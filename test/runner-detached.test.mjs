// idea-697: detached background work (`nohup x > log &`, setsid, `(x &)` in a FOREGROUND shell call) leaves the agent CLI's
// tree at once. During a drain the runner scans for it (work started after the drain began is refused, older work goes to
// the ledger), /shutdown records the ledger, and the next boot tree-kills only ledger entries that provably are still that
// work. The claude drain hook refuses a foreground command that backgrounds itself. No real process is ever killed here.
import "./helpers/clean-env.mjs";
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { sha256 } from '../runner/reap.mjs';
import { createDetachedProbe, DETACHED_FILE, detachedCandidates, detachedSupported, parsePsDetached, planDetached, planLedgerReap, readDetachedLedger, writeDetachedLedger } from '../runner/detached.mjs';
import { drainDetachRefusalText, drainHookDecision, selfBackgrounds } from '../runner/drain-hook.mjs';
import { backgroundWork, parsePs, snapshotProcesses } from '../runner/background.mjs';
import { detachedReporter } from '../runner/server.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-detached-')); dirs.push(d); return d; };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// ---- planDetached / planLedgerReap (pure) ----------------------------------------------------------------------------

const T = 5_000_000;
const W1 = { agentId: 'w1', tokenSha: sha256('tok-w1') };
const W2 = { agentId: 'w2', tokenSha: sha256('tok-w2') };
const agents = new Map([[W1.tokenSha, 'w1'], [W2.tokenSha, 'w2']]);
// systemd --user (no marker) <- nohup bash suite (w1) <- godot (w1); the w1 CLI (100) with an in-tree shell (101).
const table = () => [
  { pid: 1, ppid: 0, name: 'systemd', cmd: '/sbin/init', createdMs: 1000 },
  { pid: 900, ppid: 1, name: 'systemd', cmd: '/usr/lib/systemd/systemd --user', createdMs: 2000 },
  { pid: 100, ppid: 900, name: 'opencode', cmd: 'opencode run', createdMs: T },
  { pid: 101, ppid: 100, name: 'bash', cmd: 'bash -c npm test', createdMs: T + 100 },
  { pid: 500, ppid: 900, name: 'bash', cmd: 'bash ./run-suite.sh', createdMs: T + 1000 },
  { pid: 501, ppid: 500, name: 'godot', cmd: 'godot --headless -s suite.gd', createdMs: T + 1100 },
];
const marks = () => new Map([[100, W1], [101, W1], [500, W1], [501, W1], [900, { agentId: null, tokenSha: null }]]);

test('planDetached: one entry per topmost detached root, never the CLI tree', () => {
  const out = planDetached({ procs: table(), markers: marks(), agents, cliPids: [100], protectedPids: [] });
  assert.equal(out.length, 1);
  assert.equal(out[0].root, 500);
  assert.equal(out[0].agentId, 'w1');
  assert.deepEqual(out[0].pids.map((p) => p.pid).sort(), [500, 501]);
  assert.equal(out[0].createdMs, T + 1000);
});

test('planDetached: unknown token, mismatched id, unreadable env, protected pid and the runtime are never work', () => {
  const base = { procs: table(), cliPids: [100], protectedPids: [] };
  const only = (m) => new Map([...marks(), ...m]);
  assert.deepEqual(planDetached({ ...base, agents, markers: only([[500, { agentId: 'w1', tokenSha: sha256('old') }], [501, { agentId: 'w1', tokenSha: sha256('old') }]]) }), [], 'a token not of this lifetime');
  assert.deepEqual(planDetached({ ...base, agents, markers: only([[500, { ...W1, agentId: 'w2' }], [501, { ...W1, agentId: 'w2' }]]) }), [], 'id does not match the token');
  assert.deepEqual(planDetached({ ...base, agents, markers: only([[500, { error: 'open' }], [501, { error: 'env' }]]) }), [], 'env unreadable');
  assert.deepEqual(planDetached({ ...base, agents, markers: marks(), protectedPids: [500] }), [], 'a protected root and what is under it');
  const rt = table().map((p) => (p.pid === 500 ? { ...p, cmd: 'node /x/runner/server.mjs --home h' } : p));
  assert.deepEqual(planDetached({ ...base, procs: rt, agents, markers: marks() }), [], 'the VS runtime');
  // The CLI tree's shell carries the token too but is background.mjs's (park hold), not detached.
  assert.ok(!planDetached({ ...base, agents, markers: marks() }).some((e) => e.root === 101 || e.root === 100));
  // Without the CLI pid the CLI itself would be "detached": the runner always passes its live CLI pids.
  assert.deepEqual(detachedCandidates({ procs: table(), cliPids: [100], since: T + 500 }).sort(), [500, 501]);
});

test('planDetached: a chain broken by a process without the marker stays one entry (topmost)', () => {
  const procs = [...table(), { pid: 502, ppid: 501, name: 'sh', cmd: 'sh -c x', createdMs: T + 1200 }];
  const m = marks();
  m.set(501, { agentId: null, tokenSha: null }); // env -i in the middle
  m.set(502, W1);
  const out = planDetached({ procs, markers: m, agents, cliPids: [100] });
  assert.deepEqual(out.map((e) => e.root), [500]);
  assert.deepEqual(out[0].pids.map((p) => p.pid).sort(), [500, 501, 502]);
});

const ledgerOf = (over = {}) => ({ agentId: 'w1', tokenSha: W1.tokenSha, root: 500, pgid: 500, createdMs: T + 1000, cmd: 'bash ./run-suite.sh', ...over });
const lbase = (over = {}) => ({ procs: table(), markers: marks(), ledger: [ledgerOf()], cliPids: [100], protectedPids: [], currentShas: new Set(), knownIds: new Set(['w1', 'w2']), ...over });

test('planLedgerReap: a verified entry is reaped with its live tree; a vanished root is gone', () => {
  const r = planLedgerReap(lbase());
  assert.equal(r.reap.length, 1);
  assert.deepEqual(r.reap[0].pids.map((p) => p.pid).sort(), [500, 501]);
  assert.deepEqual(r.left, [], 'claimed pids are never "left"');
  const g = planLedgerReap(lbase({ procs: table().filter((p) => p.pid !== 500 && p.pid !== 501) }));
  assert.equal(g.gone.length, 1);
  assert.equal(g.reap.length, 0);
});

test('planLedgerReap: pid reuse, mismatched marker, unreadable or unread env, live tree, runtime are skipped (fail closed)', () => {
  const reason = (over) => { const r = planLedgerReap(lbase(over)); assert.equal(r.reap.length, 0); return r.skipped.map((s) => s.reason); };
  assert.deepEqual(reason({ ledger: [ledgerOf({ createdMs: T + 1000 - 10_000 })] }), ['pid-changed'], 'pid reuse');
  assert.deepEqual(reason({ markers: new Map([...marks(), [500, W2]]) }), ['marker-mismatch'], 'another agent');
  assert.deepEqual(reason({ markers: new Map([...marks(), [500, { agentId: 'w1', tokenSha: sha256('other') }]]) }), ['marker-mismatch'], 'same id, other token');
  assert.deepEqual(reason({ markers: new Map([...marks(), [500, { error: 'open' }]]) }), ['env-unreadable:open']);
  const noEnv = marks(); noEnv.delete(500);
  assert.deepEqual(reason({ markers: noEnv }), ['env-not-read']);
  assert.deepEqual(reason({ cliPids: [900] }), ['in-live-tree'], 'under a live CLI');
  assert.deepEqual(reason({ protectedPids: [501] }), ['live-tree-inside']);
  assert.deepEqual(reason({ procs: table().map((p) => (p.pid === 501 ? { ...p, cmd: 'node scripts/serve.mjs' } : p)) }), ['vs-runtime']);
  assert.deepEqual(reason({ ledger: [ledgerOf({ tokenSha: '' })] }), ['marker-mismatch'], 'an entry without a sha never matches');
});

test('planLedgerReap: unattributed work of a known agent is "left", never reaped; current tokens and strangers are not listed', () => {
  const procs = [...table(), { pid: 600, ppid: 900, name: 'node', cmd: 'node vite', createdMs: T + 2000 }, { pid: 601, ppid: 900, name: 'node', cmd: 'node x', createdMs: T + 2100 }, { pid: 602, ppid: 900, name: 'node', cmd: 'node y', createdMs: T + 2200 }];
  const m = marks();
  m.set(600, { agentId: 'w2', tokenSha: sha256('w2-old') });
  m.set(601, { agentId: 'w2', tokenSha: sha256('w2-now') });
  m.set(602, { agentId: 'zz', tokenSha: sha256('zz') });
  const r = planLedgerReap(lbase({ procs, markers: m, currentShas: new Set([sha256('w2-now')]) }));
  assert.deepEqual(r.reap.map((e) => e.root), [500]);
  assert.deepEqual(r.left.map((l) => [l.pid, l.agentId]), [[600, 'w2']]);
  // No ledger: the old work itself is only "left".
  const n = planLedgerReap(lbase({ ledger: [] }));
  assert.deepEqual(n.left.map((l) => l.pid), [500]);
  assert.equal(n.reap.length, 0);
});

test('ledger file: round trip, mode 600, an empty ledger removes it, a broken one reads empty', async () => {
  const f = path.join(tmp(), DETACHED_FILE);
  await writeDetachedLedger(f, [ledgerOf({ pids: [{ pid: 500 }] })]);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const back = readDetachedLedger(f);
  assert.equal(back.length, 1);
  assert.equal(back[0].root, 500);
  assert.equal(back[0].pids, undefined, 'pids are re-read at boot, never trusted from disk');
  await writeDetachedLedger(f, []);
  assert.equal(existsSync(f), false);
  writeFileSync(f, '{nope');
  assert.deepEqual(readDetachedLedger(f), []);
  writeFileSync(f, JSON.stringify({ entries: [{ root: 1, agentId: 'w1', tokenSha: 'x', createdMs: 1 }, { root: 'x' }] }));
  assert.deepEqual(readDetachedLedger(f), [], 'pid 1 and malformed entries are dropped');
});

test('parsePsDetached + createDetachedProbe.kill: a root whose start time moved is never killed', async () => {
  const now = 10_000_000;
  const rows = parsePsDetached(' 500   900   500    12 bash ./run suite.sh\nbogus\n', now);
  assert.deepEqual(rows, [{ pid: 500, ppid: 900, pgid: 500, createdMs: now - 12_000, name: 'bash', cmd: 'bash ./run suite.sh' }]);
  const killed = [];
  const probe = createDetachedProbe({ snapshot: async () => [], markers: async () => new Map(), inspect: async () => new Map([[500, { createdMs: T + 1000 + 30_000 }], [700, { createdMs: T + 1500 }]]), killTree: (pid) => { killed.push(pid); return true; } });
  const res = await probe.kill([ledgerOf(), ledgerOf({ root: 700, createdMs: T + 1500 }), ledgerOf({ root: 800 })]);
  assert.deepEqual(killed, [700]);
  assert.deepEqual(res.skipped.map((s) => [s.root, s.reason]), [[500, 'pid-changed'], [800, 'gone']]);
  assert.equal(detachedSupported('win32', {}), false);
  assert.equal(detachedSupported('linux', { VS_RUNNER_DETACHED: '0' }), false);
  assert.equal(detachedSupported('linux', {}), true);
});

// ---- Runner: drain scan, shutdown record, boot reap (fake probe, fake adapter) -----------------------------------------

function harness(opts = {}) {
  const dir = opts.dir ?? path.join(tmp(), 'agents');
  const ems = new Map();
  let nextPid = 3000;
  const adapter = {
    canPark: true,
    start({ id, emit }) { const pid = nextPid++; ems.set(id, emit); return { pid, send() { emit('status', { status: 'running' }); }, cancel() {}, kill() {} }; },
  };
  const reports = [];
  const runner = new Runner({ dir, adapters: { fake: adapter }, parkGraceMs: 0, parkHoldPollMs: 20, bgProbe: async () => [], detachedScanMs: 60_000, onDetached: (r) => reports.push(r), ...opts, ...(opts.dir ? { dir } : {}) });
  const create = () => { const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'go' }); ems.get(id)('session', { sessionId: `s-${id}` }); return id; };
  return { dir, runner, create, reports };
}

function fakeProbe() {
  const p = { found: [], scans: [], kills: [], reapCalls: [], reapResult: { reaped: [], gone: [], skipped: [], left: [] } };
  p.probe = {
    scan: async (args) => { p.scans.push(args); return p.found.map((e) => ({ ...e })); },
    kill: async (entries) => { p.kills.push(entries.map((e) => e.root)); return { killed: entries, skipped: [] }; },
    reapLedger: async (args) => { p.reapCalls.push(args); return p.reapResult; },
  };
  return p;
}

test('drain scan: detached work started after the drain began is refused (killed, logged, agent told); older work is kept in the ledger', async () => {
  const fp = fakeProbe();
  const file = path.join(tmp(), DETACHED_FILE);
  const h = harness({ detachedProbe: fp.probe, detachedFile: file });
  try {
    const id = h.create();
    const d = h.runner.setDrain({ ttlMs: 60_000, reason: 'vs restart' });
    await h.runner._detachedScan; // setDrain's first tick (nothing found yet)
    assert.equal(fp.scans.length, 1, 'setDrain arms a scan at once');
    assert.equal(fp.scans[0].agents.get(sha256(h.runner.tokensById.get(id))), id, 'the scan gets this lifetime\'s token shas');
    assert.ok(fp.scans[0].cliPids.includes(h.runner.live.get(id).handle.pid), 'live CLI pids are excluded from the scan');
    assert.ok(fp.scans[0].protectedPids.includes(process.pid));
    const early = { agentId: id, tokenSha: 'x', root: 500, pgid: 500, createdMs: d.since - 5000, cmd: 'npm run long', pids: [{ pid: 500 }] };
    const late = { agentId: id, tokenSha: 'x', root: 600, pgid: 600, createdMs: d.since + 5000, cmd: 'nohup godot --headless -s suite.gd', pids: [{ pid: 600 }, { pid: 601 }] };
    const edge = { agentId: id, tokenSha: 'x', root: 700, pgid: 700, createdMs: d.since + 400, cmd: 'maybe before', pids: [{ pid: 700 }] };
    fp.found = [early, late, edge];
    const res = await h.runner.scanDetached({ why: 'drain' });
    assert.deepEqual(fp.kills, [[600]], 'only work dated a full second after the drain is refused');
    assert.deepEqual(res.refused.map((e) => e.root), [600]);
    assert.deepEqual(res.found.map((e) => e.root), [500, 700]);
    assert.match(h.runner.live.get(id).bgStopNotice, /Detached background work you started \(nohup godot/);
    const ev = h.runner.timeline(id).find((e) => e.type === 'park-drain-refused');
    assert.ok(ev, 'refusal logged');
    assert.equal(ev.drain?.detached ?? ev.data?.drain?.detached, true);
    assert.deepEqual(readDetachedLedger(file).map((e) => e.root), [500, 700], 'the ledger keeps what still runs');
    const rep = h.reports.at(-1);
    assert.equal(rep.why, 'drain');
    assert.deepEqual(rep.refused.map((e) => e.root), [600]);
    assert.deepEqual(rep.found.map((e) => e.root), [500, 700]);
    // A second scan reports nothing new (each root once).
    fp.found = [early, edge];
    const n = h.reports.length;
    await h.runner.scanDetached({ why: 'drain' });
    assert.equal(h.reports.length, n);
    // Clearing the drain stops the interval.
    h.runner.clearDrain();
    assert.equal(h.runner._detachedTimer, null);
  } finally { h.runner.shutdown(); }
});

test('recordDetached (before /shutdown): never refuses, even mid-drain; writes the ledger; off without a probe', async () => {
  const fp = fakeProbe();
  const file = path.join(tmp(), DETACHED_FILE);
  const h = harness({ detachedProbe: fp.probe, detachedFile: file });
  try {
    const id = h.create();
    const d = h.runner.setDrain({ ttlMs: 60_000 });
    await h.runner._detachedScan;
    fp.found = [{ agentId: id, tokenSha: 'x', root: 600, pgid: 600, createdMs: d.since + 5000, cmd: 'nohup x', pids: [{ pid: 600 }] }];
    const res = await h.runner.recordDetached(5000);
    assert.equal(res.why, 'shutdown');
    assert.deepEqual(fp.kills, []);
    assert.deepEqual(readDetachedLedger(file).map((e) => e.root), [600]);
  } finally { h.runner.shutdown(); }
  const off = harness();
  try { assert.equal(await off.runner.recordDetached(10), null); assert.equal(await off.runner.scanDetached(), null); } finally { off.runner.shutdown(); }
});

test('boot reap: the previous ledger is verified against a fake table; only the matching root is tree-killed, others skipped or left', async () => {
  const root = tmp();
  const dir = path.join(root, 'agents');
  const file = path.join(root, DETACHED_FILE);
  // A first lifetime creates the agent (its log makes the id "known" to this store).
  const first = harness({ dir });
  const id = first.create();
  first.runner.shutdown({ keepResumable: true });
  const oldSha = sha256('previous-lifetime-token');
  await writeDetachedLedger(file, [
    { agentId: id, tokenSha: oldSha, root: 500, pgid: 500, createdMs: T + 1000, cmd: 'bash ./run-suite.sh' },
    { agentId: id, tokenSha: oldSha, root: 510, pgid: 510, createdMs: T + 1000, cmd: 'reused pid' },
  ]);
  const procs = [
    { pid: 900, ppid: 1, pgid: 900, name: 'systemd', cmd: 'systemd --user', createdMs: 2000 },
    { pid: 500, ppid: 900, pgid: 500, name: 'bash', cmd: 'bash ./run-suite.sh', createdMs: T + 1000 + 800 },
    { pid: 501, ppid: 500, pgid: 500, name: 'godot', cmd: 'godot', createdMs: T + 1100 + 800 },
    { pid: 510, ppid: 900, pgid: 510, name: 'bash', cmd: 'someone else', createdMs: T + 90_000 },
    { pid: 520, ppid: 900, pgid: 520, name: 'node', cmd: 'node vite --port 5199', createdMs: T + 3000 },
    { pid: 530, ppid: 900, pgid: 530, name: 'node', cmd: 'node not ours', createdMs: T + 3000 },
  ];
  const env = new Map([[500, { agentId: id, tokenSha: oldSha }], [501, { agentId: id, tokenSha: oldSha }], [510, { agentId: id, tokenSha: oldSha }], [520, { agentId: id, tokenSha: sha256('older') }], [530, { agentId: 'stranger', tokenSha: sha256('s') }], [900, { agentId: null, tokenSha: null }]]);
  const killed = [];
  const probe = createDetachedProbe({
    snapshot: async () => procs,
    markers: async (pids) => new Map(pids.filter((p) => env.has(p)).map((p) => [p, env.get(p)])),
    inspect: async (pids) => new Map(pids.map((p) => [p, { createdMs: procs.find((q) => q.pid === p).createdMs }])),
    killTree: (pid) => { killed.push(pid); return true; },
  });
  const h = harness({ dir, detachedProbe: probe, detachedFile: file });
  try {
    assert.equal(h.runner._bootLedger.length, 2, 'the ledger is read at construction');
    h.runner.armBootReap(60_000);
    assert.ok(h.runner._bootReapTimer, 'armed, not run');
    clearTimeout(h.runner._bootReapTimer);
    const res = await h.runner.reapBootLedger();
    assert.deepEqual(killed, [500], 'only the verified root (its tree via killPidTree)');
    assert.deepEqual(res.reaped.map((e) => [e.root, e.pids.length]), [[500, 2]]);
    assert.deepEqual(res.skipped.map((s) => [s.root, s.reason]), [[510, 'pid-changed']]);
    assert.deepEqual(res.left.map((l) => l.pid), [510, 520], 'known ids without a verified entry are left (510 failed its date check), a stranger is not listed');
    assert.equal(existsSync(file), false, 'the boot reap retires the old ledger');
    const rep = h.reports.at(-1);
    assert.equal(rep.why, 'boot');
    assert.deepEqual(rep.reaped.map((e) => e.root), [500]);
    assert.equal(await h.runner.reapBootLedger().then((r) => r.reaped.length), 0, 'once per boot: the ledger is consumed');
  } finally { h.runner.shutdown(); }
});

test('detachedReporter: one runner.log line, a team-log metric per refused / found / reaped / left root, skips log only', () => {
  const lines = [];
  const metrics = [];
  const rep = detachedReporter((m) => metrics.push(m), (o) => lines.push(o));
  rep({ why: 'drain', refused: [{ agentId: 'w1', root: 600, pids: [1, 2], cmd: 'nohup x', team: 't', lane: 'l' }], found: [{ agentId: 'w1', root: 500, pids: [1], cmd: 'y' }], skipped: [{ root: 7, reason: 'gone' }] });
  rep({ why: 'boot', reaped: [{ agentId: 'w2', root: 1, pids: [1], cmd: 'z' }], left: [{ agentId: 'w3', pid: 9, cmd: 'q' }] });
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].detached.skipped, [{ root: 7, reason: 'gone' }]);
  assert.equal(metrics.length, 4);
  assert.equal(metrics[0].team, 't');
  assert.equal(metrics[1].team, 'vibesquad');
  assert.match(metrics[0].text, /killed tree root 600 \(2 pids\)/);
  assert.match(metrics[3].text, /left running/);
});

// ---- drain hook: a foreground command that backgrounds itself ---------------------------------------------------------

test('selfBackgrounds (Bash): &, nohup, setsid, disown count; quoted, escaped, commented, &&, 2>&1, &>, |& do not', () => {
  for (const c of ['nohup npm test > /tmp/x.log 2>&1 &', 'npm test &', 'npm test & echo started', '(godot -s suite.gd &)', 'setsid ./run.sh', 'x & disown', 'a&&b&', 'cd x && ./suite.sh > log &\n', 'cat <<EOF > f &\nbody\nEOF', 'sleep 9 & wait']) {
    assert.equal(selfBackgrounds(c), true, c);
  }
  for (const c of ['npm test && npm run build', 'npm test 2>&1 | tail', 'npm test &> log', 'npm test &>> log', 'cmd >&2', 'a |& b', 'echo "a & b"', "grep -c '&' file", 'echo a \\& b', 'ls # nohup &', 'echo "nohup x &"', 'git commit -F - <<\'EOF\'\nR&D work &\nnohup\nEOF', "echo 'setsid'", '', 'nohupx', 'echo $#', '[[ a ]] && b || c']) {
    assert.equal(selfBackgrounds(c), false, JSON.stringify(c));
  }
});

test('selfBackgrounds (PowerShell): Start-Job / Start-Process without -Wait / trailing &; the call operator never counts', () => {
  for (const c of ['Start-Job { npm test }', 'Start-ThreadJob { x }', 'Start-Process godot -ArgumentList "-s x"', 'saps notepad', 'npm test &', 'npm test &; echo x', 'Start-Process a -Wait; Start-Process b']) assert.equal(selfBackgrounds(c, 'PowerShell'), true, c);
  for (const c of ['& "C:\\Program Files\\x.exe" --run', '& $exe', 'npm test && echo ok', 'Start-Process godot -Wait', 'Start-Process godot -NoNewWindow -Wait -PassThru', 'Write-Host "Start-Job &"', "Write-Host 'a & b'", '# Start-Job']) assert.equal(selfBackgrounds(c, 'PowerShell'), false, c);
});

test('drainHookDecision: a self-backgrounding foreground command is refused during a drain with its own text', () => {
  const now = Date.now();
  const drain = { since: now - 1000, until: now + 60_000, reason: 'vs restart' };
  const fg = (command, tool_name = 'Bash') => ({ tool_name, tool_input: { command } });
  const why = drainHookDecision(fg('nohup npm test > /tmp/x.log &'), drain, now);
  assert.match(why, /backgrounds itself/);
  assert.equal(why, drainDetachRefusalText(drain));
  assert.match(drainHookDecision(fg('Start-Job { x }', 'PowerShell'), drain, now), /backgrounds itself/);
  assert.match(drainHookDecision(fg('x &'), { kind: 'request', request: { id: 'rr-1' }, since: now, until: now + 60_000 }, now), /restart request rr-1/);
  assert.equal(drainHookDecision(fg('npm test 2>&1 && echo ok'), drain, now), null, 'plain foreground passes');
  assert.equal(drainHookDecision(fg('nohup x &'), null, now), null, 'no drain');
  assert.equal(drainHookDecision(fg('nohup x &'), { ...drain, until: now }, now), null, 'expired drain');
  assert.equal(drainHookDecision({ tool_name: 'Read', tool_input: { command: 'x &' } }, drain, now), null);
  assert.match(drainHookDecision({ tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } }, drain, now), /new background commands are refused/, 'run_in_background keeps its own text');
});

// ---- background.mjs: Linux ps carries etimes -> createdMs ---------------------------------------------------------------

test('parsePs: etimes gives a lower-bound createdMs; the 3-field form still parses undated', () => {
  const now = 50_000_000;
  const [a] = parsePs('  4242     1    45 bash -c npm test', { etimes: true, now });
  assert.deepEqual(a, { pid: 4242, ppid: 1, name: 'bash', cmd: 'bash -c npm test', createdMs: now - 46_000, createdTolMs: 2000 });
  const [b] = parsePs('1 0 sh', { etimes: true, now });
  assert.deepEqual(b, { pid: 1, ppid: 0, name: 'sh', cmd: 'sh' });
  const [c] = parsePs('7 1 12 x');
  assert.deepEqual(c, { pid: 7, ppid: 1, name: '12', cmd: '12 x' }, 'without etimes nothing is read as a date');
});

test('snapshotProcesses (linux): asks ps for etimes and dates each row', async () => {
  let argv = null;
  const spawnImpl = (file, args) => { argv = [file, ...args]; const c = new EventEmitter(); c.stdout = new EventEmitter(); c.kill = () => {}; setImmediate(() => { c.stdout.emit('data', '10 1 3 bash -c x\n'); c.emit('close', 0); }); return c; };
  const before = Date.now();
  const r = await snapshotProcesses({ platform: 'linux', spawnImpl });
  assert.ok(argv.includes('etimes='));
  assert.ok(r[0].createdMs <= before - 3000 && r[0].createdMs >= before - 5000);
  await snapshotProcesses({ platform: 'darwin', spawnImpl });
  assert.ok(!argv.includes('etimes='), 'macOS ps keeps the 3-field form');
});

test('backgroundWork: a coarse (etimes) child dated up to its tolerance before its parent is still its work', () => {
  const procs = [
    { pid: 100, ppid: 1, name: 'opencode', cmd: 'opencode', createdMs: 10_000, createdTolMs: 2000 },
    { pid: 101, ppid: 100, name: 'bash', cmd: 'bash -c suite', createdMs: 9000, createdTolMs: 2000 },
  ];
  assert.deepEqual(backgroundWork(procs, 100).map((w) => w.pid), [101]);
  assert.deepEqual(backgroundWork([procs[0], { ...procs[1], createdMs: 5000 }], 100), [], 'a real pid-reuse gap still drops it');
  assert.deepEqual(backgroundWork([{ ...procs[0], createdTolMs: undefined }, { ...procs[1], createdTolMs: undefined, createdMs: 9900 }], 100), [], 'precise dates keep the 50 ms rule');
});
