// PLAN_PER_POST03 P1 (idea-223): the `wf` label stamped by before(agent.create) lands in the runner's run record (the
// agent's JSONL log `created` event, meta.labels.wf), so @usage can attribute units from it. Hermetic: own VIBESQUAD_HOME,
// a fake adapter, an in-process runner on an ephemeral port (same harness as runner-hooks.test.mjs).
import './helpers/clean-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-wfrr-')); tmpDirs.push(d); return d; };
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

function fakeAdapter() {
  return {
    start({ emit }) {
      return {
        send(text) {
          emit('status', { status: 'running' });
          emit('output', { text: `echo:${text}` });
          emit('turn_done', {});
          emit('status', { status: 'idle' });
        },
        cancel() {},
        kill() {},
      };
    },
  };
}

async function boot() {
  const runner = new Runner({ dir: tmp(), adapters: { claude: fakeAdapter() } });
  const server = createServer(runner, { token: 't' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = tmp();
  writeDiscovery(home, { port: server.address().port, token: 't' });
  const backend = new RunnerBackend({ client: new RunnerClient({ home }), rootDir: ROOT, lanes: () => new Set(['bug-chaser']) });
  await startRunnerLifecycle({ runner: backend, startWatcher: false });
  return {
    runner, backend,
    async close() {
      await stopRunnerLifecycle();
      runner.shutdown();
      server.close();
      server.closeAllConnections?.();
    },
  };
}

const createdEvent = (runner, id) =>
  readFileSync(runner.store.file(id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'created');

const req = (labels, over = {}) => ({
  config: { provider: 'claude', model: 'claude-sonnet-5-5', cwd: CWD, title: 'T', modeId: 'default' },
  initialPrompt: 'hi',
  labels,
  env: {},
  ...over,
});

test('run record: a spawn is stamped with its derived wf in the created event; the caller override wins', async () => {
  const b = await boot();
  try {
    const a = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'worker', job: 'j' }));
    assert.equal(createdEvent(b.runner, a.id)?.meta?.labels?.wf, 'sonnet');
    assert.equal(a.labels.wf, 'sonnet');

    const o = await b.backend.createAgent(req({ lane: 'bug-chaser', role: 'worker', job: 'j', wf: 'dsp+gemini-review' }));
    assert.equal(createdEvent(b.runner, o.id)?.meta?.labels?.wf, 'dsp+gemini-review');
  } finally {
    await b.close();
  }
});
