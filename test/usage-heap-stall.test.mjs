// heap-stall-1114 (idea-238) regression tests: the /usage speedups (async pooled git, stepped getUsage, logLines parse cache,
// 5 s result cache, binary-search computeAutonomy, indexed attributeImplementer) must not change a single output byte.
// Fixtures live in temp dirs only: getUsage writes <home>/runner/usage-ledger.jsonl, so never the real ~/.vibesquad.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import cp, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearUsageCache, getUsage, getUsageAsync, readBootSizes, usageStats, usageTestHooks } from '../server/providers-catalog.mjs';

const tmpDirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-heapstall-')); tmpDirs.push(d); return d; };
test.after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); });
const T0 = Date.UTC(2026, 10, 1, 12);
const sec = (ms) => String(Math.round(ms / 1000));

// Deterministic PRNG (mulberry32) so a failing seed reproduces.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

function withRoot(root, fn) {
  const prev = process.env.VIBESQUAD_ROOT;
  process.env.VIBESQUAD_ROOT = root;
  const restore = () => { if (prev === undefined) delete process.env.VIBESQUAD_ROOT; else process.env.VIBESQUAD_ROOT = prev; };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

/** Counts setImmediate turns until stopped: > 0 means the event loop got control back while the awaited work ran. */
function tickCounter() {
  let n = 0;
  let on = true;
  const tick = () => { if (!on) return; n += 1; setImmediate(tick); };
  setImmediate(tick);
  return () => { on = false; return n; };
}

const LANES = ['usage', 'bug', 'wiki'];
const CODES = { usage: 'usa', bug: 'bug', wiki: 'wik' };

/** A home with `agents` agent logs (crossing the 500-record step boundary), a vs log over 512 KB (bounded logLines slices,
 * including one line longer than a slice), a team log, boot-size metrics, handoffs, owner touches, stalls and resolutions. */
function buildHome(home, { agents = 620, seed = 1 } = {}) {
  const r = rng(seed);
  fs.writeFileSync(path.join(home, 'teams.json'), JSON.stringify({ teams: [
    { id: 'sq-a', lanes: [{ id: 'usage', code: 'usa' }, { id: 'bug', code: 'bug' }] },
    { id: 'sq-b', lanes: [{ id: 'wiki', code: 'wik' }] },
  ] }));
  const agentsDir = path.join(home, 'runner', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  for (let i = 0; i < agents; i++) {
    const lane = LANES[i % LANES.length];
    const created = T0 + i * 60_000;
    const role = i % 7 === 0 ? 'lead' : 'worker';
    const profile = pick(r, ['Implement - Sonnet', 'Review - Gemini', 'Pre-check - Flash', 'Work Order - DSP']);
    const evs = [
      { ts: created, type: 'created', provider: profile.includes('Gemini') ? 'antigravity-cli' : 'claude', model: 'm', cwd: `C:\\wt\\VibeSquad\\unit-u${i % 40}\\`, meta: { team: lane === 'wiki' ? 'sq-b' : 'sq-a', lane, role, profile, title: `${lane} ${i}` } },
      { ts: created + 1000, type: 'input', text: 'do the thing' },
      { ts: created + 2000, type: 'output', text: i % 3 ? 'VERDICT: PASS (0/0/0)' : 'Verdict: FAIL' },
    ];
    for (let k = 0; k < 1 + (i % 4); k++) evs.push({ ts: created + 3000 + k * 1000, type: 'turn_done', costUsd: Math.round(r() * 100) / 100, usage: { inputTokens: 100 + k, outputTokens: 10 } });
    fs.writeFileSync(path.join(agentsDir, `rn-${String(i).padStart(4, '0')}.jsonl`), evs.map((e, s) => JSON.stringify({ seq: s, ...e }) + '\n').join(''));
  }
  const entry = (ts, lane, type, text) => JSON.stringify({ ts: new Date(ts).toISOString(), agent: 'Bug1', lane, type, text, refs: [] }) + '\n';
  const kinds = ['needs-you', 'you', 'decision', 'decision', 'blocker', 'done', 'done', 'handoff', 'note', 'metric'];
  let big = '';
  let teamLog = '';
  for (let i = 0; i < 3200; i++) {
    const ts = T0 + i * 45_000;
    const lane = pick(r, LANES);
    const type = pick(r, kinds);
    let text = `entry ${i} ${'x'.repeat(100)}`;
    if (type === 'decision' && r() < 0.3) text = `xsquad input on ${lane}`;
    if (type === 'done') text = r() < 0.5 ? 'PASS 3/3' : 'FAIL 1/3';
    if (type === 'metric') text = `boot-size role=${pick(r, ['worker', 'lead'])} provider=claude lane=${lane} chars=${1000 + i} total=${1200 + i} sys=10 plugin=20 artifact=30 brief=40 first=200 estTok=${300 + i}`;
    if (i % 5 === 0) teamLog += entry(ts, lane, type, text);
    else big += entry(ts, lane, type, text);
    if (i === 1600) big += entry(ts + 1, lane, 'note', 'y'.repeat(600 * 1024)); // one line longer than a 512 KB warm slice
  }
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'logs', 'sq-a--usage.jsonl'), big);
  fs.mkdirSync(path.join(home, 'teams', 'sq-b'), { recursive: true });
  fs.writeFileSync(path.join(home, 'teams', 'sq-b', 'log.jsonl'), teamLog);
  assert.ok(Buffer.byteLength(big) > 1024 * 1024, 'vs log spans several warm slices');
  return home;
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
/** git in `dir` with a fixed commit date (so copies of a repo built the same way share shas). */
const gitAt = (dir, clockMs) => (...args) => {
  const date = `${sec(clockMs)} +0000`;
  return execFileSync('git', args, { cwd: dir, env: { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: 'pipe', encoding: 'utf8' });
};
/** One --no-ff unit merge (unit-u<i>, lane by i) on main. */
function addMerge(dir, i) {
  const g = gitAt(dir, T0 + (i + 1) * 3600_000);
  const lane = LANES[i % LANES.length];
  const unit = `unit-u${i}`;
  g('checkout', '-q', '-b', unit);
  fs.writeFileSync(path.join(dir, `u${i}.txt`), 'line\n'.repeat(i + 1));
  g('add', '.');
  g('commit', '-q', '-m', `feat: u${i} (@${CODES[lane]}) review r${1 + (i % 3)}`);
  g('checkout', '-q', 'main');
  g('merge', '-q', '--no-ff', '-m', `Merge branch '${unit}' [wf:sonnet] (@${CODES[lane]}; Review-Gemini R${1 + (i % 2)} PASS)`, unit);
}
/** A git repo with `merges` --no-ff unit merges (subjects carry lane codes and review rounds). */
function buildRepo(dir, merges = 8) {
  fs.mkdirSync(dir, { recursive: true });
  const g = gitAt(dir, T0);
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'f.txt'), 'a\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  for (let i = 0; i < merges; i++) addMerge(dir, i);
  return dir;
}

// One fixture shared by the getUsage equality tests: two byte-identical homes and two byte-identical repos with the same
// basename, so the sync pass and the async pass each start from cold module caches (mergedCache is keyed per repo root).
let shared = null;
function sharedFixture() {
  if (shared) return shared;
  const base = tmp();
  const home1 = path.join(base, 'h1');
  fs.mkdirSync(home1);
  buildHome(home1);
  const home2 = path.join(base, 'h2');
  const home3 = path.join(base, 'h3');
  fs.cpSync(home1, home2, { recursive: true });
  fs.cpSync(home1, home3, { recursive: true });
  const repo1 = buildRepo(path.join(base, 'r1', 'proj'));
  const repo2 = path.join(base, 'r2', 'proj');
  fs.cpSync(repo1, repo2, { recursive: true });
  shared = { base, home1, home2, home3, repo1, repo2 };
  return shared;
}
const NOW = () => T0 + 400 * 3600_000;

// ---------------------------------------------------------------- (a) async pooled git + sliced steps == sync, and the loop yields

test('heap-stall (a): getUsageAsync (async pooled git, sliced steps) equals sync getUsage on a cold cache and yields the loop', async () => {
  const { home1, home2, repo1, repo2 } = sharedFixture();
  clearUsageCache();
  const sync = withRoot(repo1, () => getUsage({ home: home1, now: NOW }));
  clearUsageCache();
  const stop = tickCounter();
  const asyncRes = await withRoot(repo2, () => getUsageAsync({ home: home2, now: NOW, cacheMs: 0 }));
  const ticks = stop();

  assert.equal(sync.files, 620);
  assert.equal(sync.merged.units.filter((u) => !u.fromLedger).length, 8, 'all 8 merges read through the pooled (no injected git) path');
  assert.ok(sync.merged.units.every((u) => u.repo === 'proj'));
  assert.ok(sync.bootSize.length > 0 && sync.autonomy.ownerTouches.total > 0, 'fixture exercises bootSize and autonomy');
  assert.deepEqual(asyncRes, sync, 'async warm + sliced steps produce the same rollup as the single synchronous pass');
  assert.ok(ticks >= 3, `event loop ran ${ticks} setImmediate turns during getUsageAsync (git, stats and log slices are async)`);
});

test('heap-stall (a2): getUsageAsync refreshes pooled git with async execFile only (zero execFileSync on the request path)', async () => {
  const { home3, repo1 } = sharedFixture();
  // A fresh repo copy: its merged units are not cached, so getUsageAsync must spawn rev-parse + 2x log.
  const repo3 = path.join(path.dirname(path.dirname(repo1)), 'r3', 'proj');
  fs.cpSync(repo1, repo3, { recursive: true });
  // Spy on the server's named child_process imports (builtin ESM bindings follow the CJS object after syncBuiltinESMExports).
  const calls = { sync: 0, async: 0 };
  const realSync = cp.execFileSync;
  const realAsync = cp.execFile;
  cp.execFileSync = function (file, ...rest) { if (file === 'git') calls.sync += 1; return realSync.call(this, file, ...rest); };
  cp.execFile = function (file, ...rest) { if (file === 'git') calls.async += 1; return realAsync.call(this, file, ...rest); };
  syncBuiltinESMExports();
  const reset = () => { calls.sync = 0; calls.async = 0; };
  try {
    clearUsageCache();
    let stop = tickCounter();
    let res = await withRoot(repo3, () => getUsageAsync({ home: home3, now: NOW, cacheMs: 0 }));
    let ticks = stop();
    assert.equal(res.merged.units.filter((u) => !u.fromLedger).length, 8);
    assert.equal(calls.sync, 0, 'cold: no synchronous git spawn');
    assert.ok(calls.async >= 3, `cold: rev-parse + log + numstat ran async (${calls.async})`);
    assert.ok(ticks >= 3, `cold: loop turned ${ticks} times`);

    // A new merge, then a request past the 15 s HEAD-check TTL: the new HEAD is rebuilt, still with async git only.
    addMerge(repo3, 8);
    const later = () => NOW() + 60_000;
    reset();
    stop = tickCounter();
    res = await withRoot(repo3, () => getUsageAsync({ home: home3, now: later, cacheMs: 0 }));
    ticks = stop();
    assert.equal(res.merged.units.filter((u) => !u.fromLedger).length, 9, 'new HEAD picked up');
    assert.equal(calls.sync, 0, 'TTL lapse: no synchronous git spawn');
    assert.ok(calls.async >= 3, `TTL lapse: async git (${calls.async})`);
    assert.ok(ticks >= 3, `TTL lapse: loop turned ${ticks} times`);
    reset();
    const sync = withRoot(repo3, () => getUsage({ home: home3, now: later }));
    assert.equal(calls.sync, 0, 'sync getUsage inside the TTL reuses the async-filled caches');
    assert.deepEqual(res, sync, 'same rollup as the sync path on the same state');

    // Control: the spy does see the sync path's git when it is the one refreshing.
    addMerge(repo3, 9);
    reset();
    const sync2 = withRoot(repo3, () => getUsage({ home: home3, now: () => NOW() + 120_000 }));
    assert.equal(sync2.merged.units.filter((u) => !u.fromLedger).length, 10);
    assert.ok(calls.sync >= 3, `sync getUsage past the TTL spawns git synchronously (${calls.sync})`);
  } finally {
    cp.execFileSync = realSync;
    cp.execFile = realAsync;
    syncBuiltinESMExports();
  }
});

// ---------------------------------------------------------------- stepped getUsage == single pass

test('heap-stall: usageSteps drained with a loop turn at every yield equals getUsage (single pass)', async () => {
  const base = tmp();
  const homeA = path.join(base, 'a');
  fs.mkdirSync(homeA);
  buildHome(homeA, { seed: 7, agents: 540 });
  const homeB = path.join(base, 'b');
  fs.cpSync(homeA, homeB, { recursive: true });
  const L = (sha, parents, ct, subject) => [sha, parents, ct, subject].join('\x1f');
  const git = (args) => {
    if (args[0] === 'rev-parse') return 'm3\n';
    if (args[0] === 'log' && !args.includes('--numstat')) {
      return [
        L('m3', 'm2 b3', sec(T0 + 90_000_000), "Merge branch 'unit-u3' [wf:sonnet] (@wik; Review-Gemini R2 PASS)"),
        L('b3', 'm2', sec(T0 + 80_000_000), 'feat: u3 (@wik)'),
        L('m2', 'm1 b2', sec(T0 + 60_000_000), "Merge branch 'unit-u2' [wf:gemini] (@bug)"),
        L('b2', 'm1', sec(T0 + 50_000_000), 'feat: u2 (@bug)'),
        L('m1', 'a1 b1', sec(T0 + 30_000_000), "Merge branch 'unit-u1' (@usa; R1 PASS)"),
        L('b1', 'a1', sec(T0 + 20_000_000), 'feat: u1 (@usa)'),
        L('a1', '', sec(T0), 'init'),
      ].join('\n');
    }
    return '';
  };
  const laneCodes = { usa: 'usage', bug: 'bug', wik: 'wiki' };
  clearUsageCache();
  const single = getUsage({ home: homeA, git, laneCodes, now: NOW });
  clearUsageCache();
  const it = usageTestHooks.usageSteps({ home: homeB, git, laneCodes, now: NOW });
  let steps = 0;
  let r;
  while (!(r = it.next()).done) { steps += 1; await new Promise((ok) => setImmediate(ok)); }
  assert.ok(steps > 20, `getUsage ran as ${steps} steps (crosses the 500-record agent and log step points)`);
  assert.deepEqual(r.value, single);
  assert.equal(single.merged.units.length, 3);
  // getUsageAsync with an injected git (sliced, no result cache) agrees too.
  clearUsageCache();
  assert.deepEqual(await getUsageAsync({ home: homeB, git, laneCodes, now: NOW }), single);
});

// ---------------------------------------------------------------- (b) logLines parse cache: append, partial line, replace, truncate

test('heap-stall (b): the vs-log parse cache picks up appended lines and re-reads a replaced or truncated file', async () => {
  const home = tmp();
  const file = path.join(home, 'logs', 'sq-a--usage.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = (i, role, total) => JSON.stringify({ ts: new Date(T0 + i * 1000).toISOString(), agent: 'p', lane: 'usage', type: 'metric', text: `boot-size role=${role} provider=claude lane=usage chars=${total} total=${total} sys=1 plugin=2 artifact=3 brief=4 first=5 estTok=${total / 4}` }) + '\n';
  const fresh = () => { clearUsageCache(); return readBootSizes(home); };
  const count = (rows, role) => rows.find((g) => g.role === role)?.count ?? 0;

  clearUsageCache();
  fs.writeFileSync(file, line(1, 'worker', 100) + line(2, 'worker', 200) + line(3, 'worker', 300));
  assert.equal(count(readBootSizes(home), 'worker'), 3);

  fs.appendFileSync(file, line(4, 'worker', 400) + line(5, 'worker', 500));
  let got = readBootSizes(home);
  assert.equal(count(got, 'worker'), 5, 'appended lines are folded');
  assert.equal(got[0].avgChars, 300);

  // A partial trailing line is not parsed until its newline lands, and is then counted once (alone, and behind a complete line).
  const tail = line(6, 'worker', 600);
  fs.appendFileSync(file, tail.slice(0, 40));
  assert.equal(count(readBootSizes(home), 'worker'), 5, 'partial line waits for its newline');
  fs.appendFileSync(file, tail.slice(40));
  got = readBootSizes(home);
  assert.equal(count(got, 'worker'), 6, 'completed line counted once');
  const tail2 = line(8, 'worker', 800);
  fs.appendFileSync(file, line(7, 'worker', 700) + tail2.slice(0, 50));
  assert.equal(count(readBootSizes(home), 'worker'), 7, 'complete line read, partial one held back');
  fs.appendFileSync(file, tail2.slice(50));
  got = readBootSizes(home);
  assert.equal(count(got, 'worker'), 8, 'held-back line counted once completed');
  assert.deepEqual(got, fresh());

  // Replaced by a LONGER file with a different head: must not be read as an append from the old offset.
  readBootSizes(home);
  fs.writeFileSync(file, [10, 11, 12, 13, 14, 15, 16, 17].map((i) => line(i, 'lead', 1000 + i)).join(''));
  got = readBootSizes(home);
  assert.equal(count(got, 'worker'), 0, 'old records dropped on a replaced file');
  assert.equal(count(got, 'lead'), 8);
  assert.deepEqual(got, fresh());

  // Truncated to a shorter file (rotation): re-read whole.
  readBootSizes(home);
  fs.writeFileSync(file, line(20, 'reviewer', 50));
  got = readBootSizes(home);
  assert.deepEqual(got.map((g) => [g.role, g.count]), [['reviewer', 1]]);
  assert.deepEqual(got, fresh());

  // File removed: nothing stale survives.
  readBootSizes(home);
  fs.rmSync(file);
  assert.deepEqual(readBootSizes(home), []);
});

test('heap-stall (b2): bounded warm slices over a >1 MB vs log (with a line longer than a slice) parse the same records as one read', async () => {
  const home = buildHome(tmp(), { agents: 3, seed: 3 });
  // Plus a log of boot-size lines only, so any record lost or doubled at a slice boundary changes a count.
  const dense = path.join(home, 'logs', 'sq-a--bug.jsonl');
  let body = '';
  for (let i = 0; i < 9000; i++) {
    body += JSON.stringify({ ts: new Date(T0 + i * 1000).toISOString(), lane: 'bug', type: 'metric', text: `boot-size role=r${i % 5} provider=claude lane=bug total=${1000 + i} sys=${i % 9} estTok=${250 + i} pad=${'p'.repeat(i % 37)}` }) + '\n';
    if (i === 4500) body += JSON.stringify({ ts: new Date(T0).toISOString(), lane: 'bug', type: 'note', text: 'z'.repeat(700 * 1024) }) + '\n';
  }
  fs.writeFileSync(dense, body);
  assert.ok(Buffer.byteLength(body) > 3 * 512 * 1024);
  const noGit = () => '';
  clearUsageCache();
  const expected = readBootSizes(home); // one unbounded read
  assert.equal(expected.filter((g) => g.lane === 'bug' && /^r\d$/.test(g.role)).reduce((n, g) => n + g.count, 0), 9000);
  clearUsageCache();
  const viaWarm = await getUsageAsync({ home, git: noGit, now: NOW }); // warmUsageCaches reads the vs logs in 512 KB slices
  assert.deepEqual(viaWarm.bootSize, expected);
  assert.deepEqual(readBootSizes(home), expected, 'cache left caught up after the sliced warm');
  // Growth after a sliced warm continues from the saved offset.
  fs.appendFileSync(path.join(home, 'logs', 'sq-a--usage.jsonl'), JSON.stringify({ ts: new Date(T0 + 1e9).toISOString(), lane: 'usage', type: 'metric', text: 'boot-size role=scout provider=claude lane=usage total=77' }) + '\n');
  const grown = readBootSizes(home);
  assert.equal(grown.find((g) => g.role === 'scout')?.count, 1);
  clearUsageCache();
  assert.deepEqual(readBootSizes(home), grown);
});

// ---------------------------------------------------------------- (c) 5 s result cache in getUsageAsync

test('heap-stall (c): getUsageAsync reuses a rollup inside the 5 s TTL and recomputes after it; cacheMs and clearUsageCache bypass it', async () => {
  const home = tmp();
  const root = tmp(); // not a git repo: pooled git fails fast and yields no merged units
  const agentFile = path.join(home, 'runner', 'agents', 'rn-1.jsonl');
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  let seq = 0;
  const ev = (e) => JSON.stringify({ seq: seq++, ...e }) + '\n';
  fs.writeFileSync(agentFile, ev({ ts: T0, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'worker', profile: 'Implement - Sonnet' } }) + ev({ ts: T0 + 1, type: 'turn_done', costUsd: 1 }));
  const addTurn = () => fs.appendFileSync(agentFile, ev({ ts: T0 + seq, type: 'turn_done', costUsd: 1 }));
  const turns = (u) => u.totals.turns;

  mock.timers.enable({ apis: ['Date'], now: T0 + 1e9 });
  try {
    await withRoot(root, async () => {
      clearUsageCache();
      assert.equal(turns(await getUsageAsync({ home })), 1);
      addTurn();
      mock.timers.tick(4_000);
      assert.equal(turns(await getUsageAsync({ home })), 1, 'inside the TTL: cached rollup');
      assert.equal(turns(await getUsageAsync({ home, cacheMs: 0 })), 2, 'cacheMs: 0 recomputes');
      assert.equal(turns(await getUsageAsync({ home })), 1, 'cacheMs: 0 did not overwrite the cached entry');
      mock.timers.tick(1_001);
      assert.equal(turns(await getUsageAsync({ home })), 2, 'after 5 s: recomputed');

      addTurn();
      mock.timers.tick(30_000);
      assert.equal(turns(await getUsageAsync({ home, cacheMs: 60_000 })), 2, 'a longer cacheMs still hits at 30 s');
      assert.equal(turns(await getUsageAsync({ home })), 3, 'the default TTL has lapsed at 30 s');

      addTurn();
      assert.equal(turns(await getUsageAsync({ home })), 3, 'fresh entry cached');
      clearUsageCache();
      assert.equal(turns(await getUsageAsync({ home })), 4, 'clearUsageCache drops cached results');

      // The key includes the range: a different `since` is its own entry.
      addTurn();
      assert.equal(turns(await getUsageAsync({ home, since: '2000-01-01' })), 5);
      assert.equal(turns(await getUsageAsync({ home })), 4);
    });
  } finally {
    mock.timers.reset();
  }
  // An injected git never caches (tests and probes see live data).
  clearUsageCache();
  const noGit = () => '';
  assert.equal(turns(await getUsageAsync({ home, git: noGit })), 5);
  addTurn();
  assert.equal(turns(await getUsageAsync({ home, git: noGit })), 6);
});

// ---------------------------------------------------------------- (d) computeAutonomy and attributeImplementer vs the pre-fix algorithms

// Reference: computeAutonomy as of master 6271139 (linear streak + unblock scans), copied verbatim.
const XSQUAD_INPUT_RE = /\bxsquad input\b/i;
const getOrSet = (m, k, mk) => m.get(k) ?? m.set(k, mk()).get(k);
const pctile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null);
const ratio2 = (n, d) => (d ? Math.round((n / d) * 100) / 100 : null);
const isFailDone = (e) => e.type === 'done' && /\bFAIL\b/i.test(e.text);
function planCycles(handoffTs, mergeMs) {
  const hts = [...handoffTs].sort((a, b) => a - b);
  const cycles = [];
  for (let i = 0; i < hts.length; i++) {
    const next = i + 1 < hts.length ? hts[i + 1] : Infinity;
    const last = mergeMs.filter((m) => m >= hts[i] && m < next).at(-1);
    if (last !== undefined) cycles.push(Math.max(0, last - hts[i]));
  }
  return cycles;
}
function computeAutonomyOld(entries, mergedUnits) {
  const touches = entries.filter((e) => e.type === 'needs-you' || e.type === 'you' || (e.type === 'decision' && XSQUAD_INPUT_RE.test(e.text)));
  const needsYou = touches.filter((e) => e.type === 'needs-you').length;
  const you = touches.filter((e) => e.type === 'you').length;
  const handoffEntries = entries.filter((e) => e.type === 'handoff');
  const coverageStart = entries.length ? entries[0].ts : Infinity;
  const merges = mergedUnits.filter((u) => u.mergedAtMs !== null && u.mergedAtMs !== undefined && u.mergedAtMs >= coverageStart).sort((a, b) => a.mergedAtMs - b.mergedAtMs);
  let current = 0, longest = 0, prev = -Infinity;
  for (const m of merges) {
    if (touches.some((e) => e.ts > prev && e.ts <= m.mergedAtMs)) current = 0;
    else current += 1;
    longest = Math.max(longest, current);
    prev = m.mergedAtMs;
  }
  const stalls = entries.filter((e) => e.type === 'blocker' || isFailDone(e));
  const unblock = [];
  for (const s of entries.filter((e) => e.type === 'blocker' || e.type === 'needs-you' || isFailDone(e))) {
    let best = null;
    for (const e of entries) {
      if (e.ts <= s.ts || e.lane !== s.lane) continue;
      if (e.type === 'decision' || (e.type === 'done' && /\bPASS\b/i.test(e.text) && !/\bFAIL\b/i.test(e.text))) { best = e.ts; break; }
    }
    for (const m of merges) if (m.lane === s.lane && m.mergedAtMs > s.ts) { if (best === null || m.mergedAtMs < best) best = m.mergedAtMs; break; }
    if (best !== null) unblock.push(best - s.ts);
  }
  unblock.sort((a, b) => a - b);
  const handoffsByLane = new Map();
  for (const h of handoffEntries) getOrSet(handoffsByLane, h.lane, () => []).push(h.ts);
  const cycles = [];
  for (const [lane, hts] of handoffsByLane) cycles.push(...planCycles(hts, merges.filter((m) => m.lane === lane).map((m) => m.mergedAtMs)));
  return {
    ownerTouches: {
      total: touches.length, needsYou, you, xsquadInput: touches.length - needsYou - you,
      perMergedUnit: ratio2(touches.length, merges.length), unitsPerOwnerTouch: merges.length ? ratio2(merges.length, touches.length) : null, perHandoff: ratio2(touches.length, handoffEntries.length),
    },
    unassistedStreak: { current, longest },
    stalls: {
      total: stalls.length, blockers: stalls.filter((e) => e.type === 'blocker').length, failRuns: stalls.filter(isFailDone).length,
      medianUnblockMs: pctile(unblock, 0.5), p90UnblockMs: pctile(unblock, 0.9),
    },
    planAutonomy: {
      handoffs: handoffEntries.length, mergedUnits: merges.length, unitsPerHandoff: ratio2(merges.length, handoffEntries.length),
      avgPlanCycleMs: cycles.length ? Math.round(cycles.reduce((s, c) => s + c, 0) / cycles.length) : null,
    },
  };
}

test('heap-stall (d): binary-search computeAutonomy equals the old linear scans over random entries and merges (ties, lanes, nulls)', () => {
  const types = ['needs-you', 'you', 'decision', 'blocker', 'done', 'handoff', 'note', 'metric'];
  const doneTexts = ['PASS 3/3', 'FAIL 1/3', 'PASS but FAIL on retry', 'pass', 'ok'];
  let nonTrivial = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const lanes = ['a', 'b', 'c', ''].slice(0, 1 + Math.floor(r() * 4));
    const n = Math.floor(r() * 120);
    const step = 1 + Math.floor(r() * 5); // small steps -> many equal timestamps
    let ts = T0;
    const entries = [];
    for (let i = 0; i < n; i++) {
      ts += Math.floor(r() * step) * 1000; // may stay equal (ties)
      const type = pick(r, types);
      const text = type === 'done' ? pick(r, doneTexts) : type === 'decision' && r() < 0.4 ? 'xsquad input: ship it' : `t${i}`;
      entries.push({ ts, lane: pick(r, lanes), type, text, squad: 'sq' });
    }
    const span = Math.max(1, ts - T0);
    const merged = [];
    const m = Math.floor(r() * 40);
    for (let i = 0; i < m; i++) {
      const roll = r();
      let mergedAtMs;
      if (roll < 0.05) mergedAtMs = null;
      else if (roll < 0.08) mergedAtMs = undefined;
      else if (roll < 0.35 && entries.length) mergedAtMs = pick(r, entries).ts; // exactly on an entry ts
      else mergedAtMs = T0 - span * 0.1 + Math.floor(r() * span * 1.2); // some before coverage start
      merged.push({ lane: r() < 0.1 ? null : pick(r, lanes), mergedAtMs, reviewRounds: Math.floor(r() * 3) });
    }
    const expected = computeAutonomyOld(entries, merged.map((x) => ({ ...x })));
    const actual = usageTestHooks.computeAutonomy(entries, merged.map((x) => ({ ...x })));
    assert.deepEqual(actual, expected, `seed ${seed}`);
    if (expected.stalls.medianUnblockMs !== null && expected.unassistedStreak.longest > 0) nonTrivial += 1;
  }
  assert.ok(nonTrivial > 50, `${nonTrivial} seeds hit both unblock and streak paths`);
});

// Reference: attributeImplementer as of master 6271139 (filters every agent run per unit), with its helpers.
function normalizeWorktreeCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '';
  return cwd.trim().replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`).replace(/\/+$/, '');
}
const unitNameOfCwd = (cwd) => {
  const norm = normalizeWorktreeCwd(cwd);
  const idx = norm.lastIndexOf('/');
  return norm ? (idx >= 0 ? norm.slice(idx + 1) : norm).toLowerCase() : '';
};
const NON_IMPLEMENTER_PROFILE_RE = /^(?:Review|Pre-check|Check|Audit|Scout|Art Director|Planner|Spec)\b/i;
const REVIEWER_TITLE_RE = /\b(?:re-?review|reviewer)\b|(?:^|[·:\s])review(?:\s|$)/i;
function isImplementerWorker(a) {
  if (a.role !== 'worker') return false;
  if (a.roleOnly) return false;
  if (NON_IMPLEMENTER_PROFILE_RE.test(a.profile || '')) return false;
  if (REVIEWER_TITLE_RE.test(a.title || '') && !/\breview\s+fix/i.test(a.title || '')) return false;
  return true;
}
const sameSquad = (unit, agent) => !unit.squad || !agent.team || unit.squad === agent.team;
const tsMs = (v) => { if (v === null || v === undefined) return null; const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? t : null; };
function attributeImplementerOld(unit, agents) {
  const mergedAtMs = tsMs(unit.mergedAt);
  if (typeof unit.unit === 'string' && unit.unit) {
    const want = unit.unit.toLowerCase();
    const cwdMatches = agents.filter((a) => a.role === 'worker' && unitNameOfCwd(a.cwd) === want && sameSquad(unit, a));
    if (cwdMatches.length === 1) return cwdMatches[0];
    if (cwdMatches.length > 1) {
      const impls = cwdMatches.filter(isImplementerWorker);
      if (impls.length === 1) return impls[0];
      if (impls.length > 1) {
        const profiles = new Set(impls.map((a) => `${a.provider}|${a.profile}`));
        if (profiles.size === 1) return impls.slice().sort((x, y) => (x.createdAt ?? Infinity) - (y.createdAt ?? Infinity))[0];
      }
      return null;
    }
  }
  if (!unit.lane || mergedAtMs === null) return null;
  const laneWorkers = agents.filter((a) => a.role === 'worker' && a.lane === unit.lane && sameSquad(unit, a) && a.createdAt !== null && a.createdAt <= mergedAtMs);
  if (laneWorkers.length === 1) return laneWorkers[0];
  const laneImpls = laneWorkers.filter(isImplementerWorker);
  return laneImpls.length === 1 ? laneImpls[0] : null;
}

test('heap-stall (d2): indexed attributeImplementer picks the same run as the old per-unit filter over random agents and units', () => {
  const cwds = (u) => [`C:\\wt\\VibeSquad\\${u}\\`, `c:/wt/VibeSquad/${u.toUpperCase()}`, `/home/x/wt/${u}/`, `C:\\wt\\Other\\${u}`, ''];
  let attributed = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed);
    const unitNames = ['unit-a', 'unit-b', 'unit-c', 'unit-d'];
    const agents = [];
    const nAgents = Math.floor(r() * 40);
    for (let i = 0; i < nAgents; i++) {
      agents.push({
        agentId: `rn-${seed}-${i}`,
        role: r() < 0.8 ? 'worker' : pick(r, ['lead', 'brainstorm']),
        cwd: r() < 0.9 ? pick(r, cwds(pick(r, unitNames))) : undefined,
        lane: r() < 0.9 ? pick(r, ['usage', 'bug', 'wiki']) : null,
        team: r() < 0.3 ? null : pick(r, ['sq-a', 'sq-b']),
        createdAt: r() < 0.1 ? null : T0 + Math.floor(r() * 100) * 1000,
        provider: pick(r, ['claude', 'antigravity-cli']),
        profile: pick(r, ['Implement - Sonnet', 'Implement - Sonnet', 'Review - Gemini', 'Pre-check - Flash', 'Work Order - DSP']),
        title: pick(r, ['Usa1 · impl', 'Usa1 · review impl', 'review fix pass', 'reviewer', '']),
        roleOnly: r() < 0.05,
      });
    }
    for (let k = 0; k < 12; k++) {
      const unit = {
        unit: r() < 0.85 ? pick(r, [...unitNames, 'unit-none', 'UNIT-A']) : null,
        lane: r() < 0.85 ? pick(r, ['usage', 'bug', 'wiki']) : null,
        squad: r() < 0.4 ? null : pick(r, ['sq-a', 'sq-b']),
        mergedAt: r() < 0.1 ? null : new Date(T0 + Math.floor(r() * 120) * 1000).toISOString(),
      };
      const expected = attributeImplementerOld(unit, agents);
      assert.equal(usageTestHooks.attributeImplementer(unit, agents), expected, `seed ${seed} unit ${k}`);
      if (expected) attributed += 1;
    }
  }
  assert.ok(attributed > 200, `${attributed} units attributed (cwd and lane-fallback paths both hit)`);
});

// ---------------------------------------------------------------- idea-240 lows

test('idea-240 L2: a deleted vs log is dropped from the parse cache on the next warm', async () => {
  const home = tmp();
  const root = tmp();
  const a = path.join(home, 'logs', 'sq-a--one.jsonl');
  const b = path.join(home, 'logs', 'sq-a--two.jsonl');
  fs.mkdirSync(path.dirname(a), { recursive: true });
  const row = JSON.stringify({ ts: new Date(T0).toISOString(), lane: 'usage', type: 'note', text: 'x' }) + '\n';
  fs.writeFileSync(a, row); fs.writeFileSync(b, row);
  await withRoot(root, async () => {
    clearUsageCache();
    await getUsageAsync({ home, cacheMs: 0 });
    assert.equal(usageStats().logFiles, 2);
    fs.rmSync(b);
    await getUsageAsync({ home, cacheMs: 0 });
    assert.equal(usageStats().logFiles, 1, 'removed log forgotten');
  });
});

test('idea-240 L3: result-cache TTL follows opts.now; clearUsageCache resets the HEAD-check cache', async () => {
  const home = tmp();
  const root = tmp();
  const agentFile = path.join(home, 'runner', 'agents', 'rn-1.jsonl');
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  let seq = 0;
  const ev = (e) => JSON.stringify({ seq: seq++, ...e }) + '\n';
  fs.writeFileSync(agentFile, ev({ ts: T0, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'worker' } }) + ev({ ts: T0 + 1, type: 'turn_done', costUsd: 1 }));
  let t = T0;
  const now = () => t;
  await withRoot(root, async () => {
    clearUsageCache();
    assert.equal((await getUsageAsync({ home, now })).totals.turns, 1);
    fs.appendFileSync(agentFile, ev({ ts: T0 + 5, type: 'turn_done', costUsd: 1 }));
    t += 1_000;
    assert.equal((await getUsageAsync({ home, now })).totals.turns, 1, 'injected clock inside TTL: cached');
    t += 6_000;
    assert.equal((await getUsageAsync({ home, now })).totals.turns, 2, 'injected clock past TTL: recomputed');
  });
});
