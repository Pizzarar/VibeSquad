// idea-868/869 fix round 2 (Tier A Review-Gemini rn-b6997babadc1, FAIL 1/1/0 58ef09be): a runner restart at each point of an
// agent's life (queued, starting, running/open turn, parked, idle) x each kind of input (a plain input, an input that must be a
// turn of its own, a /compact). Every input is delivered exactly once, a slash command always as a turn's whole text, and
// nothing is left in the fold's pending to resurrect on a later queued restart (runner/fold-index.mjs INVARIANT).
import "./helpers/clean-env.mjs";
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner, CONTINUE_PROMPT } from '../runner/runner.mjs';
import { isTurnProgressEvent } from '../server/backend/runner-backend.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'vs-owed-matrix-')); dirs.push(d); return d; };

// Records every text each process was handed (steers included). lazyRun: a send leaves the turn in `starting` (no `running`).
function recAdapter({ lazyRun = false } = {}) {
  const started = [];
  const adapter = {
    canPark: true,
    start({ id, emit, onExit }) {
      const rec = { id, emit, onExit, texts: [], killed: false, open: false };
      started.push(rec);
      return { send(text) { rec.texts.push(text); rec.open = true; if (!lazyRun) emit('status', { status: 'running' }); }, cancel() {}, kill() { rec.killed = true; } };
    },
  };
  adapter.started = started;
  adapter.textsOf = (id) => started.filter((r) => r.id === id).flatMap((r) => r.texts);
  adapter.procOf = (id) => started.filter((r) => r.id === id && !r.killed).at(-1);
  return adapter;
}

const boot = (dir, adapter, opts = {}) => new Runner({ dir, adapters: { claude: adapter }, turnCaps: { claude: 1 }, parkGraceMs: 60_000, maxLive: 16, ...opts });
const mk = (runner, prompt) => runner.create({ provider: 'claude', cwd: os.tmpdir(), prompt });
const idle = (rec) => { rec.open = false; rec.emit('status', { status: 'idle' }); };
// Ends every open turn (and the turns the queue starts behind them) until nothing is open.
const drive = (adapter) => { for (let k = 0; k < 50; k++) { const r = adapter.started.find((x) => !x.killed && x.open); if (!r) return; idle(r); } assert.fail('drive did not settle'); };
// What the restart script does after a runner restart: the boot replays queued inputs, then every lost agent is resumed.
const restart = (dir, adapter, opts) => { const r = boot(dir, adapter, opts); r.recoverQueued(); return r; };
const parts = (texts) => texts.flatMap((t) => t.split('\n\n'));
const count = (texts, s) => parts(texts).filter((p) => p === s).length;
const ownPending = (runner, id) => runner._fold(id).pending.filter((p) => p.own === true);

// Puts agent `a` at `point` with `kind` of input in flight on a fresh runner, then shuts it down keepResumable (restart
// script). Returns { dir, a, adapter1, inputs }: inputs are the texts that must each be delivered exactly once.
function arrange(point, kind) {
  const dir = tmp();
  const adapter1 = recAdapter({ lazyRun: point === 'starting' });
  const runner = boot(dir, adapter1, { turnCaps: { claude: point === 'running' || point === 'starting' ? 2 : 1 } });
  const a = mk(runner, 'hi');
  const ra = adapter1.procOf(a);
  ra.emit('session', { sessionId: 'S-a' });
  idle(ra);
  const inputs = [];
  const send = (text, queued) => { inputs.push(text); const r = runner.send(a, text); if (queued !== undefined) assert.equal(r.queued, queued, `${point}/${kind}: send ${text}`); };
  if (point === 'queued' || point === 'parked') {
    const b = mk(runner, 'b'); // holds the single slot
    assert.ok(adapter1.procOf(b));
    if (kind === 'plain') send('plain:1', true);
    if (kind === 'own') { send('/compact', true); send('own:1', true); }
    if (kind === 'compact') send('/compact', true);
    if (point === 'parked') runner.park(a); // what _makeRoom does to free a live slot (idea-868: a queued park)
  } else if (point === 'running' || point === 'starting') {
    if (point === 'starting') runner.park(a); // the next send resumes it: `starting`, and the lazy adapter never says running
    if (kind === 'plain') { send('work:1', false); send('plain:1', false); } // a steer into the open turn
    if (kind === 'own') { send('/compact', false); send('own:1', true); } // waits behind the open /compact turn
    if (kind === 'compact') { send('work:1', false); send('/compact', true); } // waits behind the open plain turn
    const last = runner.timeline(a).filter((e) => e.type === 'status').at(-1).status;
    assert.equal(last, point, `${point}/${kind}: the log ends ${point}`);
  } else if (point === 'idle') {
    const b = mk(runner, 'b');
    idle(adapter1.procOf(b)); // the slot is free
    if (kind === 'plain') { send('plain:1', false); idle(adapter1.procOf(a)); }
    if (kind === 'compact') { send('/compact', false); idle(adapter1.procOf(a)); }
    if (kind === 'own') { // the /compact turn ends while its follow-up waits behind b's next turn
      send('/compact', false);
      assert.equal(runner.send(b, 'b2').queued, true);
      send('own:1', true);
      idle(adapter1.procOf(a));
      assert.equal(runner.status(a).status, 'queued');
    }
  }
  runner.shutdown({ keepResumable: true });
  return { dir, a, adapter1, inputs };
}

for (const point of ['queued', 'starting', 'running', 'parked', 'idle']) {
  for (const kind of ['plain', 'own', 'compact']) {
    test(`restart matrix: ${point} x ${kind} input is delivered exactly once and never resurrects`, () => {
      const { dir, a, adapter1, inputs } = arrange(point, kind);
      const adapter2 = recAdapter();
      const runner2 = restart(dir, adapter2);
      assert.equal(runner2.resume(a), true);
      drive(adapter2);
      const all = [...adapter1.textsOf(a), ...adapter2.textsOf(a)];
      for (const s of inputs) assert.equal(count(all, s), 1, `${point}/${kind}: "${s}" delivered once (got ${JSON.stringify(all)})`);
      if (inputs.includes('/compact')) assert.equal(all.filter((t) => t === '/compact').length, 1, `${point}/${kind}: /compact is a whole turn's text`);
      const cut = point === 'running' || point === 'starting';
      assert.equal(count(adapter2.textsOf(a), CONTINUE_PROMPT), cut ? 1 : 0, `${point}/${kind}: a cut turn continues, nothing else does`);
      assert.deepEqual(runner2._fold(a).pending, [], `${point}/${kind}: nothing left owed`);
      runner2.shutdown({ keepResumable: true });

      // A later restart replays nothing, and a later queued restart replays only what was queued then (no resurrection).
      const adapter3 = recAdapter();
      const runner3 = restart(dir, adapter3);
      runner3.resume(a);
      drive(adapter3);
      assert.deepEqual(adapter3.textsOf(a), [], `${point}/${kind}: a second restart delivers nothing`);
      const c = mk(runner3, 'c'); // holds the slot
      assert.equal(runner3.send(a, 'late').queued, true);
      assert.ok(adapter3.procOf(c));
      runner3.shutdown({ keepResumable: true });
      const adapter4 = recAdapter();
      const runner4 = boot(dir, adapter4);
      assert.deepEqual(runner4.recoverQueued(), [a]);
      assert.deepEqual(adapter4.textsOf(a), ['late'], `${point}/${kind}: only the input queued then`);
      runner4.shutdown();
    });
  }
}

test('the reviewer repro: a wake queued behind a running /compact survives a keepResumable restart and runs once after the continue', () => {
  const { dir, a, adapter1 } = arrange('running', 'own');
  assert.deepEqual(adapter1.textsOf(a), ['hi', '/compact']);
  const adapter2 = recAdapter();
  const runner2 = boot(dir, adapter2);
  assert.deepEqual(runner2.recoverQueued(), [], 'the log ends running: a cut turn, not a queued one');
  assert.deepEqual(ownPending(runner2, a).map((p) => p.text), ['own:1'], 'still owed');
  runner2.resume(a);
  const r = adapter2.procOf(a);
  assert.deepEqual(r.texts, [CONTINUE_PROMPT], 'the cut turn continues first');
  idle(r);
  assert.deepEqual(r.texts, [CONTINUE_PROMPT, 'own:1'], 'then the owed input, as a turn of its own');
  idle(r);
  const consumed = runner2.timeline(a).filter((e) => e.type === 'inputs-consumed');
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0].how, undefined, 'delivered, not dropped');
  runner2.shutdown();
});

test('a restart while the continue sits queued (cap held) still delivers the owed input once', () => {
  const { dir, a, adapter1 } = arrange('running', 'own');
  const adapter2 = recAdapter();
  const runner2 = restart(dir, adapter2);
  const d = mk(runner2, 'd'); // takes the single slot
  runner2.resume(a);
  assert.equal(runner2.status(a).status, 'queued', 'the continue waits for the slot');
  runner2.shutdown({ keepResumable: true });
  const adapter3 = recAdapter();
  const runner3 = boot(dir, adapter3);
  assert.deepEqual(runner3.recoverQueued(), [a]);
  drive(adapter3);
  const all = [...adapter1.textsOf(a), ...adapter2.textsOf(a), ...adapter3.textsOf(a)];
  assert.equal(count(all, 'own:1'), 1, JSON.stringify(all));
  assert.equal(count(all, CONTINUE_PROMPT), 1, JSON.stringify(all));
  assert.deepEqual(runner3._fold(a).pending, []);
  assert.ok(d);
  runner3.shutdown();
});

test('a send to the lost agent (no resume) carries the owed input ahead of its text, once', () => {
  const { dir, a } = arrange('running', 'own');
  const adapter2 = recAdapter();
  const runner2 = restart(dir, adapter2);
  runner2.send(a, 'next');
  assert.deepEqual(adapter2.textsOf(a), ['own:1\n\nnext']);
  drive(adapter2);
  assert.deepEqual(runner2._fold(a).pending, []);
  runner2.shutdown();
});

test('an owed /compact stays a turn of its own when a send carries it', () => {
  const { dir, a } = arrange('running', 'compact');
  const adapter2 = recAdapter();
  const runner2 = restart(dir, adapter2);
  runner2.send(a, 'next');
  drive(adapter2);
  assert.deepEqual(adapter2.textsOf(a), ['/compact', 'next']);
  assert.deepEqual(runner2._fold(a).pending, []);
  runner2.shutdown();
});

test('owed inputs the agent may no longer act on (stale) are dropped with a marker, never replayed later', async () => {
  const { dir, a } = arrange('running', 'own');
  await new Promise((r) => setTimeout(r, 20));
  const adapter2 = recAdapter();
  const runner2 = restart(dir, adapter2, { queueMaxAgeMs: 5 });
  runner2.resume(a);
  drive(adapter2);
  assert.deepEqual(adapter2.textsOf(a), [], 'a stale cut turn is not continued, and neither is its owed input');
  assert.deepEqual(runner2.timeline(a).filter((e) => e.type === 'inputs-consumed').map((e) => e.how), ['dropped']);
  assert.deepEqual(runner2._fold(a).pending, []);
  runner2.shutdown({ keepResumable: true });
  const adapter3 = recAdapter();
  const runner3 = restart(dir, adapter3);
  runner3.resume(a);
  mk(runner3, 'c');
  assert.equal(runner3.send(a, 'late').queued, true);
  runner3.shutdown({ keepResumable: true });
  const adapter4 = recAdapter();
  const runner4 = boot(dir, adapter4);
  assert.deepEqual(runner4.recoverQueued(), [a]);
  assert.deepEqual(adapter4.textsOf(a), ['late']);
  runner4.shutdown();
});

// Round 3 F1 (rn-863584795900): archive on the lost agent after the restart drops what it was owed; unarchive brings back none of it.
for (const via of ['send', 'resume']) {
  test(`restart -> archive -> unarchive -> ${via}: only the fresh input is delivered, the owed one never resurrects`, () => {
    const { dir, a } = arrange('running', 'own');
    const adapter2 = recAdapter();
    const runner2 = restart(dir, adapter2);
    assert.deepEqual(ownPending(runner2, a).map((p) => p.text), ['own:1'], 'owed before the archive');
    runner2.archive(a);
    assert.deepEqual(runner2._fold(a).pending, [], 'archive drops it');
    assert.deepEqual(runner2.timeline(a).filter((e) => e.type === 'inputs-consumed').map((e) => e.how), ['dropped']);
    runner2.unarchive(a);
    if (via === 'send') {
      runner2.send(a, 'fresh-after-unarchive');
      assert.deepEqual(adapter2.textsOf(a), ['fresh-after-unarchive']);
    } else {
      runner2.resume(a);
      drive(adapter2);
      assert.ok(!adapter2.textsOf(a).includes('own:1'), JSON.stringify(adapter2.textsOf(a)));
      runner2.send(a, 'fresh-after-unarchive');
      assert.deepEqual(adapter2.textsOf(a).filter((t) => t !== CONTINUE_PROMPT), ['fresh-after-unarchive']);
    }
    drive(adapter2);
    assert.deepEqual(runner2._fold(a).pending, []);
    runner2.shutdown({ keepResumable: true });
    const adapter3 = recAdapter();
    const runner3 = restart(dir, adapter3);
    runner3.resume(a);
    drive(adapter3);
    assert.deepEqual(adapter3.textsOf(a), [], 'a later restart replays nothing');
    runner3.shutdown();
  });
}

test('inputs-consumed / inputs-held are queue bookkeeping, never turn progress (server NON_PROGRESS_LOG_EVENTS)', () => {
  for (const type of ['inputs-consumed', 'inputs-held']) assert.equal(isTurnProgressEvent({ type, seq: 1 }), false, type);
  assert.equal(isTurnProgressEvent({ type: 'text', seq: 1 }), true);
});
