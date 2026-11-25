// idea-909 (O3 follow-up, idea-896): runner GET /health live breakdown by provider × state,
// per-agent rows with process count, and read-only orphan provider process reporting.
import './helpers/clean-env.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createServer } from '../runner/server.mjs';
import {
  HELD_CMD_MAX,
  buildHealthLiveDiag,
  createHealthSnapshotCache,
  formatHeldCmd,
  matchProviderProcess,
  redactCmdSecrets,
} from '../runner/health-diag.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test('buildHealthLiveDiag: counts by provider × state, per-agent procCount, truncated heldCmd, and orphan detection', () => {
  const now = Date.parse('2026-11-25T20:00:00Z');
  const longCmd = `bash -c -l "source /tmp/snap && eval 'npm test -- --queue ${'x'.repeat(200)}' < /dev/null && pwd -P >| /tmp/claude-1234-cwd"`;

  // Fake runner state with mixed providers (including agy alias -> antigravity-cli) and all 3 states.
  const live = new Map([
    ['rn-c1', { provider: 'claude', status: 'running', inflight: 1, handle: { pid: 1001 }, heldSince: null, perms: new Set() }],
    ['rn-c2', { provider: 'claude', status: 'idle', inflight: 0, handle: { pid: 1002 }, heldSince: now - 30_000, perms: new Set() }],
    ['rn-o1', { provider: 'opencode', status: 'running', inflight: 1, handle: { pid: 2001 }, heldSince: null, perms: new Set() }],
    ['rn-o2', { provider: 'opencode', status: 'idle', inflight: 0, handle: { pid: 2002 }, heldSince: null, perms: new Set() }],
    ['rn-a1', { provider: 'agy', status: 'starting', inflight: 0, handle: { pid: 3001 }, heldSince: null, perms: new Set() }],
    ['rn-a2', { provider: 'antigravity-cli', status: 'idle', inflight: 0, handle: { pid: 3002 }, heldSince: null, perms: new Set() }],
  ]);

  // rn-o2 is in the post-turn probe window (_bgHeldNow true, no shell recorded yet); rn-a2 is idle-unparked.
  const fakeRunner = {
    live,
    _bgHeldNow: (id) => id === 'rn-c2' || id === 'rn-o2',
    heldIds: () => ['rn-c2', 'rn-o2'],
    heldWork: () => ({
      'rn-c2': [{ pid: 1020, name: 'bash', cmd: longCmd }],
      'rn-o2': [],
    }),
  };

  const procs = [
    // rn-c1 (claude, 2 procs: cli + mcp sidecar)
    { pid: 1001, ppid: 500, name: 'claude', cmd: 'claude -p --input-format stream-json', createdMs: now - 60_000 },
    { pid: 1011, ppid: 1001, name: 'node', cmd: 'node server/mcp/server.mjs', createdMs: now - 59_000 },
    // rn-c2 (claude, 2 procs: cli + held bash)
    { pid: 1002, ppid: 500, name: 'claude', cmd: 'claude -p --input-format stream-json', createdMs: now - 60_000 },
    { pid: 1020, ppid: 1002, name: 'bash', cmd: longCmd, createdMs: now - 30_000 },
    // PID-reuse stranger claiming ppid=1002 but created BEFORE 1002 -> must NOT be counted under rn-c2
    { pid: 1099, ppid: 1002, name: 'sleep', cmd: 'sleep 999', createdMs: now - 120_000 },
    // rn-o1 (opencode, 3 procs: wrapper -> opencode acp -> opencode serve)
    { pid: 2001, ppid: 500, name: 'opencode', cmd: 'opencode acp', createdMs: now - 40_000 },
    { pid: 2011, ppid: 2001, name: 'opencode', cmd: 'opencode serve --port 4100', createdMs: now - 39_000 },
    { pid: 2012, ppid: 2011, name: 'node', cmd: 'node server/mcp/server.mjs', createdMs: now - 38_000 },
    // rn-o2 (opencode, 1 proc)
    { pid: 2002, ppid: 500, name: 'opencode', cmd: 'opencode acp', createdMs: now - 20_000 },
    // rn-a1 (agy, 1 proc)
    { pid: 3001, ppid: 500, name: 'agy', cmd: 'agy acp', createdMs: now - 10_000 },
    // rn-a2 (antigravity-cli, 1 proc)
    { pid: 3002, ppid: 500, name: 'agy', cmd: 'agy acp', createdMs: now - 10_000 },
    // Orphan provider processes (no owning live agent)
    { pid: 26246, ppid: 1, name: 'opencode', cmd: 'opencode serve --service', createdMs: now - 172_800_000 },
    { pid: 26300, ppid: 1, name: 'claude', cmd: 'claude -p --output-format stream-json', createdMs: now - 3_600_000 },
    // Non-provider / interactive processes that must NOT be flagged as orphans
    { pid: 500, ppid: 1, name: 'node', cmd: 'node runner/server.mjs', createdMs: now - 500_000 },
    { pid: 9001, ppid: 1, name: 'bash', cmd: 'bash -c "ps aux | grep opencode"', createdMs: now - 5_000 },
    { pid: 9002, ppid: 1, name: 'claude', cmd: 'claude', createdMs: now - 10_000 }, // interactive owner session
  ];

  const diag = buildHealthLiveDiag(fakeRunner, { procs, now });

  assert.deepEqual(diag.liveByProvider, {
    claude: { running: 1, 'idle-held': 1, 'idle-unparked': 0, total: 2 },
    opencode: { running: 1, 'idle-held': 1, 'idle-unparked': 0, total: 2 },
    'antigravity-cli': { running: 1, 'idle-held': 0, 'idle-unparked': 1, total: 2 },
  });

  const byId = Object.fromEntries(diag.liveAgents.map((a) => [a.id, a]));
  assert.deepEqual(byId['rn-c1'], { id: 'rn-c1', provider: 'claude', state: 'running', procCount: 2 });
  assert.equal(byId['rn-c2'].state, 'idle-held');
  assert.equal(byId['rn-c2'].procCount, 2, 'PID-reuse stranger not counted in subtree');
  assert.equal(typeof byId['rn-c2'].heldCmd, 'string');
  assert.ok(byId['rn-c2'].heldCmd.length <= HELD_CMD_MAX, 'heldCmd truncated to HELD_CMD_MAX');
  assert.ok(!byId['rn-c2'].heldCmd.includes('pwd -P >|'), 'Claude wrapper tail stripped');

  assert.deepEqual(byId['rn-o1'], { id: 'rn-o1', provider: 'opencode', state: 'running', procCount: 3 });
  assert.deepEqual(byId['rn-o2'], { id: 'rn-o2', provider: 'opencode', state: 'idle-held', procCount: 1, heldCmd: null });
  assert.deepEqual(byId['rn-a1'], { id: 'rn-a1', provider: 'antigravity-cli', state: 'running', procCount: 1 });
  assert.deepEqual(byId['rn-a2'], { id: 'rn-a2', provider: 'antigravity-cli', state: 'idle-unparked', procCount: 1 });

  // Owned opencode serve (pid 2011) is NOT in orphans; orphan pid 26246 & 26300 ARE.
  assert.deepEqual(diag.orphanProviderProcs, [
    { pid: 26246, ppid: 1, provider: 'opencode', cmd: 'opencode serve --service', ageSec: 172_800 },
    { pid: 26300, ppid: 1, provider: 'claude', cmd: 'claude -p --output-format stream-json', ageSec: 3_600 },
  ]);
});

test('matchProviderProcess: matches supported provider launchers and ignores unrelated commands', () => {
  assert.equal(matchProviderProcess({ name: 'opencode', cmd: 'opencode serve --service' }), 'opencode');
  assert.equal(matchProviderProcess({ name: 'opencode.exe', cmd: 'C:\\bin\\opencode.exe acp' }), 'opencode');
  assert.equal(matchProviderProcess({ name: 'node', cmd: 'node /opt/opencode/bin/opencode.mjs serve' }), 'opencode');
  assert.equal(matchProviderProcess({ name: 'claude', cmd: 'claude -p --input-format stream-json' }), 'claude');
  assert.equal(matchProviderProcess({ name: 'claude', cmd: 'claude' }), null);
  assert.equal(matchProviderProcess({ name: 'agy', cmd: 'agy acp' }), 'antigravity-cli');
  assert.equal(matchProviderProcess({ name: 'agy', cmd: 'agy -p /usage' }), null);
  assert.equal(matchProviderProcess({ name: 'npx', cmd: 'npx -y @zed-industries/codex-acp' }), 'codex');
  assert.equal(matchProviderProcess({ name: 'bash', cmd: 'bash -c "rg opencode runner/"' }), null);
  assert.equal(matchProviderProcess({ name: 'node', cmd: 'node test/runner-health-live.test.mjs' }), null);
});

test('buildHealthLiveDiag: degrades cleanly when process snapshot is unavailable (procs=null)', () => {
  const fakeRunner = {
    live: new Map([
      ['rn-1', { provider: 'claude', status: 'running', inflight: 1, handle: { pid: 100 }, heldSince: null, perms: new Set() }],
    ]),
  };
  const diag = buildHealthLiveDiag(fakeRunner, { procs: null });
  assert.deepEqual(diag.liveByProvider, { claude: { running: 1, 'idle-held': 0, 'idle-unparked': 0, total: 1 } });
  assert.deepEqual(diag.liveAgents, [{ id: 'rn-1', provider: 'claude', state: 'running', procCount: null }]);
  assert.deepEqual(diag.orphanProviderProcs, []);
  assert.equal(formatHeldCmd([]), null);
});

test('createHealthSnapshotCache: coalesces concurrent calls, caches within TTL, and returns null on error', async () => {
  let clock = 1_000;
  let calls = 0;
  const fakeProcs = [{ pid: 1, ppid: 0, name: 'init', cmd: 'init' }];
  const get = createHealthSnapshotCache({
    snapshot: async () => {
      calls += 1;
      return fakeProcs;
    },
    ttlMs: 10_000,
    now: () => clock,
  });

  // Concurrent calls coalesce into 1 snapshot.
  const [a, b] = await Promise.all([get(), get()]);
  assert.equal(calls, 1);
  assert.deepEqual(a, fakeProcs);
  assert.deepEqual(b, fakeProcs);

  // Within TTL: cached.
  clock += 5_000;
  assert.deepEqual(await get(), fakeProcs);
  assert.equal(calls, 1);

  // Past TTL: refreshed.
  clock += 6_000;
  assert.deepEqual(await get(), fakeProcs);
  assert.equal(calls, 2);

  // Failure is cached for failTtlMs so a broken ps doesn't retry on every /health call, then retries after failTtlMs.
  let failClock = 1_000;
  let failCalls = 0;
  const failing = createHealthSnapshotCache({
    snapshot: async () => {
      failCalls += 1;
      throw new Error('boom');
    },
    failTtlMs: 5_000,
    now: () => failClock,
  });
  assert.equal(await failing(), null);
  assert.equal(failCalls, 1);
  failClock += 2_000;
  assert.equal(await failing(), null);
  assert.equal(failCalls, 1, 'failure cached within failTtlMs');
  failClock += 4_000;
  assert.equal(await failing(), null);
  assert.equal(failCalls, 2, 'retries after failTtlMs');
});

test('redactCmdSecrets: redacts flags, leading env prefixes, and Bearer tokens in heldCmd and orphan cmd', () => {
  assert.equal(
    redactCmdSecrets('API_KEY=sk-123 DB_PASS="p@ss word" curl -H "Authorization: Bearer tok_abc.xyz" --auth-token=secret1 --api-key secret2 --client-secret=\'s3\' --password mypw https://example.test'),
    'API_KEY=[REDACTED] DB_PASS=[REDACTED] curl -H "Authorization: Bearer [REDACTED]" --auth-token=[REDACTED] --api-key [REDACTED] --client-secret=[REDACTED] --password [REDACTED] https://example.test',
  );

  const held = formatHeldCmd([{ pid: 10, name: 'bash', cmd: 'TOKEN=abc123 curl -H "Authorization: Bearer live_tok" --api-key=k999 http://127.0.0.1' }]);
  assert.ok(!held.includes('abc123') && !held.includes('live_tok') && !held.includes('k999'), `heldCmd leaked secret: ${held}`);
  assert.ok(held.includes('TOKEN=[REDACTED]') && held.includes('Bearer [REDACTED]') && held.includes('--api-key=[REDACTED]'));

  const fakeRunner = {
    live: new Map([
      ['rn-1', { provider: 'claude', status: 'idle', inflight: 0, handle: { pid: 100 }, heldSince: Date.now() - 1000, perms: new Set() }],
    ]),
    _bgHeldNow: () => true,
    heldWork: () => ({ 'rn-1': [{ pid: 101, name: 'bash', cmd: 'SECRET_KEY=topsecret npm test -- --token=t123' }] }),
  };
  const diag = buildHealthLiveDiag(fakeRunner, {
    procs: [
      { pid: 100, ppid: 1, name: 'claude', cmd: 'claude -p --input-format stream-json' },
      { pid: 26246, ppid: 1, name: 'opencode', cmd: 'OPENCODE_API_KEY=sk-orphan opencode serve --api-key sk-flag --token="Bearer b999"' },
    ],
  });
  assert.ok(!diag.liveAgents[0].heldCmd.includes('topsecret') && !diag.liveAgents[0].heldCmd.includes('t123'));
  const orphanCmd = diag.orphanProviderProcs[0].cmd;
  assert.ok(!orphanCmd.includes('sk-orphan') && !orphanCmd.includes('sk-flag') && !orphanCmd.includes('b999'), `orphan cmd leaked secret: ${orphanCmd}`);
  assert.ok(orphanCmd.includes('OPENCODE_API_KEY=[REDACTED]') && orphanCmd.includes('--api-key [REDACTED]'));
});

test('GET /health on runner server exposes liveByProvider, liveAgents, and orphanProviderProcs', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vs-health-live-'));
  dirs.push(dir);
  const ems = new Map();
  let nextPid = 4100;
  const makeAdapter = (canPark) => ({
    canPark,
    start({ id, emit }) {
      const pid = nextPid++;
      ems.set(id, { emit, pid });
      return { pid, send() { emit('status', { status: 'running' }); }, cancel() {}, kill() {} };
    },
  });

  const runner = new Runner({
    dir,
    adapters: { claude: makeAdapter(true), opencode: makeAdapter(true), agy: makeAdapter(false) },
    parkGraceMs: 60_000,
    parkHoldPollMs: 60_000,
    bgProbe: async () => [],
    pidAlive: () => true,
    killPid: () => {},
  });
  t.after(() => runner.shutdown());

  const idClaude = runner.create({ provider: 'claude', cwd: os.tmpdir(), prompt: 'run' });
  const idOpen = runner.create({ provider: 'opencode', cwd: os.tmpdir(), prompt: 'hold' });
  const idAgy = runner.create({ provider: 'agy', cwd: os.tmpdir(), prompt: 'idle' });
  ems.get(idClaude).emit('session', { sessionId: 's-c' });
  ems.get(idOpen).emit('session', { sessionId: 's-o' });
  ems.get(idAgy).emit('session', { sessionId: 's-a' });

  // Move idOpen to idle-held with a live shell, and idAgy to idle-unparked (canPark=false).
  ems.get(idOpen).emit('turn_done', {});
  ems.get(idOpen).emit('status', { status: 'idle' });
  const openEntry = runner.live.get(idOpen);
  openEntry.heldSince = Date.now() - 10_000;
  openEntry.heldNow = [{ pid: 9500, name: 'bash', cmd: 'npm run test:unit' }];

  ems.get(idAgy).emit('turn_done', {});
  ems.get(idAgy).emit('status', { status: 'idle' });

  const pClaude = ems.get(idClaude).pid;
  const pOpen = ems.get(idOpen).pid;
  const pAgy = ems.get(idAgy).pid;
  const fakeProcs = [
    { pid: pClaude, ppid: process.pid, name: 'claude', cmd: 'claude -p --input-format stream-json' },
    { pid: pOpen, ppid: process.pid, name: 'opencode', cmd: 'opencode acp' },
    { pid: pOpen + 100, ppid: pOpen, name: 'opencode', cmd: 'opencode serve --port 4200' },
    { pid: 9500, ppid: pOpen, name: 'bash', cmd: 'npm run test:unit' },
    { pid: pAgy, ppid: process.pid, name: 'agy', cmd: 'agy acp' },
    { pid: 26246, ppid: 1, name: 'opencode', cmd: 'opencode serve --service' },
  ];

  const server = createServer(runner, { token: 'test-tok', processSnapshot: async () => fakeProcs });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: 'Bearer test-tok' } });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.equal(body.live, 3);
  assert.equal(body.running, 1);
  assert.equal(body.held, 1);

  assert.deepEqual(body.liveByProvider, {
    claude: { running: 1, 'idle-held': 0, 'idle-unparked': 0, total: 1 },
    opencode: { running: 0, 'idle-held': 1, 'idle-unparked': 0, total: 1 },
    'antigravity-cli': { running: 0, 'idle-held': 0, 'idle-unparked': 1, total: 1 },
  });

  const rows = Object.fromEntries(body.liveAgents.map((r) => [r.id, r]));
  assert.deepEqual(rows[idClaude], { id: idClaude, provider: 'claude', state: 'running', procCount: 1 });
  assert.deepEqual(rows[idOpen], { id: idOpen, provider: 'opencode', state: 'idle-held', procCount: 3, heldCmd: 'npm run test:unit' });
  assert.deepEqual(rows[idAgy], { id: idAgy, provider: 'antigravity-cli', state: 'idle-unparked', procCount: 1 });

  assert.deepEqual(body.orphanProviderProcs, [
    { pid: 26246, ppid: 1, provider: 'opencode', cmd: 'opencode serve --service' },
  ]);
});
