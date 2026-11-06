// Child ledger: <home>/children.json lists every process the runner spawned (pid, image name, start time).
// A hard kill of the runner (taskkill /F, power loss) cannot run shutdown(), so the next boot reads the ledger and
// kills what is still alive. A pid is only killed if its image name AND creation time still match the record:
// Windows reuses pids, and killing a stranger's process is far worse than leaking an orphan.
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pidAlive } from './lock.mjs';
import { killTree } from './spawn.mjs';

export const CHILDREN_FILE = 'children.json';
export const START_TOLERANCE_MS = 5000; // spawn() is called just before the OS creates the process

const imageOf = (file) => path.basename(String(file)).toLowerCase();

// { name, createdMs } for a live pid, or null if gone OR unknown. Callers treat null as "do not kill".
export function inspectProcess(pid, { platform = process.platform, run = spawnSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'win32') {
      const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { $p.Name + '|' + [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds() }`;
      const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      const m = /^(.+)\|(\d+)\s*$/m.exec(String(r.stdout ?? ''));
      return m ? { name: m[1].trim().toLowerCase(), createdMs: Number(m[2]) } : null;
    }
    const r = run('ps', ['-p', String(pid), '-o', 'etimes=,comm='], { encoding: 'utf8', timeout: 5000 });
    const m = /^\s*(\d+)\s+(.+?)\s*$/m.exec(String(r.stdout ?? ''));
    return m ? { name: path.basename(m[2]).toLowerCase(), createdMs: Date.now() - Number(m[1]) * 1000 } : null;
  } catch {
    return null;
  }
}

// True only when the live process is provably the one we recorded.
export function matchesRecord(rec, info) {
  if (!rec || !info || typeof rec.name !== 'string' || !Number.isFinite(rec.startedAt)) return false;
  const want = rec.name.toLowerCase();
  const nameOk = info.name === want || (info.name.length >= 15 && want.startsWith(info.name)) || (want.length >= 15 && info.name.startsWith(want)); // ps truncates comm
  return nameOk && Math.abs(info.createdMs - rec.startedAt) <= START_TOLERANCE_MS;
}

export function readChildren(home) {
  try {
    const list = JSON.parse(readFileSync(path.join(home, CHILDREN_FILE), 'utf8'));
    return Array.isArray(list) ? list.filter((r) => r && Number.isInteger(r.pid)) : [];
  } catch {
    return [];
  }
}

function writeChildren(home, list) {
  const file = path.join(home, CHILDREN_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(list));
    renameSync(tmp, file);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

// Runs once at boot, before listening. Returns { killed: [pid], skipped: [pid] }.
export function sweepOrphans(home, { inspect = inspectProcess, kill = (pid) => killTree({ pid, exitCode: null, kill: () => process.kill(pid) }), alive = pidAlive } = {}) {
  const killed = [];
  const skipped = [];
  for (const rec of readChildren(home)) {
    if (rec.pid === process.pid || !alive(rec.pid)) continue;
    if (!matchesRecord(rec, inspect(rec.pid))) { skipped.push(rec.pid); continue; }
    try { kill(rec.pid); killed.push(rec.pid); } catch { skipped.push(rec.pid); }
  }
  writeChildren(home, []);
  return { killed, skipped };
}

// Live ledger for this runner process. add() on spawn, removal on the child's exit (which also covers park).
export function createChildLedger(home) {
  const entries = new Map();
  const flush = () => writeChildren(home, [...entries.values()]);
  return {
    add(child, file) {
      if (!child?.pid) return;
      entries.set(child.pid, { pid: child.pid, name: imageOf(file), startedAt: Date.now() });
      flush();
      child.once?.('exit', () => { if (entries.delete(child.pid)) flush(); });
    },
    clear() { entries.clear(); flush(); },
    get size() { return entries.size; },
  };
}
