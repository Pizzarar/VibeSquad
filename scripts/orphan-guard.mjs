// Parent-death guard for scripts/run-tests.mjs (idea-577). A backgrounded `npm test -- --queue` whose shell is killed
// (e.g. Claude Code TaskStop kills the shell only) leaves `node scripts/run-tests.mjs` alive: its pid is live, so the
// stale-holder takeover never fires and every lane's suite waits behind it. This guard notices the launcher is gone so the
// run can kill its test tree, release the slot and exit.
//
// Watched: the direct parent, then on up through launchers (shells, npm/npx, timeout/env), including the first
// non-launcher (the agent or terminal that ran the command). The chain is captured once at start (one process listing,
// async). Every pollMs: POSIX checks process.ppid against the starting value (reparented = parent gone), and every watched pid
// gets a kill(0). Every verifyMs one filtered listing compares start times, so a dead launcher whose pid Windows reused
// is still caught. Windows ParentProcessId never changes after creation, so while climbing, a "parent" created after its
// child is a reused pid and ends the chain. Off with VS_TEST_ORPHAN_GUARD=0; VS_TEST_ORPHAN_POLL_MS sets the poll.
import { execFile, execFileSync } from "node:child_process";
import { pidAlive } from "../runner/lock.mjs";

export const ORPHAN_POLL_MS = 3000;
export const ORPHAN_VERIFY_MS = 30000;
const MAX_WATCHED = 8;
const LIST_TIMEOUT_MS = 30000;
const SHELLS = new Set(["bash", "sh", "dash", "zsh", "ksh", "fish", "cmd", "powershell", "pwsh", "env", "timeout", "nice", "npm", "npx"]);

function firstToken(cmd = "") {
  const s = String(cmd).trim();
  if (s.startsWith('"')) return s.slice(1, s.indexOf('"', 1) > 0 ? s.indexOf('"', 1) : undefined);
  return s.split(/\s+/)[0] ?? "";
}

/** Lowercased program basename without .exe: from the Windows image name, else the first token of the command line. */
export function progName(p) {
  const raw = p?.name || firstToken(p?.cmd);
  return String(raw).split(/[\\/]/).pop().replace(/^-/, "").replace(/\.exe$/i, "").toLowerCase();
}

/** A process that only relays a command (shell, npm/npx, env/timeout): its death alone does not end the chain. */
export function isLauncher(p) {
  const n = progName(p);
  if (SHELLS.has(n)) return true;
  return n === "node" && /np[mx]-cli\.js|[\\/]bin[\\/]np[mx](?![\w.-])/i.test(String(p?.cmd ?? ""));
}

// Start-time slack. Windows CreationDate is exact (ms); POSIX `ps -o lstart` has 1s resolution and procps-ng can report the
// same process a second apart between calls (boot-time rounding), so start times there match within 2s.
export const startSlack = (platform = process.platform) => (platform === "win32" ? 0 : 2000);

const describe = (p) => `${progName(p) || "process"} pid ${p.pid}`;

/**
 * The ancestors to watch, from a process listing [{pid, ppid, start, name?, cmd}]. orphan is set when the direct parent is
 * already gone (missing, or its pid now belongs to a process created after us). null chain = cannot tell (no guard).
 */
export function launchChain(procs, selfPid = process.pid, max = MAX_WATCHED, slack = startSlack()) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const self = byPid.get(selfPid);
  if (!self || !Number.isInteger(self.ppid) || self.ppid <= 1) return { chain: null, orphan: null };
  const chain = [];
  let cur = self;
  while (chain.length < max && Number.isInteger(cur.ppid) && cur.ppid > 1) {
    const parent = byPid.get(cur.ppid);
    const reused = parent && parent.start != null && cur.start != null && parent.start > cur.start + slack;
    if (!parent || reused) {
      if (cur === self) return { chain: null, orphan: `parent pid ${cur.ppid} exited${reused ? " (pid reused)" : ""}` };
      break; // an upper ancestor that was gone before we started: the chain ends there
    }
    chain.push(parent);
    if (!isLauncher(parent)) break;
    cur = parent;
  }
  return { chain, orphan: null };
}

function winScript(pids) {
  const filter = pids?.length ? ` -Filter "${pids.map((p) => `ProcessId=${Number(p)}`).join(" OR ")}"` : "";
  return `Get-CimInstance Win32_Process${filter} | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; ` +
    `start = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }); cmd = $_.CommandLine } } | ConvertTo-Json -Compress`;
}

function listCommand(pids) {
  if (process.platform === "win32") return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", winScript(pids)]];
  return ["ps", [...(pids?.length ? ["-p", pids.join(",")] : ["-A"]), "-o", "pid=,ppid=,lstart=,args="]];
}

function parseList(out) {
  if (process.platform === "win32") {
    const rows = out.trim() ? JSON.parse(out) : [];
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.pid, ppid: r.ppid, name: r.name ?? "", start: Number.isFinite(r.start) ? r.start : null, cmd: r.cmd ?? "" }));
  }
  return out.split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => {
    const start = Date.parse(m[3]);
    return { pid: +m[1], ppid: +m[2], start: Number.isFinite(start) ? start : null, cmd: m[4] };
  });
}

// LC_ALL=C: lstart is printed in the locale's date format, which Date.parse cannot read outside English (start would be null).
const execOpts = () => ({ encoding: "utf8", maxBuffer: 64 << 20, timeout: LIST_TIMEOUT_MS, windowsHide: true, ...(process.platform === "win32" ? {} : { env: { ...process.env, LC_ALL: "C" } }) });

/** Async process listing [{pid, ppid, start (ms), name, cmd}], all processes or just `pids`. `signal` aborts (kills) the listing. */
export function listProcs(pids, { signal } = {}) {
  const [cmd, args] = listCommand(pids);
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...execOpts(), signal }, (err, out) => {
      if (err && !(process.platform !== "win32" && pids?.length && err.code === 1)) return reject(err); // ps -p exits 1 when none match
      try { resolve(parseList(out ?? "")); } catch (e) { reject(e); }
    });
  });
}

export function listProcsSync() {
  const [cmd, args] = listCommand();
  return parseList(execFileSync(cmd, args, execOpts()));
}

/**
 * rootPid and its descendants, parents before children. A child is followed only when both start times are known and the child
 * is not older than its parent (minus slack): an older "child" names a reused ppid. Fail safe: an unknown start stops the walk
 * there. rootStart (taken before the spawn) stands in when rootPid is missing from the listing.
 */
export function treePids(procs, rootPid, { rootStart = null, slack = startSlack() } = {}) {
  const kids = new Map();
  for (const p of procs) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)).push(p);
  const root = procs.find((p) => p.pid === rootPid) ?? { pid: rootPid, start: rootStart };
  const out = [rootPid];
  const seen = new Set(out);
  const walk = (parent) => {
    if (parent.start == null) return;
    for (const c of kids.get(parent.pid) ?? []) {
      if (seen.has(c.pid) || c.start == null || c.start + slack < parent.start) continue;
      seen.add(c.pid);
      out.push(c.pid);
      walk(c);
    }
  };
  walk(root);
  return out;
}

/** Kill rootPid's whole process tree (leaves first). Returns the pids signalled. Never throws. */
export function killTree(rootPid, { list = listProcsSync, rootStart = null } = {}) {
  let pids = [rootPid];
  try { pids = treePids(list(), rootPid, { rootStart }); } catch {
    if (process.platform === "win32") {
      try { execFileSync("taskkill", ["/T", "/F", "/PID", String(rootPid)], { stdio: "ignore", timeout: LIST_TIMEOUT_MS, windowsHide: true }); } catch {}
    }
  }
  for (const pid of [...pids].reverse()) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  return pids;
}

/**
 * Start watching. onOrphan(reason) fires at most once, after the guard has stopped itself. Returns {stop(), tick(), ready}
 * (ready resolves once the chain is captured; tests use it). The timer is unref'd, so the guard never keeps a process alive.
 */
export function startOrphanGuard({
  onOrphan,
  pollMs = Number(process.env.VS_TEST_ORPHAN_POLL_MS) || ORPHAN_POLL_MS,
  verifyMs = Math.max(ORPHAN_VERIFY_MS, 10 * (Number(process.env.VS_TEST_ORPHAN_POLL_MS) || ORPHAN_POLL_MS)),
  list = listProcs,
  alive = pidAlive,
  selfPid = process.pid,
  platform = process.platform,
  ppid = () => process.ppid,
  slack = startSlack(platform),
} = {}) {
  const initialPpid = ppid();
  const ac = new AbortController(); // stop() kills an in-flight listing
  let watched = null;
  let stopped = false;
  let busy = false;
  let lastVerify = Date.now();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    ac.abort();
  };
  const fire = (reason) => {
    if (stopped) return;
    stop();
    onOrphan(reason);
  };
  const ready = list(undefined, { signal: ac.signal }).then(
    (procs) => {
      if (stopped) return;
      const { chain, orphan } = launchChain(procs, selfPid, MAX_WATCHED, slack);
      if (orphan) return fire(orphan);
      watched = chain ?? [];
      lastVerify = Date.now();
    },
    () => {
      if (!stopped) watched = initialPpid > 1 ? [{ pid: initialPpid, start: null, name: "parent" }] : []; // listing failed: the direct parent, kill(0) only
    },
  );
  const verify = () => {
    busy = true;
    list([selfPid, ...watched.map((w) => w.pid)], { signal: ac.signal })
      .then((procs) => {
        if (stopped || !procs.some((p) => p.pid === selfPid)) return; // a listing without us is unreliable: skip
        const byPid = new Map(procs.map((p) => [p.pid, p]));
        for (const w of watched) {
          const now = byPid.get(w.pid);
          if (now && w.start != null && now.start != null && Math.abs(now.start - w.start) > slack) return fire(`${describe(w)} exited (pid reused)`);
        }
      })
      .catch(() => {})
      .finally(() => {
        busy = false;
        lastVerify = Date.now();
      });
  };
  const tick = () => {
    if (stopped) return;
    if (platform !== "win32" && initialPpid > 1 && ppid() !== initialPpid) return fire(`parent pid ${initialPpid} exited (reparented to pid ${ppid()})`);
    if (!watched) return;
    for (const w of watched) if (!alive(w.pid)) return fire(`${describe(w)} exited`);
    if (!busy && Date.now() - lastVerify >= verifyMs && watched.some((w) => w.start != null)) verify();
  };
  const timer = setInterval(tick, pollMs);
  timer.unref?.();
  return { stop, tick, ready };
}
