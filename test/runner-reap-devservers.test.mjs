// idea-515 (Z1): a worker's leaked listeners (vite dev/preview started with `&`: the tool shell died, so park's tree kill
// never reached them) are reaped once its process ends. Proof of ownership is the agent token in the listener's env (it
// survives a dead intermediate); held background work, other agents' processes, the VS runtime, the CLI itself and
// anything undatable or reused are never killed (fail closed, reported).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDevServerReaper, liveSubtree, markerPidsFor, parseMarkers, parseSs, parsePsEtimes, planReap, readEnvMarkers, reapCmdText, resetEnvReaderCache, sha256 } from '../runner/reap.mjs';
import { Runner } from '../runner/runner.mjs';
import { reapReporter } from '../runner/server.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-reap-')); dirs.push(d); return d; };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await tick(10); } };

// ---- planReap (pure) -----------------------------------------------------------------------------------------------

const T = 1_000_000; // clock base
const TOKEN = 'tok-w1';
const ME = { agentId: 'w1', tokenSha: sha256(TOKEN) };
const OTHER = { agentId: 'w2', tokenSha: sha256('tok-w2') };
// The live 11-21 shape: vite <- cmd <- npx node <- bash <- bash <- (dead tool shell 26024). MSYS bash shows no env.
const leak = () => [
  { pid: 14868, ppid: 26024, name: 'bash.exe', cmd: 'bash /c/Program Files/nodejs/npx vite --port 5199', createdMs: T + 100 },
  { pid: 14448, ppid: 14868, name: 'bash.exe', cmd: 'bash /c/Program Files/nodejs/npx vite --port 5199', createdMs: T + 200 },
  { pid: 39292, ppid: 14448, name: 'node.exe', cmd: 'node npx-cli.js vite --port 5199', createdMs: T + 300 },
  { pid: 29052, ppid: 39292, name: 'cmd.exe', cmd: 'cmd.exe /d /s /c vite --port 5199', createdMs: T + 400 },
  { pid: 21752, ppid: 29052, name: 'node.exe', cmd: '"node" "C:\\Users\\someone\\proj\\node_modules\\vite\\bin\\vite.js" --port 5199', createdMs: T + 500 },
  { pid: 21800, ppid: 21752, name: 'esbuild.exe', cmd: 'esbuild --service', createdMs: T + 600 },
];
const myMarkers = () => new Map([[21752, ME], [29052, ME], [39292, ME], [14448, { agentId: null, tokenSha: null }], [14868, { agentId: null, tokenSha: null }]]);
const base = (over = {}) => ({ procs: leak(), listeners: [{ pid: 21752, port: 5199 }], markers: myMarkers(), agentId: 'w1', tokenSha: ME.tokenSha, endedAt: T + 10_000, protectedPids: [], cliPid: 777, ...over });

test('planReap: an orphaned listener carrying this agent\'s token is reaped from its topmost token-carrying ancestor, as a tree', () => {
  const plan = planReap(base());
  assert.equal(plan.reap.length, 1);
  const r = plan.reap[0];
  assert.equal(r.root, 39292, 'npx node is the topmost ancestor with the token (MSYS bash shows none): the climb stops there');
  assert.deepEqual(r.pids.map((p) => p.pid).sort(), [21752, 21800, 29052, 39292], 'root + its live descendants (esbuild included)');
  assert.deepEqual(r.listeners, [{ pid: 21752, port: 5199 }]);
  assert.ok(!r.cmd.includes('someone'), `host path redacted: ${r.cmd}`);
  assert.deepEqual(plan.skipped, []);
});

test('planReap: another agent\'s listener, a token from another runner lifetime, an unreadable env: never reaped', () => {
  const other = planReap(base({ markers: new Map([[21752, OTHER], [29052, OTHER], [39292, OTHER]]) }));
  assert.deepEqual(other.reap, []);
  assert.deepEqual(other.skipped, [], 'another agent\'s listener is not ours: silent');
  assert.equal(other.foreign, 1);
  const stale = planReap(base({ markers: new Map([[21752, { agentId: 'w1', tokenSha: sha256('old-runner-token') }]]) }));
  assert.deepEqual(stale.reap, []);
  assert.deepEqual(stale.skipped.map((s) => s.reason), ['token-mismatch']);
  const unread = planReap(base({ markers: new Map([[21752, { error: 'open' }]]) }));
  assert.deepEqual(unread.reap, []);
  assert.deepEqual(unread.skipped.map((s) => s.reason), ['env-unreadable:open'], 'unsure: not killed, reported');
  const none = planReap(base({ markers: new Map() }));
  assert.deepEqual(none.reap, [], 'env not read: not a candidate');
  const noToken = planReap(base({ tokenSha: null }));
  assert.deepEqual(noToken.reap, []);
});

test('planReap: held background work is never touched (the listener, an ancestor, or a pid inside the tree)', () => {
  for (const pid of [21752, 39292, 14868, 21800]) {
    const plan = planReap(base({ protectedPids: [pid] }));
    assert.deepEqual(plan.reap, [], `protected ${pid}`);
    assert.match(plan.skipped[0].reason, /^held/);
  }
});

test('planReap: pid reuse: a stale parent link is never followed, up or down', () => {
  // The listener's ppid now names a process created AFTER it (the real parent died; its pid was reused): no climb.
  const procs = leak();
  procs.push({ pid: 50000, ppid: 1, name: 'explorer.exe', cmd: 'explorer', createdMs: T + 9000 });
  procs.find((p) => p.pid === 21752).ppid = 50000;
  const plan = planReap(base({ procs, markers: new Map([[21752, ME], [50000, ME]]) }));
  assert.equal(plan.reap[0].root, 21752, 'the reused pid is not an ancestor even with a matching marker');
  // A stranger whose stale ppid equals our root's pid (created before the root): not in the root's tree.
  const procs2 = leak();
  procs2.push({ pid: 61000, ppid: 39292, name: 'stranger.exe', cmd: 'stranger', createdMs: T - 50_000 });
  const tree = liveSubtree(39292, procs2).map((p) => p.pid);
  assert.ok(!tree.includes(61000), 'created before its "parent": a stale link');
  assert.ok(!planReap(base({ procs: procs2 })).reap[0].pids.some((p) => p.pid === 61000));
});

test('planReap: created after the process ended, undated, still under the live CLI, or the VS runtime: skipped', () => {
  assert.deepEqual(planReap(base({ endedAt: T + 450 })).skipped.map((s) => s.reason), ['created-after-end']);
  const undated = leak(); undated.find((p) => p.pid === 21752).createdMs = 0;
  assert.deepEqual(planReap(base({ procs: undated })).skipped.map((s) => s.reason), ['undated']);
  const later = leak(); later.find((p) => p.pid === 21800).createdMs = T + 20_000;
  assert.deepEqual(planReap(base({ procs: later })).skipped.map((s) => s.reason), ['tree-has-later-process']);
  const underCli = leak(); underCli.push({ pid: 777, ppid: 1, name: 'claude.exe', cmd: 'claude', createdMs: T }); underCli.find((p) => p.pid === 14868).ppid = 777;
  assert.deepEqual(planReap(base({ procs: underCli })).skipped.map((s) => s.reason), ['cli-alive'], 'the CLI is alive: park/exit owns that tree');
  const vs = leak(); vs.find((p) => p.pid === 21752).cmd = 'node C:\\x\\scripts\\serve.mjs --port 6767';
  assert.deepEqual(planReap(base({ procs: vs })).skipped.map((s) => s.reason), ['vs-runtime']);
});

test('planReap: two listeners in one tree are one reap; markerPidsFor reads listeners + live ancestors, newer than the token', () => {
  const plan = planReap(base({ listeners: [{ pid: 21752, port: 5199 }, { pid: 21752, port: 24678 }, { pid: 21800, port: 9000 }], markers: new Map([...myMarkers(), [21800, ME]]) }));
  assert.equal(plan.reap.length, 1);
  assert.deepEqual(plan.reap[0].listeners.map((l) => l.port).sort(), [24678, 5199, 9000]);
  assert.deepEqual(markerPidsFor([{ pid: 21752, port: 1 }], leak()).sort(), [14448, 14868, 21752, 29052, 39292]);
  assert.deepEqual(markerPidsFor([{ pid: 21752, port: 1 }], leak(), T + 5000), [], 'older than the token mint: cannot carry it, not read');
  assert.deepEqual(markerPidsFor([{ pid: 4, port: 445 }, { pid: 99999, port: 1 }], leak()), [], 'System / not in the table');
});

test('parsers: env-reader lines, ss, ps etimes; reapCmdText strips Claude\'s wrapper and host paths', () => {
  const m = parseMarkers(`12|ok|rn-abc|${'a'.repeat(64)}\r\n13|ok|-|-\n14|err|open\nnoise\n`);
  assert.deepEqual(m.get(12), { agentId: 'rn-abc', tokenSha: 'a'.repeat(64) });
  assert.deepEqual(m.get(13), { agentId: null, tokenSha: null });
  assert.deepEqual(m.get(14), { error: 'open' });
  assert.deepEqual(parseSs('LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=1234,fd=20))\nLISTEN 0 4096 [::]:22 [::]:* users:(("sshd",pid=9,fd=3))'), [{ pid: 1234, port: 5173, addr: '127.0.0.1' }, { pid: 9, port: 22, addr: '[::]' }]);
  assert.deepEqual(parsePsEtimes('  10   1   5 node node vite --port 1\n', 100_000), [{ pid: 10, ppid: 1, createdMs: 95_000, name: 'node', cmd: 'node vite --port 1' }]);
  const t = reapCmdText(`bash -c -l "source /tmp/snap && eval 'npx vite --port 5199 &' < /dev/null && pwd -P >| /tmp/claude-1-cwd"`);
  assert.ok(!t.includes('pwd -P') && t.includes('npx vite'), t);
  // idea-526 L1: the redacted path keeps its script name (the metric says which dev server), never the directories.
  const v = reapCmdText(leak()[4].cmd);
  assert.equal(v, 'node <host-path>/vite.js --port 5199');
  assert.equal(reapCmdText('node /home/someone/proj/node_modules/.bin/vite --port 1'), 'node <host-path>/vite --port 1');
  assert.equal(reapCmdText(`cd ${os.homedir()} && node C:\\Users\\someone\\proj\\dist\\ --x`), 'cd <host-path> && node <host-path> --x', 'a directory or the home folder (a user name) is never kept');
});

// ---- idea-526 M1: the Windows env reader is compiled once per runner, then only loaded ------------------------------

function fakePs({ onCompile = (out) => writeFileSync(out, 'fake-dll'), loadOut = '12|ok|-|-\n', inlineOut = `12|ok|rn-i|${'b'.repeat(64)}\n` } = {}) {
  const runs = [];
  const spawnImpl = (file, args) => {
    const script = args.at(-1);
    const kind = script.includes('-OutputAssembly') ? 'compile' : script.includes('Add-Type -Path') ? 'load' : script.includes('-TypeDefinition') ? 'inline' : 'other';
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = { on() {}, end(data) {
      runs.push({ kind, file, stdin: String(data) });
      setImmediate(() => {
        if (kind === 'compile') onCompile(String(data).split('\n---OUT---\n')[1]);
        if (kind === 'load') child.stdout.emit('data', loadOut);
        if (kind === 'inline') child.stdout.emit('data', inlineOut);
        child.emit('close', 0);
      });
    } };
    child.kill = () => {};
    return child;
  };
  return { runs, spawnImpl };
}

test('idea-526: readEnvMarkers on win32 compiles the C# helper once, then only loads it; the DLL dir is fresh and its bytes re-checked', async () => {
  resetEnvReaderCache();
  try {
    const ps = fakePs();
    const a = await readEnvMarkers([12], { platform: 'win32', spawnImpl: ps.spawnImpl });
    const b = await readEnvMarkers([12, 13], { platform: 'win32', spawnImpl: ps.spawnImpl });
    assert.deepEqual(ps.runs.map((r) => r.kind), ['compile', 'load', 'load']);
    assert.deepEqual(a.get(12), { agentId: null, tokenSha: null });
    assert.ok(b.has(12));
    const dll = ps.runs[0].stdin.split('\n---OUT---\n')[1];
    assert.match(path.basename(path.dirname(dll)), /^vs-reap-env-/, 'a mkdtemp dir of its own');
    assert.equal(ps.runs[1].stdin, `${dll}\n---PIDS---\n12`);
    assert.equal(ps.runs[2].stdin, `${dll}\n---PIDS---\n12,13`);
    assert.ok(!ps.runs[1].stdin.includes('VsReapEnv {'), 'no C# source on the load path');

    // The DLL changed on disk after compile: never loaded, inline compile from then on.
    writeFileSync(dll, 'tampered');
    const c = await readEnvMarkers([12], { platform: 'win32', spawnImpl: ps.spawnImpl });
    await readEnvMarkers([12], { platform: 'win32', spawnImpl: ps.spawnImpl });
    assert.deepEqual(ps.runs.slice(3).map((r) => r.kind), ['inline', 'inline']);
    assert.equal(c.get(12).agentId, 'rn-i');
  } finally { resetEnvReaderCache(); }
});

test('idea-526: a failed compile falls back to the inline probe (the old path) without retrying the compile', async () => {
  resetEnvReaderCache();
  try {
    const ps = fakePs({ onCompile: () => {} }); // compile "succeeds" but writes no DLL
    const a = await readEnvMarkers([12], { platform: 'win32', spawnImpl: ps.spawnImpl });
    await readEnvMarkers([12], { platform: 'win32', spawnImpl: ps.spawnImpl });
    assert.deepEqual(ps.runs.map((r) => r.kind), ['compile', 'inline', 'inline']);
    assert.equal(a.get(12).agentId, 'rn-i');
  } finally { resetEnvReaderCache(); }
});

test('idea-526 (real PowerShell): the second probe loads the compiled DLL and reads this process\'s env', { skip: process.platform !== 'win32' && 'win32 only', timeout: 120_000 }, async () => {
  resetEnvReaderCache();
  try {
    const kinds = [];
    const spy = (file, args, opts) => {
      const s = args.at(-1);
      kinds.push(s.includes('-OutputAssembly') ? 'compile' : s.includes('Add-Type -Path') ? 'load' : 'inline');
      return spawn(file, args, opts);
    };
    const first = await readEnvMarkers([process.pid], { platform: 'win32', spawnImpl: spy });
    const second = await readEnvMarkers([process.pid], { platform: 'win32', spawnImpl: spy });
    assert.deepEqual(kinds, ['compile', 'load', 'load']);
    assert.equal(first.get(process.pid)?.error, undefined, JSON.stringify([...first]));
    assert.deepEqual(second.get(process.pid), first.get(process.pid));
  } finally { resetEnvReaderCache(); }
});

// ---- createDevServerReaper (fakes) ---------------------------------------------------------------------------------

function fakeReaper({ redate } = {}) {
  const kills = [];
  const reaper = createDevServerReaper({
    platform: 'win32',
    snapshot: async () => ({ procs: leak(), listeners: [{ pid: 21752, port: 5199 }] }),
    markers: async () => myMarkers(),
    inspect: async (pids) => new Map(pids.map((p) => [p, { createdMs: (redate?.[p] ?? leak().find((x) => x.pid === p).createdMs) }])),
    kill: async (pids) => { kills.push(pids); },
  });
  return { reaper, kills };
}
const job = (over = {}) => ({ agentId: 'w1', token: TOKEN, endedAt: T + 10_000, protectedPids: [], cliPid: 777, ...over });

test('reaper: kills the proven tree (exact pids, re-dated just before) and reports pid, port, redacted cmd', async () => {
  const { reaper, kills } = fakeReaper();
  const r = await reaper(job());
  assert.deepEqual(kills.map((k) => k.sort()), [[21752, 21800, 29052, 39292]]);
  assert.equal(r.reaped.length, 1);
  assert.equal(r.reaped[0].pid, 21752);
  assert.equal(r.reaped[0].port, 5199);
  assert.match(r.reaped[0].cmd, /--port 5199/); // the full vite.js path is one host-path token: redacted whole (see REVIEW_Z1.md)
});

test('reaper: a pid whose start time moved (reused) is dropped; a reused listener means no kill at all', async () => {
  const a = fakeReaper({ redate: { 29052: T + 99_999 } });
  await a.reaper(job());
  assert.deepEqual(a.kills.map((k) => k.sort()), [[21752, 21800, 39292]], 'the reused pid is not killed');
  const b = fakeReaper({ redate: { 21752: T + 99_999 } });
  const r = await b.reaper(job());
  assert.deepEqual(b.kills, []);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['pid-changed']);
});

test('reaper: nothing is killed once the agent is live again; no token, a failing snapshot: no kill, error reported', async () => {
  const a = fakeReaper();
  const r = await a.reaper(job({ stillOk: () => false }));
  assert.deepEqual(a.kills, []);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['agent-live-again']);
  assert.match((await a.reaper(job({ token: '' }))).error, /token/);
  const broken = createDevServerReaper({ snapshot: async () => { throw new Error('cim down'); }, kill: async () => { throw new Error('must not kill'); } });
  assert.match((await broken(job())).error, /snapshot: cim down/);
});

// ---- Runner hook ---------------------------------------------------------------------------------------------------

function harness(opts = {}) {
  const ems = new Map();
  let nextPid = 5000;
  const adapter = { canPark: true, start({ id, emit }) { const pid = nextPid++; ems.set(id, emit); return { pid, send() { emit('status', { status: 'running' }); }, cancel() {}, kill() {} }; } };
  const jobs = [];
  const reports = [];
  const runner = new Runner({ dir: tmp(), adapters: { fake: adapter }, parkGraceMs: 0, bgProbe: null, reapDelayMs: 20, reaper: async (j) => { jobs.push(j); return { reaped: [{ pid: 1, port: 2, root: 1, pids: [1], cmd: 'vite' }], skipped: [] }; }, onReap: (r) => reports.push(r), ...opts });
  const create = (meta) => { const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'go', meta }); ems.get(id)('session', { sessionId: `s-${id}` }); return id; };
  const endTurn = (id) => { const em = ems.get(id); em('turn_done', {}); em('status', { status: 'idle' }); };
  return { runner, ems, jobs, reports, create, endTurn };
}

test('Runner: a worker\'s park arms one reap with its own token, end time and CLI pid; the report reaches onReap', async (t) => {
  const h = harness();
  t.after(() => h.runner.shutdown());
  const id = h.create({ role: 'worker', team: 'vibesquad', lane: 'bug-chaser' });
  const cli = h.runner.live.get(id).handle.pid;
  h.endTurn(id);
  await until(() => h.jobs.length === 1);
  const j = h.jobs[0];
  assert.equal(j.agentId, id);
  assert.equal(j.token, h.runner.tokenFor(id));
  assert.equal(j.cliPid, cli);
  assert.ok(j.since > 0 && j.since <= j.endedAt);
  assert.ok(j.protectedPids.includes(process.pid), 'the runner itself is protected');
  assert.equal(j.stillOk(), true);
  await until(() => h.reports.length === 1);
  assert.deepEqual({ id: h.reports[0].id, why: h.reports[0].why, lane: h.reports[0].lane }, { id, why: 'park', lane: 'bug-chaser' });
  await tick(60);
  assert.equal(h.jobs.length, 1, 'one reap per process end');
});

test('Runner: leads, Buddies and role-less agents are never reaped; a worker resumed before the delay is not either', async (t) => {
  const h = harness({ reapDelayMs: 80 });
  t.after(() => h.runner.shutdown());
  for (const role of ['lead', 'brainstorm', undefined]) { const id = h.create(role ? { role } : {}); h.endTurn(id); }
  const w = h.create({ role: 'worker' });
  h.endTurn(w);
  await until(() => h.runner.status(w).status === 'parked');
  h.runner.send(w, 'again'); // resumes: its new process owns the tree now
  await tick(200);
  assert.deepEqual(h.jobs, []);
});

test('Runner: other live agents\' probed/held shells and this worker\'s own last hold are protected', async (t) => {
  const h = harness({ reapDelayMs: 20 });
  t.after(() => h.runner.shutdown());
  const lead = h.create({ role: 'lead' });
  const le = h.runner.live.get(lead);
  le.heldNow = [{ pid: 4242, name: 'bash', cmd: 'npm test' }];
  le.work = [{ pid: 4343, name: 'bash', cmd: 'vite' }];
  const w = h.create({ role: 'worker' });
  h.runner.live.get(w).heldWork = [{ pid: 5151, name: 'bash', cmd: 'godot suite' }];
  h.endTurn(w);
  await until(() => h.jobs.length === 1);
  for (const pid of [4242, 4343, 5151]) assert.ok(h.jobs[0].protectedPids.includes(pid), `protected ${pid}`);
});

test('reapReporter: one runner.log line; a team-log metric per reaped listener with agent, pid, port, cmd; skips stay in runner.log', () => {
  const logged = [];
  const team = [];
  reapReporter((e) => team.push(e), (o) => logged.push(o))({ id: 'rn-1', why: 'park', team: 'vibesquad', lane: 'bug-chaser', reaped: [{ pid: 21752, port: 5199, root: 39292, pids: [39292, 21752], cmd: 'npx vite --port 5199' }], skipped: [{ pid: 9, port: 1, reason: 'env-unreadable:open' }] });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].reap.agent, 'rn-1');
  assert.equal(logged[0].reap.skipped[0].reason, 'env-unreadable:open');
  assert.equal(team.length, 1);
  assert.equal(team[0].type, 'metric');
  assert.equal(team[0].lane, 'bug-chaser');
  assert.match(team[0].text, /rn-1.*pid 21752 port 5199.*npx vite --port 5199/);
});

// ---- real processes (done check) -----------------------------------------------------------------------------------
// A fake "worker CLI" (node) with VS_AGENT_ID/VS_AGENT_TOKEN in its env starts a tool shell that launches a listener and
// exits at once (the `npx vite &` shape: the listener's parent is dead). Then the CLI is killed as park would. A declared
// background listener of the same worker (held: protected) and another agent's orphaned listener are alive too.

const REAL = process.platform === 'win32' || process.platform === 'linux';
const LISTENER = `const fs=require('fs');require('http').createServer(()=>{}).listen(0,'127.0.0.1',function(){fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,port:this.address().port}))});setTimeout(()=>{},600000)`;
// The tool shell: starts the listener detached and exits (its child is orphaned with a dead parent).
const SHELL = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e',process.argv[2],process.argv[1]],{detached:true,stdio:'ignore',windowsHide:true});c.unref();process.exit(0)`;
const CLI = `const {spawn}=require('child_process');spawn(process.execPath,['-e',process.argv[3],process.argv[1],process.argv[2]],{stdio:'ignore',windowsHide:true});setTimeout(()=>{},600000)`;
const agentEnv = (id, token) => { const e = { ...process.env, VS_AGENT_ID: id, VS_AGENT_TOKEN: token }; delete e.PASEO_AGENT_ID; return e; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const readInfo = (f) => JSON.parse(readFileSync(f, 'utf8'));

test('done check (real processes): the worker\'s orphaned listener is reaped; its held background listener and another agent\'s listener survive', { skip: !REAL && 'unsupported platform', timeout: 120_000 }, async () => {
  const d = tmp();
  const w1 = `z1-test-w1-${randomBytes(3).toString('hex')}`;
  const tok1 = randomBytes(16).toString('hex');
  const procs = [];
  const survivors = [];
  try {
    // worker 1: CLI -> tool shell (exits) -> listener (orphan)
    const orphanFile = path.join(d, 'orphan.json');
    const cli1 = spawn(process.execPath, ['-e', CLI, orphanFile, LISTENER, SHELL], { env: agentEnv(w1, tok1), stdio: 'ignore', windowsHide: true });
    procs.push(cli1);
    // worker 1's declared background listener (a held shell's child): protected
    const heldFile = path.join(d, 'held.json');
    const held = spawn(process.execPath, ['-e', LISTENER, heldFile], { env: agentEnv(w1, tok1), stdio: 'ignore', windowsHide: true });
    procs.push(held);
    // another agent's orphaned listener
    const otherFile = path.join(d, 'other.json');
    const cli2 = spawn(process.execPath, ['-e', CLI, otherFile, LISTENER, SHELL], { env: agentEnv(`z1-test-w2-${randomBytes(3).toString('hex')}`, randomBytes(16).toString('hex')), stdio: 'ignore', windowsHide: true });
    procs.push(cli2);
    await until(() => existsSync(orphanFile) && existsSync(heldFile) && existsSync(otherFile), 20_000);
    await tick(200); // the files are written in the listen callback; let the writes land
    const orphan = readInfo(orphanFile);
    const heldInfo = readInfo(heldFile);
    const other = readInfo(otherFile);
    survivors.push(heldInfo.pid, other.pid);
    // The worker's process ends (park kills its tree; the orphan is out of it). cli2 ends too: its listener is an orphan as well.
    cli1.kill();
    cli2.kill();
    await tick(500);
    assert.ok(alive(orphan.pid), 'precondition: the CLI\'s death left the listener running (the leak)');
    const r = await createDevServerReaper()({ agentId: w1, token: tok1, since: Date.now() - 120_000, endedAt: Date.now(), protectedPids: [held.pid, process.pid], cliPid: cli1.pid });
    assert.equal(r.error, undefined, `reaper error: ${r.error}`);
    assert.deepEqual(r.reaped.map((x) => [x.pid, x.port]), [[orphan.pid, orphan.port]], JSON.stringify(r));
    await until(() => !alive(orphan.pid), 10_000);
    assert.ok(alive(heldInfo.pid), 'the declared/held background listener survives');
    assert.ok(alive(other.pid), 'another agent\'s listener survives');
    assert.ok(r.skipped.some((s) => s.pid === heldInfo.pid && s.reason === 'held'), `held reported: ${JSON.stringify(r.skipped)}`);
  } finally {
    for (const p of procs) { try { p.kill(); } catch { /* gone */ } }
    for (const pid of survivors) { try { process.kill(pid); } catch { /* gone */ } }
    try { const o = readInfo(path.join(d, 'orphan.json')); process.kill(o.pid); } catch { /* reaped */ }
  }
});
