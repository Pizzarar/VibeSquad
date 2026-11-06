// VS agent tools, shared by the VS MCP server (server/mcp/server.mjs) and the vs CLI (spawn/send/status/wait).
// Every tool takes plain args and a context, and returns a plain object. Backend routing goes through the existing seam:
// rn- ids -> RunnerBackend, other ids -> Paseo, creates by lane (every lane runs on the runner unless pinned to Paseo).
import { isRunnerId } from "../backend/runner-backend.mjs";
import { coalesceReplies } from "../reply-coalesce.mjs";
import { findLaneInRegistry, findTeamInRegistry, loadTeamsRegistry, whoCandidate } from "../identity.mjs";

export const MAX_LAST_MESSAGE = 2000;
export const REPORT_TYPES = ["done", "decision", "blocker"];
const WORKER_ROLE = "worker";
const LEAD_ROLE = "lead";
const LEAD_PROFILE_PREFIX = "Lead - ";
const clean = (v) => String(v ?? "").trim();
/** A runner agent is calling: its id is the spawn parent / message sender the runner hook host needs (Paseo supplies both natively). */
const isRunnerCaller = (ctx) => String(ctx.identity?.agentId ?? "").startsWith("rn-");

/** Caller identity from env: VS_AGENT_ID (fallback PASEO_AGENT_ID), VS_TEAM, VS_LANE, VS_ROLE. */
export function identityFromEnv(env = process.env) {
  return {
    agentId: clean(env.VS_AGENT_ID) || clean(env.PASEO_AGENT_ID),
    team: clean(env.VS_TEAM),
    lane: clean(env.VS_LANE),
    role: clean(env.VS_ROLE),
  };
}

/**
 * Default context. Heavy modules (profiles, Paseo daemon client, log writer) load lazily so `initialize` and
 * `tools/list` stay instant. Every piece is injectable for tests and for the CLI, which passes its own identity.
 */
export function createContext({ env = process.env, identity, ...overrides } = {}) {
  const ctx = {
    env,
    identity: identity ?? identityFromEnv(env),
    cwd: process.cwd(),
    async loadProfiles() {
      const { loadProfiles } = await import("../profiles.mjs");
      return loadProfiles(undefined, { autoSeed: false }).profiles;
    },
    async resolveProfile(name, profiles) {
      const { findProfile, toPaseoSpawnConfig } = await import("../profiles.mjs");
      const profile = findProfile(name, profiles);
      if (!profile) return null;
      return { profile, spawn: toPaseoSpawnConfig(profile, {}, profiles) };
    },
    async writeLog({ type, text, refs }) {
      const { appendVsLogEntry } = await import("../brainstorm.mjs");
      appendVsLogEntry({ teamId: ctx.identity.team, laneId: ctx.identity.lane, agent: ctx.identity.agentId || "you", type, text, refs });
    },
    // fn(backend) runs against the owning backend. A runner id never needs Paseo; everything else goes through the
    // RoutingBackend (rn- ids -> runner, other ids -> Paseo, creates by lane, lists merged), with Paseo connected only if it
    // is listening and closed after the call.
    async withBackend({ id, lane, requireRunner } = {}, fn) {
      const { sharedRunnerBackend, getBackend, runnerLanes } = await import("../backend/index.mjs");
      if (isRunnerId(id)) {
        // Connect-only: with the runner down this is RUNNER_DOWN. The VS server owns starting it.
        const runner = sharedRunnerBackend();
        await runner.requireRunning?.();
        return fn(runner);
      }
      const { createDaemonClient } = await import("../brainstorm.mjs");
      const backend = getBackend(createDaemonClient(), { lanes: () => runnerLanes({ env }) });
      await backend.connect?.();
      try {
        // A spawn into a runner lane is RUNNER_DOWN when the runner is down (never started here). A Paseo-pinned lane, a Paseo id
        // and a list (the routing list tolerates a down runner and returns the Paseo agents) do not need it.
        if (requireRunner && !id) await backend.ensureRunner?.(lane || "");
        return await fn(backend);
      } finally {
        await Promise.resolve(backend.close?.()).catch(() => {});
      }
    },
    // Live leads in (team, lane): the exact `vs who lead` filter (whoCandidate), over the merged agent list. Fails closed:
    // an unreadable or partial list (runner down, Paseo down for a lane Paseo would serve) throws instead of reading as "none".
    async findLiveLeads({ team, lane }) {
      const res = await ctx.withBackend({ lane, requireRunner: true }, (b) => (b.fetchAgents ?? b.listAgents).call(b, {}));
      const list = Array.isArray(res) ? res : Array.isArray(res?.entries) ? res.entries : Array.isArray(res?.agents) ? res.agents : null;
      if (!list) throw new Error(`can't verify the lane has no live lead: agent list unreadable`);
      if (res.paseoUnavailable) {
        const { runnerLanes } = await import("../backend/index.mjs");
        if (!runnerLanes({ env }).has(lane.toLowerCase())) throw new Error(`can't verify the lane has no live lead: Paseo is unavailable`);
      }
      const teams = ctx.teams ?? loadTeamsRegistry();
      return list.map((e) => e?.agent ?? e).filter((a) => a && whoCandidate(a, { teams, wantTeamId: team, wantLane: lane })?.role === "lead");
    },
    ...overrides,
  };
  return ctx;
}

const entriesOf = (res) => (Array.isArray(res) ? res : Array.isArray(res?.entries) ? res.entries : Array.isArray(res?.agents) ? res.agents : []);

/** Last assistant text from a timeline, tail-capped (conclusions sit at the end). */
export function lastAssistantText(timeline, cap = MAX_LAST_MESSAGE) {
  const entries = coalesceReplies(entriesOf(timeline)); // Paseo projections can split one reply around a thought
  for (let i = entries.length - 1; i >= 0; i--) {
    const item = entries[i]?.item ?? entries[i];
    if (item?.type === "assistant_message" && item.text) {
      const t = String(item.text);
      return t.length > cap ? t.slice(-cap) : t;
    }
  }
  return "";
}

const agentOf = (res) => res?.agent ?? res;

async function snapshot(ctx, id) {
  return ctx.withBackend({ id }, async (b) => {
    const agent = agentOf(await b.fetchAgent(id));
    const tl = await (b.fetchAgentTimeline ?? b.getAgentTimeline)?.call(b, id, { direction: "tail", limit: 50, projection: "projected" });
    return { id, status: agent?.status ?? "unknown", title: agent?.title ?? "", lastMessage: lastAssistantText(tl) };
  });
}

function need(args, ...names) {
  for (const n of names) if (args?.[n] !== undefined && clean(args[n]) !== "") return String(args[n]);
  throw new Error(`${names[0]} is required`);
}
const pick = (args, ...names) => {
  for (const n of names) if (args?.[n] !== undefined && args[n] !== null && clean(args[n]) !== "") return args[n];
  return undefined;
};

async function spawnWorker(ctx, args = {}) {
  const prompt = need(args, "prompt", "initialPrompt");
  const profileName = clean(pick(args, "profile", "profileId") ?? args.labels?.profile);
  const given = { provider: clean(args.provider), model: clean(args.model), modeId: clean(pick(args, "modeId", "mode")) };
  let spawn = {};
  let profile = null;
  if (profileName) {
    const profiles = await ctx.loadProfiles();
    const hit = await ctx.resolveProfile(profileName, profiles);
    if (!hit) {
      const known = profiles.map((p) => p.name).join(", ");
      throw new Error(`unknown profile "${profileName}". Known: ${known}`);
    }
    ({ profile, spawn } = hit);
  } else if (!given.provider) {
    throw new Error("profile is required (or provider + model)");
  }
  const provider = given.provider || spawn.provider;
  const model = given.model || (given.provider && given.provider !== spawn.provider ? "" : spawn.model);
  const modeId = given.modeId || spawn.modeId;
  const { team, lane } = ctx.identity;
  const title = clean(args.title) || `Worker ${new Date().toISOString().slice(11, 19)}`;
  const labels = { ...(args.labels ?? {}) };
  const requestedRole = clean(labels.role).toLowerCase();
  const requestedTeam = clean(labels.team);
  const requestedLane = clean(labels.lane);
  // Identity-affecting labels (everything effectiveAgentRole / resolveAgentIdentity read) are never caller-supplied.
  for (const k of ["role", "digestFor", "lead", "orphan", "topic", "ord"]) delete labels[k];
  // A Buddy may start the lane's lead; nobody else, and no other role. Any failed condition is an error, never a downgrade.
  const asLead = requestedRole === LEAD_ROLE;
  if (asLead) {
    const callerRole = clean(ctx.identity.role).toLowerCase();
    if (callerRole !== "brainstorm") throw new Error(`cannot spawn a lead: caller role is "${callerRole || "none"}", only a brainstorm (Buddy) may`);
    if (!team || !lane) throw new Error("cannot spawn a lead: caller has no team and lane");
    // Canonical ids from the registry, the same resolution `vs who` applies; an unregistered team/lane cannot be verified.
    const teams = ctx.teams ?? loadTeamsRegistry();
    const callerLane = findLaneInRegistry(lane, teams);
    const callerTeam = findTeamInRegistry(team, teams);
    if (!callerLane || !callerTeam || callerLane.team.id !== callerTeam.id) throw new Error(`cannot spawn a lead: caller team "${team}" / lane "${lane}" is not in the team registry`);
    const canonTeam = callerTeam.id;
    const canonLane = callerLane.lane.id;
    const sameLane = (q) => findLaneInRegistry(q, teams)?.lane.id === canonLane;
    if (requestedLane && !sameLane(requestedLane)) throw new Error(`cannot spawn a lead: target lane "${requestedLane}" is not the caller's lane "${canonLane}"`);
    if (requestedTeam && findTeamInRegistry(requestedTeam, teams)?.id !== canonTeam) throw new Error(`cannot spawn a lead: target team "${requestedTeam}" is not the caller's team "${canonTeam}"`);
    if (!clean(profile?.name).startsWith(LEAD_PROFILE_PREFIX)) throw new Error(`cannot spawn a lead: profile "${clean(profile?.name) || profileName || "none"}" is not a "${LEAD_PROFILE_PREFIX}" profile`);
    let live;
    try {
      live = await ctx.findLiveLeads({ team: canonTeam, lane: canonLane });
    } catch (e) {
      throw new Error(e?.message?.startsWith("can't verify") ? e.message : `can't verify the lane has no live lead: ${e?.message ?? e}`);
    }
    if (live.length) throw new Error(`cannot spawn a lead: lane "${canonLane}" already has a live lead (${live.map((a) => a.id).join(", ")})`);
    labels.lead = canonLane;
    labels.team = canonTeam;
    labels.lane = canonLane;
  } else {
    if (team || labels.team) labels.team = team || labels.team;
    if (lane || labels.lane) labels.lane = lane || labels.lane;
  }
  const role = asLead ? LEAD_ROLE : WORKER_ROLE;
  labels.role = role;
  if (profile) labels.profile = profile.name || profile.id; // by name: the plugin, failover and digest identity all match names
  else delete labels.profile; // a caller-supplied profile label can make the agent read as a digest
  if (isRunnerCaller(ctx)) labels["vs.parent"] = ctx.identity.agentId;
  delete labels.ord; // ordinals are assigned by the squad, never by a spawn arg
  labels.job = clean(labels.job) || title;
  const env = { VS_ROLE: role, ...(labels.profile ? { VS_PROFILE: labels.profile } : {}), ...(labels.lane ? { VS_LANE: labels.lane } : {}), ...(labels.team ? { VS_TEAM: labels.team } : {}) };
  const created = await ctx.withBackend({ lane: labels.lane, requireRunner: true }, (b) =>
    b.createAgent({
      config: {
        provider, model, cwd: clean(args.cwd) || ctx.cwd, title,
        ...(modeId ? { modeId } : {}),
        ...(spawn.systemPrompt ? { systemPrompt: spawn.systemPrompt } : {}),
      },
      initialPrompt: prompt,
      labels,
      env,
    }),
  );
  const agent = agentOf(created);
  return { id: agent?.id ?? created?.agentId ?? created?.id, title: agent?.title || title };
}

async function sendTool(ctx, args = {}) {
  const id = need(args, "id", "agentId");
  const text = need(args, "text", "prompt", "message");
  await ctx.withBackend({ id }, (b) => b.sendAgentPrompt(id, text, isRunnerCaller(ctx) && id.startsWith("rn-") ? { senderId: ctx.identity.agentId } : undefined));
  return { id, sent: true };
}

async function waitTool(ctx, args = {}) {
  const id = need(args, "id", "agentId");
  const sec = Number(pick(args, "timeoutSec", "timeout") ?? 0);
  const res = await ctx.withBackend({ id }, (b) => b.waitForFinish(id, sec > 0 ? Math.round(sec * 1000) : 0));
  const snap = await snapshot(ctx, id).catch(() => null);
  return { id, status: res?.status ?? "error", ...(res?.error ? { error: String(res.error) } : {}), lastMessage: snap?.lastMessage ?? "" };
}

async function statusTool(ctx, args = {}) {
  return snapshot(ctx, need(args, "id", "agentId"));
}

async function cancelTool(ctx, args = {}) {
  const id = need(args, "id", "agentId");
  await ctx.withBackend({ id }, (b) => b.cancelAgent(id));
  return { id, cancelled: true };
}

async function listTool(ctx) {
  const { team, lane } = ctx.identity;
  const res = await ctx.withBackend({ lane }, (b) => (b.fetchAgents ?? b.listAgents).call(b, {}));
  return entriesOf(res)
    .map((e) => e?.agent ?? e)
    .filter((a) => a && !a.archivedAt && (!lane || clean(a.labels?.lane).toLowerCase() === lane.toLowerCase()) && (!team || !a.labels?.team || clean(a.labels.team).toLowerCase() === team.toLowerCase()))
    .map((a) => ({ id: a.id, title: a.title ?? "", status: a.status ?? "unknown", role: a.labels?.role ?? "", profile: a.labels?.profile ?? "" }));
}

async function reportTool(ctx, args = {}) {
  const type = clean(args.type);
  if (!REPORT_TYPES.includes(type)) throw new Error(`type must be one of: ${REPORT_TYPES.join(", ")}`);
  const text = clean(args.text);
  if (!text) throw new Error("text is required");
  await ctx.writeLog({ type, text, refs: args.refs });
  return { logged: true, type };
}

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: true });
const S = { type: "string" };

/** Canonical VS tools. */
export const VS_TOOLS = {
  spawn_worker: {
    description: "Start a worker agent in your lane from a VS profile. Returns {id, title}.",
    inputSchema: obj({ title: S, profile: S, prompt: S, cwd: S, labels: { type: "object" } }, ["title", "profile", "prompt"]),
    run: spawnWorker,
  },
  send: { description: "Send a follow-up message to an agent.", inputSchema: obj({ id: S, text: S }, ["id", "text"]), run: sendTool },
  wait: {
    description: "Block until an agent is idle, errored or the timeout hits. Returns {status, lastMessage}.",
    inputSchema: obj({ id: S, timeoutSec: { type: "number" } }, ["id"]),
    run: waitTool,
  },
  status: { description: "Agent status, title and its last assistant message (capped ~2k chars).", inputSchema: obj({ id: S }, ["id"]), run: statusTool },
  report: {
    description: "Write a done/decision/blocker entry to your team log as yourself.",
    inputSchema: obj({ type: { type: "string", enum: REPORT_TYPES }, text: S }, ["type", "text"]),
    run: reportTool,
  },
  list: { description: "Agents in your lane.", inputSchema: obj({}), run: listTool },
  cancel: { description: "Interrupt an agent's current turn.", inputSchema: obj({ id: S }, ["id"]), run: cancelTool },
};

/** Paseo-name aliases for prompts written against the Paseo MCP. Every hit is logged as a metric. */
export const ALIASES = {
  create_agent: "spawn_worker",
  send_agent_prompt: "send",
  get_agent_status: "status",
  list_agents: "list",
  cancel_agent: "cancel",
  wait_for_agent: "wait",
};

// Every alias result carries agentId next to id, so prompts written against Paseo's result shape keep working.
const aliasResult = (name, r) => {
  if (name === "list_agents") return { agents: r.map((a) => ({ ...a, agentId: a.id })) };
  return r?.id !== undefined ? { ...r, agentId: r.id } : r;
};

// Paseo-shaped inputs per alias (agentId, prompt/initialPrompt, mode/modeId); the canonical schemas stay VS-shaped.
const AGENT_ID = { agentId: S, id: S };
const ALIAS_SCHEMAS = {
  create_agent: obj({ title: S, provider: S, model: S, modeId: S, mode: S, initialPrompt: S, prompt: S, cwd: S, labels: { type: "object" }, profile: S }),
  send_agent_prompt: obj({ ...AGENT_ID, prompt: S, text: S }),
  get_agent_status: obj(AGENT_ID),
  list_agents: obj({}),
  cancel_agent: obj(AGENT_ID),
  wait_for_agent: obj({ ...AGENT_ID, timeout: { type: "number" }, timeoutSec: { type: "number" } }),
};

export const ALL_TOOLS = Object.fromEntries([
  ...Object.entries(VS_TOOLS),
  ...Object.entries(ALIASES).map(([alias, target]) => [alias, {
    ...VS_TOOLS[target],
    description: `Paseo-compatible alias of ${target}. ${VS_TOOLS[target].description}`,
    inputSchema: ALIAS_SCHEMAS[alias],
    alias: true,
  }]),
]);

/** Runs a tool by name (canonical or Paseo alias). Alias hits log `mcp-alias: tool=<name> caller=<id> lane=<lane>`. */
export async function callTool(ctx, name, args = {}) {
  const target = ALIASES[name] ?? name;
  const def = VS_TOOLS[target];
  if (!def) throw new Error(`unknown tool "${name}"`);
  if (ALIASES[name]) {
    const { agentId, lane } = ctx.identity;
    try {
      await ctx.writeLog({ type: "metric", text: `mcp-alias: tool=${name} caller=${agentId || "unknown"} lane=${lane || "unknown"}` });
    } catch { /* metrics are best effort */ }
  }
  const result = await def.run(ctx, args ?? {});
  return ALIASES[name] ? aliasResult(name, result) : result;
}
