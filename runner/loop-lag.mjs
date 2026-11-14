// Always-on event-loop lag + CPU burst monitor (cpu-profile-1114 fix 3). One tiny unref'd 100ms timer per process; a line is
// appended to ~/.vibesquad/logs/loop-lag.jsonl only when drift > 500ms (or a 30s CPU window is above 50% of a core), so the next
// "runner not responding (no answer in 15s)" can be pinned on the server or the runner. Shared by server/serve.mjs and runner/server.mjs.
import { appendFile, rename, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const LAG_TICK_MS = 100;
export const LAG_THRESHOLD_MS = 500;
export const CPU_WINDOW_MS = 30_000;
export const CPU_BURST_PCT = 50;
export const LAG_WINDOW_MS = 300_000;
export const LAG_LOG_MAX_BYTES = 5 * 1024 * 1024;

export function lagLogPath(env = process.env) {
  return path.join(env.VIBESQUAD_HOME || path.join(homedir(), '.vibesquad'), 'logs', 'loop-lag.jsonl');
}

/**
 * @param {{proc:string, file?:string, now?:()=>number, cpuUsage?:()=>{user:number,system:number}, heapUsed?:()=>number,
 *   append?:(file:string,line:string)=>Promise<void>, maxBytes?:number}} o
 * Returns { tick, cpuTick, stats, start, stop }. tick/cpuTick are exposed so tests drive a fake clock.
 */
export function createLoopLagMonitor({ proc, file = lagLogPath(), now = Date.now, cpuUsage = () => process.cpuUsage(), heapUsed = () => process.memoryUsage().heapUsed, append, maxBytes = LAG_LOG_MAX_BYTES } = {}) {
  let last = now();
  let lagMaxMs = 0;
  const events = []; // [ts, driftMs] over LAG_WINDOW_MS
  let lastCpu = cpuUsage();
  let lastCpuAt = last;
  let lastSampleCpu = lastCpu; // cpu at the previous lag tick, for the per-sample delta
  let dirReady = false;
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
    if (drift > LAG_THRESHOLD_MS) {
      lagMaxMs = Math.max(lagMaxMs, drift);
      events.push([t, drift]);
      prune(t);
      write({ ts: new Date(t).toISOString(), proc, driftMs: Math.round(drift), heapUsed: heapUsed(), cpuUserMs: Math.round((cpu.user - lastSampleCpu.user) / 1000), cpuSystemMs: Math.round((cpu.system - lastSampleCpu.system) / 1000) });
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
  let timers = [];
  return {
    tick, cpuTick, stats,
    flush: () => writing,
    start() {
      if (timers.length) return this;
      timers = [setInterval(tick, LAG_TICK_MS), setInterval(cpuTick, CPU_WINDOW_MS)];
      for (const x of timers) x.unref?.();
      return this;
    },
    stop() { for (const x of timers) clearInterval(x); timers = []; },
  };
}

let shared = null;
/** Process-wide monitor, started once. */
export function startLoopLagMonitor(proc) { return (shared ??= createLoopLagMonitor({ proc }).start()); }
export function loopLagStats() { return shared ? shared.stats() : { lagMaxMs: 0, lagOver1sLast5m: 0 }; }
