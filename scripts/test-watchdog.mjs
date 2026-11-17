// Per-file hang watchdog for scripts/run-tests.mjs (idea-309). `node --test` has no per-file timeout, and one wedged file
// (e.g. test/ui-overlap.test.mjs awaiting a headless Edge) held the machine-wide suite slot for 30+ min. A file is hung when
// it has started running, has not finished, and has emitted no test event for `idleMs`. The watchdog names the file, kills that
// file's node process and every descendant (the Edge child), and lets node --test report the file as failed so the run ends.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_FILE_IDLE_MS = 15 * 60 * 1000;

/** Fold progress JSONL text into Map<file, {open, last}>. Bad lines are ignored. */
export function foldProgress(text, state = new Map()) {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e?.file) continue;
    const s = state.get(e.file) ?? { open: 0, last: 0 };
    if (e.ev === "start") s.open = 1;
    else if (e.ev === "end") s.open = 0;
    s.last = Math.max(s.last, Number(e.t) || 0);
    state.set(e.file, s);
  }
  return state;
}

/** Files with an unfinished test and no event for idleMs. */
export function hungFiles(state, now, idleMs) {
  return [...state].filter(([, s]) => s.open > 0 && now - s.last >= idleMs).map(([file]) => file);
}

/** [{pid, ppid, cmd}] for every process. */
export function listProcesses() {
  if (process.platform === "win32") {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"], { encoding: "utf8", maxBuffer: 64 << 20, timeout: 30000 });
    const rows = JSON.parse(out || "[]");
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, cmd: r.CommandLine ?? "" }));
  }
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 64 << 20, timeout: 30000 });
  return out.split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], cmd: m[3] }));
}

const norm = (s) => s.replaceAll("\\", "/").toLowerCase();

/** Pids to kill for a hung file: the descendant of rootPid whose command line names the file, plus all its descendants. */
export function pidsForFile(procs, rootPid, file) {
  const kids = new Map();
  for (const p of procs) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)).push(p);
  const under = (pid) => (kids.get(pid) ?? []).flatMap((c) => [c, ...under(c.pid)]);
  const f = norm(file), rel = norm(path.relative(process.cwd(), file));
  const owner = under(rootPid).find((p) => { const c = norm(p.cmd); return c.includes(f) || (rel && !rel.startsWith("..") && c.includes(rel)); });
  if (!owner) return [];
  return [owner.pid, ...under(owner.pid).map((p) => p.pid)];
}

function killPids(pids) {
  for (const pid of [...pids].reverse()) { // leaves first
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

/**
 * Poll `progressFile`; kill + report any hung file once. Returns {stop(), killed: string[]}.
 * onHung(file, {idleMs, pids}) is called after the kill (default: stderr line naming the file).
 */
export function startWatchdog({ progressFile, rootPid, idleMs = DEFAULT_FILE_IDLE_MS, pollMs = 5000, root = process.cwd(), onHung, now = Date.now, list = listProcesses, kill = killPids }) {
  const state = new Map();
  const done = new Set();
  const killed = [];
  let offset = 0;
  const tick = () => {
    try {
      const buf = readFileSync(progressFile);
      const nl = buf.lastIndexOf(10); // only complete lines
      if (nl >= offset) { foldProgress(buf.subarray(offset, nl + 1).toString("utf8"), state); offset = nl + 1; }
    } catch { return; }
    for (const file of hungFiles(state, now(), idleMs)) {
      if (done.has(file)) continue;
      done.add(file);
      let pids = [];
      try { pids = pidsForFile(list(), rootPid, file); } catch {}
      kill(pids);
      killed.push(file);
      const rel = path.relative(root, file).split(path.sep).join("/");
      const note = pids.length ? `killed pid ${pids[0]} and ${pids.length - 1} child process(es)` : "killed nothing (owning process not found)";
      const msg = `TEST FILE TIMEOUT: ${rel} had a test running with no progress for ${Math.round(idleMs / 1000)}s; ${note}. The file is reported as failed so the suite slot is freed.`;
      if (onHung) onHung(file, { idleMs, pids, msg }); else console.error(msg);
    }
  };
  const timer = setInterval(tick, pollMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), killed, tick };
}
