import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { computeKillSet, forceRestartRunner, listProcesses, unstick } from '../server/unstick.mjs';

const P = (pid, ppid, cmd, name = 'node.exe') => ({ pid, ppid, name, cmd, startedMs: 1 });
const procs = [
  P(1, 0, 'explorer', 'explorer.exe'),
  P(10, 1, 'cmd', 'cmd.exe'),
  P(100, 10, 'node server/serve.mjs'),        // serving VS server
  P(101, 100, 'node child-of-server'),
  P(200, 1, String.raw`node C:\x\runner\server.mjs --home x`), // runner
  P(201, 200, 'node codex-agent'),            // agent tree
  P(202, 201, 'node agent-grandchild'),
  P(300, 1, String.raw`node C:\x\server\mcp\vs-mcp.mjs`),
  P(400, 1, 'node @playwright/mcp'),
  P(500, 1, 'node -e setInterval(()=>{},1e9)'), // stray
  P(501, 1, 'chrome', 'chrome.exe'),
];

test('kill set spares server, ancestors, runner, agent trees, MCP; kills the stray only', () => {
  const { kill, spared } = computeKillSet(procs, { selfPid: 100, roots: [200] });
  assert.deepEqual(kill.map((p) => p.pid), [500]);
  for (const pid of [100, 101, 10, 200, 201, 202, 300, 400]) assert.ok(spared.some((s) => s.pid === pid), `spared ${pid}`);
});

test('ledger roots spare their trees even without a recognisable cmdline', () => {
  const { kill } = computeKillSet([...procs, P(600, 1, 'node odd-agent'), P(601, 600, 'node odd-kid')], { selfPid: 100, roots: [200, 600] });
  assert.deepEqual(kill.map((p) => p.pid), [500]);
});

function setup(healthy) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'vs-unstick-'));
  const killed = [];
  const calls = { restart: 0 };
  let up = healthy;
  const opts = {
    home, selfPid: 100, list: () => procs, killPid: (pid) => killed.push(pid),
    runnerHealthy: () => up, restartRunner: () => { calls.restart++; up = true; return true; },
    now: () => new Date('2026-11-06T12:00:00Z'),
  };
  return { home, killed, calls, opts };
}

test('snapshot is written, only the stray is killed, healthy runner is not restarted', async () => {
  const { home, killed, calls, opts } = setup(true);
  try {
    const r = await unstick(opts);
    assert.deepEqual(killed, [500]);
    assert.equal(r.killed.length, 1);
    assert.equal(calls.restart, 0);
    assert.ok(existsSync(r.snapshot));
    const snap = JSON.parse(readFileSync(r.snapshot, 'utf8'));
    assert.ok(snap.node.length >= 7 && snap.node.every((n) => 'pid' in n && 'ppid' in n && 'cmd' in n && 'startedMs' in n));
    assert.equal(snap.runnerHealthy, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('unhealthy runner triggers a restart', async () => {
  const { home, calls, opts } = setup(false);
  try {
    const r = await unstick(opts);
    assert.equal(calls.restart, 1);
    assert.equal(r.runner.restarted, true);
    assert.equal(r.runner.healthy, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

function hung(confirmRestart, { lockPid = 200, discPid = 200, onKill } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'vs-unstick-'));
  const rHome = path.join(home, 'runner');
  mkdirSync(rHome, { recursive: true });
  writeFileSync(path.join(rHome, 'runner.json'), JSON.stringify({ port: 1, pid: discPid }));
  writeFileSync(path.join(rHome, 'token'), 't');
  writeFileSync(path.join(rHome, 'runner.lock'), JSON.stringify({ pid: lockPid }));
  const killed = [];
  let restarts = 0;
  const forceArgs = [];
  const run = () => unstick({
    home, selfPid: 100, list: () => procs, killPid: (pid) => { killed.push(pid); onKill?.(pid); }, alive: (pid) => !killed.includes(pid),
    runnerHealthy: () => restarts > 0, restartRunner: (o) => { restarts++; forceArgs.push(o?.force); return true; },
    confirmRestart, healthTimeoutMs: 50,
  });
  return { home, rHome, killed, run, forceArgs, restarts: () => restarts };
}

test('hung runner without confirm is spared and reports needsRestart', async () => {
  const h = hung(false);
  try {
    const r = await h.run();
    assert.deepEqual(h.killed, [500]);
    assert.equal(r.runner.needsRestart, true);
    assert.equal(r.runner.restarted, false);
    assert.equal(h.restarts(), 0);
    assert.ok(existsSync(path.join(h.rHome, 'runner.lock')));
    assert.ok(existsSync(r.snapshot));
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('hung runner with confirm is killed, lock/discovery cleared, restarted', async () => {
  const h = hung(true);
  try {
    const r = await h.run();
    assert.deepEqual(h.killed, [500, 200]);
    assert.equal(r.runner.needsRestart, false);
    assert.equal(r.runner.restarted, true);
    assert.equal(r.runner.healthy, true);
    assert.ok(!existsSync(path.join(h.rHome, 'runner.lock')));
    assert.ok(!existsSync(path.join(h.rHome, 'runner.json')));
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('listProcesses throws on spawn error, non-zero exit, empty or unparseable output', () => {
  const ok = { status: 0, stdout: '1|0|5|node.exe|node x' };
  assert.equal(listProcesses({ platform: 'win32', run: () => ok }).length, 1);
  assert.throws(() => listProcesses({ platform: 'win32', run: () => ({ error: new Error('ETIMEDOUT'), status: null, stdout: '1|0|5|node.exe|x' }) }), /ETIMEDOUT/);
  assert.throws(() => listProcesses({ platform: 'win32', run: () => ({ status: 1, stdout: '1|0|5|node.exe|x' }) }), /exited 1/);
  assert.throws(() => listProcesses({ platform: 'win32', run: () => ({ status: 0, stdout: '' }) }), /empty/);
  assert.throws(() => listProcesses({ platform: 'win32', run: () => ({ status: 0, stdout: 'garbage line' }) }), /unparseable/);
  assert.throws(() => listProcesses({ platform: 'linux', run: () => ({ status: 0, stdout: 'oops' }) }), /unparseable/);
});

test('failed process list kills nothing and says so', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'vs-unstick-'));
  const killed = [];
  try {
    const r = await unstick({ home, selfPid: 100, list: () => { throw new Error('powershell exited 1'); }, killPid: (p) => killed.push(p), runnerHealthy: () => true });
    assert.equal(r.ok, false);
    assert.match(r.error, /process list failed/);
    assert.deepEqual(killed, []);
    const r2 = await unstick({ home, selfPid: 999, list: () => procs, killPid: (p) => killed.push(p), runnerHealthy: () => true });
    assert.equal(r2.ok, false); // listing without this server = partial
    assert.deepEqual(killed, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('ancestors of spared processes are spared (taskkill /T would take the child)', () => {
  const list = [P(1, 0, 'explorer', 'explorer.exe'), P(100, 1, 'node server/serve.mjs'), P(700, 1, 'node wrapper.js'), P(701, 700, 'node agent-child'), P(800, 700, 'node sibling-stray')];
  const { kill, spared } = computeKillSet(list, { selfPid: 100, roots: [701] });
  assert.ok(spared.some((s) => s.pid === 700), 'wrapper spared');
  assert.deepEqual(kill.map((p) => p.pid), [800]);
});

test('confirmed restart is forced, and lock/discovery of a newer runner are kept', async () => {
  const h = hung(true);
  try {
    await h.run();
    assert.deepEqual(h.forceArgs, [true]);
  } finally { rmSync(h.home, { recursive: true, force: true }); }
  const g = hung(true, { lockPid: 4242, discPid: 200 });
  try {
    await g.run();
    assert.ok(existsSync(path.join(g.rHome, 'runner.lock')), 'lock of a different (new) runner kept');
    assert.ok(!existsSync(path.join(g.rHome, 'runner.json')), 'discovery still named the killed pid');
  } finally { rmSync(g.home, { recursive: true, force: true }); }
});

test('runner that does not die is not cleaned up or restarted', async () => {
  const h = hung(true);
  try {
    const r = await unstick({ home: h.home, selfPid: 100, list: () => procs, killPid: () => {}, alive: () => true, runnerHealthy: () => false, restartRunner: () => { throw new Error('should not restart'); }, confirmRestart: true, healthTimeoutMs: 50, deadTimeoutMs: 100 });
    assert.equal(r.runner.restarted, false);
    assert.match(r.runner.note, /did not exit/);
    assert.ok(existsSync(path.join(h.rHome, 'runner.lock')));
  } finally { rmSync(h.home, { recursive: true, force: true }); }
});

test('RunnerBackend.startOwned({force}) bypasses the failure cooldown and a doomed in-flight start', async () => {
  const { RunnerBackend } = await import('../server/backend/runner-backend.mjs');
  let calls = 0;
  const rc = { starting: 'doomed', startOwned: () => { calls++; return Promise.resolve(); } };
  const b = new RunnerBackend({ client: rc, buildPrefix: async () => '', hooks: false });
  b.ensureFailedAt = Date.now();
  assert.equal(await b.startOwned(), false); // cooldown
  assert.equal(calls, 0);
  assert.equal(await b.startOwned({ force: true }), true);
  assert.equal(calls, 1);
  assert.equal(rc.starting, null);
  b.ensuring = new Promise(() => {}); // never settles
  assert.equal(await b.startOwned({ force: true }), true);
  assert.equal(calls, 2);
});

test('forceRestartRunner cancels only running turns and never archives', async () => {
  const cancelled = [];
  const archived = [];
  let restarted = 0;
  const backend = {
    listAgents: async () => [
      { id: 'rn-run', status: 'running', archivedAt: null },
      { id: 'rn-idle', status: 'idle', archivedAt: null },
      { id: 'rn-closed', status: 'closed', archivedAt: null },
      { id: 'rn-archived', status: 'running', archivedAt: '2026-11-07T00:00:00Z' },
    ],
    cancelAgent: async (id) => cancelled.push(id),
    archiveAgent: async (id) => archived.push(id),
  };
  const r = await forceRestartRunner({ backend, restartRunner: async () => { restarted++; return true; } });
  assert.deepEqual(cancelled, ['rn-run']); // running + not archived only
  assert.deepEqual(archived, []);          // never archives anything
  assert.equal(restarted, 1);
  assert.equal(r.ok, true);
  assert.equal(r.restarted, true);
  assert.deepEqual(r.cancelled, ['rn-run']);
});

test('forceRestartRunner still restarts when the agent list is unreachable (runner down)', async () => {
  let restarted = 0;
  const r = await forceRestartRunner({
    listAgents: async () => { throw new Error('runner down'); },
    restartRunner: async () => { restarted++; return true; },
  });
  assert.equal(restarted, 1);
  assert.equal(r.ok, true);
  assert.deepEqual(r.cancelled, []);
});

test('restart-runner route is owner-only: POST without the local token is 403', async () => {
  const { createVibesquadMiddleware } = await import('../server/vibesquad-api.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vs-restart-route-'));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = path.join(dir, '.vibesquad');
  const repo = path.join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  const mw = createVibesquadMiddleware(repo);
  const server = http.createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const noToken = await fetch(`http://127.0.0.1:${port}/__vibesquad/restart-runner`, { method: 'POST' });
    assert.equal(noToken.status, 403);
  } finally {
    await new Promise((r) => server.close(r));
    prev === undefined ? delete process.env.VIBESQUAD_HOME : (process.env.VIBESQUAD_HOME = prev);
    rmSync(dir, { recursive: true, force: true });
  }
});
