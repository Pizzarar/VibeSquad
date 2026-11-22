// Off-loop git exec (idea-560): on Windows each `git` child costs the server a synchronous CreateProcess on its event
// loop (~0.5-3s per spawn under AV; loop-lag.jsonl 11-22: agent-duties.ts unitBranchGit 44 stalls/45s max 2.7s,
// runGit 21/22s). `execFile("git", ...)` from a request/hook path therefore blocks the loop even though it is "async".
// This runs the same child in ONE persistent, unref'd worker thread (same shape as runner/spawn-off-loop.mjs idea-545
// and server/auth.mjs readInterfacesOffLoop), so the CreateProcess happens off the loop.
//
// Why a mirror and not a shared module with runner/spawn-off-loop.mjs: the runner helper uses `spawn` with no cwd and
// REJECTS on non-zero exit, while this caller needs `execFile` with a cwd, non-rejecting { ok, out, code }, and a
// non-zero exit (merge-base --is-ancestor = 1) as a NORMAL, resolved answer. The worker-lifecycle machinery is copied
// from that module: one worker, ref'd only while a request is pending, a per-worker pending map so a dead worker's late
// 'exit' fails only its own requests, and a main-thread guard timer that settles + terminates a wedged worker.
// idea-572: the same worker also runs non-git children via execOffLoop (providers-catalog merged-units git log, restart-request
// `vs send`/`vs log` calls: loop-lag 11-22 08:23-09:38Z, 34 + 15 stalls on their CreateProcess).
import { Worker } from "node:worker_threads";
import path from "node:path";

const WORKER_SRC = `const { parentPort } = require('node:worker_threads');
const { execFile } = require('node:child_process');
parentPort.on('message', ({ id, file, cwd, args, env, timeoutMs, maxBuffer }) => {
  try {
    const opts = { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true };
    if (env) opts.env = env;
    if (maxBuffer) opts.maxBuffer = maxBuffer;
    execFile(file, args, opts, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      parentPort.postMessage({ id, ok: !err, out: String(stdout ?? ''), err: String(stderr ?? ''), code, msg: err ? String(err.message ?? err).slice(0, 300) : '' });
    });
  } catch (e) {
    parentPort.postMessage({ id, ok: false, out: '', err: '', code: null, msg: String(e?.message ?? e).slice(0, 300) });
  }
});`;

let worker = null;
let nextId = 1;
const pending = new Map(); // id -> { w, resolve, guard }
const GUARD_SLACK_MS = 5_000; // the worker's own execFile timer can't fire if its thread is wedged in a sync CreateProcess

/** Worker spawn counter for tests and diagnostics: how many worker threads this module started. */
export const gitSpawnStats = { workerSpawns: 0, dispatches: 0 }; // dispatches: git children actually posted to the worker (a deduped call adds none)

/** A failed call's answer: never a wrong guess, always "ask git again / keep / null" in the callers' terms. */
const FAILED = { ok: false, out: "", err: "", code: null, msg: "off-loop worker failed" };

function settle(id, value) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.guard);
  if (!pending.size) p.w.unref();
  p.resolve(value);
  return true;
}

// Fails only the requests that belong to this worker (a dead worker's late 'exit' must not touch its replacement's).
function failWorker(w) {
  if (worker === w) worker = null;
  for (const [id, p] of [...pending]) if (p.w === w) settle(id, FAILED);
}

function getWorker() {
  if (worker) return worker;
  const w = (worker = new Worker(WORKER_SRC, { eval: true }));
  gitSpawnStats.workerSpawns++;
  w.on("message", (m) => settle(m.id, { ok: m.ok, out: m.out, err: m.err, code: m.code, msg: m.msg }));
  w.on("error", () => failWorker(w));
  w.on("exit", () => failWorker(w));
  w.unref(); // idle: never keeps the server alive; ref'd only while a request is pending (after the listeners: 'message' re-refs)
  return w;
}

/** Same resolved-cwd + argv + timeout => one in-flight child. */
function keyFor(cwd, args, timeoutMs, maxBuffer) {
  return `${path.resolve(cwd).toLowerCase()}\u0000${(args ?? []).join("\u0000")}\u0000${timeoutMs ?? 5000}\u0000${maxBuffer ?? ""}`;
}

const INFLIGHT = new Map();

/**
 * idea-572: run any `file args` child in the same worker thread (no shell, no dedupe: callers like `vs send` are not
 * idempotent). Resolves { ok, out, err, code, msg }: `out`/`err` are the raw stdout/stderr, `code` the numeric exit code (0 on
 * ok) or null on a non-exit failure (timeout, spawn error, signal, wedged worker), `msg` the error text. Never rejects.
 * `env` omitted = the worker's own env (the server's at worker start).
 */
export function execOffLoop(file, args, { cwd, env, timeoutMs = 5000, maxBuffer } = {}) {
  return new Promise((resolve) => {
    const id = nextId++;
    let w;
    try {
      w = getWorker();
      const guard = setTimeout(() => {
        // Wedged worker (e.g. stuck in a sync CreateProcess): fail this call, fail the worker's other calls, replace it.
        settle(id, FAILED);
        failWorker(w);
        w.terminate().catch(() => {});
      }, timeoutMs + GUARD_SLACK_MS);
      guard.unref?.();
      pending.set(id, { w, resolve, guard });
      w.ref();
      gitSpawnStats.dispatches++;
      w.postMessage({ id, file, cwd, args: args ?? [], env: env ?? null, timeoutMs, maxBuffer: maxBuffer ?? null });
    } catch {
      // Synchronous constructor/postMessage failure: still resolve (never reject).
      if (!settle(id, FAILED)) resolve(FAILED);
    }
  });
}

/**
 * Run `git --no-optional-locks <args>` in the worker thread. Resolves { ok, out, code }: `ok` true on exit 0, `out` is the
 * raw (untrimmed) stdout, `code` is the numeric exit code (0 on ok) or null on any non-exit failure (timeout, spawn
 * error, signal, wedged worker). Never rejects: a worker that errors, exits, or is terminated resolves ok:false.
 * `maxBuffer` (optional) raises execFile's 1 MiB stdout cap for big `git log` reads (idea-572).
 */
export function gitExecOffLoop(cwd, args, timeoutMs, { maxBuffer } = {}) {
  const key = keyFor(cwd, args, timeoutMs, maxBuffer);
  const hit = INFLIGHT.get(key);
  if (hit) return hit;
  const p = execOffLoop("git", ["--no-optional-locks", ...(args ?? [])], { cwd, timeoutMs: timeoutMs ?? 5000, maxBuffer })
    .then((r) => ({ ok: r.ok, out: r.out, code: r.code }))
    .finally(() => {
      if (INFLIGHT.get(key) === p) INFLIGHT.delete(key);
    });
  INFLIGHT.set(key, p);
  return p;
}

/** Test seam: drop the in-flight map, reset the counter, and terminate the idle worker. */
export function _resetGitSpawn() {
  INFLIGHT.clear();
  gitSpawnStats.workerSpawns = 0;
  gitSpawnStats.dispatches = 0;
  const w = worker;
  worker = null;
  if (w) w.terminate().catch(() => {});
}
