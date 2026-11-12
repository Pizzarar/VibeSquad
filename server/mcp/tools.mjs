// VS agent tools, shared by the VS MCP server (server/mcp/server.mjs) and the vs CLI (spawn/send/status/wait).
// Every tool takes plain args and a context, and returns a plain object. Every agent is a runner agent (rn- id); the
// runner is the only backend (server/backend/index.mjs).
//
// X1b (docs/PLAN_X1_IDENTITY.md): the caller is (VS_AGENT_ID, VS_AGENT_TOKEN), verified against runner memory with
// GET /verify-agent (verifyCaller) before every tool that acts on identity; the env's VS_ROLE/VS_LANE/VS_TEAM are only
// a claim until then. Calls to the VS server carry x-vs-agent-id + x-vs-agent-token and never the owner's local token.
// X1d: an agent id without its token is a 403 before any request leaves the process; there is no fallback to the env
// identity, the disk record or the owner header (the X1a-X1b rollout flag VS_AGENT_TOKEN_REQUIRED is gone).
import { isRunnerId } from "../backend/runner-backend.mjs";
import { fetchWithLocalToken, localTokenPath, readLocalToken } from "../local-token.mjs";
import { coalesceReplies } from "../reply-coalesce.mjs";
import { effectiveAgentRole, findLaneInRegistry, findTeamInRegistry, isHubLane, isLiveAgent, isRetiredAgent, loadTeamsRegistry, resolveLeadWinner, whoCandidate } from "../identity.mjs";
import { assertBuddyRestartAllowed } from "../buddy-restart-auth.mjs";
import { STAKES_VALUES } from "../stakes-ladder.mjs";

export const MAX_LAST_MESSAGE = 2000;
export const REPORT_TYPES = ["done", "decision", "blocker"];
const WORKER_ROLE = "worker";
const LEAD_ROLE = "lead";
const LEAD_PROFILE_PREFIX = "Lead - ";
const clean = (v) => String(v ?? "").trim();
const forbidden = (why) => Object.assign(new Error(why.startsWith("403") ? why : `403: ${why}`), { status: 403 });

/** Caller identity from env: VS_AGENT_ID (fallback PASEO_AGENT_ID) + VS_AGENT_TOKEN, VS_TEAM, VS_LANE, VS_ROLE. */
export function identityFromEnv(env = process.env) {
  return {
    agentId: clean(env.VS_AGENT_ID) || clean(env.PASEO_AGENT_ID),
    token: clean(env.VS_AGENT_TOKEN),
    team: clean(env.VS_TEAM),
    lane: clean(env.VS_LANE),
    role: clean(env.VS_ROLE),
  };
}

/**
 * The agent this context calls as, from its identity (the token is the identity's own field; the CLI copies it from
 * VS_AGENT_TOKEN): null when there is neither an agent id nor a token (the owner's shell, or unknown); `{ id, token }`
 * otherwise. An agent caller is always verified (verifyCaller / agentHeaders): an id without its token, or a token
 * without an id, is a 403, never a claim (X1d removed the rollout fallback).
 */
export function agentCallerOf(ctx) {
  const id = clean(ctx?.identity?.agentId);
  const token = clean(ctx?.identity?.token);
  // R1 M1: a token with the id cleared is still an agent shell, never the owner: it verifies (and fails closed).
  if (!id && !token) return null;
  return { id, token };
}

const MISSING_TOKEN = (id) => `403: agent token invalid for ${id || "(no VS_AGENT_ID)"} (VS_AGENT_TOKEN does not match the runner's token for VS_AGENT_ID, or the agent is gone/retired)`;

/** The headers an agent caller presents to the VS server. Throws 403 when the (id, token) pair is incomplete: nothing is sent. */
export function agentHeaders(caller) {
  if (!caller?.id || !caller?.token) throw forbidden(MISSING_TOKEN(caller?.id));
  return { "x-vs-agent-id": caller.id, "x-vs-agent-token": caller.token };
}

/**
 * The caller's own agent record. A missing record reads as null (the tool then refuses as "not a live ..."); any other
 * failure (a 403 from the runner, a transport error) propagates: the caller lookup is never swallowed into null (X1b).
 */
async function fetchCallerRecord(ctx, id) {
  try {
    const a = agentOf(await ctx.withBackend({ id }, (b) => b.fetchAgent(id)));
    return a && a.id ? a : null;
  } catch (e) {
    if (e?.status === 404 || String(e?.message ?? "").toLowerCase().includes("not found")) return null;
    throw e;
  }
}

/** The agent id to stamp as spawn parent / message sender: the verified caller (every identity tool verifies first). */
const callerAgentId = (ctx) => agentCallerOf(ctx)?.id ?? "";

/**
 * Resolve the caller from its token: GET /verify-agent through the backend (RunnerBackend.verifyAgent). On success the
 * context's identity is overwritten with the runner's record (role/lane/team/profile/digest/digestFor/overlord) and
 * `verified: true`; a wrong/missing token, or a gone/retired agent, throws a 403-tagged error (never swallowed).
 * Returns null when there is nothing to verify: no agent id and no token (owner / unknown).
 */
export async function verifyCaller(ctx) {
  const caller = agentCallerOf(ctx);
  if (!caller) return null;
  const bad = MISSING_TOKEN(caller.id);
  if (!caller.token || !caller.id) throw forbidden(bad);
  // Verified once per context: a tool that is reached through callTool (alias metric) and its own gate does one runner call.
  const done = ctx[VERIFIED];
  if (done && done.id === caller.id && done.token === caller.token) return done.rec;
  let who;
  try {
    who = ctx.verifyAgent
      ? await ctx.verifyAgent({ id: caller.id, token: caller.token })
      : await ctx.withBackend({ id: caller.id, verify: true }, (b) => {
        if (typeof b.verifyAgent !== "function") throw new Error("backend cannot verify agent callers (no verifyAgent)");
        return b.verifyAgent({ id: caller.id, token: caller.token });
      });
  } catch (e) {
    if (e?.status === 403) throw forbidden(bad);
    throw e;
  }
  const rec = who?.agent ?? who;
  if (!rec || typeof rec !== "object" || clean(rec.id) !== caller.id) throw forbidden(bad);
  ctx.identity = {
    ...ctx.identity,
    agentId: caller.id,
    token: caller.token,
    role: clean(rec.role).toLowerCase() || WORKER_ROLE,
    lane: clean(rec.lane),
    team: clean(rec.team),
    profile: clean(rec.profile),
    digest: rec.digest === true,
    digestFor: rec.digestFor ? String(rec.digestFor) : null,
    overlord: rec.overlord === true,
    verified: true,
  };
  Object.defineProperty(ctx, VERIFIED, { value: { id: caller.id, token: caller.token, rec }, enumerable: false, configurable: true });
  return rec;
}
const VERIFIED = Symbol("vibesquad.verifiedCaller");

const homeOf = (env = {}) => clean(env.VIBESQUAD_HOME) || null;

/** Owner proof for a CLI/MCP process: no agent id and the per-install local token (~/.vibesquad/local-token) is readable. */
export async function hasOwnerProof(ctx) {
  if (agentCallerOf(ctx)) return false;
  return localTokenAvailable(ctx);
}

/** The per-install local token file is readable for this context's home (the owner's proof; never read by an agent path). */
const localTokenAvailable = (ctx) => {
  const home = homeOf(ctx?.env);
  return Boolean(readLocalToken(home ? localTokenPath(home) : undefined));
};
const localTokenFile = (ctx) => { const home = homeOf(ctx?.env); return home ? { file: localTokenPath(home) } : {}; };

/**
 * Auth headers for a call to the VS server: an agent sends x-vs-agent-id + x-vs-agent-token and nothing else (an agent
 * never presents the owner's local token; an incomplete pair throws 403); the owner's shell (no agent id, no token)
 * sends the local-token header when the file is readable (empty headers otherwise: the server treats that as unknown).
 */
export async function vsServerHeaders(ctx) {
  const caller = agentCallerOf(ctx);
  if (caller) return agentHeaders(caller);
  return {}; // the owner header is minted only inside fetchWithLocalToken, after the listener proved it holds the token
}

/** An agent's POST: its own headers, a plain socket (no local token leaves the process, so no loopback proof is needed). */
async function postAsAgent(ctx, route, payload, timeoutMs, headers) {
  const port = Number(ctx?.env?.VIBESQUAD_PORT || process.env.VIBESQUAD_PORT || 4180);
  return (ctx.fetch ?? fetch)(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: payload,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * POST `route` as this caller: an agent with its own headers (an incomplete (id, token) pair is a 403 thrown here, before
 * any socket opens); the owner's shell makes the listener prove it holds the local token over the one socket the request
 * then rides (X1 E4a L3 / prove-local L1) before x-vibesquad-token goes out. A failed proof is an error (`proofFailed`),
 * never a disk fallback; nothing listening is `unreachable`. Returns the raw Response.
 */
async function postAsCaller(ctx, route, payload, timeoutMs) {
  const caller = agentCallerOf(ctx);
  const headers = caller ? agentHeaders(caller) : null; // 403 before the try: never reported as "unreachable"
  try {
    return headers
      ? await postAsAgent(ctx, route, payload, timeoutMs, headers)
      : await fetchWithLocalToken(route, ownerPostInit(ctx, payload, timeoutMs));
  } catch (e) {
    if (e?.proofFailed) throw e;
    throw Object.assign(new Error(`VS server unreachable: ${e?.message ?? e}`), { unreachable: true });
  }
}

/** fetchWithLocalToken options for the owner's shell: proof first, one socket, token from this home. */
const ownerPostInit = (ctx, payload, timeoutMs) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: payload,
  port: Number(ctx?.env?.VIBESQUAD_PORT || process.env.VIBESQUAD_PORT || 4180),
  ...localTokenFile(ctx),
  fetchImpl: ctx.fetch,
  timeoutMs,
  tokenOptional: true,
});

/**
 * POST `route` on the local VS server as this caller. Connection failures throw with `unreachable: true`; a non-2xx
 * answer throws `<status>: <server error>` tagged with `status` (so a 403 reads as 403 to the agent). Returns the JSON body.
 */
export async function postToVsServer(ctx, route, body, { timeoutMs = 20_000 } = {}) {
  const r = await postAsCaller(ctx, route, JSON.stringify(body ?? {}), timeoutMs);
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${r.status}: ${json?.error ?? `server answered ${r.status}`}`), { status: r.status, body: json });
  return json;
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
    // X1b: the log entry goes to the VS server (POST /__vibesquad/vs-log), which attributes it to the verified caller
    // (worker/digest/lead rules, `you` owner-only). An agent id without its token is a 403 before anything is sent (X1d).
    // Direct disk append only for the owner's shell (local token in hand) when the server is down. Returns the entry.
    async writeLog({ type, text, refs, agent }) {
      // `agent` names the owner's entry only (the CLI passes the configured user name); the server ignores it for an agent.
      const name = ctx.identity.agentId || clean(agent);
      const body = { teamId: ctx.identity.team, laneId: ctx.identity.lane, type, text, refs, ...(name ? { agent: name } : {}) };
      if (agentCallerOf(ctx)) return (await postToVsServer(ctx, "/__vibesquad/vs-log", body)).entry;
      // R1 H1: the owner's shell must hold the local token; a scrubbed shell (no id, no token) is nobody and writes nothing.
      if (!(await hasOwnerProof(ctx))) throw new Error("vs log: no owner proof (no agent id and no readable local token under the VibeSquad home); only the owner's shell or an agent may write the log");
      try {
        return (await postToVsServer(ctx, "/__vibesquad/vs-log", body)).entry;
      } catch (e) {
        if (!e?.unreachable) throw e;
        const { appendVsLogEntry } = await import("../brainstorm.mjs");
        return appendVsLogEntry({ teamId: ctx.identity.team, laneId: ctx.identity.lane, agent: name || "you", type, text, refs }).entry;
      }
    },
    // fn(backend) runs against the runner. Connect-only: with the runner down this is RUNNER_DOWN. The VS server owns starting it.
    // opts.verify (verifyCaller): skip the /health probe, which an agent with a wrong token cannot pass either (the
    // runner answers 403 to every route for it); the verify call itself then reports the 403 instead of RUNNER_DOWN.
    async withBackend(opts, fn) {
      const { sharedRunnerBackend } = await import("../backend/index.mjs");
      const runner = sharedRunnerBackend();
      if (!opts?.verify) await runner.requireRunning?.();
      return fn(runner);
    },
    // Live leads in (team, lane): the exact `vs who lead` filter (whoCandidate), over the agent list. Fails closed:
    // an unreadable list (runner down) throws instead of reading as "none".
    async findLiveLeads({ team, lane }) {
      const res = await ctx.withBackend({ lane, requireRunner: true }, (b) => (b.fetchAgents ?? b.listAgents).call(b, {}));
      const list = Array.isArray(res) ? res : Array.isArray(res?.entries) ? res.entries : Array.isArray(res?.agents) ? res.agents : null;
      if (!list) throw new Error(`can't verify the lane has no live lead: agent list unreadable`);
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

// One in-flight lead spawn per (team, lane) in this process: a retried or double-fired call must not pass the live-lead check
// while the first create is still in flight (that mints two leads, a `vs who lead` CONFLICT).
const leadSpawnLeases = new Set();

async function spawnWorker(ctx, args = {}) {
  const lease = { key: "" };
  try {
    return await spawnWorkerOnce(ctx, args, lease);
  } finally {
    if (lease.key) leadSpawnLeases.delete(lease.key);
  }
}

async function spawnWorkerOnce(ctx, args = {}, lease = { key: "" }) {
  await verifyCaller(ctx); // X1b: role/lane/team below are the runner's record, not the env claim (403 propagates)
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
  const givenThinking = clean(pick(args, "thinkingOptionId", "thinking"));
  const thinkingOptionId = givenThinking || (given.provider && given.provider !== spawn.provider ? "" : clean(spawn.thinkingOptionId));
  const { team, lane } = ctx.identity;
  const title = clean(args.title) || `Worker ${new Date().toISOString().slice(11, 19)}`;
  const labels = { ...(args.labels ?? {}) };
  // Convenience for labels.stakes (the ladder reads the label); an explicit labels.stakes wins.
  const stakesArg = clean(args.stakes);
  if (stakesArg) {
    if (!STAKES_VALUES.includes(stakesArg)) throw new Error(`unknown stakes "${stakesArg}". Known: ${STAKES_VALUES.join(", ")}`);
    if (!clean(labels.stakes)) labels.stakes = stakesArg;
  }
  const requestedRole = clean(labels.role).toLowerCase();
  const requestedTeam = clean(labels.team);
  const requestedLane = clean(labels.lane);
  // Identity-affecting labels (everything effectiveAgentRole / resolveAgentIdentity read) are never caller-supplied.
  for (const k of ["role", "digestFor", "lead", "orphan", "topic", "ord"]) delete labels[k];
  // Handoff bookkeeping is written only by the lead-handoff flow; a caller-supplied one could forge a takeover (demote the live lead).
  for (const k of Object.keys(labels)) if (/^(vs\.handoff|handoff-)/i.test(k)) delete labels[k];
  // A Buddy may start the lane's lead; nobody else, and no other role. Any failed condition is an error, never a downgrade.
  const asLead = requestedRole === LEAD_ROLE;
  if (asLead) {
    const callerRole = clean(ctx.identity.role).toLowerCase();
    if (callerRole !== "brainstorm" && callerRole !== LEAD_ROLE) throw new Error(`cannot spawn a lead: caller role is "${callerRole || "none"}", only a brainstorm (Buddy) or the Squad's hub lead may`);
    if (!team || !lane) throw new Error("cannot spawn a lead: caller has no team and lane");
    // Canonical ids from the registry, the same resolution `vs who` applies; an unregistered team/lane cannot be verified.
    const teams = ctx.teams ?? loadTeamsRegistry();
    const callerLane = findLaneInRegistry(lane, teams);
    const callerTeam = findTeamInRegistry(team, teams);
    if (!callerLane || !callerTeam || callerLane.team.id !== callerTeam.id) throw new Error(`cannot spawn a lead: caller team "${team}" / lane "${lane}" is not in the team registry`);
    const canonTeam = callerTeam.id;
    const callerIsHub = isHubLane(callerTeam, callerLane.lane);
    // A lead may only spawn from the hub lane (the Overlord); a Buddy only for its own lane. The hub Overlord may name any lane of its own Squad.
    if (callerRole === LEAD_ROLE && !callerIsHub) throw new Error(`cannot spawn a lead: a lead on non-hub lane "${callerLane.lane.id}" may not spawn leads; only a brainstorm (Buddy) or the Squad's hub lead (Overlord) may`);
    if (callerRole === LEAD_ROLE) {
      // Cross-lane power is never granted from env alone: the caller's own agent record must say it is a live lead on this hub lane.
      const callerId = clean(ctx.identity.agentId);
      const rec = callerId ? await fetchCallerRecord(ctx, callerId) : null; // X1b: a failed caller lookup propagates (missing = null)
      const recLane = rec ? findLaneInRegistry(clean(rec.labels?.lane || rec.labels?.lead), teams) : null;
      const recTeam = rec ? findTeamInRegistry(clean(rec.labels?.team), teams) : null;
      if (!rec || effectiveAgentRole(rec) !== LEAD_ROLE || isRetiredAgent(rec) || rec.archivedAt || (rec.status === "closed" && rec.resumable !== true) || recLane?.lane.id !== callerLane.lane.id || recTeam?.id !== canonTeam) {
        throw new Error(`cannot spawn a lead: ${callerId || "caller"} is not a live lead of hub lane "${callerLane.lane.id}" per its agent record`);
      }
    }
    let canonLane = callerLane.lane.id;
    if (callerRole === LEAD_ROLE && requestedLane) {
      const target = findLaneInRegistry(requestedLane, teams);
      if (!target || target.team.id !== canonTeam) throw new Error(`cannot spawn a lead: target lane "${requestedLane}" is not in the caller's Squad "${canonTeam}"`);
      canonLane = target.lane.id;
    } else if (requestedLane && findLaneInRegistry(requestedLane, teams)?.lane.id !== canonLane) {
      throw new Error(`cannot spawn a lead: target lane "${requestedLane}" is not the caller's lane "${canonLane}"`);
    }
    if (requestedTeam && findTeamInRegistry(requestedTeam, teams)?.id !== canonTeam) throw new Error(`cannot spawn a lead: target team "${requestedTeam}" is not the caller's team "${canonTeam}"`);
    if (!clean(profile?.name).startsWith(LEAD_PROFILE_PREFIX)) throw new Error(`cannot spawn a lead: profile "${clean(profile?.name) || profileName || "none"}" is not a "${LEAD_PROFILE_PREFIX}" profile`);
    const leaseKey = `${canonTeam}:${canonLane}`;
    if (leadSpawnLeases.has(leaseKey)) throw new Error(`cannot spawn a lead: a lead spawn for lane "${canonLane}" is already in flight`);
    leadSpawnLeases.add(leaseKey);
    lease.key = leaseKey;
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
  if (callerAgentId(ctx)) labels["vs.parent"] = callerAgentId(ctx); // the verified caller (or the claimed id under the fallback)
  delete labels.ord; // ordinals are assigned by the squad, never by a spawn arg
  labels.job = clean(labels.job) || title;
  // Which of model/thinking came from the profile rather than the caller: the before.agent.create hook must not read those as an explicit override of the stakes ladder.
  delete labels["vs.profile-derived"];
  const derived = [!given.model && model ? "model" : "", !givenThinking && thinkingOptionId ? "thinking" : ""].filter(Boolean);
  if (derived.length) labels["vs.profile-derived"] = derived.join(",");
  const env = { VS_ROLE: role, ...(labels.profile ? { VS_PROFILE: labels.profile } : {}), ...(labels.lane ? { VS_LANE: labels.lane } : {}), ...(labels.team ? { VS_TEAM: labels.team } : {}) };
  const created = await ctx.withBackend({ lane: labels.lane, requireRunner: true }, (b) =>
    b.createAgent({
      config: {
        provider, model, cwd: clean(args.cwd) || ctx.cwd, title,
        ...(modeId ? { modeId } : {}),
        ...(thinkingOptionId ? { thinkingOptionId } : {}),
        ...(spawn.systemPrompt ? { systemPrompt: spawn.systemPrompt } : {}),
      },
      initialPrompt: prompt,
      labels,
      env,
    }),
  );
  const agent = agentOf(created);
  const result = { id: agent?.id ?? created?.agentId ?? created?.id, title: agent?.title || title };
  const partnerName = !asLead && !args._duetPartner ? ART_DUET[labels.profile] : undefined;
  if (partnerName) {
    try {
      const partner = await spawnArtPartner(ctx, args, { partnerName, self: result, selfProfile: labels.profile, job: labels.job, lane: labels.lane });
      if (partner) result.partner = partner;
    } catch (e) {
      result.partnerError = String(e?.message ?? e); // the primary exists: return its id so a retry doesn't duplicate it
    }
  }
  return result;
}

// Art duet: spawning one half of Painter + Director starts the other (same job) unless that job already has a live partner.
const ART_DUET = { "Art Painter - Opus": "Art Director - Gemini", "Art Director - Gemini": "Art Painter - Opus" };
const ART_PAINTER = "Art Painter - Opus";

async function spawnArtPartner(ctx, args, { partnerName, self, selfProfile, job, lane }) {
  const live = await ctx.withBackend({ lane, requireRunner: true }, (b) => (b.fetchAgents ?? b.listAgents).call(b, {})).catch(() => null);
  const dead = new Set(["closed", "error", "archived"]);
  const taken = entriesOf(live).map((e) => e?.agent ?? e).some((a) => a && !a.archivedAt && !dead.has(a.status) && a.id !== self.id
    && clean(a.labels?.profile) === partnerName && clean(a.labels?.job) === job && clean(a.labels?.lane).toLowerCase() === clean(lane).toLowerCase());
  if (taken) return null;
  const painterId = selfProfile === ART_PAINTER ? self.id : null;
  const brief = clean(args.prompt ?? args.initialPrompt);
  const prompt = painterId
    ? `You are the Art Director in a Painter + Director duet. Your Painter is agent ${painterId}; it will send you gallery PNG paths via \`send\`. Reply with numbered fixes or PASS (max round 4).\n\nBrief:\n${brief}`
    : `You are the Art Painter in a Painter + Director duet. Your Director is agent ${self.id}; send it each gallery PNG path via \`send\` and fix only its numbered items until PASS or round 4.\n\nBrief:\n${brief}`;
  // The partner is a different profile (often another provider): it never inherits the caller's provider/model/mode/thinking.
  const { provider: _p, model: _m, modeId: _mi, mode: _mo, thinkingOptionId: _t, thinking: _th, ...partnerArgs } = args;
  const p = await spawnWorker(ctx, { ...partnerArgs, _duetPartner: true, profile: partnerName, prompt, title: `${partnerName} · ${job}`, labels: { ...(args.labels ?? {}), job } });
  const msg = painterId
    ? `Your Art Director is agent ${p.id}. Send it each gallery PNG via \`send\`.`
    : `Your Art Painter is agent ${p.id}; it will send you gallery PNGs. Judge them and reply with numbered fixes or PASS.`;
  await ctx.withBackend({ id: self.id }, (b) => b.sendAgentPrompt(self.id, msg, callerAgentId(ctx) ? { senderId: callerAgentId(ctx) } : undefined)).catch(() => {});
  return p.id;
}

async function sendTool(ctx, args = {}) {
  const id = need(args, "id", "agentId");
  const text = need(args, "text", "prompt", "message");
  await verifyCaller(ctx); // X1b: a wrong/missing token is a 403 before anything is sent
  // Owner turns jump the queue: only a caller with no agent id AND owner proof (the local token) is the owner. An agent
  // carries senderId instead (the runner sets owner/senderId from the verified caller anyway); no proof = no opts.
  const sender = callerAgentId(ctx);
  const opts = sender ? { senderId: sender } : (await hasOwnerProof(ctx)) ? { owner: true } : undefined;
  const res = await ctx.withBackend({ id }, (b) => b.sendAgentPrompt(id, text, opts));
  return res?.redirectedTo ? { id, sent: true, redirectedTo: res.redirectedTo } : { id, sent: true };
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
  await verifyCaller(ctx); // X1b: the runner then scopes the cancel to the verified caller
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
  await verifyCaller(ctx); // X1b: 403 on a bad token before the server is asked; the server re-attributes the entry
  const entry = await ctx.writeLog({ type, text, refs: args.refs });
  return { logged: true, type, ...(entry && typeof entry === "object" ? { agent: entry.agent, refs: entry.refs } : {}) };
}

const HANDOFF_DEDUPE_MS = 10 * 60_000;
const handoffView = (r, extra = {}) => ({
  id: r.successorId ?? r.id,
  title: r.title ?? r.successor?.title ?? "",
  oldLeadId: r.oldLeadId,
  ...(r.deduped ? { deduped: true } : {}),
  ...extra,
});

/** A lead's handoff request that names another agent or lane than itself (the Overlord's cross-lane form). */
async function isCrossLaneRequest(ctx, askedId, askedLane, callerId) {
  if (askedId && askedId !== callerId) return true;
  if (!askedLane) return false;
  const teams = ctx.teams ?? loadTeamsRegistry();
  const mine = findLaneInRegistry(clean(ctx.identity.lane), teams);
  return !mine || findLaneInRegistry(askedLane, teams)?.lane.id !== mine.lane.id;
}

/**
 * Hand a lane's lead over to a successor through the existing lead-handoff flow (server/lead-handoff.mjs): spawns the successor,
 * re-parents open workers, relabels the old lead former-lead. A Buddy may do it for its OWN lane's live lead (trigger "buddy"),
 * a lead only for itself (trigger "self"); the Squad's hub lead (Overlord) for any lane of its own Squad (trigger "overlord", optional steer);
 * nobody else. Idempotent: a second call returns the existing successor.
 */
async function handoffLead(ctx, args = {}) {
  await verifyCaller(ctx); // X1b: callerRole/lane/team below come from the runner's record (403 propagates)
  const callerRole = clean(ctx.identity.role).toLowerCase();
  const callerId = clean(ctx.identity.agentId);
  const askedId = clean(pick(args, "id", "agentId"));
  const askedLane = clean(pick(args, "lane", "laneId"));
  const action = clean(args.action).toLowerCase();
  // Targets may be missing (null); the caller's own lookup never swallows an error (X1b).
  const fetchAgent = async (id) => agentOf(await ctx.withBackend({ id }, (b) => b.fetchAgent(id)).catch(() => null));
  const fetchCaller = (id) => fetchCallerRecord(ctx, id);
  if (action === "retire") {
    const teams = ctx.teams ?? loadTeamsRegistry();
    let target;
    if (callerId) {
      const caller = await fetchCaller(callerId);
      const role = caller ? effectiveAgentRole(caller) : "";
      if (!caller || (role !== LEAD_ROLE && role !== "brainstorm") || isRetiredAgent(caller) || caller.archivedAt || (caller.status === "closed" && caller.resumable !== true)) {
        throw new Error(`cannot retire stale leads: caller role is "${callerRole || "none"}", only the owner, a brainstorm (Buddy) or a lead may`);
      }
      const callerTeam = findTeamInRegistry(clean(caller.labels?.team), teams);
      const callerLane = findLaneInRegistry(clean(caller.labels?.lane || caller.labels?.lead), teams, callerTeam?.id);
      if (!callerLane || !callerTeam || callerLane.team.id !== callerTeam.id) {
        throw new Error(`cannot retire stale leads: caller record team "${caller.labels?.team ?? ""}" / lane "${caller.labels?.lane ?? ""}" is not in the team registry`);
      }
      target = askedLane ? findLaneInRegistry(askedLane, teams, callerTeam.id) : callerLane;
      if (!target || target.team.id !== callerTeam.id) {
        throw new Error(`cannot retire stale leads: target lane "${askedLane}" is not in the caller's Squad "${callerTeam.id}"`);
      }
      if (target.lane.id !== callerLane.lane.id && !(role === LEAD_ROLE && isHubLane(callerTeam, callerLane.lane))) {
        throw new Error("cannot retire stale leads: only the Squad's hub lead (Overlord) or the owner may retire stale leads in another lane");
      }
    } else {
      if (!(await hasOwnerProof(ctx))) {
        throw new Error("cannot retire stale leads: no owner proof (only the owner, a brainstorm (Buddy) or a lead may)");
      }
      const laneHint = askedLane || clean(ctx.identity.lane) || clean(ctx.identity.team) || "vibesquad";
      target = findLaneInRegistry(laneHint, teams);
      if (!target) throw new Error(`cannot retire stale leads: lane "${laneHint}" is not in the team registry`);
    }
    const body = { action: "retire", teamId: target.team.id, laneId: target.lane.id, ...(callerId ? { callerId } : {}) };
    let res;
    let via = "server";
    if (ctx.performHandoff) {
      res = await ctx.performHandoff(body);
      via = "injected";
    } else {
      try {
        res = await postLeadHandoffToServer(body, ctx);
      } catch (e) {
        if (!e?.unreachable) throw e;
        via = "in-process (VS server unreachable)";
        res = await (await import("../lead-handoff.mjs")).performLeadHandoffHttp({ ...body, ...(ctx.inProcessDeps ?? {}) });
      }
    }
    if (res?.ok === false || res?.error) throw new Error(`lead retire failed: ${res.error ?? "unknown"}`);
    const retired = Array.isArray(res?.retired) ? res.retired : [];
    return {
      id: res?.winnerId ?? null,
      title: res?.title ?? "",
      lane: res?.laneId ?? target.lane.id,
      team: res?.teamId ?? target.team.id,
      retired,
      retiredIds: retired.map((x) => x.id),
      via,
    };
  }
  let target;
  let trigger;
  if (callerRole === "brainstorm") {
    const { team, lane } = ctx.identity;
    if (!team || !lane) throw new Error("cannot hand off a lead: caller has no team and lane");
    if (!callerId) throw new Error("cannot hand off a lead: caller has no agent id");
    const caller = await fetchCaller(callerId);
    if (!caller || effectiveAgentRole(caller) !== "brainstorm" || isRetiredAgent(caller)) {
      throw new Error(`cannot hand off a lead: ${callerId} is not a live Buddy`);
    }
    const teams = ctx.teams ?? loadTeamsRegistry();
    const callerLane = findLaneInRegistry(lane, teams);
    const callerTeam = findTeamInRegistry(team, teams);
    if (!callerLane || !callerTeam || callerLane.team.id !== callerTeam.id) throw new Error(`cannot hand off a lead: caller team "${team}" / lane "${lane}" is not in the team registry`);
    if (askedLane && findLaneInRegistry(askedLane, teams)?.lane.id !== callerLane.lane.id) throw new Error(`cannot hand off a lead: target lane "${askedLane}" is not the caller's lane "${callerLane.lane.id}"`);
    const live = await ctx.findLiveLeads({ team: callerTeam.id, lane: callerLane.lane.id });
    if (!live.length) throw new Error(`cannot hand off a lead: lane "${callerLane.lane.id}" has no live lead`);
    target = resolveLeadWinner(live).winner;
    if (askedId && askedId !== target.id) throw new Error(`cannot hand off a lead: ${askedId} is not the live lead of lane "${callerLane.lane.id}" (${target.id})`);
    trigger = "buddy";
    // The live lead is already a fresh handoff successor: a repeated call (no explicit target id) returns it instead of
    // handing off again. An explicit id means "hand off that agent", so it never takes this short-circuit.
    const age = Date.now() - Date.parse(target.createdAt ?? "");
    if (!askedId && target.labels?.["vs.handoff-from"] && age >= 0 && age < HANDOFF_DEDUPE_MS) {
      return handoffView({ successorId: target.id, title: target.title, oldLeadId: target.labels["vs.handoff-from"], deduped: true }, { trigger });
    }
  } else if (callerRole === LEAD_ROLE && (await isCrossLaneRequest(ctx, askedId, askedLane, callerId))) {
    // (c) The Squad's hub lead (Overlord) hands off any lane's live lead in its own Squad. Identity is the runner record's, never args.
    if (!callerId) throw new Error("cannot hand off a lead: caller has no agent id");
    const caller = await fetchCaller(callerId);
    if (!caller || effectiveAgentRole(caller) !== LEAD_ROLE || isRetiredAgent(caller) || caller.archivedAt || (caller.status === "closed" && caller.resumable !== true)) {
      throw new Error(`cannot hand off a lead: ${callerId} is not a live lead`);
    }
    // Lane and Squad come from the caller's own record, never from env (VS_LANE/VS_TEAM are spoofable).
    const teams = ctx.teams ?? loadTeamsRegistry();
    const callerLane = findLaneInRegistry(clean(caller.labels?.lane || caller.labels?.lead), teams);
    const callerTeam = findTeamInRegistry(clean(caller.labels?.team), teams);
    if (!callerLane || !callerTeam || callerLane.team.id !== callerTeam.id) throw new Error(`cannot hand off a lead: caller record team "${caller.labels?.team ?? ""}" / lane "${caller.labels?.lane ?? ""}" is not in the team registry`);
    if (!isHubLane(callerTeam, callerLane.lane)) throw new Error("cannot hand off a lead: a lead may only hand off itself unless it is the Squad's hub lead (Overlord)");
    if (!askedLane) throw new Error("cannot hand off a lead: the Overlord must name the target lane");
    const targetLane = findLaneInRegistry(askedLane, teams);
    if (!targetLane || targetLane.team.id !== callerTeam.id) throw new Error(`cannot hand off a lead: target lane "${askedLane}" is not in the caller's Squad "${callerTeam.id}"`);
    const live = await ctx.findLiveLeads({ team: callerTeam.id, lane: targetLane.lane.id });
    if (!live.length) throw new Error(`cannot hand off a lead: lane "${targetLane.lane.id}" has no live lead (spawn one instead)`);
    target = resolveLeadWinner(live).winner;
    if (askedId && askedId !== target.id) throw new Error(`cannot hand off a lead: ${askedId} is not the live lead of lane "${targetLane.lane.id}" (${target.id})`);
    if (target.id === callerId || targetLane.lane.id === callerLane.lane.id) throw new Error("cannot hand off a lead: the Overlord hands off other lanes' leads; use a plain handoff_lead for itself");
    trigger = "overlord";
    const age = Date.now() - Date.parse(target.createdAt ?? "");
    if (!askedId && target.labels?.["vs.handoff-from"] && age >= 0 && age < HANDOFF_DEDUPE_MS) {
      return handoffView({ successorId: target.id, title: target.title, oldLeadId: target.labels["vs.handoff-from"], deduped: true }, { trigger });
    }
    // O6 floor (mirrored by the server re-check): a healthy lead under 100k is steered first; --force needs a steer.
    // The lane listing omits lastPromptAt/lastProgressAt, so read the lead itself before judging "wedged".
    const floor = (await import("../lead-handoff.mjs")).overlordFloorVerdict((await fetchAgent(target.id)) ?? target, { force: args.force === true, steer: clean(args.steer) });
    if (floor.refuse) throw new Error(`cannot hand off a lead: ${floor.message}`);
  } else if (callerRole === LEAD_ROLE) {
    if (!callerId) throw new Error("cannot hand off a lead: caller has no agent id");
    // The lane is canonicalised through the registry like the Buddy branch; an empty or unknown lane is refused.
    const rawLane = clean(ctx.identity.lane);
    if (!rawLane) throw new Error("cannot hand off a lead: caller has no lane");
    const callerLane = findLaneInRegistry(rawLane, ctx.teams ?? loadTeamsRegistry());
    if (!callerLane) throw new Error(`cannot hand off a lead: caller lane "${rawLane}" is not in the team registry`);
    if ((askedId && askedId !== callerId) || (askedLane && findLaneInRegistry(askedLane, ctx.teams ?? loadTeamsRegistry())?.lane.id !== callerLane.lane.id)) {
      throw new Error("cannot hand off a lead: a lead may only hand off itself");
    }
    target = await fetchCaller(callerId);
    const known = Boolean(target);
    if (!target) target = { id: callerId };
    trigger = "self";
    const successor = clean(target.labels?.["handoff-successor"]);
    if (successor) {
      const s = await fetchAgent(successor);
      return handoffView({ successorId: successor, title: s?.title ?? "", oldLeadId: callerId, deduped: true }, { trigger });
    }
    if (target.archivedAt || (target.status === "closed" && target.resumable !== true) || (known && (effectiveAgentRole(target) !== "lead" || isRetiredAgent(target)))) {
      throw new Error(`cannot hand off a lead: ${callerId} is not a live lead`);
    }
  } else {
    throw new Error(`cannot hand off a lead: caller role is "${callerRole || "none"}", only a brainstorm (Buddy) or a lead may`);
  }
  const steer = clean(args.steer).slice(0, 2000);
  const body = { trigger, agentId: target.id, callerId, retireImmediately: true, httpWaitMs: 180_000, ...(trigger === "overlord" && steer ? { steer } : {}), ...(trigger === "overlord" && args.force === true ? { force: true } : {}) };
  let res;
  let via = "server";
  if (ctx.performHandoff) {
    res = await ctx.performHandoff(body);
    via = "injected";
  } else {
    // One process owns the dedupe slots: route through the VS server, in-process only when it is unreachable.
    try {
      res = await postLeadHandoffToServer(body, ctx);
    } catch (e) {
      if (!e?.unreachable) throw e;
      via = "in-process (VS server unreachable)";
      res = await (await import("../lead-handoff.mjs")).performLeadHandoffHttp({ ...body, ...(ctx.inProcessDeps ?? {}) });
    }
  }
  if (res?.ok === false || res?.error) throw new Error(`handoff failed: ${res.error ?? "unknown"}`);
  // A pre-H1 server doesn't know the route/shape and answers without a successor id: nothing was spawned.
  if (!clean(res?.successorId ?? res?.id)) throw new Error("handoff failed: the VS server returned no successor agent id (server too old for lead handoff, or no agent was created)");
  return handoffView(res, { trigger, via });
}

/**
 * POST the handoff to the running VS server's single /__vibesquad/lead-handoff endpoint as this caller (agent headers for an
 * agent, never the owner's local token; X1b). Connection failures carry `unreachable`; a refusal is returned as `{ error }`
 * (the caller reports it as a failed handoff), a 403 with its status in the text.
 */
async function postLeadHandoffToServer(body, ctx) {
  const r = await postAsCaller(ctx, "/__vibesquad/lead-handoff", JSON.stringify(body), 200_000);
  const json = await r.json().catch(() => ({}));
  return r.ok ? json : httpRefusal({ status: r.status, body: json });
}

/** A non-2xx answer as the `{ error }` the tools report: the server's own text, prefixed with the status only for a 403 (X1b). */
const httpRefusal = (e) => {
  const body = e.body && typeof e.body === "object" ? e.body : {};
  const text = String(body.error ?? `server answered ${e.status}`);
  return { ...body, error: e.status === 403 && !text.startsWith("403") ? `403: ${text}` : text };
};

/**
 * Restart a lane's Buddy through the existing /__vibesquad/brainstorm-restart path (archives the old Buddy, keeps its children, spawns a
 * fresh one from the brief). Allowed: the owner (a human `vs`, no agent id), that lane's live lead, and the Squad's hub lead (Overlord)
 * for any lane of its own Squad. The caller's role/lane/team are read from its runner record, never from env or args; the server
 * route re-checks callerId on its own (server/buddy-restart-auth.mjs). A lane with no Buddy yet (a new `vs pin new` lane) gets its
 * first one through the same start-brainstorm path the UI's first pin click uses (idea-95), with the same grants.
 */
async function restartBuddy(ctx, args = {}) {
  await verifyCaller(ctx); // X1b: a wrong/missing token is a 403 here; the owner path below needs owner proof
  const callerId = clean(ctx.identity.agentId);
  const askedLane = clean(pick(args, "lane", "laneId"));
  const profileName = buddyProfileArg(args);
  const teams = ctx.teams ?? loadTeamsRegistry();
  const fetchAgent = async (id) => agentOf(await ctx.withBackend({ id }, (b) => b.fetchAgent(id)).catch(() => null));
  let teamId;
  let laneId;
  let caller = null;
  if (callerId) {
    caller = await fetchCallerRecord(ctx, callerId); // the caller's own lookup never swallows an error (X1b)
    if (!caller || effectiveAgentRole(caller) !== LEAD_ROLE || !isLiveAgent(caller)) {
      throw new Error(`cannot restart a Buddy: ${callerId} is not a live lead (only the owner, the lane's lead or the Squad's Overlord may)`);
    }
    // Lane and Squad come from the caller's own record, never from env (VS_LANE/VS_TEAM are spoofable).
    const callerTeam = findTeamInRegistry(clean(caller.labels?.team), teams);
    const callerLane = findLaneInRegistry(clean(caller.labels?.lane || caller.labels?.lead), teams, callerTeam?.id);
    if (!callerLane || !callerTeam || callerLane.team.id !== callerTeam.id) throw new Error(`cannot restart a Buddy: caller record team "${caller.labels?.team ?? ""}" / lane "${caller.labels?.lane ?? ""}" is not in the team registry`);
    const target = askedLane ? findLaneInRegistry(askedLane, teams, callerTeam.id) : callerLane;
    if (!target) throw new Error(`cannot restart a Buddy: lane "${askedLane}" is not in the team registry`);
    if (target.team.id !== callerTeam.id) throw new Error(`cannot restart a Buddy: lane "${target.lane.id}" is in another Squad than the caller's "${callerTeam.id}"`);
    if (target.lane.id !== callerLane.lane.id && !isHubLane(callerTeam, callerLane.lane)) {
      throw new Error("cannot restart a Buddy: a lead may only restart its own lane's Buddy unless it is the Squad's hub lead (Overlord)");
    }
    teamId = callerTeam.id;
    laneId = target.lane.id;
  } else {
    if (!askedLane) throw new Error("cannot restart a Buddy: --lane is required");
    const target = findLaneInRegistry(askedLane, teams);
    if (!target) throw new Error(`cannot restart a Buddy: lane "${askedLane}" is not in the team registry`);
    teamId = target.team.id;
    laneId = target.lane.id;
  }
  const res = await ctx.withBackend({ lane: laneId, requireRunner: true }, (b) => (b.fetchAgents ?? b.listAgents).call(b, {}));
  const list = Array.isArray(res) ? res : Array.isArray(res?.entries) ? res.entries : Array.isArray(res?.agents) ? res.agents : null;
  if (!list) throw new Error("cannot restart a Buddy: agent list unreadable");
  const buddies = list.map((e) => e?.agent ?? e).filter((a) => a && whoCandidate(a, { teams, wantTeamId: teamId, wantLane: laneId })?.role === "brainstorm");
  // The lane's main Buddy (no topic label) restarts; a topic Buddy only when it is the sole one.
  const buddy = buddies.find((a) => !clean(a.labels?.topic)) ?? (buddies.length === 1 ? buddies[0] : null);
  if (!buddy && buddies.length) throw new Error(`cannot restart a Buddy: lane "${laneId}" has only topic Buddies`);
  const trigger = callerId ? (caller && findLaneInRegistry(clean(caller.labels?.lane || caller.labels?.lead), teams)?.lane.id === laneId ? "lane-lead" : "overlord") : "owner";
  const send = async (body) => {
    const out = ctx.restartBuddyRequest ? await ctx.restartBuddyRequest(body) : await postBuddyRestartToServer(body, ctx);
    if (out?.ok === false || out?.error) throw new Error(`buddy restart failed: ${out.error ?? out.reason ?? "unknown"}`);
    return out;
  };
  const extra = { ...(callerId ? { callerId } : {}), ...(profileName ? { profileName } : {}) };
  if (!buddy) {
    // idea-95: no Buddy yet. The route's start path dedupes concurrent starts per lane and reuses (or reopens) any Buddy that appeared
    // meanwhile, so a race or a retry still leaves exactly one. The route re-checks the callerId grant for the target lane.
    const out = await send({ agentId: "start-brainstorm", reason: "start-brainstorm", laneId, teamId, ...extra });
    return { id: out.newAgentId ?? out.id ?? "", oldBuddyId: "", started: true, ...(out.reused ? { reused: true } : {}), lane: laneId, team: teamId, title: out.title ?? "", trigger };
  }
  if (callerId) assertBuddyRestartAllowed(caller, buddy, teams);
  // The route special-cases a few reason strings (start-brainstorm, auto*): the verb's free text is always prefixed.
  const why = clean(args.reason).slice(0, 200);
  const out = await send({ agentId: buddy.id, laneId, teamId, reason: why ? `buddy-restart-verb: ${why}` : "buddy-restart-verb", ...extra });
  return { id: out.newAgentId ?? out.id ?? "", oldBuddyId: buddy.id, lane: laneId, team: teamId, title: out.title ?? "", ...(out.skipped ? { skipped: true, reason: out.reason } : {}), trigger };
}

/** idea-95: `--profile <Brainstorm profile>` wins; `--provider claude|gemini` picks the stock Brainstorm profile. The route only accepts brainstorm-role profiles. */
function buddyProfileArg(args) {
  const profile = clean(args.profile).slice(0, 120);
  if (profile) return profile;
  const provider = clean(args.provider).toLowerCase();
  if (!provider) return "";
  if (provider.startsWith("claude")) return "Brainstorm - Claude";
  if (provider.startsWith("gemini") || provider.startsWith("antigravity")) return "Brainstorm - Gemini";
  throw new Error(`cannot restart a Buddy: unknown provider "${provider}" (use claude or gemini, or --profile "<Brainstorm profile>")`);
}

/** The watch-set registry (server/watch-sets.mjs, W1). Injected via ctx.watchSets for tests; lazy-imported at runtime. */
async function getWatchSets(ctx) {
  if (ctx.watchSets) return ctx.watchSets;
  try {
    const load = ctx.loadWatchSets ?? (() => import("../watch-sets.mjs"));
    return await load();
  } catch {
    throw new Error("watch sets unavailable");
  }
}

/**
 * Register / list / cancel a watch set (W2). `vs watch add <agent...> [--suite] [--restart] [--stall <min>]` lets a lead
 * register the agents + its suite run + a restart it is waiting on, then end its turn; a server-side watcher pings once when
 * the set completes or stalls. Auth mirrors handoff_lead / restart_buddy: the owner defaults to the resolved caller identity,
 * workers are refused, and only the same-Squad Overlord (role=lead on the hub lane) may name a different owner (and only an
 * agent of its own Squad). Identity is read from the runner record, never from env/args.
 */
async function watchTool(ctx, args = {}) {
  const action = clean(args.action);
  if (!["add", "list", "cancel"].includes(action)) throw new Error("watch action must be one of: add, list, cancel");
  await verifyCaller(ctx); // X1b: the gate is the verified caller; a wrong/missing token is a 403 before any lookup
  const callerId = clean(ctx.identity.agentId);
  const callerRole = clean(ctx.identity.role).toLowerCase();
  const teams = ctx.teams ?? loadTeamsRegistry();
  // agentOf keeps a `{ agent: null }` wrapper when the backend has no record; normalize to null so a missing agent is detectable.
  const norm = (a) => (a && a.id ? a : null);
  const fetchAgent = async (id) => norm(agentOf(await ctx.withBackend({ id }, (b) => b.fetchAgent(id)).catch(() => null)));

  // Resolve the caller's identity from its runner record (never env/args), exactly like handoff_lead / restart_buddy.
  // The caller's own lookup never swallows an error (X1b).
  let caller = null;
  if (callerId) caller = await fetchCallerRecord(ctx, callerId);
  const recRole = caller ? effectiveAgentRole(caller) : "";
  // Workers and digest agents get no watch verb (a digest worker is not a lead/Buddy and must never register watches).
  if (recRole === "worker" || recRole === "digest" || (!caller && (!callerRole || callerRole === "worker"))) {
    throw new Error("workers may not use the watch verb");
  }
  // Only a live lead or Buddy may watch; retired/former-lead/closed/unknown callers are refused outright.
  if (!caller || !isLiveAgent(caller) || (recRole !== "lead" && recRole !== "brainstorm")) {
    throw new Error("only a live lead or Buddy may use the watch verb");
  }
  // Lane and Squad come from the caller's own record, never from env (VS_LANE/VS_TEAM are spoofable).
  const callerTeam = findTeamInRegistry(clean(caller.labels?.team), teams);
  const callerLane = findLaneInRegistry(clean(caller.labels?.lane || caller.labels?.lead), teams, callerTeam?.id);
  if (!callerTeam || !callerLane || callerLane.team.id !== callerTeam.id) {
    throw new Error(`only a live lead or Buddy may use the watch verb: caller record team "${caller.labels?.team ?? ""}" / lane "${caller.labels?.lane ?? ""}" is not in the team registry`);
  }
  const team = callerTeam.id;
  let lane = callerLane.lane.id;
  const isOverlord = recRole === "lead" && isHubLane(callerTeam, callerLane.lane);

  // owner defaults to the caller; only the same-Squad Overlord may name a different one (and only a live lead/Buddy of its own Squad).
  let owner = callerId;
  const requestedOwner = clean(pick(args, "owner"));
  if (requestedOwner && requestedOwner !== callerId) {
    if (!isOverlord) throw new Error("only the same-Squad Overlord may set a different owner");
    const ownerRec = await fetchAgent(requestedOwner);
    if (!ownerRec) throw new Error(`cannot watch for an unknown agent "${requestedOwner}"`);
    if (!isLiveAgent(ownerRec) || !["lead", "brainstorm"].includes(effectiveAgentRole(ownerRec))) {
      throw new Error(`cannot watch for a retired, closed, worker or digest agent "${requestedOwner}"`);
    }
    const ownerTeam = findTeamInRegistry(clean(ownerRec.labels?.team), teams);
    if (!ownerTeam || ownerTeam.id !== team) throw new Error("only the same-Squad Overlord may set a different owner in its own Squad");
    owner = requestedOwner;
    const ownerLane = findLaneInRegistry(clean(ownerRec.labels?.lane || ownerRec.labels?.lead), teams, ownerTeam.id);
    if (ownerLane) lane = ownerLane.lane.id;
  }

  const ws = await getWatchSets(ctx);

  if (action === "cancel") {
    const id = clean(pick(args, "id"));
    if (!id) throw new Error("id is required to cancel a watch");
    // X1 F6: same rule as `add`'s owner: only the set's owner, or the same-Squad Overlord for a set of its own Squad, may
    // cancel. Ids are listable (`watch list` with any owner), so the id alone must never be the capability.
    const allow = (set) => set.owner === callerId || (isOverlord && String(set.team ?? "") === team);
    const out = await ws.cancelWatch(id, callerId, { allow });
    if (out?.refused) throw new Error(out.error);
    return out;
  }
  if (action === "list") {
    const opts = {};
    if (owner) opts.owner = owner;
    if (team) opts.team = team;
    return ws.listWatches(opts);
  }
  // add
  const items = [];
  const seen = new Set();
  const rawAgents = Array.isArray(args.agents) ? args.agents : args.agents !== undefined ? [args.agents] : [];
  for (const a of rawAgents) {
    const ref = clean(a);
    if (!ref) continue;
    if (!isRunnerId(ref)) throw new Error(`watch agents must be runner ids (rn-...), got "${ref}"`);
    if (seen.has(ref)) continue;
    seen.add(ref);
    items.push({ kind: "agent", ref });
  }
  if (args.suite) items.push({ kind: "suite", ref: "" });
  if (args.restart) items.push({ kind: "restart", ref: "" });
  if (!items.length) throw new Error("a watch set needs at least one item (agents, --suite or --restart)");
  const stallMin = args.stallMin === undefined ? 15 : Number(args.stallMin);
  if (!Number.isFinite(stallMin) || stallMin <= 0) throw new Error("stallMin must be a positive number of minutes");
  return ws.addWatch({ owner, team, lane, items, stallMin });
}

/** POST /__vibesquad/brainstorm-restart as this caller (agent headers for an agent, never the owner's local token; X1b). */
async function postBuddyRestartToServer(body, ctx) {
  let r;
  try {
    r = await postAsCaller(ctx, "/__vibesquad/brainstorm-restart", JSON.stringify(body), 200_000);
  } catch (e) {
    if (!e?.unreachable) throw e;
    throw new Error(`${e.message} (a Buddy restart runs through the server so its archive/spawn budgets apply)`);
  }
  const json = await r.json().catch(() => ({}));
  return r.ok ? json : httpRefusal({ status: r.status, body: json });
}

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: true });
const S = { type: "string" };
const STAKES_PARAM = { type: "string", enum: STAKES_VALUES, description: "Routes the spawn's model + effort by stakes; sets labels.stakes (an explicit labels.stakes wins)." };

/** Canonical VS tools. */
export const VS_TOOLS = {
  spawn_worker: {
    description: "Start a worker agent in your lane from a VS profile. Optional stakes (tierA-security | tierA-invariant | normal | mechanical) routes the model + effort by stakes (same as labels.stakes; labels.stakes wins if both). Returns {id, title}.",
    inputSchema: obj({ title: S, profile: S, prompt: S, cwd: S, provider: S, model: S, thinkingOptionId: S, thinking: S, labels: { type: "object" }, stakes: STAKES_PARAM }, ["title", "profile", "prompt"]),
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
    description: "Write a done/decision/blocker entry to your team log as yourself. The VS server attributes it from your verified token (X1): a worker may only log done/blocker (refs forced to itself), a digest worker done (refs forced to the worker it digests), a lead/Buddy any type; decision from a worker is a 403. Returns {logged, type, agent, refs} as recorded.",
    inputSchema: obj({ type: { type: "string", enum: REPORT_TYPES }, text: S }, ["type", "text"]),
    run: reportTool,
  },
  handoff_lead: {
    description: "Hand the lane's lead over to a successor (the lead-handoff flow: spawns it, re-parents workers, marks the old lead former-lead). A Buddy hands off its own lane's live lead; a lead hands off itself (write your packet Judgment first); the Squad's Overlord (hub lead) may hand off any lane's lead in its Squad with an optional steer note for the successor. Returns {id, title, oldLeadId}.",
    inputSchema: obj({ lane: S, steer: S, force: { type: "boolean" } }),
    run: handoffLead,
  },
  restart_buddy: {
    description: "Restart a lane's Buddy (archives the old Buddy, keeps its children, spawns a fresh one from the brief), or start the lane's first Buddy when it has none (a new pinned lane). A lead restarts its own lane's Buddy; the Squad's Overlord (hub lead) any lane in its Squad. Optional reason; optional profile (a Brainstorm profile name) or provider (claude|gemini). Returns {id, oldBuddyId, lane, team, title, started?}.",
    inputSchema: obj({ lane: S, reason: S, profile: S, provider: S }),
    run: restartBuddy,
  },
  watch: {
    description: "Register, list or cancel a watch set: a lead registers the agents + its suite run + a restart it is waiting on and ends its turn; a server-side watcher pings once when the whole set completes or stalls (stallMin, default 15). Default owner is the caller; workers are refused; only the same-Squad Overlord may set a different owner (within its own Squad). Returns {id} for add, the watch list for list, and a cancel confirmation for cancel.",
    inputSchema: obj({ action: { type: "string", enum: ["add", "list", "cancel"] }, agents: { type: "array", items: S }, suite: { type: "boolean" }, restart: { type: "boolean" }, stallMin: { type: "number" }, id: S, owner: S }, ["action"]),
    run: watchTool,
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
  create_agent: obj({ title: S, provider: S, model: S, modeId: S, mode: S, initialPrompt: S, prompt: S, cwd: S, labels: { type: "object" }, profile: S, thinkingOptionId: S, thinking: S, stakes: STAKES_PARAM }),
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
    await verifyCaller(ctx); // R1 M2: the metric is logged as the verified caller (a bad token is a 403 before any log)
    const { agentId, lane } = ctx.identity;
    try {
      await ctx.writeLog({ type: "metric", text: `mcp-alias: tool=${name} caller=${agentId || "unknown"} lane=${lane || "unknown"}` });
    } catch { /* metrics are best effort */ }
  }
  const result = await def.run(ctx, args ?? {});
  return ALIASES[name] ? aliasResult(name, result) : result;
}
