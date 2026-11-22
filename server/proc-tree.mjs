// Kill a child process and everything it spawned. Windows has no process groups for plain spawn(), so use taskkill /T.
// Built-ins only: scripts/restart-runtime.mjs imports this statically (posixKillTree) and must not pull in app modules.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

/** Best-effort; synchronous when `sync` (needed inside a process "exit" handler). */
export function killTree(pid, { sync = false } = {}) {
  if (!pid || pid < 2) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(pid), "/T", "/F"];
    if (sync) {
      // taskkill is a separate process: under heavy CPU load its startup alone can pass a few seconds, and a spawnSync timeout kills it
      // mid-job and leaves the tree alive. Allow a generous ceiling, and if it still didn't finish, at least take down the root.
      let r;
      try { r = spawnSync("taskkill", args, { windowsHide: true, stdio: "ignore", timeout: 30000 }); } catch {}
      if (!r || r.error || r.signal) { try { process.kill(pid, "SIGKILL"); } catch {} }
    } else {
      try { spawn("taskkill", args, { windowsHide: true, stdio: "ignore" }).on("error", () => {}).unref(); } catch {}
    }
    return;
  }
  // POSIX: children are started detached (own process group), so signal the group, then the pid itself.
  for (const target of [-pid, pid]) {
    try { process.kill(target, "SIGKILL"); } catch {}
  }
}

const exitHooks = new Set();
let hooked = false;

/** Runs `fn` when the server process exits, including on SIGINT/SIGTERM/SIGHUP (which skip "exit" handlers by default). */
export function onServerExit(fn) {
  exitHooks.add(fn);
  if (!hooked) {
    hooked = true;
    const run = () => { for (const f of exitHooks) { try { f(); } catch {} } };
    process.on("exit", run);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      // Only finish the default behaviour (exit) when nobody else is listening for the signal.
      process.on(sig, () => { run(); if (process.listenerCount(sig) <= 1) process.exit(128); });
    }
  }
  return () => exitHooks.delete(fn);
}

// ---- POSIX process-group tree kill (forge-host A2, audit R4/R27) -------------------------------------------------------
// Off win32 the runner starts every agent CLI `detached` (spawnNoShell), so the CLI leads its own process group and
// kill(-pid) reaches every descendant that did not leave the group (tool shells, MCP sidecars, a Godot suite). A pid
// that is not a group leader (a child from before detached spawns, a hand-started server) falls back to a ppid walk of
// /proc (or `ps`), signalled leaf-first. Never used on win32: callers keep their taskkill /T branch.

export const TREE_KILL_GRACE_MS = 5000;

/** One /proc/<pid>/stat line -> { pid, ppid, pgid, start } or null. comm may hold spaces and parens: split after the last ')'. */
export function parseProcStat(text) {
  const s = String(text ?? "");
  const open = s.indexOf("(");
  const close = s.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(s.slice(0, open).trim());
  const f = s.slice(close + 1).trim().split(/\s+/); // f[0]=state f[1]=ppid f[2]=pgrp ... f[19]=starttime
  const ppid = Number(f[1]);
  const pgid = Number(f[2]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || !Number.isInteger(pgid)) return null;
  const start = f[19] !== undefined && /^\d+$/.test(f[19]) ? f[19] : null;
  return { pid, ppid, pgid, start };
}

/**
 * Map<pid, { pid, ppid, pgid, start }> of every process, or null when the OS would not say. Linux: /proc/<pid>/stat
 * (start = starttime ticks, used to spot pid reuse before an escalation). Elsewhere: `ps -A -o pid=,ppid=,pgid=` (start null).
 */
export function readProcTable({ procDir = "/proc", readdir = readdirSync, read = readFileSync, run = spawnSync } = {}) {
  let names = null;
  try { names = readdir(procDir); } catch { /* no /proc (macOS): ps below */ }
  if (names) {
    const table = new Map();
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      let rec = null;
      try { rec = parseProcStat(read(`${procDir}/${name}/stat`, "utf8")); } catch { /* exited mid-walk */ }
      if (rec) table.set(rec.pid, rec);
    }
    if (table.size) return table;
  }
  try {
    const r = run("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 5000 });
    const table = new Map();
    for (const line of String(r?.stdout ?? "").split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
      if (m) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start: null });
    }
    return table.size ? table : null;
  } catch { return null; }
}

/** Process group id of this process (POSIX), or null. Node has no getpgid, so read it from the proc table. */
export function ownPgid({ selfPid = process.pid, readTable = readProcTable } = {}) {
  try { return readTable()?.get(selfPid)?.pgid ?? null; } catch { return null; }
}

/** Descendants of rootPid (root excluded), every child listed before its parent (post-order: leaves first). */
export function descendantsLeafFirst(rootPid, table) {
  const kids = new Map();
  for (const p of table?.values?.() ?? []) {
    if (p.pid === p.ppid) continue;
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const visit = (pid) => {
    for (const k of kids.get(pid) ?? []) {
      if (seen.has(k)) continue; // a malformed table must not loop
      seen.add(k);
      visit(k);
      out.push(k);
    }
  };
  visit(rootPid);
  return out;
}

/** True when `pid` is `selfPid` or one of its ancestors in `table`. */
function isSelfOrAncestor(pid, selfPid, table) {
  let cur = selfPid;
  for (let hops = 0; cur && hops < 4096; hops++) {
    if (cur === pid) return true;
    const next = table?.get(cur)?.ppid;
    if (!next || next === cur) return false;
    cur = next;
  }
  return false;
}

// pid -> { fire, clear, timer }: tree kills waiting out their grace. One per pid (a second kill during the grace is a no-op), and
// every pending escalation fires at once when this process exits (a runner stop exits ~300 ms after SIGTERM, before any grace).
const pendingKills = new Map();
let exitHooked = false;
let cachedPgid = null;

/** Number of tree kills still in their grace period (tests). */
export function pendingTreeKills() { return pendingKills.size; }

/** Escalate every pending tree kill now (SIGKILL whatever is still alive) and drop its timer. Runs on process exit. */
export function flushTreeKills() {
  for (const [pid, p] of [...pendingKills]) {
    pendingKills.delete(pid);
    p.clear(p.timer);
    try { p.fire(); } catch { /* best effort */ }
  }
}

/**
 * Kill `pid` and its descendants on POSIX. Returns { mode, targets? }:
 *   'group'   - kill(-pid, signal) reached the process group (pid leads it); with a grace, kill(-pid, SIGKILL) after it if
 *               the group still exists.
 *   'walk'    - not a group leader (ESRCH/EPERM on -pid): descendants from the proc table signalled leaf-first, pid last;
 *               after the grace, SIGKILL those still alive whose start time still matches (pid reuse).
 *   'pid'     - walk: false (restart script): no group, so only pid itself.
 *   'gone'    - nothing to kill (ESRCH on the group and on pid).
 *   'pending' - a kill of this pid is already in its grace: nothing new sent, no second timer.
 *   'refused' - pid <= 1, this process, or (walk) one of its ancestors.
 * ESRCH anywhere counts as already dead. Never signals pid 0/1, this process, or this process's own group.
 * graceMs null: no escalation (the caller escalates itself). signal SIGKILL: nothing to escalate.
 */
export function posixKillTree(pid, {
  signal = "SIGTERM",
  graceMs = TREE_KILL_GRACE_MS,
  walk = true,
  killImpl = process.kill.bind(process),
  readTable = readProcTable,
  selfPid = process.pid,
  selfPgid,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === selfPid) return { mode: "refused" };
  if (pendingKills.has(pid)) return { mode: "pending" };
  const myGroup = selfPgid !== undefined ? selfPgid
    : selfPid === process.pid && readTable === readProcTable ? (cachedPgid ??= ownPgid()) // a process never changes its own group here
    : ownPgid({ selfPid, readTable });
  const sig = (target, s) => {
    if (target === 0 || target === 1 || target === -1 || target === selfPid || target === -selfPid) return "err";
    if (myGroup && target === -myGroup) return "err";
    try { killImpl(target, s); return "ok"; } catch (e) { return e?.code === "ESRCH" ? "gone" : "err"; }
  };
  const escalate = signal !== "SIGKILL" && Number.isFinite(graceMs) && graceMs >= 0;
  const schedule = (fire) => {
    const entry = { fire, clear: clearTimer, timer: null };
    entry.timer = setTimer(() => { if (pendingKills.get(pid) === entry) pendingKills.delete(pid); fire(); }, graceMs);
    entry.timer?.unref?.();
    pendingKills.set(pid, entry);
    if (!exitHooked) { exitHooked = true; process.once("exit", flushTreeKills); }
  };

  const groupRes = sig(-pid, signal);
  if (groupRes === "ok") {
    if (escalate) schedule(() => { if (sig(-pid, 0) !== "gone") sig(-pid, "SIGKILL"); });
    return { mode: "group" };
  }
  // No group led by pid (ESRCH), or not ours to signal (EPERM / our own group): is pid itself still there?
  if (groupRes === "gone" && sig(pid, 0) === "gone") return { mode: "gone" };
  if (!walk) return { mode: sig(pid, signal) === "gone" ? "gone" : "pid" };
  let table = null;
  try { table = readTable(); } catch { /* unknown: pid alone below */ }
  if (table && isSelfOrAncestor(pid, selfPid, table)) return { mode: "refused" };
  const targets = [...(table ? descendantsLeafFirst(pid, table) : []).filter((p) => p > 1 && p !== selfPid), pid];
  const started = new Map(targets.map((p) => [p, table?.get(p)?.start ?? null]));
  for (const p of targets) sig(p, signal);
  if (escalate) {
    schedule(() => {
      let now = null;
      try { now = readTable(); } catch { /* unknown: liveness alone */ }
      for (const p of targets) {
        if (sig(p, 0) === "gone") continue;
        const was = started.get(p);
        const is = now?.get(p)?.start ?? null;
        if (was !== null && is !== null && was !== is) continue; // pid reused by a stranger during the grace
        sig(p, "SIGKILL");
      }
    });
  }
  return { mode: "walk", targets };
}
