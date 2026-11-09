import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOpsMention, unroutedOpsBucket } from '../scripts/audit-owner-stamps.mjs';

const ev = (o) => JSON.stringify(o);

test('isOpsMention matches restart / sync / gotchas-blocker phrasing', () => {
  for (const t of ['it needs a server restart', 'needs restart', 'restart the server', 'restart the VS server', 'runtime sync', 'sync the runtime', 'untracked files', 'node_modules junction', 'flaky test']) {
    assert.equal(isOpsMention(t), true, t);
  }
  for (const t of ['all good', 'merged and pushed', 'the sky is blue', 'no news']) {
    assert.equal(isOpsMention(t), false, t);
  }
});

test('unroutedOpsBucket skips routed mentions and flags unrouted ones by lane with rn id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
  const now = Date.now();
  // Overlord run: hub lead (lane === team).
  fs.writeFileSync(path.join(dir, 'rn-overlord.jsonl'), [
    ev({ type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'vibesquad', team: 'vibesquad' } }),
  ].join('\n'));
  // Routed: mentions restart AND sends it to the Overlord within the window.
  fs.writeFileSync(path.join(dir, 'rn-routed.jsonl'), [
    ev({ type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'ade', team: 'vibesquad' } }),
    ev({ type: 'output', ts: now - 500, text: 'Merged. It needs a server restart to go live.' }),
    ev({ type: 'tool', ts: now - 400, name: 'mcp__vibesquad__send', input: { id: 'rn-overlord', text: 'From @ade Ade1 (lead): needs a server restart after merge.' } }),
  ].join('\n'));
  // Unrouted: mentions restart, never routes it.
  fs.writeFileSync(path.join(dir, 'rn-unrouted.jsonl'), [
    ev({ type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'uip', team: 'vibesquad' } }),
    ev({ type: 'output', ts: now - 300, text: 'Merged. Restart the VS server to pick it up.' }),
  ].join('\n'));
  const r = unroutedOpsBucket(dir);
  assert.equal(r.mentions, 2);
  assert.equal(r.routed, 1);
  assert.equal(r.total, 1);
  assert.deepEqual(r.byLane, { uip: 1 });
  assert.equal(r.examples.length, 1);
  assert.equal(r.examples[0].run, 'rn-unrouted');
  assert.equal(r.examples[0].lane, 'uip');
});

test('unroutedOpsBucket respects the since/until window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'rn-w.jsonl'), [
    ev({ type: 'created', ts: now - 10 * 3600 * 1000, meta: { role: 'lead', lane: 'art', team: 'vibesquad' } }),
    ev({ type: 'output', ts: now - 10 * 3600 * 1000, text: 'flaky shared test needs a server restart' }),
  ].join('\n'));
  assert.equal(unroutedOpsBucket(dir).total, 1);
  assert.equal(unroutedOpsBucket(dir, { since: now - 3600 * 1000 }).total, 0);
});
