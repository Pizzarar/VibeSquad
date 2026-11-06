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
