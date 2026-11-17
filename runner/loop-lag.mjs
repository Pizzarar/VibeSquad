// Always-on event-loop lag + CPU burst monitor (cpu-profile-1114 fix 3). One tiny unref'd 100ms timer per process; a line is
// appended to ~/.vibesquad/logs/loop-lag.jsonl only when drift > 500ms (or a 30s CPU window is above 50% of a core), so the next
// "runner not responding (no answer in 15s)" can be pinned on the server or the runner. Shared by server/serve.mjs and runner/server.mjs.
import { appendFile, rename, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { PerformanceObserver } from 'node:perf_hooks';
import { Session, url as inspectorUrl } from 'node:inspector';
import { fileURLToPath } from 'node:url';

export const LAG_TICK_MS = 100;
export const LAG_THRESHOLD_MS = 500;
export const CPU_WINDOW_MS = 30_000;
export const CPU_BURST_PCT = 50;
export const LAG_WINDOW_MS = 300_000;
export const LAG_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const WATCHDOG_STALL_MS = 350; // heartbeat silent this long -> capture the main thread's stack
export const GC_MIN_MS = 20; // gc pauses shorter than this are not kept
export const GC_STANDALONE_MS = 100; // a single gc pause this long gets its own jsonl line
const MAX_FRAMES = 8;
const GRACE_MS = 150; // let the watchdog's message land before the stall line is written
const KINDS = { 1: 'scavenge', 2: 'minor-ms', 4: 'mark-sweep-compact', 8: 'incremental', 16: 'weak-cb', 31: 'all' };

// ---- watchdog worker (same file). Why a worker: the main thread cannot sample itself while blocked. The worker watches a
// SharedArrayBuffer heartbeat; when it goes silent it connects an inspector Session to the main thread, enables the Debugger and
// asks it to pause. The pause lands inside blocking JS (busy loops, Atomics.wait) immediately, and right after a native sync call
// (execSync/readFileSync) returns, with that call's frame on top. The Debugger domain is on only for the few ms of a capture, so
// idle cost is one 150ms Atomics.load. Always resumes + disables (fails safe: Debugger.disable releases a stuck pause).
// At most one capture per stall (capturedAt): a stall keeps the heartbeat silent until it ends, so without the gate every 150ms
// poll would start another pause. Never captures while an inspector is open (hb[1], published by the main thread because
// inspector.url() is undefined in a worker): V8 pause state is per-isolate, so our resume would unpause a user's breakpoint.
function shortUrl(u) { return String(u || '').replace('file:///', '').split(/[\\/]/).slice(-2).join('/'); }
function runWatchdog() {
  const hb = new Int32Array(workerData.sab);
  let lastV = Atomics.load(hb, 0), lastAt = Date.now(), cap = null, capturedAt = null;
  const capture = (startedAt) => {
    const session = new Session();
    let done = false, timer = null;
    // Idempotent; the only place done is set, so resume + disable + disconnect always run exactly once, whichever path ends first.
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { session.post('Debugger.resume'); } catch {}
      try { session.post('Debugger.disable'); } catch {}
      try { session.disconnect(); } catch {}
      cap = null;
    };
    cap = session;
    try { session.connectToMainThread(); } catch { cap = null; return; }
    const urls = new Map(); // callFrame.url is empty for ESM; Debugger.enable replays scriptParsed for every loaded script
    session.on('Debugger.scriptParsed', (m) => { if (m.params.url) urls.set(m.params.scriptId, m.params.url); });
    session.on('Debugger.paused', (m) => {
      if (done) return;
      try {
        const frames = (m.params.callFrames || []).slice(0, MAX_FRAMES).map((fr) => `${fr.functionName || '(anon)'} ${shortUrl(fr.url || urls.get(fr.location.scriptId))}:${fr.location.lineNumber + 1}`);
        parentPort.postMessage({ stallStartedAt: startedAt, pausedAfterMs: Date.now() - startedAt, frames });
      } catch { /* attribution is best-effort */ } finally { finish(); }
    });
    timer = setTimeout(finish, 5000);
    timer.unref();
    try { session.post('Debugger.enable', () => { if (!done) session.post('Debugger.pause'); }); } catch { finish(); }
  };
  setInterval(() => {
    const v = Atomics.load(hb, 0), t = Date.now();
    if (v !== lastV) { lastV = v; lastAt = t; return; }
    if (t - lastAt > WATCHDOG_STALL_MS && !cap && capturedAt !== lastAt && !Atomics.load(hb, 1)) { capturedAt = lastAt; capture(lastAt); }
  }, 150);
}
if (!isMainThread && workerData?.vsLoopLagWatchdog) runWatchdog();

export function lagLogPath(env = process.env) {
  return path.join(env.VIBESQUAD_HOME || path.join(homedir(), '.vibesquad'), 'logs', 'loop-lag.jsonl');
}

/**
 * @param {{proc:string, file?:string, now?:()=>number, cpuUsage?:()=>{user:number,system:number}, heapUsed?:()=>number,
 *   append?:(file:string,line:string)=>Promise<void>, maxBytes?:number, watchdog?:boolean, gcMinMs?:number, gcStandaloneMs?:number}} o
 * Returns { tick, cpuTick, stats, start, stop }. tick/cpuTick are exposed so tests drive a fake clock.
 */
export function createLoopLagMonitor({ watchdog = false, proc, file = lagLogPath(), now = Date.now, cpuUsage = () => process.cpuUsage(), heapUsed = () => process.memoryUsage().heapUsed, append, maxBytes = LAG_LOG_MAX_BYTES, gcMinMs = GC_MIN_MS, gcStandaloneMs = GC_STANDALONE_MS } = {}) {
  let last = now();
  let lagMaxMs = 0;
  const events = []; // [ts, driftMs] over LAG_WINDOW_MS
  let lastCpu = cpuUsage();
  let lastCpuAt = last;
  let lastSampleCpu = lastCpu; // cpu at the previous lag tick, for the per-sample delta
  let dirReady = false;
  const gcs = []; // [endTs, durMs, kind] pauses >= GC_MIN_MS, last 60s
  const attribs = []; // watchdog captures {stallStartedAt, pausedAfterMs, frames}
  let hb = null;
  let worker = null;
  let obs = null;
  const gcAfter = (t0, t1) => {
    const hit = gcs.filter(([ts]) => ts >= t0 && ts <= t1);
    if (!hit.length) return undefined;
    return { n: hit.length, totalMs: Math.round(hit.reduce((a, g) => a + g[1], 0)), maxMs: Math.round(Math.max(...hit.map((g) => g[1]))), kind: hit.sort((a, b) => b[1] - a[1])[0][2] };
  };
  let writing = Promise.resolve();
  const doAppend = append ?? (async (f, line) => {
    if (!dirReady) { mkdirSync(path.dirname(f), { recursive: true }); dirReady = true; }
    try { if ((await stat(f)).size > maxBytes) await rename(f, `${f}.1`); } catch { /* absent */ }
    await appendFile(f, line);
  });
  const write = (obj) => {
    const line = `${JSON.stringify(obj)}\n`;
    writing = writing.then(() => doAppend(file, line)).catch(() => {});
    return writing;
  };
  function prune(t) { while (events.length && events[0][0] < t - LAG_WINDOW_MS) events.shift(); }
  function tick() {
    const t = now();
    const drift = t - last - LAG_TICK_MS;
    last = t;
    const cpu = cpuUsage();
    if (hb) { Atomics.store(hb, 1, inspectorUrl() ? 1 : 0); Atomics.add(hb, 0, 1); } // [1]: inspector open -> watchdog stands down
    if (drift > LAG_THRESHOLD_MS) {
      lagMaxMs = Math.max(lagMaxMs, drift);
      events.push([t, drift]);
      prune(t);
      const rec = { ts: new Date(t).toISOString(), proc, driftMs: Math.round(drift), heapUsed: heapUsed(), cpuUserMs: Math.round((cpu.user - lastSampleCpu.user) / 1000), cpuSystemMs: Math.round((cpu.system - lastSampleCpu.system) / 1000) };
      const t0 = t - drift - LAG_TICK_MS;
      const fin = () => {
        const g = gcAfter(t0, t + 1);
        if (g) rec.gc = g;
        const a = attribs.find((x) => x.stallStartedAt >= t0 - 100 && x.stallStartedAt <= t);
        if (a) { rec.frames = a.frames; rec.pausedAfterMs = a.pausedAfterMs; }
        try { rec.res = resourceCounts(); } catch { /* optional */ }
        write(rec);
      };
      if (worker) setTimeout(fin, GRACE_MS).unref?.(); else fin();
    }
    lastSampleCpu = cpu;
  }
  function cpuTick() {
    const t = now();
    const cpu = cpuUsage();
    const wall = t - lastCpuAt;
    if (wall > 0) {
      const pct = ((cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000 / wall) * 100;
      if (pct > CPU_BURST_PCT) write({ ts: new Date(t).toISOString(), proc, cpuPct: Math.round(pct) });
    }
    lastCpu = cpu;
    lastCpuAt = t;
  }
  function stats() {
    const t = now();
    prune(t);
    return { lagMaxMs: Math.round(lagMaxMs), lagOver1sLast5m: events.filter(([, d]) => d > 1000).length };
  }
  function resourceCounts() {
    const c = {};
    for (const r of process.getActiveResourcesInfo()) c[r] = (c[r] || 0) + 1;
    return c;
  }
  function onGc(list) {
    for (const e of list.getEntries()) {
      if (e.duration < gcMinMs) continue;
      const kind = KINDS[e.detail?.kind ?? e.kind] || 'gc';
      const end = now();
      gcs.push([end, e.duration, kind]);
      while (gcs.length && gcs[0][0] < end - 60_000) gcs.shift();
      if (e.duration >= gcStandaloneMs) write({ ts: new Date(end).toISOString(), proc, gcMs: Math.round(e.duration), gcKind: kind, heapUsed: heapUsed() });
    }
  }
  function startWatchdog() {
    try {
      const sab = new SharedArrayBuffer(8);
      hb = new Int32Array(sab);
      worker = new Worker(fileURLToPath(import.meta.url), { workerData: { vsLoopLagWatchdog: true, sab }, resourceLimits: { maxOldGenerationSizeMb: 32 } });
      worker.unref();
      worker.on('message', (m) => { attribs.push(m); while (attribs.length > 20) attribs.shift(); });
      worker.on('error', () => { worker = null; hb = null; });
    } catch { worker = null; hb = null; }
  }
  let timers = [];
  return {
    tick, cpuTick, stats,
    flush: () => writing,
    start() {
      if (timers.length) return this;
      timers = [setInterval(tick, LAG_TICK_MS), setInterval(cpuTick, CPU_WINDOW_MS)];
      for (const x of timers) x.unref?.();
      try { obs = new PerformanceObserver(onGc); obs.observe({ entryTypes: ['gc'] }); } catch { obs = null; }
      if (watchdog) startWatchdog();
      return this;
    },
    stop() { for (const x of timers) clearInterval(x); timers = []; obs?.disconnect(); obs = null; worker?.terminate(); worker = null; hb = null; },
    onGc,
    captures: () => attribs.slice(), // watchdog captures received so far (tests, diagnostics)
  };
}

let shared = null;
/** Process-wide monitor, started once. */
export function startLoopLagMonitor(proc) { return (shared ??= createLoopLagMonitor({ proc, watchdog: process.env.VS_LOOP_LAG_WATCHDOG !== '0' }).start()); }
export function loopLagStats() { return shared ? shared.stats() : { lagMaxMs: 0, lagOver1sLast5m: 0 }; }
