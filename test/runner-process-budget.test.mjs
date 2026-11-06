// Agent process budget: live-agent cap, parking idle agents, resume on the next prompt, tree cleanup on shutdown.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Runner, maxLiveFromEnv, DEFAULT_MAX_LIVE } from '../runner/runner.mjs';
import { createClaudeAdapter } from '../runner/adapters/claude.mjs';
import { killTree, spawnNoShell } from '../runner/spawn.mjs';

const dirs = [];
const pids = new Set();
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-budget-')); dirs.push(d); return d; };
after(() => {
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Fake claude CLI children. Each acknowledges 'init' with a session id and finishes a turn on any user message.
function fakeSpawn() {
  const calls = [];
  const impl = (file, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0, null); };
    child.push = (o) => child.stdout.write(JSON.stringify(o) + '\n');
    child.stdin.on('data', () => setImmediate(() => child.push({ type: 'result', subtype: 'success' })));
    const sid = `sess-${calls.length + 1}`;
    setImmediate(() => child.push({ type: 'system', subtype: 'init', session_id: sid, model: 'm' }));
    calls.push({ file, args, child, sid });
    return child;
  };
  impl.calls = calls;
  return impl;
}
const resolved = { file: '/bin/fake', args: [] };
const tick = () => new Promise((r) => setTimeout(r, 25));

function setup(maxLive) {
  const spawnImpl = fakeSpawn();
  const adapter = createClaudeAdapter({ spawnImpl, mcp: false });
  const runner = new Runner({ dir: tmp(), adapters: { claude: adapter }, maxLive });
  return { runner, spawnImpl };
}
const mk = (runner, extra = {}) => runner.create({ provider: 'claude', cwd: os.tmpdir(), ...extra });

test('default cap is 6 and VS_RUNNER_MAX_LIVE overrides it', () => {
  assert.equal(DEFAULT_MAX_LIVE, 6);
  assert.equal(maxLiveFromEnv({}), 6);
  assert.equal(maxLiveFromEnv({ VS_RUNNER_MAX_LIVE: '3' }), 3);
  assert.equal(maxLiveFromEnv({ VS_RUNNER_MAX_LIVE: 'nope' }), 6);
  assert.equal(maxLiveFromEnv({ VS_RUNNER_MAX_LIVE: '0' }), 6);
});

test('claude adapter passes --resume only when resuming', () => {
  const spawnImpl = fakeSpawn();
  const a = createClaudeAdapter({ spawnImpl, mcp: false });
  assert.equal(a.canPark, true);
  const noop = () => {};
  a.start({ cwd: '.', emit: noop, onExit: noop });
  assert.ok(!spawnImpl.calls[0].args.includes('--resume'));
  a.start({ cwd: '.', emit: noop, onExit: noop, resume: 'abc' });
  const args = spawnImpl.calls[1].args;
  assert.equal(args[args.indexOf('--resume') + 1], 'abc');
});

test('spawn past the cap parks the oldest idle agent; its log says parked and its process is killed', async () => {
  const { runner, spawnImpl } = setup(2);
  const a = mk(runner);
  await tick();
  const b = mk(runner);
  await tick();
  // both idle only after a turn finishes
  runner.send(a, 'hi'); await tick();
  runner.send(b, 'hi'); await tick();
  assert.equal(runner.status(a).status, 'idle');
  const c = mk(runner);
  await tick();
  assert.equal(runner.live.size, 2);
  assert.equal(runner.status(a).status, 'parked', 'oldest idle (a) is parked');
  assert.equal(runner.status(b).status, 'idle');
  assert.ok(runner.live.has(c));
  assert.equal(spawnImpl.calls[0].child.killed, true);
  assert.ok(!runner.timeline(a).some((e) => e.type === 'exit'), 'parking is not an exit');
  runner.shutdown();
});

test('a prompt to a parked agent resumes it with --resume <sessionId>, parking another idle one', async () => {
  const { runner, spawnImpl } = setup(2);
  const a = mk(runner); const b = mk(runner);
  await tick();
  runner.send(a, 'one'); await tick();
  runner.send(b, 'two'); await tick();
  runner.park(a);
  assert.equal(runner.status(a).status, 'parked');
  mk(runner); await tick(); // takes the free slot; a and the new one + b would be 3 -> b parked? b is idle, oldest idle
  runner.send(a, 'again'); await tick();
  const resumed = spawnImpl.calls.at(-1);
  assert.equal(resumed.args[resumed.args.indexOf('--resume') + 1], 'sess-1');
  assert.equal(runner.live.size, 2);
  assert.ok(runner.live.has(a));
  assert.ok(runner.timeline(a).some((e) => e.type === 'input' && e.text === 'again'));
  runner.shutdown();
});

test('a parked agent resumes lazily from the log in a fresh Runner (after a runner restart)', async () => {
  const dir = tmp();
  const s1 = fakeSpawn();
  const r1 = new Runner({ dir, adapters: { claude: createClaudeAdapter({ spawnImpl: s1, mcp: false }) }, maxLive: 6 });
  const id = mk(r1); await tick();
  r1.send(id, 'x'); await tick();
  r1.updateMeta(id, { labels: { job: 'renamed' } });
  r1.park(id);
  r1.shutdown();
  const s2 = fakeSpawn();
  const r2 = new Runner({ dir, adapters: { claude: createClaudeAdapter({ spawnImpl: s2, mcp: false }) }, maxLive: 6 });
  assert.equal(r2.live.size, 0, 'nothing is resumed on boot');
  assert.equal(s2.calls.length, 0);
  assert.equal(r2.status(id).status, 'parked');
  assert.equal(r2._parkedSpec(id).meta.labels?.job, 'renamed', 'resume uses meta patched after creation');
  r2.send(id, 'back'); await tick();
  assert.equal(s2.calls.length, 1);
  assert.ok(s2.calls[0].args.includes('--resume'));
  r2.shutdown();
});

test('refuses with a clear error only when no agent is idle; a refused spawn leaves no agent behind', async () => {
  const { runner } = setup(2);
  const a = mk(runner, { prompt: 'work' }); const b = mk(runner, { prompt: 'work' });
  // the fake finishes turns asynchronously: check before they go idle
  assert.equal(runner.status(a).status, 'running');
  const before = runner.list().length;
  assert.throws(() => mk(runner), /agent cap reached \(2 live\) and none are idle/);
  assert.equal(runner.list().length, before);
  assert.equal(runner.live.size, 2);
  await tick();
  assert.doesNotThrow(() => mk(runner), 'once a turn ends there is an idle agent to park');
  assert.ok(b);
  runner.shutdown();
});

test('only idle agents can be parked', async () => {
  const { runner } = setup(6);
  const a = mk(runner, { prompt: 'work' });
  assert.throws(() => runner.park(a), /only idle agents can be parked/);
  runner.shutdown();
});

test('Runner.shutdown kills the whole process tree (agent + its sidecars)', async () => {
  const grandchild = 'setInterval(()=>{},1000)';
  const parentSrc = `const {spawn}=require('child_process');const g=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});console.log(g.pid);setInterval(()=>{},1000)`;
  let exited;
  const exitedP = new Promise((r) => { exited = r; });
  const adapter = {
    canPark: false,
    start({ emit, onExit }) {
      const child = spawnNoShell(process.execPath, ['-e', parentSrc], { resolved: { file: process.execPath, args: [] } });
      pids.add(child.pid);
      child.stdout.on('data', (d) => { const g = Number(String(d).trim()); if (g) pids.add(g); });
      child.on('exit', (code, signal) => { onExit({ code, signal }); exited(); });
      emit('status', { status: 'idle' });
      return { send() {}, cancel() {}, kill() { killTree(child); } };
    },
  };
  const runner = new Runner({ dir: tmp(), adapters: { fake: adapter }, maxLive: 6 });
  const id = runner.create({ provider: 'fake', cwd: os.tmpdir() });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const deadline = Date.now() + 5000;
  while (pids.size < 2 && Date.now() < deadline) await tick();
  assert.equal(pids.size, 2, 'parent and grandchild both started');
  const [p, g] = [...pids];
  assert.ok(alive(p) && alive(g));
  runner.shutdown();
  const until = Date.now() + 8000;
  while ((alive(p) || alive(g)) && Date.now() < until) await tick();
  assert.ok(!alive(p), 'agent process is gone');
  assert.ok(!alive(g), 'its sidecar is gone too');
  await exitedP; // let the exit event land in the log before the temp dir is removed
  assert.ok(runner.timeline(id).some((e) => e.type === 'exit' && e.reason === 'runner-shutdown'));
});

test('runner/server.mjs runs shutdown on exit and on every stop signal', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runner', 'server.mjs'), 'utf8');
  assert.match(src, /process\.on\('exit', \(\) => \{[^}]*runner\.shutdown\(\)/s);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP', 'uncaughtException']) assert.ok(src.includes(`'${sig}'`), sig);
});
