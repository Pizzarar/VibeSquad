// Restart drain (ideas 198 + 186): while `vs restart` waits for the runner to go idle, NEW background work is refused
// (runner-side park hold refusal for every provider + a claude PreToolUse hook), work that predates the drain keeps holding,
// the drain expires on its own and never survives a runner start, and only the admin token can set or clear it.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Runner, DRAIN_TTL_MAX_MS, drainNoticeText } from '../runner/runner.mjs';
import { createServer } from '../runner/server.mjs';
import { createClaudeAdapter, drainHookSettings, DRAIN_HOOK_SCRIPT } from '../runner/adapters/claude.mjs';
import { drainHookDecision } from '../runner/drain-hook.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix = 'vs-drain-') => { const d = mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await tick(10); } };
const ADMIN = 'admin-token-drain';

// Fake parkable agents; the probe answers from `work` (pid -> shells), so a test sets the shells' start times.
function harness({ dir = path.join(tmp(), 'agents'), ...opts } = {}) {
  const work = new Map();
  const kills = [];
  const sends = [];
  const ems = new Map();
  let nextPid = 1000;
  const adapter = {
    canPark: true,
    start({ id, emit }) {
      const pid = nextPid++;
      ems.set(id, emit);
      return { pid, send(text) { sends.push({ id, text }); emit('status', { status: 'running' }); }, cancel() {}, kill() { kills.push(id); } };
    },
  };
  const bgProbe = async (pid) => work.get(pid) ?? [];
  const runner = new Runner({ dir, adapters: { fake: adapter }, parkGraceMs: 0, parkHoldPollMs: 20, parkHoldMaxMs: 60_000, bgProbe, ...opts });
  const create = () => { const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'go' }); ems.get(id)('session', { sessionId: `s-${id}` }); return id; };
  const endTurn = (id) => { const em = ems.get(id); em('turn_done', {}); em('status', { status: 'idle' }); };
  const pidOf = (id) => runner.live.get(id)?.handle.pid;
  const shell = (id, createdMs) => work.set(pidOf(id), [{ pid: 9000, name: 'bash', cmd: "eval 'npm test'", ...(createdMs !== undefined ? { createdMs } : {}) }]);
  return { dir, runner, work, kills, sends, ems, create, endTurn, pidOf, shell };
}
const types = (runner, id) => runner.timeline(id).map((e) => e.type);

test('setDrain validates its TTL (1s..2h) and a refresh keeps the first `since`', async () => {
  const { runner } = harness();
  try {
    for (const bad of [undefined, 999, DRAIN_TTL_MAX_MS + 1, 1500.5, 'x']) assert.throws(() => runner.setDrain({ ttlMs: bad }), (e) => e.status === 400, `ttl ${bad}`);
    assert.equal(runner.drainState(), null);
    const a = runner.setDrain({ ttlMs: 60_000, reason: 'vs restart' });
    await tick(15);
    const b = runner.setDrain({ ttlMs: 120_000 });
    assert.equal(b.since, a.since, 'refresh extends, it does not restart the drain window');
    assert.ok(b.until > a.until);
    assert.equal(runner.clearDrain(), true);
    assert.equal(runner.clearDrain(), false, 'a second clear reports nothing was active');
  } finally { runner.shutdown(); }
});

test('while draining, a NEW hold (shell started after the drain) is refused: parked, logged, work stopped', async () => {
  const h = harness();
  try {
    const id = h.create();
    const drain = h.runner.setDrain({ ttlMs: 60_000, reason: 'vs restart test' });
    h.shell(id, drain.since + 5);
    h.endTurn(id);
    await until(() => h.kills.length === 1);
    assert.equal(h.runner.status(id).status, 'parked');
    const refused = h.runner.timeline(id).filter((e) => e.type === 'park-drain-refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].work[0].pid, 9000);
    assert.equal(refused[0].drain.reason, 'vs restart test');
    assert.ok(!types(h.runner, id).includes('park-held'));
  } finally { h.runner.shutdown(); }
});

test('while draining, an EXISTING hold is allowed: work started before the drain, or undated work, keeps holding', async () => {
  const h = harness();
  try {
    const older = h.create();
    const undated = h.create();
    const drain = h.runner.setDrain({ ttlMs: 60_000 });
    h.shell(older, drain.since - 10_000);
    h.shell(undated); // POSIX ps gives no start time: the drain never stops what it cannot date
    h.endTurn(older);
    h.endTurn(undated);
    await until(() => types(h.runner, older).includes('park-held') && types(h.runner, undated).includes('park-held'));
    await tick(80); // several hold polls under the drain
    assert.deepEqual(h.kills, []);
    for (const id of [older, undated]) assert.ok(!types(h.runner, id).includes('park-drain-refused'));
    // A hold already in place when the drain starts is not refused on its later polls either.
    const before = h.create();
    h.runner.clearDrain();
    h.shell(before, Date.now() + 60_000); // dated AFTER the coming drain's since: only the existing hold keeps it
    h.endTurn(before);
    await until(() => types(h.runner, before).includes('park-held'));
    h.runner.setDrain({ ttlMs: 60_000 });
    await tick(80);
    assert.ok(!h.kills.includes(before), 'a hold that began before the drain keeps holding');
    assert.ok(!types(h.runner, before).includes('park-drain-refused'));
  } finally { h.runner.shutdown(); }
});

test('no drain: a new background shell holds the park as before', async () => {
  const h = harness();
  try {
    const id = h.create();
    h.shell(id, Date.now());
    h.endTurn(id);
    await until(() => types(h.runner, id).includes('park-held'));
    assert.deepEqual(h.kills, []);
  } finally { h.runner.shutdown(); }
});

test('TTL expiry ends the drain on its own (state and drain.json), and refusals stop with it', async () => {
  const root = tmp();
  const drainFile = path.join(root, 'drain.json');
  const h = harness({ drainFile });
  try {
    const d = h.runner.setDrain({ ttlMs: 1000, reason: 'ttl' });
    assert.ok(existsSync(drainFile));
    const onDisk = JSON.parse(readFileSync(drainFile, 'utf8'));
    assert.deepEqual(onDisk, d, 'the hook reads the same { since, until, reason }');
    await until(() => !existsSync(drainFile), 2500);
    assert.equal(h.runner.drainState(), null);
    const id = h.create();
    h.shell(id, Date.now());
    h.endTurn(id);
    await until(() => types(h.runner, id).includes('park-held'));
    assert.ok(!types(h.runner, id).includes('park-drain-refused'));
  } finally { h.runner.shutdown(); }
});

test('drainState() treats a drain past `until` as ended even before its timer fires', () => {
  const { runner } = harness();
  try {
    runner.setDrain({ ttlMs: 60_000 });
    runner._drain.until = Date.now() - 1;
    assert.equal(runner.drainState(), null);
    assert.equal(runner._drainRefusesHold([{ pid: 1, createdMs: Date.now() }]), false);
  } finally { runner.shutdown(); }
});

test('a runner start clears a drain file a crashed runner left behind; shutdown clears an active drain', () => {
  const root = tmp();
  const drainFile = path.join(root, 'drain.json');
  writeFileSync(drainFile, JSON.stringify({ since: Date.now(), until: Date.now() + 3_600_000, reason: 'stale' }));
  const h = harness({ drainFile });
  assert.ok(!existsSync(drainFile), 'removed at construction');
  assert.equal(h.runner.drainState(), null);
  h.runner.setDrain({ ttlMs: 60_000 });
  assert.ok(existsSync(drainFile));
  h.runner.shutdown();
  assert.ok(!existsSync(drainFile), 'removed at shutdown');
  assert.equal(h.runner.drainState(), null);
});

test('the drained notice reaches the agent on its next send, also after a runner restart, exactly once', async () => {
  const dir = path.join(tmp(), 'agents');
  const h1 = harness({ dir });
  const id = h1.create();
  const drain = h1.runner.setDrain({ ttlMs: 60_000, reason: 'vs restart' });
  h1.shell(id, drain.since + 5);
  h1.endTurn(id);
  await until(() => h1.kills.length === 1);
  h1.runner.shutdown();

  const h2 = harness({ dir }); // a fresh runner on the same logs: the notice is folded from the log, not memory
  try {
    h2.runner.send(id, 'next task');
    await until(() => h2.sends.some((s) => s.id === id));
    const sent = h2.sends.find((s) => s.id === id).text;
    const refused = h1.runner.timeline(id).find((e) => e.type === 'park-drain-refused');
    const notice = drainNoticeText(refused.drain, refused.work);
    assert.ok(sent.startsWith(notice), `notice first: ${sent}`);
    assert.ok(sent.endsWith('next task'));
    assert.match(notice, /draining for a restart/);
    assert.match(notice, /npm test/);
    assert.equal(h2.runner.timeline(id).filter((e) => e.type === 'drain-notice').length, 1);
    // Once an input has followed the refusal, the notice is spent.
    h2.ems.get(id)('turn_done', {}); h2.ems.get(id)('status', { status: 'idle' });
    await until(() => h2.runner.status(id).status === 'parked');
    h2.sends.length = 0;
    h2.runner.send(id, 'again');
    await until(() => h2.sends.some((s) => s.id === id));
    assert.equal(h2.sends.find((s) => s.id === id).text, 'again');
  } finally { h2.runner.shutdown(); }
});

// ---- HTTP: admin only ----
async function served({ token = ADMIN } = {}) {
  const drainFile = path.join(tmp(), 'drain.json');
  const h = harness({ drainFile });
  const srv = createServer(h.runner, { token, hash: 'h', onShutdown() {} });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const call = async (headers, method, route, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: r.status, body: json };
  };
  const stop = async () => { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); h.runner.shutdown(); };
  return { h, drainFile, call, stop };
}

test('POST/DELETE /drain: agent token 403, admin 200; /health reports the drain', async () => {
  const s = await served();
  try {
    const id = s.h.create();
    const agent = { 'x-vs-agent-id': id, 'x-vs-agent-token': s.h.runner.tokensById.get(id) };
    assert.ok(agent['x-vs-agent-token'], 'the agent has a token');
    const admin = { authorization: `Bearer ${ADMIN}` };
    for (const method of ['POST', 'DELETE']) {
      const r = await s.call(agent, method, '/drain', method === 'POST' ? { ttlMs: 60_000 } : undefined);
      assert.equal(r.status, 403, `agent ${method}`);
    }
    assert.equal(s.h.runner.drainState(), null, 'an agent never set it');
    assert.equal((await s.call({}, 'POST', '/drain', { ttlMs: 60_000 })).status, 401);
    assert.equal((await s.call(admin, 'POST', '/drain', { ttlMs: 10 })).status, 400, 'bad TTL');
    const set = await s.call(admin, 'POST', '/drain', { ttlMs: 60_000, reason: 'vs restart' });
    assert.equal(set.status, 200);
    assert.equal(set.body.drain.reason, 'vs restart');
    assert.ok(existsSync(s.drainFile));
    const health = await s.call(admin, 'GET', '/health');
    assert.equal(health.body.drain.reason, 'vs restart');
    const del = await s.call(admin, 'DELETE', '/drain');
    assert.equal(del.status, 200);
    assert.equal(del.body.cleared, true);
    assert.equal((await s.call(admin, 'GET', '/health')).body.drain, null);
    assert.ok(!existsSync(s.drainFile));
  } finally { await s.stop(); }
});

// ---- the claude PreToolUse hook ----
const runHook = (drainFile, input, script = DRAIN_HOOK_SCRIPT) =>
  spawnSync(process.execPath, [script, drainFile], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 10_000 });
const bg = { tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } };

test('drain-hook: exit 2 + reason for background Bash/PowerShell while draining, 0 otherwise', () => {
  const root = tmp();
  const file = path.join(root, 'drain.json');
  writeFileSync(file, JSON.stringify({ since: Date.now(), until: Date.now() + 60_000, reason: 'vs restart' }));
  for (const tool of ['Bash', 'PowerShell']) {
    const r = runHook(file, { tool_name: tool, tool_input: { command: 'x', run_in_background: true } });
    assert.equal(r.status, 2, `${tool}: ${r.stderr}`);
    assert.match(r.stderr, /draining for a runtime restart/);
  }
  assert.equal(runHook(file, { tool_name: 'Bash', tool_input: { command: 'ls' } }).status, 0, 'foreground passes');
  assert.equal(runHook(file, { tool_name: 'Bash', tool_input: { command: 'ls', run_in_background: false } }).status, 0);
  assert.equal(runHook(file, { tool_name: 'Read', tool_input: { file_path: 'x', run_in_background: true } }).status, 0, 'other tools pass');
  assert.equal(runHook(file, 'not json').status, 0, 'unparseable stdin fails open');
});

test('drain-hook: fails open (exit 0) when drain.json is missing, corrupt, expired or has no `until`', () => {
  const root = tmp();
  const file = path.join(root, 'drain.json');
  assert.equal(runHook(file, bg).status, 0, 'missing');
  assert.equal(runHook('', bg).status, 0, 'no path arg');
  writeFileSync(file, '{"since": 1, "until":');
  assert.equal(runHook(file, bg).status, 0, 'corrupt');
  writeFileSync(file, JSON.stringify({ since: 1, until: Date.now() - 1 }));
  assert.equal(runHook(file, bg).status, 0, 'expired (a crashed runner left it)');
  writeFileSync(file, JSON.stringify({ since: 1 }));
  assert.equal(runHook(file, bg).status, 0, 'no until');
  mkdirSync(path.join(root, 'adir'));
  assert.equal(runHook(path.join(root, 'adir'), bg).status, 0, 'a directory, not a file');
  // The script itself unavailable: node exits 1, which Claude Code treats as a non-blocking hook error (only 2 blocks).
  assert.notEqual(runHook(file, bg, path.join(root, 'no-such-hook.mjs')).status, 2);
});

test('drainHookDecision is pure: null outside an unexpired drain or for non-background calls', () => {
  const now = 1_000_000;
  const d = { since: now - 10, until: now + 10, reason: 'r' };
  assert.match(drainHookDecision(bg, d, now), /draining/);
  assert.equal(drainHookDecision(bg, null, now), null);
  assert.equal(drainHookDecision(bg, { ...d, until: now }, now), null);
  assert.equal(drainHookDecision({ tool_name: 'Bash', tool_input: { run_in_background: 'true' } }, d, now), null, 'only literal true');
  assert.equal(drainHookDecision(null, d, now), null);
});

test('drain-hook: no-drain fast path is cheap (exits before reading stdin)', () => {
  const file = path.join(tmp(), 'drain.json');
  const n = 5;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) assert.equal(runHook(file, bg).status, 0);
  const perMs = Number(process.hrtime.bigint() - t0) / 1e6 / n;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  const baseMs = Number(process.hrtime.bigint() - t1) / 1e6 / n;
  console.log(`drain-hook no-drain: ${perMs.toFixed(1)} ms/call (bare node startup ${baseMs.toFixed(1)} ms)`);
  assert.ok(perMs < baseMs + 250, `hook ${perMs} ms vs node ${baseMs} ms`);
});

// ---- adapter settings ----
function fakeSpawn() {
  const impl = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    impl.calls.push({ file, args, opts });
    return child;
  };
  impl.calls = [];
  return impl;
}
const settingsOf = (args) => JSON.parse(args[args.indexOf('--settings') + 1]);

test('adapter: with a drain path the hook is ALWAYS installed (even with no drain.json at spawn); without one, none', () => {
  const root = tmp();
  const drainFile = path.join(root, 'drain.json');
  assert.ok(!existsSync(drainFile), 'no drain at spawn time');
  const spawnImpl = fakeSpawn();
  const a = createClaudeAdapter({ spawnImpl, command: process.execPath, mcp: false, promptsDir: path.join(root, 'p'), drainFile });
  a.start({ id: 'rn-d', cwd: os.tmpdir(), env: {}, emit() {}, onExit() {} });
  const s = settingsOf(spawnImpl.calls[0].args);
  assert.ok(s.enabledPlugins, 'plugins-off settings kept');
  const [entry] = s.hooks.PreToolUse;
  assert.equal(entry.matcher, 'Bash|PowerShell');
  assert.equal(entry.hooks[0].type, 'command');
  assert.match(entry.hooks[0].command, /^node .*drain-hook\.mjs .*drain\.json"?$/);
  assert.ok(!/\\/.test(entry.hooks[0].command), 'forward slashes only (bash and cmd)');

  const plain = fakeSpawn();
  createClaudeAdapter({ spawnImpl: plain, command: process.execPath, mcp: false, promptsDir: path.join(root, 'p2') })
    .start({ id: 'rn-n', cwd: os.tmpdir(), env: {}, emit() {}, onExit() {} });
  assert.equal(settingsOf(plain.calls[0].args).hooks, undefined);
});

test('adapter: the installed hook command runs through a shell (paths with spaces) and blocks only while draining', () => {
  const root = path.join(tmp(), 'with space');
  mkdirSync(root, { recursive: true });
  const drainFile = path.join(root, 'drain.json');
  const cmd = drainHookSettings(drainFile).PreToolUse[0].hooks[0].command;
  assert.match(cmd, /"[^"]*with space[^"]*drain\.json"$/, 'a whitespace path is quoted');
  const sh = (input) => spawnSync(cmd, { shell: true, input: JSON.stringify(input), encoding: 'utf8', timeout: 10_000 });
  assert.equal(sh(bg).status, 0, 'no drain file: allowed');
  writeFileSync(drainFile, JSON.stringify({ since: Date.now(), until: Date.now() + 60_000, reason: 'r' }));
  const r = sh(bg);
  assert.equal(r.status, 2, r.stderr);
  rmSync(drainFile);
  assert.equal(sh(bg).status, 0, 'drain cleared mid-session: allowed again, no respawn needed');
});
