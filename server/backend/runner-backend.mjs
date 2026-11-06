// RunnerBackend: the AgentBackend seam over the VS agent runner's HTTP API (docs/PLAN_OWN_DAEMON.md Block 3).
// squad/team/lane/role/ord/profile are first-class fields on the runner record; this class maps them (and the
// runner's event log) back into the shapes callers already read from PaseoBackend/DaemonClient.
import fs from "node:fs";
import path from "node:path";
import { RunnerClient, runnerHome } from "./runner-client.mjs";
import { joinTarget, joinInto, canExtendThought } from "../reply-coalesce.mjs";

const FIRST_CLASS = ["squad", "team", "lane", "role", "ord", "profile"];
const ENV_FOR = { lane: "VS_LANE", team: "VS_TEAM", role: "VS_ROLE", profile: "VS_PROFILE" };
const CLAUDE_PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"]);
const STATUS = { starting: "initializing", running: "running", idle: "idle", exited: "closed", lost: "closed", unknown: "idle" };

export const isRunnerId = (id) => typeof id === "string" && id.startsWith("rn-");

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

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
    requiresAttention: false,
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
  }
  if (!created) return null;
  return toAgent({
    id, provider: created.provider, model: created.model, cwd: created.cwd, meta,
    status: exited ? "exited" : status, createdAt: created.ts, updatedAt: last?.ts, archivedAt,
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
        entries.push({ ...base, item: { type: "user_message", text: e.text } });
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

export class RunnerBackend {
  constructor({ client = new RunnerClient(), buildPrefix = injectedPrefix } = {}) {
    Object.defineProperty(this, "rc", { value: client });
    Object.defineProperty(this, "buildPrefix", { value: buildPrefix });
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
    return (await this.fetchAgent(id)).agent;
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

  async sendAgentPrompt(id, text) {
    await this.rc.request("POST", `/agents/${encodeURIComponent(id)}/input`, { text });
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
    await this.rc.request("POST", `/agents/${encodeURIComponent(id)}/archive`, {});
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
  }

  async refreshAgent(id) {
    return (await this.fetchAgent(id)).agent;
  }

  async detachAgent() {}
  async deleteHeartbeat() {}
  subscribe() {
    return () => {};
  }
  subscribeConnectionStatus() {
    return () => {};
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
