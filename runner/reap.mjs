// idea-515 (Z1): reap a worker's leaked listeners (vite dev/preview, any dev server) once its process ends.
// The leak: an agent runs `npx vite &` (or Start-Process, nohup ...) inside a normal tool call. The tool shell exits at
// once, so the server's parent chain ends at a dead pid; park()/exit kill the CLI's tree (taskkill /T walks live parent
// links), never reach it, and it keeps its port for good. Live sample 11-21: node vite :5199 <- cmd <- node npx <- bash
// <- bash <- (dead tool shell).
// Proof of ownership survives a dead intermediate because the environment does: every process an agent's CLI starts
// inherits VS_AGENT_ID and VS_AGENT_TOKEN (runner/runner.mjs agentEnv). The token is the runner's per-agent secret for this
// runner lifetime, so a listener whose env carries THIS agent's token was started under this agent's CLI in this runner
// lifetime. Only its sha256 is compared (the env reader prints a hash, never the value).
// Fail closed everywhere: no snapshot, an env that cannot be read, a token from another runner lifetime, a pid the probe
// cannot date, a process created after the agent's process ended, anything near held background work, the runner itself
// or its ancestors: not killed (the reasons are reported). PID reuse: a parent link only counts when the child was
// created after the parent (as background.mjs), and every pid is re-dated right before its kill (children.mjs rule).
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnCaptureOffLoop } from './spawn-off-loop.mjs';
import { shellCmdTail } from './background.mjs';
import { redactHostPathTokens } from '../server/redact-host-paths.mjs';

export const sha256 = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
const LINK_SLACK_MS = 50; // background.mjs: a child created before its parent is a stale ParentProcessId (pid reuse)
// A coarse row (ps etimes: whole seconds, each row read at its own instant) says so with createdTolMs; the link check then
// allows that much, as background.mjs backgroundWork does (idea-697 review M2): a child read a second "before" its parent
// is still its child, so an in-tree shell never falls out of its CLI's tree and reads as detached.
const linkSlack = (p, q) => Math.max(LINK_SLACK_MS, Number(p.createdTolMs) || 0, Number(q.createdTolMs) || 0);
const MAX_DEPTH = 64;
const SYSTEM_PIDS = new Set([0, 4]);
// Defense in depth: the VS runtime never carries an agent token (scripts/restart-runtime.mjs AGENT_ENV_KEYS scrub), but a
// process that looks like it is never reaped either.
export const VS_RUNTIME = /(?:^|[\\/\s"'])(?:scripts[\\/]serve|scripts[\\/]restart-runtime|runner[\\/]server|runner[\\/]runner)\.mjs\b/i;

/** A reaped command fit for runner.log and the team log: Claude's wrapper stripped, host paths redacted to their script name, tail kept. */
export function reapCmdText(cmd, max = 160) {
  const t = redactHostPathTokens(shellCmdTail(cmd, Infinity), { keepBasename: true }).replace(/\\/g, '/').replace(/[\r\n\t`"]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `...${t.slice(-max).replace(/^\S*\s*/, '')}` : t;
}

// The live parent of p in the snapshot, or null when the link is broken (parent gone) or stale (pid reuse).
function parentOf(p, byPid) {
  const q = byPid.get(p.ppid);
  if (!q || q.pid === p.pid) return null;
  if (!(q.createdMs > 0) || !(p.createdMs > 0) || p.createdMs + linkSlack(p, q) < q.createdMs) return null;
  return q;
}

/** Live ancestors of pid (nearest first) through valid links only. */
export function liveAncestors(pid, byPid) {
  const out = [];
  const seen = new Set([pid]);
  let p = byPid.get(pid);
  while (p && out.length < MAX_DEPTH) {
    const q = parentOf(p, byPid);
    if (!q || seen.has(q.pid)) break;
    seen.add(q.pid);
    out.push(q);
    p = q;
  }
  return out;
}

/** root and its live descendants through valid links (each child created after its parent). */
export function liveSubtree(rootPid, procs, byPid = new Map(procs.map((p) => [p.pid, p]))) {
  const kids = new Map();
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const out = [];
  const seen = new Set();
  const walk = (pid, depth) => {
    if (seen.has(pid) || depth > MAX_DEPTH) return;
    const p = byPid.get(pid);
    if (!p) return;
    seen.add(pid);
    out.push(p);
    for (const c of kids.get(pid) ?? []) if (parentOf(c, byPid) === p) walk(c.pid, depth + 1);
  };
  walk(rootPid, 0);
  return out;
}

/** Pids whose env must be read: every listener (created since `since`, the token's mint time) and its live ancestor chain (the root climb needs their markers). */
export function markerPidsFor(listeners, procs, since = 0) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const pids = new Set();
  for (const l of listeners) {
    if (!byPid.has(l.pid) || SYSTEM_PIDS.has(l.pid)) continue;
    if (since > 0 && !(byPid.get(l.pid).createdMs + 1000 >= since)) continue; // older than the agent's token: cannot carry it
    pids.add(l.pid);
    for (const a of liveAncestors(l.pid, byPid)) if (!SYSTEM_PIDS.has(a.pid)) pids.add(a.pid);
  }
  return [...pids];
}

/**
 * Pure. Which of the machine's listeners this agent's ended process leaked, and what to kill for each.
 *   procs: [{ pid, ppid, name, cmd, createdMs }]   listeners: [{ pid, port, addr? }]
 *   markers: Map<pid, { agentId, tokenSha } | { error }> (env read; absent = not read)
 *   agentId, tokenSha: this agent; endedAt: when its process ended (later processes are not its)
 *   protectedPids: held background shells (any agent's, and this one's last hold), the runner, its ancestors: never killed,
 *     and nothing in their subtree or above them is either.
 *   cliPid: the agent's CLI pid; a chain still reaching it means the CLI is alive: left to park/exit.
 * Returns { reap: [{ root, pids, listeners: [{ pid, port }], cmd }], skipped: [{ pid, port, reason }], foreign }.
 */
export function planReap({ procs, listeners, markers, agentId, tokenSha, endedAt, protectedPids = [], cliPid = null }) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const prot = new Set(protectedPids.filter((p) => Number.isInteger(p) && p > 0));
  const mine = (pid) => { const m = markers.get(pid); return !!m && !m.error && m.agentId === agentId && !!tokenSha && m.tokenSha === tokenSha; };
  const reap = new Map(); // root pid -> entry
  const skipped = [];
  let foreign = 0;
  const seenListener = new Set();
  for (const l of listeners) {
    if (!Number.isInteger(l.pid) || l.pid <= 0 || SYSTEM_PIDS.has(l.pid) || seenListener.has(`${l.pid}:${l.port}`)) continue;
    seenListener.add(`${l.pid}:${l.port}`);
    const skip = (reason) => skipped.push({ pid: l.pid, port: l.port, reason });
    const p = byPid.get(l.pid);
    const m = markers.get(l.pid);
    if (!p) { if (m && !m.error && m.agentId === agentId) skip('not-in-snapshot'); else foreign++; continue; }
    if (!m) { foreign++; continue; } // not read: not a candidate
    if (m.error) { skip(`env-unreadable:${m.error}`); continue; } // unsure: never killed, reported
    if (m.agentId !== agentId) { foreign++; continue; } // another agent's, or no agent's at all
    if (!tokenSha || m.tokenSha !== tokenSha) { skip('token-mismatch'); continue; } // same id, other runner lifetime (or forged): unsure
    if (!(p.createdMs > 0)) { skip('undated'); continue; }
    if (p.createdMs > endedAt) { skip('created-after-end'); continue; }
    const ancestors = liveAncestors(l.pid, byPid);
    if (prot.has(l.pid) || ancestors.some((a) => prot.has(a.pid))) { skip('held'); continue; }
    if (cliPid !== null && ancestors.some((a) => a.pid === cliPid)) { skip('cli-alive'); continue; }
    // Root: the topmost live ancestor still carrying this agent's token (npx/cmd/bash wrappers of the server), never the
    // CLI, a protected pid or anything created after the end.
    let root = p;
    for (const a of ancestors) {
      if (a.pid === cliPid || prot.has(a.pid) || SYSTEM_PIDS.has(a.pid) || !mine(a.pid) || !(a.createdMs > 0) || a.createdMs > endedAt) break;
      root = a;
    }
    const tree = liveSubtree(root.pid, procs, byPid);
    if (tree.some((t) => prot.has(t.pid))) { skip('held-in-tree'); continue; }
    if ([...tree, ...ancestors].some((t) => VS_RUNTIME.test(String(t.cmd ?? '')))) { skip('vs-runtime'); continue; }
    if (cliPid !== null && tree.some((t) => t.pid === cliPid)) { skip('cli-alive'); continue; }
    const fresh = tree.filter((t) => !(t.createdMs > 0) || t.createdMs > endedAt);
    if (fresh.length) { skip('tree-has-later-process'); continue; }
    if (!reap.has(root.pid)) reap.set(root.pid, { root: root.pid, pids: tree.map((t) => ({ pid: t.pid, name: t.name, createdMs: t.createdMs })), listeners: [], cmd: reapCmdText(p.cmd || p.name) });
    reap.get(root.pid).listeners.push({ pid: l.pid, port: l.port });
  }
  // A root nested inside another root's tree is already covered.
  const all = [...reap.values()];
  const covered = new Set();
  for (const r of all) for (const q of all) if (q !== r && q.pids.some((x) => x.pid === r.root)) covered.add(r.root);
  for (const r of all) if (covered.has(r.root)) { const host = all.find((q) => q !== r && !covered.has(q.root) && q.pids.some((x) => x.pid === r.root)); host?.listeners.push(...r.listeners); }
  return { reap: all.filter((r) => !covered.has(r.root)), skipped, foreign };
}

// ---- probes ---------------------------------------------------------------------------------------------------------

// idea-545: with no injected spawnImpl the spawn runs in a worker thread (it blocks its caller ~0.5-1s+ on Windows).
const runPs = (script, { spawnImpl = null, timeoutMs = 30_000, stdin = null } = {}) => !spawnImpl ? spawnCaptureOffLoop('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs, stdin }) : new Promise((resolve, reject) => {
  let out = '';
  let done = false;
  const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { shell: false, windowsHide: true, stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
  const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
  const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(reject, new Error('powershell timed out')); }, timeoutMs);
  timer.unref?.();
  child.stdout.on('data', (d) => { out += d; });
  child.on('error', (err) => finish(reject, err));
  child.on('close', (code) => (code === 0 ? finish(resolve, out) : finish(reject, new Error(`powershell exited ${code}`))));
  if (stdin !== null) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
});

const runCmd = (file, args, { spawnImpl = null, timeoutMs = 20_000 } = {}) => !spawnImpl ? spawnCaptureOffLoop(file, args, { timeoutMs }) : new Promise((resolve, reject) => {
  let out = '';
  let done = false;
  const child = spawnImpl(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
  const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(reject, new Error(`${file} timed out`)); }, timeoutMs);
  timer.unref?.();
  child.stdout.on('data', (d) => { out += d; });
  child.on('error', (err) => finish(reject, err));
  child.on('close', (code) => (code === 0 ? finish(resolve, out) : finish(reject, new Error(`${file} exited ${code}`))));
});

// Windows: process table + TCP listeners in one CIM-backed PowerShell call.
const WIN_TABLE = "$ErrorActionPreference='Stop'; $p = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; q = $_.ParentProcessId; n = $_.Name; c = $_.CommandLine; t = $(if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) } }; $l = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ p = $_.OwningProcess; o = $_.LocalPort; a = $_.LocalAddress } }); [pscustomobject]@{ procs = @($p); listeners = $l } | ConvertTo-Json -Compress -Depth 4";

export function parseWinTable(text) {
  const j = JSON.parse(text || '{}');
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  return {
    procs: arr(j.procs).map((r) => ({ pid: Number(r.p), ppid: Number(r.q), name: String(r.n ?? ''), cmd: String(r.c ?? ''), createdMs: Number(r.t) || 0 })),
    listeners: arr(j.listeners).map((r) => ({ pid: Number(r.p), port: Number(r.o), addr: String(r.a ?? '') })),
  };
}

// Linux: ps with elapsed seconds (createdMs to ~1 s) + ss for listening TCP sockets with their pids.
export function parsePsEtimes(text, now = Date.now()) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), createdMs: now - Number(m[3]) * 1000, createdTolMs: 2000, name: m[4], cmd: m[5] || m[4] });
  }
  return out;
}
export function parseSs(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const local = line.trim().split(/\s+/)[3] ?? '';
    const port = Number(/:(\d+)$/.exec(local)?.[1]);
    for (const m of line.matchAll(/pid=(\d+)/g)) if (port) out.push({ pid: Number(m[1]), port, addr: local.replace(/:\d+$/, '') });
  }
  return out;
}

/** { procs, listeners } for the whole machine. Rejects on an unsupported platform (the caller fails closed). */
export async function snapshotListeners({ platform = process.platform, spawnImpl = null } = {}) {
  if (platform === 'win32') return parseWinTable(await runPs(WIN_TABLE, { spawnImpl }));
  if (platform === 'linux') {
    const now = Date.now();
    const [ps, ss] = await Promise.all([runCmd('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'etimes=', '-o', 'comm=', '-o', 'args='], { spawnImpl }), runCmd('ss', ['-ltnpH'], { spawnImpl })]);
    return { procs: parsePsEtimes(ps, now), listeners: parseSs(ss) };
  }
  throw new Error(`reap: unsupported platform ${platform}`);
}

// Windows env reader: the PEB's environment block of each pid (64-bit targets read by a 64-bit PowerShell), printing only
// "pid|ok|<VS_AGENT_ID>|<sha256(VS_AGENT_TOKEN)>" or "pid|err|<why>". The token value never leaves this process.
const WIN_ENV_CS = String.raw`
using System; using System.Runtime.InteropServices; using System.Text; using System.Security.Cryptography;
public static class VsReapEnv {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int a, bool i, int p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, IntPtr n, out IntPtr r);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool w);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, IntPtr i, int l, out int r);
  static byte[] Rd(IntPtr h, long a, int n) { var b = new byte[n]; IntPtr r; if (!ReadProcessMemory(h, new IntPtr(a), b, new IntPtr(n), out r) || r.ToInt64() != n) return null; return b; }
  static string Safe(string s) { var sb = new StringBuilder(); foreach (char c in s) sb.Append(char.IsLetterOrDigit(c) && c < 128 || c == '-' || c == '_' ? c : '?'); return sb.ToString(); }
  public static string Probe(int pid) {
    if (IntPtr.Size != 8) return pid + "|err|reader-32bit";
    IntPtr h = OpenProcess(0x1000 | 0x0010, false, pid);
    if (h == IntPtr.Zero) return pid + "|err|open";
    IntPtr pbi = Marshal.AllocHGlobal(48);
    try {
      bool w; if (IsWow64Process(h, out w) && w) return pid + "|err|wow64";
      int l; if (NtQueryInformationProcess(h, 0, pbi, 48, out l) != 0) return pid + "|err|query";
      long peb = Marshal.ReadInt64(pbi, 8);
      var pp = Rd(h, peb + 0x20, 8); if (pp == null) return pid + "|err|peb";
      long par = BitConverter.ToInt64(pp, 0);
      var ep = Rd(h, par + 0x80, 8); if (ep == null) return pid + "|err|params";
      long env = BitConverter.ToInt64(ep, 0);
      var sp = Rd(h, par + 0x3F0, 8); long size = sp == null ? 0 : BitConverter.ToInt64(sp, 0);
      byte[] blk = null;
      if (size > 0 && size <= (1 << 20)) blk = Rd(h, env, (int)size);
      for (int n = 1 << 16; blk == null && n >= 4096; n /= 2) blk = Rd(h, env, n);
      if (blk == null) return pid + "|err|env";
      string id = null, tok = null;
      foreach (var e in Encoding.Unicode.GetString(blk).Split('\0')) {
        if (e.Length == 0) break;
        int eq = e.IndexOf('=', 1); if (eq < 0) continue;
        string k = e.Substring(0, eq);
        if (string.Equals(k, "VS_AGENT_ID", StringComparison.OrdinalIgnoreCase)) id = e.Substring(eq + 1);
        else if (string.Equals(k, "VS_AGENT_TOKEN", StringComparison.OrdinalIgnoreCase)) tok = e.Substring(eq + 1);
      }
      string sha = "-";
      if (tok != null) { using (var s = SHA256.Create()) { var d = s.ComputeHash(Encoding.UTF8.GetBytes(tok)); var sb = new StringBuilder(); foreach (var x in d) sb.Append(x.ToString("x2")); sha = sb.ToString(); } }
      return pid + "|ok|" + (id == null ? "-" : Safe(id)) + "|" + sha;
    } finally { Marshal.FreeHGlobal(pbi); CloseHandle(h); }
  }
}`;

const ENV_PROBE_LOOP = "foreach ($x in ($in[1] -split ',')) { if ($x -match '^\\d+$') { try { [VsReapEnv]::Probe([int]$x) } catch { \"$x|err|probe\" } } }";
const ENV_INLINE_PS = "$ErrorActionPreference='Stop'; $in = [Console]::In.ReadToEnd() -split '\\n---PIDS---\\n'; Add-Type -TypeDefinition $in[0] -Language CSharp; " + ENV_PROBE_LOOP;
const ENV_LOAD_PS = "$ErrorActionPreference='Stop'; $in = [Console]::In.ReadToEnd() -split '\\n---PIDS---\\n'; Add-Type -Path $in[0]; " + ENV_PROBE_LOOP;
const ENV_COMPILE_PS = "$ErrorActionPreference='Stop'; $in = [Console]::In.ReadToEnd() -split '\\n---OUT---\\n'; Add-Type -TypeDefinition $in[0] -Language CSharp -OutputAssembly $in[1] -OutputType Library";
const sha256Bytes = (buf) => createHash('sha256').update(buf).digest('hex');

// idea-526 (idea-515 review M1): Add-Type -TypeDefinition runs csc (~2 s of CPU) in every PowerShell that uses it, and every
// park with a young host listener used it. The helper is now compiled once per runner process into a fresh mkdtemp dir
// (nothing pre-planted there can be picked up), its sha256 kept in memory and re-checked before each load; later probes
// only load the DLL (~0.6 s). Any compile/load failure falls back to the inline compile for good. The dir goes on exit.
let envReader = null; // null | Promise<{ path, sha } | null> | { failed: true }
async function envReaderDll(spawnImpl) {
  if (envReader?.failed) return null;
  envReader ??= (async () => {
    let dir;
    try {
      dir = await mkdtemp(join(tmpdir(), 'vs-reap-env-'));
      const path = join(dir, 'VsReapEnv.dll');
      await runPs(ENV_COMPILE_PS, { spawnImpl, stdin: `${WIN_ENV_CS}\n---OUT---\n${path}` });
      const sha = sha256Bytes(await readFile(path));
      const made = dir;
      process.once('exit', () => { try { rmSync(made, { recursive: true, force: true }); } catch { /* best effort */ } });
      return { path, sha };
    } catch {
      if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
      envReader = { failed: true };
      return null;
    }
  })();
  const r = await envReader;
  return envReader?.failed ? null : r;
}
/** Test seam: forget the compiled env reader (the next win32 probe compiles it again). */
export function resetEnvReaderCache() { envReader = null; }

export function parseMarkers(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const ok = /^(\d+)\|ok\|([^|]*)\|([0-9a-f]{64}|-)\s*$/.exec(line);
    if (ok) { out.set(Number(ok[1]), { agentId: ok[2] === '-' ? null : ok[2], tokenSha: ok[3] === '-' ? null : ok[3] }); continue; }
    const err = /^(\d+)\|err\|([\w-]+)\s*$/.exec(line);
    if (err) out.set(Number(err[1]), { error: err[2] });
  }
  return out;
}

/** Map<pid, { agentId, tokenSha } | { error }> for the given pids. A pid absent from the map was not read. */
export async function readEnvMarkers(pids, { platform = process.platform, spawnImpl = null, readFileImpl = readFile } = {}) {
  const ok = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  if (!ok.length) return new Map();
  if (platform === 'win32') {
    const pidList = ok.join(',');
    const dll = await envReaderDll(spawnImpl);
    if (dll) {
      try {
        // Load the helper compiled once for this runner, after checking it is still the bytes we compiled.
        if (sha256Bytes(await readFile(dll.path)) !== dll.sha) throw new Error('env reader changed on disk');
        return parseMarkers(await runPs(ENV_LOAD_PS, { spawnImpl, stdin: `${dll.path}\n---PIDS---\n${pidList}` }));
      } catch {
        envReader = { failed: true }; // a missing, changed or unloadable helper: compile inline from now on (the old path)
      }
    }
    // The C# source and pid list go over stdin (no argv length limit; pids are not secret either way).
    return parseMarkers(await runPs(ENV_INLINE_PS, { spawnImpl, stdin: `${WIN_ENV_CS}\n---PIDS---\n${pidList}` }));
  }
  if (platform === 'linux') {
    const out = new Map();
    for (const pid of ok) {
      try {
        const vars = String(await readFileImpl(`/proc/${pid}/environ`, 'utf8')).split('\0');
        const get = (k) => { const v = vars.find((e) => e.startsWith(`${k}=`)); return v === undefined ? null : v.slice(k.length + 1); };
        const id = get('VS_AGENT_ID');
        const tok = get('VS_AGENT_TOKEN');
        out.set(pid, { agentId: id === null ? null : id.replace(/[^\w-]/g, '?'), tokenSha: tok === null ? null : sha256(tok) });
      } catch (err) { out.set(pid, { error: err?.code === 'EACCES' ? 'open' : 'env' }); }
    }
    return out;
  }
  return new Map();
}

// Kill exactly these pids (no /T: taskkill's tree walk trusts stale parent ids, so a stranger whose dead parent's pid our
// root reused would die with it). Windows: one taskkill /F with a /PID per pid. POSIX: SIGKILL each.
export function killPids(pids, { platform = process.platform, spawnImpl = spawn, killImpl = process.kill.bind(process) } = {}) {
  const ok = pids.filter((p) => Number.isInteger(p) && p > 0 && !SYSTEM_PIDS.has(p));
  if (!ok.length) return Promise.resolve();
  if (platform === 'win32') {
    return new Promise((resolve) => {
      try {
        const k = spawnImpl('taskkill', ['/F', ...ok.flatMap((p) => ['/PID', String(p)])], { shell: false, windowsHide: true, stdio: 'ignore' });
        k.on?.('error', () => resolve());
        k.on?.('close', () => resolve());
        if (!k.on) resolve();
      } catch { resolve(); }
    });
  }
  for (const p of ok) { try { killImpl(p, 'SIGKILL'); } catch { /* gone */ } }
  return Promise.resolve();
}

/** Async re-date (never spawnSync: the runner's loop must not block): Map<pid, { createdMs }> for the pids still alive. */
export async function redatePids(pids, { platform = process.platform, spawnImpl = null } = {}) {
  const ok = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0);
  const out = new Map();
  if (!ok.length) return out;
  if (platform === 'win32') {
    const filter = ok.map((p) => `ProcessId=${p}`).join(' OR ');
    const text = await runPs(`Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [string]$_.ProcessId + '|' + [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }`, { spawnImpl });
    for (const line of text.split(/\r?\n/)) { const m = /^(\d+)\|(\d+)\s*$/.exec(line); if (m && ok.includes(Number(m[1]))) out.set(Number(m[1]), { createdMs: Number(m[2]) }); }
    return out;
  }
  const now = Date.now();
  let text = '';
  try { text = await runCmd('ps', ['-o', 'pid=', '-o', 'etimes=', '-p', ok.join(',')], { spawnImpl }); } catch { return out; } // ps exits 1 when none is alive
  for (const line of text.split(/\r?\n/)) { const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line); if (m && ok.includes(Number(m[1]))) out.set(Number(m[1]), { createdMs: now - Number(m[2]) * 1000 }); }
  return out;
}

const START_MATCH_MS = (platform) => (platform === 'win32' ? 1000 : 2500); // ps dates to the second

/**
 * The runner's reaper: (job) -> Promise<{ reaped: [{ pid, port, root, pids, cmd }], skipped: [...], error? }>.
 *   job: { agentId, token, since (token mint time), endedAt, protectedPids, cliPid, stillOk: () => bool }
 * stillOk is asked right before any kill (the agent resumed, the runner is shutting down: nothing is killed).
 * Every pid is re-dated just before the kill and dropped if its start time moved (pid reuse) or it is gone.
 */
export function createDevServerReaper({ platform = process.platform, snapshot = () => snapshotListeners({ platform }), markers = (pids) => readEnvMarkers(pids, { platform }), inspect = (pids) => redatePids(pids, { platform }), kill = (pids) => killPids(pids, { platform }) } = {}) {
  // Reaps that land together (a burst of parks) share one snapshot, if it started after their process ended.
  let shared = null; // { startedAt, promise }
  const table = (endedAt) => {
    if (shared && shared.startedAt >= endedAt) return shared.promise;
    const startedAt = Date.now();
    const promise = Promise.resolve().then(() => snapshot());
    const mine = { startedAt, promise };
    shared = mine;
    promise.then(() => setTimeout(() => { if (shared === mine) shared = null; }, 1000).unref?.(), () => { if (shared === mine) shared = null; });
    return promise;
  };
  return async ({ agentId, token, since = 0, endedAt, protectedPids = [], cliPid = null, stillOk = () => true }) => {
    if (!agentId || !token) return { reaped: [], skipped: [], error: 'no agent token' };
    let snap;
    try { snap = await table(endedAt); } catch (err) { return { reaped: [], skipped: [], error: `snapshot: ${err?.message ?? err}` }; }
    const want = markerPidsFor(snap.listeners, snap.procs, since);
    let env;
    try { env = await markers(want); } catch (err) { return { reaped: [], skipped: [], error: `env: ${err?.message ?? err}` }; }
    const plan = planReap({ procs: snap.procs, listeners: snap.listeners, markers: env, agentId, tokenSha: sha256(token), endedAt, protectedPids, cliPid });
    const reaped = [];
    const skipped = [...plan.skipped];
    if (!plan.reap.length) return { reaped, skipped };
    if (!stillOk()) return { reaped, skipped: [...skipped, ...plan.reap.flatMap((r) => r.listeners.map((l) => ({ ...l, reason: 'agent-live-again' })))] };
    const all = plan.reap.flatMap((r) => r.pids.map((p) => p.pid));
    let now; // Map<pid, { createdMs }>; missing = gone or unknown: never killed
    try { now = await inspect(all); } catch { now = new Map(); }
    const tol = START_MATCH_MS(platform);
    for (const r of plan.reap) {
      const pids = r.pids.filter((p) => { const i = now.get(p.pid); return i && Math.abs(i.createdMs - p.createdMs) <= tol; }).map((p) => p.pid);
      const listenersOk = r.listeners.filter((l) => pids.includes(l.pid));
      for (const l of r.listeners) if (!pids.includes(l.pid)) skipped.push({ ...l, reason: 'pid-changed' });
      if (!listenersOk.length) continue;
      if (!stillOk()) { for (const l of listenersOk) skipped.push({ ...l, reason: 'agent-live-again' }); continue; }
      await kill(pids);
      for (const l of listenersOk) reaped.push({ pid: l.pid, port: l.port, root: r.root, pids, cmd: r.cmd });
    }
    return { reaped, skipped };
  };
}
