// idea-783: the Art Director (duet partner) must stay reachable for its Painter across idle/park cycles.
// Unit: the pair rule (server/art-duet.mjs). Runner: a parked Director is resumed by its Painter's own (agent-caller) send,
// round after round; an archived one is not (a worker may not unarchive a peer it did not spawn), which is why the
// auto-close must never archive a Director whose Painter is live (server/hooks/agent-duties.ts).
import "./setup/hermetic.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '../runner/runner.mjs';
import { createServer, writeDiscovery } from '../runner/server.mjs';
import { RunnerClient } from '../server/backend/runner-client.mjs';
import { RunnerBackend } from '../server/backend/runner-backend.mjs';
import { ART_DUET, isDuetDirector, isLiveDuetMember, liveDuetPainterOf } from '../server/art-duet.mjs';

const dirs = [];
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-duet-')); dirs.push(d); return d; };

const mk = (id, profile, over = {}, labels = {}) => ({ id, status: 'idle', ...over, labels: { team: 'efi', lane: 'art-pipeline', role: 'worker', profile, job: 'CB4 · paint', ...labels } });

test('pair rule: a Director is held only by a live Painter of the same job and lane; a Painter is never held', () => {
  const dir = mk('d', 'Art Director - Gemini');
  assert.equal(isDuetDirector(dir.labels), true);
  assert.equal(liveDuetPainterOf(dir, [dir, mk('p', 'Art Painter - Opus')]), 'p');
  assert.equal(liveDuetPainterOf(dir, [mk('p', 'Art Painter - Opus', { status: 'running' })]), 'p', 'running counts');
  assert.equal(liveDuetPainterOf(dir, [mk('p', 'Art Painter - Opus', { status: 'initializing' })]), 'p', 'queued counts');
  assert.equal(liveDuetPainterOf(mk('d2', 'Art Director'), [mk('p2', 'Art Painter')]), 'p2', 'P5c role names pair');
  // Not live / not its Painter.
  assert.equal(liveDuetPainterOf(dir, [mk('p', 'Art Painter - Opus', { archivedAt: '2026-11-24T10:00:00Z' })]), null, 'archived');
  for (const status of ['closed', 'error', 'exited', 'archived']) assert.equal(liveDuetPainterOf(dir, [mk('p', 'Art Painter - Opus', { status })]), null, status);
  assert.equal(liveDuetPainterOf(dir, [mk('p', 'Art Painter - Opus', {}, { job: 'other' })]), null, 'other job');
  assert.equal(liveDuetPainterOf(dir, [mk('p', 'Art Painter - Opus', {}, { lane: 'ui-raid' })]), null, 'other lane');
  assert.equal(liveDuetPainterOf(dir, [mk('p', 'Art Painter', {})]), null, 'old names pair with old names only');
  assert.equal(liveDuetPainterOf(dir, [mk('d9', 'Art Director - Gemini')]), null, 'another Director is not a Painter');
  // Never held: the Painter itself, a Director without a job, any other profile.
  assert.equal(isDuetDirector(mk('p', 'Art Painter - Opus').labels), false);
  assert.equal(liveDuetPainterOf(mk('p', 'Art Painter - Opus'), [mk('d', 'Art Director - Gemini')]), null);
  assert.equal(liveDuetPainterOf(mk('d', 'Art Director - Gemini', {}, { job: '' }), [mk('p', 'Art Painter - Opus', {}, { job: '' })]), null, 'no job: no pair key');
  assert.equal(isDuetDirector(mk('i', 'Implement - Sonnet').labels), false);
  assert.equal(isLiveDuetMember(null), false);
  assert.equal(ART_DUET['Art Painter - Opus'], 'Art Director - Gemini', 'the spawn tool pairs from the same table');
});

// A parkable fake provider (as in worker-close-cap-ttl.test.mjs): sessions survive a park, a send echoes.
function parkableAdapter(starts) {
  return {
    canPark: true,
    start({ emit, resume }) {
      starts.push(resume ?? null);
      setImmediate(() => emit('session', { sessionId: resume ?? 'sess-dir' }));
      return {
        send(text) { emit('status', { status: 'running' }); emit('output', { text: `echo:${text}` }); emit('turn_done', {}); emit('status', { status: 'idle' }); },
        cancel() {}, kill() {},
      };
    },
  };
}

test('a parked Director is resumed by its Painter\'s send across park cycles and stays on the roster; an archived one is not', async () => {
  const starts = [];
  const runner = new Runner({ dir: tmp(), adapters: { claude: parkableAdapter(starts) } });
  const server = createServer(runner, { token: 't' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const home = tmp();
  writeDiscovery(home, { port: server.address().port, token: 't' });
  const backend = new RunnerBackend({ client: new RunnerClient({ home, env: {} }), buildPrefix: async () => '' });
  const spawn = (title, profile, labels = {}) => backend.createAgent({
    config: { provider: 'claude', model: 'm', cwd: process.cwd(), title }, initialPrompt: 'start',
    labels: { team: 'efi', lane: 'art-pipeline', role: 'worker', profile, job: 'CB4 · paint', ...labels }, env: {},
  });
  const settle = () => new Promise((r) => setTimeout(r, 20)); // the session event
  try {
    const lead = await spawn('Lead', 'Lead - Opus', { role: 'lead' });
    const painter = await spawn('Painter', 'Art Painter - Opus', { 'vs.parent': lead.id });
    const director = await spawn('Director', 'Art Director - Gemini', { 'vs.parent': lead.id }); // the lead's child, NOT the Painter's
    for (const a of [lead, painter, director]) { await backend.waitForFinish(a.id, 2000); await settle(); }
    const asPainter = { senderId: painter.id, caller: { id: painter.id, token: runner.tokensById.get(painter.id) } };
    const onRoster = async () => (await backend.fetchAgents()).entries.some((e) => (e.agent ?? e).id === director.id);

    for (const round of [1, 2, 3]) {
      runner.park(director.id); // R4 parks an idle agent right after turn_done
      assert.equal(runner.live.has(director.id), false, `round ${round}: parked, no process`);
      const parked = (await backend.fetchAgent(director.id)).agent;
      assert.equal(parked.status, 'idle', `round ${round}: a parked Director reads idle`);
      assert.equal(parked.archivedAt ?? null, null, `round ${round}: and is not archived`);
      assert.equal(await onRoster(), true, `round ${round}: still on the roster (vs who)`);
      await backend.sendAgentPrompt(director.id, `gallery r${round}`, asPainter); // the Painter's own send: resumes in place
      await backend.waitForFinish(director.id, 2000);
      await settle();
      assert.equal((await backend.getAgentTimeline(director.id)).at(-1).item.text, `echo:gallery r${round}`, `round ${round}: delivered`);
    }
    assert.deepEqual(starts.slice(-3), ['sess-dir', 'sess-dir', 'sess-dir'], 'every round resumed the same session');

    // The incident state: the done-report close archived the parked Director. Its Painter is not its parent, lead or the
    // Overlord, so the revive (unarchive) is refused and the send fails exactly as reported in idea-783.
    runner.park(director.id);
    await backend.updateAgent(director.id, { labels: { 'vs.auto-archived': '1' } });
    await backend.archiveAgent(director.id);
    await assert.rejects(() => backend.sendAgentPrompt(director.id, 'gallery r4', asPainter), /not running/);
    assert.equal(await onRoster(), false, 'archived: off the roster');
    assert.ok((await backend.fetchAgent(director.id)).agent.archivedAt, 'archivedAt is what status must report (tools.mjs snapshot)');
    assert.equal((await backend.fetchAgent(director.id)).agent.labels['vs.parent'], lead.id);
    // Its parent lead may unarchive it: the same send from the lead revives it (the gate, not the runner, refused the Painter).
    await backend.sendAgentPrompt(director.id, 'lead nudge', { senderId: lead.id, caller: { id: lead.id, token: runner.tokensById.get(lead.id) } });
    await backend.waitForFinish(director.id, 2000);
    assert.equal((await backend.getAgentTimeline(director.id)).at(-1).item.text, 'echo:lead nudge');
  } finally {
    runner.shutdown();
    server.close(); server.closeAllConnections?.();
  }
});
