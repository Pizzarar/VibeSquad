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

// R10 fu4 (adaptive agy poll): a 30 min gap let the Claude/GPT 5h row go 73% -> 100% (burn ~1 pt/min) before the 85%
// failover (server/provider-failover.mjs AGY_CLAUDE_FAILOVER_THRESHOLD) ever read it. The poller still only runs on agy
// turn_done, but its floor drops from AGY_POLL_SLOW_MS to AGY_POLL_FAST_MS while a pool is "hot":
//  - level: any 5h row (Gemini or Claude/GPT) at/over AGY_POLL_FAST_AT_PCT. 60 leaves 25 pts (~25 min at 1 pt/min) before 85,
//    and a 3 min floor means a reading lands every <=3 pts there, so 85 is seen by ~88 at the observed burn. Weekly rows are
//    left out of the level rule: one sits over 60% for days and would keep polling fast for no reason.
//  - burn: any row whose last two readings in the same window (same resetsAt) project to >= AGY_POLL_PROJECT_PCT (the
//    failover threshold) by the next slow poll. Catches a fast climb from below 60 (e.g. 30 -> 58 projects 86).
// Cost: `agy -p /usage` is ~9s in a scratch home with no model call; at most 20/h and only while hot and agy turns finish.
// Env overrides (ms / pct): VS_AGY_POLL_SLOW_MS, VS_AGY_POLL_FAST_MS, VS_AGY_POLL_FAST_AT_PCT.
export const AGY_POLL_SLOW_MS = 30 * 60_000;
export const AGY_POLL_FAST_MS = 3 * 60_000;
export const AGY_POLL_FAST_AT_PCT = 60;
export const AGY_POLL_PROJECT_PCT = 85; // = AGY_CLAUDE_FAILOVER_THRESHOLD (test/r10-fu4 keeps them equal)

export function agyPollConfigFromEnv(env = process.env) {
  const num = (v, ok) => { const t = String(v ?? '').trim(); const n = Number(t); return t !== '' && ok(n) ? n : undefined; }; // ' ' is Number 0: never a floor/level
  const out = {};
  const slow = num(env.VS_AGY_POLL_SLOW_MS, (n) => Number.isInteger(n) && n >= 0);
  const fast = num(env.VS_AGY_POLL_FAST_MS, (n) => Number.isInteger(n) && n >= 0);
  const at = num(env.VS_AGY_POLL_FAST_AT_PCT, (n) => Number.isFinite(n) && n >= 0 && n <= 100);
  if (slow !== undefined) out.minIntervalMs = slow;
  if (fast !== undefined) out.fastIntervalMs = fast;
  if (at !== undefined) out.fastAtPct = at;
  return out;
}

// The floor before the next poll, from this poll's rows and the previous reading per provider/window (prev: Map key -> {usedPct, resetsAt, at}).
export function agyNextPollMs(rows, prev, { at, slowMs = AGY_POLL_SLOW_MS, fastMs = AGY_POLL_FAST_MS, fastAtPct = AGY_POLL_FAST_AT_PCT, projectPct = AGY_POLL_PROJECT_PCT } = {}) {
  if (fastMs >= slowMs) return slowMs;
  for (const r of rows ?? []) {
    const used = Number(r?.usedPct);
    if (!Number.isFinite(used)) continue;
    if (r.window === '5h' && used >= fastAtPct) return fastMs;
    const p = prev?.get(`${r.provider}|${r.window}`);
    if (!p || p.resetsAt !== r.resetsAt || !(at > p.at) || !(used > p.usedPct)) continue; // new window or no climb: no projection
    if (used + ((used - p.usedPct) / (at - p.at)) * slowMs >= projectPct) return fastMs;
  }
  return slowMs;
}

// Polls at most once per floor (minIntervalMs, or fastIntervalMs while a pool is hot: agyNextPollMs), one in flight
// (concurrent calls return []). poll.shutdown() kills an in-flight agy.
export function createAgyUsagePoller({ store, run = runAgyUsageIsolated, minIntervalMs = AGY_POLL_SLOW_MS, fastIntervalMs = AGY_POLL_FAST_MS, fastAtPct = AGY_POLL_FAST_AT_PCT, projectPct = AGY_POLL_PROJECT_PCT, now = Date.now, canRun = () => true } = {}) {
  let busy = false;
  let lastAt = 0;
  let floorMs = minIntervalMs;
  const readings = new Map(); // provider|window -> last parsed reading (not store.last: that only holds changed records)
  let current = null;
  let stopped = false;
  const poll = async function poll(agentId) {
    if (busy || stopped || now() - lastAt < floorMs) return [];
    // idea-349 (canRun, off by default since idea-701: the default run is isolated): a spawned `agy` on the shared backend announces "subagents and background tasks stopped due to server restart"
    // to live agy sessions. Skip (without spending the interval) while any agy agent is mid-turn or holding background work.
    try { if (!canRun(agentId)) return []; } catch { return []; }
    busy = true;
    lastAt = now();
    try {
      const text = await run({ onChild: (c) => { current = c; } });
      if (stopped) return [];
      const rows = parseAgyUsage(text);
      const at = now();
      // Empty/unparseable output keeps the current floor (like a rejected run): no reading is not a cool reading.
      if (rows.length) floorMs = agyNextPollMs(rows, readings, { at, slowMs: minIntervalMs, fastMs: fastIntervalMs, fastAtPct, projectPct });
      for (const r of rows) readings.set(`${r.provider}|${r.window}`, { usedPct: r.usedPct, resetsAt: r.resetsAt, at });
      return rows.map((r) => store.record({ ...r, source: 'provider', agentId }, at)).filter(Boolean);
    } catch { return []; } finally { busy = false; current = null; }
  };
  poll.floorMs = () => floorMs;
  poll.shutdown = () => { stopped = true; if (current) killTree(current); current = null; };
  return poll;
}

// ---- Prepaid provider credits (usa-66, idea-963) --------------------------------------------------------------------
// Polls prepaid balance APIs (starting with DeepSeek) at most once per 30 min and persists latest readings to
// <runner home>/credits.json. Keys are read from existing provider config/env only (never stored or logged).

export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
export const CREDIT_POLL_INTERVAL_MS = 30 * 60_000;
const CREDIT_FETCH_TIMEOUT_MS = 15_000;

/**
 * Parse DeepSeek GET /user/balance response:
 *   { is_available: true, balance_infos: [{ currency: "USD", total_balance: "7.12", ... }] }
 * Prefers the USD entry when multiple currencies are returned, else the first entry with a finite total_balance.
 */
export function parseDeepSeekBalance(body) {
  let data = body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return null; }
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.balance_infos)) return null;
  const valid = [];
  for (const info of data.balance_infos) {
    if (!info || typeof info !== 'object') continue;
    const raw = info.total_balance;
    if (raw === null || raw === undefined || raw === '') continue;
    const balance = Number(raw);
    if (!Number.isFinite(balance)) continue;
    const currency = typeof info.currency === 'string' && info.currency.trim() ? info.currency.trim().toUpperCase() : 'USD';
    valid.push({ balance, currency });
  }
  if (!valid.length) return null;
  const chosen = valid.find((v) => v.currency === 'USD') ?? valid[0];
  return {
    balance: chosen.balance,
    currency: chosen.currency,
    isAvailable: typeof data.is_available === 'boolean' ? data.is_available : null,
  };
}

function extractKeyFromJsonValue(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
    if (parsed && typeof parsed === 'object') {
      const k = parsed.key ?? parsed.apiKey ?? parsed.api_key ?? parsed.token;
      if (typeof k === 'string' && k.trim()) return k.trim();
    }
    return null;
  } catch {
    return trimmed;
  }
}

/**
 * Locate the DeepSeek API key where opencode / env already keeps it (no new secret store):
 *  1. env.DEEPSEEK_API_KEY
 *  2. opencode SQLite credential table (~/.local/share/opencode/opencode.db, integration_id = 'deepseek')
 *  3. opencode legacy JSON auth/config files (auth.json / opencode.json)
 * Under a test runner, never reads the developer's real home (isForbiddenRealUserHome).
 */
export async function findDeepSeekApiKey({ env = process.env, realHome = os.homedir(), sqliteImport } = {}) {
  const fromEnv = typeof env?.DEEPSEEK_API_KEY === 'string' ? env.DEEPSEEK_API_KEY.trim() : '';
  if (fromEnv) return fromEnv;
  if (!realHome || isForbiddenRealUserHome(realHome)) return null;

  const dataRoots = [
    env?.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, 'opencode') : null,
    path.join(realHome, '.local', 'share', 'opencode'),
    env?.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'opencode') : null,
  ].filter(Boolean);

  for (const root of [...new Set(dataRoots)]) {
    const dbPath = path.join(root, 'opencode.db');
    if (!existsSync(dbPath)) continue;
    let db;
    try {
      const mod = sqliteImport ? await sqliteImport() : await import('node:sqlite');
      const DatabaseSync = mod?.DatabaseSync;
      if (!DatabaseSync) continue;
      db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db
        .prepare("SELECT value FROM credential WHERE lower(integration_id) = 'deepseek' AND (active = 1 OR active IS NULL) ORDER BY active DESC, time_updated DESC LIMIT 1")
        .get();
      const key = extractKeyFromJsonValue(row?.value);
      if (key) return key;
    } catch {
      // unreadable / locked / unsupported sqlite: fall through to JSON files
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  const configRoots = [
    ...dataRoots,
    env?.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'opencode') : null,
    path.join(realHome, '.config', 'opencode'),
  ].filter(Boolean);

  for (const root of [...new Set(configRoots)]) {
    for (const file of ['auth.json', 'opencode.json']) {
      const p = path.join(root, file);
      if (!existsSync(p)) continue;
      try {
        const doc = JSON.parse(readFileSync(p, 'utf8'));
        const ds = doc?.deepseek ?? doc?.provider?.deepseek?.options ?? doc?.providers?.deepseek;
        if (typeof ds === 'string' && ds.trim()) return ds.trim();
        if (ds && typeof ds === 'object') {
          const k = ds.key ?? ds.apiKey ?? ds.api_key ?? ds.token;
          if (typeof k === 'string' && k.trim()) return k.trim();
        }
      } catch { /* ignore malformed/unreadable file */ }
    }
  }
  return null;
}

/**
 * Fetch DeepSeek prepaid balance. Refuses real network calls under a test runner when no fetchImpl is injected.
 * Never includes the API key in returned values or error messages.
 */
export async function fetchDeepSeekBalance({ key, fetchImpl, timeoutMs = CREDIT_FETCH_TIMEOUT_MS, url = DEEPSEEK_BALANCE_URL } = {}) {
  const apiKey = typeof key === 'string' ? key.trim() : '';
  if (!apiKey) return { provider: 'deepseek', balance: null, currency: null, status: 'no-key' };
  if (!fetchImpl && underTestRunner()) throw new Error('refusing to fetch DeepSeek balance under a test runner');
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return { provider: 'deepseek', balance: null, currency: null, status: 'error' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res?.ok) return { provider: 'deepseek', balance: null, currency: null, status: 'error' };
    const body = typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
    const parsed = parseDeepSeekBalance(body);
    if (!parsed) return { provider: 'deepseek', balance: null, currency: null, status: 'error' };
    return { provider: 'deepseek', balance: parsed.balance, currency: parsed.currency, status: 'ok' };
  } catch {
    return { provider: 'deepseek', balance: null, currency: null, status: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

export const PREPAID_CREDIT_PROVIDERS = Object.freeze([
  Object.freeze({
    provider: 'deepseek',
    resolveKey: findDeepSeekApiKey,
    fetchBalance: fetchDeepSeekBalance,
  }),
]);

/** Persist latest credit readings per provider to <runner home>/credits.json (atomic tmp + rename). */
export class CreditStore {
  constructor(file) { this.file = file; }

  read() {
    if (isForbiddenRealHome(this.file)) return [];
    let map = {};
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      map = parsed && typeof parsed.credits === 'object' && parsed.credits && !Array.isArray(parsed.credits) ? parsed.credits : {};
    } catch { return []; }
    return Object.values(map)
      .filter((r) => r && typeof r === 'object' && typeof r.provider === 'string' && r.provider)
      .map((r) => ({
        provider: r.provider,
        balance: typeof r.balance === 'number' && Number.isFinite(r.balance) ? r.balance : null,
        currency: typeof r.currency === 'string' && r.currency ? r.currency : null,
        checkedAt: typeof r.checkedAt === 'string' && r.checkedAt ? r.checkedAt : null,
        status: typeof r.status === 'string' && r.status ? r.status : 'error',
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }

  record({ provider, balance = null, currency = null, checkedAt, status = 'error' }, now = Date.now()) {
    if (!provider || isForbiddenRealHome(this.file)) return null;
    let map = {};
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed.credits === 'object' && parsed.credits && !Array.isArray(parsed.credits)) map = parsed.credits;
    } catch { map = {}; }
    // Strict allowlist of fields so secrets can never be written to disk.
    const rec = {
      provider: String(provider),
      balance: typeof balance === 'number' && Number.isFinite(balance) ? balance : null,
      currency: typeof currency === 'string' && currency ? currency : null,
      checkedAt: typeof checkedAt === 'string' && checkedAt ? checkedAt : new Date(now).toISOString(),
      status: String(status || 'error'),
    };
    map[rec.provider] = rec;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ credits: map }, null, 2) + '\n');
    renameSync(tmp, this.file);
    return rec;
  }
}

/**
 * Polls prepaid provider credit balances at most once per minIntervalMs (default 30 min), one in flight.
 * Returns cached readings when throttled. Generic across PREPAID_CREDIT_PROVIDERS.
 */
export function createCreditPoller({
  store = null,
  providers = PREPAID_CREDIT_PROVIDERS,
  minIntervalMs = CREDIT_POLL_INTERVAL_MS,
  now = Date.now,
  fetchImpl,
  resolveKey,
  env = process.env,
  realHome = os.homedir(),
} = {}) {
  let busy = false;
  let lastAt = -Infinity;
  let stopped = false;
  let cached = [];

  const poll = async function poll({ force = false } = {}) {
    if (stopped) return [...cached];
    const t = now();
    if (busy || (!force && t - lastAt < minIntervalMs)) return [...cached];
    busy = true;
    lastAt = t;
    const out = [];
    try {
      for (const p of providers) {
        if (stopped) break;
        const checkedAt = new Date(now()).toISOString();
        let entry;
        try {
          const key = resolveKey ? await resolveKey(p.provider) : await p.resolveKey({ env, realHome });
          if (!key) {
            entry = { provider: p.provider, balance: null, currency: null, checkedAt, status: 'no-key' };
          } else {
            const res = await p.fetchBalance({ key, fetchImpl });
            entry = {
              provider: p.provider,
              balance: typeof res?.balance === 'number' && Number.isFinite(res.balance) ? res.balance : null,
              currency: typeof res?.currency === 'string' && res.currency ? res.currency : null,
              checkedAt,
              status: typeof res?.status === 'string' && res.status ? res.status : 'error',
            };
          }
        } catch {
          entry = { provider: p.provider, balance: null, currency: null, checkedAt, status: 'error' };
        }
        try { store?.record(entry, now()); } catch { /* best-effort */ }
        out.push(entry);
      }
      if (!stopped) cached = out;
      return [...cached];
    } finally {
      busy = false;
    }
  };
  poll.shutdown = () => { stopped = true; };
  poll.cached = () => [...cached];
  return poll;
}
