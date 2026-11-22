// Off-loop git exec (idea-560): on Windows each `git` child costs the server a synchronous CreateProcess on its event
// loop (~0.5-3s per spawn under AV; loop-lag.jsonl 11-22: agent-duties.ts unitBranchGit 44 stalls/45s, runGit 21/22s).
// `execFile("git", ...)` from a request/hook path therefore blocks the loop even though it is "async". This runs the
// same child in a worker thread (server/git-spawn-worker.mjs), so the CreateProcess happens off the loop; the caller's
// contract is unchanged (async, same { ok, out, code }).
//
// Single-flight per repo+args: concurrent identical calls (same resolved cwd, same argv, same timeout) share one child.
// No TTL cache here: the answer can go stale, and callers already guard staleness with their own fingerprint caches
// (agent-duties.ts spawnStateCache / unitBranchCache), which this must not bypass.
import { Worker } from "node:worker_threads";
import path from "node:path";

const INFLIGHT = new Map();
/** Worker spawn counter for tests and diagnostics: how many worker threads this module started. */
export const gitSpawnStats = { workerSpawns: 0 };

/** Same resolved-cwd + argv + timeout => one in-flight child. */
function keyFor(cwd, args, timeoutMs) {
  return `${path.resolve(cwd).toLowerCase()}\u0000${(args ?? []).join("\u0000")}\u0000${timeoutMs ?? 5000}`;
}

/**
 * Run `git --no-optional-locks <args>` in a worker thread. Resolves { ok, out, code }: `ok` true on exit 0, `out` is the
 * raw (untrimmed) stdout, `code` is the numeric exit code (0 on ok) or null on any non-exit failure (timeout, spawn
 * error, signal, worker error). Never rejects: a worker that errors or exits without answering resolves ok:false.
 */
export function gitExecOffLoop(cwd, args, timeoutMs) {
  const key = keyFor(cwd, args, timeoutMs);
  const hit = INFLIGHT.get(key);
  if (hit) return hit;
  const p = new Promise((resolve) => {
    gitSpawnStats.workerSpawns++;
    const w = new Worker(new URL("./git-spawn-worker.mjs", import.meta.url), {
      workerData: { cwd, args: args ?? [], timeoutMs: timeoutMs ?? 5000 },
    });
    let settled = false;
    const done = (m) => {
      if (settled) return;
      settled = true;
      resolve(m);
    };
    w.once("message", done);
    w.once("error", () => done({ ok: false, out: "", code: null }));
    w.once("exit", () => done({ ok: false, out: "", code: null }));
  }).finally(() => INFLIGHT.delete(key));
  INFLIGHT.set(key, p);
  return p;
}

/** Test seam: drop the in-flight map and reset the spawn counter. */
export function _resetGitSpawn() {
  INFLIGHT.clear();
  gitSpawnStats.workerSpawns = 0;
}
