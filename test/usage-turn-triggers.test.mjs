import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyTurnTrigger,
  clampLeadLongThreshold,
  clearUsageCache,
  getUsage,
  getUsageAsync,
  handleProvidersApi,
  LEAD_LONG_TURN_MIN,
  LEAD_LONG_THRESHOLD_MIN,
  LEAD_LONG_THRESHOLD_MAX,
  TURN_TRIGGERS,
} from '../server/providers-catalog.mjs';
import { SOFT_FLAG_NUDGE, WRITE_HANDOFF_PROMPT } from '../server/lead-handoff.mjs';
import { BRAINSTORM_WARN_NUDGE } from '../server/token-watch.mjs';
import { doneText } from '../server/restart-coord.mjs';
import { kickText, escalateText } from '../server/idle-lane-kick.mjs';
import './helpers/keep-alive.mjs';

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-triggers-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

const noGit = () => '';
const T0 = Date.UTC(2026, 10, 20, 12);

function writeAgent(home, id, evs) {
  const dir = path.join(home, 'runner', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), evs.map((e, i) => JSON.stringify({ seq: i, ...e })).join('\n') + '\n');
}

function callApi(urlPath, home) {
  return new Promise((resolve) => {
    const req = { method: 'GET', url: urlPath };
    handleProvidersApi(req, {}, {
      home,
      git: noGit,
      sendJson: (_res, status, body) => resolve({ status, body }),
      readBody: async () => ({}),
    });
  });
}

test('classifyTurnTrigger: structured runner fields and anchored server headers only; never infers from prose', () => {
  // Structured fields win even if text looks like a server protocol message
  assert.equal(classifyTurnTrigger({ senderId: 'rn-lead', text: 'Watch w-abcdef12 complete: all 1 item done.' }), 'send');
  assert.equal(classifyTurnTrigger({ owner: true, text: doneText('2026-11-25T13:00:00Z') }), 'send');
  assert.equal(classifyTurnTrigger({ senderId: 'rn-lead', text: 'hello' }, { isFirstInput: true }), 'send');
  assert.equal(classifyTurnTrigger({ owner: true, text: 'hello' }, { isFirstInput: true }), 'send');

  // Resume / runtime origin / initial spawn prompt -> none
  assert.equal(classifyTurnTrigger({ resume: true, text: 'Continue.' }), 'none');
  assert.equal(classifyTurnTrigger({ origin: 'bg-wake', text: 'Background shell finished' }), 'none');
  assert.equal(classifyTurnTrigger({ text: 'Watch w-abcdef12 complete: all 1 item done.' }, { isFirstInput: true }), 'none');

  // Exact anchored server headers
  assert.equal(classifyTurnTrigger({ text: 'Watch w-254ebc2d complete: all 2 items done.\n- agent rn-a: done' }), 'watch');
  assert.equal(classifyTurnTrigger({ text: 'Watch w-254ebc2d finished: 1 done, 1 FAIL (of 2).' }), 'watch');
  assert.equal(classifyTurnTrigger({ text: 'Watch w-84470978 stall: suite FAIL.' }), 'watch');
  assert.equal(classifyTurnTrigger({ text: "Verdicts (read in code from each agent's own `PASS|FAIL H/M/L <hash>` line; a FAIL anywhere wins; merge gate: vs verdict):\n- agent rn-a: PASS" }), 'watch');
  assert.equal(classifyTurnTrigger({ text: 'New team log event in lane usage: [done] merged' }), 'log-event');
  assert.equal(classifyTurnTrigger({ text: `${doneText('2026-11-25T13:00:00Z')} (restart-request rr-1, tip abc1234)` }), 'restart-done');
  assert.equal(classifyTurnTrigger({ text: SOFT_FLAG_NUDGE }), 'wrap-up');
  assert.equal(classifyTurnTrigger({ text: WRITE_HANDOFF_PROMPT }), 'wrap-up');
  assert.equal(classifyTurnTrigger({ text: BRAINSTORM_WARN_NUDGE }), 'wrap-up');
  assert.equal(classifyTurnTrigger({ text: kickText('usa-63') }), 'idle-kick');
  assert.equal(classifyTurnTrigger({ text: escalateText('usage', 'usa-63', 30) }), 'idle-kick');

  // Free-form prose mentioning trigger keywords -> none (never infer from prose)
  assert.equal(classifyTurnTrigger({ text: 'Please watch for the restart-done event and wrap up when idle-kick fires.' }), 'none');
  assert.equal(classifyTurnTrigger({ text: '/compact keep the plan' }), 'none');
  assert.equal(classifyTurnTrigger({ text: 'Here is a New team log event in lane usage: [done] foo' }), 'none');
  assert.equal(classifyTurnTrigger({ text: 'Let us wait for restart-done before running tests.' }), 'none');
  assert.equal(classifyTurnTrigger({ text: '' }), 'none');
  assert.equal(classifyTurnTrigger(null), 'none');
});

test('turnTriggers: tags all 7 trigger kinds, ignores mid-turn steerOnly overwrite, clears on error/invalid-ts', () => {
  const home = tmp();
  let t = T0;
  const nextTs = () => (t += 1000);
  let cost = 0;
  const done = (delta) => { cost = Math.round((cost + delta) * 1e6) / 1e6; return { ts: nextTs(), type: 'turn_done', costUsd: cost }; };

  writeAgent(home, 'rn-lead1', [
    { ts: nextTs(), type: 'created', provider: 'claude', model: 'claude-opus-5-5', meta: { lane: 'usage', role: 'lead', team: 'alpha' } },
    // 1. spawn prompt -> none ($0.10)
    { ts: nextTs(), type: 'input', text: 'You are Lead for lane usage.' },
    done(0.10),
    // 2. watch ping + mid-turn steerOnly wrap-up -> stays watch ($0.20)
    { ts: nextTs(), type: 'input', text: 'Watch w-1234abcd complete: all 1 item done.' },
    { ts: nextTs(), type: 'input', text: SOFT_FLAG_NUDGE, steerOnly: true },
    done(0.20),
    // 3. send from another agent -> send ($0.30)
    { ts: nextTs(), type: 'input', text: 'status update', senderId: 'rn-buddy1' },
    done(0.30),
    // 4. log-event -> log-event ($0.40)
    { ts: nextTs(), type: 'input', text: 'New team log event in lane usage: [done] unit merged' },
    done(0.40),
    // 5. restart-done -> restart-done ($0.50)
    { ts: nextTs(), type: 'input', text: doneText('2026-11-25T13:00:00Z') },
    done(0.50),
    // 6. wrap-up (non-steer) -> wrap-up ($0.60)
    { ts: nextTs(), type: 'input', text: WRITE_HANDOFF_PROMPT },
    done(0.60),
    // 7. idle-kick -> idle-kick ($0.70)
    { ts: nextTs(), type: 'input', text: kickText('usa-63') },
    done(0.70),
    // 8. failed turn with watch trigger must not leak into next turn with no input
    { ts: nextTs(), type: 'input', text: 'Watch w-deadbeef stall: suite FAIL.' },
    { ts: nextTs(), type: 'error', message: 'transient' },
    done(0.05), // no input -> none ($0.05)
    // 9. invalid-ts turn_done skipped and does not leak trigger
    { ts: nextTs(), type: 'input', text: 'New team log event in lane usage: [blocker] x' },
    { ts: 1e20, type: 'turn_done', costUsd: Math.round((cost + 0.99) * 1e6) / 1e6 },
  ]);

  const u = getUsage({ home, git: noGit });
  const tt = u.turnTriggers;
  assert.deepEqual(tt.triggers, TURN_TRIGGERS);
  assert.equal(tt.totals.none.turns, 2);
  assert.ok(Math.abs(tt.totals.none.costUsd - 0.15) < 1e-6);
  assert.equal(tt.totals.watch.turns, 1);
  assert.ok(Math.abs(tt.totals.watch.costUsd - 0.20) < 1e-6);
  assert.equal(tt.totals.send.turns, 1);
  assert.ok(Math.abs(tt.totals.send.costUsd - 0.30) < 1e-6);
  assert.equal(tt.totals['log-event'].turns, 1);
  assert.ok(Math.abs(tt.totals['log-event'].costUsd - 0.40) < 1e-6);
  assert.equal(tt.totals['restart-done'].turns, 1);
  assert.ok(Math.abs(tt.totals['restart-done'].costUsd - 0.50) < 1e-6);
  assert.equal(tt.totals['wrap-up'].turns, 1);
  assert.ok(Math.abs(tt.totals['wrap-up'].costUsd - 0.60) < 1e-6);
  assert.equal(tt.totals['idle-kick'].turns, 1);
  assert.ok(Math.abs(tt.totals['idle-kick'].costUsd - 0.70) < 1e-6);

  const leadRow = tt.byRole.find((r) => r.role === 'lead');
  assert.equal(leadRow.turns, 8);
  assert.ok(Math.abs(leadRow.costUsd - 2.85) < 1e-6);
  assert.equal(tt.byLaneRole.length, 1);
  assert.equal(tt.byLaneRole[0].teamId, 'alpha');
  assert.equal(tt.byLaneRole[0].lane, 'usage');
});

test('postHandoff & postHandoffCost: predecessor after handoff-successor, successor (vs.handoff-from), and respawnOf', () => {
  const home = tmp();

  // Predecessor lead: 2 turns BEFORE handoff-successor ($1.00), then meta patch, then 1 turn AFTER ($0.50)
  writeAgent(home, 'rn-pred', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'lead', team: 'alpha' } },
    { ts: T0 + 1000, type: 'input', text: 'Boot' },
    { ts: T0 + 2000, type: 'turn_done', costUsd: 0.40 },
    { ts: T0 + 3000, type: 'input', text: 'Watch w-11112222 complete: all 1 item done.' },
    { ts: T0 + 4000, type: 'turn_done', costUsd: 1.00 },
    { ts: T0 + 5000, type: 'meta', patch: { role: 'former-lead', labels: { 'handoff-successor': 'rn-succ' } } },
    { ts: T0 + 6000, type: 'input', text: 'late ping', senderId: 'rn-worker' },
    { ts: T0 + 7000, type: 'turn_done', costUsd: 1.50 },
  ]);

  // Successor lead: created with vs.handoff-from -> ALL turns postHandoff ($2.00)
  writeAgent(home, 'rn-succ', [
    { ts: T0 + 5500, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'lead', team: 'alpha', labels: { 'vs.handoff-from': 'rn-pred' } } },
    { ts: T0 + 6000, type: 'input', text: 'You are successor lead' },
    { ts: T0 + 7000, type: 'turn_done', costUsd: 0.80 },
    { ts: T0 + 8000, type: 'input', text: 'Watch w-33334444 complete: all 1 item done.' },
    { ts: T0 + 9000, type: 'turn_done', costUsd: 2.00 },
  ]);

  // Normal worker ($3.00 preHandoff) + respawned worker ($1.00 postHandoff)
  writeAgent(home, 'rn-w1', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'worker', team: 'alpha' } },
    { ts: T0 + 1000, type: 'input', text: 'Implement X' },
    { ts: T0 + 2000, type: 'turn_done', costUsd: 3.00 },
  ]);
  writeAgent(home, 'rn-w2', [
    { ts: T0 + 3000, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'worker', team: 'alpha', labels: { respawnOf: 'rn-w1' } } },
    { ts: T0 + 4000, type: 'input', text: 'Retry X' },
    { ts: T0 + 5000, type: 'turn_done', costUsd: 1.00 },
  ]);

  // Brainstorm (preHandoff only, $0.50)
  writeAgent(home, 'rn-b1', [
    { ts: T0, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role: 'brainstorm', team: 'alpha' } },
    { ts: T0 + 1000, type: 'input', text: 'hi', owner: true },
    { ts: T0 + 2000, type: 'turn_done', costUsd: 0.50 },
  ]);

  const u = getUsage({ home, git: noGit });
  const ph = u.postHandoffCost;

  const lead = ph.byRole.find((r) => r.role === 'lead');
  assert.equal(lead.preHandoff.turns, 2);
  assert.ok(Math.abs(lead.preHandoff.costUsd - 1.00) < 1e-6);
  assert.equal(lead.postHandoff.turns, 3); // 1 on predecessor after handoff-successor + 2 on successor
  assert.ok(Math.abs(lead.postHandoff.costUsd - 2.50) < 1e-6);
  assert.equal(lead.postHandoffShare, Math.round((2.50 / 3.50) * 1000) / 1000);

  const worker = ph.byRole.find((r) => r.role === 'worker');
  assert.equal(worker.preHandoff.turns, 1);
  assert.ok(Math.abs(worker.preHandoff.costUsd - 3.00) < 1e-6);
  assert.equal(worker.postHandoff.turns, 1);
  assert.ok(Math.abs(worker.postHandoff.costUsd - 1.00) < 1e-6);
  assert.equal(worker.postHandoffShare, 0.25);

  const buddy = ph.byRole.find((r) => r.role === 'brainstorm');
  assert.equal(buddy.preHandoff.turns, 1);
  assert.equal(buddy.postHandoff.turns, 0);
  assert.equal(buddy.postHandoffShare, 0);

  // Totals across all roles: pre = 4.50 (4 turns), post = 3.50 (4 turns)
  assert.equal(ph.totals.preHandoff.turns, 4);
  assert.ok(Math.abs(ph.totals.preHandoff.costUsd - 4.50) < 1e-6);
  assert.equal(ph.totals.postHandoff.turns, 4);
  assert.ok(Math.abs(ph.totals.postHandoff.costUsd - 3.50) < 1e-6);
  assert.equal(ph.totals.postHandoffShare, Math.round((3.50 / 8.00) * 1000) / 1000);

  // Trigger buckets also carry postHandoff breakdown
  assert.equal(u.turnTriggers.totals.watch.turns, 2);
  assert.equal(u.turnTriggers.totals.watch.postHandoffTurns, 1);
  assert.ok(Math.abs(u.turnTriggers.totals.watch.postHandoffCostUsd - 1.20) < 1e-6);
  assert.equal(u.turnTriggers.totals.send.postHandoffTurns, 1);
  assert.ok(Math.abs(u.turnTriggers.totals.send.postHandoffCostUsd - 0.50) < 1e-6);
});

test('clampLeadLongThreshold and ?leadLongThreshold=N query param on usage-export and usage', async () => {
  assert.equal(clampLeadLongThreshold(undefined), LEAD_LONG_TURN_MIN);
  assert.equal(clampLeadLongThreshold(''), LEAD_LONG_TURN_MIN);
  assert.equal(clampLeadLongThreshold('abc'), LEAD_LONG_TURN_MIN);
  assert.equal(clampLeadLongThreshold(NaN), LEAD_LONG_TURN_MIN);
  assert.equal(clampLeadLongThreshold(0), LEAD_LONG_THRESHOLD_MIN);
  assert.equal(clampLeadLongThreshold(-10), LEAD_LONG_THRESHOLD_MIN);
  assert.equal(clampLeadLongThreshold(99999), LEAD_LONG_THRESHOLD_MAX);
  assert.equal(clampLeadLongThreshold('50.9'), 50);

  const home = tmp();
  const makeRun = (role, n) => {
    const evs = [{ ts: T0, type: 'created', provider: 'claude', model: 'm', meta: { lane: 'usage', role, team: 'alpha' } }];
    for (let i = 1; i <= n; i++) {
      const ts = T0 + i * 1000;
      // Turns 1..50 repeat 'ls' (must NOT seed loop for threshold=50); turns 51..55 repeat 'ls' (51,52 seed; 53,54,55 loop)
      evs.push({ ts, type: 'tool', phase: 'call', id: `t${i}`, name: 'Bash', input: { command: i === 56 ? 'git commit -m x' : 'ls' } });
      evs.push({ ts, type: 'turn_done', costUsd: Math.round(i * 0.1 * 1e6) / 1e6 });
    }
    return evs;
  };
  writeAgent(home, 'rn-l1', makeRun('lead', 60));
  writeAgent(home, 'rn-l2', makeRun('former-lead', 60)); // usa-56 folds into lead -> included in pooled
  writeAgent(home, 'rn-b1', makeRun('former-brainstorm', 60)); // usa-56 folds into brainstorm -> in byLaneRole only

  clearUsageCache();
  // Default threshold (80): 60-turn runs have 0 long-tail turns
  const def = await callApi('/__vibesquad/providers/usage-export', home);
  assert.equal(def.status, 200);
  assert.equal(def.body.leadLongTurns.threshold, 80);
  const sum = (r) => r.productive.turns + r.waiting.turns + r.loop.turns + r.other.turns;
  assert.equal(sum(def.body.leadLongTurns.pooled), 0);

  // ?leadLongThreshold=50 on usage-export: each 60-turn run has 10 long-tail turns (51..60)
  const q50 = await callApi('/__vibesquad/providers/usage-export?leadLongThreshold=50', home);
  assert.equal(q50.status, 200);
  assert.equal(q50.body.leadLongTurns.threshold, 50);
  assert.equal(sum(q50.body.leadLongTurns.pooled), 20, 'lead + former-lead both in pooled');
  assert.equal(q50.body.leadLongTurns.pooled.productive.turns, 2); // turn 56 on both leads
  assert.equal(q50.body.leadLongTurns.pooled.other.turns, 4); // turns 51, 52 on both leads (head 1..50 did not seed!)
  assert.equal(q50.body.leadLongTurns.pooled.loop.turns, 14); // turns 53..55, 57..60 on both leads
  const buddyRow = q50.body.leadLongTurns.byLaneRole.find((r) => r.role === 'brainstorm');
  assert.equal(sum(buddyRow), 10, 'former-brainstorm folded into brainstorm in byLaneRole');

  // ?leadLongThreshold=50 also works on /usage and does not collide with cached default
  const u50 = await callApi('/__vibesquad/providers/usage?leadLongThreshold=50', home);
  assert.equal(u50.status, 200);
  assert.equal(u50.body.leadLongTurns.threshold, 50);
  assert.equal(sum(u50.body.leadLongTurns.pooled), 20);

  // Out-of-range query param is clamped
  const uClamp = await callApi('/__vibesquad/providers/usage-export?leadLongThreshold=0', home);
  assert.equal(uClamp.status, 200);
  assert.equal(uClamp.body.leadLongTurns.threshold, 1);

  // Direct getUsageAsync respects threshold in cache key
  const a55 = await getUsageAsync({ home, git: noGit, leadLongThreshold: 55 });
  assert.equal(a55.leadLongTurns.threshold, 55);
  assert.equal(sum(a55.leadLongTurns.pooled), 10);
});
