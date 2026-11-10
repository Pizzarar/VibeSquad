// Background work under an idle agent: shells its CLI started during a turn that are still running (Claude Code's
// run_in_background Bash, a gemini/agy shell tool left running: a full test suite, a build). park() kills the agent's whole
// process tree, so the runner holds the park while any exist (see Runner._parkWhenClear).
// What counts: a SHELL process in the CLI's tree that is not an MCP sidecar. A live tree always has more than the CLI
// (conhost.exe on Windows, the vs MCP server, playwright, user MCPs like blender-mcp under agy), and gemini relaunches
// itself as a node child, so "any descendant" would hold every agent forever. Every agent-run command goes through a shell.
import { spawn } from 'node:child_process';

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'tcsh', 'csh', 'nu', 'cmd', 'powershell', 'pwsh']);
const imageOf = (name) => String(name ?? '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
// An MCP server the CLI launched at boot, maybe via a shell (`cmd /c npx some-mcp`). Claude Code tool shells always source
// a shell-snapshots file, so a tool command that merely mentions mcp is still work.
const isSidecar = (p) => /mcp/i.test(p.cmd ?? '') && !/shell-snapshots/i.test(p.cmd ?? '');

// Pure: shells under rootPid that are not inside an MCP sidecar's subtree, topmost first (a shell's own subtree is its
// work, not more entries). procs: [{ pid, ppid, name, cmd, createdMs? }]. A child created before its parent is a stale
// Windows ParentProcessId (pid reuse), not a descendant. cmd keeps the tail: Claude Code puts the real command last.
export function backgroundWork(procs, rootPid) {
  const kids = new Map();
  const byPid = new Map();
  for (const p of procs) {
    byPid.set(p.pid, p);
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const walk = (pid, depth) => {
    const parent = byPid.get(pid);
    for (const c of kids.get(pid) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      if (parent?.createdMs && c.createdMs && c.createdMs + 50 < parent.createdMs) continue;
      if (depth === 0 && isSidecar(c)) continue;
      if (SHELLS.has(imageOf(c.name))) { out.push({ pid: c.pid, name: imageOf(c.name), cmd: String(c.cmd ?? '').slice(-240) }); continue; }
      walk(c.pid, depth + 1);
    }
  };
  walk(rootPid, 0);
  return out;
}

const WIN_SCRIPT = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; q = $_.ParentProcessId; n = $_.Name; c = $_.CommandLine; t = $(if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }) } } | ConvertTo-Json -Compress";

// One snapshot of the whole process table (Windows: a single CIM query, not a per-pid loop; POSIX: one ps). Async: the
// CIM query takes ~0.5-1.5 s and must never block the runner's event loop.
export function snapshotProcesses({ platform = process.platform, spawnImpl = spawn, timeoutMs = 20_000 } = {}) {
  const win = platform === 'win32';
  const [file, args] = win
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_SCRIPT]]
    : ['ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'args=']];
  return new Promise((resolve, reject) => {
    let out = '';
    let done = false;
    const child = spawnImpl(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(reject, new Error('process snapshot timed out')); }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => {
      if (code !== 0) return finish(reject, new Error(`process snapshot exited ${code}`));
      try { finish(resolve, win ? parseWin(out) : parsePs(out)); } catch (err) { finish(reject, err); }
    });
  });
}

function parseWin(text) {
  const j = JSON.parse(text || '[]');
  return (Array.isArray(j) ? j : [j]).map((r) => ({ pid: r.p, ppid: r.q, name: r.n ?? '', cmd: r.c ?? '', createdMs: r.t || 0 }));
}

function parsePs(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3].split(/\s+/)[0] ?? '', cmd: m[3] });
  }
  return out;
}

// probe(rootPid) -> Promise<[{ pid, name, cmd }]>. Probes that land together share one snapshot (many agents park at once
// when a burst of turns ends), and a snapshot is reused for ttlMs.
export function createBackgroundProbe({ snapshot = snapshotProcesses, ttlMs = 1000 } = {}) {
  let inflight = null;
  let cached = null;
  const table = () => {
    if (cached && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.procs);
    if (!inflight) {
      inflight = Promise.resolve().then(() => snapshot()).then(
        (procs) => { cached = { at: Date.now(), procs }; inflight = null; return procs; },
        (err) => { inflight = null; throw err; },
      );
    }
    return inflight;
  };
  return async (rootPid) => backgroundWork(await table(), rootPid);
}
