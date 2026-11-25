// Provider limit windows (5h / weekly). Sources, verified against real CLI output (test/fixtures/limits):
//  - claude: a `rate_limit_event` line in the stream-json output, every turn. Parsed by the claude adapter.
//  - antigravity-cli (Gemini): NOT in the ACP stream. `agy -p /usage` prints the quota table (~9s, no model call),
//    so the runner polls it after turns (see createAgyUsagePoller).
// Records land in <runner home>/limits.jsonl, append-only, one line each:
//   { at, provider, window: "5h"|"weekly", usedPct (0-100), resetsAt (ISO), source: "provider"|"estimate", agentId }
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnNoShell, killTree } from './spawn.mjs';
import { isForbiddenRealHome, isForbiddenRealUserHome, underTestRunner } from '../server/test-guard.mjs';

// Claude's unifiedWindows keys -> our window ids. Add 'five_hour' here is already mapped, so a plan with a 5h window just works.
const CLAUDE_WINDOWS = { five_hour: '5h', seven_day: 'weekly' };

// rate_limit_event -> [{ window, usedPct, resetsAt }]. utilization is a 0-1 fraction, resetsAt epoch seconds.
// Windows other than 5h/weekly (e.g. seven_day_opus) are ignored.
export function parseClaudeRateLimit(m) {
  const info = m?.rate_limit_info;
  if (!info) return [];
  const windows = info.unifiedWindows && Object.keys(info.unifiedWindows).length
    ? info.unifiedWindows
    : (info.rateLimitType && info.utilization !== undefined ? { [info.rateLimitType]: { utilization: info.utilization, resetsAt: info.resetsAt } } : {});
  const out = [];
  for (const [key, w] of Object.entries(windows)) {
    const window = CLAUDE_WINDOWS[key];
    if (!window || !Number.isFinite(w?.utilization)) continue;
    const resets = Number(w.resetsAt ?? info.resetsAt);
    out.push({ window, usedPct: round1(w.utilization * 100), resetsAt: Number.isFinite(resets) ? new Date(resets * 1000).toISOString() : null });
  }
  return out;
}

// `agy -p /usage` table. Remaining% -> usedPct. The Gemini pool is provider "antigravity-cli"; the Claude/GPT pool is a
// separate quota on the Google plan (not the Anthropic account), recorded under its own provider id.
const AGY_POOLS = { 'Gemini Models': 'antigravity-cli', 'Claude and GPT models': 'antigravity-cli/claude-gpt' };
const AGY_WINDOWS = { 'Five Hour Limit Remaining': '5h', 'Weekly Limit Remaining': 'weekly' };
export function parseAgyUsage(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const [pool, label, pct, reset] = line.split('\t').map((s) => s.trim());
    const provider = AGY_POOLS[pool];
    const window = AGY_WINDOWS[label];
    const remaining = /^(\d+(?:\.\d+)?)%$/.exec(pct ?? '');
    if (!provider || !window || !remaining) continue;
    const t = Date.parse(reset);
    out.push({ provider, window, usedPct: round1(100 - Number(remaining[1])), resetsAt: Number.isFinite(t) ? new Date(t).toISOString() : null });
  }
  return out;
}

const round1 = (n) => Math.round(n * 10) / 10;

// Append-only limits.jsonl. Skips a record identical (usedPct + resetsAt) to the last one written for its provider/window.
// A `limits-checked.json` sidecar next to it records the last *check* time per provider/window on every record() call
// (written or deduped): the jsonl only holds changed samples, so the newest `at` is the last change, not the last poll.
const CHECKED_FILE = 'limits-checked.json';
function checkedPath(file) { return path.join(path.dirname(file), CHECKED_FILE); }

// Cheap (called per poll): read the sidecar, set one key, write back atomically (tmp + rename). Bounded: one entry per provider/window.
function writeChecked(file, key, checkedAt) {
  const sidecar = checkedPath(file);
  let map = {};
  try { map = JSON.parse(readFileSync(sidecar, 'utf8')); } catch { map = {}; }
  if (typeof map !== 'object' || map === null || Array.isArray(map)) map = {};
  map[key] = checkedAt;
  mkdirSync(path.dirname(sidecar), { recursive: true });
  const tmp = `${sidecar}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(map));
  renameSync(tmp, sidecar);
}

export class LimitStore {
  constructor(file) { this.file = file; this.last = new Map(); }
  record({ provider, window, usedPct, resetsAt, source = 'provider', agentId = null }, now = Date.now()) {
    if (isForbiddenRealHome(this.file)) return null; // a test must never write the developer's real ~/.vibesquad
    const key = `${provider}|${window}`;
    const prev = this.last.get(key);
    const checkedAt = new Date(now).toISOString();
    // Record the check on every poll so the UI can show "sampled Xh ago" from the last *check*, not the last *change*.
    try { writeChecked(this.file, key, checkedAt); } catch { /* sidecar is best-effort */ }
    if (prev && prev.usedPct === usedPct && prev.resetsAt === resetsAt && prev.source === source) return null;
    const rec = { at: checkedAt, provider, window, usedPct, resetsAt, source, agentId };
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(rec) + '\n');
    this.last.set(key, rec);
    return rec;
  }
}

// Runs `agy -p /usage` and resolves to stdout. Refuses to spawn the real agy under a test runner (no spawnImpl injected).
// onChild gets the live child so the owner can kill it on shutdown; the timeout kills the whole tree (win32 leaks otherwise).
export function runAgyUsage({ spawnImpl, timeoutMs = 30_000, onChild, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    if (!spawnImpl && underTestRunner()) return reject(new Error('refusing to spawn the real agy under a test runner'));
    let child;
    try {
      child = spawnNoShell('agy', ['-p', '/usage'], { env, ...(spawnImpl ? { resolved: { file: 'agy', args: [] } } : {}) }, spawnImpl);
    } catch (e) { return reject(e); }
    onChild?.(child);
    let out = '';
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); onChild?.(null); fn(v); };
    const timer = setTimeout(() => { killTree(child); finish(reject, new Error('agy /usage timed out')); }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (d) => { out += d; });
    child.stderr?.on('data', () => {}); // drain: an unread stderr pipe can stall the child
    child.on('error', (e) => finish(reject, e));
    child.on('exit', () => finish(resolve, out));
  });
}

// idea-701 spike: `agy -p /usage` under its own HOME/XDG dirs starts its own backend (own ports, own ~/.gemini/antigravity-cli state)
// and leaves live agy sessions alone (verified: live agy pids, listening ports and state-file hashes unchanged), so it needs no
// "no agy agent mid-turn" guard. Only the sign-in files are copied in (fresh each poll); the scratch home is removed afterwards.
const AGY_STATE_REL = path.join('.gemini', 'antigravity-cli');
const AGY_AUTH_FILES = ['antigravity-oauth-token', 'settings.json', 'installation_id'];
// The token is copied byte-for-byte and discarded: safe while Google does not rotate refresh tokens (a rotation would stale the real file).
export function makeAgyIsolatedHome({ realHome = os.homedir(), tmpBase = os.tmpdir() } = {}) {
  if (isForbiddenRealUserHome(realHome)) return null; // a test must never copy the developer's real sign-in into /tmp
  const src = path.join(realHome, AGY_STATE_REL);
  if (!existsSync(path.join(src, AGY_AUTH_FILES[0]))) return null; // not signed in: nothing to poll
  const home = mkdtempSync(path.join(tmpBase, 'vs-agy-usage-'));
  const cleanup = () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } };
  const dst = path.join(home, AGY_STATE_REL);
  try {
    mkdirSync(dst, { recursive: true, mode: 0o700 });
    for (const f of AGY_AUTH_FILES) {
      try { copyFileSync(path.join(src, f), path.join(dst, f)); chmodSync(path.join(dst, f), 0o600); }
      catch (e) { if (f === AGY_AUTH_FILES[0]) throw e; /* settings/installation_id are optional */ }
    }
  } catch { cleanup(); return null; } // no half-built scratch home (and no token copy) is left behind
  return {
    home,
    env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache') },
    cleanup,
  };
}

// runAgyUsage in an isolated home. Under a test runner without spawnImpl it refuses BEFORE touching the real home.
export async function runAgyUsageIsolated({ spawnImpl, makeHome = makeAgyIsolatedHome, ...opts } = {}) {
  if (!spawnImpl && underTestRunner()) throw new Error('refusing to spawn the real agy under a test runner');
  const iso = makeHome();
  if (!iso) throw new Error('agy not signed in: no antigravity-oauth-token to poll with');
  try { return await runAgyUsage({ ...opts, spawnImpl, env: iso.env }); } finally { iso.cleanup(); }
}

// Polls at most once per minIntervalMs, one in flight (concurrent calls return []). poll.shutdown() kills an in-flight agy.
export function createAgyUsagePoller({ store, run = runAgyUsageIsolated, minIntervalMs = 30 * 60_000, now = Date.now, canRun = () => true } = {}) {
  let busy = false;
  let lastAt = 0;
  let current = null;
  let stopped = false;
  const poll = async function poll(agentId) {
    if (busy || stopped || now() - lastAt < minIntervalMs) return [];
    // idea-349 (canRun, off by default since idea-701: the default run is isolated): a spawned `agy` on the shared backend announces "subagents and background tasks stopped due to server restart"
    // to live agy sessions. Skip (without spending the interval) while any agy agent is mid-turn or holding background work.
    try { if (!canRun(agentId)) return []; } catch { return []; }
    busy = true;
    lastAt = now();
    try {
      const text = await run({ onChild: (c) => { current = c; } });
      if (stopped) return [];
      return parseAgyUsage(text).map((r) => store.record({ ...r, source: 'provider', agentId }, now())).filter(Boolean);
    } catch { return []; } finally { busy = false; current = null; }
  };
  poll.shutdown = () => { stopped = true; if (current) killTree(current); current = null; };
  return poll;
}
