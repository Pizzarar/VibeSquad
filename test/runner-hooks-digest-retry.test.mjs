// idea-207 H1/H2/M1: a digest whose turn dies on a transient EOF gets the A4 retry and logs ONE real verdict; UNVERIFIED only once
// retries are exhausted; the digest is archived exactly once, after the retry loop. Drives the REAL runner-hooks facade
// (waitForFinish over a fake runner timeline) and the real plugin hooks, so neither the wait nor the archive is mocked away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'vs-dr-'));
const VS_HOME = tmp();
process.env.VIBESQUAD_HOME = VS_HOME;
process.env.VIBESQUAD_ROOT = tmp();
const CWD = path.join(tmp(), 'VibeSquad');
mkdirSync(CWD, { recursive: true });
writeFileSync(
  path.join(VS_HOME, 'teams.json'),
  JSON.stringify({ teams: [{ id: 'vibesquad', name: 'VibeSquad', lanes: [{ id: 'bug-chaser', paths: ['VibeSquad'] }], paths: ['VibeSquad'] }] }),
);

const { createRunnerHookHost } = await import('../server/backend/runner-hooks.mjs');

const LOG = path.join(VS_HOME, 'teams', 'vibesquad', 'log.jsonl');
const teamLog = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
};

/**
 * A fake runner backend. Each digest turn plays the next entry of `turns`:
 *  'claude-eof': the claude adapter's result error (error item, then idle)
 *  'acp-eof':    an ACP turn that streamed some text, then the prompt rejected on EOF (runner/adapters/acp.mjs: error, then idle)
 *  'verdict':    the digest runs `vs log done` (a team-log entry) and replies
 * Like the runner, a turn shows `running` a couple of polls after its prompt, the status goes idle BEFORE the lifecycle
 * turn_ended reaches the hooks (the A4 retry is scheduled late), and a send to an archived agent throws "is not running".
 */
function fakeRunner(turns, workerId) {
  const agents = new Map();
  const timelines = new Map();
  const archived = [];
  const sends = [];
  let seq = 0;
  let host = null;
  let n = 0;
  const push = (id, item) => {
    const s = ++seq;
    timelines.get(id).push({ item, seqStart: s, seqEnd: s, timestamp: new Date().toISOString() });
  };
  const playTurn = async (id) => {
    const kind = turns[n++] ?? 'verdict';
    await sleep(40); // queued/starting: still idle on the first polls after the prompt (M1 window)
    agents.get(id).status = 'running';
    await sleep(30);
    let outcome = { kind: 'completed' };
    if (kind === 'claude-eof') {
      push(id, { type: 'error', message: 'API Error: unexpected EOF' });
      outcome = { kind: 'failed', error: { message: 'API Error: unexpected EOF' } };
    } else if (kind === 'acp-eof') {
      push(id, { type: 'assistant_message', text: 'Reading the worker report...' });
      push(id, { type: 'error', message: 'stream error: unexpected EOF' });
      outcome = { kind: 'failed', error: { message: 'stream error: unexpected EOF' } };
    } else {
      mkdirSync(path.dirname(LOG), { recursive: true });
      appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), agent: id, lane: 'bug-chaser', type: 'done', text: `PASS: real verdict for ${workerId}`, refs: [workerId] }) + '\n');
      push(id, { type: 'assistant_message', text: 'Logged.' });
    }
    agents.get(id).status = 'idle';
    await sleep(60); // the lifecycle stream trails the status the waiter polls
    await host.emit('agent.turn_ended', { agent: { ...agents.get(id) }, turnId: String(seq), outcome });
  };
  const backend = {
    async getAgent(id) {
      const a = agents.get(id);
      if (!a) throw new Error(`no agent ${id}`);
      return { ...a, labels: { ...a.labels } };
    },
    async fetchAgentTimeline(id, opts = {}) {
      const all = timelines.get(id) ?? [];
      return { entries: Number(opts.limit) > 0 ? all.slice(-Number(opts.limit)) : all.slice() };
    },
    async listAgents() {
      return [...agents.values()].map((a) => ({ ...a }));
    },
    async createAgent({ config, prompt, labels }) {
      const id = `rn-dig-${agents.size}`;
      agents.set(id, { id, title: config.title, cwd: config.cwd, provider: config.provider, status: 'idle', labels: { ...labels }, archivedAt: null, createdAt: new Date().toISOString() });
      timelines.set(id, []);
      push(id, { type: 'user_message', text: prompt });
      void playTurn(id);
      return { ...agents.get(id) };
    },
    async sendAgentPrompt(id, text) {
      const a = agents.get(id);
      if (!a || a.archivedAt) throw new Error(`agent ${id} is not running`); // runner/runner.mjs send()
      sends.push({ id, text });
      push(id, { type: 'user_message', text });
      void playTurn(id);
      return { queued: false };
    },
    async archiveAgent(id) {
      archived.push(id);
      const a = agents.get(id);
      if (a) a.archivedAt = new Date().toISOString();
    },
    async updateAgent() {},
    async cancelAgent() {},
    async deleteHeartbeat() {},
  };
  agents.set(workerId, { id: workerId, title: 'Bug1 · thing', cwd: CWD, provider: 'claude', status: 'idle', labels: { team: 'vibesquad', lane: 'bug-chaser', role: 'worker', job: 'j' }, archivedAt: null });
  timelines.set(workerId, []);
  push(workerId, { type: 'user_message', text: 'build thing' });
  push(workerId, { type: 'assistant_message', text: 'PASS: built thing' });
  return {
    backend, agents, archived, sends,
    setHost: (h) => (host = h),
    digestIds: () => [...agents.values()].filter((a) => a.labels.digestFor === workerId).map((a) => a.id),
  };
}

async function run(turns, workerId, { cappedProviders = [] } = {}) {
  const f = fakeRunner(turns, workerId);
  // retryBaseMs 1200: the A4 resend goes out well after the waiter's next poll (also the old 1s poll), so a waiter that
  // archives or gives up on the failed turn (H1/H2) is caught instead of being masked by a retry that already finished.
  const host = await createRunnerHookHost(f.backend, { startWatcher: false, deps: { retryBaseMs: 1200, cappedProviders }, pollMs: 20 });
  f.setHost(host);
  try {
    await host.emit('agent.turn_ended', { agent: await f.backend.getAgent(workerId), turnId: 't1', outcome: { kind: 'completed' } });
    const [dig] = await until(() => (f.digestIds().length ? f.digestIds() : null), 2000, 'digest spawned');
    const doneEntries = () => teamLog().filter((e) => e.type === 'done' && (e.refs ?? []).includes(workerId));
    // Settled: an entry for the turn is in, and every digest (the primary and any idea-218 alternate) is archived.
    await until(() => doneEntries().length && f.digestIds().every((id) => f.archived.includes(id)), 30000, 'digest(s) settled');
    await sleep(400); // anything late (a second verdict, a fallback, a second archive, a third digest) lands here
    const entries = doneEntries();
    return { ...f, dig, entries };
  } finally {
    host.dispose();
  }
}

test('H1/M1: a Claude digest whose turn 1 dies on EOF gets the A4 retry; one real verdict, no UNVERIFIED, archived once', async () => {
  const r = await run(['claude-eof', 'verdict'], 'rn-w-claude');
  assert.equal(r.digestIds().length, 1, 'one digest');
  assert.equal(r.sends.filter((s) => s.id === r.dig && /transient network error/.test(s.text)).length, 1, 'the retry reached the (unarchived) digest');
  assert.deepEqual(r.entries.map((e) => e.text), ['PASS: real verdict for rn-w-claude'], 'exactly one verdict, the real one');
  assert.deepEqual(r.archived, [r.dig], 'archived exactly once, after the retry');
});

test('H2: an ACP turn that errors then goes idle is a failed turn: retried, then one real verdict', async () => {
  const r = await run(['acp-eof', 'verdict'], 'rn-w-acp');
  assert.equal(r.sends.filter((s) => s.id === r.dig).length, 1, 'one A4 resend');
  assert.deepEqual(r.entries.map((e) => e.text), ['PASS: real verdict for rn-w-acp']);
  assert.deepEqual(r.archived, [r.dig]);
});

test('retries exhausted, no alternate (claude + opencode capped): two resends, then exactly one UNVERIFIED, archived once', async () => {
  const r = await run(['claude-eof', 'acp-eof', 'claude-eof'], 'rn-w-dead', { cappedProviders: ['claude', 'opencode'] });
  assert.equal(r.digestIds().length, 1, 'no alternate: never respawned');
  assert.equal(r.sends.filter((s) => s.id === r.dig).length, 2, 'MAX_RETRIES resends');
  assert.equal(r.entries.length, 1, 'one entry for the turn');
  assert.match(r.entries[0].text, /^UNVERIFIED \(digest failed\): PASS: built thing/);
  assert.deepEqual(r.archived, [r.dig]);
});

const EXHAUST = ['claude-eof', 'acp-eof', 'claude-eof']; // turn 1 + MAX_RETRIES resends, all EOF

test('idea-218: primary EOF through its retries -> respawned ONCE on the failover alternate (Check - Haiku); one real verdict, each archived once', async () => {
  const r = await run([...EXHAUST, 'verdict'], 'rn-w-alt');
  const ids = r.digestIds();
  assert.equal(ids.length, 2, 'primary + one alternate');
  const [primary, alt] = ids.map((id) => r.agents.get(id));
  assert.equal(primary.labels.profile, 'Pre-check - Flash');
  assert.equal(primary.provider, 'antigravity-cli');
  assert.equal(alt.labels.profile, 'Check - Haiku', 'counterpart of the digest profile');
  assert.equal(alt.provider, 'claude', 'a different provider');
  assert.equal(alt.labels.digestFor, 'rn-w-alt');
  assert.equal(r.sends.filter((s) => s.id === primary.id).length, 2, 'the primary got its MAX_RETRIES resends first');
  assert.deepEqual(r.entries.map((e) => e.text), ['PASS: real verdict for rn-w-alt'], 'exactly one entry: the alternate verdict, no UNVERIFIED');
  assert.deepEqual(r.archived, [primary.id, alt.id], 'each archived exactly once, the primary before the alternate spawned');
});

test('idea-218: the alternate skips capped providers (claude capped -> Audit - DSF on opencode)', async () => {
  const r = await run([...EXHAUST, 'verdict'], 'rn-w-skip', { cappedProviders: ['claude'] });
  const ids = r.digestIds();
  assert.equal(ids.length, 2);
  const alt = r.agents.get(ids[1]);
  assert.equal(alt.labels.profile, 'Audit - DSF');
  assert.equal(alt.provider, 'opencode');
  assert.deepEqual(r.entries.map((e) => e.text), ['PASS: real verdict for rn-w-skip']);
  assert.deepEqual(r.archived, ids);
});

test('idea-218: the alternate also fails through its retries -> no third digest, exactly one UNVERIFIED, both archived once', async () => {
  const r = await run([...EXHAUST, ...EXHAUST], 'rn-w-both');
  const ids = r.digestIds();
  assert.equal(ids.length, 2, 'respawned once, never twice');
  assert.equal(r.sends.filter((s) => s.id === ids[1]).length, 2, 'the alternate gets its own A4 retries');
  assert.equal(r.entries.length, 1, 'one entry for the turn');
  assert.match(r.entries[0].text, /^UNVERIFIED \(digest failed\): PASS: built thing/);
  assert.deepEqual(r.archived, ids, 'each archived exactly once');
});

test('M1: a second waitForFinish after a resend does not return on the previous turn (floor past the reported turn)', async () => {
  const f = fakeRunner(['claude-eof', 'verdict'], 'rn-w-floor');
  const { runnerPaseoFacade } = await import('../server/backend/runner-hooks.mjs');
  f.setHost({ emit: async () => {} }); // no hooks: this drives the handle alone
  const facade = runnerPaseoFacade(f.backend, { splitProviderModel: (p, m) => ({ provider: p, model: m }) }, { pollMs: 20 });
  const h = await facade.agents.create({ config: { provider: 'claude' }, title: 't', prompt: 'p', labels: { digestFor: 'rn-w-floor' } });
  const first = await h.waitForFinish(5000);
  assert.equal(first.status, 'error');
  assert.match(first.error, /EOF/);
  await f.backend.sendAgentPrompt(h.id, 'retry');
  const second = await h.waitForFinish(5000);
  assert.equal(second.status, 'idle', 'turn 2 (the verdict turn), not turn 1 again');
  const tail = (await f.backend.fetchAgentTimeline(h.id)).entries.at(-1);
  assert.equal(tail.item.text, 'Logged.', 'returned only after turn 2 produced its reply');
  assert.deepEqual(f.archived, [], 'no autoArchive requested: the handle never archives');
});
