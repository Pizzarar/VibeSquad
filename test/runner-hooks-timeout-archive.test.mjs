// idea-189: a digest created with autoArchive must NOT be archived when its waitForFinish merely times out (still queued/running).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runnerPaseoFacade } from '../server/backend/runner-hooks.mjs';

function fake(statuses) {
  const archived = [];
  let i = 0;
  const backend = {
    createAgent: async () => ({ id: 'rn-dig', status: 'queued' }),
    getAgent: async () => ({ id: 'rn-dig', status: statuses[Math.min(i++, statuses.length - 1)] }),
    fetchAgentTimeline: async () => ({ entries: [] }),
    archiveAgent: async (id) => { archived.push(id); },
  };
  const plugin = { splitProviderModel: (p, m) => ({ provider: p, model: m }) };
  return { archived, facade: runnerPaseoFacade(backend, plugin) };
}

test('autoArchive: a timeout (still queued) leaves the digest alive; a finished/closed one is archived', async () => {
  const q = fake(['queued']);
  const h = await q.facade.agents.create({ config: { provider: 'antigravity-cli' }, autoArchive: true });
  const res = await h.waitForFinish(30);
  assert.equal(res.status, 'timeout');
  assert.deepEqual(q.archived, [], 'a timed-out wait must not archive the pending digest');

  const c = fake(['closed']);
  const h2 = await c.facade.agents.create({ config: { provider: 'antigravity-cli' }, autoArchive: true });
  assert.equal((await h2.waitForFinish(1000)).status, 'error');
  assert.deepEqual(c.archived, ['rn-dig'], 'a failed/closed digest is still archived');
});
