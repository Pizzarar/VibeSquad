import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOpsMention, unroutedOpsBucket, audit, handoffBucket } from '../scripts/audit-owner-stamps.mjs';

const ev = (o) => JSON.stringify(o);
const mkdir = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const write = (dir, name, lines) => fs.writeFileSync(path.join(dir, name), lines.map(ev).join('\n'));

test('isOpsMention matches restart/sync blockers and rejects negated/instructional/flaky-passing', () => {
  for (const t of ['it needs a server restart', 'needs restart', 'restart the server', 'restart the VS server', 'runtime sync', 'sync the runtime', 'untracked files', 'node_modules junction']) {
    assert.equal(isOpsMention(t), true, t);
  }
  assert.equal(isOpsMention('the flaky shared test blocks the suite'), true);
  for (const t of [
    "I didn't restart the server",
    "Don't restart the runner or server yourself",
    'no need to restart',
    'Still waiting on Hub2 to sync the runtime and restart the server',
    'checking how the other lanes sync the runtime',
    'The only test failure was the known flaky git-watch test (15/15 on 3 solo reruns)',
    'Flaky under full-suite load: it passes 15/15 three times in a row on its own.',
    "I'll re-run that file alone to see whether it's flaky.",
    'all good',
  ]) assert.equal(isOpsMention(t), false, t);
});

test('unroutedOpsBucket flags unrouted restart mentions and skips routed ones by lane with rn id', (t) => {
  const dir = mkdir(t);
  const now = Date.now();
  write(dir, 'rn-overlord.jsonl', [{ type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'vibesquad', team: 'vibesquad' } }]);
  // Routed: mentions restart AND sends it to the Overlord within the window.
  write(dir, 'rn-routed.jsonl', [
    { type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'ade', team: 'vibesquad' } },
    { type: 'output', ts: now - 500, text: 'Merged. It needs a server restart to go live.' },
    { type: 'tool', ts: now - 400, name: 'mcp__vibesquad__send', input: { id: 'rn-overlord', text: 'From @ade Ade1 (lead): needs a server restart after merge.' } },
  ]);
  // Unrouted: mentions restart, never routes it.
  write(dir, 'rn-unrouted.jsonl', [
    { type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'uip', team: 'vibesquad' } },
    { type: 'output', ts: now - 300, text: 'Merged. Restart the VS server to pick it up.' },
  ]);
  const r = unroutedOpsBucket(dir);
  assert.equal(r.mentions, 2);
  assert.equal(r.routed, 1);
  assert.equal(r.total, 1);
  assert.deepEqual(r.byLane, { uip: 1 });
  assert.equal(r.examples.length, 1);
  assert.equal(r.examples[0].run, 'rn-unrouted');
  assert.equal(r.examples[0].lane, 'uip');
  assert.match(r.auditKey, /^unrouted-ops:\d{4}-\d{2}-\d{2}$/);
});

test('(a) non-lead incoming input messages are ignored', (t) => {
  const dir = mkdir(t);
  const now = Date.now();
  write(dir, 'rn-overlord.jsonl', [{ type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'vibesquad', team: 'vibesquad' } }]);
  write(dir, 'rn-lead.jsonl', [
    { type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'ade', team: 'vibesquad' } },
    { type: 'input', ts: now - 500, text: "Hub3: Tell me when you've pushed, and I'll restart the server" },
    { type: 'input', ts: now - 400, text: "New team log event in lane ade: [done] PASS, needs a restart" },
  ]);
  const r = unroutedOpsBucket(dir);
  assert.equal(r.mentions, 0);
  assert.equal(r.total, 0);
});

test('(b) handoff packet input matches Judgment/Gotchas, ignoring Recent team log and brainstorm summary', (t) => {
  const dir = mkdir(t);
  const now = Date.now();
  write(dir, 'rn-overlord.jsonl', [{ type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'vibesquad', team: 'vibesquad' } }]);
  write(dir, 'rn-handoff.jsonl', [{
    type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'ade', team: 'vibesquad' },
  }, {
    type: 'input', ts: now - 500, text: [
      'You are ★ Ade2, the successor lead for lane `ade` (handoff trigger=self from rn-prev).',
      '- **Handoff packet:** `C:/packet-ade.md`',
      '--- BEGIN HANDOFF PACKET (C:/packet-ade.md) ---',
      '# Handoff — VibeSquad / ade / ord1',
      '## Auto State',
      '**Recent Team Log (since last handoff):**',
      '  - restart the server (noise that must be ignored)',
      '## Judgment',
      'Merged X. It needs a server restart to go live.',
      '## Decisions',
      '- none',
      '### Gotchas',
      '- restart the server after merge',
      '## Next',
      '- ship',
      '--- END HANDOFF PACKET ---',
      '--- BEGIN BRAINSTORM SUMMARY ---',
      'runtime sync noise that must be ignored',
      '--- END BRAINSTORM SUMMARY ---',
    ].join('\n'),
  }]);
  const r = unroutedOpsBucket(dir);
  assert.equal(r.total, 1);
  assert.deepEqual(r.byLane, { ade: 1 });
  assert.equal(r.examples[0].run, 'rn-handoff');
});

test('(c) CLI vs send to Overlord and inbox add to @bug count as routed', (t) => {
  const dir = mkdir(t);
  const now = Date.now();
  write(dir, 'rn-overlord.jsonl', [{ type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'vibesquad', team: 'vibesquad' } }]);
  // Routed via CLI `vs send <overlord>` in a Bash tool.
  write(dir, 'rn-cli-send.jsonl', [
    { type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'ade', team: 'vibesquad' } },
    { type: 'output', ts: now - 500, text: 'Merged. It needs a server restart.' },
    { type: 'tool', ts: now - 400, name: 'Bash', input: { command: 'vs send rn-overlord "needs a server restart"' } },
  ]);
  // Routed via `vs inbox add --from-brainstorm --lane bug-chaser` (flags before --lane).
  write(dir, 'rn-inbox-add.jsonl', [
    { type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'uip', team: 'vibesquad' } },
    { type: 'output', ts: now - 500, text: 'Merged. Restart the VS server.' },
    { type: 'tool', ts: now - 400, name: 'Bash', input: { command: 'vs inbox add --from-brainstorm --lane bug-chaser "restart needed"' } },
  ]);
  const r = unroutedOpsBucket(dir);
  assert.equal(r.mentions, 2);
  assert.equal(r.routed, 2);
  assert.equal(r.total, 0);
});

test('(c2) vs inbox add with --lane @bug counts as routed', (t) => {
  const dir = mkdir(t);
  const now = Date.now();
  write(dir, 'rn-overlord.jsonl', [{ type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'vibesquad', team: 'vibesquad' } }]);
  write(dir, 'rn-inbox-atbug.jsonl', [
    { type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'uip', team: 'vibesquad' } },
    { type: 'output', ts: now - 500, text: 'Merged. Runtime sync needed.' },
    { type: 'tool', ts: now - 400, name: 'Bash', input: { command: 'vs inbox add --lane @bug "runtime sync"' } },
  ]);
  const r = unroutedOpsBucket(dir);
  assert.equal(r.total, 0);
});

test('(e) @bug self-mentions are not flagged (the bug lane is the sink)', (t) => {
  const dir = mkdir(t);
  const now = Date.now();
  write(dir, 'rn-overlord.jsonl', [{ type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'vibesquad', team: 'vibesquad' } }]);
  write(dir, 'rn-bug.jsonl', [
    { type: 'created', ts: now - 1000, meta: { role: 'lead', lane: 'bug-chaser', team: 'vibesquad' } },
    { type: 'output', ts: now - 500, text: 'Merged. It needs a server restart to go live.' },
  ]);
  const r = unroutedOpsBucket(dir);
  assert.equal(r.mentions, 0);
  assert.equal(r.total, 0);
});

test('unroutedOpsBucket respects the since/until window', (t) => {
  const dir = mkdir(t);
  const now = Date.now();
  write(dir, 'rn-w.jsonl', [
    { type: 'created', ts: now - 10 * 3600 * 1000, meta: { role: 'lead', lane: 'art', team: 'vibesquad' } },
    { type: 'output', ts: now - 10 * 3600 * 1000, text: 'flaky shared test needs a server restart' },
  ]);
  assert.equal(unroutedOpsBucket(dir).total, 1);
  assert.equal(unroutedOpsBucket(dir, { since: now - 3600 * 1000 }).total, 0);
});

test('(f) audit reports rubber-stamps per lane', (t) => {
  const dir = mkdir(t);
  write(dir, 'rn-a.jsonl', [
    { type: 'created', ts: 1, meta: { role: 'lead', lane: 'ade', team: 'vibesquad' } },
    { type: 'input', ts: 2, text: 'send it' },
  ]);
  write(dir, 'rn-b.jsonl', [
    { type: 'created', ts: 1, meta: { role: 'lead', lane: 'uip', team: 'vibesquad' } },
    { type: 'input', ts: 2, text: 'send it' },
  ]);
  assert.deepEqual(audit({ dir }).stampsByLane, { ade: 1, uip: 1 });
});

test('(f) handoffBucket reports under100k per lane', () => {
  const run = (o) => ({ outputs: 0, maxCtx: 0, inputs: [], labels: {}, cwd: '', ts: 1, ...o });
  const runs = [
    run({ id: 'p1', role: 'lead', team: 't', lane: 'l', maxCtx: 50000 }),
    run({ id: 's1', role: 'lead', team: 't', lane: 'l', labels: { 'vs.handoff-from': 'p1', 'vs.handoff-trigger': 'self' } }),
  ];
  const r = handoffBucket(runs);
  assert.equal(r.churn['t/l'].under100k, 1);
  assert.deepEqual(r.handoffs, { total: 1, under100k: 1, atOrOver100k: 0, predecessorUnknown: 0 });
});
