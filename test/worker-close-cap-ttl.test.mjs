// R5: cap TTL (expired caps are ignored and pruned) and archived-worker revival through RunnerBackend.send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createServer, writeDiscovery } from '../runner/server.mjs';
import { RunnerClient } from '../server/backend/runner-client.mjs';
import { RunnerBackend } from '../server/backend/runner-backend.mjs';
import { CAP_DEFAULT_TTL_MS, isCapExpired, readCappedProviders } from '../server/provider-failover.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'vs-r5-'));
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

test('cap TTL: updatedAt older than 5 h (no reset given) is ignored and pruned from the file', () => {
  const dir = tmp();
  const file = path.join(dir, 'capped-providers.json');
  try {
    writeFileSync(file, JSON.stringify({ capped: { claude: { reason: 'old', updatedAt: hoursAgo(6) }, gemini: { reason: 'fresh', updatedAt: hoursAgo(1) } } }), 'utf8');
    const caps = readCappedProviders({ cappedProvidersPath: file, useDiskCaps: true });
    assert.deepEqual(Object.keys(caps), ['antigravity-cli'], 'only the fresh gemini cap (normalized family)');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).capped), ['gemini'], 'expired cap pruned from disk');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cap TTL: a stated reset time overrides the 5 h default in both directions', () => {
  const now = Date.now();
  assert.equal(CAP_DEFAULT_TTL_MS, 5 * 3600_000);
  assert.equal(isCapExpired({ updatedAt: hoursAgo(10), resetsAt: new Date(now + 3600_000).toISOString() }, now), false, 'reset still ahead');
  assert.equal(isCapExpired({ updatedAt: hoursAgo(1), resetsAt: new Date(now - 1000).toISOString() }, now), true, 'reset passed');
  assert.equal(isCapExpired({ reason: 'no timestamp' }, now), false, 'unknown age never expires');
});

test('cap TTL: epoch-seconds resetsAt is read as seconds, a BOM does not hide the file, and pruning keeps a concurrent cap', () => {
  const now = Date.now();
  assert.equal(isCapExpired({ resetsAt: Math.floor(now / 1000) - 60 }, now), true, 'seconds in the past');
  assert.equal(isCapExpired({ resetsAt: Math.floor(now / 1000) + 3600 }, now), false, 'seconds in the future');
  const dir = tmp();
  const file = path.join(dir, 'c.json');
  try {
    writeFileSync(file, '\uFEFF' + JSON.stringify({ capped: { claude: { updatedAt: hoursAgo(8) }, deepseek: { updatedAt: hoursAgo(1) } } }), 'utf8');
    assert.deepEqual(Object.keys(readCappedProviders({ cappedProvidersPath: file, useDiskCaps: true })), ['deepseek']);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).capped), ['deepseek']);
    assert.deepEqual(readdirSync(dir), ['c.json'], 'no tmp file left behind');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('vs cap list never shows an expired cap', () => {
  const dir = tmp();
  const home = path.join(dir, '.vibesquad');
  mkdirSync(home, { recursive: true });
  try {
    writeFileSync(path.join(home, 'capped-providers.json'), JSON.stringify({ capped: { claude: { reason: 'stale cap', updatedAt: hoursAgo(9) } } }), 'utf8');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PASEO_(AGENT_|CLI)|VS_)/.test(k)));
    const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '..', 'cli', 'vs.mjs'), 'cap', 'list'], {
      encoding: 'utf8', env: { ...env, VIBESQUAD_HOME: home, PASEO_HOME: path.join(dir, '.paseo') },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '(no capped providers)\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A parkable fake provider: sessions survive a park, and a send to a revived agent echoes.
function parkableAdapter() {
  return {
    canPark: true,
    start({ emit, resume }) {
      setImmediate(() => emit('session', { sessionId: resume ?? 'sess-1' }));
      return {
        send(text) { emit('status', { status: 'running' }); emit('output', { text: `echo:${text}` }); emit('turn_done', {}); emit('status', { status: 'idle' }); },
        cancel() {}, kill() {},
      };
    },
  };
}

test('a finished worker (parked, then archived) has no live process and a later send unarchives + resumes it', async () => {
  const runner = new Runner({ dir: tmp(), adapters: { claude: parkableAdapter() } });
  const server = createServer(runner, { token: 't' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = tmp();
  writeDiscovery(home, { port: server.address().port, token: 't' });
  const backend = new RunnerBackend({ client: new RunnerClient({ home }), buildPrefix: async () => '' });
  try {
    const agent = await backend.createAgent({
      config: { provider: 'claude', model: 'm', cwd: process.cwd(), title: 'W' }, initialPrompt: 'work',
      labels: { team: 'vibesquad', lane: 'bug', role: 'worker' }, env: {},
    });
    await backend.waitForFinish(agent.id, 2000);
    await new Promise((r) => setTimeout(r, 20)); // session event
    runner.park(agent.id); // R4 parks an idle agent right after turn_done; the close path then archives
    await backend.updateAgent(agent.id, { labels: { 'vs.auto-archived': '1' } }); // what the plugin's close path sets
    await backend.archiveAgent(agent.id);
    assert.equal(runner.live.size, 0, 'no live process');
    assert.equal((await backend.fetchAgents()).entries.length, 0, 'archived from the roster');

    await backend.sendAgentPrompt(agent.id, 'follow-up');
    const tl = await backend.getAgentTimeline(agent.id);
    assert.equal(tl.at(-1).item.text, 'echo:follow-up', 'the send was delivered, not dropped');
    assert.equal((await backend.fetchAgents()).entries.length, 1, 'back on the roster');
  } finally {
    server.close(); server.closeAllConnections?.();
  }
});

test('send revives only an auto-archived worker: a retired lead stays archived and the send fails', async () => {
  const runner = new Runner({ dir: tmp(), adapters: { claude: parkableAdapter() } });
  const server = createServer(runner, { token: 't' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = tmp();
  writeDiscovery(home, { port: server.address().port, token: 't' });
  const backend = new RunnerBackend({ client: new RunnerClient({ home }), buildPrefix: async () => '' });
  const mk = (role) => backend.createAgent({ config: { provider: 'claude', model: 'm', cwd: process.cwd(), title: role }, initialPrompt: 'x', labels: { team: 'vibesquad', lane: 'bug', role }, env: {} });
  try {
    const lead = await mk('lead');
    const worker = await mk('worker');
    for (const a of [lead, worker]) { await backend.waitForFinish(a.id, 2000); await new Promise((r) => setTimeout(r, 20)); runner.park(a.id); }
    // Unmarked archives (a retired lead, a manual archive) are never revived, even for a worker.
    await backend.archiveAgent(lead.id);
    await assert.rejects(() => backend.sendAgentPrompt(lead.id, 'hi'), /not running/);
    await backend.archiveAgent(worker.id);
    await assert.rejects(() => backend.sendAgentPrompt(worker.id, 'hi'), /not running/, 'unmarked worker archive is not revived');
    assert.equal((await backend.fetchAgent(lead.id)).agent.archivedAt !== null, true);
    await backend.updateAgent(worker.id, { labels: { 'vs.auto-archived': '1' } });
    await backend.sendAgentPrompt(worker.id, 'hi');
    assert.equal((await backend.getAgentTimeline(worker.id)).at(-1).item.text, 'echo:hi');
  } finally {
    server.close(); server.closeAllConnections?.();
  }
});

test('cap TTL: numeric-string resetsAt is read as seconds or ms', () => {
  const now = Date.now();
  const sec = (d) => String(Math.floor(now / 1000) + d);
  assert.equal(isCapExpired({ resetsAt: sec(-60) }, now), true, 'seconds string, past');
  assert.equal(isCapExpired({ resetsAt: sec(3600) }, now), false, 'seconds string, future');
  assert.equal(isCapExpired({ resetsAt: String(now - 60_000) }, now), true, 'ms string, past');
  assert.equal(isCapExpired({ resetsAt: String(now + 3600_000) }, now), false, 'ms string, future');
});
