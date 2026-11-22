// idea-545: on Windows every child_process.spawn blocks the calling thread for ~0.5-1s+ (CreateProcess + AV). The runner's
// periodic probes (background.mjs snapshotProcesses, reap.mjs runPs/runCmd: powershell CIM queries) did that on the main
// loop: loop-lag.jsonl 2026-11-22 03:25Z showed 89 stalls / 173 s from background.mjs alone. This runs the spawn and the wait
// in one persistent, unref'd worker thread (same shape as server/auth.mjs readInterfacesOffLoop), so the main loop only
// posts a message. Agent-process spawns (runner/spawn.mjs) are NOT routed here.
import { Worker } from 'node:worker_threads';

const WORKER_SRC = `const { parentPort } = require('node:worker_threads');
const { spawn } = require('node:child_process');
parentPort.on('message', ({ id, file, args, stdin, timeoutMs }) => {
  let out = '', done = false, timer = null;
  const finish = (msg) => { if (done) return; done = true; clearTimeout(timer); parentPort.postMessage({ id, ...msg }); };
  let child;
  try { child = spawn(file, args, { shell: false, windowsHide: true, stdio: [stdin === null || stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'] }); }
  catch (e) { return finish({ err: String(e && e.message || e) }); }
  timer = setTimeout(() => { try { child.kill(); } catch {} finish({ err: file + ' timed out' }); }, timeoutMs);
  child.stdout.on('data', (d) => { out += d; });
  child.on('error', (e) => finish({ err: String(e && e.message || e) }));
  child.on('close', (code) => (code === 0 ? finish({ out }) : finish({ err: file + ' exited ' + code })));
  if (stdin !== null && stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
});`;

let worker = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject }

function failAll(err) { for (const [id, p] of pending) { pending.delete(id); p.reject(err); } }

function getWorker() {
  if (worker) return worker;
  const w = worker = new Worker(WORKER_SRC, { eval: true });
  w.on('message', ({ id, out, err }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (!pending.size) w.unref();
    if (err !== undefined) p.reject(new Error(err)); else p.resolve(out);
  });
  const gone = (err) => { if (worker === w) worker = null; failAll(err instanceof Error ? err : new Error('spawn worker exited')); };
  w.on('error', gone);
  w.on('exit', () => gone(new Error('spawn worker exited')));
  w.unref(); // idle: never keeps the runner alive; ref'd only while a request is pending (and after the listeners: adding a 'message' listener re-refs the port)
  return w;
}

/** Runs `file args` (no shell, hidden window) in the worker thread; resolves to stdout on exit 0, rejects otherwise or on timeout. */
export function spawnCaptureOffLoop(file, args, { timeoutMs = 20_000, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try { const w = getWorker(); w.ref(); w.postMessage({ id, file, args, stdin, timeoutMs }); } catch (err) { pending.delete(id); reject(err); }
  });
}
