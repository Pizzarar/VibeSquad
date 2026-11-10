#!/usr/bin/env node
// Detached, one-shot restart of the VS runner + VS server (idea-78). Every agent, the Overlord included, runs ON the
// runner, so whoever stops it cuts their own turn. This script has no repo imports (Node built-ins only) and is meant to
// be started detached (`vs restart`, or `Start-Process -WindowStyle Hidden node scripts/restart-runtime.mjs`), so it
// outlives both processes and finishes the job alone.
//
//   node scripts/restart-runtime.mjs [--dry-run] [--wait-timeout <sec=600>] [--stop-timeout <sec=30>] [--no-wait]
//        [--no-force] [--no-resume] [--resume-all-lost] [--port <4180>] [--home <runner home>] [--runtime-dir <dir>] [--node <exe>]
//        [--config-dir <desktop config dir>] [--out-dir <result dir>] [--log <file>] [--vs-home <dir>]
//
// Steps (each logged with a timestamp, all recorded in ~/.vibesquad/restart-<ts>.json):
//   lock -> detect -> marker (server.restarting, refreshed) -> wait runner running:0 -> stop runner -> stop server -> start server
//   (it boots the runner; fallback: start the runner directly) -> verify -> resume lost agents -> clear marker -> result file.
// Stop order: runner (POST /shutdown, token-authed, keeps agents resumable), then the server (Windows: taskkill /T /F, since
// serve.mjs has no state to flush and a plain taskkill never stops headless node.exe; POSIX: SIGTERM then SIGKILL after
// --stop-timeout), then a sweep for a runner the server's supervisor respawned in the gap. Runner force-kill only after
// --stop-timeout or when the runner predates /shutdown; never with --no-force.
// Reuses: runner /health `running`, runner.json + token discovery, the desktop `server.restarting` marker
// (src-tauri restart_marker_fresh: valid 120s, so refreshed every 30s) and server.pid, the desktop's server launch
// (spawn_server_process: node server/serve.mjs, cwd = runtime dir, VIBESQUAD_RUNTIME_DIR/BUNDLED_NODE/PORT/START_RUNNER).
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv) {
  const o = { dryRun: false, wait: true, force: true, resume: true, waitTimeoutSec: 600, stopTimeoutSec: 30 };
  const val = (i) => { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-wait') o.wait = false;
    else if (a === '--no-force') o.force = false;
    else if (a === '--no-resume') o.resume = false;
    else if (a === '--resume-all-lost') o.resumeAllLost = true;
    else if (a === '--wait-timeout') o.waitTimeoutSec = Number(val(i++));
    else if (a === '--stop-timeout') o.stopTimeoutSec = Number(val(i++));
    else if (a === '--port') o.port = Number(val(i++));
    else if (a === '--home') o.home = val(i++);
    else if (a === '--runtime-dir') o.runtimeDir = val(i++);
    else if (a === '--node') o.node = val(i++);
    else if (a === '--config-dir') o.configDir = val(i++);
    else if (a === '--out-dir') o.outDir = val(i++);
    else if (a === '--log') o.log = val(i++);
    else if (a === '--vs-home') o.vsHome = val(i++);
    else throw new Error(`unknown flag ${a}`);
  }
  for (const k of ['waitTimeoutSec', 'stopTimeoutSec']) if (!Number.isFinite(o[k]) || o[k] < 0) throw new Error(`bad ${k}`);
  return o;
}

export function vsHome(env = process.env) { return env.VIBESQUAD_HOME || path.join(os.homedir(), '.vibesquad'); }
/** Same rule as src-tauri config_dir(). */
export function desktopConfigDir(env = process.env) {
  if (env.VIBESQUAD_DESKTOP_CONFIG_DIR?.trim()) return env.VIBESQUAD_DESKTOP_CONFIG_DIR.trim();
  if (env.LOCALAPPDATA?.trim()) return path.join(env.LOCALAPPDATA, 'com.vibesquad.desktop');
  if (env.APPDATA?.trim()) return path.join(env.APPDATA, 'com.vibesquad.desktop');
  return path.join(os.homedir(), '.config', 'com.vibesquad.desktop');
}

// ---- process helpers (injectable through deps) ---------------------------------------------------------------------
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** { pid, ppid, cmd } or null. */
export function procInfo(pid) {
  if (!pidAlive(pid)) return null;
  try {
    if (IS_WIN) {
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){"$($p.ParentProcessId)|$($p.CommandLine)"}`], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      const line = String(r.stdout ?? '').trim();
      if (!line) return { pid, ppid: null, cmd: '' };
      const i = line.indexOf('|');
      return { pid, ppid: Number(line.slice(0, i)) || null, cmd: line.slice(i + 1) };
    }
    const r = spawnSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    const m = /^\s*(\d+)\s+(.*)$/.exec(String(r.stdout ?? '').trim());
    return { pid, ppid: m ? Number(m[1]) : null, cmd: m?.[2] ?? '' };
  } catch { return { pid, ppid: null, cmd: '' }; }
}

/** Pid listening on a TCP port (the VS server), or null. */
export function listenerPid(port) {
  try {
    if (IS_WIN) {
      const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
        const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && Number(m[1]) === port) return Number(m[2]);
      }
      return null;
    }
    const r = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5000 });
    const n = Number(String(r.stdout ?? '').split(/\s+/)[0]);
    return n > 0 ? n : null;
  } catch { return null; }
}

/** Graceful: SIGTERM on POSIX; plain `taskkill /PID` (no /F) on Windows. */
export function termGracefully(pid) {
  if (IS_WIN) { spawnSync('taskkill', ['/PID', String(pid)], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); return; }
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
}
/** Last resort only. */
export function killHard(pid) {
  if (IS_WIN) { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); return; }
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
}

/** Starts a fully detached process whose stdio goes to a log file. Returns the pid. */
export function spawnDetached(cmd, args, { cwd, env, logFile }) {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  try {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true, shell: false });
    child.on('error', () => {});
    child.unref();
    return child.pid;
  } finally { closeSync(fd); }
}

/** GET (or POST) returning { status, body } over http, or https with a self-signed cert (the server's mux). */
export function httpCall(url, { method = 'GET', headers = {}, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers, rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { let body = s; try { body = s ? JSON.parse(s) : null; } catch { /* text */ } resolve({ status: res.statusCode, body }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

const defaultDeps = { sleep, now: () => Date.now(), pidAlive, procInfo, listenerPid, termGracefully, killHard, spawnDetached, httpCall, serverStopMode: IS_WIN ? 'tree-kill' : 'graceful' };

// ---- detection -----------------------------------------------------------------------------------------------------
function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

const looksLikeRuntime = (dir) => !!dir && existsSync(path.join(dir, 'server', 'serve.mjs'));

/** Everything the run needs, from the live system. Pure reads. */
export async function detect(opts, d = defaultDeps, env = process.env) {
  const home = opts.home ?? path.join(vsHome(env), 'runner');
  const port = opts.port ?? (Number(env.VIBESQUAD_PORT) || 4180);
  const configDir = opts.configDir ?? desktopConfigDir(env);
  const runner = await detectRunner(home, d);
  const spid = d.listenerPid(port);
  return finishDetect({ opts, d, env, home, port, configDir, runner, spid });
}

const isRunnerCmd = (cmd) => /runner[\\/]server\.mjs/.test(cmd ?? '');

/** The runner as discovery files + a live probe describe it right now (re-run before acting on it). */
export async function detectRunner(home, d = defaultDeps) {
  const disc = readJson(path.join(home, 'runner.json'));
  let token = null;
  try { token = readFileSync(path.join(home, 'token'), 'utf8').trim(); } catch { /* no runner token */ }
  const runner = { home, port: disc?.port ?? null, pid: disc?.pid ?? null, token, alive: false, health: null, parent: null, cmd: null };
  if (runner.pid) {
    const pi = d.procInfo(runner.pid);
    // A pid from runner.json may have been recycled by an unrelated process: alive only if its command line is the runner.
    runner.isRunner = isRunnerCmd(pi?.cmd);
    runner.alive = !!pi && runner.isRunner;
    runner.staleDiscovery = !!pi && !runner.isRunner;
    runner.parent = pi?.ppid ?? null;
    runner.cmd = pi?.cmd ?? null;
  }
  if (runner.alive && runner.port && token) {
    try {
      const h = await d.httpCall(`http://127.0.0.1:${runner.port}/health`, { headers: { authorization: `Bearer ${token}` }, timeoutMs: 3000 });
      if (h.status === 200) runner.health = h.body;
    } catch { /* unhealthy */ }
  }
  return runner;
}

async function finishDetect({ opts, d, env, home, port, configDir, runner, spid }) {
  const si = spid ? d.procInfo(spid) : null;
  const server = { port, pid: spid, cmd: si?.cmd ?? null, parent: si?.ppid ?? null, isServe: /serve\.mjs/.test(si?.cmd ?? ''), health: null };
  if (spid) {
    for (const scheme of ['http', 'https']) {
      try {
        const h = await d.httpCall(`${scheme}://127.0.0.1:${port}/api/health`, { timeoutMs: 3000 });
        if (h.status === 200) { server.health = { scheme, ...(typeof h.body === 'object' && h.body ? h.body : {}) }; break; }
      } catch { /* try the next scheme */ }
    }
  }
  // Launch plan: flags > the live server's own node/runtime dir > the installed runtime > this checkout.
  let nodeExe = opts.node ?? null;
  let runtimeDir = opts.runtimeDir ?? null;
  let launchSource = opts.runtimeDir ? 'flag' : null;
  if (!runtimeDir) {
    const exe = /^"([^"]+)"|^(\S+)/.exec(server.cmd ?? '');
    const liveExe = exe?.[1] ?? exe?.[2];
    if (liveExe && looksLikeRuntime(path.dirname(liveExe))) { runtimeDir = path.dirname(liveExe); nodeExe ??= liveExe; launchSource = 'live server'; }
  }
  if (!runtimeDir) {
    const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    for (const c of [path.join(local, 'com.vibesquad.desktop', 'runtime'), path.join(local, 'VibeSquad', 'runtime')]) {
      if (looksLikeRuntime(c)) { runtimeDir = c; launchSource = 'installed runtime'; break; }
    }
  }
  if (!runtimeDir) { runtimeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); launchSource = 'this checkout'; }
  if (!nodeExe) {
    const bundled = path.join(runtimeDir, IS_WIN ? 'node.exe' : 'node');
    nodeExe = existsSync(bundled) ? bundled : process.execPath;
  }
  const serverLaunch = {
    node: nodeExe, args: ['server/serve.mjs'], cwd: runtimeDir, source: launchSource,
    logFile: path.join(vsHome(env), `serve-${port}.log`),
    env: { VIBESQUAD_RUNTIME_DIR: runtimeDir, VIBESQUAD_BUNDLED_NODE: nodeExe, VIBESQUAD_PORT: String(port), VIBESQUAD_START_RUNNER: '1' },
  };
  const runnerLaunch = { node: nodeExe, args: [path.join(runtimeDir, 'runner', 'server.mjs'), '--home', home], cwd: runtimeDir, logFile: path.join(home, 'runner.log') };
  return { home, port, configDir, runner, server, serverLaunch, runnerLaunch, outDir: opts.outDir ?? vsHome(env) };
}

async function runnerCall(det, d, method, route, timeoutMs = 10000) {
  const { runner } = det;
  if (!runner.port || !runner.token) throw new Error('no runner discovery');
  return d.httpCall(`http://127.0.0.1:${runner.port}${route}`, { method, headers: { authorization: `Bearer ${runner.token}` }, timeoutMs });
}
const agentList = (body) => (Array.isArray(body) ? body : Array.isArray(body?.agents) ? body.agents : []);
const brief = (a) => ({ id: a.id, title: a.title ?? a.name ?? null, status: a.status });

// ---- the run -------------------------------------------------------------------------------------------------------
export async function restartRuntime(opts, deps = {}, env = process.env, log = (line) => console.log(line)) {
  const d = { ...defaultDeps, ...deps };
  const outDir = opts.outDir ?? vsHome(env);
  const configDir = opts.configDir ?? desktopConfigDir(env);
  const result = { startedAt: new Date(d.now()).toISOString(), dryRun: !!opts.dryRun, steps: [], cutAgents: [], resumedAgents: [], errors: [], oldHash: null, newHash: null, forced: [], ok: false };
  const step = (name, detail = {}) => {
    const rec = { step: name, at: new Date(d.now()).toISOString(), ...detail };
    result.steps.push(rec);
    log(`[${rec.at}] ${name}${Object.keys(detail).length ? ' ' + JSON.stringify(detail) : ''}`);
  };

  if (opts.dryRun) {
    const det = await detect(opts, d, env);
    let agents = [];
    if (det.runner.health) { try { agents = agentList((await runnerCall(det, d, 'GET', '/agents?full=1')).body); } catch { /* listed below as unknown */ } }
    result.plan = {
      detected: {
        runner: { pid: det.runner.pid, alive: det.runner.alive, port: det.runner.port, parentPid: det.runner.parent, cmd: det.runner.cmd, health: det.runner.health, hasToken: !!det.runner.token },
        server: { pid: det.server.pid, port: det.server.port, cmd: det.server.cmd, isServe: det.server.isServe, parentPid: det.server.parent, health: det.server.health },
        runningAgents: agents.filter((a) => a.status === 'running').map(brief),
        lostAgents: agents.filter((a) => a.status === 'lost').map(brief),
        markerFile: path.join(det.configDir, 'server.restarting'),
      },
      steps: [
        `touch ${path.join(det.configDir, 'server.restarting')} (refreshed every 30s)`,
        opts.wait ? `wait for runner /health running:0 (timeout ${opts.waitTimeoutSec}s, then proceed and record cut agents)` : 'skip waiting (--no-wait)',
        det.runner.alive ? `stop runner pid ${det.runner.pid} via POST /shutdown (token-authed, keeps agents resumable: no exit events), force after ${opts.stopTimeoutSec}s${opts.force ? '' : ' (disabled: --no-force)'}` : 'runner not running: nothing to stop',
        det.server.pid ? (det.server.isServe ? `stop server pid ${det.server.pid}: ${d.serverStopMode === 'tree-kill' ? 'taskkill /T /F (serve.mjs has no state to flush)' : `SIGTERM, force after ${opts.stopTimeoutSec}s`}; then sweep any runner it respawned` : `REFUSE: pid ${det.server.pid} on port ${det.server.port} is not a serve.mjs process`) : `server not running on port ${det.server.port}: nothing to stop`,
        `start server: ${det.serverLaunch.node} ${det.serverLaunch.args.join(' ')} (cwd ${det.serverLaunch.cwd}, from ${det.serverLaunch.source}, log ${det.serverLaunch.logFile}); it boots the runner`,
        `fallback if the runner is not up after 45s: ${det.runnerLaunch.node} ${det.runnerLaunch.args.join(' ')}`,
        'verify: runner /health hash, GET /agents?full=1, server /api/health',
        opts.resume ? 'POST /agents/:id/resume for every agent that is status=lost after the restart but was not lost before it (--resume-all-lost: every lost agent)' : 'skip resume (--no-resume)',
        `clear marker, write ${path.join(det.outDir, 'restart-<ts>.json')}`,
      ],
      launch: { server: det.serverLaunch, runner: det.runnerLaunch },
    };
    result.ok = true;
    return result;
  }

  // Idempotence: one restart at a time. A second run while the first is alive exits; a dead holder's lock is taken over.
  mkdirSync(outDir, { recursive: true });
  const lockFile = path.join(outDir, 'restart-runtime.lock');
  const takeLock = () => {
    try { writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: d.now() }), { flag: 'wx' }); return true; } catch { return false; }
  };
  if (!takeLock()) {
    const holder = readJson(lockFile);
    if (holder && d.pidAlive(holder.pid) && holder.pid !== process.pid && d.now() - holder.at < 45 * 60000) {
      step('abort', { reason: `another restart is running (pid ${holder.pid})` });
      result.errors.push('already running');
      result.alreadyRunning = true;
      return result;
    }
    rmSync(lockFile, { force: true });
    if (!takeLock()) { result.errors.push('could not take restart lock'); return result; }
  }
  const markerFile = path.join(configDir, 'server.restarting');
  const touchMarker = () => {
    try { mkdirSync(configDir, { recursive: true }); if (existsSync(markerFile)) utimesSync(markerFile, new Date(), new Date()); else writeFileSync(markerFile, String(process.pid)); } catch (e) { result.errors.push(`marker: ${e.message}`); }
  };
  let markerTimer = null;
  const fail = (what, e) => { result.errors.push(`${what}: ${e?.message ?? e}`); step('error', { what, error: String(e?.message ?? e) }); };

  let det;
  try {
    // Detection happens under the lock: a concurrent run can no longer change what we read.
    det = await detect(opts, d, env);
    result.oldHash = det.runner.health?.hash ?? null;
    // 1. marker
    touchMarker();
    markerTimer = setInterval(touchMarker, 30000);
    markerTimer.unref?.();
    step('marker touched', { file: markerFile });

    // 2. wait for the runner to go idle
    if (det.runner.health && opts.wait) {
      const deadline = d.now() + opts.waitTimeoutSec * 1000;
      let running = det.runner.health.running;
      step('waiting for runner idle', { running, timeoutSec: opts.waitTimeoutSec });
      while (running !== 0 && d.now() < deadline) {
        await d.sleep(2000);
        try { running = (await runnerCall(det, d, 'GET', '/health', 5000)).body?.running ?? running; } catch { running = 0; break; } // runner died on its own
      }
      if (running !== 0) {
        try { result.cutAgents = agentList((await runnerCall(det, d, 'GET', '/agents?full=1')).body).filter((a) => a.status === 'running').map(brief); } catch (e) { fail('list cut agents', e); }
        step('wait timed out, proceeding', { running, cutAgents: result.cutAgents });
      } else step('runner idle');
    } else step('wait skipped', { reason: det.runner.health ? 'no-wait' : 'runner not healthy' });

    // Re-detect right before acting: the wait can take minutes, and the runner may have restarted (new pid/port/token) meanwhile.
    det.runner = await detectRunner(det.home, d);
    // Preflight: refuse before anything is stopped if the server port belongs to something that is not serve.mjs.
    const pre = d.listenerPid(det.port);
    if (pre) {
      const pi = d.procInfo(pre);
      if (!pi || !/serve\.mjs/.test(pi.cmd ?? '')) { fail('server stop', `pid ${pre} on port ${det.port} is not serve.mjs; refusing to touch it`); throw new Error('abort'); }
    }

    // Snapshot right before the stop: which agents were already lost (historic; the roster holds hundreds) and which were mid-turn.
    let lostBefore = null;
    if (det.runner.health) {
      try {
        const before = agentList((await runnerCall(det, d, 'GET', '/agents?full=1', 30000)).body);
        lostBefore = new Set(before.filter((a) => a.status === 'lost').map((a) => a.id));
        result.runningAtStop = before.filter((a) => a.status === 'running').map(brief);
        step('snapshot before stop', { running: result.runningAtStop.length, alreadyLost: lostBefore.size });
      } catch (e) { fail('snapshot', e); }
    }

    // 3. stop the runner (keep-resumable: no exit events, so step 7 can resume the agents it cut)
    const stopProc = async (label, pid, graceful) => {
      await graceful();
      const end = d.now() + opts.stopTimeoutSec * 1000;
      while (d.pidAlive(pid) && d.now() < end) await d.sleep(250);
      if (!d.pidAlive(pid)) { step(`${label} stopped gracefully`, { pid }); return true; }
      if (!opts.force) { fail(`${label} stop`, `pid ${pid} still alive after ${opts.stopTimeoutSec}s and --no-force`); return false; }
      d.killHard(pid);
      result.forced.push({ label, pid, reason: 'graceful stop timed out' });
      await d.sleep(500);
      step(`${label} force-killed`, { pid, alive: d.pidAlive(pid) });
      return !d.pidAlive(pid);
    };
    const clearRunnerFiles = (pid) => {
      for (const f of ['runner.json', 'runner.lock']) {
        const info = readJson(path.join(det.home, f));
        if (info && info.pid === pid) rmSync(path.join(det.home, f), { force: true }); // only that dead runner's files
      }
    };
    const stopRunner = async () => {
      const r0 = det.runner;
      if (!r0.alive) { step('runner not running', r0.staleDiscovery ? { note: `runner.json names pid ${r0.pid}, which is not a runner (recycled); left alone` } : {}); return true; }
      let accepted = false;
      try {
        const r = await runnerCall(det, d, 'POST', '/shutdown');
        accepted = r.status === 202;
        if (!accepted) step('runner /shutdown unavailable', { status: r.status, note: r.status === 404 ? 'runner predates /shutdown' : undefined });
      } catch (e) { step('runner /shutdown failed', { error: e.message }); }
      if (accepted) { if (!(await stopProc('runner', r0.pid, async () => {}))) return false; }
      else if (!opts.force) { fail('runner stop', 'no graceful stop available and --no-force'); return false; }
      else {
        // An old runner cannot be told to stop; a hard kill writes no exit events, so its agents stay resumable (lost).
        const again = d.procInfo(r0.pid); // re-verify immediately before the kill: the pid may have been recycled
        if (!again || !isRunnerCmd(again.cmd)) { fail('runner stop', `pid ${r0.pid} is no longer the runner; refusing to kill it`); return false; }
        d.killHard(r0.pid);
        result.forced.push({ label: 'runner', pid: r0.pid, reason: 'no /shutdown endpoint on this runner build' });
        await d.sleep(500);
        step('runner force-killed', { pid: r0.pid, alive: d.pidAlive(r0.pid) });
      }
      clearRunnerFiles(r0.pid);
      return true;
    };
    if (!(await stopRunner())) throw new Error('runner did not stop');

    // 4. stop the server. serve.mjs has no state to flush: its only exit hooks (onServerExit: terminals.mjs, workspace-scripts.mjs)
    // kill child processes, and a tree kill (/T /F) does exactly that; everything else it persists is written as it changes.
    // So no graceful step on Windows (a plain taskkill never works on headless node.exe); POSIX still gets SIGTERM first.
    // The runner went first, so the supervisor inside this server may have respawned one: swept below.
    const cur = d.listenerPid(det.port);
    if (!cur) step('server not running', { port: det.port });
    else {
      const info = d.procInfo(cur);
      if (!info || !/serve\.mjs/.test(info.cmd ?? '')) { fail('server stop', `pid ${cur} on port ${det.port} is not serve.mjs; refusing to touch it`); throw new Error('abort'); }
      if (d.serverStopMode === 'tree-kill') {
        const again = d.procInfo(cur); // re-verify immediately before the kill: the pid may have been reused
        if (!again || !/serve\.mjs/.test(again.cmd ?? '')) { fail('server stop', `pid ${cur} changed identity before the kill`); throw new Error('abort'); }
        d.killHard(cur);
        await d.sleep(500);
        result.serverStop = 'tree-kill';
        step('server tree-killed', { pid: cur, alive: d.pidAlive(cur) });
      } else if (!(await stopProc('server', cur, () => d.termGracefully(cur)))) throw new Error('server did not stop');
      if (d.pidAlive(cur)) { fail('server stop', `pid ${cur} still alive`); throw new Error('server did not stop'); }
    }
    // Sweep: a runner the old server respawned in the gap holds no work, but it must not outlive the restart (or block ours).
    const stray = await detectRunner(det.home, d);
    if (stray.alive && stray.pid !== det.runner.pid) {
      det.runner = stray;
      step('stray runner found after server stop', { pid: stray.pid });
      if (!(await stopRunner())) throw new Error('stray runner did not stop');
    }

    // 5. start the server (same launch as the desktop app); it boots the runner
    const healthy = async () => { for (const s of ['http', 'https']) { try { if ((await d.httpCall(`${s}://127.0.0.1:${det.port}/api/health`, { timeoutMs: 3000 })).status === 200) return true; } catch { /* next */ } } return false; };
    if (await healthy()) step('server already up, not starting another', { port: det.port });
    else {
      const sl = det.serverLaunch;
      const pid = d.spawnDetached(sl.node, sl.args, { cwd: sl.cwd, env: { ...env, ...sl.env }, logFile: sl.logFile });
      try { mkdirSync(det.configDir, { recursive: true }); writeFileSync(path.join(det.configDir, 'server.pid'), String(pid)); } catch { /* desktop pid file is best effort */ }
      step('server started', { pid, cwd: sl.cwd, log: sl.logFile });
    }
    const serverEnd = d.now() + 90000;
    while (!(await healthy()) && d.now() < serverEnd) await d.sleep(500);
    if (!(await healthy())) { fail('server start', 'not healthy after 90s'); throw new Error('server not healthy'); }
    step('server healthy');

    const fresh = async () => {
      const disc = readJson(path.join(det.home, 'runner.json'));
      let token = null;
      try { token = readFileSync(path.join(det.home, 'token'), 'utf8').trim(); } catch { /* not yet */ }
      if (!disc?.port || !token || disc.pid === det.runner.pid) return null;
      det.runner = { ...det.runner, port: disc.port, pid: disc.pid, token };
      try { const h = await runnerCall(det, d, 'GET', '/health', 3000); return h.status === 200 ? h.body : null; } catch { return null; }
    };
    let health = null;
    for (const end = d.now() + (opts.runnerBootMs ?? 45000); !health && d.now() < end;) { health = await fresh(); if (!health) await d.sleep(500); }
    if (!health) {
      const rl = det.runnerLaunch;
      const pid = d.spawnDetached(rl.node, rl.args, { cwd: rl.cwd, env: { ...env }, logFile: rl.logFile });
      step('runner not booted by the server, started directly', { pid });
      for (const end = d.now() + (opts.runnerBootMs ?? 45000); !health && d.now() < end;) { health = await fresh(); if (!health) await d.sleep(500); }
    }
    if (!health) { fail('runner start', 'no healthy runner after start'); throw new Error('runner not healthy'); }

    // 6. verify
    result.newHash = health.hash ?? null;
    const list = await runnerCall(det, d, 'GET', '/agents?full=1', 30000);
    const agents = agentList(list.body);
    step('verified', { runnerPid: health.pid, hash: result.newHash, hashChanged: result.oldHash ? result.oldHash !== result.newHash : null, agents: agents.length, serverHealthy: true });
    if (list.status !== 200) fail('verify', `GET /agents?full=1 -> ${list.status}`);

    // 7. resume lost agents
    if (opts.resume) {
      // Only agents the restart lost: resuming the whole historic lost roster would wake hundreds of dead sessions.
      const targets = agents.filter((x) => x.status === 'lost' && (opts.resumeAllLost || (lostBefore && !lostBefore.has(x.id))));
      if (!lostBefore && !opts.resumeAllLost) step('resume skipped', { reason: 'no pre-stop snapshot to tell restart-lost agents from old ones' });
      for (const a of targets) {
        try {
          const r = await runnerCall(det, d, 'POST', `/agents/${encodeURIComponent(a.id)}/resume`);
          result.resumedAgents.push({ ...brief(a), httpStatus: r.status, ok: r.status === 202 });
        } catch (e) { result.resumedAgents.push({ ...brief(a), ok: false, error: e.message }); }
      }
      step('resumed lost agents', { count: result.resumedAgents.length, failed: result.resumedAgents.filter((x) => !x.ok).length });
    }
    result.ok = result.errors.length === 0;
  } catch (e) {
    if (e.message !== 'abort' && !result.errors.length) fail('restart', e);
    result.ok = false;
  } finally {
    // 8. clear marker, release lock, write the result file
    if (markerTimer) clearInterval(markerTimer);
    rmSync(markerFile, { force: true });
    step('marker cleared');
    result.finishedAt = new Date(d.now()).toISOString();
    const file = path.join(outDir, `restart-${result.startedAt.replace(/[:.]/g, '-')}.json`);
    try { writeFileSync(file, JSON.stringify(result, null, 2)); result.resultFile = file; log(`result: ${file}`); } catch (e) { log(`could not write result: ${e.message}`); }
    const holder = readJson(lockFile);
    if (holder?.pid === process.pid) rmSync(lockFile, { force: true });
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`restart-runtime: ${e.message}`); process.exit(2); }
  if (opts.vsHome) process.env.VIBESQUAD_HOME = opts.vsHome; // `vs restart` runs us via WMI, which drops its env
  const log = (line) => { console.log(line); if (opts.log) { try { appendFileSync(opts.log, line + '\n'); } catch { /* console only */ } } };
  const r = await restartRuntime(opts, {}, process.env, log);
  if (r.dryRun) console.log(JSON.stringify(r.plan, null, 2));
  process.exit(r.ok ? 0 : r.alreadyRunning ? 3 : 1);
}
