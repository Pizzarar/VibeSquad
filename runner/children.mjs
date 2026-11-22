// Child ledger: <home>/children.json lists every process the runner spawned (pid, image name, start time).
// A hard kill of the runner (taskkill /F, power loss) cannot run shutdown(), so the next boot reads the ledger and
// kills what is still alive. A pid is only killed if its image name AND creation time still match the record:
// Windows reuses pids, and killing a stranger's process is far worse than leaking an orphan.
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
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

// Batched inspectProcess: one PowerShell call for every pid on Windows (~0.7 s each otherwise, before listen).
// Returns Map<pid, info>; a pid missing from the map means gone or unknown, i.e. "do not kill".
export function inspectProcesses(pids, { platform = process.platform, run = spawnSync } = {}) {
  const ok = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  const out = new Map();
  if (!ok.length) return out;
  if (platform !== 'win32') {
    for (const pid of ok) { const info = inspectProcess(pid, { platform, run }); if (info) out.set(pid, info); }
    return out;
  }
  try {
    const filter = ok.map((pid) => `ProcessId=${pid}`).join(' OR ');
    const script = `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [string]$_.ProcessId + '|' + $_.Name + '|' + [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }`;
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    for (const line of String(r.stdout ?? '').split(/\r?\n/)) {
      const m = /^(\d+)\|(.+)\|(\d+)\s*$/.exec(line);
      if (m && ok.includes(Number(m[1]))) out.set(Number(m[1]), { name: m[2].trim().toLowerCase(), createdMs: Number(m[3]) });
    }
  } catch { /* unknown: kill nothing */ }
  return out;
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
// Pass inspect (per pid) or inspectMany (batched, the default) to override the process lookup.
// The default kill is the tree kill: taskkill /T /F on win32; off win32 the recorded child led its own process group
// (spawnNoShell detached), so its whole group gets SIGTERM then SIGKILL after the grace (audit R4). killOpts reaches killTree (tests).
export function sweepOrphans(home, { inspect, inspectMany = inspectProcesses, killOpts = {}, kill = (pid) => killTree({ pid, exitCode: null, kill: () => process.kill(pid) }, killOpts), alive = pidAlive } = {}) {
  const killed = [];
  const skipped = [];
  const live = readChildren(home).filter((rec) => rec.pid !== process.pid && alive(rec.pid));
  const infos = inspect ? null : inspectMany(live.map((rec) => rec.pid));
  for (const rec of live) {
    if (!matchesRecord(rec, inspect ? inspect(rec.pid) : infos.get(rec.pid) ?? null)) { skipped.push(rec.pid); continue; }
    try { (kill(rec.pid) === false ? skipped : killed).push(rec.pid); } catch { skipped.push(rec.pid); } // false: refused (POSIX guard), nothing signalled
  }
  writeChildren(home, []);
  return { killed, skipped };
}

// Live ledger for this runner process. add() on spawn, removal on the child's exit (which also covers park).
// idea-572: every add/removal goes through ONE serialized async writer (write tmp, then rename: atomic, as before). The sync
// write+rename in add() blocked the runner loop ~1-5s under AV (loop-lag 2026-11-22 08:23-09:38Z: writeChildren 36 stalls / 47s,
// 29 of them renameSync <- add <- spawnNoShell). Crash exposure is unchanged: spawn() has already created the child when add()
// runs, so a hard kill between spawn and a durable ledger was always possible; the async write starts in the same tick and takes
// the same wall time, it just no longer holds the loop. Ordering: one write in flight at a time, each rename carries a snapshot
// taken after the previous one, and the writer only stops once the file holds the newest generation (`written === gen`).
// clear() keeps the sync writer (a shutdown path must not depend on the loop surviving); if an async rename lands after it,
// `written` drops below `gen` and the writer re-asserts the current state.
// afs: the async fs ops (test seam: a held rename makes the clear-vs-rename race deterministic).
export function createChildLedger(home, { afs = { writeFile, rename, rm } } = {}) {
  const entries = new Map();
  let gen = 0; // bumped on every change
  let written = 0; // generation the file is known to hold
  let soon = null; // pending coalesced-removal timer
  let writing = null; // the in-flight async writer, if any
  const file = path.join(home, CHILDREN_FILE);
  const tmp = `${file}.${process.pid}.async.tmp`; // not the sync writer's tmp: the two can overlap; one async writer at a time
  const snapshot = () => [...entries.values()];
  // The sync writer (clear, and the async writer's error fallback). It carries every change made so far, so it also cancels a pending timer.
  const flush = () => { gen++; if (soon) { clearTimeout(soon); soon = null; } writeChildren(home, snapshot()); written = gen; };
  const writeAsync = async () => {
    while (written !== gen) {
      const snap = gen;
      try {
        await afs.writeFile(tmp, JSON.stringify(snapshot()));
        if (snap !== gen) continue; // changed meanwhile: re-snapshot instead of renaming a stale one into place
        await afs.rename(tmp, file);
      } catch {
        try { await afs.rm(tmp, { force: true }); } catch { /* ignore */ }
        flush(); // failed (EPERM/EBUSY under AV): never drop records, fall back to the sync writer
        return;
      }
      written = snap; // the file holds `snap` now, even if a sync flush wrote a newer state just before this rename landed
    }
  };
  const kick = () => {
    if (writing) return; // the in-flight writer loops until written === gen
    writing = writeAsync().finally(() => { writing = null; if (written !== gen && !soon) kick(); });
  };
  const arm = () => { soon = setTimeout(() => { soon = null; kick(); }, 50); soon.unref?.(); };
  return {
    add(child, file) {
      if (!child?.pid) return;
      entries.set(child.pid, { pid: child.pid, name: imageOf(file), startedAt: Date.now() });
      gen++;
      kick(); // at once: an add is never delayed by the removal coalescing window
      child.once?.('exit', () => { if (entries.delete(child.pid)) { gen++; if (!soon) arm(); } });
    },
    clear() { entries.clear(); flush(); },
    get size() { return entries.size; },
    // Resolves once the file holds every change made before the call (tests, diagnostics). Never rejects.
    async settled() {
      for (;;) {
        if (soon) { clearTimeout(soon); soon = null; kick(); }
        if (writing) { await writing.catch(() => {}); continue; }
        if (written === gen) return;
        kick();
      }
    },
  };
}
