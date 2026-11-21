// /__vibesquad/runner/* : the UI's window onto the agent runner (the browser reaches agents only through these routes).
// Writes are gated by the caller (vibesquad-api.mjs: owner, or an allow-listed verified agent forwarded to the runner's scope rules).
import { sharedRunnerBackend } from "./backend/index.mjs";
import { callerOf } from "./auth.mjs";
import { pickBugIntakeAgent } from "./inbox.mjs";
import { redactHostPathTokens } from "./redact-host-paths.mjs";
import { defangPromptFences } from "./write-guards.mjs";

const PREFIX = "/__vibesquad/runner/";
const ID_RE = /^rn-[A-Za-z0-9_-]{1,64}$/;

const HEARTBEAT_MS = 15000;

/**
 * GET /__vibesquad/runner/events: SSE of roster upserts, timeline appends and status transitions (RunnerBackend.subscribeEvents).
 * The backend starts it with the full roster; the listener, heartbeat and runner stream are released when the client goes away.
 */
function streamEvents(req, res, backend, heartbeatMs = HEARTBEAT_MS, filter = null) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write(": ok\n\n");
  const write = (ev) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  // E6a: a filter maps one backend event to the events this client may see (0..n); without one every event goes out as is.
  const send = filter ? (ev) => { for (const out of filter(ev)) write(out); } : write;
  let off = null;
  let closed = false;
  const beat = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': hb\n\ndata: {"kind":"hb"}\n\n'); }, heartbeatMs); // comment for proxies; data event so the browser watchdog sees activity
  beat.unref?.();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(beat);
    off?.();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  // The backend delivers the initial roster itself, in order with live events. A runner that is down yields
  // { kind: "disconnected" } (never an empty roster), so the browser keeps the agents it has.
  off = backend.subscribeEvents(send);
  if (closed) off();
}

/** What the browser reads on boot: the runner is always on (every lane runs on it). */
export async function runnerStatus() {
  return { enabled: true };
}

/**
 * `caller` (X1c): the middleware's resolved caller. The middleware admits only the owner and allow-listed agent routes here.
 * An agent caller is forwarded to the runner as that agent ({ id, token }), so the runner's scope rules decide (team, parent,
 * role, protected meta); `owner: true` on input is only ever set for the owner. The body can never name the caller.
 */
export async function handleRunnerApi(req, res, { readBody, sendJson, backend = sharedRunnerBackend(), status = runnerStatus, caller = callerOf(req), testerTeams = null }) {
  // E6a: a bug-tester device never reaches the owner/agent code below (deny-by-default, its own scoped handler).
  if (caller?.kind === "tester") return handleTesterRunnerApi(req, res, { readBody, sendJson, backend, caller, testerTeams });
  const agent = caller?.kind === "agent" ? { id: caller.id, token: caller.token } : null;
  const as = agent ? { caller: agent } : {};
  try {
    const parts = (req.url ?? "").split("?")[0].slice(PREFIX.length).split("/").filter(Boolean);
    const url = new URL(req.url, "http://x");
    if (parts[0] === "status") return sendJson(res, 200, await status());
    if (parts[0] === "events" && parts.length === 1 && req.method === "GET") {
      // Connect-only: the VS server's supervisor owns the runner; the stream retries until it is up.
      return streamEvents(req, res, backend);
    }
    if (parts[0] === "agents" && parts.length === 1 && req.method === "GET") {
      if (url.searchParams.get("archived") === "1") {
        const all = await backend.listAgents({ filter: { includeArchived: true } }).catch(() => []);
        return sendJson(res, 200, { enabled: true, agents: all.filter((a) => a.archivedAt) });
      }
      const agents = await backend.listAgents().catch(() => []); // runner not started yet = no agents
      return sendJson(res, 200, { enabled: true, agents });
    }
    if (parts[0] === "sweep" && parts.length === 1 && req.method === "POST") {
      // B3: the 5-min long-done worker sweep, run once over every Squad. Dry run unless the body says apply:true.
      const body = await readBody(req);
      const host = await backend.hookHost();
      if (!host?.sweepDoneWorkersReport) return sendJson(res, 503, { error: "hooks are not running on this server" });
      return sendJson(res, 200, await host.sweepDoneWorkersReport({ apply: body?.apply === true }));
    }
    if (parts[0] === "spawn" && req.method === "POST") {
      const { caller: _claimed, ...body } = (await readBody(req)) ?? {};
      return sendJson(res, 201, { agent: await backend.createAgent({ ...body, ...as }) });
    }
    if (parts[0] === "agents" && ID_RE.test(parts[1] ?? "")) {
      const id = parts[1];
      const action = parts[2];
      if (req.method === "GET" && action === "timeline") {
        const limit = Number(url.searchParams.get("limit") ?? 0) || undefined;
        const before = url.searchParams.get("direction") === "before" ? Number(url.searchParams.get("cursor")) : NaN;
        const opts = Number.isFinite(before) ? { limit, direction: "before", cursor: { epoch: "runner", seq: before } } : { limit };
        return sendJson(res, 200, await backend.fetchAgentTimeline(id, opts));
      }
      if (req.method === "GET" && !action) return sendJson(res, 200, await backend.fetchAgent(id));
      if (req.method === "POST") {
        const body = await readBody(req);
        if (action === "input") {
          // steerOnly (idea-169/214): join the agent's open turn or drop; never starts, resumes or revives a turn. The runner's
          // answer ({ delivered, reason? }) goes back to the caller so it learns whether the steer was dropped.
          const steerOnly = body?.steerOnly === true;
          const r = await backend.sendAgentPrompt(id, String(body?.text ?? ""), {
            images: Array.isArray(body?.images) ? body.images : undefined,
            activeTurnBehavior: !steerOnly && body?.activeTurnBehavior === "interrupt" ? "interrupt" : undefined,
            // Only the owner's composer is a human send; an agent's send is forwarded as that agent (the runner sets
            // senderId from the verified caller, ignores a body `owner`, and downgrades an interrupt it may not cancel).
            owner: !agent,
            ...(steerOnly ? { steerOnly: true } : {}),
            ...as,
          });
          if (steerOnly) return sendJson(res, 200, { ok: true, delivered: r?.delivered === true, ...(r?.reason ? { reason: r.reason } : {}) });
        }
        else if (action === "cancel") await backend.cancelAgent(id, as);
        else if (action === "archive") await backend.archiveAgent(id, as);
        else if (action === "unarchive") await backend.unarchiveAgent(id, as);
        else if (action === "resume") {
          // Reopens a lost/parked agent in place (same id and history); status stays "closed" when it is not resumable.
          return sendJson(res, 200, { ok: true, agent: await backend.refreshAgent(id, as) });
        }
        else if (action === "meta") await backend.updateAgent(id, body, as);
        else if (action === "config") {
          if (agent) return sendJson(res, 403, { error: "config is owner-only" }); // not on AGENT_WRITE_ALLOWLIST; belt and braces
          return sendJson(res, 200, { ok: true, ...(await backend.setAgentConfig(id, body ?? {})) }); // model / mode / thinking: applies from the next turn
        }
        else return sendJson(res, 404, { error: "not found" });
        return sendJson(res, 200, { ok: true });
      }
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    return sendJson(res, err?.status && err.status >= 400 ? err.status : 500, { error: String(err?.message ?? err) });
  }
}

// ---- E6a: the bug-tester's window onto the runner (docs/PLAN_E6_TESTER_ROLES.md) ----
// A bug-tester device sees exactly the bug-intake agent (pickBugIntakeAgent: the bug lane's front-door Buddy, else its Lead)
// of each Squad on its allowedTeams, as a stripped record; reads only messages; writes only plain, non-owner input to that
// agent. Every other runner route is 403. Deny-by-default: a route is answered only when it matches a case below exactly.

export const TESTER_MESSAGE_TYPES = Object.freeze(["user_message", "assistant_message"]);
const TESTER_INPUT_MAX_CHARS = 8000;
const TESTER_TIMELINE_MAX = 200;
const testerForbidden = (why = "forbidden: bug-tester device cannot access this route") => Object.assign(new Error(why), { status: 403 });

/**
 * The chat prefix every tester message carries (server-stamped; a body can never drop or change it): `[Alpha Tester · <name>] `,
 * or `[Alpha Tester · <name> · card:<cardId>] ` for a line about one of the caller's cards (the handler checks ownership).
 * Brackets, line breaks and "·" are blanked out of the name so a device name can never forge a card tag or close the stamp.
 */
export const testerChatPrefix = (name, cardId = null) => {
  const n = String(name ?? "").replace(/[\r\n[\]·]/g, " ").replace(/\s+/g, " ").trim() || "tester";
  const card = typeof cardId === "string" && /^idea-\d{1,12}$/.test(cardId) ? ` · card:${cardId}` : "";
  return `[Alpha Tester · ${n}${card}] `;
};

/** `text` with the caller's prefix in front (once). */
export function stampTesterText(caller, text, { cardId = null } = {}) {
  const prefix = testerChatPrefix(caller?.name, cardId);
  const t = String(text ?? "").trim();
  return t.startsWith(prefix) ? t : `${prefix}${t}`;
}

/** The team records a tester may reach: `testerTeams` (array or () => array), filtered again to caller.allowedTeams. */
export function testerTeamRecords(caller, testerTeams) {
  let list = typeof testerTeams === "function" ? testerTeams() : testerTeams;
  if (!Array.isArray(list)) list = [];
  const allowed = new Set((caller?.allowedTeams ?? []).map((t) => String(t).trim().toLowerCase()));
  return list.filter((t) => t && allowed.has(String(t.id ?? "").trim().toLowerCase()));
}

/** id -> agent record of the allowed bug-intake agent(s) among `agents`, one per allowed Squad at most. */
export function testerIntakeAgents(agents, teams) {
  const out = new Map();
  const list = Array.isArray(agents) ? agents.map((a) => a?.agent ?? a).filter(Boolean) : [];
  for (const team of teams) {
    const a = pickBugIntakeAgent(list, team);
    if (a?.id && !a.archivedAt) out.set(a.id, a);
  }
  return out;
}

const redactText = (t) => redactHostPathTokens(String(t ?? ""));

/** The only agent fields a tester sees: id, title, status, team/lane/role labels, timestamps. No cwd, prompt, provider, paths. */
export function testerAgentView(a) {
  if (!a || typeof a !== "object") return null;
  const labels = {};
  for (const k of ["team", "lane", "role"]) if (typeof a.labels?.[k] === "string") labels[k] = a.labels[k];
  return {
    id: String(a.id ?? ""),
    title: redactText(a.title ?? ""),
    status: typeof a.status === "string" ? a.status : "unknown",
    labels,
    ...(typeof a.createdAt === "string" ? { createdAt: a.createdAt } : {}),
    ...(typeof a.updatedAt === "string" ? { updatedAt: a.updatedAt } : {}),
  };
}

/** Timeline entries a tester may read: user/assistant messages only, text redacted, no images or other item fields. */
export function testerTimelineEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => TESTER_MESSAGE_TYPES.includes(e?.item?.type))
    .map((e) => ({
      ...(typeof e.timestamp === "string" ? { timestamp: e.timestamp } : {}),
      ...(Number.isFinite(e.seqStart) ? { seqStart: e.seqStart } : {}),
      ...(Number.isFinite(e.seqEnd) ? { seqEnd: e.seqEnd } : {}),
      item: { type: e.item.type, text: redactText(e.item.text) },
    }));
}

/** A tester-safe window of `id`'s timeline: `{ entries, hasOlder, lastSeq?, startCursor }`, messages only. */
export async function fetchTesterTimeline(backend, id, { limit, before } = {}) {
  const n = Math.min(Math.max(Number(limit) || 0, 0), TESTER_TIMELINE_MAX) || TESTER_TIMELINE_MAX;
  const opts = Number.isFinite(before) ? { limit: n, direction: "before", cursor: { epoch: "runner", seq: before } } : { limit: n };
  const t = (await backend.fetchAgentTimeline(id, opts)) ?? {};
  return {
    entries: testerTimelineEntries(t.entries),
    hasOlder: t.hasOlder === true,
    ...(Number.isFinite(t.lastSeq) ? { lastSeq: t.lastSeq } : {}),
    startCursor: t.startCursor && Number.isFinite(t.startCursor.seq) ? { epoch: "runner", seq: t.startCursor.seq } : null,
  };
}

/** C0 controls and DEL out; \t and \n stay (a tester's line may be multi-line); \r goes too, so \r\n collapses to \n. */
const stripTesterControl = (s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
/** A tester's chat text, sanitized: control chars stripped, prompt fences defanged, ``` runs broken (no fake code blocks). */
export function sanitizeTesterInput(text) {
  const t = stripTesterControl(text).trim();
  return defangPromptFences(t).replace(/`{3,}/g, (m) => "ʼ".repeat(m.length));
}

/** Send a tester's chat line to an allowed agent: prefixed, never owner, never interrupt / steer-only, no images. */
export async function sendTesterInput(backend, caller, id, text, { cardId = null } = {}) {
  if (typeof text !== "string") throw Object.assign(new Error("text must be a string"), { status: 400 });
  const t = sanitizeTesterInput(text);
  if (!t) throw Object.assign(new Error("text is required"), { status: 400 });
  if (t.length > TESTER_INPUT_MAX_CHARS) throw Object.assign(new Error(`text too long (${TESTER_INPUT_MAX_CHARS} chars max)`), { status: 413 });
  await backend.sendAgentPrompt(id, stampTesterText(caller, t, { cardId }), { owner: false });
}

const TESTER_PASS_EVENTS = new Set(["connected", "disconnected", "hb"]);
const TESTER_TIMELINE_TYPES = new Set(["input", "output"]); // runner event types that become user/assistant messages

/**
 * The SSE filter for a tester: keeps its own id -> agent map from roster/agent/remove, re-derives the allowed bug-intake
 * set after each, and emits a fresh filtered roster whenever that set changes. Forwards connected/disconnected/hb, and
 * agent/remove/created/status/timeline only for an allowed id; drops permission, tools and any kind it does not know.
 */
export function createTesterEventFilter(teamsOf) {
  const all = new Map();
  let allowed = new Map();
  let key = null;
  const recompute = () => {
    allowed = testerIntakeAgents([...all.values()], teamsOf());
    const k = [...allowed.keys()].sort().join(",");
    const changed = k !== key;
    key = k;
    return changed;
  };
  const roster = () => ({ kind: "roster", agents: [...allowed.values()].map(testerAgentView) });
  return (ev) => {
    const kind = ev?.kind;
    if (TESTER_PASS_EVENTS.has(kind)) return [{ kind }];
    if (kind === "roster") {
      all.clear();
      for (const a of Array.isArray(ev.agents) ? ev.agents : []) if (a?.id) all.set(a.id, a);
      recompute();
      return [roster()];
    }
    if (kind === "agent") {
      const a = ev.agent;
      if (!a?.id) return [];
      all.set(a.id, a);
      if (recompute()) return [roster()];
      return allowed.has(a.id) ? [{ kind: "agent", agent: testerAgentView(a) }] : [];
    }
    if (kind === "remove") {
      const id = ev.agentId;
      const was = allowed.has(id);
      all.delete(id);
      const changed = recompute();
      const out = was ? [{ kind: "remove", agentId: id }] : [];
      return changed ? [...out, roster()] : out;
    }
    if (kind === "created" || kind === "status") {
      if (!allowed.has(ev.agentId)) return [];
      const agent = testerAgentView(allowed.get(ev.agentId));
      return [kind === "status" ? { kind, agentId: ev.agentId, from: ev.from, to: ev.to, agent } : { kind, agentId: ev.agentId, agent }];
    }
    if (kind === "timeline") {
      if (!allowed.has(ev.agentId) || !TESTER_TIMELINE_TYPES.has(ev.type)) return [];
      return [{ kind, agentId: ev.agentId, ...(Number.isFinite(ev.seq) ? { seq: ev.seq } : {}), type: ev.type }];
    }
    return [];
  };
}

/** E6a: handleRunnerApi for a bug-tester caller (see the block comment above). Never reaches the owner/agent branches. */
async function handleTesterRunnerApi(req, res, { readBody, sendJson, backend, caller, testerTeams }) {
  try {
    const path = (req.url ?? "").split("?")[0];
    if (!path.startsWith(PREFIX)) throw testerForbidden();
    const parts = path.slice(PREFIX.length).split("/"); // exact shape: an empty segment never matches below
    const url = new URL(req.url, "http://x");
    const teamsOf = () => testerTeamRecords(caller, testerTeams);
    const allowedNow = async () => testerIntakeAgents(await backend.listAgents().catch(() => []), teamsOf());
    if (req.method === "GET" && parts.length === 1 && parts[0] === "status") return sendJson(res, 200, { enabled: true });
    if (req.method === "GET" && parts.length === 1 && parts[0] === "events") return streamEvents(req, res, backend, HEARTBEAT_MS, createTesterEventFilter(teamsOf));
    if (req.method === "GET" && parts.length === 1 && parts[0] === "agents") {
      if (url.searchParams.has("archived")) throw testerForbidden("forbidden: bug-tester device cannot list archived agents");
      return sendJson(res, 200, { enabled: true, agents: [...(await allowedNow()).values()].map(testerAgentView) });
    }
    if (parts[0] === "agents" && ID_RE.test(parts[1] ?? "") && parts.length <= 3) {
      const id = parts[1];
      const action = parts[2];
      const isRead = req.method === "GET" && (parts.length === 2 || action === "timeline");
      const isInput = req.method === "POST" && action === "input";
      if (!isRead && !isInput) throw testerForbidden();
      const allowed = await allowedNow();
      if (!allowed.has(id)) throw testerForbidden("forbidden: not a bug-intake agent of your Squads");
      if (parts.length === 2) return sendJson(res, 200, { agent: testerAgentView(allowed.get(id)) });
      if (action === "timeline") {
        const before = url.searchParams.get("direction") === "before" ? Number(url.searchParams.get("cursor")) : NaN;
        return sendJson(res, 200, await fetchTesterTimeline(backend, id, { limit: url.searchParams.get("limit"), before }));
      }
      const body = (await readBody(req)) ?? {};
      await sendTesterInput(backend, caller, id, body?.text); // only `text` is read: owner / interrupt / steerOnly / images never pass
      return sendJson(res, 200, { ok: true });
    }
    throw testerForbidden();
  } catch (err) {
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status === 500) console.warn(`[vibesquad] tester runner request failed: ${err?.message ?? err}`);
    return sendJson(res, status, { error: status === 500 ? "runner request failed; see the server log" : redactText(err?.message ?? err) });
  }
}
