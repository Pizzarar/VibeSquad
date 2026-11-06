// B11 unit-run-hook-parity: the Paseo plugin hooks run for runner (rn-*) agents through the lifecycle bus.
// Hermetic: own VIBESQUAD_HOME / VIBESQUAD_ROOT, a fake adapter, an in-process runner on an ephemeral port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'vs-rh-'));
const VS_HOME = tmp();
const ROOT = tmp();
process.env.VIBESQUAD_HOME = VS_HOME;
process.env.VIBESQUAD_ROOT = ROOT;
const CWD = path.join(tmp(), 'VibeSquad');
mkdirSync(CWD, { recursive: true });
writeFileSync(
  path.join(VS_HOME, 'teams.json'),
  JSON.stringify({ teams: [{ id: 'vibesquad', name: 'VibeSquad', lanes: [{ id: 'bug-chaser', paths: ['VibeSquad'] }], paths: ['VibeSquad'] }] }),
);

const { Runner } = await import('../runner/runner.mjs');
const { createServer, writeDiscovery } = await import('../runner/server.mjs');
const { RunnerClient } = await import('../server/backend/runner-client.mjs');
const { RunnerBackend } = await import('../server/backend/runner-backend.mjs');
const { startRunnerLifecycle, stopRunnerLifecycle } = await import('../server/backend/runner-lifecycle.mjs');
const { createPlugin } = await import('../plugin/index.server.ts');

const until = async (fn, ms = 6000, what = 'condition') => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

// Fake provider. A prompt starting "USAGE:<n>" reports <n> context tokens; "FAIL:" ends the turn with an error.
function fakeAdapter(starts) {
  return {
    start({ emit, systemPrompt, model, meta }) {
      starts.push({ systemPrompt, model, meta });
      return {
        send(text) {
          emit('status', { status: 'running' });
          const u = /^USAGE:(\d+)/.exec(text);
          if (u) emit('usage', { contextTokens: Number(u[1]) });
          emit('output', { text: `echo:${text}` });
          if (text.startsWith('FAIL:')) emit('error', { message: 'stream idle timeout' });
          emit('turn_done', {});
          emit('status', { status: 'idle' });
        },
        cancel() {},
        kill() {},
      };
    },
  };
}

async function boot({ agy = false } = {}) {
  const starts = [];
  const adapters = { claude: fakeAdapter(starts) };
  if (agy) adapters['antigravity-cli'] = fakeAdapter(starts);
  const runner = new Runner({ dir: tmp(), adapters });
  const server = createServer(runner, { token: 't' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = tmp();
  writeDiscovery(home, { port: server.address().port, token: 't' });
  const backend = new RunnerBackend({ client: new RunnerClient({ home }), rootDir: ROOT, lanes: () => new Set(['bug-chaser']) });
  const lifecycle = await startRunnerLifecycle({ runner: backend, startWatcher: false });
  return {
    runner, backend, starts, lifecycle,
    async close() {
      await stopRunnerLifecycle();
      server.close();
      server.closeAllConnections?.();
    },
  };
}

const req = (labels = {}, over = {}) => ({
  config: { provider: 'claude', model: 'claude-haiku-5-5', cwd: CWD, title: 'T', modeId: 'default' },
  initialPrompt: 'hi',
  labels,
  env: {},
  ...over,
});
const teamLog = () => {
  const f = path.join(VS_HOME, 'teams', 'vibesquad', 'log.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const inputs = async (b, id) => (await b.backend.fetchAgentTimeline(id)).entries.filter((e) => e.item.type === 'user_message').map((e) => e.item.text);

test('created: layered prompt applies before start; team/ord labels and parent are filled by the bus', async () => {
  const b = await boot();
  try {
    const lead = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'lead' }));
    // before("agent.create"): fixed-order layers reached the adapter via the system prompt
    const sys = b.starts.at(-1).systemPrompt;
    assert.match(sys, /^Team rules \(VibeSquad\):/);
    assert.ok(sys.includes('Role: lead.') || sys.includes('lead'), 'lead role pack layered');
    assert.equal(b.starts.at(-1).meta.team, 'vibesquad', 'team resolved before the agent starts (env/labels)');
    // agent.created: ord assigned by the plugin through RunnerBackend.updateAgent
    const labels = await until(async () => {
      const a = await b.backend.getAgent(lead.id);
      return a.labels.ord ? a.labels : null;
    }, 6000, 'lead ord label');
    assert.equal(labels.ord, '1');
    assert.equal(labels.team, 'vibesquad');

    const child = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'worker', job: 'j', 'vs.parent': lead.id }));
    assert.equal(child.parentAgentId, lead.id);
    const metric = await until(() => teamLog().find((e) => /^first-dispatch context:/.test(e.text) && e.text.includes(`lead=${lead.id}`)), 6000, 'first-dispatch metric');
    assert.match(metric.text, /ord=1/);
    // no double fire: one agent.created timing line per agent
    await settle();
    const created = teamLog().filter((e) => e.text.startsWith('hook-timing hook=agent.created') && (e.refs ?? []).includes(lead.id));
    assert.equal(created.length, 1);
  } finally {
    await b.close();
  }
});

test('turn_ended: a worker with a job gets a digest agent (autoArchive), never digested itself', async () => {
  const b = await boot({ agy: true });
  try {
    const w = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'worker', job: 'build thing' }, { initialPrompt: 'PASS: built' }));
    const digest = await until(async () => (await b.backend.listAgents({ filter: { includeArchived: true } })).find((a) => a.labels.digestFor === w.id), 8000, 'digest agent');
    assert.equal(digest.labels.role, 'worker');
    assert.equal(digest.labels.profile, 'Pre-check - Flash');
    assert.equal(digest.provider, 'antigravity-cli');
    assert.ok((await inputs(b, digest.id)).some((t) => t.includes(`--ref ${w.id}`)), 'digest prompt names the worker');
    // the digest's own turn end must not spawn another digest
    await settle(500);
    const all = (await b.backend.listAgents({ filter: { includeArchived: true } })).filter((a) => a.labels.digestFor);
    assert.equal(all.length, 1);
    // autoArchive after the backstop wait finishes
    await until(async () => (await b.backend.getAgent(digest.id)).archivedAt, 8000, 'digest archived');
  } finally {
    await b.close();
  }
});

test('turn_ended: when the digest agent cannot start, the verdict is written directly (UNVERIFIED fallback)', async () => {
  const b = await boot(); // no antigravity adapter: the digest create throws
  try {
    const w = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'worker', job: 'build thing' }, { initialPrompt: 'PASS: built' }));
    const done = await until(() => teamLog().find((e) => e.type === 'done' && e.agent === w.id), 8000, 'fallback done entry');
    assert.match(done.text, /^UNVERIFIED \(digest spawn failed\): echo:PASS: built/);
  } finally {
    await b.close();
  }
});

test('turn_ended: lead usage over 150k flags once; over 250k sends the handoff prompt exactly once', async () => {
  const b = await boot();
  try {
    const lead = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'lead' }, { initialPrompt: 'USAGE:160000' }));
    await until(async () => (await b.backend.getAgent(lead.id)).labels['handoff-flagged'] === '1', 8000, '150k handoff-flagged label');
    const nudges = async () => (await inputs(b, lead.id)).filter((t) => /handoff/i.test(t) && !t.startsWith('USAGE:'));
    await until(async () => (await nudges()).length >= 1, 8000, '150k nudge');
    // another turn at the same level: no second nudge
    await b.backend.sendAgentPrompt(lead.id, 'USAGE:161000');
    await settle(600);
    assert.equal((await nudges()).length, 1);

    await b.backend.sendAgentPrompt(lead.id, 'USAGE:260000');
    await until(async () => (await b.backend.getAgent(lead.id)).labels['handoff-write-prompted'] === '1', 8000, '250k prompt label');
    await b.backend.sendAgentPrompt(lead.id, 'USAGE:262000');
    await settle(600);
    const after = await nudges();
    assert.equal(after.length, 2, 'one 150k nudge + one 250k write-handoff prompt, never repeated');
  } finally {
    await b.close();
  }
});

test('turn_ended failed with a transient error: A4 retry nudges the agent to continue', async () => {
  const b = await boot();
  try {
    const w = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'worker', job: 'j' }, { initialPrompt: 'FAIL: x' }));
    // retryBaseMs is 5000 in the default deps: drive the same handler with a short one
    await b.lifecycle.stop?.();
    const host = await b.backend.attachHooks({ startWatcher: false, deps: { retryBaseMs: 20 } });
    const agent = await b.backend.getAgent(w.id);
    await host.emit('agent.turn_ended', { agent, turnId: '9', outcome: { kind: 'failed', error: { message: 'stream idle timeout' } } });
    await until(async () => (await inputs(b, w.id)).some((t) => /transient network error/.test(t)), 6000, 'retry prompt');
  } finally {
    await b.close();
  }
});

test('log.jsonl watcher: a team-log [done] entry wakes the rn- lead through the runner', async () => {
  const b = await boot();
  try {
    const lead = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'lead' }));
    await until(async () => (await b.backend.getAgent(lead.id)).labels.ord, 6000, 'lead labelled');
    await until(async () => (await b.backend.getAgent(lead.id)).status === 'idle', 6000, 'lead idle');
    await b.lifecycle.stop?.();
    await stopRunnerLifecycle();
    const host = await b.backend.attachHooks({ startWatcher: false, deps: { debounceMs: 20, leadWakeCooldownMs: 0 } });
    host.scanLogs(true); // baseline: skip history
    mkdirSync(path.join(VS_HOME, 'teams', 'vibesquad'), { recursive: true });
    appendFileSync(
      path.join(VS_HOME, 'teams', 'vibesquad', 'log.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), agent: 'rn-someworker', lane: 'bug-chaser', type: 'done', text: 'PASS: shipped it', refs: [] }) + '\n',
    );
    host.scanLogs(false);
    await until(async () => (await inputs(b, lead.id)).some((t) => /^New team log event in lane bug-chaser: \[done\] PASS: shipped it/.test(t)), 6000, 'wakeup input');
  } finally {
    await b.close();
  }
});

test('send with a senderId to a retired lead is redirected to the live lead (turn_started handling for runner agents)', async () => {
  const b = await boot();
  try {
    const oldLead = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'lead' }));
    await until(async () => (await b.backend.getAgent(oldLead.id)).labels.ord, 6000, 'old lead labelled');
    const newLead = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'lead' }));
    // the new lead's agent.created retires the old one
    await until(async () => /^former/.test((await b.backend.getAgent(oldLead.id)).labels.role ?? ''), 8000, 'old lead retired');
    const before = (await inputs(b, newLead.id)).length;
    await b.backend.sendAgentPrompt(oldLead.id, 'hello old', { senderId: 'rn-sender' });
    await until(async () => (await inputs(b, newLead.id)).length > before, 6000, 'redirect to new lead');
    assert.ok((await inputs(b, newLead.id)).includes('hello old'));
    assert.ok(!(await inputs(b, oldLead.id)).includes('hello old'), 'not delivered to the retired lead');
    // a user (no senderId) typing to the retired lead stays with it
    await b.backend.sendAgentPrompt(oldLead.id, 'user says hi');
    assert.ok((await inputs(b, oldLead.id)).includes('user says hi'));
  } finally {
    await b.close();
  }
});

test('no double fire: the bus ignores non-rn ids, and the plugin run for Paseo is untouched', async () => {
  const b = await boot();
  try {
    const seen = [];
    b.lifecycle.host.emit = async (hook, payload) => { seen.push([hook, payload.agent?.id]); };
    b.backend.emitEvent({ kind: 'created', agentId: '0b6f3e7a-uuid', agent: { id: '0b6f3e7a-uuid' } });
    b.backend.emitEvent({ kind: 'turn_ended', agentId: '0b6f3e7a-uuid', agent: { id: '0b6f3e7a-uuid' }, turnId: '1', outcome: { kind: 'completed' } });
    assert.deepEqual(seen, []);
    b.backend.emitEvent({ kind: 'turn_started', agentId: 'rn-abc', agent: { id: 'rn-abc' } });
    await settle(50); // emits are serialized through the bus queue
    assert.deepEqual(seen, [['agent.turn_started', 'rn-abc']]);
    // the plugin itself still builds for a Paseo-style server with the original signature
    const handlers = [];
    const dispose = createPlugin({ startWatcher: false })({ before: () => () => {}, on: (n) => (handlers.push(n), () => {}), handle: () => {} });
    assert.ok(handlers.includes('agent.created') && handlers.includes('agent.turn_ended') && handlers.includes('agent.turn_started'));
    dispose();
  } finally {
    await b.close();
  }
});

test('runner events: turn_started / turn_ended (completed, failed) are derived from the log', async () => {
  const b = await boot();
  try {
    await stopRunnerLifecycle();
    const evs = [];
    const off = b.backend.subscribeEvents((e) => { if (['created', 'turn_started', 'turn_ended'].includes(e.kind)) evs.push(e); });
    const a = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'worker', job: 'j' }, { initialPrompt: 'ok' }));
    await until(() => evs.some((e) => e.kind === 'turn_ended'), 6000, 'turn_ended');
    await b.backend.sendAgentPrompt(a.id, 'FAIL: nope');
    await until(() => evs.filter((e) => e.kind === 'turn_ended').length === 2, 6000, 'second turn_ended');
    const ended = evs.filter((e) => e.kind === 'turn_ended');
    assert.equal(ended[0].outcome.kind, 'completed');
    assert.equal(ended[1].outcome.kind, 'failed');
    assert.match(ended[1].outcome.error.message, /stream idle timeout/);
    assert.ok(evs.some((e) => e.kind === 'created' && e.agentId === a.id));
    assert.equal(evs.filter((e) => e.kind === 'turn_started').length, 2, 'exactly one turn_started per turn, including the first');
    off();
  } finally {
    await b.close();
  }
});

test('ACP-style failure before the first "running" still ends the turn as failed (status error, not closed)', async () => {
  const starts = [];
  const bad = { start({ emit }) { starts.push(1); return { send() { emit('error', { message: 'init failed' }); }, cancel() {}, kill() {} }; } };
  const runner = new Runner({ dir: tmp(), adapters: { claude: bad } });
  const server = createServer(runner, { token: 't' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = tmp();
  writeDiscovery(home, { port: server.address().port, token: 't' });
  const backend = new RunnerBackend({ client: new RunnerClient({ home }), rootDir: ROOT, hooks: false });
  const evs = [];
  const off = backend.subscribeEvents((e) => { if (e.kind === 'turn_ended') evs.push(e); });
  try {
    const a = await backend.createAgent(req({ lane: 'bug-chaser', role: 'worker' }));
    runner.store.append(a.id, 'exit', { code: 1, error: 'init failed' });
    await until(() => evs.length === 1, 6000, 'turn_ended on exit');
    assert.equal(evs[0].outcome.kind, 'failed');
    assert.equal(evs[0].agent.status, 'error');
  } finally {
    off();
    server.close();
    server.closeAllConnections?.();
  }
});

test('profile ids and names both resolve explicitly; spawn_worker labels carry the name', async () => {
  const { matchStoredProfile, loadStoredProfiles } = await import('../plugin/index.server.ts');
  const p = loadStoredProfiles().find((x) => x.id);
  assert.ok(p, 'a stored/default profile with an id exists');
  assert.equal(matchStoredProfile(p.name)?.explicit, true);
  assert.equal(matchStoredProfile(p.id)?.explicit, true);
  assert.equal(matchStoredProfile(p.id)?.profile.name, p.name);
});

test('digest: an idle digest that logged nothing triggers the direct-write fallback; rn- prompt uses vs status', async () => {
  const b = await boot({ agy: true });
  try {
    const w = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'worker', job: 'build thing' }, { initialPrompt: 'PASS: built' }));
    const digest = await until(async () => (await b.backend.listAgents({ filter: { includeArchived: true } })).find((a) => a.labels.digestFor === w.id), 8000, 'digest agent');
    const prompt = (await inputs(b, digest.id)).find((t) => t.includes('digest agent'));
    assert.match(prompt, new RegExp('vs status ' + w.id));
    assert.doesNotMatch(prompt, /paseo inspect/);
    // the fake digest never runs `vs log done`; once it is idle the plugin writes the verdict itself
    const done = await until(() => teamLog().find((e) => e.type === 'done' && e.agent === w.id), 15000, 'fallback after idle');
    assert.match(done.text, /^UNVERIFIED \(digest logged nothing\)/);
  } finally {
    await b.close();
  }
});

test('created agents carry thinkingOptionId/featureValues and a spawn-configured marker; agy alias is canonicalised', async () => {
  const b = await boot({ agy: true });
  try {
    const a = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'worker' }, { config: { provider: 'agy', cwd: CWD, title: 'T', thinkingOptionId: 'low', featureValues: { approvalPolicy: 'skip' } } }));
    assert.equal(a.provider, 'antigravity-cli');
    assert.equal(a.thinkingOptionId, 'low');
    assert.deepEqual(a.featureValues, { approvalPolicy: 'skip' });
    assert.equal(a.labels['vs.spawn-configured'], '1');
  } finally {
    await b.close();
  }
});

test('vs shim runtime closure carries the plugin (.ts), its package.json and the runner alias table', async () => {
  const { installVsShim } = await import('../cli/vs.mjs');
  const base = tmp();
  installVsShim({ binDirs: [path.join(base, 'bin')], baseHome: base });
  for (const rel of ['plugin/index.server.ts', 'plugin/package.json', 'plugin/server/remote-proxy.ts', 'runner/adapters/acp.mjs', 'server/backend/runner-hooks.mjs', 'server/lead-handoff.mjs', 'server/lean-tools.mjs']) {
    assert.ok(existsSync(path.join(base, 'runtime', rel)), `${rel} copied into the runtime`);
  }
});

test('cold start: agent spawned before the event stream connects still gets exactly one created and one turn_started; a restart replays nothing', async () => {
  const starts = [];
  const home = tmp();
  const runner = new Runner({ dir: path.join(home, 'agents'), adapters: { claude: fakeAdapter(starts) } }); // the layout the real runner uses
  const server = createServer(runner, { token: 't' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeDiscovery(home, { port: server.address().port, token: 't' });
  const rc = new RunnerClient({ home });
  const realStream = rc.stream.bind(rc);
  rc.stream = (opts) => { // the stream connects only after the agent's first events are already in the log
    let h;
    const t = setTimeout(() => { h = realStream(opts); }, 700);
    return { close() { clearTimeout(t); h?.close(); } };
  };
  const backend = new RunnerBackend({ client: rc, rootDir: ROOT, lanes: () => new Set(['bug-chaser']) });
  try {
    const lc = await startRunnerLifecycle({ runner: backend, startWatcher: false });
    const seen = [];
    const realEmit = lc.host.emit.bind(lc.host);
    lc.host.emit = async (hook, payload) => { seen.push([hook, payload.agent?.id]); return realEmit(hook, payload); };
    const a = await backend.createAgent(req({ lane: 'bug-chaser', role: 'lead' }));
    await until(() => seen.some(([h]) => h === 'agent.turn_ended'), 8000, 'replayed turn_ended');
    await settle(400);
    const mine = seen.filter(([, id]) => id === a.id).map(([h]) => h);
    assert.equal(mine.filter((h) => h === 'agent.created').length, 1);
    assert.equal(mine.filter((h) => h === 'agent.turn_started').length, 1);
    assert.equal(mine.filter((h) => h === 'agent.turn_ended').length, 1);
    await until(async () => (await backend.getAgent(a.id)).labels.ord, 6000, 'lead ord from the replayed created');

    // restart the lifecycle (serve.mjs restart): history is not replayed
    await stopRunnerLifecycle();
    const lc2 = await startRunnerLifecycle({ runner: backend, startWatcher: false });
    const seen2 = [];
    lc2.host.emit = async (hook, payload) => { seen2.push([hook, payload.agent?.id]); };
    await settle(3500); // stream reconnect + catch-up
    assert.deepEqual(seen2, []);
  } finally {
    await stopRunnerLifecycle();
    server.close();
    server.closeAllConnections?.();
  }
});

test('MCP/CLI spawns do not log orphan / fallback metrics twice (before and created)', async () => {
  const b = await boot();
  try {
    const a = await b.backend.createAgent(req({ role: 'worker', job: 'j' }, { config: { provider: 'claude', cwd: os.tmpdir(), title: 'O', modeId: 'default' } }));
    await until(() => teamLogAll().some((e) => e.text.startsWith('hook-timing hook=agent.created') && (e.refs ?? []).includes(a.id)), 6000, 'created hook ran');
    await settle(300);
    const orphans = teamLogAll().filter((e) => e.text.startsWith('orphan:'));
    assert.equal(orphans.length, 1, 'one orphan metric for the spawn, not two');
  } finally {
    await b.close();
  }
});
function teamLogAll() {
  const out = [];
  for (const t of ['vibesquad', '_unassigned']) {
    const f = path.join(VS_HOME, 'teams', t, 'log.jsonl');
    if (existsSync(f)) out.push(...readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  }
  return out;
}

// ── catch-up state (review r3) ───────────────────────────────────────────────────────────────────────────
// A controllable runner: the event stream is connected / dropped by the test, and one prompt can be held mid-turn.
async function bootCtl({ delayStream = 0 } = {}) {
  const ctl = { held: null, runner: null };
  const adapter = {
    start({ emit, id }) {
      return {
        send(text) {
          if (text.startsWith('ERR:')) { emit('error', { message: 'init failed' }); return; } // fails before any "running"
          if (text.startsWith('META:')) ctl.runner.updateMeta(id, { title: 'renamed' }); // a meta event lands between input and running
          emit('status', { status: 'running' });
          if (text.startsWith('HOLD:')) { ctl.held = () => { emit('output', { text: 'done' }); emit('turn_done', {}); emit('status', { status: 'idle' }); }; return; }
          emit('output', { text: `echo:${text}` });
          emit('turn_done', {});
          emit('status', { status: 'idle' });
        },
        cancel() {},
        kill() {},
      };
    },
  };
  const home = tmp();
  const runner = new Runner({ dir: path.join(home, 'agents'), adapters: { claude: adapter } });
  ctl.runner = runner;
  const server = createServer(runner, { token: 't' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeDiscovery(home, { port: server.address().port, token: 't' });
  const rc = new RunnerClient({ home });
  const realStream = rc.stream.bind(rc);
  rc.stream = (opts) => {
    ctl.opts = opts;
    ctl.connect = () => { ctl.h?.close(); ctl.h = realStream(opts); };
    ctl.drop = () => { ctl.h?.close(); ctl.h = null; opts.onClose?.(); };
    const t = setTimeout(ctl.connect, delayStream || 1);
    return { close() { clearTimeout(t); ctl.h?.close(); } };
  };
  const backend = new RunnerBackend({ client: rc, rootDir: ROOT, lanes: () => new Set(['bug-chaser']) });
  const seen = [];
  const tap = (lc) => { const real = lc.host.emit.bind(lc.host); lc.host.emit = async (hook, payload) => { seen.push([hook, payload.agent?.id, payload.outcome?.kind]); return real(hook, payload); }; };
  return {
    ctl, backend, seen, tap, runner, home,
    count: (hook, id) => seen.filter(([h, i]) => h === hook && i === id).length,
    async close() { await stopRunnerLifecycle(); server.close(); server.closeAllConnections?.(); },
  };
}

test('catch-up: a turn that started before a disconnect and ended during it yields one turn_ended', async () => {
  const b = await bootCtl();
  try {
    const lc = await startRunnerLifecycle({ runner: b.backend, startWatcher: false });
    b.tap(lc);
    const a = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'worker' }, { initialPrompt: 'HOLD: go' }));
    await until(() => b.count('agent.turn_started', a.id) === 1, 6000, 'turn_started');
    b.ctl.drop();
    b.ctl.held(); // the turn ends while the stream is down
    await settle(200);
    b.ctl.connect();
    await until(() => b.count('agent.turn_ended', a.id) === 1, 6000, 'turn_ended after reconnect');
    await settle(400);
    assert.equal(b.count('agent.turn_ended', a.id), 1);
    assert.equal(b.count('agent.turn_started', a.id), 1);
  } finally { await b.close(); }
});

test('catch-up: a failure before the first "running" while disconnected yields one failed turn_ended', async () => {
  const b = await bootCtl();
  try {
    const lc = await startRunnerLifecycle({ runner: b.backend, startWatcher: false });
    b.tap(lc);
    const a = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'worker' }));
    await until(() => b.count('agent.turn_ended', a.id) === 1, 6000, 'first turn_ended');
    b.ctl.drop();
    await b.backend.sendAgentPrompt(a.id, 'ERR: boom');
    b.runner.store.append(a.id, 'exit', { code: 1, error: 'init failed' });
    b.ctl.connect();
    await until(() => b.count('agent.turn_ended', a.id) === 2, 6000, 'failed turn_ended');
    assert.equal(b.seen.filter(([h, i, o]) => h === 'agent.turn_ended' && i === a.id && o === 'failed').length, 1);
  } finally { await b.close(); }
});

test('catch-up: meta between input and status:running still yields exactly one turn_started', async () => {
  const b = await bootCtl();
  try {
    const lc = await startRunnerLifecycle({ runner: b.backend, startWatcher: false });
    b.tap(lc);
    const a = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'worker' }));
    await until(() => b.count('agent.turn_ended', a.id) === 1, 6000, 'first turn');
    b.ctl.drop();
    await b.backend.sendAgentPrompt(a.id, 'META: go');
    b.ctl.connect();
    await until(() => b.count('agent.turn_ended', a.id) === 2, 6000, 'second turn_ended');
    await settle(300);
    assert.equal(b.count('agent.turn_started', a.id), 2, 'one per turn');
  } finally { await b.close(); }
});

test('ordering: lifecycle subscribes before another listener opens the stream; slow hook attach loses nothing', async () => {
  const b = await bootCtl();
  try {
    const realAttach = b.backend.attachHooks.bind(b.backend);
    b.backend.attachHooks = async (o) => { await settle(700); return realAttach(o); }; // cold plugin import
    const ready = startRunnerLifecycle({ runner: b.backend, startWatcher: false }); // not awaited, like serve.mjs
    b.backend.subscribeEvents(() => {}); // the push watcher opens the shared stream right after
    const a = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'lead' }));
    const lc = await ready;
    b.tap(lc);
    await until(async () => (await b.backend.getAgent(a.id)).labels.ord === '1', 8000, 'created hook ran after the slow attach');
    await until(() => teamLogAll().some((e) => e.text.startsWith('hook-timing hook=agent.created') && (e.refs ?? []).includes(a.id)), 6000, 'created timing');
    assert.equal(teamLogAll().filter((e) => e.text.startsWith('hook-timing hook=agent.created') && (e.refs ?? []).includes(a.id)).length, 1);
  } finally { await b.close(); }
});

test('catch-up: leads created before the stream connects are processed in createdAt order, not id order', async () => {
  const b = await bootCtl({ delayStream: 900 });
  try {
    await startRunnerLifecycle({ runner: b.backend, startWatcher: false });
    // Fixed ids whose alphabetical order is the reverse of their creation order.
    const mk = (id, ts) => {
      const dir = path.join(b.home, 'agents');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, id + '.jsonl'), JSON.stringify({ seq: 0, ts, type: 'created', provider: 'claude', model: null, cwd: CWD, meta: { title: id, role: 'lead', lane: 'bug-chaser', team: 'vibesquad' } }) + '\n');
    };
    mk('rn-ccc000000001', Date.now() - 3000);
    mk('rn-bbb000000001', Date.now() - 2000);
    mk('rn-aaa000000001', Date.now() - 1000);
    await until(async () => (await b.backend.getAgent('rn-aaa000000001')).labels.ord, 10000, 'last lead labelled');
    const ords = [];
    for (const id of ['rn-ccc000000001', 'rn-bbb000000001', 'rn-aaa000000001']) ords.push((await b.backend.getAgent(id)).labels.ord);
    assert.deepEqual(ords, ['1', '2', '3'], 'oldest created gets ord 1 even though its id sorts last');
  } finally { await b.close(); }
});

test('a roster fetch failure on created and on idle still emits exactly one created and one turn_ended', async () => {
  const rec = { id: 'rn-fail00000001', provider: 'claude', model: null, cwd: CWD, meta: { title: 'F', role: 'worker', lane: 'bug-chaser' }, status: 'idle', pendingPermissions: [], createdAt: 1, updatedAt: 1, lastSeq: 9 };
  let failures = 2;
  const client = { request: async () => { if (failures-- > 0) throw new Error('runner restarting'); return rec; } };
  const backend = new RunnerBackend({ client, rootDir: ROOT, hooks: false });
  backend.live.hwm = new Map();
  const got = [];
  backend.listeners.add((e) => { if (['created', 'turn_started', 'turn_ended'].includes(e.kind)) got.push(e.kind); });
  const ev = (seq, type, o) => ({ id: rec.id, event: { seq, ts: 1000 + seq, type, ...o } });
  await backend.handleLogEvent(ev(0, 'created', { provider: 'claude', model: null, cwd: CWD, meta: rec.meta })); // fetch #1 throws
  await backend.handleLogEvent(ev(1, 'input', { text: 'hi' }));
  await backend.handleLogEvent(ev(2, 'status', { status: 'running' })); // fetch #2 throws
  await backend.handleLogEvent(ev(3, 'status', { status: 'idle' }));
  assert.deepEqual(got, ['created', 'turn_started', 'turn_ended']);
});

test('lifecycle: a failing attachHooks is loud, stops buffering and lets a later start retry', async () => {
  const b = await bootCtl();
  try {
    const real = b.backend.attachHooks.bind(b.backend);
    let calls = 0;
    b.backend.attachHooks = async (o) => { if (++calls === 1) throw new Error('plugin import failed'); return real(o); };
    await assert.rejects(startRunnerLifecycle({ runner: b.backend, startWatcher: false }), /plugin import failed/);
    assert.ok(teamLogAll().some((e) => /runner hooks unavailable.*plugin import failed/.test(e.text)), 'metric written');
    const lc = await startRunnerLifecycle({ runner: b.backend, startWatcher: false });
    assert.ok(lc.host, 'second start succeeds');
  } finally { await b.close(); }
});

test('fetch failures during created / turn_ended keep a lead a lead and still digest a worker (no label downgrade)', async () => {
  const b = await bootCtl();
  try {
    const lc = await startRunnerLifecycle({ runner: b.backend, startWatcher: false });
    b.tap(lc);
    b.ctl.connect();
    await until(() => b.backend.live.stream, 3000, 'stream');
    await settle(300);
    // The runner is reachable for writes but every roster read fails (getAgent / fetchAgent / list), as in a restart hiccup.
    const realFetch = b.backend.fetchAgent.bind(b.backend);
    const realList = b.backend.listAgents.bind(b.backend);
    b.backend.fetchAgent = async () => { throw new Error('runner restarting'); };
    b.backend.listAgents = async () => { throw new Error('runner restarting'); };
    const base = { provider: 'claude', model: null, cwd: CWD, prompt: 'go' };
    const leadId = b.ctl.runner.create({ ...base, meta: { title: 'L', role: 'lead', lane: 'bug-chaser', team: 'vibesquad' } });
    const workerId = b.ctl.runner.create({ ...base, prompt: 'PASS: built', meta: { title: 'W', role: 'worker', lane: 'bug-chaser', team: 'vibesquad', labels: { job: 'build thing' } } });
    await until(() => b.count('agent.turn_ended', leadId) === 1 && b.count('agent.turn_ended', workerId) === 1, 8000, 'both turns ended');
    await settle(1500); // hooks finish while reads still fail
    b.backend.fetchAgent = realFetch;
    b.backend.listAgents = realList;
    const lead = await b.backend.getAgent(leadId);
    assert.equal(lead.labels.role, 'lead', 'role not downgraded to worker');
    assert.ok(lead.labels.ord, 'ord assigned from the payload labels');
    const worker = await b.backend.getAgent(workerId);
    assert.equal(worker.labels.role, 'worker');
    const all = await b.backend.listAgents({ filter: { includeArchived: true } });
    assert.ok(all.some((a) => a.labels.digestFor === workerId) || teamLogAll().some((e) => e.type === 'done' && e.agent === workerId), 'digest agent spawned (or direct-write fallback)');
  } finally { await b.close(); }
});

test('archive is terminal: trailing exit never resurrects the row, and an open turn closes once', async () => {
  const rec = { id: 'rn-arch00000001', provider: 'claude', cwd: CWD, meta: { role: 'worker' }, status: 'exited', pendingPermissions: [], createdAt: 1, updatedAt: 1, lastSeq: 9 };
  const backend = new RunnerBackend({ client: { request: async () => rec }, rootDir: ROOT, hooks: false });
  backend.live.hwm = new Map();
  const got = [];
  backend.listeners.add((e) => { if (['agent', 'remove', 'turn_ended', 'status'].includes(e.kind)) got.push(e.kind + (e.outcome ? ':' + e.outcome.kind : '')); });
  const ev = (seq, type, o) => ({ id: rec.id, event: { seq, ts: 1000 + seq, type, ...o } });
  await backend.handleLogEvent(ev(0, 'created', { provider: 'claude', cwd: CWD, meta: rec.meta }));
  await backend.handleLogEvent(ev(1, 'input', { text: 'x' }));
  await backend.handleLogEvent(ev(2, 'status', { status: 'running' }));
  got.length = 0;
  await backend.handleLogEvent(ev(3, 'archive', {}));
  await backend.handleLogEvent(ev(4, 'exit', { code: 1 }));
  await backend.handleLogEvent(ev(5, 'status', { status: 'idle' }));
  assert.deepEqual(got, ['remove', 'turn_ended:failed'], 'one remove, one closing turn_ended, no agent_update after remove');
});

test('baseline sees an archive that is followed by exit / error / idle', async () => {
  const home = tmp();
  const dir = path.join(home, 'agents');
  mkdirSync(dir, { recursive: true });
  const line = (seq, type, o) => JSON.stringify({ seq, ts: seq, type, ...o }) + '\n';
  writeFileSync(path.join(dir, 'rn-a1.jsonl'), line(0, 'created', { provider: 'claude', meta: {} }) + line(1, 'archive', {}) + line(2, 'exit', { code: 0 }));
  writeFileSync(path.join(dir, 'rn-a2.jsonl'), line(0, 'created', { provider: 'claude', meta: {} }) + line(1, 'status', { status: 'running' }) + line(2, 'archive', {}) + line(3, 'error', { message: 'x' }) + line(4, 'status', { status: 'idle' }));
  writeFileSync(path.join(dir, 'rn-live.jsonl'), line(0, 'created', { provider: 'claude', meta: {} }) + line(1, 'status', { status: 'idle' }));
  const backend = new RunnerBackend({ client: new RunnerClient({ home }), rootDir: ROOT, hooks: false });
  backend.enableCatchUp();
  assert.ok(backend.live.archived.has('rn-a1') && backend.live.archived.has('rn-a2'));
  assert.ok(!backend.live.archived.has('rn-live'));
  assert.equal(backend.live.hwm.get('rn-a2'), 4);
});

test('catch-up: a worker that finished and was archived while the stream was down still gets turn_ended and remove', async () => {
  const b = await bootCtl();
  try {
    const lc = await startRunnerLifecycle({ runner: b.backend, startWatcher: false });
    b.tap(lc);
    const removed = [];
    b.backend.listeners.add((e) => { if (e.kind === 'remove') removed.push(e.agentId); });
    const a = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'worker', job: 'j' }, { initialPrompt: 'HOLD: go' }));
    await until(() => b.count('agent.turn_started', a.id) === 1, 6000, 'turn_started');
    b.ctl.drop();
    b.ctl.held(); // turn ends...
    b.runner.archive(a.id); // ...and the worker is auto-archived, all while the stream is down
    await settle(200);
    b.ctl.connect();
    await until(() => b.count('agent.turn_ended', a.id) === 1, 6000, 'turn_ended replayed for the archived agent');
    await until(() => removed.includes(a.id), 6000, 'remove replayed');
    await settle(300);
    assert.equal(b.count('agent.turn_ended', a.id), 1);
  } finally { await b.close(); }
});
