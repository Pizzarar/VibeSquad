// idea-1140: an ended worker's leftovers (non-listener processes outside its CLI's tree and group that still carry its
// VS_AGENT_ID + VS_AGENT_TOKEN) are reaped on exit and archive stop: runner/detached.mjs planAgentLeftovers (pure) +
// createLeftoverReaper (executor), reached through runner/reap.mjs createDevServerReaper({ leftovers }) from
// Runner._reapAfterEnd. Live 11-26: headless Chromium's crashpad + helpers outlived rn-10db93c202e8 and read `left` at 3 boots.
import "./helpers/clean-env.mjs";
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDevServerReaper, killPids, sha256 } from '../runner/reap.mjs';
import { createLeftoverReaper, planAgentLeftovers } from '../runner/detached.mjs';
import { Runner } from '../runner/runner.mjs';
import { reapReporter } from '../runner/server.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-reap-tree-')); dirs.push(d); return d; };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await tick(10); } };

// ---- planAgentLeftovers (pure) -------------------------------------------------------------------------------------

const T = 7_000_000;
const END = T + 60_000;
const W1 = { agentId: 'w1', tokenSha: sha256('tok-w1') };
const NONE = { agentId: null, tokenSha: null };
const SELF = 50; // the runner
// The live shape: runner (50) -> live CLI of another agent (60) -> its shell (61). The ended worker's script exited, so its
// Chromium (300, group leader after setsid) and its children (301 zygote, 302 gpu; same group) plus crashpad (310, its own
// session) hang off the subreaper (2). Strangers: 400 (no marker), 410 (another agent), 420 (w1's id, wrong token).
const table = () => [
  { pid: 2, ppid: 1, pgid: 2, createdMs: T - 1e6, cmd: 'systemd --user' },
  { pid: 49, ppid: 2, pgid: 49, createdMs: T - 9000, cmd: 'bash' },
  { pid: SELF, ppid: 49, pgid: 50, createdMs: T - 5000, cmd: 'node runner/server.mjs' },
  { pid: 60, ppid: SELF, pgid: 60, createdMs: T + 10, cmd: 'claude' },
  { pid: 61, ppid: 60, pgid: 60, createdMs: T + 20, cmd: 'bash -c npm test' },
  { pid: 300, ppid: 2, pgid: 300, createdMs: T + 1000, cmd: '/usr/bin/chromium-browser --headless --screenshot' },
  { pid: 301, ppid: 300, pgid: 300, createdMs: T + 1100, cmd: '/usr/lib/chromium/chromium --type=zygote' },
  { pid: 302, ppid: 300, pgid: 300, createdMs: T + 1200, cmd: '/usr/lib/chromium/chromium --type=gpu-process' },
  { pid: 310, ppid: 300, pgid: 310, createdMs: T + 1300, cmd: '/usr/lib/chromium/chrome_crashpad_handler --database=/tmp/x' },
  { pid: 400, ppid: 2, pgid: 400, createdMs: T + 2000, cmd: 'sleep 600' },
  { pid: 410, ppid: 2, pgid: 410, createdMs: T + 2000, cmd: 'node other.js' },
  { pid: 420, ppid: 2, pgid: 420, createdMs: T + 2000, cmd: 'node forged.js' },
];
const marks = () => new Map([
  [60, { agentId: 'w2', tokenSha: sha256('tok-w2') }], [61, { agentId: 'w2', tokenSha: sha256('tok-w2') }],
  [300, W1], [301, W1], [302, W1], [310, W1],
  [400, NONE], [410, { agentId: 'w2', tokenSha: sha256('tok-w2') }], [420, { agentId: 'w1', tokenSha: sha256('tok-from-a-dead-lifetime') }],
]);
const plan = (over = {}) => planAgentLeftovers({ procs: table(), markers: marks(), agentId: 'w1', tokenSha: W1.tokenSha, endedAt: END, cliPids: [60], protectedPids: [SELF, 49], selfPid: SELF, ...over });

test('planAgentLeftovers: the ended worker\'s detached tree is one entry, leaf-first, group-killed only because the whole group is its own', () => {
  const r = plan();
  assert.equal(r.reap.length, 1, JSON.stringify(r));
  const e = r.reap[0];
  assert.equal(e.root, 300);
  assert.equal(e.agentId, 'w1');
  assert.deepEqual(e.pids.map((x) => x.pid), [310, 302, 301, 300], 'leaf-first: children before the root');
  assert.equal(e.pgid, 300, 'group 300 = {300, 301, 302}, all verified w1 pids');
  assert.deepEqual(r.skipped, []);
});

test('planAgentLeftovers: no marker, another agent\'s id, w1\'s id with the wrong token: never planned', () => {
  const pids = plan().reap.flatMap((e) => e.pids.map((x) => x.pid));
  for (const p of [400, 410, 420]) assert.ok(!pids.includes(p), `stranger ${p} planned`);
  // Alone (no Chromium at all), nothing is planned either.
  const only = table().filter((p) => ![300, 301, 302, 310].includes(p.pid));
  assert.deepEqual(plan({ procs: only }).reap, []);
  // No token sha (the runner lost the token): nothing at all.
  assert.deepEqual(plan({ tokenSha: null }).reap, []);
});

test('planAgentLeftovers: the runner, its parent, the runtime, a held pid and every live CLI tree are protected', () => {
  // The same marker on the runner's own process, its parent and a live CLI's shell: none of them is planned.
  const m = marks();
  for (const p of [SELF, 49, 60, 61]) m.set(p, W1);
  const r = plan({ markers: m });
  const pids = r.reap.flatMap((e) => e.pids.map((x) => x.pid));
  for (const p of [SELF, 49, 60, 61]) assert.ok(!pids.includes(p), `protected ${p} planned`);
  // A held shell inside the detached tree: the whole entry is skipped (never killed around held work).
  assert.deepEqual(plan({ protectedPids: [SELF, 49, 301] }).reap, []);
  // The runtime (scripts/serve.mjs) carrying the marker, or as an ancestor of the tree: never.
  const rt = table().map((p) => (p.pid === 300 ? { ...p, cmd: 'node scripts/serve.mjs' } : p));
  assert.deepEqual(plan({ procs: rt }).reap, []);
  // A live CLI pid (the agent resumed, same token): its tree is never leftovers.
  const resumed = [...table(), { pid: 70, ppid: SELF, pgid: 70, createdMs: T + 50, cmd: 'claude --resume' }, { pid: 71, ppid: 70, pgid: 70, createdMs: T + 60, cmd: 'node build.js' }];
  const m2 = marks(); m2.set(70, W1); m2.set(71, W1);
  const r2 = plan({ procs: resumed, markers: m2, cliPids: [60, 70] });
  assert.ok(!r2.reap.some((e) => e.pids.some((x) => x.pid === 70 || x.pid === 71)), 'resumed CLI tree untouched');
});

test('planAgentLeftovers: only processes created before the end; a later member also drops the group kill', () => {
  const r = plan({ endedAt: T + 1150 }); // 302 and 310 started after the agent ended
  assert.deepEqual(r.reap[0].pids.map((x) => x.pid), [301, 300]);
  assert.equal(r.reap[0].pgid, null, 'group 300 holds 302 (later): exact pids only');
  assert.deepEqual(r.skipped.map((s) => [s.pid, s.reason]).sort(), [[302, 'created-after-end'], [310, 'created-after-end']]);
  // A root created after the end: nothing.
  assert.deepEqual(plan({ endedAt: T + 900 }).reap, []);
  // Undated members are never killed.
  const und = table().map((p) => (p.pid === 302 ? { ...p, createdMs: 0 } : p));
  assert.ok(!plan({ procs: und }).reap[0].pids.some((x) => x.pid === 302));
});

test('planAgentLeftovers: a group with a stranger in it is never signalled; a foreign marker in the tree skips the entry; unreadable members are left', () => {
  // A stranger (no valid parent link to 300) joined group 300: the group is not wholly w1's.
  const g = [...table(), { pid: 330, ppid: 2, pgid: 300, createdMs: T + 1400, cmd: 'other' }];
  const r = plan({ procs: g });
  assert.equal(r.reap[0].pgid, null);
  assert.deepEqual(r.reap[0].pids.map((x) => x.pid), [310, 302, 301, 300]);
  // Another agent's marker inside w1's tree: unsure, skipped whole.
  const m = marks(); m.set(302, { agentId: 'w2', tokenSha: sha256('tok-w2') });
  const f = plan({ markers: m });
  assert.deepEqual(f.reap, []);
  assert.deepEqual(f.skipped, [{ pid: 302, root: 300, reason: 'foreign-in-tree' }]);
  // A half marker (w1's id, no token) is foreign too.
  const h = marks(); h.set(301, { agentId: 'w1', tokenSha: null });
  assert.deepEqual(plan({ markers: h }).reap, []);
  // A setuid helper whose env cannot be read: not killed (and no group kill), the rest is.
  const u = marks(); u.set(302, { error: 'open' });
  const ur = plan({ markers: u });
  assert.deepEqual(ur.reap[0].pids.map((x) => x.pid), [310, 301, 300]);
  assert.equal(ur.reap[0].pgid, null);
  assert.deepEqual(ur.skipped, [{ pid: 302, root: 300, reason: 'env-unreadable:open' }]);
  // An unmarked child (cleared env) under a w1 root is the root's own work: killed.
  const n = marks(); n.set(310, NONE);
  assert.deepEqual(plan({ markers: n }).reap[0].pids.map((x) => x.pid), [310, 302, 301, 300]);
});

// ---- createLeftoverReaper (executor, injected seams) ---------------------------------------------------------------

function fakeLeftover({ platform = 'linux', startsSeq = null, procs = table() } = {}) {
  const kills = [];
  const envReads = [];
  const startReads = [];
  const exact = new Map(procs.map((p) => [p.pid, `boot/${p.createdMs}`]));
  let call = 0;
  const reaper = createLeftoverReaper({
    platform,
    snapshot: async () => procs,
    markers: async (pids) => { envReads.push([...pids]); const m = marks(); return new Map(pids.filter((p) => m.has(p)).map((p) => [p, m.get(p)])); },
    starts: async (pids) => { startReads.push([...pids]); const s = startsSeq?.[call++] ?? exact; return new Map(pids.filter((p) => s.has(p)).map((p) => [p, s.get(p)])); },
    kill: async (pids, pgid) => { kills.push({ pids, pgid }); },
  });
  return { reaper, kills, envReads, startReads, exact };
}
const job = (over = {}) => ({ agentId: 'w1', token: 'tok-w1', since: T, endedAt: END, protectedPids: [SELF, 49], liveCliPids: [60], selfPid: SELF, stillOk: () => true, ...over });

test('createLeftoverReaper: env proof bracketed by start reads; kills the verified pids leaf-first with the group', async () => {
  const f = fakeLeftover();
  const r = await f.reaper(job());
  assert.equal(r.error, undefined);
  assert.deepEqual(f.kills, [{ pids: [310, 302, 301, 300], pgid: 300 }]);
  assert.deepEqual(r.reaped.map((x) => [x.root, x.pgid, x.pids]), [[300, 300, [310, 302, 301, 300]]]);
  assert.equal(f.startReads.length, 2, 'one start read before the env read, one right before the kill');
  assert.ok(f.startReads[0].includes(300) && f.envReads[0].includes(300));
  for (const p of [SELF, 49, 60, 61]) assert.ok(!f.envReads[0].includes(p), `protected/live-tree pid ${p} is not even read`);
});

test('createLeftoverReaper: pid reuse (start moved between the env read and the kill) is refused; a gone pid too; no group kill then', async () => {
  const f0 = fakeLeftover();
  const moved = new Map(f0.exact); moved.set(302, 'boot/999'); moved.delete(310);
  const f = fakeLeftover({ startsSeq: [f0.exact, moved] });
  const r = await f.reaper(job());
  assert.deepEqual(f.kills, [{ pids: [301, 300], pgid: null }], 'only the unchanged pids, exact (no group signal)');
  assert.deepEqual(r.skipped.map((s) => [s.pid, s.reason]).sort(), [[302, 'pid-changed'], [310, 'gone']]);
  // A reused ROOT pid (the whole entry moved): nothing of it, and nothing whose start the first read missed.
  const allMoved = new Map([...f0.exact].map(([p, s]) => [p, `${s}x`]));
  const g = fakeLeftover({ startsSeq: [f0.exact, allMoved] });
  await g.reaper(job());
  assert.deepEqual(g.kills, []);
  const h = fakeLeftover({ startsSeq: [new Map(), f0.exact] });
  await h.reaper(job());
  assert.deepEqual(h.kills, [], 'no start before the env read: never killed');
});

test('createLeftoverReaper: nothing once the agent is live again; no token; a failing snapshot or env read: no kill, error reported', async () => {
  const f = fakeLeftover();
  const r = await f.reaper(job({ stillOk: () => false }));
  assert.deepEqual(f.kills, []);
  assert.deepEqual(r.skipped.map((s) => s.reason), ['agent-live-again']);
  assert.match((await f.reaper(job({ token: '' }))).error, /token/);
  const broken = createLeftoverReaper({ platform: 'linux', snapshot: async () => { throw new Error('ps gone'); }, kill: () => { throw new Error('must not kill'); } });
  assert.match((await broken(job())).error, /snapshot: ps gone/);
  const noEnv = createLeftoverReaper({ platform: 'linux', snapshot: async () => table(), starts: async () => new Map(), markers: async () => { throw new Error('proc'); }, kill: () => { throw new Error('must not kill'); } });
  assert.match((await noEnv(job())).error, /env: proc/);
  const mac = createLeftoverReaper({ platform: 'darwin' });
  assert.match((await mac(job())).error, /unsupported platform darwin/);
});

test('createLeftoverReaper (win32 planning): the CIM CreationDate is the first start read; a moved CreationDate is refused; no group', async () => {
  // Windows rows: no pgid, exact CreationDate ms. The killer gets exact pids only.
  const win = table().map(({ pgid, ...p }) => p);
  const later = new Map(win.map((p) => [p.pid, String(p.createdMs)]));
  later.set(301, String(T + 1101)); // pid 301 reused between the CIM table and the kill
  const kills = [];
  const startReads = [];
  const r = await createLeftoverReaper({
    platform: 'win32',
    snapshot: async () => win,
    markers: async (pids) => { const m = marks(); return new Map(pids.filter((p) => m.has(p)).map((p) => [p, m.get(p)])); },
    starts: async (pids) => { startReads.push(pids); return new Map(pids.filter((p) => later.has(p)).map((p) => [p, later.get(p)])); },
    kill: async (pids, pgid) => { kills.push({ pids, pgid }); },
  })(job());
  assert.equal(startReads.length, 1, 'win32: only the re-read before the kill (the table was exact)');
  assert.deepEqual(kills, [{ pids: [310, 302, 300], pgid: null }]);
  assert.deepEqual(r.skipped.map((s) => [s.pid, s.reason]), [[301, 'pid-changed']]);
});

test('killPids (the win32 killer): one taskkill /F with a /PID per pid, never /T; POSIX SIGKILLs exactly those pids in order', async () => {
  const calls = [];
  const fakeSpawn = (file, args) => { calls.push({ file, args }); return { on: (ev, cb) => { if (ev === 'close') setImmediate(cb); } }; };
  await killPids([310, 302, 300], { platform: 'win32', spawnImpl: fakeSpawn });
  assert.deepEqual(calls, [{ file: 'taskkill', args: ['/F', '/PID', '310', '/PID', '302', '/PID', '300'] }]);
  assert.ok(!calls[0].args.includes('/T'));
  const sig = [];
  await killPids([310, 302, 0, 4, 300], { platform: 'linux', killImpl: (p, s) => sig.push([p, s]) });
  assert.deepEqual(sig, [[310, 'SIGKILL'], [302, 'SIGKILL'], [300, 'SIGKILL']]);
});

test('createDevServerReaper({ leftovers }): runs the leftover reap only for a job that asks for it; its result rides under .leftovers', async () => {
  const lo = [];
  const reaper = createDevServerReaper({ snapshot: async () => ({ procs: [], listeners: [] }), markers: async () => new Map(), leftovers: async (j) => { lo.push(j); return { reaped: [{ root: 300, pids: [300], cmd: 'chromium' }], skipped: [] }; } });
  const base = { agentId: 'w1', token: 'tok-w1', since: 0, endedAt: Date.now() };
  const park = await reaper(base);
  assert.equal(park.leftovers, undefined);
  assert.equal(lo.length, 0);
  const exit = await reaper({ ...base, leftovers: true, liveCliPids: [60] });
  assert.equal(lo.length, 1);
  assert.deepEqual(lo[0].liveCliPids, [60]);
  assert.deepEqual(exit.leftovers.reaped.map((x) => x.root), [300]);
  const boom = createDevServerReaper({ snapshot: async () => ({ procs: [], listeners: [] }), markers: async () => new Map(), leftovers: async () => { throw new Error('x'); } });
  assert.equal((await boom({ ...base, leftovers: true })).leftovers.error, 'x');
});

// ---- Runner hook ---------------------------------------------------------------------------------------------------

function harness(opts = {}) {
  const ems = new Map();
  const exits = new Map();
  let nextPid = 5000;
  const adapter = { canPark: true, start({ id, emit, onExit }) { const pid = nextPid++; ems.set(id, emit); exits.set(id, onExit); return { pid, send() { emit('status', { status: 'running' }); }, cancel() {}, kill() {} }; } };
  const jobs = [];
  const reports = [];
  const runner = new Runner({ dir: tmp(), adapters: { fake: adapter }, parkGraceMs: 60_000, bgProbe: null, reapDelayMs: 20, reaper: async (j) => { jobs.push(j); return { reaped: [], skipped: [], leftovers: { reaped: [{ agentId: j.agentId, root: 300, pgid: 300, pids: [310, 300], cmd: 'chromium' }], skipped: [] } }; }, onReap: (r) => reports.push(r), ...opts });
  const create = (meta) => { const id = runner.create({ provider: 'fake', cwd: os.tmpdir(), prompt: 'go', meta }); ems.get(id)('session', { sessionId: `s-${id}` }); return id; };
  const endTurn = (id) => { const em = ems.get(id); em('turn_done', {}); em('status', { status: 'idle' }); };
  return { runner, ems, exits, jobs, reports, create, endTurn };
}

test('Runner: a worker\'s exit and archive stop ask for leftovers (live CLI pids + the runner as selfPid); a park does not', async (t) => {
  const h = harness();
  t.after(() => h.runner.shutdown());
  const other = h.create({ role: 'lead' }); // a live CLI whose tree must stay protected
  const otherCli = h.runner.live.get(other).handle.pid;
  const ex = h.create({ role: 'worker', lane: 'bug-chaser' });
  h.endTurn(ex);
  h.exits.get(ex)({ code: 0 });
  await until(() => h.jobs.length === 1);
  assert.equal(h.jobs[0].agentId, ex);
  assert.equal(h.jobs[0].leftovers, true);
  assert.equal(h.jobs[0].selfPid, process.pid);
  assert.ok(h.jobs[0].liveCliPids.includes(otherCli));
  assert.ok(h.jobs[0].protectedPids.includes(process.pid) && h.jobs[0].protectedPids.includes(process.ppid));
  await until(() => h.reports.length === 1);
  assert.equal(h.reports[0].why, 'exit');
  assert.deepEqual(h.reports[0].leftovers.reaped.map((r) => r.root), [300]);

  const ar = h.create({ role: 'worker' });
  h.endTurn(ar);
  h.runner.archive(ar);
  await until(() => h.jobs.length === 2);
  assert.equal(h.jobs[1].agentId, ar);
  assert.equal(h.jobs[1].leftovers, true);
  assert.equal(h.reports[1]?.why ?? (await until(() => h.reports.length === 2), h.reports[1].why), 'stop');

  const pk = h.create({ role: 'worker' });
  h.endTurn(pk);
  h.runner.park(pk);
  await until(() => h.jobs.length === 3);
  assert.equal(h.jobs[2].agentId, pk);
  assert.equal(h.jobs[2].leftovers, undefined, 'park: listeners only (its detached work may be the next turn\'s)');
});

test('reapReporter: leftovers get the runner.log line and one team-log metric per reaped tree', () => {
  const logged = [];
  const team = [];
  reapReporter((e) => team.push(e), (o) => logged.push(o))({ id: 'rn-1', why: 'exit', team: 'vibesquad', lane: 'bug-chaser', reaped: [], skipped: [], leftovers: { reaped: [{ agentId: 'rn-1', root: 300, pgid: 300, pids: [310, 300], cmd: 'chromium-browser --headless' }], skipped: [{ pid: 302, root: 300, reason: 'env-unreadable:open' }] } });
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].reap.leftovers.reaped, [{ root: 300, pgid: 300, pids: [310, 300], cmd: 'chromium-browser --headless' }]);
  assert.equal(logged[0].reap.leftovers.skipped[0].reason, 'env-unreadable:open');
  assert.equal(team.length, 1);
  assert.match(team[0].text, /rn-1 left processes running outside its CLI after it ended \(exit\): killed tree root 300 \(2 pids, group 300\): chromium-browser --headless/);
});

// ---- real processes (Linux) ----------------------------------------------------------------------------------------
// fixture.cjs roles (every process writes <dir>/<name>.pid):
//   cli <dir> <tag> <exitAfterMs>: the fake agent CLI; starts `shell`, then exits after exitAfterMs (0 = stays until killed).
//   shell <dir> <tag>: the tool shell: starts `lead` detached (setsid) and exits at once (the script ended).
//   lead <dir> <tag>: Chromium's shape: leads its group; a plain child (`helper`, same group), a child that leads its own
//     session (`crash`, crashpad), and `mid`, which starts `orphan` detached and exits (a double fork: orphan's parent is gone).
//   sleep <dir> <name>: writes its pid and sleeps.
const FIXTURE = String.raw`
const { spawn } = require('child_process'); const fs = require('fs'); const path = require('path');
const [role, dir, tag, extra] = process.argv.slice(2);
const me = (name) => fs.writeFileSync(path.join(dir, name + '.pid'), String(process.pid));
const run = (r, name, detached) => { const c = spawn(process.execPath, [__filename, r, dir, name, ''], { detached, stdio: 'ignore' }); if (detached) c.unref(); return c; };
const forever = () => setInterval(() => {}, 1 << 30);
if (role === 'cli') { me(tag + '.cli'); run('shell', tag, false); const ms = Number(extra) || 0; if (ms) setTimeout(() => process.exit(0), ms); forever(); }
else if (role === 'shell') { me(tag + '.shell'); run('lead', tag, true); setTimeout(() => process.exit(0), 50); }
else if (role === 'lead') { me(tag + '.lead'); run('sleep', tag + '.helper', false); run('sleep', tag + '.crash', true); run('mid', tag, false); forever(); }
else if (role === 'mid') { run('sleep', tag + '.orphan', true); setTimeout(() => process.exit(0), 50); }
else if (role === 'sleep') { me(tag); forever(); }
`;
const LINUX = process.platform === 'linux';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const fixtureEnv = (id, token) => { const e = { ...process.env }; for (const k of Object.keys(e)) if (/^(VS_|PASEO_)/.test(k)) delete e[k]; if (id) e.VS_AGENT_ID = id; if (token) e.VS_AGENT_TOKEN = token; return e; };
const pidsIn = (d, tag) => Object.fromEntries(readdirSync(d).filter((f) => f.startsWith(`${tag}.`) && f.endsWith('.pid')).map((f) => [f.slice(tag.length + 1, -4), Number(readFileSync(path.join(d, f), 'utf8'))]));
const FAMILY = ['lead', 'helper', 'crash', 'orphan'];
const waitFamily = (d, tag) => until(() => FAMILY.every((n) => existsSync(path.join(d, `${tag}.${n}.pid`))), 20_000);
// Cleanup: only pids our own fixtures wrote, each re-checked to still carry this run's fixture id before the signal.
const cleanup = (d, fixtureIds) => {
  for (const f of readdirSync(d).filter((x) => x.endsWith('.pid'))) {
    const pid = Number(readFileSync(path.join(d, f), 'utf8'));
    let env = '';
    try { env = readFileSync(`/proc/${pid}/environ`, 'utf8'); } catch { continue; }
    if (fixtureIds.some((id) => env.includes(`VS_FIXTURE_RUN=${id}`))) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
};

test('real (Linux): a detached tree (setsid group + own-session crashpad + double-forked orphan) of an ended agent is reaped; strangers survive', { skip: !LINUX && 'linux only', timeout: 120_000 }, async () => {
  const d = tmp();
  const fx = path.join(d, 'fixture.cjs');
  writeFileSync(fx, FIXTURE);
  const run = `run-${randomBytes(4).toString('hex')}`;
  const id = `rt-w1-${randomBytes(3).toString('hex')}`;
  const tok = randomBytes(16).toString('hex');
  const env = (i, t) => ({ ...fixtureEnv(i, t), VS_FIXTURE_RUN: run });
  try {
    const since = Date.now() - 1000;
    // The agent's CLI starts a script that leaves the Chromium-shaped family behind, then the CLI is killed (the end).
    const cli = spawn(process.execPath, [fx, 'cli', d, 'me', '0'], { env: env(id, tok), stdio: 'ignore' });
    // Strangers, each left by its own exiting shell: no marker, another agent's id + token, this agent's id + a wrong token.
    spawn(process.execPath, [fx, 'cli', d, 'none', '300'], { env: env(null, null), stdio: 'ignore' });
    spawn(process.execPath, [fx, 'cli', d, 'other', '300'], { env: env(`rt-w2-${randomBytes(3).toString('hex')}`, randomBytes(16).toString('hex')), stdio: 'ignore' });
    spawn(process.execPath, [fx, 'cli', d, 'forged', '300'], { env: env(id, randomBytes(16).toString('hex')), stdio: 'ignore' });
    for (const tag of ['me', 'none', 'other', 'forged']) await waitFamily(d, tag);
    const me = pidsIn(d, 'me');
    // ps dates rows to the second (createdMs is an upper bound): wait so the family reads as created before the end.
    await tick(1500);
    cli.kill('SIGKILL');
    await until(() => !alive(me.cli) || cli.exitCode !== null || cli.signalCode !== null, 5000);
    for (const n of FAMILY) assert.ok(alive(me[n]), `precondition: ${n} survived the CLI's end (the leak)`);
    const r = await createLeftoverReaper()({ agentId: id, token: tok, since, endedAt: Date.now(), protectedPids: [process.pid, process.ppid], liveCliPids: [], selfPid: process.pid });
    assert.equal(r.error, undefined, `reaper error: ${r.error}`);
    const killed = new Set(r.reaped.flatMap((x) => x.pids));
    for (const n of FAMILY) assert.ok(killed.has(me[n]), `${n} (${me[n]}) reaped: ${JSON.stringify(r)}`);
    assert.ok(r.reaped.some((x) => x.root === me.lead && x.pgid === me.lead), `lead's whole group is the agent's: group kill ${JSON.stringify(r.reaped)}`);
    await until(() => FAMILY.every((n) => !alive(me[n])), 10_000);
    for (const tag of ['none', 'other', 'forged']) {
      const s = pidsIn(d, tag);
      for (const n of FAMILY) assert.ok(alive(s[n]), `stranger ${tag}.${n} survives`);
    }
  } finally {
    cleanup(d, [run]);
  }
});

test('real (Linux): through the Runner: a worker\'s leftovers are reaped on exit and on archive; a pid-reuse dated plan is refused', { skip: !LINUX && 'linux only', timeout: 120_000 }, async (t) => {
  const d = tmp();
  const fx = path.join(d, 'fixture.cjs');
  writeFileSync(fx, FIXTURE);
  const run = `run-${randomBytes(4).toString('hex')}`;
  let n = 0;
  // A real adapter-shaped fake: the "CLI" is a real process with the runner's agentEnv (VS_AGENT_ID + this lifetime's token).
  const adapter = {
    canPark: true,
    start({ id, env, emit, onExit }) {
      const tag = `a${n++}`;
      const exitAfter = exitNext ? '3000' : '0'; // the exit case: the CLI ends by itself after its script leaked
      exitNext = false;
      const c = spawn(process.execPath, [fx, 'cli', d, tag, exitAfter], { env: { ...env, VS_FIXTURE_RUN: run }, stdio: 'ignore' });
      c.on('exit', (code) => onExit({ code }));
      setImmediate(() => { emit('session', { sessionId: `s-${tag}` }); emit('status', { status: 'idle' }); });
      tags.set(id, tag);
      return { pid: c.pid, send() { emit('status', { status: 'running' }); emit('status', { status: 'idle' }); }, cancel() {}, kill() { try { c.kill('SIGKILL'); } catch { /* gone */ } } };
    },
  };
  const tags = new Map();
  let exitNext = false;
  const reports = [];
  const runner = new Runner({ dir: tmp(), adapters: { fake: adapter }, parkGraceMs: 600_000, bgProbe: null, reapDelayMs: 50, reaper: createDevServerReaper({ leftovers: createLeftoverReaper() }), onReap: (r) => reports.push(r) });
  t.after(() => { runner.shutdown(); cleanup(d, [run]); });
  const report = (id) => reports.find((r) => r.id === id && r.leftovers);

  // exit: the CLI exits by itself 3 s after its script left the family behind.
  exitNext = true;
  const exitAgent = runner.create({ provider: 'fake', cwd: os.tmpdir(), meta: { role: 'worker' } });
  const exTag = tags.get(exitAgent);
  await waitFamily(d, exTag);
  const exFam = pidsIn(d, exTag);
  await until(() => !!report(exitAgent), 30_000);
  const er = report(exitAgent);
  assert.equal(er.why, 'exit');
  assert.equal(er.leftovers.error, undefined, JSON.stringify(er));
  await until(() => FAMILY.every((f) => !alive(exFam[f])), 10_000);

  // archive: an idle worker is archived (stop keeping its session); its CLI is killed and its leftovers reaped.
  const ar = runner.create({ provider: 'fake', cwd: os.tmpdir(), meta: { role: 'worker' } });
  const arTag = tags.get(ar);
  await waitFamily(d, arTag);
  const arFam = pidsIn(d, arTag);
  await until(() => runner.live.get(ar)?.status === 'idle' && !!runner.live.get(ar)?.sessionId, 5000);
  await tick(1500); // ps dates to the second: the family must read as created before the end
  runner.archive(ar);
  await until(() => !!report(ar), 30_000);
  const arr = report(ar);
  assert.equal(arr.why, 'stop');
  assert.equal(arr.leftovers.error, undefined, JSON.stringify(arr));
  await until(() => FAMILY.every((f) => !alive(arFam[f])), 10_000);

  // pid reuse: the same family planned, but every start read before the kill differs (the pids were reused): refused.
  const pr = runner.create({ provider: 'fake', cwd: os.tmpdir(), meta: { role: 'worker' } });
  const prTag = tags.get(pr);
  await waitFamily(d, prTag);
  const prFam = pidsIn(d, prTag);
  await tick(1500);
  let reads = 0;
  const refusing = createLeftoverReaper({ starts: async (pids) => { reads++; const { readStartIds } = await import('../runner/detached.mjs'); const m = await readStartIds(pids); return reads === 1 ? m : new Map([...m].map(([p, s]) => [p, `${s}-reused`])); } });
  const res = await refusing({ agentId: pr, token: runner.tokenFor(pr), since: 0, endedAt: Date.now(), protectedPids: [process.pid, process.ppid], liveCliPids: [], selfPid: process.pid });
  assert.deepEqual(res.reaped, [], JSON.stringify(res));
  assert.ok(res.skipped.some((s) => s.reason === 'pid-changed'), JSON.stringify(res.skipped));
  for (const f of FAMILY) assert.ok(alive(prFam[f]), `${f} survives a re-date mismatch`);
});
