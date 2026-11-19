// idea-347: server-side restart coordination. The Overlord used to hold the drain-ask -> wait-for-drained -> fire-restart
// timer in its own turn; a dead session missed the window (11-18 03:30Z, 18:42Z). `vs restart request <tip>` now records a
// durable request in <VIBESQUAD_HOME>/restart-request.json and this module's server loop drives it:
//
//   requested --(live leads listed, drain asks sent)--> draining
//   draining  --(every asked lead drained or gone, runner holds none of their work)--> ready
//   draining  --(deadline passed: laggards logged)--> ready
//   ready     --(firedAt persisted BEFORE the launch: one fire per request, also across a server restart)--> firing
//   firing    --(restart-<ts>.json ok)--> done (restart-done logged + sent) | (refused / deferred / failed / no result)--> aborted
//
// A drain is a team-log `vs log restart-feedback 'drained restart <tip>'` (a bare 'drained restart' logged after the request
// counts too; another tip does not). The fire runs the existing `vs restart` path as the owner's shell (the same path and
// identity scripts/restart-runtime.mjs uses for its done broadcast); this module never restarts anything itself.
// idea-369: each ask and `vs restart status` carry the runner's held background work (/health heldAgents + heldWork) per lead.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { withFileLock, withFileLockSync } from "./file-lock.mjs";
import { writeFileAtomic } from "./brief-write.mjs";
import { linesFromEndSync } from "./log-tail.mjs";
import { DONE_TEXT, DRAINED_TEXT, DRAIN_LOG_SLACK_MS, doneText, holderLeads } from "./restart-coord.mjs";
import { isLiveAgent, loadTeamsRegistry, resolveAgentIdentity, resolveLeadWinner, whoCandidate } from "./identity.mjs";
import { toAgent } from "./backend/runner-backend.mjs";

export const REQUEST_FILE = "restart-request.json";
export const STATES = Object.freeze(["requested", "draining", "ready", "firing", "done", "aborted"]);
export const TERMINAL = new Set(["done", "aborted"]);
export const DEFAULT_DEADLINE_MIN = 30;
export const MAX_DEADLINE_MIN = 240;
export const TICK_MS = 15_000;
/** A fired request with no restart-<ts>.json after this long is aborted (restart-runtime's own drain wait tops out at 2h). */
export const FIRING_TIMEOUT_MS = 3 * 3600_000;
/** A restart result counts for a request when it started no earlier than this before the fire (clock skew between processes). */
const RESULT_SLACK_MS = 60_000;
const EVENTS_MAX = 40;
const HISTORY_MAX = 10;
export const TIP_RE = /^[A-Za-z0-9][\w./-]{0,63}$/;
const DRAINED_RE = /^restart-feedback:\s*drained restart\b\s*([^\s,;'"]*)/i;

const vsHomeOf = (home) => path.resolve(home || process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"));
export const requestPath = (home) => path.join(vsHomeOf(home), REQUEST_FILE);
const iso = (ms) => new Date(ms).toISOString();
const clean = (t, cap = 80) => String(t ?? "").replace(/[^\w .,:;=/@%+~#()[\]{}<>|&*?!$-]+/g, " ").replace(/\s+/g, " ").trim().slice(-cap);

// ---- the file -------------------------------------------------------------------------------------------------------

function readDoc(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e?.code === "ENOENT") return { version: 1, current: null, history: [] };
    throw e;
  }
  const doc = JSON.parse(raw.replace(/^﻿/, ""));
  if (!doc || typeof doc !== "object") throw new Error(`${file}: not a restart request file`);
  return { version: 1, current: doc.current ?? null, history: Array.isArray(doc.history) ? doc.history : [] };
}

const mutation = (file, fn) => (lock) => {
  const doc = readDoc(file);
  const before = JSON.stringify(doc);
  const out = fn(doc);
  if (JSON.stringify(doc) !== before) {
    lock?.assertOwned?.();
    writeFileAtomic(file, JSON.stringify(doc, null, 2) + "\n");
  }
  return out;
};
function mutateSync(home, fn) {
  const file = requestPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLockSync(file, mutation(file, fn));
}
function mutateAsync(home, fn) {
  const file = requestPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(file, mutation(file, fn));
}

/** The current (open or last finished) request, or null. */
export function readRestartRequest(home) {
  return readDoc(requestPath(home)).current;
}

/**
 * Record a request (the CLI's `vs restart request`; the caller gate is the CLI's). Refuses while another request is open.
 * `requestedBy` is the Overlord's agent id or "owner"; team/lane are where restart-feedback lines are logged.
 */
export function createRestartRequest(home, { tip, requestedBy, team = "", lane = "", needs = "", deadlineMin = DEFAULT_DEADLINE_MIN, now = Date.now() } = {}) {
  const t = String(tip ?? "").trim();
  if (!TIP_RE.test(t)) throw new Error(`vs restart request: <tip> must be a commit or branch name (letters, digits, . _ / -), got ${JSON.stringify(String(tip ?? ""))}`);
  const min = Number(deadlineMin);
  if (!Number.isInteger(min) || min < 1 || min > MAX_DEADLINE_MIN) throw new Error(`vs restart request: --deadline must be whole minutes, 1-${MAX_DEADLINE_MIN}`);
  const need = String(needs ?? "").trim();
  if (need && !/^[\w,.\s-]{1,120}$/.test(need)) throw new Error("vs restart request: --needs takes Live-Needs tokens (e.g. server-restart,runner-restart)");
  return mutateSync(home, (doc) => {
    const cur = doc.current;
    if (cur && !TERMINAL.has(cur.state)) throw new Error(`vs restart request: ${cur.id} (tip ${cur.tip}) is still ${cur.state}; see vs restart status, or vs restart abort first.`);
    if (cur) doc.history = [cur, ...doc.history].slice(0, HISTORY_MAX);
    const at = iso(now);
    doc.current = {
      id: `rr-${at.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(2).toString("hex")}`,
      tip: t,
      requestedBy: String(requestedBy || "owner"),
      team: String(team ?? ""),
      lane: String(lane ?? ""),
      needs: need,
      createdAt: at,
      deadlineMin: min,
      deadline: iso(now + min * 60_000),
      state: "requested",
      asked: {},
      drained: {},
      gone: {},
      held: null,
      events: [{ at, text: `requested by ${requestedBy || "owner"} (deadline ${min} min)` }],
    };
    return doc.current;
  });
}

/** `vs restart abort`: an open request that has not fired yet ends as aborted; the server loop tells the asked leads. */
export function abortRestartRequest(home, { by = "owner", reason = "", now = Date.now() } = {}) {
  return mutateSync(home, (doc) => {
    const cur = doc.current;
    if (!cur || TERMINAL.has(cur.state)) throw new Error("vs restart abort: no open restart request.");
    if (cur.state === "firing") throw new Error(`vs restart abort: ${cur.id} already fired vs restart at ${cur.firedAt}; it cannot be called back.`);
    abort(cur, iso(now), `aborted by ${by}${reason ? `: ${clean(reason, 200)}` : ""}`);
    return cur;
  });
}

// ---- inputs ---------------------------------------------------------------------------------------------------------

/**
 * Every live lead, one per lane the `vs who lead` way (whoCandidate + resolveLeadWinner; a CONFLICT lane lists each
 * contender). Accepts the runner's raw /agents records or toAgent() rows. [{ leadId, team, lane, title }].
 */
export function liveLeads(agents, teams = loadTeamsRegistry()) {
  const list = (Array.isArray(agents) ? agents : []).map((a) => (a && typeof a === "object" && a.meta && !a.labels ? toAgent(a) : a));
  const byLane = new Map();
  for (const a of list) {
    if (!a || !isLiveAgent(a)) continue;
    const who = resolveAgentIdentity(a, { teams, cwd: a.cwd });
    if (who.isOrphan || !who.teamId || !who.laneId) continue;
    if (whoCandidate(a, { teams, wantTeamId: who.teamId, wantLane: who.laneId })?.role !== "lead") continue;
    const key = `${who.teamId}/${who.laneId}`;
    if (!byLane.has(key)) byLane.set(key, { team: who.teamId, lane: who.laneId, cands: [] });
    byLane.get(key).cands.push(a);
  }
  const out = [];
  for (const { team, lane, cands } of byLane.values()) {
    const r = resolveLeadWinner(cands);
    const picked = r.winner ? [r.winner] : r.conflict ? cands.filter((a) => (r.contenders ?? []).includes(a.id)) : [];
    for (const a of picked) out.push({ leadId: a.id, team, lane, title: String(a.title ?? a.name ?? "").split(" · ")[0].trim() || null });
  }
  return out;
}

/** The runner's held list ({ ids, work }) grouped by the holders' live leads (restart-coord holderLeads). */
export function heldByLead(held, agents, teams = loadTeamsRegistry()) {
  if (!held || !Array.isArray(held.ids)) return null;
  const { leads, unresolved } = holderLeads(held.ids, agents, teams);
  const work = held.work && typeof held.work === "object" ? held.work : {};
  const entry = (id) => ({ agentId: id, work: (work[id] ?? []).map((w) => ({ pid: w.pid, cmd: clean(w.cmd ?? w.name) })) });
  return {
    byLead: Object.fromEntries(leads.map((l) => [l.leadId, l.heldAgents.map(entry)])),
    unresolved: unresolved.map((u) => ({ ...entry(u.agentId), reason: u.reason })),
  };
}

/** Tip `token` from a drained line matches the request's tip: equal, or one a >= 7-char prefix of the other (short/long hash). */
export function tipMatches(token, tip) {
  const a = String(token ?? "").toLowerCase();
  const b = String(tip ?? "").toLowerCase();
  if (!a) return true; // a bare 'drained restart' logged after the request
  if (a === b) return true;
  return Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a));
}

/**
 * agent id -> first ts of a 'drained restart [<tip>]' restart-feedback line at or after sinceMs, from every team log. Each
 * log is read from its end and stops at a line stamped before stopMs (append-only; DRAIN_LOG_SLACK_MS covers writers that
 * land out of order), so a loop tick reads only what is new since its last scan.
 */
export function drainedSince(home, { sinceMs, stopMs = sinceMs, tip }) {
  const out = new Map();
  const root = path.join(vsHomeOf(home), "teams");
  let teams = [];
  try { teams = fs.readdirSync(root); } catch { return out; }
  const stop = Math.min(stopMs, sinceMs) - DRAIN_LOG_SLACK_MS;
  for (const team of teams) {
    try {
      for (const line of linesFromEndSync(path.join(root, team, "log.jsonl"))) {
        let e;
        try { e = JSON.parse(line.replace(/^﻿/, "")); } catch { continue; }
        const ts = Date.parse(e?.ts ?? "");
        if (ts < stop) break;
        if (e?.type !== "metric" || !(ts >= sinceMs)) continue;
        const m = DRAINED_RE.exec(String(e.text ?? ""));
        if (!m || !tipMatches(m[1], tip)) continue;
        const id = String(e.agent ?? "").trim();
        if (id && (!out.has(id) || out.get(id) > e.ts)) out.set(id, e.ts);
      }
    } catch { continue; }
  }
  return out;
}

/** restart-<ts>.json records in `home`, newest first (the newest `max`). */
export function restartResults(home, max = 8) {
  const dir = vsHomeOf(home);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => /^restart-.*\.json$/.test(n)).sort().reverse().slice(0, max).map((n) => {
    try { return { file: path.join(dir, n), ...JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) }; } catch { return null; }
  }).filter(Boolean);
}

// ---- the state machine ----------------------------------------------------------------------------------------------

function event(req, at, text) {
  req.events = [...(req.events ?? []), { at, text }].slice(-EVENTS_MAX);
}
function abort(req, at, reason) {
  req.state = "aborted";
  req.abortedAt = at;
  req.abortReason = reason;
  event(req, at, reason);
}
const leadName = (l) => `${l.lane} lead ${l.leadId}${l.title ? ` (${l.title})` : ""}`;
const heldLine = (list) => (list ?? []).map((h) => (h.work?.length ? `${h.agentId} (${h.work.map((w) => `pid ${w.pid}: ${w.cmd}`).join(", ")})` : h.agentId)).join(", ");

/** The drain ask (no double quotes or backticks: it may be pasted into a shell). idea-369: names the lane's held work. */
export function requestAskText(req, lead, held) {
  const left = Math.max(0, Math.round((Date.parse(req.deadline) - Date.parse(req.createdAt)) / 60000));
  return `Restart request ${req.id} (tip ${req.tip}${req.needs ? `, needs ${req.needs}` : ""}) from ${req.requestedBy}: the server restarts the runtime once every live lead has drained, or at ${req.deadline} (~${left} min) regardless. ` +
    `Please drain: let running suites finish or stop what is not needed (vs stop <agent> --background, idle agents only), hold new background suites, then run: vs log restart-feedback '${DRAINED_TEXT} ${req.tip}'. ` +
    (held?.length ? `The runner holds background work in your lane right now: ${heldLine(held)}; it must finish or be stopped before your drain counts. ` : "") +
    `You get '${DONE_TEXT}' after the restart; lift the hold then. Progress: vs restart status.`;
}

/** Asked leads that still block the fire: not drained (and not gone), or drained while the runner still holds their work. */
export function pendingLeads(req) {
  const out = [];
  for (const [leadId, a] of Object.entries(req.asked ?? {})) {
    if (req.gone?.[leadId]) continue; // a lead that died or retired counts as drained
    const held = req.held?.byLead?.[leadId] ?? [];
    if (!req.drained?.[leadId]) out.push({ leadId, ...a, reason: held.length ? `not drained; runner holds ${heldLine(held)}` : "not drained" });
    else if (held.length) out.push({ leadId, ...a, reason: `logged '${DRAINED_TEXT}' but the runner still holds ${heldLine(held)}` });
  }
  return out;
}

/**
 * One step for the open request `req` (mutated in place). Inputs: `leads` (liveLeads(), null = runner unreachable),
 * `drained` (drainedSince() map), `held` (heldByLead(); undefined = not read, null = unknown), `results` (restartResults(),
 * read while firing). Returns the side effects for the driver, which persists `req` BEFORE running any of them:
 * { kind: "ask", leadId, text } | { kind: "log", text } | { kind: "fire" } | { kind: "send", leadId, text }.
 */
export function stepRequest(req, { now = Date.now(), leads = null, drained = null, held = undefined, results = [] } = {}) {
  const actions = [];
  const at = iso(now);
  req.asked ??= {};
  req.drained ??= {};
  req.gone ??= {};
  if (TERMINAL.has(req.state)) return notifyClosed(req, at, actions);
  if (held !== undefined) req.held = held ? { at, ...held } : null;

  if (req.state === "requested" || req.state === "draining") {
    if (leads) {
      for (const l of leads) {
        if (l.leadId === req.requestedBy || req.asked[l.leadId]) continue;
        req.asked[l.leadId] = { team: l.team, lane: l.lane, title: l.title ?? null, askedAt: at };
        actions.push({ kind: "ask", leadId: l.leadId, text: requestAskText(req, l, req.held?.byLead?.[l.leadId]) });
      }
      const live = new Set(leads.map((l) => l.leadId));
      for (const id of Object.keys(req.asked)) {
        if (!live.has(id) && !req.gone[id]) { req.gone[id] = at; event(req, at, `${leadName({ leadId: id, ...req.asked[id] })} is gone: counts as drained`); }
      }
      if (req.state === "requested") {
        req.state = "draining";
        req.drainingAt = at;
        event(req, at, `drain asks to ${Object.keys(req.asked).length} live lead(s)`);
      } else if (actions.length) event(req, at, `drain asks to ${actions.length} new lead(s)`);
    }
    for (const [id, ts] of drained ?? []) {
      if (!req.asked[id] || req.drained[id]) continue; // duplicates and non-asked agents change nothing
      req.drained[id] = ts;
      event(req, at, `${leadName({ leadId: id, ...req.asked[id] })} drained`);
    }
    const past = now >= Date.parse(req.deadline);
    if (req.state === "requested") {
      if (!past) return actions;
      abort(req, at, "deadline passed before the runner listed any lead: no drain asks went out, nothing fired");
      return notifyClosed(req, at, actions);
    }
    const pend = pendingLeads(req);
    if (!pend.length) {
      req.state = "ready";
      req.readyAt = at;
      req.readyReason = "all-drained";
      const n = Object.keys(req.asked).length;
      event(req, at, `ready: all ${n} asked lead(s) drained or gone`);
      actions.push({ kind: "log", text: `restart-request ${req.id} ready: all ${n} asked lead(s) drained or gone; firing vs restart for ${req.tip}` });
    } else if (past) {
      req.state = "ready";
      req.readyAt = at;
      req.readyReason = "deadline";
      req.laggards = pend.map(({ leadId, team, lane, title, reason }) => ({ leadId, team, lane, title, reason }));
      const who = req.laggards.map((l) => `${leadName(l)} [${l.reason}]`).join("; ");
      event(req, at, `deadline passed; not drained: ${who}`);
      actions.push({ kind: "log", text: `restart-request ${req.id} deadline passed; firing vs restart for ${req.tip} anyway (restart-runtime still waits for idle and defers rather than kill); not drained: ${who}` });
    }
  }

  if (req.state === "ready") {
    req.state = "firing";
    req.firedAt = at;
    event(req, at, "firing vs restart");
    actions.push({ kind: "fire" });
    return actions;
  }

  if (req.state === "firing") {
    if (req.launch && req.launch.ok === false) {
      abort(req, at, `vs restart did not launch: ${req.launch.error}`);
    } else {
      const fired = Date.parse(req.firedAt ?? "") || now;
      const r = (results ?? []).find((x) => x && !x.dryRun && (Date.parse(x.startedAt ?? "") || 0) >= fired - RESULT_SLACK_MS);
      if (r?.ok) {
        req.state = "done";
        req.doneAt = at;
        req.result = { file: r.file ?? null, ok: true, finishedAt: r.finishedAt ?? null };
        event(req, at, `restart done (${r.file ? path.basename(r.file) : "result"})`);
      } else if (r) {
        req.result = { file: r.file ?? null, ok: false, finishedAt: r.finishedAt ?? null };
        abort(req, at, `the restart ${r.deferred ? "deferred on background work" : "failed"}: ${clean(r.errors?.[0] ?? "no error recorded", 300)}`);
      } else if (now - fired > FIRING_TIMEOUT_MS) {
        abort(req, at, `no restart result within ${FIRING_TIMEOUT_MS / 3600_000}h of the fire`);
      }
    }
    if (TERMINAL.has(req.state)) return notifyClosed(req, at, actions);
  }
  return actions;
}

/** Once per finished request: log the outcome and tell every asked lead still live to lift its hold. */
function notifyClosed(req, at, actions) {
  if (req.notifiedAt) return actions;
  req.notifiedAt = at;
  const done = req.state === "done";
  actions.push({ kind: "log", text: done ? `${DONE_TEXT} ${req.tip} (restart-request ${req.id})` : `restart-request ${req.id} aborted: ${req.abortReason}` });
  const text = done ? `${doneText(at)} (restart-request ${req.id}, tip ${req.tip})`
    : `Restart request ${req.id} (tip ${req.tip}) was aborted: ${req.abortReason}. No restart is pending from it; lift your background-suite hold.`;
  for (const id of Object.keys(req.asked ?? {})) if (!req.gone?.[id]) actions.push({ kind: "send", leadId: id, text });
  return actions;
}

// ---- status ---------------------------------------------------------------------------------------------------------

export function formatRequestStatus(req, now = Date.now()) {
  if (!req) return "no restart request (vs restart request <tip> [--deadline <min>])";
  const mins = (t) => Math.round((Date.parse(t) - now) / 60000);
  const lines = [`restart request ${req.id}: ${req.state} (tip ${req.tip}${req.needs ? `, needs ${req.needs}` : ""}, by ${req.requestedBy}, created ${req.createdAt}, deadline ${req.deadline}${TERMINAL.has(req.state) ? "" : ` (${mins(req.deadline) >= 0 ? `in ${mins(req.deadline)} min` : `${-mins(req.deadline)} min ago`})`})`];
  const asked = Object.entries(req.asked ?? {});
  const settled = asked.filter(([id]) => req.drained?.[id] || req.gone?.[id]).length;
  if (asked.length) lines.push(`  leads: ${settled}/${asked.length} drained or gone`);
  for (const [id, a] of asked) {
    const held = req.held?.byLead?.[id] ?? [];
    const st = req.gone?.[id] ? `gone ${req.gone[id]} (counts as drained)` : req.drained?.[id] ? `drained ${req.drained[id]}` : "NOT drained";
    lines.push(`  - ${leadName({ leadId: id, ...a })}: ${st}${a.error ? `; ask failed: ${a.error}` : ""}${held.length ? `; runner holds ${heldLine(held)}` : ""}`);
  }
  if (req.held?.unresolved?.length) lines.push(`  held with no lead resolved: ${req.held.unresolved.map((u) => `${heldLine([u])} (${u.reason})`).join("; ")}`);
  if (req.held === null && !TERMINAL.has(req.state)) lines.push("  runner held list: unknown (runner unreachable or older)");
  if (req.laggards?.length) lines.push(`  fired at the deadline without: ${req.laggards.map((l) => `${leadName(l)} [${l.reason}]`).join("; ")}`);
  if (req.firedAt) lines.push(`  fired ${req.firedAt}${req.launch ? (req.launch.ok ? " (vs restart launched)" : ` (launch failed: ${req.launch.error})`) : ""}`);
  if (req.result?.file) lines.push(`  result: ${req.result.file}`);
  if (req.abortReason) lines.push(`  aborted: ${req.abortReason}`);
  for (const e of (req.events ?? []).slice(-6)) lines.push(`  ${e.at}  ${e.text}`);
  return lines.join("\n");
}

// ---- the driver -----------------------------------------------------------------------------------------------------

const VS_CLI = path.resolve(import.meta.dirname, "..", "cli", "vs.mjs");
const AGENT_ENV_KEYS = ["VS_AGENT_ID", "PASEO_AGENT_ID", "VS_AGENT_TOKEN", "VS_ROLE", "VS_LANE", "VS_TEAM", "VS_ORD", "VS_PROFILE"];

/** One `vs` call as the owner's shell (agent identity stripped, as restart-runtime's runVs), async: the server loop never blocks. */
export function runVsAsync(args, { env = process.env, timeoutMs = 60_000 } = {}) {
  const e = { ...env };
  for (const k of AGENT_ENV_KEYS) delete e[k];
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(process.execPath, [VS_CLI, ...args], { env: e, cwd: path.dirname(path.dirname(VS_CLI)), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) { resolve({ ok: false, error: String(err?.message ?? err).slice(0, 300) }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { out += b; });
    child.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, error: String(err?.message ?? err).slice(0, 300) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out.trim().slice(-300);
      resolve(code === 0 ? { ok: true, out: text } : { ok: false, error: text || `exit ${code}` });
    });
  });
}

/**
 * The server loop. Deps (all injectable for tests): listAgents() -> runner agents, heldList() -> { ids, work } | null,
 * runVs(args) -> { ok, error? } (logs, sends), fire() -> { ok, error? } (the existing `vs restart` path), teams() -> registry.
 * tick() reads the inputs outside the lock, steps under it, persists, then runs the effects; it never overlaps itself.
 */
export function createRestartRequestLoop({
  home,
  listAgents,
  heldList = async () => null,
  runVs = (args) => runVsAsync(args),
  fire = () => runVsAsync(["restart"], { timeoutMs: 120_000 }),
  teams = () => loadTeamsRegistry(),
  now = () => Date.now(),
  tickMs = TICK_MS,
  log = () => {},
} = {}) {
  let busy = null;
  let scanned = null; // { id, at }: the last drained-log scan for this request (in memory: a restarted server rescans once)
  let timer = null;

  const logArgs = (req, text) => ["log", "restart-feedback", text, ...(req.team && req.lane ? ["--team", req.team, "--lane", req.lane] : [])];

  async function run() {
    const cur = readRestartRequest(home);
    if (!cur || (TERMINAL.has(cur.state) && cur.notifiedAt)) return { state: cur?.state ?? null, actions: [] };
    const open = !TERMINAL.has(cur.state) && cur.state !== "firing";
    let leads = null;
    let held;
    let drained = null;
    let results = [];
    const scanAt = now();
    if (open) {
      let agents = null;
      try { agents = await listAgents(); } catch (e) { log(`restart-request: agent list failed: ${e?.message ?? e}`); }
      if (Array.isArray(agents)) {
        const reg = teams();
        leads = liveLeads(agents, reg);
        let h = null;
        try { h = await heldList(); } catch { h = null; }
        held = h ? heldByLead(h, agents, reg) : null;
      }
      const sinceMs = Date.parse(cur.createdAt);
      drained = drainedSince(home, { sinceMs, stopMs: scanned?.id === cur.id ? scanned.at : sinceMs, tip: cur.tip });
    } else if (cur.state === "firing") results = restartResults(home);
    const { req, actions } = await mutateAsync(home, (doc) => {
      if (!doc.current || doc.current.id !== cur.id) return { req: doc.current, actions: [] };
      return { req: doc.current, actions: stepRequest(doc.current, { now: now(), leads, drained, held, results }) };
    });
    if (open) scanned = { id: cur.id, at: scanAt };
    // Effects, after the state that caused them is on disk (an ask is never re-sent, a fire never repeated).
    const outcomes = {};
    for (const a of actions) {
      if (a.kind === "fire") {
        let r;
        try { r = await fire(req); } catch (e) { r = { ok: false, error: String(e?.message ?? e) }; }
        await mutateAsync(home, (doc) => {
          if (doc.current?.id === req.id) doc.current.launch = { ok: Boolean(r?.ok), at: iso(now()), ...(r?.ok ? { out: clean(r.out, 300) } : { error: clean(r?.error ?? "unknown", 300) }) };
        });
        log(`restart-request ${req.id}: vs restart ${r?.ok ? "launched" : `failed: ${r?.error}`}`);
        continue;
      }
      const r = await runVs(a.kind === "log" ? logArgs(req, a.text) : ["send", a.leadId, a.text]).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (a.kind === "ask") outcomes[a.leadId] = r;
      if (!r?.ok) log(`restart-request ${req.id}: ${a.kind}${a.leadId ? ` ${a.leadId}` : ""} failed: ${r?.error}`);
    }
    if (Object.keys(outcomes).length) {
      await mutateAsync(home, (doc) => {
        if (doc.current?.id !== req.id) return;
        for (const [id, r] of Object.entries(outcomes)) {
          const a = doc.current.asked?.[id];
          if (!a) continue;
          if (r?.ok) a.sentAt = iso(now());
          else a.error = clean(r?.error ?? "unknown", 200);
        }
      });
    }
    return { state: req?.state ?? null, actions };
  }

  const loop = {
    /** One step; concurrent calls share the running one. */
    tick() {
      if (!busy) busy = run().finally(() => { busy = null; });
      return busy;
    },
    start() {
      if (timer) return;
      timer = setInterval(() => void loop.tick().catch((e) => log(`restart-request tick failed: ${e?.message ?? e}`)), tickMs);
      timer.unref?.();
      void loop.tick().catch(() => {});
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return loop;
}

/** The production loop on the real home: the shared runner backend's agent list and /health held list. */
export async function startRestartRequestLoop({ home, log = (l) => console.warn(l) } = {}) {
  const { sharedRunnerBackend } = await import("./backend/index.mjs");
  const backend = sharedRunnerBackend();
  const loop = createRestartRequestLoop({
    home,
    log,
    listAgents: () => backend.listAgents(),
    heldList: async () => {
      const h = await backend.rc.request("GET", "/health", undefined, { restartWait: false });
      return Array.isArray(h?.heldAgents) ? { ids: h.heldAgents, work: h.heldWork && typeof h.heldWork === "object" ? h.heldWork : {} } : null;
    },
  });
  loop.start();
  return loop;
}
