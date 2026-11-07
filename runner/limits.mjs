// Provider limit windows (5h / weekly). Sources, verified against real CLI output (test/fixtures/limits):
//  - claude: a `rate_limit_event` line in the stream-json output, every turn. Parsed by the claude adapter.
//  - antigravity-cli (Gemini): NOT in the ACP stream. `agy -p /usage` prints the quota table (~9s, no model call),
//    so the runner polls it after turns (see createAgyUsagePoller).
// Records land in <runner home>/limits.jsonl, append-only, one line each:
//   { at, provider, window: "5h"|"weekly", usedPct (0-100), resetsAt (ISO), source: "provider"|"estimate", agentId }
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { spawnNoShell, resolveExecutable } from './spawn.mjs';

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
export class LimitStore {
  constructor(file) { this.file = file; this.last = new Map(); }
  record({ provider, window, usedPct, resetsAt, source = 'provider', agentId = null }, now = Date.now()) {
    const key = `${provider}|${window}`;
    const prev = this.last.get(key);
    if (prev && prev.usedPct === usedPct && prev.resetsAt === resetsAt && prev.source === source) return null;
    const rec = { at: new Date(now).toISOString(), provider, window, usedPct, resetsAt, source, agentId };
    mkdirSync(path.dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(rec) + '\n');
    this.last.set(key, rec);
    return rec;
  }
}

// Polls `agy -p /usage` at most once per minIntervalMs, one in flight. run() resolves to stdout; injectable for tests.
export function runAgyUsage({ spawnImpl, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const r = resolveExecutable('agy');
    const child = spawnNoShell(r.file, [...r.args, '-p', '/usage'], { env: process.env }, spawnImpl);
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('agy /usage timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', () => { clearTimeout(timer); resolve(out); });
  });
}

export function createAgyUsagePoller({ store, run = runAgyUsage, minIntervalMs = 5 * 60_000, now = Date.now } = {}) {
  let busy = false;
  let lastAt = 0;
  return async function poll(agentId) {
    if (busy || now() - lastAt < minIntervalMs) return [];
    busy = true;
    lastAt = now();
    try {
      return parseAgyUsage(await run()).map((r) => store.record({ ...r, source: 'provider', agentId }, now())).filter(Boolean);
    } catch { return []; } finally { busy = false; }
  };
}
