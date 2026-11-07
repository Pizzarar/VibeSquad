import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeKillSet, unstick } from '../server/unstick.mjs';

const P = (pid, ppid, cmd, name = 'node.exe') => ({ pid, ppid, name, cmd, startedMs: 1 });
const procs = [
  P(1, 0, 'explorer', 'explorer.exe'),
  P(10, 1, 'cmd', 'cmd.exe'),
  P(100, 10, 'node server/serve.mjs'),        // serving VS server
  P(101, 100, 'node child-of-server'),
  P(200, 1, 'node runner/server.mjs --home x'), // runner
  P(201, 200, 'node codex-agent'),            // agent tree
  P(202, 201, 'node agent-grandchild'),
  P(300, 1, 'node C:/x/server/mcp/vs-mcp.mjs'),
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

function hung(confirmRestart) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'vs-unstick-'));
  const rHome = path.join(home, 'runner');
  mkdirSync(rHome, { recursive: true });
  writeFileSync(path.join(rHome, 'runner.json'), JSON.stringify({ port: 1, pid: 200 }));
  writeFileSync(path.join(rHome, 'token'), 't');
  writeFileSync(path.join(rHome, 'runner.lock'), JSON.stringify({ pid: 200 }));
  const killed = [];
  let restarts = 0;
  const run = () => unstick({
    home, selfPid: 100, list: () => procs, killPid: (pid) => killed.push(pid), alive: () => true,
    runnerHealthy: () => restarts > 0, restartRunner: () => { restarts++; return true; },
    confirmRestart, healthTimeoutMs: 50,
  });
  return { home, rHome, killed, run, restarts: () => restarts };
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
