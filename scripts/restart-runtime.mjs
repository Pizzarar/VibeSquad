#!/usr/bin/env node
// Detached, one-shot restart of the VS runner + VS server (idea-78). Every agent, the Overlord included, runs ON the
// runner, so whoever stops it cuts their own turn. Its static imports are Node built-ins only (the coordinated-drain helpers,
// server/restart-coord.mjs, load lazily on a deferral or after a success; a load failure only loses the lead names). It is meant to
// be started detached (`vs restart`, or `Start-Process -WindowStyle Hidden node scripts/restart-runtime.mjs`), so it
// outlives both processes and finishes the job alone.
//
//   node scripts/restart-runtime.mjs [--dry-run] [--wait-timeout <sec=600>] [--stop-timeout <sec=30>] [--boot-timeout <sec=120>] [--no-wait]
//        [--no-force] [--no-resume] [--resume-all-lost] [--resume-verify <sec=90>] [--kill-background] [--port <4180>]
//        [--home <runner home>] [--runtime-dir <dir>] [--node <exe>] [--config-dir <desktop config dir>] [--out-dir <result dir>]
//        [--log <file>] [--vs-home <dir>]
//
// Steps (each logged with a timestamp, all recorded in ~/.vibesquad/restart-<ts>.json):
//   lock -> detect -> marker (server.restarting, refreshed) -> drain (runner refuses new background work, TTL) ->
//   wait runner running:0 + held:0 -> stop runner -> stop server ->
//   start server (it boots the runner; a live runner.lock holder still booting is waited on up to RUNNER_BOOT_MAX_MS; fallback,
//   only with no live holder: start the runner directly) -> verify -> resume lost agents -> check each
//   resumed agent leaves `starting` (retry once, then mark it failed) -> clear drain (if that runner is still up) -> clear marker ->
//   result file.
// Background work (an idle agent whose park is held by a suite/build it left running: /health `held`) is never killed by
// default. If it outlasts --wait-timeout the restart is deferred (nothing stopped, exit 4) unless --kill-background.
// A deferral names each holder's lane lead (the `vs who lead` resolution) with a ready-to-send drain ask, in the result file
// and the log; `vs restart` then refuses for 30 min until every named lead logged restart-feedback 'drained restart'; the
// next successful restart logs restart-feedback 'restart-done' and sends it to every asked lead (docs/PLAN_COORDINATED_DRAIN.md).
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

export const BOOT_TIMEOUT_DEFAULT_SEC = 120;
// Restart drain (ideas 198 + 186): while the idle wait runs, the runner refuses NEW background work (runner POST /drain).
// TTL = wait timeout + stop timeout + this margin, capped at the runner's 2 h ceiling, so a restart that crashes before its
// finally never leaves the runner draining; the finally clears it on every path that keeps the old runner.
export const DRAIN_MARGIN_SEC = 120;
export const DRAIN_TTL_MAX_MS = 2 * 60 * 60 * 1000;
export function drainTtlMs(opts) {
  const sec = (Number(opts.waitTimeoutSec) || 0) + (Number(opts.stopTimeoutSec) || 0) + DRAIN_MARGIN_SEC;
  return Math.min(DRAIN_TTL_MAX_MS, Math.max(1000, Math.round(sec * 1000)));
}
// Blank, non-numeric or <= 0 env values fall back to the default (a 0ms wait would fail every slow start).
export function bootDefault(v) { const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) && n > 0 ? n : BOOT_TIMEOUT_DEFAULT_SEC; }

export function parseArgs(argv) {
  const o = { dryRun: false, wait: true, force: true, resume: true, killBackground: false, waitTimeoutSec: 600, stopTimeoutSec: 30, resumeVerifySec: 90, bootTimeoutSec: bootDefault(process.env.VS_RESTART_BOOT_TIMEOUT) };
  const val = (i) => { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-wait') o.wait = false;
    else if (a === '--no-force') o.force = false;
    else if (a === '--no-resume') o.resume = false;
    else if (a === '--resume-all-lost') o.resumeAllLost = true;
    else if (a === '--kill-background') o.killBackground = true;
    else if (a === '--resume-verify') o.resumeVerifySec = Number(val(i++));
    else if (a === '--wait-timeout') o.waitTimeoutSec = Number(val(i++));
    else if (a === '--boot-timeout') { const v = val(i++); o.bootTimeoutSec = v.trim() === '' ? NaN : Number(v); }
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
  for (const k of ['waitTimeoutSec', 'stopTimeoutSec', 'resumeVerifySec']) if (!Number.isFinite(o[k]) || o[k] < 0) throw new Error(`bad ${k}`);
  if (!Number.isFinite(o.bootTimeoutSec) || o.bootTimeoutSec <= 0) throw new Error('bad bootTimeoutSec');
  return o;
}

// X1b (docs/PLAN_X1_IDENTITY.md): the relaunched server and runner must never inherit the caller's agent identity. A lead
// running `vs restart` carries VS_AGENT_ID + VS_AGENT_TOKEN; a server started with them would call the runner as that lead.
export const AGENT_ENV_KEYS = ['VS_AGENT_ID', 'PASEO_AGENT_ID', 'VS_AGENT_TOKEN', 'VS_ROLE', 'VS_LANE', 'VS_TEAM', 'VS_ORD', 'VS_PROFILE']; // + the identity claims (R1 L1)
export function stripAgentEnv(env = process.env) {
  const out = { ...env };
  for (const k of AGENT_ENV_KEYS) delete out[k];
  return out;
}

/** Raw `reg query <key> /v Path` -> { type, value } or null. Injectable so tests never touch the registry. */
export function regQueryPath(key, name = 'Path') {
  const r = spawnSync('reg', ['query', key, '/v', name], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0 || !r.stdout) throw new Error(`reg query ${key} failed (${r.status ?? r.error?.message})`);
  const m = new RegExp(`^\\s*${name}\\s+(REG_EXPAND_SZ|REG_SZ)\\s+(.*?)\\s*$`, 'im').exec(r.stdout);
  if (!m) throw new Error(`reg query ${key}: no ${name} value`);
  return { type: m[1], value: m[2] };
}
const PATH_KEYS = ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'HKCU\\Environment'];
const GIT_KEYS = ['HKLM\\SOFTWARE\\GitForWindows', 'HKCU\\SOFTWARE\\GitForWindows', 'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows'];
const EMPTY_DROP_KEYS = ['HOME', 'SHELL'];
const pathNorm = (p) => p.trim().replace(/[\\/]+$/, '').toLowerCase();
const SYS_DIR_RE = /[\\/](system32|syswow64)([\\/]|$)/i;
/** `where git` (first hit) -> absolute git.exe path or ''. */
export function whereGit() {
  try { const r = spawnSync('where', ['git'], { windowsHide: true, encoding: 'utf8', timeout: 5000 }); return (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || ''; } catch { return ''; }
}
/** Git for Windows root (registry InstallPath, else derived from git.exe on PATH) that has bin\bash.exe or usr\bin\sh.exe; '' if none. Never throws. */
const unq = (s) => String(s ?? '').trim().replace(/^"+|"+$/g, '').trim(); // PATH entries / registry values may be quoted
/** Root for the known git.exe layouts only (<root>\cmd, <root>\bin, <root>\mingw64\bin); '' otherwise (e.g. a scoop shim). */
function gitRootFromExe(exe) {
  const w = path.win32; const dir = w.dirname(unq(exe));
  const leaf = w.basename(dir).toLowerCase();
  if (leaf === 'cmd' || leaf === 'bin') {
    const parent = w.dirname(dir);
    if (/^(mingw64|mingw32)$/i.test(w.basename(parent)) && leaf === 'bin') return w.dirname(parent);
    return parent;
  }
  return '';
}
/**
 * Git for Windows root (registry InstallPath, else derived from git.exe on PATH) that has bin\bash.exe or usr\bin\sh.exe;
 * '' if none. Never throws. regQuery/exists/which are explicit: a missing one means "unavailable", never the real thing.
 */
export function findGitRoot({ regQuery, exists, which, pathList = [] } = {}) {
  const ok = (r) => { try { return !!r && !!exists && (exists(path.win32.join(r, 'bin', 'bash.exe')) || exists(path.win32.join(r, 'usr', 'bin', 'sh.exe'))); } catch { return false; } };
  if (regQuery) for (const k of GIT_KEYS) { try { const r = unq(regQuery(k, 'InstallPath')?.value); if (ok(r)) return r; } catch { /* next */ } }
  const cands = [];
  try { const w = which?.(); if (w) cands.push(w); } catch { /* none */ }
  for (const e of pathList) { try { const g = path.win32.join(unq(e), 'git.exe'); if (exists?.(g)) cands.push(g); } catch { /* skip */ } }
  for (const g of cands) { const r = gitRootFromExe(g); if (ok(r)) return r; }
  return '';
}
/** Put <root>\bin and <root>\usr\bin ahead of the first System32/SysWOW64 entry (the WSL bash.exe stub lives there). */
export function insertGitBin(list, root) {
  const bins = [path.win32.join(root, 'bin'), path.win32.join(root, 'usr', 'bin')];
  const drop = new Set(bins.map(pathNorm));
  const rest = list.filter((e) => !drop.has(pathNorm(e)));
  let at = rest.findIndex((e) => SYS_DIR_RE.test(e));
  if (at < 0) at = rest.length;
  rest.splice(at, 0, ...bins);
  return rest;
}
/**
 * A runtime relaunched from an agent tool shell inherits a stripped env (no Git bin on PATH, HOME=''), and every restart
 * compounds it (idea-178). Win32: PATH = registry machine+user entries first, then inherited extras (dedupe, nothing
 * lost); empty HOME/SHELL removed; exactly one Path key. Never throws. Non-win32: unchanged.
 */
export function repairShellEnv(env = process.env, { regQuery, exists, which, platform = process.platform, log = () => {} } = {}) {
  if (platform !== 'win32') return env;
  const out = { ...env };
  for (const k of EMPTY_DROP_KEYS) if (out[k] === '') delete out[k];
  const pathKeys = Object.keys(out).filter((k) => k.toLowerCase() === 'path');
  const inherited = pathKeys.map((k) => out[k]).find((v) => v) || '';
  try {
    const reg = []; let lastErr = null; let got = 0;
    for (const key of PATH_KEYS) { // read independently: a missing HKCU Path must not discard HKLM (idea-179 L1)
      try {
        if (!regQuery) throw new Error('no registry reader');
        const { type, value } = regQuery(key);
        const v = type === 'REG_EXPAND_SZ' ? value.replace(/%([^%]+)%/g, (m, n) => { const hit = Object.keys(out).find((k) => k.toLowerCase() === n.toLowerCase()); return hit ? out[hit] : m; }) : value;
        reg.push(...v.split(';')); got++;
      } catch (e) { lastErr = e; }
    }
    if (!got) throw lastErr || new Error('no registry Path');
    const seen = new Set(); let list = [];
    for (const e of [...reg, ...inherited.split(';')]) {
      const q = unq(e);
      const n = pathNorm(q);
      if (!n || seen.has(n)) continue;
      seen.add(n); list.push(q);
    }
    try {
      const root = findGitRoot({ regQuery, exists, which, pathList: list });
      if (root) list = insertGitBin(list, root);
    } catch (e) { log(`env repair: git bin skipped (${e?.message || e})`); }
    for (const k of pathKeys) delete out[k];
    out.Path = list.join(';');
  } catch (e) {
    log(`env repair: registry PATH unavailable (${e?.message || e}); keeping inherited PATH`);
    if (pathKeys.length > 1) { for (const k of pathKeys) delete out[k]; out.Path = inherited; } // idea-179 L2: one Path key
  }
  return out;
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

/**
 * { pid, ppid, cmd } or null (the pid is gone). `cmd: ''` with `unknown: true` means the query failed (Get-CimInstance came
 * back empty or timed out under load, idea-148/328) or the OS would not show the command line: the caller must treat that
 * as UNKNOWN identity, never as "a different process". An empty answer is retried (attempts) before giving up.
 */
export function procInfo(pid, { run = spawnSync, alive = pidAlive, win = IS_WIN, attempts = 3 } = {}) {
  if (!alive(pid)) return null;
  for (let i = 0; i < attempts; i++) {
    let line = '';
    try {
      const r = win
        ? run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){"$($p.ParentProcessId)|$($p.CommandLine)"}`], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
        : run('ps', ['-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
      line = String(r?.stdout ?? '').trim();
    } catch { /* query failed: retried below */ }
    if (line) {
      let ppid = null; let cmd = '';
      if (win) { const j = line.indexOf('|'); ppid = Number(line.slice(0, j)) || null; cmd = j >= 0 ? line.slice(j + 1).trim() : ''; }
      else { const m = /^\s*(\d+)\s*(.*)$/.exec(line); ppid = m ? Number(m[1]) : null; cmd = m?.[2]?.trim() ?? ''; }
      // The process answered but its command line is hidden (another user / protected): a retry would not change that.
      return cmd ? { pid, ppid, cmd } : { pid, ppid, cmd: '', unknown: true };
    }
    if (!alive(pid)) return null; // exited while we asked
  }
  return { pid, ppid: null, cmd: '', unknown: true };
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
export function httpCall(url, { method = 'GET', headers = {}, timeoutMs = 5000, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers: body ? { 'content-type': 'application/json', ...headers } : headers, rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => { let body = s; try { body = s ? JSON.parse(s) : null; } catch { /* text */ } resolve({ status: res.statusCode, body }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(method === 'POST' ? (body ? JSON.stringify(body) : '{}') : undefined);
  });
}

const VS_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'vs.mjs');
/** One `vs` call as the owner's shell (agent identity stripped, X1b). Never throws: { ok } or { ok: false, error }. */
export function runVs(args, env = process.env) {
  const r = spawnSync(process.execPath, [VS_CLI, ...args], { env: stripAgentEnv(env), cwd: path.dirname(path.dirname(VS_CLI)), encoding: 'utf8', timeout: 60000, windowsHide: true });
  return r.status === 0 ? { ok: true } : { ok: false, error: String(r.error?.message || r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 300) };
}
const loadCoord = () => import('../server/restart-coord.mjs');
// runner.lock helpers (bootingHolder/readLock/RUNNER_BOOT_MAX_MS, idea-260), lazy like coord: the static imports stay Node built-ins.
const loadLock = () => import('../runner/lock.mjs');
const defaultDeps = { coord: loadCoord, lock: loadLock, runVs: (args, env = process.env) => runVs(args, env), regQuery: regQueryPath, exists: existsSync, which: whereGit, sleep, now: () => Date.now(), pidAlive, procInfo, listenerPid, termGracefully, killHard, spawnDetached, httpCall, serverStopMode: IS_WIN ? 'tree-kill' : 'graceful' };

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
    // A pid from runner.json may have been recycled by an unrelated process: alive only if it is the runner. Only a command
    // line that positively is something else counts as recycled; an unreadable one is confirmed through /health (idea-328).
    const id = await runnerIdentity(runner, d);
    runner.identity = id.state;
    runner.isRunner = id.state === 'runner';
    runner.alive = runner.isRunner;
    runner.staleDiscovery = id.state === 'recycled';
    runner.parent = id.pi?.ppid ?? null;
    runner.cmd = id.pi?.cmd ?? null;
    if (id.health) runner.health = id.health;
    if (id.state === 'unknown') { runner.portClosed = !!id.portClosed; runner.healthOutcomes = id.healthOutcomes ?? []; }
  }
  if (runner.alive && !runner.health) runner.health = (await probeRunnerHealth(runner, d)).body;
  return runner;
}

// idea-344 (2be31012 restart): with loop lag at lagMax 1981ms a single 3s /health window missed a live runner, which was
// then "treated as gone" and taken down by the server tree-kill with no graceful stop and no fold-index save. /health is now
// retried with growing timeouts and a backoff (worst case ~16s, spent only while it does not answer).
export const HEALTH_TIMEOUTS_MS = [3000, 5000, 5000];
/** First line a launched restart-runtime appends to its --log (cli/vs.mjs RESTART_STARTED_LINE mirrors it, idea-355). */
export const STARTED_LINE = 'restart-runtime started';
const HEALTH_BACKOFF_MS = [1000, 2000];

/**
 * The runner's token-checked /health, lag-tolerant: { body, outcomes, refused }. body is the 200 body or null (no discovery,
 * no token, never answered, never 200). refused: every try was ECONNREFUSED, i.e. nothing listens on the runner's port (a
 * lagging runner still accepts the connection and times out instead). A 401 is another token: retrying cannot help.
 */
async function probeRunnerHealth(runner, d, timeouts = HEALTH_TIMEOUTS_MS) {
  if (!runner.port || !runner.token) return { body: null, outcomes: ['no runner discovery'], refused: false };
  const outcomes = [];
  for (let i = 0; i < timeouts.length; i++) {
    if (i) await d.sleep(HEALTH_BACKOFF_MS[i - 1] ?? HEALTH_BACKOFF_MS.at(-1));
    try {
      const h = await d.httpCall(`http://127.0.0.1:${runner.port}/health`, { headers: { authorization: `Bearer ${runner.token}` }, timeoutMs: timeouts[i] });
      if (h.status === 200) return { body: h.body, outcomes, refused: false };
      outcomes.push(`status ${h.status}`);
      if (h.status === 401) break;
    } catch (e) { outcomes.push(e?.code === 'ECONNREFUSED' ? 'refused' : String(e?.code || e?.message || e)); }
  }
  return { body: null, outcomes, refused: outcomes.length > 0 && outcomes.every((o) => o === 'refused') };
}

/**
 * Is runner.pid the runner right now? { state, pi, health? }. state: 'runner' (its command line says so, or the line was
 * unreadable and the token-checked /health answers with exactly that pid; a body without a pid does not count), 'recycled' (a readable command line that is not the
 * runner: the only positive mismatch), 'gone' (no such process, also when it exits while /health is retried), 'unknown'
 * (alive, unreadable command line, and the lag-tolerant /health does not confirm: never killed by pid; portClosed says
 * whether anything listens on the runner's port at all; see stopUnconfirmed in restartRuntime, idea-344).
 */
async function runnerIdentity(runner, d) {
  const pi = d.procInfo(runner.pid);
  if (!pi) return { state: 'gone', pi: null };
  if (pi.cmd) return { state: isRunnerCmd(pi.cmd) ? 'runner' : 'recycled', pi };
  const probe = await probeRunnerHealth(runner, d);
  if (probe.body && probe.body.pid === runner.pid) return { state: 'runner', pi, health: probe.body, via: 'health' };
  if (!d.pidAlive(runner.pid)) return { state: 'gone', pi: null };
  return { state: 'unknown', pi, portClosed: probe.refused, healthOutcomes: probe.outcomes };
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

async function runnerCall(det, d, method, route, timeoutMs = 10000, body = null) {
  const { runner } = det;
  if (!runner.port || !runner.token) throw new Error('no runner discovery');
  return d.httpCall(`http://127.0.0.1:${runner.port}${route}`, { method, headers: { authorization: `Bearer ${runner.token}` }, timeoutMs, ...(body ? { body } : {}) });
}
const agentList = (body) => (Array.isArray(body) ? body : Array.isArray(body?.agents) ? body.agents : []);
const brief = (a) => ({ id: a.id, title: a.title ?? a.name ?? null, status: a.status });

/**
 * A 202 from /resume only means the job was accepted. Each resumed agent must leave `starting` within --resume-verify;
 * a stuck one is retried once (POST /unwedge {retry}), and one still stuck after that is stopped and logged as failed
 * (POST /unwedge: it then reads `lost`, visible in vs who / the roster, and a send can still resume it) instead of sitting in
 * "initializing" with a live slot until the next restart re-resumes it (idea-109).
 */
async function verifyResumed(det, d, opts, result, step, fail) {
  const ids = result.resumedAgents.filter((a) => a.ok).map((a) => a.id);
  if (!ids.length) return;
  const stuck = async (list) => {
    const out = [];
    for (const id of list) {
      try {
        const r = await runnerCall(det, d, 'GET', `/agents/${encodeURIComponent(id)}`, 5000);
        if (r.status === 200 && r.body?.status === 'starting') out.push(id);
      } catch { /* unreachable: not proven stuck */ }
    }
    return out;
  };
  const waitOut = async (list) => {
    const end = d.now() + opts.resumeVerifySec * 1000;
    let left = await stuck(list);
    while (left.length && d.now() < end) { await d.sleep(2000); left = await stuck(left); }
    return left;
  };
  const unwedge = async (id, body) => {
    try {
      const r = await runnerCall(det, d, 'POST', `/agents/${encodeURIComponent(id)}/unwedge`, 10000, body);
      return r.status === 200 ? (r.body?.action ?? null) : `http ${r.status}`; // 404: a runner build without /unwedge
    } catch (e) { return `error ${e.message}`; }
  };
  let left = await waitOut(ids);
  if (!left.length) { step('resumed agents started', { count: ids.length }); return; }
  const retried = [];
  for (const id of left) retried.push({ id, action: await unwedge(id, { retry: true }) });
  step('resume stuck in starting, retried once', { afterSec: opts.resumeVerifySec, retried });
  left = await waitOut(left);
  for (const id of left) result.resumeFailed.push({ id, action: await unwedge(id, { retry: false, reason: `still starting ${opts.resumeVerifySec}s after a restart resume and one retry` }) });
  if (result.resumeFailed.length) fail('resume verify', `${result.resumeFailed.length} agent(s) never left 'starting': ${result.resumeFailed.map((x) => x.id).join(', ')}`);
  else step('resumed agents started after retry', { count: retried.length });
}

/**
 * D3 done broadcast: after a successful restart, every lead asked to drain by the deferrals since the last successful
 * restart gets restart-feedback 'restart-done' in its lane log and a direct message, so it lifts the hold. Best effort:
 * a failed log/send is recorded in result.doneBroadcast, never turns a good restart into a failure.
 */
async function doneBroadcast(d, outDir, result, step) {
  try {
    const coord = await d.coord();
    const chain = coord.deferralChain(outDir, { now: d.now() });
    if (!chain?.leads.length) return;
    const text = coord.doneText(new Date(d.now()).toISOString());
    const lanes = new Map(chain.leads.map((l) => [`${l.team}/${l.lane}`, l]));
    const logged = [...lanes.values()].map((l) => ({ team: l.team, lane: l.lane, ...d.runVs(['log', 'restart-feedback', coord.DONE_TEXT, '--team', l.team, '--lane', l.lane]) }));
    const sent = chain.leads.map((l) => ({ leadId: l.leadId, lane: l.lane, ...d.runVs(['send', l.leadId, text]) }));
    result.doneBroadcast = { leads: chain.leads.map((l) => l.leadId), logged, sent };
    step('done broadcast', result.doneBroadcast);
  } catch (e) {
    result.doneBroadcast = { error: e.message };
    step('done broadcast failed', { error: e.message });
  }
}

/** `vs restart` runs us via WMI, which drops its env: restore what it passed as flags (VIBESQUAD_HOME, R2 L2 VIBESQUAD_PORT). */
export function applyLaunchEnv(opts, env = process.env) {
  if (opts.vsHome) env.VIBESQUAD_HOME = opts.vsHome;
  if (Number.isInteger(opts.port) && opts.port > 0) env.VIBESQUAD_PORT = String(opts.port);
  return env;
}

// ---- the run -------------------------------------------------------------------------------------------------------
export async function restartRuntime(opts, deps = {}, env = process.env, log = (line) => console.log(line)) {
  // R2 L2: D3's vs log/send run with restartRuntime's env (the WMI child's restored VIBESQUAD_HOME/PORT), not a bare process.env.
  const injectedRunVs = deps.runVs ?? defaultDeps.runVs;
  const d = { ...defaultDeps, ...deps, runVs: (args) => injectedRunVs(args, env) };
  opts = { resumeVerifySec: 90, ...opts };
  const outDir = opts.outDir ?? vsHome(env);
  const configDir = opts.configDir ?? desktopConfigDir(env);
  const result = { startedAt: new Date(d.now()).toISOString(), dryRun: !!opts.dryRun, steps: [], cutAgents: [], resumedAgents: [], resumeFailed: [], errors: [], oldHash: null, newHash: null, forced: [], ok: false };
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
        runner: { pid: det.runner.pid, alive: det.runner.alive, identity: det.runner.identity ?? null, port: det.runner.port, parentPid: det.runner.parent, cmd: det.runner.cmd, health: det.runner.health, hasToken: !!det.runner.token },
        server: { pid: det.server.pid, port: det.server.port, cmd: det.server.cmd, isServe: det.server.isServe, parentPid: det.server.parent, health: det.server.health },
        runningAgents: agents.filter((a) => a.status === 'running').map(brief),
        heldAgents: det.runner.health?.heldAgents ?? [],
        lostAgents: agents.filter((a) => a.status === 'lost').map(brief),
        markerFile: path.join(det.configDir, 'server.restarting'),
      },
      steps: [
        `touch ${path.join(det.configDir, 'server.restarting')} (refreshed every 30s)`,
        ...(opts.wait ? [`drain: runner POST /drain (ttl ${Math.round(drainTtlMs(opts) / 1000)}s): new background work is refused while waiting; cleared at the end`] : []),
        opts.wait ? `wait for runner /health running:0 and held:0 (timeout ${opts.waitTimeoutSec}s; then running turns are cut and recorded, and held background work ${opts.killBackground ? 'is killed (--kill-background)' : 'defers the restart (nothing stopped, exit 4)'})` : 'skip waiting (--no-wait)',
        det.runner.alive ? `stop runner pid ${det.runner.pid} via POST /shutdown (token-authed, keeps agents resumable: no exit events), force after ${opts.stopTimeoutSec}s${opts.force ? '' : ' (disabled: --no-force)'}` : det.runner.identity === 'unknown' && det.runner.pid ? `runner pid ${det.runner.pid} alive, identity unknown: stop only via token /shutdown (never killed by pid)` : 'runner not running: nothing to stop',
        det.server.pid ? (det.server.isServe ? `stop server pid ${det.server.pid}: ${d.serverStopMode === 'tree-kill' ? 'taskkill /T /F (serve.mjs has no state to flush)' : `SIGTERM, force after ${opts.stopTimeoutSec}s`}; then sweep any runner it respawned` : `REFUSE: pid ${det.server.pid} on port ${det.server.port} is not a serve.mjs process`) : `server not running on port ${det.server.port}: nothing to stop`,
        `start server: ${det.serverLaunch.node} ${det.serverLaunch.args.join(' ')} (cwd ${det.serverLaunch.cwd}, from ${det.serverLaunch.source}, log ${det.serverLaunch.logFile}); it boots the runner`,
        `fallback if the runner is not up after 45s: ${det.runnerLaunch.node} ${det.runnerLaunch.args.join(' ')}`,
        'verify: runner /health hash, GET /agents?full=1, server /api/health',
        opts.resume ? `POST /agents/:id/resume for every agent that is status=lost after the restart but was not lost before it (--resume-all-lost: every lost agent); each must leave 'starting' within ${opts.resumeVerifySec}s, else one retry, else it is stopped and logged as failed (reads lost)` : 'skip resume (--no-resume)',
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
  let drainOn = null; // { runner: { port, token } }: the runner this restart set a drain on (cleared in the finally)
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

    // 2. wait for the runner to go idle: no open turns and no idle agent holding background work (a held park). A runner
    // build without the `held` field reports none.
    if (det.runner.health && opts.wait) {
      // Drain first (ideas 198 + 186): from now on the runner refuses new background work machine-wide, so held work only
      // drains while we wait. A runner without /drain (404) or a failed call just waits as before: never a restart error.
      const ttlMs = drainTtlMs(opts);
      try {
        const r = await runnerCall(det, d, 'POST', '/drain', 5000, { ttlMs, reason: `vs restart pid ${process.pid}` });
        if (r.status === 200) {
          drainOn = { runner: { port: det.runner.port, token: det.runner.token } };
          step('drain set', { ttlSec: Math.round(ttlMs / 1000), until: r.body?.drain?.until ? new Date(r.body.drain.until).toISOString() : null });
        } else step('drain not set', { status: r.status, error: r.status === 404 ? 'runner predates /drain' : String(r.body?.error ?? '') });
      } catch (e) { step('drain not set', { error: e.message }); }
      const deadline = d.now() + opts.waitTimeoutSec * 1000;
      let running = det.runner.health.running;
      let heldAgents = det.runner.health.heldAgents ?? [];
      let held = det.runner.health.held ?? heldAgents.length;
      let heldWork = det.runner.health.heldWork ?? {};
      step('waiting for runner idle', { running, held, timeoutSec: opts.waitTimeoutSec });
      while ((running !== 0 || held > 0) && d.now() < deadline) {
        await d.sleep(2000);
        try {
          const h = (await runnerCall(det, d, 'GET', '/health', 5000)).body ?? {};
          running = h.running ?? running;
          heldAgents = h.heldAgents ?? [];
          held = h.held ?? heldAgents.length;
          heldWork = h.heldWork ?? {};
        } catch { running = 0; held = 0; break; } // runner died on its own
      }
      if (held > 0 && !opts.killBackground) {
        // Never kill a suite or build an agent left running (idea-88): defer, stop nothing, and say who holds it.
        // Coordinated drain (PLAN_COORDINATED_DRAIN D1): name each holder's lane lead and a ready-to-send drain ask. Timer
        // retries never drain anything; the holders' leads do (11-12: ~7 timed retries vs one coordinated round).
        let leads = [];
        let unresolved = [];
        let coord = null;
        try {
          coord = await d.coord();
          const agents = agentList((await runnerCall(det, d, 'GET', '/agents?full=1', 30000)).body);
          ({ leads, unresolved } = coord.holderLeads(heldAgents, agents));
        } catch (e) { unresolved = heldAgents.map((id) => ({ agentId: id, reason: `lead lookup failed: ${e.message}` })); }
        const at = new Date(d.now()).toISOString();
        leads = leads.map((l) => ({ ...l, heldWork: Object.fromEntries(l.heldAgents.filter((id) => heldWork[id]?.length).map((id) => [id, heldWork[id]])) })); // idea-230: what holds it, in the ask and the record
        leads = leads.map((l) => ({ ...l, ask: coord ? coord.drainAskText(l, at) : null }));
        result.deferred = { held, heldAgents, heldWork, running, leads, unresolved };
        step('deferred: background work still running', result.deferred);
        result.errors.push(coord ? coord.deferralMessage({ held, heldAgents, waitSec: opts.waitTimeoutSec, leads, unresolved, heldWork })
          : `deferred: ${held} agent(s) still hold background work after ${opts.waitTimeoutSec}s (${heldAgents.join(', ') || 'ids unknown'}); no lead resolved (${unresolved[0]?.reason ?? 'unknown'}): ask the holders' leads to drain, wait for each 'drained', then rerun vs restart. No timer retries; --kill-background needs the owner's per-run OK.`);
        for (const l of leads) log(`drain ask -> vs send ${l.leadId} "${l.ask}"`);
        for (const u of unresolved) log(`no lead resolved for ${u.agentId}: ${u.reason}`);
        throw new Error('abort');
      }
      if (running !== 0 || held > 0) {
        try { result.cutAgents = agentList((await runnerCall(det, d, 'GET', '/agents?full=1')).body).filter((a) => a.status === 'running').map(brief); } catch (e) { fail('list cut agents', e); }
        if (held > 0) result.killedBackground = heldAgents;
        step('wait timed out, proceeding', { running, cutAgents: result.cutAgents, ...(held > 0 ? { killedBackground: heldAgents } : {}) });
      } else step('runner idle');
    } else step('wait skipped', { reason: det.runner.health ? 'no-wait' : 'runner not healthy' });

    // Re-detect right before acting: the wait can take minutes, and the runner may have restarted (new pid/port/token) meanwhile.
    det.runner = await detectRunner(det.home, d);
    // Preflight: refuse before anything is stopped if the server port belongs to something that is not serve.mjs. An unreadable
    // command line (procInfo unknown, after its retries) also aborts here, before the runner is touched (idea-148).
    const notServeMsg = (pid, pi) => (pi?.unknown
      ? `pid ${pid} on port ${det.port}: command line could not be read (process query failed or timed out); refusing to touch it`
      : `pid ${pid} on port ${det.port} is not serve.mjs; refusing to touch it`);
    const pre = d.listenerPid(det.port);
    if (pre) {
      const pi = d.procInfo(pre);
      if (!pi || !/serve\.mjs/.test(pi.cmd ?? '')) { fail('server stop', notServeMsg(pre, pi)); throw new Error('abort'); }
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
    const notRunningNote = (r) => (r.staleDiscovery ? { note: `runner.json names pid ${r.pid}, which is not a runner (recycled); left alone` } : {});
    // idea-344: runner.json names a LIVE pid whose command line cannot be read and whose /health stayed silent through the
    // lag-tolerant retries. That used to be "treated as gone", and the server tree-kill then took a lagging runner down hard.
    // Safe path, never a kill by pid: (a) nothing listens on the runner's port -> it is not serving as the runner (a lagging
    // runner still accepts connections): left alone, with a loud note; (b) otherwise send the token-checked /shutdown (only
    // the runner holding that token can accept it, so it cannot hit a recycled pid) with a lag-tolerant timeout and wait for
    // the pid to exit; (c) not accepted and the pid still alive: abort before the server is touched (nothing stopped yet).
    // Aborting costs one retry later; going on would cost a hard kill with no graceful stop and no fold-index save.
    const stopUnconfirmed = async (r) => {
      const base = `runner.json names pid ${r.pid}: alive, command line unreadable, /health did not confirm it (${(r.healthOutcomes ?? []).join(', ') || 'no answer'})`;
      if (r.portClosed) { step('runner not running', { note: `${base}; nothing listens on runner port ${r.port}, so it is not serving as the runner; left alone (not killed)` }); return true; }
      let accepted = false; let why = '';
      try { const res = await runnerCall(det, d, 'POST', '/shutdown', 15000); accepted = res.status === 202; if (!accepted) why = `status ${res.status}`; } catch (e) { why = e.message; }
      if (accepted) {
        const end = d.now() + opts.stopTimeoutSec * 1000;
        while (d.pidAlive(r.pid) && d.now() < end) await d.sleep(250);
        if (!d.pidAlive(r.pid)) { step('runner stopped gracefully', { pid: r.pid, via: 'token /shutdown (identity unconfirmed)' }); clearRunnerFiles(r.pid); return true; }
        fail('runner stop', `${base}; it accepted /shutdown but is still alive after ${opts.stopTimeoutSec}s; refusing to kill an unconfirmed pid`);
        return false;
      }
      if (!d.pidAlive(r.pid)) { step('runner exited before stop', { pid: r.pid }); clearRunnerFiles(r.pid); return true; }
      fail('runner stop', `${base}; token /shutdown not accepted (${why}). Refusing to go on: stopping the server would take this runner down with no graceful stop and no fold-index save. Nothing was stopped; retry when loop lag drops, or stop the runner by hand (or delete runner.json if pid ${r.pid} is not the runner)`);
      return false;
    };
    const stopRunner = async (adopted = false) => {
      const r0 = det.runner;
      if (!r0.alive && r0.identity === 'unknown') return stopUnconfirmed(r0);
      if (!r0.alive) { step('runner not running', notRunningNote(r0)); return true; }
      let accepted = false;
      try {
        const r = await runnerCall(det, d, 'POST', '/shutdown');
        accepted = r.status === 202;
        if (!accepted) step('runner /shutdown unavailable', { status: r.status, note: r.status === 404 ? 'runner predates /shutdown' : undefined });
      } catch (e) { step('runner /shutdown failed', { error: e.message }); }
      if (!accepted && !adopted) {
        // idea-220: the server's runner supervisor (RR1, 'runner code changed') may have restarted the runner under us. A new
        // runner in runner.json is adopted and stopped instead; an old one that has simply exited is already stopped.
        const now = await detectRunner(det.home, d);
        if (now.alive && now.pid !== r0.pid) {
          step('runner replaced during restart, adopting', { oldPid: r0.pid, pid: now.pid });
          clearRunnerFiles(r0.pid);
          det.runner = now;
          return stopRunner(true);
        }
        if (!d.pidAlive(r0.pid)) { step('runner exited before stop', { pid: r0.pid }); clearRunnerFiles(r0.pid); return true; }
      }
      if (accepted) { if (!(await stopProc('runner', r0.pid, async () => {}))) return false; }
      else if (!opts.force) { fail('runner stop', 'no graceful stop available and --no-force'); return false; }
      else {
        // An old runner cannot be told to stop; a hard kill writes no exit events, so its agents stay resumable (lost).
        // Re-verify immediately before the kill: the pid may have been recycled. Only a confirmed runner is killed.
        const again = await runnerIdentity(r0, d);
        if (again.state !== 'runner') { fail('runner stop', again.state === 'unknown' ? `pid ${r0.pid} could not be confirmed as the runner (command line unreadable, /health silent); refusing to kill it` : `pid ${r0.pid} is no longer the runner; refusing to kill it`); return false; }
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
      if (!info || !/serve\.mjs/.test(info.cmd ?? '')) { fail('server stop', notServeMsg(cur, info)); throw new Error('abort'); }
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

    // Anything runner.json says now is stale (e.g. a stray killed by the server tree-kill): clear it, so that any runner.json
    // present after the start was written by the new runner. Pid inequality is not freshness (the OS can reuse a pid).
    rmSync(path.join(det.home, 'runner.json'), { force: true });
    // 5. start the server (same launch as the desktop app); it boots the runner
    const healthy = async () => { for (const s of ['http', 'https']) { try { if ((await d.httpCall(`${s}://127.0.0.1:${det.port}/api/health`, { timeoutMs: 3000 })).status === 200) return true; } catch { /* next */ } } return false; };
    let spawnedServerPid = null;
    if (await healthy()) step('server already up, not starting another', { port: det.port });
    else {
      const sl = det.serverLaunch;
      const pid = d.spawnDetached(sl.node, sl.args, { cwd: sl.cwd, env: { ...repairShellEnv(stripAgentEnv(env), { regQuery: d.regQuery, exists: d.exists, which: d.which, log }), ...sl.env }, logFile: sl.logFile }); // never as an agent (X1b)
      try { mkdirSync(det.configDir, { recursive: true }); writeFileSync(path.join(det.configDir, 'server.pid'), String(pid)); } catch { /* desktop pid file is best effort */ }
      spawnedServerPid = pid;
      step('server started', { pid, cwd: sl.cwd, log: sl.logFile });
    }
    // Post-start waits poll with backoff up to --boot-timeout (VS_RESTART_BOOT_TIMEOUT, default 120s): a slow boot (the runner resumes
    // the agents the restart cut; X1b waits 45s by design) is reported as "slow start (N s)", never failed. Fail only if the process
    // died or the deadline passed. Exit codes unchanged (any fail -> the same nonzero as before).
    const bootMs = opts.runnerBootMs ?? bootDefault(String(opts.bootTimeoutSec ?? '')) * 1000; // restartRuntime may be called without parseArgs: never NaN
    const slowNote = (label) => (el) => [`${label} slow start (${Math.round(el / 1000)} s)`, { seconds: Math.round(el / 1000) }];
    const bootWait = async (label, until, probe, isDead, note = slowNote(label)) => {
      const t0 = d.now(); let delay = 500; let nextNote = 15000;
      for (;;) {
        const h = await probe(); if (h) return h;
        if (isDead()) return 'died';
        const el = d.now() - t0;
        if (d.now() >= until) return null;
        if (el >= nextNote) { step(...note(el)); nextNote += 15000; }
        await d.sleep(delay); delay = Math.min(Math.round(delay * 1.5), 5000);
      }
    };
    const serverT0 = d.now();
    const serverBootMs = opts.serverBootMs ?? bootMs;
    // The spawned pid may be a launcher that hands off to the real server and exits: its exit alone is not death. Adopt whoever listens
    // on the port as the server pid (and rewrite server.pid). Before any listener was seen keep waiting (the handoff may still be booting)
    // until the deadline; once one was adopted, its death with no live listener left is real death (fail fast).
    let adoptedListener = false;
    const serverDead = () => {
      if (spawnedServerPid == null || d.now() - serverT0 <= 3000 || d.pidAlive(spawnedServerPid)) return false;
      const lp = d.listenerPid(det.port);
      if (lp != null && lp !== spawnedServerPid && d.pidAlive(lp)) {
        step('server launcher exited, tracking listener', { launcher: spawnedServerPid, pid: lp });
        spawnedServerPid = lp; adoptedListener = true;
        try { writeFileSync(path.join(det.configDir, 'server.pid'), String(lp)); } catch { /* best effort, as at spawn */ }
        return false;
      }
      return adoptedListener;
    };
    const sres = await bootWait('server', serverT0 + serverBootMs, async () => ((await healthy()) ? true : null), serverDead);
    if (sres !== true) { fail('server start', sres === 'died' ? `server process ${spawnedServerPid} died during start` : `not healthy after ${Math.round(serverBootMs / 1000)}s`); throw new Error('server not healthy'); }
    // A launcher that handed off and went healthy inside serverDead's 3s guard never got adopted: do it on success too (idea-217).
    if (spawnedServerPid != null && !adoptedListener) {
      const lp = d.listenerPid(det.port);
      if (lp != null && lp !== spawnedServerPid && d.pidAlive(lp)) {
        step('server launcher handed off, tracking listener', { launcher: spawnedServerPid, pid: lp });
        spawnedServerPid = lp; adoptedListener = true;
        try { writeFileSync(path.join(det.configDir, 'server.pid'), String(lp)); } catch { /* best effort, as at spawn */ }
      }
    }
    step('server healthy');

    let seenPid = null; let directPid = null; let directAt = 0;
    const fresh = async () => {
      const disc = readJson(path.join(det.home, 'runner.json'));
      let token = null;
      try { token = readFileSync(path.join(det.home, 'token'), 'utf8').trim(); } catch { /* not yet */ }
      if (!disc?.port || !token || !Number.isFinite(disc.pid)) return null; // runner.json was cleared before the start: any file now is the new runner's
      det.runner = { ...det.runner, port: disc.port, pid: disc.pid, token }; seenPid = disc.pid;
      try { const h = await runnerCall(det, d, 'GET', '/health', 3000); return h.status === 200 ? h.body : null; } catch { return null; }
    };
    const runnerDead = () => (seenPid != null && !d.pidAlive(seenPid)) || (seenPid == null && directPid != null && d.now() - directAt > 3000 && !d.pidAlive(directPid)); // direct-spawn pid counts until runner.json shows up
    // Bug24 (11-16): a server-booted runner took runner.lock and folded the roster for 120s before it published runner.json; the
    // old flat 45s grace then started a second runner, which died on alreadyRunning, and the restart failed while the first came
    // up healthy. A live runner.lock holder that has not published yet is booting (runner/lock.mjs bootingHolder, idea-260):
    // wait it out up to RUNNER_BOOT_MAX_MS from its lock time, never start another; start one directly only with no live holder.
    let lockLib = null;
    try { lockLib = await d.lock(); } catch (e) { step('runner lock helpers unavailable', { error: e.message, note: 'no booting-holder check: direct start after the grace window' }); }
    const runnerLockFile = path.join(det.home, 'runner.lock');
    const bootMaxMs = lockLib?.RUNNER_BOOT_MAX_MS ?? 0;
    const booting = () => (lockLib ? lockLib.bootingHolder(det.home, { alive: d.pidAlive, now: d.now() }) : null);
    const liveHolder = () => { const h = lockLib?.readLock(runnerLockFile); return h && Number.isInteger(h.pid) && d.pidAlive(h.pid) ? h : null; };
    const secsSince = (t) => Math.max(0, Math.round((d.now() - (t ?? d.now())) / 1000));
    const runnerNote = (el) => {
      const b = booting();
      return b ? [`runner booting (pid ${b.pid}, ${secsSince(b.startedAt)}s)`, { pid: b.pid, seconds: secsSince(b.startedAt) }] : slowNote('runner')(el);
    };
    const runnerT0 = d.now();
    const hardEnd = runnerT0 + bootMaxMs + bootMs; // every holder wait is bounded by its own boot max; this caps a chain of them
    // Phase 1: give the server the usual 45s to boot the runner and publish runner.json.
    let health = await bootWait('runner', runnerT0 + Math.min(45000, bootMs), fresh, runnerDead, runnerNote);
    const waitedOn = new Set();
    // Phase 2 (nothing published yet): wait on a booting holder, else start one directly (once), else stop and report.
    while ((!health || health === 'died') && seenPid == null) {
      const b = booting();
      const key = b && `${b.pid}:${b.startedAt}`;
      if (b && !waitedOn.has(key)) {
        if (d.now() >= hardEnd) break; // a chain of holders past the cap: report it below
        waitedOn.add(key);
        step('runner booting, not starting another', { pid: b.pid, seconds: secsSince(b.startedAt), maxSec: Math.round(bootMaxMs / 1000) });
        // Dead = the holder exited before publishing (re-judged next turn) or the runner it published died.
        health = await bootWait('runner', Math.min((b.startedAt ?? d.now()) + bootMaxMs, hardEnd), fresh, () => (seenPid != null && !d.pidAlive(seenPid)) || (seenPid == null && !d.pidAlive(b.pid)), runnerNote);
        if (health === 'died' && seenPid == null) step('runner boot holder exited before publishing', { pid: b.pid });
        continue;
      }
      if (directPid != null || liveHolder()) break; // started one already, or a live holder past its boot max: never double it
      const rl = det.runnerLaunch;
      const pid = d.spawnDetached(rl.node, rl.args, { cwd: rl.cwd, env: repairShellEnv(stripAgentEnv(env), { regQuery: d.regQuery, exists: d.exists, which: d.which, log }), logFile: rl.logFile }); // never as an agent (X1b)
      directPid = pid; directAt = d.now();
      step('runner not booted by the server, started directly', { pid });
      health = await bootWait('runner', d.now() + bootMs, fresh, runnerDead, runnerNote);
    }
    if (!health && seenPid != null) health = await bootWait('runner', Math.max(runnerT0 + bootMs, d.now() + 15000), fresh, runnerDead, runnerNote); // a new runner published and is booting: wait out the full window
    if (!health || health === 'died') {
      // Report the real state, not a blanket failure: a runner that is healthy now (e.g. ours died on alreadyRunning because the
      // server's runner held the lock) is a success.
      const last = await fresh();
      if (last) { step('runner healthy on final check', { pid: seenPid }); health = last; }
    }
    if (!health || health === 'died') {
      const h = liveHolder();
      const pub = lockLib && h ? lockLib.publishedBy(det.home, h) : false;
      if (h) {
        const state = pub ? 'published runner.json but /health does not answer' : (booting() ? 'still booting' : `has not published runner.json after ${Math.round(bootMaxMs / 1000)}s (wedged)`);
        result.runnerHolder = { pid: h.pid, ageSec: secsSince(h.startedAt), published: pub, healthy: false, directPid };
        fail('runner start', `runner.lock holder pid ${h.pid} is alive (${secsSince(h.startedAt)}s) but not healthy: ${state}${directPid != null && directPid !== h.pid ? `; direct start pid ${directPid} ${d.pidAlive(directPid) ? 'alive' : 'exited'}` : ''}`);
      } else if (health === 'died') fail('runner start', `runner process ${seenPid ?? directPid} died during start`);
      else fail('runner start', `no healthy runner after start (${Math.round(bootMs / 1000)}s)`);
      throw new Error('runner not healthy');
    }

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
      await verifyResumed(det, d, opts, result, step, fail);
    }
    result.ok = result.errors.length === 0;
    if (result.ok) await doneBroadcast(d, outDir, result, step);
  } catch (e) {
    if (e.message !== 'abort' && !result.errors.length) fail('restart', e);
    result.ok = false;
  } finally {
    // 8. end the drain, clear marker, release lock, write the result file. A drain on a runner this restart stopped ended
    // with it (the call then fails or meets a new runner's token: 401); a deferral or a failed stop leaves that runner up.
    if (drainOn) {
      try {
        const r = await runnerCall(drainOn, d, 'DELETE', '/drain', 3000);
        step(r.status === 200 ? 'drain cleared' : 'drain clear skipped', r.status === 200 ? { wasActive: r.body?.cleared === true } : { status: r.status, reason: 'not the drained runner any more' });
      } catch (e) { step('drain clear skipped', { reason: `drained runner gone (${e.message})` }); }
    }
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
  // idea-355: a detached launch has no console, so the log file is the only witness. `vs restart` waits for this STARTED_LINE
  // before reporting success; anything that stops us before restartRuntime runs is written there too.
  const argv = process.argv.slice(2);
  const li = argv.indexOf('--log');
  const earlyLog = (line) => { if (li >= 0 && argv[li + 1]) { try { appendFileSync(argv[li + 1], `[${new Date().toISOString()}] ${line}\n`); } catch { /* console only */ } } };
  earlyLog(`${STARTED_LINE} (pid ${process.pid})`);
  process.on('uncaughtException', (e) => { earlyLog(`restart-runtime crashed: ${e?.stack ?? e}`); process.exit(1); });
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`restart-runtime: ${e.message}`); earlyLog(`restart-runtime: ${e.message}`); process.exit(2); }
  applyLaunchEnv(opts, process.env); // `vs restart` runs us via WMI, which drops its env
  const log = (line) => { console.log(line); if (opts.log) { try { appendFileSync(opts.log, line + '\n'); } catch { /* console only */ } } };
  const r = await restartRuntime(opts, {}, process.env, log);
  if (r.dryRun) console.log(JSON.stringify(r.plan, null, 2));
  process.exit(r.ok ? 0 : r.alreadyRunning ? 3 : r.deferred ? 4 : 1);
}
