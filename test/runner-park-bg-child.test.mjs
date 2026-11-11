// idea-89: the after-turn park must not kill background work an agent left running (Claude Code run_in_background Bash:
// a full test suite, a build). park() kills the whole process tree, so it is held while a shell lives under the CLI and
// happens once it exits; a max-hold bound turns a long hold into a logged forced park. Explicit stops still kill.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner, parkHoldMaxFromEnv, parkHoldPollFromEnv } from '../runner/runner.mjs';
import { backgroundWork, createBackgroundProbe } from '../runner/background.mjs';
import { killTree } from '../runner/spawn.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-parkbg-')); dirs.push(d); return d; };
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await tick(10); } };

// Fake agents with a pid. The probe answers from `work` (pid -> [{ pid, name, cmd }]), so a test turns a background shell on/off.
function harness(opts = {}) {
  const work = new Map();
  const probes = [];
  const kills = [];
  const ems = new Map();
  let nextPid = 1000;
  const adapter = {
    canPark: true,
    start({ id, emit }) {
      const pid = nextPid++;
      ems.set(id, emit);
      return { pid, send() { emit('status', { status: 'running' }); }, cancel() {}, kill() { kills.push(id); } };
    },
  };
  const bgProbe = async (pid) => { probes.push(pid); return work.get(pid) ?? []; };
  const runner = new Runner({ dir: tmp(), adapters: { fake: adapter }, parkGraceMs: 0, parkHoldPollMs: 20, parkHoldMaxMs: 60_000, bgProbe, ...opts });
  const create = (prompt = 'go') => {
    const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt });
    ems.get(id)('session', { sessionId: `s-${id}` });
    return id;
  };
  const endTurn = (id) => { const em = ems.get(id); em('turn_done', {}); em('status', { status: 'idle' }); };
  const pidOf = (id) => runner.live.get(id)?.handle.pid;
  const shell = (id) => { work.set(pidOf(id), [{ pid: 9000, name: 'bash', cmd: "eval 'npm test'" }]); };
  const clear = (id, pid) => { work.delete(pid ?? pidOf(id)); };
  return { runner, work, probes, kills, ems, create, endTurn, pidOf, shell, clear };
}
const types = (runner, id) => runner.timeline(id).map((e) => e.type);

test('env knobs: park hold max / poll', () => {
  assert.equal(parkHoldMaxFromEnv({}), 60 * 60 * 1000);
  assert.equal(parkHoldMaxFromEnv({ VS_RUNNER_PARK_HOLD_MAX_MS: '0' }), 0, '0 turns the hold off');
  assert.equal(parkHoldMaxFromEnv({ VS_RUNNER_PARK_HOLD_MAX_MS: 'x' }), 60 * 60 * 1000);
  assert.equal(parkHoldPollFromEnv({}), 15_000);
  assert.equal(parkHoldPollFromEnv({ VS_RUNNER_PARK_HOLD_POLL_MS: '500' }), 500);
});

test('park is held while a background shell lives under the agent, and happens after it exits', async () => {
  const h = harness();
  const id = h.create();
  const pid = h.pidOf(id);
  h.shell(id);
  h.endTurn(id);
  await tick(120);
  assert.deepEqual(h.kills, [], 'not killed while the background shell runs');
  assert.ok(h.runner.live.has(id), 'still live');
  assert.equal(h.runner.status(id).status, 'idle');
  const held = h.runner.timeline(id).filter((e) => e.type === 'park-held');
  assert.equal(held.length, 1, 'one park-held per hold');
  assert.equal(held[0].work[0].pid, 9000);
  assert.ok(h.probes.filter((p) => p === pid).length >= 2, 're-checked while held');
  h.clear(id, pid);
  await until(() => h.kills.length === 1);
  assert.deepEqual(h.kills, [id]);
  assert.equal(h.runner.status(id).status, 'parked');
  assert.ok(!types(h.runner, id).includes('park-forced'));
  h.runner.shutdown();
});

test('no background work: park happens right after the turn, as before', async () => {
  const h = harness();
  const id = h.create();
  h.endTurn(id);
  await until(() => h.kills.length === 1);
  assert.equal(h.runner.status(id).status, 'parked');
  assert.ok(!types(h.runner, id).includes('park-held'));
  h.runner.shutdown();
});

test('max hold: a hold past parkHoldMaxMs is a logged forced park, not a silent kill', async () => {
  const h = harness({ parkHoldMaxMs: 80 });
  const id = h.create();
  h.shell(id);
  h.endTurn(id);
  await tick(40);
  assert.deepEqual(h.kills, []);
  await until(() => h.kills.length === 1);
  const forced = h.runner.timeline(id).filter((e) => e.type === 'park-forced');
  assert.equal(forced.length, 1);
  assert.ok(forced[0].heldMs >= 80, `heldMs ${forced[0].heldMs}`);
  assert.equal(forced[0].work[0].pid, 9000, 'what was killed is on record');
  assert.equal(h.runner.status(id).status, 'parked');
  h.runner.shutdown();
});

test('parkHoldMaxMs 0 turns the hold off (old behaviour, no probe)', async () => {
  const h = harness({ parkHoldMaxMs: 0 });
  const id = h.create();
  h.shell(id);
  h.endTurn(id);
  await until(() => h.kills.length === 1);
  assert.deepEqual(h.probes, []);
  h.runner.shutdown();
});

test('shutdown still kills a held agent', async () => {
  const h = harness();
  const id = h.create();
  h.shell(id);
  h.endTurn(id);
  await tick(60);
  assert.deepEqual(h.kills, []);
  h.runner.shutdown();
  assert.deepEqual(h.kills, [id]);
  await tick(60);
  assert.deepEqual(h.kills, [id], 'no late hold re-check after shutdown');
});

test('archive (explicit stop) still kills a held agent, session kept', async () => {
  const h = harness();
  const id = h.create();
  h.shell(id);
  h.endTurn(id);
  await tick(60);
  h.runner.archive(id);
  assert.deepEqual(h.kills, [id]);
  await tick(60);
  assert.deepEqual(h.kills, [id]);
  h.runner.shutdown();
});

test('a new turn while held cancels the hold; its own idle re-checks', async () => {
  const h = harness();
  const id = h.create();
  h.shell(id);
  h.endTurn(id);
  await tick(60);
  h.runner.send(id, 'next');
  const before = h.probes.length;
  await tick(80);
  assert.equal(h.probes.length, before, 'no hold polling during a running turn');
  assert.deepEqual(h.kills, []);
  h.clear(id);
  h.endTurn(id);
  await until(() => h.kills.length === 1);
  assert.equal(h.runner.timeline(id).filter((e) => e.type === 'park-held').length, 1);
  h.runner.shutdown();
});

test('activity after idle (the CLI reporting a finished task on its own) defers the park', async () => {
  const h = harness({ parkGraceMs: 40 });
  const id = h.create();
  h.endTurn(id);
  await tick(20);
  h.ems.get(id)('output', { text: 'background task finished: 42 passed' }); // no running status: an unprompted turn
  await tick(35);
  assert.deepEqual(h.kills, [], 'not parked mid-output');
  await until(() => h.kills.length === 1);
  h.runner.shutdown();
});

test('makeRoom never parks a held agent: the new job queues and starts once the shell exits', async () => {
  const h = harness({ maxLive: 1 });
  const a = h.create();
  const pidA = h.pidOf(a);
  h.shell(a);
  h.endTurn(a);
  await tick(60);
  const b = h.runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'b' });
  assert.equal(h.runner.queuePosition(b).queued, true, 'b waits for the live slot');
  assert.deepEqual(h.kills, []);
  h.clear(a, pidA);
  await until(() => h.runner.live.has(b));
  assert.deepEqual(h.kills, [a]);
  h.runner.shutdown();
});

test('makeRoom probes an idle agent inside its grace before parking it for room', async () => {
  const h = harness({ maxLive: 1, parkGraceMs: 60_000 });
  const a = h.create();
  h.shell(a);
  h.endTurn(a);
  const b = h.runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'b' });
  await tick(60);
  assert.deepEqual(h.kills, [], 'a has a background shell: not parked for room');
  assert.equal(h.runner.queuePosition(b).queued, true);
  h.runner.shutdown();
  const h2 = harness({ maxLive: 1, parkGraceMs: 60_000 });
  const c = h2.create();
  h2.endTurn(c);
  const d = h2.runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'd' });
  await until(() => h2.runner.live.has(d));
  assert.deepEqual(h2.kills, [c], 'no background work: parked for room after the probe');
  h2.runner.shutdown();
});

test('setConfig on a held idle agent does not kill it; it parks after the shell exits', async () => {
  const h = harness({ parkGraceMs: 60_000 });
  const id = h.create();
  const pid = h.pidOf(id);
  h.shell(id);
  h.endTurn(id);
  await tick(20);
  h.runner.setConfig(id, { model: 'other' });
  await tick(60);
  assert.deepEqual(h.kills, []);
  assert.ok(h.runner.timeline(id).some((e) => e.type === 'park-held'));
  h.clear(id, pid);
  await until(() => h.kills.length === 1); // configStale: no 60s grace, the stale process goes as soon as the shell is gone
  assert.equal(h.runner.status(id).status, 'parked');
  h.runner.shutdown();
});

test('a failing probe falls back to the old park, with the error logged', async () => {
  const kills = [];
  let em;
  const adapter = { canPark: true, start({ emit }) { em = emit; return { pid: 7, send() { emit('status', { status: 'running' }); }, cancel() {}, kill() { kills.push(1); } }; } };
  const runner = new Runner({ dir: tmp(), adapters: { fake: adapter }, parkGraceMs: 0, parkHoldPollMs: 20, bgProbe: async () => { throw new Error('no powershell'); } });
  const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'x' });
  em('session', { sessionId: 's' }); em('turn_done', {}); em('status', { status: 'idle' });
  await until(() => kills.length === 1);
  assert.ok(runner.timeline(id).some((e) => e.type === 'park-probe-error' && /no powershell/.test(e.message)));
  runner.shutdown();
});

// ---- backgroundWork (pure) ----

test('backgroundWork: shells count; conhost, MCP sidecars and stale-ppid strangers do not', () => {
  const procs = [
    { pid: 1, ppid: 0, name: 'claude.exe', cmd: 'claude -p', createdMs: 1000 },
    { pid: 2, ppid: 1, name: 'conhost.exe', cmd: 'conhost.exe 0x4', createdMs: 1001 },
    { pid: 3, ppid: 1, name: 'node.exe', cmd: 'node C:/vs/runtime/server/mcp/server.mjs', createdMs: 1002 },
    { pid: 4, ppid: 1, name: 'cmd.exe', cmd: 'cmd /c npx -y @playwright/mcp@latest', createdMs: 1003 },
    { pid: 5, ppid: 4, name: 'node.exe', cmd: 'node playwright', createdMs: 1004 },
    { pid: 6, ppid: 1, name: 'uvx.exe', cmd: 'uvx blender-mcp', createdMs: 1005 },
    { pid: 7, ppid: 6, name: 'python.exe', cmd: 'python -c "import subprocess"', createdMs: 1006 },
    { pid: 8, ppid: 7, name: 'bash.exe', cmd: 'bash -c helper', createdMs: 1007 }, // inside a sidecar: not agent work
  ];
  assert.deepEqual(backgroundWork(procs, 1), []);
  procs.push(
    { pid: 10, ppid: 1, name: 'bash.exe', cmd: "bash -c \"source /c/Users/x/.claude/shell-snapshots/snap.sh && eval 'node --test test/mcp.test.mjs'\"", createdMs: 2000 },
    { pid: 11, ppid: 10, name: 'bash.exe', cmd: 'bash inner', createdMs: 2001 },
    { pid: 12, ppid: 11, name: 'node.exe', cmd: 'node --test', createdMs: 2002 },
    { pid: 20, ppid: 1, name: 'node.exe', cmd: 'node gemini relaunch', createdMs: 2100 }, // gemini relaunch child: not a shell
    { pid: 21, ppid: 20, name: 'powershell.exe', cmd: 'powershell -Command npm run build', createdMs: 2101 },
    { pid: 30, ppid: 1, name: 'sh', cmd: '/bin/sh -c make', createdMs: 500 }, // created before its "parent": a reused pid
  );
  const w = backgroundWork(procs, 1);
  assert.deepEqual(w.map((x) => [x.pid, x.name]), [[10, 'bash'], [21, 'powershell']], 'topmost shells only; a tool shell mentioning mcp still counts');
  assert.match(w[0].cmd, /mcp\.test\.mjs'"$/, 'cmd keeps the tail (the real command)');
  assert.deepEqual(backgroundWork(procs, 999), [], 'unknown root: nothing');
});

test('createBackgroundProbe: concurrent probes share one snapshot', async () => {
  let n = 0;
  const probe = createBackgroundProbe({ snapshot: async () => { n++; await tick(10); return [{ pid: 2, ppid: 1, name: 'bash', cmd: 'x' }]; }, ttlMs: 1000 });
  const [a, b] = await Promise.all([probe(1), probe(5)]);
  assert.equal(n, 1);
  assert.equal(a.length, 1);
  assert.equal(b.length, 0);
});

// Review-Gemini High: a tool command mentioning mcp is still work; sidecars under a wrapper CLI are not.
test('backgroundWork: tool shells that mention mcp count; sidecars at any depth do not', () => {
  const root = { pid: 1, ppid: 0, name: 'agy.exe', cmd: 'agy acp', createdMs: 1000 };
  const agyTool = { pid: 2, ppid: 1, name: 'powershell.exe', cmd: 'powershell -Command "try { $OutputEncoding = [System.Text.UTF8Encoding]::new($false); npm run test:mcp } catch {}"', createdMs: 1001 };
  const claudePs = { pid: 3, ppid: 1, name: 'pwsh.exe', cmd: 'pwsh -NoProfile -Command "$script = $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT; node --test test/mcp-tools.test.mjs"', createdMs: 1002 };
  const plainTool = { pid: 4, ppid: 1, name: 'bash', cmd: 'bash -c "node scripts/check-mcp.mjs && node test/runner-mcp.test.mjs"', createdMs: 1003 };
  assert.deepEqual(backgroundWork([root, agyTool, claudePs, plainTool], 1).map((w) => w.pid), [2, 3, 4]);

  const wrapper = [
    { pid: 10, ppid: 0, name: 'opencode.exe', cmd: 'opencode acp', createdMs: 1000 },
    { pid: 11, ppid: 10, name: 'opencode.exe', cmd: 'opencode.exe serve', createdMs: 1001 },
    { pid: 12, ppid: 11, name: 'cmd.exe', cmd: 'cmd /c npx -y @playwright/mcp@latest --headless', createdMs: 1002 },
    { pid: 13, ppid: 11, name: 'cmd.exe', cmd: 'cmd /c uvx blender-mcp', createdMs: 1003 },
    { pid: 14, ppid: 11, name: 'sh', cmd: '/bin/sh -c "node C:/vs/runtime/server/mcp/server.mjs"', createdMs: 1004 },
    { pid: 15, ppid: 11, name: 'cmd.exe', cmd: 'cmd /c npx -y @modelcontextprotocol/server-filesystem C:/x', createdMs: 1005 },
    { pid: 16, ppid: 11, name: 'bash', cmd: 'bash -c "npx mcp-server-fetch"', createdMs: 1006 },
    { pid: 17, ppid: 11, name: 'cmd.exe', cmd: 'cmd /c node C:\\Users\\x\\AppData\\Local\\VibeSquad\\runtime\\server\\mcp\\server.mjs', createdMs: 1007 },
    { pid: 18, ppid: 11, name: 'cmd.exe', cmd: 'cmd /c "C:\\uv\\Scripts\\blender-mcp.exe"', createdMs: 1008 },
    { pid: 19, ppid: 11, name: 'cmd.exe', cmd: 'cmd /c node C:\\npm\\node_modules\\@playwright\\mcp\\cli.js', createdMs: 1009 },
  ];
  assert.deepEqual(backgroundWork(wrapper, 10), [], 'MCP launchers under a wrapper CLI (depth >= 1) are sidecars');
});

// Review-Gemini Med: a snapshot that started before the agent's turn ended may miss a shell started late in that turn.
test('createBackgroundProbe: a probe with minAt never uses a snapshot started before it', async () => {
  let n = 0;
  const snaps = [];
  const probe = createBackgroundProbe({
    snapshot: async () => { n++; const k = n; await tick(30); snaps.push(k); return k === 1 ? [] : [{ pid: 2, ppid: 1, name: 'bash', cmd: 'npm test' }]; },
    ttlMs: 60_000,
  });
  const first = probe(1); // in flight, started before the turn ended
  await tick(10);
  const turnEnded = Date.now();
  await tick(2);
  const late = await probe(1, turnEnded); // must not join the in-flight one
  assert.equal(late.length, 1, 'took a fresh snapshot');
  assert.equal((await first).length, 0);
  assert.equal(n, 2);
  assert.equal((await probe(1, turnEnded)).length, 1, 'a snapshot started after minAt is reused');
  assert.equal(n, 2);
  await tick(2);
  await probe(1, Date.now());
  assert.equal(n, 3, 'cached snapshot older than minAt: a new one');
});

test('runner passes the turn-end time as minAt to the probe', async () => {
  const calls = [];
  let em;
  const adapter = { canPark: true, start({ emit }) { em = emit; return { pid: 77, send() { emit('status', { status: 'running' }); }, cancel() {}, kill() {} }; } };
  const runner = new Runner({ dir: tmp(), adapters: { fake: adapter }, parkGraceMs: 0, parkHoldPollMs: 20, bgProbe: async (pid, minAt) => { calls.push({ pid, minAt }); return []; } });
  const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'x' });
  em('session', { sessionId: 's' });
  await tick(5);
  const beforeIdle = Date.now();
  em('turn_done', {}); em('status', { status: 'idle' });
  await until(() => runner.status(id).status === 'parked');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pid, 77);
  assert.ok(Number.isFinite(calls[0].minAt) && calls[0].minAt >= beforeIdle, `minAt ${calls[0].minAt} >= ${beforeIdle}`);
  runner.shutdown();
});

// ---- one real process tree (cheap: node + one shell for ~1.5s) ----

test('real process: a live shell under the agent holds the park; it parks after the shell exits', async () => {
  const kills = [];
  let em;
  let child;
  // The shell lives until this file exists, not for a fixed time: under load the first process probe can take longer than any fixed budget.
  const release = path.join(tmp(), 'release');
  const adapter = {
    canPark: true,
    start({ emit }) {
      em = emit;
      // root = a node "CLI" that leaves a shell running (cmd.exe on Windows, /bin/sh elsewhere), like a background Bash
      const shellCmd = `node -e "const f=process.argv[1],fs=require('fs');const t=setInterval(()=>{if(fs.existsSync(f))clearInterval(t)},50)" "${release}" && echo done`;
      const script = `require('child_process').spawn(${JSON.stringify(shellCmd)}, { shell: true, stdio: 'ignore' }); setInterval(() => {}, 1000);`;
      child = spawn(process.execPath, ['-e', script], { stdio: 'ignore', windowsHide: true });
      return { pid: child.pid, send() { emit('status', { status: 'running' }); }, cancel() {}, kill() { kills.push(Date.now()); killTree(child); } };
    },
  };
  const runner = new Runner({ dir: tmp(), adapters: { fake: adapter }, parkGraceMs: 0, parkHoldPollMs: 200 });
  try {
    const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'x' });
    await tick(400); // let the shell start
    em('session', { sessionId: 's' }); em('turn_done', {}); em('status', { status: 'idle' });
    await until(() => runner.timeline(id).some((e) => e.type === 'park-held'), 30000);
    assert.deepEqual(kills, [], 'held, not killed');
    writeFileSync(release, '');
    await until(() => kills.length === 1, 30000);
    assert.equal(runner.status(id).status, 'parked');
    assert.ok(!runner.timeline(id).some((e) => e.type === 'park-forced'));
  } finally {
    runner.shutdown();
    killTree(child);
  }
});
