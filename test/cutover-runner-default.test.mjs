// Cutover behaviour under the shipping default (every lane on the runner), not the suite's VS_DEFAULT_BACKEND=paseo rollback.
// Each test passes `env`/`lanes` explicitly, so none of them depends on the preload.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PaseoBackend } from '../server/backend/paseo-backend.mjs';
import { RoutingBackend, paseoExpected, runnerLanes } from '../server/backend/lane-routing.mjs';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'vs-cut-'));
const noFile = () => path.join(tmp(), 'missing.json');

function paseoFake() {
  const calls = [];
  const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return Promise.resolve(typeof ret === 'function' ? ret(...args) : ret); };
  return {
    calls,
    connect: rec('connect'),
    close: rec('close'),
    createAgent: rec('createAgent', { id: 'p-uuid', labels: {} }),
    fetchAgents: rec('fetchAgents', { entries: [{ agent: { id: 'p-1' } }] }),
    cancelAgent: rec('cancelAgent'),
    sendAgentPrompt: rec('sendAgentPrompt'),
  };
}

function runnerFake() {
  const calls = [];
  const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return Promise.resolve(ret); };
  return {
    calls,
    createAgent: rec('createAgent', { id: 'rn-new' }),
    fetchAgents: rec('fetchAgents', { entries: [{ agent: { id: 'rn-1' } }] }),
    cancelAgent: rec('cancelAgent'),
  };
}

test("owner setup: startPaseoWithVibeSquad=true, Paseo down: runner lists and creates keep working, only Paseo-scoped work is refused", async () => {
  const home = tmp();
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ startPaseoWithVibeSquad: true }));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = home;
  try {
    const lanes = () => runnerLanes({ env: { VS_PASEO_LANES: 'legacy' }, teamsFile: noFile() });
    assert.equal(paseoExpected({ lanes }), true, 'Paseo is wanted (setting on + a pinned lane)');
    const paseo = paseoFake();
    const runner = runnerFake();
    const b = new RoutingBackend(new PaseoBackend(paseo), runner, { lanes, paseoAlive: async () => false });
    await b.connect();
    assert.equal(b.paseoUnavailable, true);
    assert.equal(paseo.calls.some((c) => c[0] === 'connect'), false, 'no connect attempt against a closed port');

    // Lists: runner agents come back, flagged, never a rejection.
    const list = await b.fetchAgents({});
    assert.deepEqual(list.entries.map((e) => e.agent.id), ['rn-1']);
    assert.equal(list.paseoUnavailable, true);
    assert.equal(JSON.stringify(list).includes('paseoUnavailable'), false, 'the marker is not serialised');

    // Creates: default lane and no lane go to the runner; a Paseo-pinned lane is refused clearly.
    assert.equal((await b.createAgent({ labels: { lane: 'bug-chaser' }, config: {} })).id, 'rn-new');
    assert.equal((await b.createAgent({ labels: {}, config: {} })).id, 'rn-new');
    await assert.rejects(b.createAgent({ labels: { lane: 'legacy' }, config: {} }), { code: 'PASEO_UNAVAILABLE' });

    // Per-id: runner ids work, Paseo ids are refused.
    await b.cancelAgent('rn-1');
    await assert.rejects(b.cancelAgent('11111111-uuid'), { code: 'PASEO_UNAVAILABLE' });
    assert.equal(paseo.calls.some((c) => c[0] === 'createAgent' || c[0] === 'cancelAgent'), false);
  } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prev;
  }
});

test('handoff-topic and park-topic keep the card and its Paseo topic agent when Paseo is down', async () => {
  const { handoffTopicBrainstorm, parkTopicBrainstorm, readInboxCards, writeInboxCards } = await import('../server/inbox.mjs');
  const baseHome = tmp();
  mkdirSync(baseHome, { recursive: true });
  const card = { id: 'card1', title: 'T', status: 'parked', laneId: 'vibesquad', topicAgentId: '11111111-2222-3333-4444-555555555555', topicTitle: 'T', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
  writeInboxCards([card], baseHome);
  const prev = { b: process.env.VS_DEFAULT_BACKEND, d: process.env.PASEO_DAEMON };
  process.env.VS_DEFAULT_BACKEND = 'runner'; // the shipping default: getBackend wraps the real client in a RoutingBackend
  process.env.PASEO_DAEMON = '127.0.0.1:9'; // nothing listens
  try {
    const { resetPaseoProbe } = await import('../server/backend/lane-routing.mjs');
    resetPaseoProbe();
    await assert.rejects(handoffTopicBrainstorm({ cardId: 'card1', baseHome }, process.cwd()), { code: 'PASEO_UNAVAILABLE' });
    resetPaseoProbe();
    await assert.rejects(parkTopicBrainstorm({ cardId: 'card1', baseHome }, process.cwd()), { code: 'PASEO_UNAVAILABLE' });
    const after = readInboxCards(baseHome).find((c) => c.id === 'card1');
    assert.equal(after.topicAgentId, card.topicAgentId, 'the card still points at its live Paseo topic agent');
    assert.equal(after.status, 'parked');
  } finally {
    if (prev.b === undefined) delete process.env.VS_DEFAULT_BACKEND;
    else process.env.VS_DEFAULT_BACKEND = prev.b;
    if (prev.d === undefined) delete process.env.PASEO_DAEMON;
    else process.env.PASEO_DAEMON = prev.d;
  }
});

test('push watcher: attach, single-flight recheck and detach (disposers run, client closed) as Paseo comes and goes', async () => {
  const { startPushWatcher, stopPushWatcher } = await import('../server/push.mjs');
  let wanted = false;
  const made = [];
  const createClient = () => {
    const c = { subs: 0, offs: 0, closed: 0 };
    c.subscribe = () => { c.subs += 1; return () => { c.offs += 1; }; };
    c.subscribeConnectionStatus = () => { c.subs += 1; return () => { c.offs += 1; }; };
    c.connect = async () => {};
    c.close = async () => { c.closed += 1; };
    c.fetchAgents = async () => ({ entries: [] });
    made.push(c);
    return c;
  };
  const watcher = startPushWatcher(process.cwd(), { runner: null, paseo: () => wanted, createClient });
  try {
    await watcher.recheck();
    assert.equal(watcher.paseoAttached, false);
    assert.equal(made.length, 0, 'no DaemonClient while Paseo is not wanted');

    wanted = true; // setting flipped / lane pinned / daemon started
    await Promise.all([watcher.recheck(), watcher.recheck(), watcher.recheck()]);
    assert.equal(watcher.paseoAttached, true);
    assert.equal(made.length, 1, 'concurrent rechecks attach exactly once');
    assert.equal(made[0].subs, 2);

    wanted = false; // Paseo stopped and nothing wants it any more
    await watcher.recheck();
    assert.equal(watcher.paseoAttached, false);
    assert.equal(made[0].offs, 2, 'both subscriptions were disposed');
    assert.equal(made[0].closed, 1);

    wanted = true; // and it can come back
    await watcher.recheck();
    assert.equal(made.length, 2);
  } finally {
    await stopPushWatcher();
  }
});

test('the browser Paseo lifecycle pauses instead of disposing the DaemonClient (source guard)', () => {
  const src = readFileSync(new URL('../src/paseo.ts', import.meta.url), 'utf8');
  const park = src.slice(src.indexOf('function parkPaseo'), src.indexOf('async function connect'));
  assert.match(park, /setReconnectEnabled\?\.\(false\)/);
  assert.doesNotMatch(park, /daemonClient\.close\(/, 'close() is terminal: the client could never reconnect');
  assert.match(src, /setReconnectEnabled\?\.\(true\)/);
  assert.match(src, /dropPaseoAgents\(\)/);
  assert.match(src, /code: "PASEO_UNAVAILABLE"/);
});
