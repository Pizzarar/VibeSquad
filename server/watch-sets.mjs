// Watch sets (docs/PLAN_COMPLETION_DIGEST_RELAY.md, block W1): a lead registers what it waits on (agents, its suite run, a
// restart) and ends its turn. This deterministic watcher (0 tokens) pings the owner ONCE when the whole set is finished, plus
// once per item that stalls (the set stays armed for the rest). A lead stops polling with `vs wait` loops and heartbeats.
//
// Registry: <home>/watches.json `{version, sets:[{id, owner, team, lane, createdAt, stallMin, items:[{kind, ref, state, since,
// report?}], firedAt?, cancelledAt?, pings:[]}]}`. Every write is a locked read-modify-write (the `vs watch` verb writes from
// another process) and atomic; the server reloads it on start and on every change.
// Inputs: runner events (onRunnerEvent, from RunnerBackend.subscribeEvents), team-log `done` / `blocker` entries (onLogEntry,
// from the plugin's scanLogs), the suite result + lock files in tmpdir, `restart-<ts>.json` records, and the stall clock (tick).
// Output: pings handed to `deliver`; the plugin routes them through its wake path (pendingWake -> flushWake -> send).
//
// Ping lifecycle, persisted per ping: fired (`at`, written BEFORE any send, so a set never fires twice, also across a restart) ->
// attemptedAt (written right before the send; never re-sent after that) -> deliveredAt | error. A ping fired but never attempted
// (server restarted while it waited for a busy owner) is redelivered after the reload: the same ping, not a second fire.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pidAlive } from "../runner/lock.mjs";
import { withFileLockSync } from "./file-lock.mjs";
import { writeFileAtomic } from "./brief-write.mjs";
import { isDigestAgent, isRetiredRole } from "./identity.mjs";

export const WATCH_KINDS = Object.freeze(["agent", "suite", "restart"]);
export const DEFAULT_STALL_MIN = 15;
export const SUITE_RESULT_FILE = "vibesquad-npm-test-last.json";
export const SUITE_LOCK_FILE = "vibesquad-npm-test.lock";
/** Fired / cancelled sets whose pings are all attempted are dropped from the file after this long. */
export const PRUNE_AFTER_MS = 7 * 24 * 60 * 60_000;
const REPORT_CAP = 400; // per item in a ping; W4 merges long texts
const REPORTS_PER_AGENT = 20;
const SNAP_REFRESH_MS = 60_000; // re-read a watched agent this often, so a missed runner event cannot hang the set
const BACKFILL_TAIL_BYTES = 4 * 1024 * 1024;
/** A suite item with one of these refs (or none) matches any run; any other ref must equal the run's agentId. */
const ANY_SUITE = new Set(["", "*", "any", "suite", "npm-test"]);
/** Same shape as agent-duties' VERDICT_RE: "PASS: …", "FAIL: …", "UNVERIFIED (digest failed): FAIL …". */
const VERDICT_RE = /^\s*(?:UNVERIFIED\b.*?:\s*)?(?:PASS|FAIL)\b/;
const MANAGER_ROLES = new Set(["lead", "brainstorm", "buddy", "overlord"]);

const vsHome = (home) => path.resolve(home || process.env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"));
export const watchesPath = ({ home } = {}) => path.join(vsHome(home), "watches.json");

const iso = (ms) => new Date(ms).toISOString();
const timeOf = (v) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN);
const oneLine = (s, cap = REPORT_CAP) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
};
const isOpen = (set) => !set.firedAt && !set.cancelledAt;
const pingKeyOf = (set, ping) => `${set.id}#${ping.key}`;
const refsOf = (entry) =>
  [...new Set([entry?.agent, ...(Array.isArray(entry?.refs) ? entry.refs : [])].map((x) => String(x ?? "").trim()).filter(Boolean))];

function emptyDoc() {
  return { version: 1, sets: [] };
}

/** Missing file = empty registry. A corrupt one throws, so it is never overwritten. */
function readDoc(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return emptyDoc();
    throw e;
  }
  const doc = JSON.parse(raw.replace(/^﻿/, ""));
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.sets)) throw new Error(`${file}: not a watch registry`);
  return doc;
}

/** Locked read-modify-write; writes (atomically) only when fn changed the doc. Returns fn's value. */
function mutateDoc(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLockSync(file, () => {
    const doc = readDoc(file);
    const before = JSON.stringify(doc);
    const out = fn(doc);
    if (JSON.stringify(doc) !== before) writeFileAtomic(file, JSON.stringify(doc, null, 2) + "\n");
    return out;
  });
}

function prune(doc, now) {
  doc.sets = doc.sets.filter((s) => {
    const closedAt = timeOf(s.firedAt ?? s.cancelledAt);
    if (!Number.isFinite(closedAt) || now - closedAt < PRUNE_AFTER_MS) return true;
    return (s.pings ?? []).some((p) => !p.attemptedAt) && !s.cancelledAt;
  });
}

function normalizeItem(raw) {
  const kind = String(raw?.kind ?? "").trim().toLowerCase();
  if (!WATCH_KINDS.includes(kind)) throw new Error(`addWatch: item kind must be one of ${WATCH_KINDS.join("|")} (got ${JSON.stringify(raw?.kind)})`);
  const ref = String(raw?.ref ?? "").trim();
  if (kind === "agent" && !ref) throw new Error("addWatch: an agent item needs a ref (the agent id)");
  return { kind, ref };
}

// ---------------------------------------------------------------------------
// Registry API (W2's `vs watch` verb and MCP `watch` call these; auth is W2's job, W1 trusts its caller)
// ---------------------------------------------------------------------------

/** Register a watch set. `opts.home` / `opts.now` are for tests. Returns `{id}`. */
export function addWatch({ owner, team, lane, items, stallMin = DEFAULT_STALL_MIN } = {}, { home, now = Date.now() } = {}) {
  const who = String(owner ?? "").trim();
  if (!who) throw new Error("addWatch: owner is required");
  if (!Array.isArray(items) || !items.length) throw new Error("addWatch: at least one item is required");
  const sm = Number(stallMin ?? DEFAULT_STALL_MIN);
  if (!Number.isFinite(sm) || sm <= 0) throw new Error(`addWatch: stallMin must be a positive number of minutes (got ${JSON.stringify(stallMin)})`);
  const seen = new Set();
  const at = iso(now);
  const norm = [];
  for (const raw of items) {
    const it = normalizeItem(raw);
    const k = `${it.kind}:${it.ref}`;
    if (seen.has(k)) continue;
    seen.add(k);
    norm.push({ ...it, state: "waiting", phase: "pending", since: at, phaseSince: at });
  }
  const set = { id: `w-${randomBytes(4).toString("hex")}`, owner: who, team: String(team ?? "").trim(), lane: String(lane ?? "").trim(), createdAt: at, stallMin: sm, items: norm, pings: [] };
  mutateDoc(watchesPath({ home }), (doc) => {
    prune(doc, now);
    doc.sets.push(set);
  });
  return { id: set.id };
}

/** Every registered set (newest last), optionally filtered by owner and/or team. Each carries `status`: armed | fired | cancelled. */
export function listWatches({ owner, team } = {}, { home } = {}) {
  const doc = readDoc(watchesPath({ home }));
  return doc.sets
    .filter((s) => (!owner || s.owner === owner) && (!team || s.team === team))
    .map((s) => ({ ...structuredClone(s), status: s.firedAt ? "fired" : s.cancelledAt ? "cancelled" : "armed" }));
}

/** Disarm a set. A fired set cannot be cancelled (it already pinged). Returns `{ok, id, error?}`. */
export function cancelWatch(id, callerId, { home, now = Date.now() } = {}) {
  return mutateDoc(watchesPath({ home }), (doc) => {
    const set = doc.sets.find((s) => s.id === id);
    if (!set) return { ok: false, id, error: `no watch ${id}` };
    if (set.firedAt) return { ok: false, id, error: `watch ${id} already fired at ${set.firedAt}` };
    if (set.cancelledAt) return { ok: true, id, already: true };
    set.cancelledAt = iso(now);
    set.cancelledBy = String(callerId ?? "").trim() || "unknown";
    return { ok: true, id };
  });
}

// ---------------------------------------------------------------------------
// State machine (pure given its inputs; exported for tests)
// ---------------------------------------------------------------------------

/**
 * Classify one non-done item. ctx: { now, startedAt, agents: Map<id, obs>, reports: Map<id, [{type, ts, text}]> (counted
 * entries only), suite: {result, lock}, restarts: [{name, rec}], alive(pid) }.
 * Returns { phase, phaseSince?, state: waiting | done | fail | stalled, reason?, report? }.
 */
export function classifyItem(item, set, ctx) {
  const t = ctx.now;
  const created = timeOf(set.createdAt);
  const stallMs = Number(set.stallMin) * 60_000;
  const since = (phase, fallback = t) => (phase === item.phase && Number.isFinite(timeOf(item.phaseSince)) ? timeOf(item.phaseSince) : fallback);

  if (item.kind === "agent") {
    const o = ctx.agents.get(item.ref);
    // Reports count after registration and, when the runner told us, after the agent's latest turn started (a fix round
    // after an older report is not done yet).
    const floor = Math.max(created, o?.turnStartedAt ?? 0);
    const reps = (ctx.reports.get(item.ref) ?? []).filter((r) => timeOf(r.ts) >= floor);
    const done = reps.filter((r) => r.type === "done").at(-1);
    const doneAt = done ? timeOf(done.ts) : -Infinity;
    const blocker = reps.filter((r) => r.type === "blocker" && timeOf(r.ts) > doneAt).at(-1);
    if (!o) {
      const ps = since("pending", created);
      return t - ps > stallMs ? { phase: "pending", state: "stalled", reason: "no-events", ...(done ? { report: done.text } : {}) } : { phase: "pending", state: "waiting" };
    }
    const busy = o.status === "running" || o.status === "initializing";
    if (done && !busy) return { phase: o.archived ? "archived" : o.status || "idle", state: "done", report: done.text };
    if (o.archived) return { phase: "archived", state: "stalled", reason: "archived" };
    if (o.status === "closed") return { phase: "closed", state: "stalled", reason: o.lost || o.resumable ? "lost" : "exited" };
    if (o.status === "error") return { phase: "error", state: "stalled", reason: "error" };
    if (o.attention) return { phase: o.status || "running", state: "stalled", reason: "blocked (permission)" };
    if (blocker) return { phase: o.status || "running", state: "stalled", reason: "blocked", report: blocker.text };
    if (!busy) {
      const ps = since("idle");
      return t - ps > stallMs ? { phase: "idle", state: "stalled", reason: "idle-no-report" } : { phase: "idle", state: "waiting" };
    }
    const quietSince = Math.max(o.lastEventAt ?? 0, ctx.startedAt ?? 0, since("running"));
    return t - quietSince > stallMs ? { phase: "running", state: "stalled", reason: "silent" } : { phase: "running", state: "waiting" };
  }

  if (item.kind === "suite") {
    const anyRun = ANY_SUITE.has(item.ref.toLowerCase());
    const matches = (x) => Boolean(x) && (anyRun || String(x.agentId ?? "") === item.ref);
    const rec = ctx.suite?.result;
    const recAt = timeOf(rec?.finishedAt ?? rec?.startedAt);
    if (matches(rec) && recAt >= created) {
      if (rec.died) return { phase: "died", state: "stalled", reason: "died", report: `suite holder pid ${rec.pid ?? "?"} died with no result` };
      const fail = Number(rec.fail) || 0;
      const files = Array.isArray(rec.failingFiles) && rec.failingFiles.length ? `; failing: ${rec.failingFiles.join(", ")}` : "";
      const summary = `${rec.pass ?? "?"}/${rec.tests ?? "?"} pass, ${fail} fail${files}`;
      return fail > 0 ? { phase: "finished", state: "fail", report: `FAIL ${summary}` } : { phase: "finished", state: "done", report: `PASS ${summary}` };
    }
    const lock = ctx.suite?.lock;
    if (matches(lock)) {
      if (!ctx.alive(Number(lock.pid))) return { phase: "running", state: "stalled", reason: "holder-dead", report: `suite holder pid ${lock.pid} is gone and wrote no result` };
      const lockAt = timeOf(lock.startedAt);
      return { phase: "running", phaseSince: Number.isFinite(lockAt) ? iso(lockAt) : undefined, state: "waiting" };
    }
    const ps = since("queued");
    return t - ps > stallMs ? { phase: "queued", state: "stalled", reason: "not-started" } : { phase: "queued", state: "waiting" };
  }

  // restart
  const ref = item.ref;
  const cands = (ctx.restarts ?? []).filter(({ name, rec }) =>
    ref ? name === ref || name === `restart-${ref}.json` || name.includes(ref) : !rec.dryRun && timeOf(rec.finishedAt ?? rec.startedAt) >= created,
  );
  const last = cands.at(-1)?.rec;
  if (last) {
    if (last.ok === true) {
      const cut = Array.isArray(last.cutAgents) ? last.cutAgents.length : 0;
      const resumed = Array.isArray(last.resumedAgents) ? last.resumedAgents.length : 0;
      return { phase: "finished", state: "done", report: `restart ok: cut ${cut}, resumed ${resumed}${last.newHash ? `, now ${String(last.newHash).slice(0, 12)}` : ""}` };
    }
    const errs = (Array.isArray(last.errors) ? last.errors : []).map((e) => (typeof e === "string" ? e : e?.message ?? e?.step ?? JSON.stringify(e)));
    return { phase: "finished", state: "stalled", reason: "restart-failed", report: `restart failed${errs.length ? `: ${errs.join("; ")}` : ""}` };
  }
  const ps = since("waiting", created);
  return t - ps > stallMs ? { phase: "waiting", state: "stalled", reason: "no-result" } : { phase: "waiting", state: "waiting" };
}

function itemLabel(item) {
  if (item.kind === "agent") return `agent ${item.ref}`;
  if (item.kind === "suite") return ANY_SUITE.has(item.ref.toLowerCase()) ? "suite" : `suite (${item.ref})`;
  return item.ref ? `restart ${item.ref}` : "restart";
}

function itemLine(item) {
  const rep = item.report ? ` — ${oneLine(item.report)}` : "";
  if (item.state === "done") return `- ${itemLabel(item)}: done${rep}`;
  if (item.state === "fail") return `- ${itemLabel(item)}: FAIL${rep}`;
  if (item.state === "stalled") return `- ${itemLabel(item)}: STALLED (${item.reason})${rep}`;
  return `- ${itemLabel(item)}: ${item.phase || "waiting"}`;
}

function completionText(set) {
  const n = (st) => set.items.filter((i) => i.state === st).length;
  const [d, f, s] = [n("done"), n("fail"), n("stalled")];
  const head =
    f || s
      ? `Watch ${set.id} finished: ${d} done${f ? `, ${f} FAIL` : ""}${s ? `, ${s} still stalled` : ""} (of ${set.items.length}).`
      : `Watch ${set.id} complete: all ${set.items.length} item${set.items.length === 1 ? "" : "s"} done.`;
  return [head, ...set.items.map(itemLine), "Run 'vs log --since-me' for the full reports."].join("\n");
}

function stallText(set, fresh) {
  const what = fresh.map((i) => `${itemLabel(i)} ${i.state === "fail" ? "FAIL" : `stalled (${i.reason})`}`).join(", ");
  return [
    `Watch ${set.id} stall: ${what}. The set stays armed for the rest ('vs watch cancel ${set.id}' to stop).`,
    ...set.items.map(itemLine),
  ].join("\n");
}

/**
 * Advance one open set in place. Returns the ping it fired (already appended to set.pings), or null.
 * Fire rule: when every item is settled (done, FAIL, or stalled and already pinged) and some item finished since the last ping,
 * the completion ping fires (set.firedAt; the set is closed for good). Otherwise every item that newly stalled or FAILed gets a
 * stall ping (all of them in ONE message), once per item; the set stays armed.
 */
export function stepSet(set, ctx) {
  if (!isOpen(set)) return null;
  const at = iso(ctx.now);
  for (const item of set.items) {
    if (item.state === "done") continue; // sticky
    const c = classifyItem(item, set, ctx);
    if (c.phase !== item.phase) {
      item.phase = c.phase;
      item.phaseSince = c.phaseSince ?? at;
    } else if (c.phaseSince && c.phaseSince !== item.phaseSince) item.phaseSince = c.phaseSince;
    if (c.state !== item.state || (c.reason ?? null) !== (item.reason ?? null)) {
      item.state = c.state;
      item.since = at;
      if (c.reason) item.reason = c.reason;
      else delete item.reason;
      if (c.state === "done" || c.state === "fail") item.doneAt = at;
    }
    if (c.report !== undefined && c.report !== item.report) item.report = c.report;
  }
  set.pings ??= [];
  const lastPing = timeOf(set.lastPingAt);
  const settled = (i) => i.state === "done" || i.state === "fail" || (i.state === "stalled" && Boolean(i.stallFiredAt));
  const progressed = set.items.some((i) => (i.state === "done" || i.state === "fail") && !(timeOf(i.doneAt) <= lastPing));
  if (set.items.every(settled) && progressed) {
    const ping = { key: "done", at, text: completionText(set) };
    set.pings.push(ping);
    set.firedAt = at;
    set.lastPingAt = at;
    return ping;
  }
  const fresh = set.items.filter((i) => (i.state === "stalled" || i.state === "fail") && !i.stallFiredAt);
  if (!fresh.length) return null;
  for (const i of fresh) i.stallFiredAt = at;
  const ping = { key: `stall-${set.pings.filter((p) => p.key !== "done").length + 1}`, at, text: stallText(set, fresh) };
  set.pings.push(ping);
  set.lastPingAt = at;
  return ping;
}

// ---------------------------------------------------------------------------
// Engine (one per machine: the VS server's watcher-enabled hook host)
// ---------------------------------------------------------------------------

/**
 * opts: home, tmpdir (suite files), now(), alive(pid), getAgent(id) -> snapshot | null, deliver(ping) (the plugin's wake path),
 * log(msg), retryMs (re-offer of an undelivered ping). All injectable for tests.
 * deliver receives { key, setId, pingKey, text, owner, team, lane, set }; it must not throw synchronously.
 */
export function createWatchEngine({
  home,
  tmpdir = os.tmpdir(),
  now = () => Date.now(),
  alive = pidAlive,
  getAgent,
  deliver,
  log = () => {},
  retryMs = 10_000,
} = {}) {
  const file = watchesPath({ home });
  const startedAt = now();
  let cache = emptyDoc();
  let cacheStamp = "";
  const agents = new Map(); // id -> { status, statusSince, lost, resumable, archived, attention, lastEventAt, turnStartedAt, labels }
  const reports = new Map(); // agent id -> raw done/blocker entries that name it (newest last, capped)
  const reportKeys = new Set();
  const counted = new WeakMap(); // entry -> Map<ref, Promise<boolean>>
  const authorKinds = new Map(); // author id -> "digest" | "manager" | "other"
  const lastSnap = new Map(); // agent id -> ms of the last getAgent
  const lastOffer = new Map(); // ping key -> ms of the last deliver call
  const restartCache = new Map(); // file name -> { mtimeMs, rec }
  let ticking = false;

  function reload() {
    let stamp = "";
    try {
      const st = fs.statSync(file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      stamp = "missing";
    }
    if (stamp === cacheStamp) return cache;
    try {
      cache = readDoc(file);
      cacheStamp = stamp;
    } catch (e) {
      log(`watch registry unreadable (${file}): ${e?.message ?? e}`);
    }
    return cache;
  }

  const openSets = () => reload().sets.filter(isOpen);
  const watchedRefs = () => new Set(openSets().flatMap((s) => s.items.filter((i) => i.kind === "agent").map((i) => i.ref)));

  function obsFor(id) {
    let o = agents.get(id);
    if (!o) agents.set(id, (o = {}));
    return o;
  }

  function observe(a, t, activity = true) {
    if (!a?.id) return;
    const o = obsFor(String(a.id));
    const st = String(a.status ?? "");
    if (o.status !== st) {
      o.status = st;
      o.statusSince = t;
    }
    o.lost = a.lost === true;
    o.resumable = a.resumable === true;
    o.archived = Boolean(a.archivedAt || a.archived);
    o.attention = Boolean(a.requiresAttention || (a.pendingPermissions?.length ?? 0) > 0);
    if (a.labels) o.labels = a.labels;
    if (activity || o.lastEventAt === undefined) o.lastEventAt = t;
  }

  /** RunnerBackend.subscribeEvents listener. Never throws. */
  function onRunnerEvent(ev) {
    try {
      const t = now();
      if (!ev || typeof ev !== "object") return;
      if (ev.kind === "roster") {
        for (const a of ev.agents ?? []) observe(a, t, false); // a (re)connect seed is not activity
        return;
      }
      if (ev.kind === "remove") {
        const o = obsFor(String(ev.agentId));
        o.archived = true;
        o.lastEventAt = t;
        return;
      }
      if (ev.agent) observe(ev.agent, t);
      else if (ev.agentId) obsFor(String(ev.agentId)).lastEventAt = t;
      if (ev.kind === "permission" && ev.agentId) obsFor(String(ev.agentId)).attention = true;
      if (ev.kind === "turn_started" && ev.agentId) obsFor(String(ev.agentId)).turnStartedAt = t;
    } catch (e) {
      log(`watch runner event failed: ${e?.message ?? e}`);
    }
  }

  function recordReport(entry) {
    const k = `${entry.ts}|${entry.agent}|${entry.type}|${entry.text}`;
    if (reportKeys.has(k)) return;
    const watched = watchedRefs();
    const ids = refsOf(entry).filter((id) => watched.has(id));
    if (!ids.length) return;
    reportKeys.add(k);
    for (const id of ids) {
      const list = reports.get(id) ?? [];
      list.push(entry);
      list.sort((a, b) => timeOf(a.ts) - timeOf(b.ts));
      if (list.length > REPORTS_PER_AGENT) list.splice(0, list.length - REPORTS_PER_AGENT);
      reports.set(id, list);
    }
  }

  /**
   * A team-log entry (scanLogs). Records `done` / `blocker` entries that name a watched agent and returns the ids of the open
   * sets that take it over: the plugin holds it back from the normal per-event wake to the set's owner (one ping, not N).
   * A blocker on an item that already had its stall ping is not taken (the owner hears it the normal way).
   */
  function onLogEntry(_team, entry) {
    try {
      if (!entry || (entry.type !== "done" && entry.type !== "blocker")) return [];
      const ts = timeOf(entry.ts);
      const ids = refsOf(entry);
      const taken = [];
      for (const set of openSets()) {
        if (Number.isFinite(ts) && ts < timeOf(set.createdAt)) continue;
        if (entry.agent === set.owner) continue; // the owner's own entries never wake it anyway
        const hit = set.items.filter((i) => i.kind === "agent" && ids.includes(i.ref));
        if (!hit.length) continue;
        if (entry.type === "blocker" && hit.every((i) => i.stallFiredAt)) continue;
        taken.push(set.id);
      }
      recordReport(entry);
      return taken;
    } catch (e) {
      log(`watch log entry failed: ${e?.message ?? e}`);
      return [];
    }
  }

  async function authorKind(id) {
    const known = authorKinds.get(id);
    if (known) return known;
    let snapAgent = null;
    try {
      snapAgent = agents.get(id)?.labels ? { labels: agents.get(id).labels } : await getAgent?.(id);
    } catch {
      snapAgent = null;
    }
    if (!snapAgent) return "other"; // unknown: not memoized, a later lookup may know it
    const labels = snapAgent.labels ?? {};
    const role = String(labels.role ?? "").trim().toLowerCase();
    const kind = isDigestAgent(labels) ? "digest" : MANAGER_ROLES.has(role) || isRetiredRole(role) ? "manager" : "other";
    authorKinds.set(id, kind);
    return kind;
  }

  /** Does `entry` count as `ref`'s own report? Its own entry, its digest's, or a non-manager's PASS/FAIL verdict naming it. */
  function reportCounts(entry, ref) {
    let byRef = counted.get(entry);
    if (!byRef) counted.set(entry, (byRef = new Map()));
    let p = byRef.get(ref);
    if (!p) {
      p = (async () => {
        if (entry.agent === ref) return true;
        const kind = await authorKind(String(entry.agent ?? ""));
        if (kind === "digest") return true;
        if (kind === "manager") return false;
        return VERDICT_RE.test(String(entry.text ?? ""));
      })().catch(() => false);
      byRef.set(ref, p);
    }
    return p;
  }

  /** The sets (by id) that `entry` was taken by and still holds: not cancelled, and the entry is a counted report of an item. */
  async function holdingSets(entry, setIds) {
    reload();
    const out = [];
    for (const id of setIds ?? []) {
      const set = cache.sets.find((s) => s.id === id);
      if (!set || (set.cancelledAt && !set.firedAt)) continue;
      const ids = refsOf(entry);
      for (const item of set.items) {
        if (item.kind !== "agent" || !ids.includes(item.ref)) continue;
        if (await reportCounts(entry, item.ref)) {
          out.push(structuredClone(set));
          break;
        }
      }
    }
    return out;
  }

  function readJson(p) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
    } catch {
      return null;
    }
  }

  function readRestarts() {
    let names = [];
    try {
      names = fs.readdirSync(vsHome(home)).filter((n) => /^restart-.*\.json$/.test(n));
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      const full = path.join(vsHome(home), name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      let hit = restartCache.get(name);
      if (!hit || hit.mtimeMs !== mtimeMs) {
        const rec = readJson(full);
        if (!rec || typeof rec !== "object") continue; // mid-write: next tick
        restartCache.set(name, (hit = { mtimeMs, rec }));
      }
      out.push({ name, rec: hit.rec });
    }
    return out.sort((a, b) => timeOf(a.rec.finishedAt ?? a.rec.startedAt) - timeOf(b.rec.finishedAt ?? b.rec.startedAt));
  }

  /** Async inputs for one evaluation: re-read stale watched agents, resolve report authors. */
  async function gather(sets) {
    const t = now();
    const refs = new Set(sets.flatMap((s) => s.items.filter((i) => i.kind === "agent" && i.state !== "done").map((i) => i.ref)));
    if (getAgent) {
      for (const ref of refs) {
        if (t - (lastSnap.get(ref) ?? -Infinity) < SNAP_REFRESH_MS) continue;
        lastSnap.set(ref, t);
        try {
          const a = await getAgent(ref);
          if (a) observe({ ...a, id: a.id ?? ref }, t, false);
        } catch {
          /* runner hiccup: the stall clock still runs */
        }
      }
    }
    const valid = new Map();
    for (const ref of refs) {
      const list = [];
      for (const e of reports.get(ref) ?? []) if (await reportCounts(e, ref)) list.push({ type: e.type, ts: e.ts, text: String(e.text ?? "") });
      valid.set(ref, list);
    }
    const kinds = new Set(sets.flatMap((s) => s.items.map((i) => i.kind)));
    const td = tmpdir;
    return {
      now: now(),
      startedAt,
      agents,
      reports: valid,
      alive,
      suite: kinds.has("suite") ? { result: readJson(path.join(td, SUITE_RESULT_FILE)), lock: readJson(path.join(td, SUITE_LOCK_FILE)) } : {},
      restarts: kinds.has("restart") ? readRestarts() : [],
    };
  }

  /** Evaluate every open set, persist changes (fired pings BEFORE anything is sent), then offer undelivered pings. */
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const open = openSets();
      if (open.length) {
        const ctx = await gather(open);
        // Dry run on a copy of the cache first: only take the lock when something changes.
        const dry = structuredClone(open);
        const before = JSON.stringify(dry);
        for (const s of dry) stepSet(s, ctx);
        if (JSON.stringify(dry) !== before) {
          try {
            mutateDoc(file, (doc) => {
              for (const s of doc.sets) stepSet(s, ctx);
              prune(doc, ctx.now);
            });
          } catch (e) {
            log(`watch registry write failed: ${e?.message ?? e}`);
          }
          cacheStamp = "";
          reload();
        }
      }
      await offerPending();
    } finally {
      ticking = false;
    }
  }

  async function offerPending() {
    if (!deliver) return;
    const t = now();
    for (const set of cache.sets) {
      if (set.cancelledAt) continue; // the owner disarmed it: drop what was not sent yet
      for (const ping of set.pings ?? []) {
        if (ping.attemptedAt) continue;
        const key = pingKeyOf(set, ping);
        if (t - (lastOffer.get(key) ?? -Infinity) < retryMs) continue;
        lastOffer.set(key, t);
        try {
          await deliver({ key, setId: set.id, pingKey: ping.key, text: ping.text, owner: set.owner, team: set.team, lane: set.lane, set: structuredClone(set) });
        } catch (e) {
          log(`watch ${set.id} delivery failed: ${e?.message ?? e}`);
        }
      }
    }
  }

  function markPings(keys, fn) {
    const want = new Set(keys ?? []);
    if (!want.size) return;
    try {
      mutateDoc(file, (doc) => {
        for (const set of doc.sets) for (const ping of set.pings ?? []) if (want.has(pingKeyOf(set, ping))) fn(ping);
      });
    } catch (e) {
      log(`watch ping mark failed: ${e?.message ?? e}`);
    }
    cacheStamp = "";
    reload();
  }

  /** Right before the send: from here on the ping is never sent again (at most once), even across a restart. */
  const markAttempted = (keys, to) =>
    markPings(keys, (p) => {
      p.attemptedAt ??= iso(now());
      p.to = to;
    });
  const markDelivered = (keys, to) =>
    markPings(keys, (p) => {
      p.deliveredAt ??= iso(now());
      p.to = to;
    });
  const markFailed = (keys, error) =>
    markPings(keys, (p) => {
      p.error = oneLine(error, 200);
    });

  /** Startup: load the registry and recover the reports filed while the server was down (scanLogs skips history). */
  function start() {
    const open = openSets();
    if (!open.length) return;
    const since = Math.min(...open.map((s) => timeOf(s.createdAt)).filter(Number.isFinite));
    const root = path.join(vsHome(home), "teams");
    let dirs = [];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      return;
    }
    for (const team of dirs) {
      const f = path.join(root, team, "log.jsonl");
      let text = "";
      try {
        const size = fs.statSync(f).size;
        const fd = fs.openSync(f, "r");
        try {
          const len = Math.min(size, BACKFILL_TAIL_BYTES);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, size - len);
          text = buf.toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        if (!line.includes('"done"') && !line.includes('"blocker"')) continue;
        try {
          const e = JSON.parse(line);
          if ((e.type === "done" || e.type === "blocker") && timeOf(e.ts) >= since) recordReport(e);
        } catch {
          /* partial first line of the tail, or malformed */
        }
      }
    }
  }

  return {
    file,
    reload,
    start,
    tick,
    onRunnerEvent,
    onLogEntry,
    holdingSets,
    markAttempted,
    markDelivered,
    markFailed,
    get: (id) => {
      const s = reload().sets.find((x) => x.id === id);
      return s ? structuredClone(s) : null;
    },
    list: () => structuredClone(reload().sets),
  };
}
