import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createServer, writeDiscovery } from '../runner/server.mjs';
import { RunnerClient } from '../server/backend/runner-client.mjs';
import { RunnerBackend, readRunnerAgentSync } from '../server/backend/runner-backend.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'vs-unarch-'));

test('unarchive restores an archived runner agent: roster, sync read, timeline, meta kept; archive event stays in the log', async () => {
  const adapter = { start({ emit }) { return { send(t) { emit('status', { status: 'running' }); emit('output', { text: `echo:${t}` }); emit('turn_done', {}); emit('status', { status: 'idle' }); }, cancel() {}, kill() {} }; } };
  const dir = tmp();
  (await import('node:fs')).mkdirSync(path.join(dir, 'agents'));
  const runner = new Runner({ dir: path.join(dir, 'agents'), adapters: { claude: adapter } });
  const server = createServer(runner, { token: 't' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = tmp();
  writeDiscovery(home, { port: server.address().port, token: 't' });
  const backend = new RunnerBackend({ client: new RunnerClient({ home }), buildPrefix: async () => '' });
  try {
    const agent = await backend.createAgent({
      config: { provider: 'claude', model: 'm', cwd: process.cwd(), title: 'Old Chat', modeId: 'default' },
      initialPrompt: 'hi', labels: { team: 'vibesquad', lane: 'bug-chaser', role: 'brainstorm' }, env: {},
    });
    await backend.updateAgent(agent.id, { labels: { role: 'former-brainstorm' } });
    await backend.archiveAgent(agent.id);
    assert.equal((await backend.fetchAgents()).entries.length, 0);
    assert.ok(runner.status(agent.id).archivedAt);
    assert.ok(readRunnerAgentSync(agent.id, { home: dir })?.archivedAt, 'sync log read sees the archive');

    await backend.unarchiveAgent(agent.id);
    assert.equal(runner.status(agent.id).archivedAt, null);
    assert.equal(readRunnerAgentSync(agent.id, { home: dir })?.archivedAt, null);
    const roster = (await backend.fetchAgents()).entries.map((e) => e.agent);
    assert.equal(roster.length, 1);
    assert.equal(roster[0].archivedAt, null);
    assert.equal(roster[0].labels.role, 'former-brainstorm', 'role is untouched: it never becomes a live brainstorm');
    assert.equal((await backend.getAgentTimeline(agent.id)).at(-1).item.text, 'echo:hi', 'history still readable');
    assert.equal(runner.timeline(agent.id).filter((e) => e.type === 'archive').length, 1);
    assert.equal(runner.timeline(agent.id).filter((e) => e.type === 'unarchive').length, 1);
    assert.equal(runner.timeline(agent.id).at(-1).type, 'unarchive', 'unarchive resumes nothing');

    // Archiving again still works (archive after unarchive wins).
    await backend.archiveAgent(agent.id);
    assert.equal((await backend.fetchAgents()).entries.length, 0);
    await assert.rejects(() => backend.unarchiveAgent('rn-nope'));
  } finally { server.close(); server.closeAllConnections?.(); }
});
