// Spawn helpers: resolve executables ourselves and never use a shell.
// A shell on win32 (cmd.exe /c) truncates multi-line args (D1 in docs/UPSTREAM_ISSUES.md).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const EXE_EXTS = ['.exe', '.com'];

// Resolve a bare command to a real executable path. On win32, a .cmd npm shim is followed
// to the .exe/.js it launches instead of being run through cmd.exe.
export function resolveExecutable(cmd, { env = process.env, platform = process.platform } = {}) {
  const win = platform === 'win32';
  const sep = win ? ';' : ':';
  const dirs = path.isAbsolute(cmd) ? [''] : (env.PATH || env.Path || '').split(sep).filter(Boolean);
  for (const dir of dirs) {
    const base = dir ? path.join(dir, cmd) : cmd;
    if (!win) {
      if (existsSync(base)) return { file: base, args: [] };
      continue;
    }
    if (EXE_EXTS.includes(path.extname(base).toLowerCase()) && existsSync(base)) return { file: base, args: [] };
    for (const ext of EXE_EXTS) if (existsSync(base + ext)) return { file: base + ext, args: [] };
    if (existsSync(base + '.cmd')) {
      const target = parseCmdShim(base + '.cmd');
      if (target) return target;
    }
  }
  throw new Error(`cannot resolve executable "${cmd}" without a shell`);
}

// npm .cmd shims end with: "%dp0%\path\to\target" %*   (target is an .exe, or a .js run by node)
export function parseCmdShim(shimPath) {
  const text = readFileSync(shimPath, 'utf8');
  const dp0 = path.dirname(shimPath);
  const found = [...text.matchAll(/"%dp0%\\([^"]+)"/gi)].map((x) => x[1]).filter((p) => /\.(exe|js|cjs|mjs)$/i.test(p));
  if (!found.length) return null;
  const target = path.join(dp0, found[found.length - 1]);
  if (!existsSync(target)) return null;
  if (/\.exe$/i.test(target)) return { file: target, args: [] };
  return { file: process.execPath, args: [target] };
}

// Set by the runner entry point; every spawned child is recorded so a hard-killed runner's orphans can be swept at next boot.
let childLedger = null;
export function setChildLedger(ledger) { childLedger = ledger; }

// The only place the runner starts a child. shell is pinned to false.
export function spawnNoShell(cmd, args, opts = {}, spawnImpl = spawn) {
  const { resolved, ...rest } = opts;
  const r = resolved ?? resolveExecutable(cmd, { env: opts.env ?? process.env });
  const child = spawnImpl(r.file, [...r.args, ...args], { ...rest, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try { childLedger?.add(child, r.file); } catch { /* the ledger is best effort */ }
  return child;
}

// Kill a child and its descendants. child.kill() on win32 only ends the direct child, so a claude/opencode
// that spawned tools would leak them. taskkill /T /F runs without a shell (args are a fixed list).
export function killTree(child, { platform = process.platform, spawnImpl = spawn } = {}) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined)) return false;
  if (platform === 'win32' && child.pid) {
    try {
      const k = spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      k.on?.('error', () => child.kill());
      k.unref?.();
      return true;
    } catch { /* fall through */ }
  }
  try { child.kill(); } catch { /* already gone */ }
  return true;
}

// Kill a process by pid AND its descendants (ideas 228 + 229): a held agent's background shell (bash run_godot.sh ->
// timeout.exe -> Godot). Killing only the shell on Windows leaves its native children running, orphaned out of the agent's
// tree where nothing counts or kills them. Windows: taskkill /pid <pid> /T /F (no shell, fixed args). POSIX: the process
// group (a background shell is usually its leader), else the pid. Callers pass only pids a fresh probe saw under the agent.
export function killPidTree(pid, { platform = process.platform, spawnImpl = spawn, killImpl = process.kill.bind(process) } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === 'win32') {
    try {
      const k = spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      k.on?.('error', () => { try { killImpl(pid); } catch { /* gone */ } });
      k.unref?.();
      return true;
    } catch { /* fall through */ }
  }
  try { killImpl(-pid, 'SIGKILL'); return true; } catch { /* not a group leader */ }
  try { killImpl(pid, 'SIGKILL'); } catch { /* already gone */ }
  return true;
}
