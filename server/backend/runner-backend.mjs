// RunnerBackend: the AgentBackend seam over the VS agent runner's HTTP API (docs/PLAN_OWN_DAEMON.md Block 3).
// squad/team/lane/role/ord/profile are first-class fields on the runner record; this class maps them (and the
// runner's event log) back into the shapes callers already read from PaseoBackend/DaemonClient.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunnerClient, runnerHome } from "./runner-client.mjs";
import { joinTarget, joinInto, canExtendThought } from "../reply-coalesce.mjs";
import { refreshWhosHere } from "../whos-here.mjs";
import { runnerLanes } from "./lane-routing.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// Log event types that change the roster row (everything else is timeline-only).
const ROSTER_EVENTS = new Set(["created", "status", "meta", "exit", "archive", "usage", "permission", "session"]);

const FIRST_CLASS = ["squad", "team", "lane", "role", "ord", "profile"];
const ENV_FOR = { lane: "VS_LANE", team: "VS_TEAM", role: "VS_ROLE", profile: "VS_PROFILE" };
const CLAUDE_PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"]);
const STATUS = { starting: "initializing", running: "running", idle: "idle", exited: "closed", lost: "closed", unknown: "idle" };

export const isRunnerId = (id) => typeof id === "string" && id.startsWith("rn-");

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/**
 * Adapter usage events -> the usage shapes callers read: lastUsage (what lead-handoff / the UI context meter use)
 * and tokenUsage (same numbers, plain). Empty until the adapter has reported one.
 */
function usageFields(u) {
  if (!u || !Number.isFinite(u.contextTokens)) return {};
  const lastUsage = {
    contextWindowUsedTokens: u.contextTokens,
    ...(Number.isFinite(u.contextMax) ? { contextWindowMaxTokens: u.contextMax } : {}),
    inputTokens: u.inputTokens ?? u.contextTokens,
    ...(Number.isFinite(u.outputTokens) ? { outputTokens: u.outputTokens } : {}),
    ...(Number.isFinite(u.costUsd) ? { costUsd: u.costUsd } : {}),
  };
  return { lastUsage, tokenUsage: { ...lastUsage, usedTokens: u.contextTokens } };
}

/** Runner status record -> the agent snapshot shape (PaseoAgent) the callers and UI read. */
export function toAgent(rec) {
  const meta = rec.meta ?? {};
  const labels = { ...(meta.labels ?? {}) };
  for (const k of FIRST_CLASS) if (meta[k] !== undefined && meta[k] !== null && meta[k] !== "") labels[k] = String(meta[k]);
  labels.backend = "runner";
  return {
    id: rec.id,
    provider: rec.provider,
    model: rec.model ?? null,
    cwd: rec.cwd,
    title: meta.title || rec.id,
    status: STATUS[rec.status] ?? "idle",
    labels,
    modeId: meta.permissionMode ?? meta.acpMode ?? (rec.provider === "claude" ? "auto" : null),
    thinkingOptionId: null,
    requiresAttention: (rec.pendingPermissions ?? []).length > 0,
    pendingPermissions: (rec.pendingPermissions ?? []).map((p) => ({ id: p.id, toolName: p.toolName ?? null })),
    ...usageFields(rec.usage),
    createdAt: iso(rec.createdAt),
    updatedAt: iso(rec.updatedAt ?? rec.createdAt),
    lastActivityAt: iso(rec.updatedAt ?? rec.createdAt),
    archivedAt: iso(rec.archivedAt),
    workspaceId: null,
    backend: "runner",
  };
}

/**
 * Synchronous, read-only view of a runner agent straight from its JSONL log (<runner home>/agents/<id>.jsonl).
 * For callers that cannot await the HTTP API (vs log identity, vs who). Returns the toAgent() snapshot or null.
 */
export function readRunnerAgentSync(id, { env = process.env } = {}) {
  if (!isRunnerId(id) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  let text;
  try {
    text = fs.readFileSync(path.join(runnerHome(env), "agents", `${id}.jsonl`), "utf8");
  } catch {
    return null;
  }
  let created = null;
  let status = "unknown";
  let exited = false;
  let archivedAt = null;
  let last = null;
  let usage = null;
  const perms = new Map();
  const meta = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    last = e;
    if (e.type === "created") { created = e; Object.assign(meta, e.meta); }
    else if (e.type === "meta") Object.assign(meta, e.patch, e.patch?.labels ? { labels: { ...meta.labels, ...e.patch.labels } } : {});
    else if (e.type === "status") status = e.status;
    else if (e.type === "exit") exited = true;
    else if (e.type === "archive") archivedAt = e.ts;
    else if (e.type === "usage") usage = e;
    else if (e.type === "permission") { if (e.phase === "request") perms.set(e.id, { id: e.id, toolName: e.toolName }); else perms.delete(e.id); }
  }
  if (!created) return null;
  return toAgent({
    id, provider: created.provider, model: created.model, cwd: created.cwd, meta,
    status: exited ? "exited" : status, createdAt: created.ts, updatedAt: last?.ts, archivedAt,
    usage, pendingPermissions: [...perms.values()],
  });
}

/** Every runner agent on this machine (sync, log-derived). Empty when no runner dir exists. */
export function listRunnerAgentsSync({ env = process.env } = {}) {
  let names;
  try {
    names = fs.readdirSync(path.join(runnerHome(env), "agents"));
  } catch {
    return [];
  }
  return names.filter((f) => f.endsWith(".jsonl")).map((f) => readRunnerAgentSync(f.slice(0, -6), { env })).filter(Boolean);
}

/** Runner JSONL events -> timeline entries ({ item, timestamp, seqStart, seqEnd }) as the timeline UI expects. */
export function toTimeline(events) {
  const entries = [];
  const toolIdx = new Map();
  for (const e of events) {
    const base = { timestamp: iso(e.ts), seqStart: e.seq, seqEnd: e.seq };
    const last = entries[entries.length - 1];
    switch (e.type) {
      case "input":
        entries.push({ ...base, item: { type: "user_message", text: e.text, ...(e.images ? { images: e.images } : {}) } });
        break;
      case "output": {
        // The log is walked in order and input / tool / error / turn_done are the separators, so no seq arithmetic:
        // stderr / raw / meta lines mid-reply must not split it. Text after a thought rejoins the message before it.
        const next = { ...base, item: { type: "assistant_message", text: e.text } };
        const i = joinTarget(entries, next);
        if (i >= 0) entries[i] = joinInto(entries[i], next, { trailing: entries.slice(i + 1) });
        else entries.push(next);
        break;
      }
      case "thought":
        if (canExtendThought(entries)) {
          last.item.text += e.text;
          last.seqEnd = e.seq;
        } else entries.push({ ...base, item: { type: "reasoning", text: e.text } });
        break;
      case "tool":
        if (e.phase === "call") {
          toolIdx.set(e.id, entries.length);
          entries.push({ ...base, item: { type: "tool_call", callId: e.id, name: e.name ?? "tool", status: "running", detail: { input: e.input, kind: e.kind } } });
        } else {
          const t = entries[toolIdx.get(e.id)];
          if (t) {
            const failed = e.isError || e.status === "failed";
            t.item.status = failed ? "failed" : e.status === "completed" || e.phase === "result" ? "completed" : t.item.status;
            if (failed) t.item.error = "tool failed";
            t.seqEnd = e.seq;
          }
        }
        break;
      case "turn_done":
        if (last) last.turnEnd = true; // a real turn boundary: the next turn's text never rejoins this reply
        break;
      case "error":
        entries.push({ ...base, item: { type: "error", message: e.message } });
        break;
      default:
        break;
    }
  }
  return entries;
}

let promptModule;
/** The Paseo plugin's own pure prompt builder (EVERYONE_LAYER + role pack), so both backends layer identically. */
async function injectedPrefix(role, cwd) {
  if (!["lead", "brainstorm", "worker"].includes(role)) return "";
  try {
    promptModule ??= await import("../../plugin/index.server.ts");
    return promptModule.injectedPrefix(role, cwd) || "";
  } catch {
    return ""; // prompt layering is best effort: an agent without it is still usable
  }
}

/** Shown status of a tracked agent: "error" while an errored turn has not been followed by a new one. */
const viewStatus = (t) => (t.errored && t.status !== "running" ? "error" : t.status);

export class RunnerBackend {
  constructor({ client = new RunnerClient(), buildPrefix = injectedPrefix, whosHere = refreshWhosHere, rootDir = REPO_ROOT, lanes = runnerLanes } = {}) {
    Object.defineProperty(this, "rc", { value: client });
    Object.defineProperty(this, "buildPrefix", { value: buildPrefix });
    Object.defineProperty(this, "whosHere", { value: whosHere });
    Object.defineProperty(this, "rootDir", { value: rootDir });
    Object.defineProperty(this, "listeners", { value: new Set() });
    Object.defineProperty(this, "live", { value: { stream: null, chain: Promise.resolve(), turn: new Map(), gen: 0 } });
    // Paseo-side agents of the same lanes, set by the RoutingBackend so a Who's here refresh sees the whole lane.
    Object.defineProperty(this, "siblings", { value: { list: null } });
    Object.defineProperty(this, "lanes", { value: lanes });
  }

  /** `fn()` resolves the non-runner agents (Paseo) so a lane brief lists everyone, not just runner agents. */
  useSiblingAgents(fn) {
    this.siblings.list = fn;
  }

  /** Detach `fn` (only if it is still the active provider: a newer owner keeps its own). */
  dropSiblingAgents(fn) {
    if (this.siblings.list === fn) this.siblings.list = null;
  }

  runCli() {
    return null;
  }

  async connect() {
    await this.rc.ensureRunning();
  }

  async close() {}

  async createAgent({ config = {}, initialPrompt, prompt, labels = {}, env = {} } = {}) {
    await this.rc.ensureRunning();
    const meta = { title: config.title, labels: {} };
    for (const k of FIRST_CLASS) {
      const v = labels[k] ?? (ENV_FOR[k] ? env[ENV_FOR[k]] : undefined);
      if (v !== undefined && v !== "") meta[k] = v;
    }
    for (const [k, v] of Object.entries(labels)) if (!FIRST_CLASS.includes(k) && v !== undefined) meta.labels[k] = String(v);
    // Claude permission modes only mean something to claude; for ACP providers modeId is the agent's own ACP mode.
    if (config.modeId) {
      if (config.provider === "claude") { if (CLAUDE_PERMISSION_MODES.has(config.modeId)) meta.permissionMode = config.modeId; }
      else meta.acpMode = config.modeId;
    }
    const prefix = await this.buildPrefix(meta.role || "", config.cwd);
    const systemPrompt = [prefix, config.systemPrompt].filter(Boolean).join("\n\n") || undefined;
    const { id } = await this.rc.request("POST", "/agents", {
      provider: config.provider,
      model: config.model,
      cwd: config.cwd,
      prompt: initialPrompt || prompt || undefined,
      systemPrompt,
      meta,
    });
    const agent = (await this.fetchAgent(id)).agent;
    await this.refreshLaneWhosHere(agent.labels?.lane);
    return agent;
  }

  /** Keep the lane brief's "Who's here" current, like the Paseo plugin does on spawn. Best effort. */
  async refreshLaneWhosHere(lane) {
    if (!lane) return;
    try {
      const mine = await this.listAgents();
      let agents;
      let others = null;
      if (this.siblings.list) others = await this.siblings.list().catch(() => null); // Paseo down/closed: not an error
      if (others) {
        const seen = new Set(mine.map((a) => a.id));
        agents = [...mine, ...others.filter((a) => !seen.has(a.id))];
      } else if (this.lanes().has(String(lane).toLowerCase())) {
        agents = mine; // lane lives wholly on the runner (and Paseo cannot be asked)
      } else {
        return; // cannot see the whole lane (Paseo agents may share it): leave the brief alone rather than wipe them
      }
      this.whosHere({ laneId: lane, agents, rootDir: this.rootDir });
    } catch {
      /* the brief is cosmetic: never fail a spawn over it */
    }
  }

  async fetchAgent(id) {
    const rec = await this.rc.request("GET", `/agents/${encodeURIComponent(id)}`);
    return { agent: toAgent(rec), project: null };
  }

  async getAgent(id) {
    return (await this.fetchAgent(id)).agent;
  }

  async fetchAgents(opts = {}) {
    const { ids } = await this.rc.request("GET", "/agents");
    const recs = await Promise.all(ids.map((id) => this.rc.request("GET", `/agents/${id}`).catch(() => null)));
    const includeArchived = opts?.filter?.includeArchived;
    const entries = recs
      .filter(Boolean)
      .map((r) => ({ agent: toAgent(r), project: null }))
      .filter((e) => includeArchived || !e.agent.archivedAt);
    return { entries };
  }

  async listAgents(opts) {
    return (await this.fetchAgents(opts)).entries.map((e) => e.agent);
  }

  /** opts: { images: [{ data (base64), mimeType }], activeTurnBehavior: 'steer' (default) | 'interrupt' }. */
  async sendAgentPrompt(id, text, opts = {}) {
    const body = { text };
    if (opts.images?.length) body.images = opts.images;
    if (opts.activeTurnBehavior) body.activeTurnBehavior = opts.activeTurnBehavior;
    await this.rc.request("POST", `/agents/${encodeURIComponent(id)}/input`, body);
  }

  async fetchAgentTimeline(id, opts = {}) {
    const { events } = await this.rc.request("GET", `/agents/${encodeURIComponent(id)}/timeline`);
    let entries = toTimeline(events);
    if (opts.direction === "before" && opts.cursor) entries = entries.filter((e) => e.seqStart < opts.cursor.seq);
    const limit = Number(opts.limit) > 0 ? Number(opts.limit) : entries.length;
    // The newest row can be a thought while the reply it belongs to grew in an earlier row, so change-detection
    // (runnerBridge poll) reads the highest seq across all rows, not the last row's.
    const lastSeq = entries.reduce((m, e) => Math.max(m, e.seqEnd ?? -1), -1);
    const hasOlder = entries.length > limit;
    entries = entries.slice(-limit);
    const first = entries[0];
    return { entries, hasOlder, lastSeq, startCursor: first ? { epoch: "runner", seq: first.seqStart } : null };
  }

  async getAgentTimeline(id) {
    return (await this.fetchAgentTimeline(id)).entries;
  }

  async cancelAgent(id) {
    await this.rc.request("POST", `/agents/${encodeURIComponent(id)}/cancel`, {});
  }

  async archiveAgent(id) {
    const lane = (await this.fetchAgent(id).catch(() => null))?.agent.labels?.lane;
    await this.rc.request("POST", `/agents/${encodeURIComponent(id)}/archive`, {});
    await this.deleteHeartbeat(id).catch(() => {}); // an archived agent's self-heartbeats would otherwise fire at it forever
    await this.refreshLaneWhosHere(lane);
    return { archivedAt: new Date().toISOString() };
  }

  async updateAgent(id, { name, labels } = {}) {
    const patch = {};
    if (name) patch.title = name;
    if (labels) {
      patch.labels = {};
      for (const [k, v] of Object.entries(labels)) {
        if (FIRST_CLASS.includes(k)) patch[k] = v;
        else patch.labels[k] = String(v);
      }
    }
    await this.rc.request("POST", `/agents/${encodeURIComponent(id)}/meta`, patch);
    // role / lane changes (a Lead or Buddy retiring to former-*) change who is listed
    if (patch.role !== undefined || patch.lane !== undefined || patch.labels?.role !== undefined) {
      await this.refreshLaneWhosHere((await this.fetchAgent(id).catch(() => null))?.agent.labels?.lane);
    }
  }

  async refreshAgent(id) {
    return (await this.fetchAgent(id)).agent;
  }

  async detachAgent() {}
  /** Heartbeats are VS schedules with a self target; the runner has no daemon-side store, so drop them from schedules.json. */
  async deleteHeartbeat(agentId) {
    const { sharedSchedules } = await import("../schedules.mjs");
    (await sharedSchedules()).deleteHeartbeat(agentId);
  }

  /**
   * Live runner events (one shared SSE stream, opened on the first listener and closed with the last):
   *   { kind: 'connected' | 'disconnected' }
   *   { kind: 'roster', agents }                      full roster, on every (re)connect
   *   { kind: 'agent', agent }                        roster upsert
   *   { kind: 'remove', agentId }                     archived
   *   { kind: 'status', agentId, from, to, agent }    e.g. running -> idle | error
   *   { kind: 'permission', agentId, request }
   *   { kind: 'timeline', agentId, seq, type }        a timeline entry was appended
   * Returns the unsubscribe.
   */
  subscribeEvents(listener) {
    this.listeners.add(listener);
    if (!this.live.stream) {
      this.live.stream = this.rc.stream({
        onOpen: () => this.enqueue((gen) => this.seedRoster(gen)),
        onClose: () => this.emitEvent({ kind: "disconnected" }),
        onMessage: (m) => this.enqueue((gen) => this.handleLogEvent(m, gen)),
      });
    }
    // The first roster a listener sees comes through the same chain as live events, so a slow listAgents() can never
    // land after a newer agent event. Runner unreachable = "disconnected", never an empty roster (clients keep their agents).
    this.enqueue((gen) => this.seedListener(listener, gen));
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.live.stream) {
        this.live.stream.close();
        this.live.stream = null;
        this.live.gen++; // work already queued on the chain belongs to the closed stream: drop its results
        this.live.turn.clear();
      }
    };
  }

  enqueue(fn) {
    const gen = this.live.gen;
    this.live.chain = this.live.chain.then(() => (gen === this.live.gen ? fn(gen) : undefined)).catch(() => {});
  }

  emitEvent(ev) {
    for (const fn of [...this.listeners]) {
      try { fn(ev); } catch { /* a bad listener must not stop the others */ }
    }
  }

  /** A listed agent with the in-memory "error" overlay (the runner log itself only knows running/idle). */
  overlay(agent) {
    return this.live.turn.get(agent.id)?.errored && agent.status !== "running" ? { ...agent, status: "error" } : agent;
  }

  /** Initial roster for one new listener (the stream's shared status map is seeded by seedRoster on open). */
  async seedListener(listener, gen) {
    let agents;
    try { agents = await this.listAgents(); } catch { agents = null; }
    if (gen !== this.live.gen || !this.listeners.has(listener)) return;
    try {
      if (agents) {
        listener({ kind: "roster", agents: agents.map((a) => this.overlay(a)) });
        listener({ kind: "connected" });
      } else listener({ kind: "disconnected" });
    } catch { /* a bad listener must not stop the chain */ }
  }

  /** On (re)connect: remember every agent's status (so the first transition after it is detected) and publish the full roster. */
  async seedRoster(gen) {
    let agents;
    try { agents = await this.listAgents(); } catch { agents = null; }
    if (gen !== this.live.gen) return;
    if (!agents) return this.emitEvent({ kind: "disconnected" });
    const next = new Map();
    for (const a of agents) {
      const prev = this.live.turn.get(a.id);
      next.set(a.id, { status: a.status, errored: !!prev?.errored && a.status !== "running" });
    }
    this.live.turn = next;
    this.emitEvent({ kind: "roster", agents: agents.map((a) => this.overlay(a)) });
    this.emitEvent({ kind: "connected" });
  }

  /**
   * The shown status comes from the log events themselves, applied in log order on the serialized chain, never from
   * fetchAgent's tail-of-log status (which may already include events still queued behind this one).
   */
  async handleLogEvent({ id, event: e }, gen = this.live.gen) {
    if (!id || !e) return;
    this.emitEvent({ kind: "timeline", agentId: id, seq: e.seq, type: e.type });
    const t0 = this.live.turn.get(id);
    const from = t0 && viewStatus(t0);
    // An error during a turn sticks as the agent's status until the next turn starts (what push pages on, once).
    if (e.type === "error") { if (t0?.status === "running") t0.errored = true; return; }
    if (!ROSTER_EVENTS.has(e.type)) return;
    if (e.type === "archive") {
      this.live.turn.delete(id);
      this.emitEvent({ kind: "remove", agentId: id });
      return;
    }
    let agent;
    try { agent = (await this.fetchAgent(id)).agent; } catch { return; } // runner restarting: the next event resyncs
    if (gen !== this.live.gen) return;
    const t = t0 ?? { status: agent.status, errored: false };
    if (e.type === "status" && e.status) {
      t.status = STATUS[e.status] ?? e.status;
      if (t.status === "running") t.errored = false; // next turn began
    } else if (e.type === "exit") {
      t.status = "closed";
      if (from === "running" && (e.error || (e.code ?? 0) !== 0)) t.errored = true; // died mid-turn
    }
    this.live.turn.set(id, t);
    const to = viewStatus(t);
    const shown = { ...agent, status: to };
    this.emitEvent({ kind: "agent", agent: shown });
    if (from !== undefined && from !== to) this.emitEvent({ kind: "status", agentId: id, from, to, agent: shown });
    if (e.type === "permission" && e.phase === "request") this.emitEvent({ kind: "permission", agentId: id, request: { id: e.id, toolName: e.toolName } });
    if (e.type === "exit") await this.refreshLaneWhosHere(agent.labels?.lane);
  }

  /** AgentBackend.subscribe shape (what server/push.mjs reads): agent_update / agent_permission_request / agent_deleted. */
  subscribe(cb) {
    return this.subscribeEvents((ev) => {
      if (ev.kind === "agent") cb({ type: "agent_update", agentId: ev.agent.id, payload: { agent: ev.agent } });
      else if (ev.kind === "permission") cb({ type: "agent_permission_request", agentId: ev.agentId, request: ev.request });
      else if (ev.kind === "remove") cb({ type: "agent_deleted", agentId: ev.agentId });
    });
  }

  subscribeConnectionStatus(cb) {
    return this.subscribeEvents((ev) => {
      if (ev.kind === "connected") cb({ status: "connected" });
      else if (ev.kind === "disconnected") cb({ status: "disconnected" });
    });
  }

  /** Polls the log-derived status; resolves like DaemonClient.waitForFinish (status idle | timeout | error). */
  async waitForFinish(id, timeoutMs = 0) {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
    for (;;) {
      const { agent } = await this.fetchAgent(id);
      if (agent.status === "idle") return { status: "idle", agent };
      if (agent.status === "closed") return { status: "error", error: "agent exited", agent };
      if (Date.now() >= deadline) return { status: "timeout", agent };
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
