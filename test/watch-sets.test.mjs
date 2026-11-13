// Watch sets (docs/PLAN_COMPLETION_DIGEST_RELAY.md W1): registry, state machine, one-shot fire, persistence across a restart,
// stall pings, retired-owner reroute, and the hold-back of watched items from the normal per-event wakes.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addWatch, cancelWatch, createWatchEngine, listWatches, watchesPath, DIGEST_MERGE_MAX, SUITE_LOCK_FILE, SUITE_RESULT_FILE } from "../server/watch-sets.mjs";

const T0 = Date.parse("2026-11-10T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "vs-watch-"));
  const home = join(dir, "home");
  const tmp = join(dir, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  return { dir, home, tmp, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * An engine on a fake clock that records every delivery. Like the plugin's flushWake, the fake marks each ping attempted
 * (`attempt: false` = the server died before the send: the ping stays unattempted and is re-offered).
 */
function engineFor(sb, { clock, attempt = true, ...opts } = {}) {
  const delivered = [];
  const c = clock ?? { t: T0 };
  const engine = createWatchEngine({
    home: sb.home,
    tmpdir: sb.tmp,
    now: () => c.t,
    alive: (pid) => pid === 111,
    deliver: (d) => {
      delivered.push(d);
      if (attempt) engine.markAttempted([d.key], d.owner);
    },
    retryMs: 0,
    ...opts,
  });
  engine.start();
  return { engine, delivered, clock: c };
}

const agentEv = (id, status, extra = {}) => ({ kind: "status", agentId: id, agent: { id, status, labels: { role: "worker" }, ...extra } });
const doneEntry = (agent, at, text = "PASS: shipped", refs = []) => ({ ts: iso(at), agent, lane: "vibesquad", type: "done", text, refs });

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("addWatch / listWatches / cancelWatch: persisted to <home>/watches.json, validated, filterable", () => {
  const sb = sandbox();
  try {
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }, { kind: "agent", ref: "w-1" }, { kind: "suite" }] }, { home: sb.home, now: T0 });
    assert.match(id, /^w-[0-9a-f]{8}$/);
    const file = watchesPath({ home: sb.home });
    assert.equal(file, join(sb.home, "watches.json"));
    const doc = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(doc.sets.length, 1);
    assert.equal(doc.sets[0].stallMin, 15, "stallMin defaults to 15");
    assert.deepEqual(doc.sets[0].items.map((i) => `${i.kind}:${i.ref}:${i.state}`), ["agent:w-1:waiting", "suite::waiting"], "duplicate items collapse");
    addWatch({ owner: "lead-2", team: "other", lane: "x", items: [{ kind: "restart" }], stallMin: 5 }, { home: sb.home, now: T0 });
    assert.equal(listWatches({ owner: "lead-1" }, { home: sb.home }).length, 1);
    assert.equal(listWatches({ team: "other" }, { home: sb.home })[0].status, "armed");
    assert.equal(listWatches({}, { home: sb.home }).length, 2);

    assert.throws(() => addWatch({ owner: "", items: [{ kind: "suite" }] }, { home: sb.home }), /owner/);
    assert.throws(() => addWatch({ owner: "a", items: [] }, { home: sb.home }), /item/);
    assert.throws(() => addWatch({ owner: "a", items: [{ kind: "agent" }] }, { home: sb.home }), /ref/);
    assert.throws(() => addWatch({ owner: "a", items: [{ kind: "bogus", ref: "x" }] }, { home: sb.home }), /kind/);
    assert.throws(() => addWatch({ owner: "a", items: [{ kind: "suite" }], stallMin: 0 }, { home: sb.home }), /stallMin/);

    assert.deepEqual(cancelWatch(id, "lead-1", { home: sb.home, now: T0 + 1 }), { ok: true, id });
    assert.equal(listWatches({ owner: "lead-1" }, { home: sb.home }).length, 0, "cancelled hidden by default");
    const after = listWatches({ owner: "lead-1", all: true }, { home: sb.home })[0];
    assert.equal(after.status, "cancelled");
    assert.equal(after.cancelledBy, "lead-1");
    assert.equal(cancelWatch("w-nope", "x", { home: sb.home }).ok, false);
    assert.equal(existsSync(`${file}.lock`), false, "the lock is released");
  } finally {
    sb.cleanup();
  }
});

test("a corrupt registry is never overwritten", () => {
  const sb = sandbox();
  try {
    writeFileSync(watchesPath({ home: sb.home }), "{not json", "utf8");
    assert.throws(() => addWatch({ owner: "a", items: [{ kind: "suite" }] }, { home: sb.home }));
    assert.equal(readFileSync(watchesPath({ home: sb.home }), "utf8"), "{not json");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// State machine + one-shot fire
// ---------------------------------------------------------------------------

test("completion: exactly one ping when every item is done (idle AND a report after registration); never again", async () => {
  const sb = sandbox();
  try {
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }, { kind: "agent", ref: "w-2" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = engineFor(sb);
    engine.onRunnerEvent(agentEv("w-1", "running"));
    engine.onRunnerEvent(agentEv("w-2", "running"));
    // A report from before registration never counts.
    engine.onLogEntry("vibesquad", doneEntry("w-1", T0 - 1000, "PASS: old"));
    // w-1 reports mid-turn: not done until it is idle.
    engine.onLogEntry("vibesquad", doneEntry("w-1", T0 + 1000, "PASS: w1 shipped"));
    clock.t = T0 + 2000;
    await engine.tick();
    assert.equal(delivered.length, 0, "w-1 is still running");
    engine.onRunnerEvent(agentEv("w-1", "idle"));
    await engine.tick();
    assert.equal(engine.get(id).items[0].state, "done");
    assert.equal(delivered.length, 0, "w-2 still pending: no ping");
    engine.onRunnerEvent(agentEv("w-2", "idle"));
    // The digest's verdict (author is a digest agent, refs the worker) is w-2's report.
    engine.onRunnerEvent({ kind: "agent", agent: { id: "dg-2", status: "idle", labels: { role: "worker", digestFor: "w-2" } } });
    engine.onLogEntry("vibesquad", doneEntry("dg-2", T0 + 3000, "PASS: w2 verified", ["w-2"]));
    clock.t = T0 + 4000;
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].key, `${id}#done`);
    assert.match(delivered[0].text, /complete: all 2 items done/);
    assert.match(delivered[0].text, /w1 shipped/);
    assert.match(delivered[0].text, /w2 verified/);
    const set = engine.get(id);
    assert.ok(set.firedAt, "firedAt persisted");
    assert.equal(set.pings.length, 1);
    // More events and ticks: a fired set never re-fires.
    engine.onLogEntry("vibesquad", doneEntry("w-1", T0 + 5000, "PASS: again"));
    for (let i = 0; i < 3; i++) {
      clock.t += 20 * MIN;
      await engine.tick();
    }
    assert.equal(delivered.length, 1);
    assert.equal(engine.get(id).pings.length, 1);
  } finally {
    sb.cleanup();
  }
});

test("a lead's own done that refs a worker is not the worker's report", async () => {
  const sb = sandbox();
  try {
    const { id } = addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: T0 });
    const { engine, delivered } = engineFor(sb);
    engine.onRunnerEvent(agentEv("w-1", "idle"));
    engine.onRunnerEvent({ kind: "agent", agent: { id: "lead-2", status: "idle", labels: { role: "lead" } } });
    assert.deepEqual(engine.onLogEntry("vibesquad", doneEntry("lead-2", T0 + 1000, "PASS: merged w-1", ["w-1"])), [id], "taken (held)…");
    await engine.tick();
    assert.equal(engine.get(id).items[0].state, "waiting", "…but it does not complete the item");
    assert.equal(delivered.length, 0);
  } finally {
    sb.cleanup();
  }
});

test("exactly once across a restart: firedAt is persisted before the send; an unattempted ping is redelivered (not re-fired), an attempted one never again", async () => {
  const sb = sandbox();
  try {
    const { id } = addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: T0 });
    const a = engineFor(sb, { attempt: false });
    a.engine.onRunnerEvent(agentEv("w-1", "idle"));
    a.engine.onLogEntry("vibesquad", doneEntry("w-1", T0 + 1000));
    a.clock.t = T0 + 2000;
    await a.engine.tick();
    assert.equal(a.delivered.length, 1);
    const firedAt = JSON.parse(readFileSync(watchesPath({ home: sb.home }), "utf8")).sets[0].firedAt;
    assert.ok(firedAt, "fire decision is on disk before anything was sent");

    // "Crash" before the send: a fresh engine (server restart) redelivers the SAME ping once, and does not fire a second one.
    const b = engineFor(sb, { clock: { t: T0 + 10 * MIN }, attempt: false });
    b.engine.onRunnerEvent(agentEv("w-1", "idle"));
    await b.engine.tick();
    assert.equal(b.delivered.length, 1);
    assert.equal(b.delivered[0].key, a.delivered[0].key);
    assert.equal(b.engine.get(id).pings.length, 1, "no second fire");
    assert.equal(b.engine.get(id).firedAt, firedAt);
    b.engine.markAttempted([b.delivered[0].key], "lead-1");
    b.engine.markDelivered([b.delivered[0].key], "lead-1");

    // After the attempt: restart again, nothing is offered, ever.
    const c = engineFor(sb, { clock: { t: T0 + 60 * MIN } });
    c.engine.onRunnerEvent(agentEv("w-1", "closed", { lost: true }));
    await c.engine.tick();
    await c.engine.tick();
    assert.equal(c.delivered.length, 0);
    const ping = c.engine.get(id).pings[0];
    assert.ok(ping.attemptedAt && ping.deliveredAt);
    assert.equal(ping.to, "lead-1");
  } finally {
    sb.cleanup();
  }
});

test("concurrent ticks fire once", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: T0 });
    const { engine, delivered } = engineFor(sb);
    engine.onRunnerEvent(agentEv("w-1", "idle"));
    engine.onLogEntry("vibesquad", doneEntry("w-1", T0 + 1));
    await Promise.all([engine.tick(), engine.tick(), engine.tick()]);
    await engine.tick();
    assert.equal(delivered.length, 1);
  } finally {
    sb.cleanup();
  }
});

test("stall: one ping per stalled item (all in one message), the set stays armed, and completes when the rest finishes", async () => {
  const sb = sandbox();
  try {
    const { id } = addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }, { kind: "agent", ref: "w-2" }, { kind: "agent", ref: "w-3" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = engineFor(sb);
    engine.onRunnerEvent(agentEv("w-1", "running"));
    engine.onRunnerEvent(agentEv("w-2", "running"));
    engine.onRunnerEvent(agentEv("w-3", "running"));
    // A restart cuts w-1 and w-2: both lost at once -> ONE stall ping naming both.
    engine.onRunnerEvent({ kind: "roster", agents: [{ id: "w-1", status: "closed", lost: true, resumable: true }, { id: "w-2", status: "closed", lost: true, resumable: true }] });
    clock.t = T0 + 1000;
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].pingKey, "stall-1");
    assert.match(delivered[0].text, /agent w-1 stalled \(lost\), agent w-2 stalled \(lost\)/);
    assert.match(delivered[0].text, /agent w-3: running/);
    let set = engine.get(id);
    assert.equal(set.firedAt, undefined, "still armed");
    // Still lost on later ticks: no second stall ping for the same items.
    clock.t += 5 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 1);
    // w-1 is resumed, then stalls again (error): still no second ping for w-1 (once per item).
    engine.onRunnerEvent(agentEv("w-1", "running"));
    await engine.tick();
    engine.onRunnerEvent(agentEv("w-1", "error"));
    await engine.tick();
    assert.equal(delivered.length, 1);
    // w-3 finishes: every item is settled and something finished since the stall ping -> the one completion ping.
    engine.onRunnerEvent(agentEv("w-3", "idle"));
    engine.onLogEntry("vibesquad", doneEntry("w-3", clock.t + 1, "PASS: w3"));
    clock.t += 1000;
    await engine.tick();
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1].pingKey, "done");
    assert.match(delivered[1].text, /finished: 1 done, 2 still stalled \(of 3\)/);
    set = engine.get(id);
    assert.ok(set.firedAt);
  } finally {
    sb.cleanup();
  }
});

test("a missed event does not hang the set: a silent running agent, an idle one with no report, and a never-seen one stall after stallMin", async () => {
  const sb = sandbox();
  try {
    const { id } = addWatch({ owner: "lead-1", stallMin: 15, items: [{ kind: "agent", ref: "w-run" }, { kind: "agent", ref: "w-idle" }, { kind: "agent", ref: "w-ghost" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = engineFor(sb);
    engine.onRunnerEvent(agentEv("w-run", "running"));
    engine.onRunnerEvent(agentEv("w-idle", "idle"));
    await engine.tick();
    clock.t = T0 + 14 * MIN;
    engine.onRunnerEvent({ kind: "timeline", agentId: "w-run" }); // activity keeps w-run's clock fresh
    await engine.tick();
    assert.equal(delivered.length, 0, "inside stallMin");
    clock.t = T0 + 16 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].text, /w-idle stalled \(idle-no-report\)/);
    assert.match(delivered[0].text, /w-ghost stalled \(no-events\)/);
    assert.doesNotMatch(delivered[0].text, /w-run stalled/);
    clock.t = T0 + 30 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 2);
    assert.match(delivered[1].text, /w-run stalled \(silent\)/);
    assert.equal(engine.get(id).firedAt, undefined);
  } finally {
    sb.cleanup();
  }
});

test("a missed status event is repaired by the periodic re-read (getAgent)", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: T0 });
    const status = { "w-1": "running" };
    const { engine, delivered, clock } = engineFor(sb, { getAgent: async (id) => ({ id, status: status[id], labels: { role: "worker" } }) });
    engine.onLogEntry("vibesquad", doneEntry("w-1", T0 + 1000));
    await engine.tick(); // seeded from getAgent: running
    assert.equal(delivered.length, 0);
    status["w-1"] = "idle"; // the idle event never arrives
    clock.t = T0 + 2 * MIN; // past the re-read interval
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].pingKey, "done");
  } finally {
    sb.cleanup();
  }
});

test("blocker entry and permission wait stall the item; a blocker after the stall ping is not taken over", async () => {
  const sb = sandbox();
  try {
    const { id } = addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }, { kind: "agent", ref: "w-2" }] }, { home: sb.home, now: T0 });
    const { engine, delivered } = engineFor(sb);
    engine.onRunnerEvent(agentEv("w-1", "running"));
    engine.onRunnerEvent(agentEv("w-2", "running", { requiresAttention: true, pendingPermissions: [{ id: "p1", toolName: "Bash" }] }));
    const blk = { ts: iso(T0 + 1000), agent: "w-1", lane: "vibesquad", type: "blocker", text: "need creds", refs: [] };
    assert.deepEqual(engine.onLogEntry("vibesquad", blk), [id]);
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].text, /w-1 stalled \(blocked\)/);
    assert.match(delivered[0].text, /need creds/);
    assert.match(delivered[0].text, /w-2 stalled \(blocked \(permission\)\)/);
    assert.deepEqual(engine.onLogEntry("vibesquad", { ...blk, ts: iso(T0 + 2000), text: "still blocked" }), [], "already pinged: normal wake");
  } finally {
    sb.cleanup();
  }
});

test("idea-110: requiresAttention without a pending permission is not 'blocked (permission)'; a resolved permission clears it", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }, { kind: "agent", ref: "w-2" }] }, { home: sb.home, now: T0 });
    const { engine, delivered } = engineFor(sb);
    // w-1: attention flag set for a non-permission reason (empty pending list).
    engine.onRunnerEvent(agentEv("w-1", "running", { requiresAttention: true, pendingPermissions: [] }));
    // w-2: permission requested, then answered (the agent event after it carries an empty list).
    engine.onRunnerEvent(agentEv("w-2", "running", { requiresAttention: true, pendingPermissions: [{ id: "p1" }] }));
    engine.onRunnerEvent({ kind: "permission", agentId: "w-2", request: { id: "p1", toolName: "Bash" } });
    engine.onRunnerEvent(agentEv("w-2", "running", { requiresAttention: false, pendingPermissions: [] }));
    await engine.tick();
    assert.equal(delivered.length, 0, "neither agent is blocked on a permission");
  } finally {
    sb.cleanup();
  }
});

test("idea-216: an ACP auto-resolved permission (event carries a snapshot with no pending permission) never reads 'blocked (permission)'", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", stallMin: 15, items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = engineFor(sb);
    engine.onRunnerEvent(agentEv("w-1", "running", { pendingPermissions: [] }));
    // request + resolved are logged back to back; the fetch behind the request already shows no pending permission.
    engine.onRunnerEvent({ kind: "permission", agentId: "w-1", agent: { id: "w-1", status: "running", labels: { role: "worker" }, pendingPermissions: [] }, request: { id: "p1", toolName: "Edit" } });
    clock.t = T0 + 20 * MIN;
    await engine.tick();
    assert.doesNotMatch(delivered.map((d) => d.text).join("\n"), /blocked \(permission\)/);
  } finally {
    sb.cleanup();
  }
});

test("unit-watch-false-stall-2 A: idle after a turn with a final assistant message is done, in round 1 and after a re-prompt", async () => {
  const sb = sandbox();
  try {
    const { id } = addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: T0 });
    let text = "";
    const { engine, delivered, clock } = engineFor(sb, { lastMessage: async () => text });
    engine.onRunnerEvent(agentEv("w-1", "running"));
    engine.onRunnerEvent({ kind: "turn_started", agentId: "w-1" });
    text = "round 1 report";
    engine.onRunnerEvent(agentEv("w-1", "idle"));
    engine.onRunnerEvent({ kind: "turn_ended", agentId: "w-1" });
    clock.t = T0 + 20 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].pingKey, "done", "round 1: no STALLED ping");
    assert.match(delivered[0].text, /round 1 report/);
    // Second set, the same worker re-prompted for a fix round that ends with a final message.
    const second = addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: clock.t });
    engine.onRunnerEvent({ kind: "turn_started", agentId: "w-1" });
    engine.onRunnerEvent(agentEv("w-1", "running"));
    text = "PASS 0/0/0 ea0c2bc";
    engine.onRunnerEvent(agentEv("w-1", "idle"));
    engine.onRunnerEvent({ kind: "turn_ended", agentId: "w-1" });
    clock.t += 20 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1].pingKey, "done", "round 2: no STALLED ping");
    assert.match(delivered[1].text, /PASS 0\/0\/0 ea0c2bc/);
    assert.notEqual(second.id, id);
  } finally {
    sb.cleanup();
  }
});

test("unit-watch-false-stall-2 A (review H1): round 1's final text does not complete a set created after it, even when tick() runs before the re-prompt's turn_started", async () => {
  const sb = sandbox();
  try {
    const clock = { t: T0 };
    let text = "round 1 report";
    const { engine, delivered } = engineFor(sb, { clock, lastMessage: async () => text });
    engine.onRunnerEvent(agentEv("w-1", "running"));
    engine.onRunnerEvent(agentEv("w-1", "idle"));
    clock.t = T0 + 5 * MIN;
    const { id } = addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: clock.t });
    await engine.tick(); // before the re-prompt's turn_started: the old text must not count
    assert.equal(delivered.length, 0);
    assert.equal(engine.get(id).items[0].state, "waiting");
    clock.t += MIN;
    engine.onRunnerEvent({ kind: "turn_started", agentId: "w-1" });
    engine.onRunnerEvent(agentEv("w-1", "running"));
    text = "round 2 report";
    engine.onRunnerEvent(agentEv("w-1", "idle"));
    engine.onRunnerEvent({ kind: "turn_ended", agentId: "w-1" });
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].text, /round 2 report/);
  } finally {
    sb.cleanup();
  }
});

test(
  "unit-watch-false-stall-2 A (review H2): a user_message after the last assistant message makes the watch's final text empty (stale), not done",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["lead-1", mk("lead-1", "lead")],
      ["w-1", mk("w-1", "worker")],
    ]);
    const now = Date.now();
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: now - 1000 });
    let entries = [{ item: { type: "assistant_message", text: "old report" } }, { item: { type: "user_message", text: "fix round" } }];
    const h = await pluginHarness(sb, agents, { timelineFor: () => entries });
    try {
      h.watch.onRunnerEvent(agentEv("w-1", "running"));
      await h.watch.tick();
      assert.equal(h.watch.get(id).items[0].state, "waiting", "stale text before the user message is not a report");
      entries = [{ item: { type: "user_message", text: "fix round" } }, { item: { type: "assistant_message", text: "new report" } }];
      h.watch.onRunnerEvent({ kind: "turn_ended", agentId: "w-1" }); // re-read
      await h.watch.tick();
      assert.equal(h.watch.get(id).items[0].state, "done");
    } finally {
      h.stop();
    }
  }),
);

test("unit-watch-false-stall-2 A (review R2): turn started BEFORE the watch was added, ends after: final text is done", async () => {
  const sb = sandbox();
  try {
    const clock = { t: T0 };
    let text = "round 1 report";
    const { engine, delivered } = engineFor(sb, { clock, lastMessage: async () => text });
    engine.onRunnerEvent({ kind: "turn_started", agentId: "w-1" }); // T1
    engine.onRunnerEvent(agentEv("w-1", "running"));
    clock.t = T0 + 5 * MIN;
    addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: clock.t }); // T2
    clock.t += MIN; // T3
    text = "PASS 0/0/0 final";
    engine.onRunnerEvent(agentEv("w-1", "idle"));
    engine.onRunnerEvent({ kind: "turn_ended", agentId: "w-1" });
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].pingKey, "done");
    assert.match(delivered[0].text, /PASS 0\/0\/0 final/);
  } finally {
    sb.cleanup();
  }
});

test("unit-watch-false-stall-2 A: an idle worker with no final message still stalls idle-no-report", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = engineFor(sb, { lastMessage: async () => "" });
    engine.onRunnerEvent(agentEv("w-1", "idle"));
    await engine.tick(); // starts the idle clock
    clock.t = T0 + 20 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].text, /idle-no-report/);
  } finally {
    sb.cleanup();
  }
});

test("unit-watch-false-stall-2 B (idea-171): a permission event with an empty pendingPermissions, and a stale flag after the turn moves on, is not 'blocked (permission)'", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }, { kind: "agent", ref: "w-2" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = engineFor(sb);
    // w-1: the permission event carries a snapshot whose pending list is already empty (answered before we saw it).
    engine.onRunnerEvent({ kind: "permission", agentId: "w-1", agent: { id: "w-1", status: "running", labels: { role: "worker" }, pendingPermissions: [] } });
    // w-2: real permission, answered; only id-only events (no snapshot) follow, then the next turn.
    engine.onRunnerEvent(agentEv("w-2", "running", { pendingPermissions: [{ id: "p1" }] }));
    engine.onRunnerEvent({ kind: "permission", agentId: "w-2", request: { id: "p1" } });
    engine.onRunnerEvent({ kind: "turn_started", agentId: "w-2" });
    clock.t = T0 + MIN;
    await engine.tick();
    assert.equal(delivered.length, 0, "neither is blocked on a permission");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Suite + restart items (W3 / restart-runtime contracts, from fixtures)
// ---------------------------------------------------------------------------

test("suite item: PASS record = done, FAIL record = done-with-FAIL (pinged), dead holder with no result = stall, died record = stall", async () => {
  const sb = sandbox();
  try {
    const resultFile = join(sb.tmp, SUITE_RESULT_FILE);
    const lockFile = join(sb.tmp, SUITE_LOCK_FILE);
    // FAIL with another item still pending -> a stall-type ping reporting the FAIL.
    const a = addWatch({ owner: "lead-1", items: [{ kind: "suite", ref: "rn-runner" }, { kind: "agent", ref: "w-1" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = engineFor(sb);
    engine.onRunnerEvent(agentEv("w-1", "running"));
    writeFileSync(lockFile, JSON.stringify({ pid: 111, agentId: "rn-runner", startedAt: T0 + 1000, full: true, files: [] }));
    clock.t = T0 + 20 * MIN; // a live holder never stalls, however long it runs
    engine.onRunnerEvent({ kind: "timeline", agentId: "w-1" });
    await engine.tick();
    assert.equal(engine.get(a.id).items[0].phase, "running");
    assert.equal(delivered.length, 0);
    // Another agent's result is not ours.
    writeFileSync(resultFile, JSON.stringify({ agentId: "rn-other", pid: 222, startedAt: iso(T0 + 1), full: true, files: [], finishedAt: iso(clock.t), tests: 10, pass: 10, fail: 0, failingFiles: [] }));
    await engine.tick();
    assert.equal(delivered.length, 0);
    writeFileSync(resultFile, JSON.stringify({ agentId: "rn-runner", pid: 111, startedAt: iso(T0 + 1000), full: true, files: [], finishedAt: iso(clock.t + 1), tests: 1200, pass: 1198, fail: 2, failingFiles: ["test/a.test.mjs"] }));
    rmSync(lockFile);
    clock.t += 1000;
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].text, /suite \(rn-runner\) FAIL/);
    assert.match(delivered[0].text, /1198\/1200 pass, 2 fail; failing: test\/a\.test\.mjs/);
    assert.equal(engine.get(a.id).firedAt, undefined);

    // Dead holder, no result (a park / kill of the suite runner) -> stall.
    const b = addWatch({ owner: "lead-2", items: [{ kind: "suite" }] }, { home: sb.home, now: clock.t });
    writeFileSync(lockFile, JSON.stringify({ pid: 999, agentId: "rn-x", startedAt: clock.t + 10, full: true, files: [] }));
    clock.t += 1000;
    await engine.tick();
    const bp = delivered.filter((d) => d.setId === b.id);
    assert.equal(bp.length, 1);
    assert.match(bp[0].text, /stalled \(holder-dead\)/);

    // W3's died record for the stolen holder -> stall; then a PASS rerun -> done -> completion.
    const c = addWatch({ owner: "lead-3", items: [{ kind: "suite", ref: "rn-y" }] }, { home: sb.home, now: clock.t });
    rmSync(lockFile);
    writeFileSync(resultFile, JSON.stringify({ agentId: "rn-y", pid: 333, startedAt: iso(clock.t), full: true, files: [], finishedAt: iso(clock.t + 5), died: true }));
    clock.t += 1000;
    await engine.tick();
    assert.match(delivered.filter((d) => d.setId === c.id)[0].text, /stalled \(died\)/);
    writeFileSync(resultFile, JSON.stringify({ agentId: "rn-y", pid: 334, startedAt: iso(clock.t), full: true, files: [], finishedAt: iso(clock.t + 5), tests: 5, pass: 5, fail: 0, failingFiles: [] }));
    clock.t += 1000;
    await engine.tick();
    const cp = delivered.filter((d) => d.setId === c.id);
    assert.equal(cp.length, 2);
    assert.match(cp[1].text, /complete: all 1 item done/);
    assert.match(cp[1].text, /PASS 5\/5 pass, 0 fail/);
  } finally {
    sb.cleanup();
  }
});

test("suite item: only a full run started after registration counts; a queued 17-test run that overwrites the full run's record never reads green", async () => {
  const sb = sandbox();
  try {
    const resultFile = join(sb.tmp, SUITE_RESULT_FILE);
    const lockFile = join(sb.tmp, SUITE_LOCK_FILE);
    const partial = (at, extra = {}) => ({ agentId: "rn-w", pid: 555, startedAt: at, finishedAt: at + 30_000, full: false, files: ["test/watch-sets.test.mjs"], tests: 17, pass: 17, fail: 0, failingFiles: [], ...extra });
    const full = (at, extra = {}) => ({ agentId: "rn-full", pid: 444, startedAt: at, finishedAt: at + 10 * MIN, full: true, files: [], tests: 1300, pass: 1300, fail: 0, failingFiles: [], ...extra });

    // (a) Partial PASS records (one with full:false, one old record with no `full` field) never satisfy the item.
    const a = addWatch({ owner: "lead-a", items: [{ kind: "suite" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = engineFor(sb);
    writeFileSync(resultFile, JSON.stringify(partial(T0 + 1000)));
    clock.t = T0 + 2 * MIN;
    await engine.tick();
    const { full: _f, files: _x, ...legacy } = partial(T0 + 2000);
    writeFileSync(resultFile, JSON.stringify(legacy));
    await engine.tick();
    assert.equal(delivered.length, 0, "no ping from a partial run");
    assert.equal(engine.get(a.id).items[0].state, "waiting");
    // A partial run holding the lock is not "our suite running" either.
    writeFileSync(lockFile, JSON.stringify({ pid: 111, agentId: "rn-w", startedAt: T0 + 3000, full: false, files: ["x"] }));
    await engine.tick();
    assert.equal(engine.get(a.id).items[0].phase, "queued");
    rmSync(lockFile);

    // (b) A full run that started BEFORE registration does not count, even if it passes after it.
    writeFileSync(resultFile, JSON.stringify(full(T0 - MIN)));
    await engine.tick();
    assert.equal(delivered.length, 0, "a full run older than the watch is not ours");

    // (c) The full run FAILs, then a queued 17-test run PASSes and overwrites the record: the FAIL stands, no green.
    const b = addWatch({ owner: "lead-b", items: [{ kind: "suite" }, { kind: "agent", ref: "w-1" }] }, { home: sb.home, now: clock.t });
    engine.onRunnerEvent(agentEv("w-1", "running"));
    writeFileSync(resultFile, JSON.stringify(full(clock.t + 1000, { pass: 1298, fail: 2, failingFiles: ["test/x.test.mjs"] })));
    clock.t += 11 * MIN;
    engine.onRunnerEvent({ kind: "timeline", agentId: "w-1" });
    await engine.tick();
    let bp = delivered.filter((d) => d.setId === b.id);
    assert.equal(bp.length, 1);
    assert.match(bp[0].text, /suite FAIL/);
    writeFileSync(resultFile, JSON.stringify(partial(clock.t)));
    clock.t += MIN;
    engine.onRunnerEvent({ kind: "timeline", agentId: "w-1" });
    await engine.tick();
    assert.equal(engine.get(b.id).items[0].state, "fail", "the partial run did not replace the full run's verdict");
    engine.onRunnerEvent(agentEv("w-1", "idle"));
    engine.onLogEntry("vibesquad", doneEntry("w-1", clock.t + 1, "PASS: w1"));
    clock.t += 1000;
    await engine.tick();
    bp = delivered.filter((d) => d.setId === b.id);
    assert.equal(bp.length, 2);
    assert.match(bp[1].text, /finished: 1 done, 1 FAIL/);
    assert.match(bp[1].text, /suite: FAIL — FAIL 1298\/1300/);
    assert.doesNotMatch(bp[1].text, /17\/17|complete: all/);

    // (d) The full run is still going (or not yet seen) when the 17-test run's PASS lands: waiting, not green; the full PASS then completes it.
    const c = addWatch({ owner: "lead-c", items: [{ kind: "suite" }] }, { home: sb.home, now: clock.t });
    const fullStart = clock.t + 1000;
    writeFileSync(lockFile, JSON.stringify({ pid: 111, agentId: "rn-full", startedAt: fullStart, full: true, files: [] }));
    writeFileSync(resultFile, JSON.stringify(partial(clock.t + 2000)));
    clock.t += 5 * MIN;
    await engine.tick();
    assert.equal(delivered.filter((d) => d.setId === c.id).length, 0);
    assert.equal(engine.get(c.id).items[0].phase, "running");
    rmSync(lockFile);
    writeFileSync(resultFile, JSON.stringify(full(fullStart)));
    clock.t += MIN;
    await engine.tick();
    const cp = delivered.filter((d) => d.setId === c.id);
    assert.equal(cp.length, 1);
    assert.match(cp[0].text, /complete: all 1 item done/);
    assert.match(cp[0].text, /PASS 1300\/1300/);

    // (e) A died record for a full run is a stall; a died partial run is ignored.
    const d = addWatch({ owner: "lead-d", items: [{ kind: "suite" }] }, { home: sb.home, now: clock.t });
    writeFileSync(resultFile, JSON.stringify({ agentId: "rn-w", pid: 556, startedAt: clock.t + 10, full: false, files: ["x"], died: true }));
    clock.t += MIN;
    await engine.tick();
    assert.equal(delivered.filter((x) => x.setId === d.id).length, 0, "a died partial run is not our suite");
    writeFileSync(resultFile, JSON.stringify({ agentId: "rn-full", pid: 445, startedAt: clock.t, full: true, files: [], died: true }));
    clock.t += MIN;
    await engine.tick();
    const dp = delivered.filter((x) => x.setId === d.id);
    assert.equal(dp.length, 1);
    assert.match(dp[0].text, /suite stalled \(died\)/);
  } finally {
    sb.cleanup();
  }
});

test("restart item: restart-<ts>.json ok:true = done, ok:false = stall, none after stallMin = stall; dry runs and older records ignored", async () => {
  const sb = sandbox();
  try {
    writeFileSync(join(sb.home, "restart-old.json"), JSON.stringify({ startedAt: iso(T0 - 5 * MIN), finishedAt: iso(T0 - 4 * MIN), ok: true, cutAgents: [] }));
    const a = addWatch({ owner: "lead-1", items: [{ kind: "restart" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = engineFor(sb);
    await engine.tick();
    assert.equal(delivered.length, 0, "a record from before registration is not ours");
    writeFileSync(join(sb.home, "restart-dry.json"), JSON.stringify({ startedAt: iso(T0 + 1), finishedAt: iso(T0 + 2), dryRun: true, ok: true }));
    await engine.tick();
    assert.equal(delivered.length, 0, "a dry run is not a restart");
    writeFileSync(join(sb.home, "restart-2026-11-10T12-01-00-000Z.json"), JSON.stringify({ startedAt: iso(T0 + MIN), finishedAt: iso(T0 + 2 * MIN), ok: false, cutAgents: ["rn-1"], errors: [{ step: "runner", message: "port busy" }] }));
    clock.t = T0 + 3 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].text, /restart stalled \(restart-failed\)/);
    assert.match(delivered[0].text, /port busy/);
    writeFileSync(join(sb.home, "restart-2026-11-10T12-04-00-000Z.json"), JSON.stringify({ startedAt: iso(T0 + 4 * MIN), finishedAt: iso(T0 + 5 * MIN), ok: true, cutAgents: ["rn-1", "rn-2"], resumedAgents: ["rn-1"] }));
    clock.t = T0 + 6 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 2);
    assert.match(delivered[1].text, /restart: done — restart ok: cut 2, resumed 1/);
    assert.ok(engine.get(a.id).firedAt);

    const b = addWatch({ owner: "lead-2", stallMin: 5, items: [{ kind: "restart" }] }, { home: sb.home, now: clock.t });
    clock.t += 6 * MIN;
    await engine.tick();
    const bp = delivered.filter((d) => d.setId === b.id);
    assert.equal(bp.length, 1);
    assert.match(bp[0].text, /stalled \(no-result\)/);
  } finally {
    sb.cleanup();
  }
});

test("a cancelled set never fires and drops its unsent pings", async () => {
  const sb = sandbox();
  try {
    const { id } = addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }, { kind: "agent", ref: "w-2" }] }, { home: sb.home, now: T0 });
    const { engine, delivered } = engineFor(sb, { deliver: () => {} });
    engine.onRunnerEvent(agentEv("w-1", "error"));
    engine.onRunnerEvent(agentEv("w-2", "running"));
    await engine.tick(); // stall ping fired (not delivered by this no-op deliver)
    assert.equal(engine.get(id).pings.length, 1);
    cancelWatch(id, "lead-1", { home: sb.home });
    const b = engineFor(sb);
    b.engine.onRunnerEvent(agentEv("w-2", "idle"));
    b.engine.onLogEntry("vibesquad", doneEntry("w-2", T0 + 1000));
    assert.deepEqual(b.engine.onLogEntry("vibesquad", doneEntry("w-2", T0 + 1001)), [], "a cancelled set takes nothing");
    await b.engine.tick();
    assert.equal(b.delivered.length, 0);
    assert.equal(delivered.length, 0);
  } finally {
    sb.cleanup();
  }
});

test("startup backfill: a report filed while the server was down still completes the set", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: T0 });
    mkdirSync(join(sb.home, "teams", "vibesquad"), { recursive: true });
    appendFileSync(join(sb.home, "teams", "vibesquad", "log.jsonl"), JSON.stringify(doneEntry("w-1", T0 + 1000, "PASS: while down")) + "\n");
    const { engine, delivered } = engineFor(sb);
    engine.onRunnerEvent({ kind: "roster", agents: [{ id: "w-1", status: "idle" }] });
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].text, /while down/);
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// W4: digest merge (docs/PLAN_COMPLETION_DIGEST_RELAY.md block W4)
// ---------------------------------------------------------------------------

const longReport = (ref) => `${ref} PASS: shipped with ${"detail ".repeat(45)} commit deadbeefcafe1`.trim(); // ~ 330 chars each

test("a short ping is sent raw and never spawns a merge worker", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: T0 });
    const spawns = [];
    const { engine, delivered, clock } = engineFor(sb, {
      spawnDigest: (d) => {
        spawns.push(d);
        return true;
      },
    });
    engine.onRunnerEvent(agentEv("w-1", "idle"));
    engine.onLogEntry("vibesquad", doneEntry("w-1", T0 + 1000, "PASS: w1 shipped"));
    clock.t = T0 + 2000;
    await engine.tick();
    assert.equal(delivered.length, 1, "the raw text is delivered");
    assert.equal(spawns.length, 0, "no Flash spawn for a short set");
    assert.match(delivered[0].text, /complete: all 1 item done/);
    assert.ok(delivered[0].text.length <= DIGEST_MERGE_MAX);
  } finally {
    sb.cleanup();
  }
});

test("a long completion ping spawns exactly one merge worker (attempted before the spawn) and is not sent raw", async () => {
  const sb = sandbox();
  try {
    const refs = ["w-1", "w-2", "w-3", "w-4", "w-5", "w-6"];
    const { id } = addWatch({ owner: "lead-1", items: refs.map((ref) => ({ kind: "agent", ref })) }, { home: sb.home, now: T0 });
    const spawns = [];
    const { engine, delivered, clock } = engineFor(sb, {
      spawnDigest: (d) => {
        spawns.push(d);
        // One-ping guarantee: attemptedAt is persisted BEFORE the spawn runs.
        assert.ok(engine.get(id).pings[0].attemptedAt, "attemptedAt persisted before the spawn");
        return true;
      },
    });
    for (const ref of refs) {
      engine.onRunnerEvent(agentEv(ref, "idle"));
      engine.onLogEntry("vibesquad", doneEntry(ref, T0 + 1000, longReport(ref)));
    }
    clock.t = T0 + 2000;
    await engine.tick();
    const ping = engine.get(id).pings[0];
    assert.ok(ping.text.length > DIGEST_MERGE_MAX, `the set's text is over ${DIGEST_MERGE_MAX} chars (got ${ping.text.length})`);
    assert.equal(spawns.length, 1, "exactly one merge worker for a long set");
    assert.equal(delivered.length, 0, "the raw text is not also sent");
    assert.ok(ping.attemptedAt, "attemptedAt persisted");
    // Later ticks never re-spawn.
    clock.t += 5 * MIN;
    await engine.tick();
    assert.equal(spawns.length, 1);
  } finally {
    sb.cleanup();
  }
});

test("a failed merge spawn falls back to the raw text, truncated with a size note", async () => {
  const sb = sandbox();
  try {
    const refs = ["w-1", "w-2", "w-3", "w-4", "w-5", "w-6"];
    const { id } = addWatch({ owner: "lead-1", items: refs.map((ref) => ({ kind: "agent", ref })) }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = engineFor(sb, { spawnDigest: () => false });
    for (const ref of refs) {
      engine.onRunnerEvent(agentEv(ref, "idle"));
      engine.onLogEntry("vibesquad", doneEntry(ref, T0 + 1000, longReport(ref)));
    }
    clock.t = T0 + 2000;
    await engine.tick();
    const ping = engine.get(id).pings[0];
    assert.ok(ping.text.length > DIGEST_MERGE_MAX);
    assert.equal(delivered.length, 1, "fallback delivered exactly once");
    assert.ok(ping.attemptedAt, "attemptedAt persisted (never re-offered)");
    assert.equal(delivered[0].text.startsWith(ping.text.slice(0, DIGEST_MERGE_MAX)), true, "fallback is the raw text's prefix");
    assert.match(delivered[0].text, /\(\+\d+ chars, see vs log\)$/, "fallback names the dropped char count");
    // Never sent twice: another tick does not re-offer (attempted) or re-spawn.
    clock.t += 5 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 1);
  } finally {
    sb.cleanup();
  }
});

test("a set spawns at most one Flash worker across multiple over-long pings (stall, then done)", async () => {
  const sb = sandbox();
  try {
    const refs = ["w-1", "w-2", "w-3", "w-4", "w-5", "w-6", "w-7", "w-8"];
    const { id } = addWatch({ owner: "lead-1", items: refs.map((ref) => ({ kind: "agent", ref })) }, { home: sb.home, now: T0 });
    const spawns = [];
    const { engine, delivered, clock } = engineFor(sb, {
      spawnDigest: (d) => {
        spawns.push(d);
        return true;
      },
    });
    // w-1..w-6 finish with long reports so any ping's text exceeds the threshold.
    for (const ref of refs.slice(0, 6)) {
      engine.onRunnerEvent(agentEv(ref, "idle"));
      engine.onLogEntry("vibesquad", doneEntry(ref, T0 + 1000, longReport(ref)));
    }
    // w-7 stalls -> a >1500 stall ping (the set's first over-long ping).
    engine.onRunnerEvent(agentEv("w-7", "error"));
    clock.t = T0 + 2000;
    await engine.tick();
    assert.equal(spawns.length, 1, "the stall ping spawned the set's one Flash worker");
    assert.equal(delivered.length, 0, "the stall ping was merged, not sent raw");
    assert.ok(engine.get(id).pings[0].text.length > DIGEST_MERGE_MAX, "stall ping over threshold");
    // w-8 finishes -> a >1500 completion ping; the set already used its one Flash worker.
    engine.onRunnerEvent(agentEv("w-8", "idle"));
    engine.onLogEntry("vibesquad", doneEntry("w-8", clock.t + 1, longReport("w-8")));
    clock.t += 1000;
    await engine.tick();
    assert.equal(spawns.length, 1, "no second Flash worker for the completion ping");
    assert.equal(delivered.length, 1, "the completion ping fell back to the truncated raw text");
    assert.match(delivered[0].text, /\(\+\d+ chars, see vs log\)$/, "fallback names the dropped char count");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// idea-160 R3
// ---------------------------------------------------------------------------

test("escalation (R3 H): every item stalled, no sibling done: after the last step the set closes with its one ping", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", team: "t", lane: "l", items: [{ kind: "agent", ref: "w-a" }, { kind: "agent", ref: "w-b" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = escEngine(sb);
    engine.onRunnerEvent(agentEv("w-a", "idle"));
    engine.onRunnerEvent(agentEv("w-b", "idle"));
    await engine.tick();
    clock.t = T0 + 16 * MIN;
    await engine.tick();
    clock.t += 25 * MIN;
    await engine.tick();
    clock.t += 25 * MIN;
    await engine.tick();
    assert.equal(engine.list()[0].firedAt, undefined, "esc2 just fired");
    clock.t += 1 * MIN;
    await engine.tick();
    assert.ok(engine.list()[0].firedAt, "closed after the last step");
    const done = delivered.filter((d) => d.pingKey === "done");
    assert.equal(done.length, 1);
    assert.match(done[0].text, /still stalled/);
    const n = delivered.length;
    clock.t += 300 * MIN;
    await engine.tick();
    assert.equal(delivered.length, n, "nothing after the close");
  } finally {
    sb.cleanup();
  }
});

test("escalation (R3 H): siblings finished BEFORE the stall ping; the idle one escalates, then the set closes once", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", team: "t", lane: "l", items: [{ kind: "agent", ref: "w-idle" }, { kind: "agent", ref: "w-ok" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = escEngine(sb);
    engine.onRunnerEvent(agentEv("w-idle", "idle"));
    engine.onRunnerEvent(agentEv("w-ok", "idle"));
    await engine.tick();
    clock.t = T0 + 10 * MIN;
    engine.onLogEntry("t", doneEntry("w-ok", clock.t));
    await engine.tick();
    clock.t = T0 + 16 * MIN;
    await engine.tick(); // stall ping (w-idle)
    clock.t += 25 * MIN;
    await engine.tick();
    clock.t += 25 * MIN;
    await engine.tick();
    clock.t += 1 * MIN;
    await engine.tick();
    assert.ok(engine.list()[0].firedAt);
    assert.equal(delivered.filter((d) => d.pingKey === "done").length, 1);
    assert.deepEqual(delivered.map((d) => d.target).filter(Boolean), ["owner", "overlord"]);
  } finally {
    sb.cleanup();
  }
});

test("escalation (R3 M): a real turn after the nudge's clears nudgeTurnAt (persisted), so a restart does not revive the episode", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-m" }] }, { home: sb.home, now: T0 });
    const clock = { t: T0 };
    const a = escEngine(sb, { clock });
    a.engine.onRunnerEvent(agentEv("w-m", "idle"));
    await a.engine.tick();
    clock.t = T0 + 16 * MIN;
    await a.engine.tick();
    clock.t += 25 * MIN;
    await a.engine.tick(); // esc1 + nudge
    clock.t += 10_000;
    a.engine.onRunnerEvent(agentEv("w-m", "running"));
    a.engine.onRunnerEvent({ kind: "turn_started", agentId: "w-m" }); // the nudge's turn
    await a.engine.tick();
    assert.ok(a.engine.list()[0].items[0].nudgeTurnAt, "recorded");
    clock.t += 2 * MIN;
    a.engine.onRunnerEvent(agentEv("w-m", "idle"));
    await a.engine.tick();
    clock.t += 10 * MIN;
    a.engine.onRunnerEvent(agentEv("w-m", "running"));
    a.engine.onRunnerEvent({ kind: "turn_started", agentId: "w-m" }); // a real turn
    await a.engine.tick();
    assert.equal(a.engine.list()[0].items[0].nudgeTurnAt, undefined, "cleared and persisted");
    clock.t += 2 * MIN;
    a.engine.onRunnerEvent(agentEv("w-m", "idle"));
    await a.engine.tick();
    // restart: the new engine has no turn time in memory
    const b = escEngine(sb, { clock });
    b.engine.onRunnerEvent(agentEv("w-m", "idle"));
    clock.t += 90 * MIN;
    await b.engine.tick();
    await b.engine.tick();
    assert.equal(b.delivered.filter((d) => d.target === "overlord").length, 0, "no Overlord ping from the ended episode");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Plugin integration: the wake path (agent-duties.ts Hook 3 / 3b)
// ---------------------------------------------------------------------------

const TEAMS_DOC = {
  teams: [
    {
      id: "vibesquad",
      name: "VibeSquad",
      lanes: [
        { id: "vibesquad", name: "VibeSquad", hub: true, paths: ["VibeSquad"] },
        { id: "feat-alpha", name: "Feat Alpha", code: "Fea", paths: ["VibeSquad"] },
      ],
      paths: ["VibeSquad"],
    },
    { id: "efi", name: "EFI", lanes: [{ id: "efi", name: "EFI", hub: true, paths: ["EFI"] }, { id: "main-game", name: "Main", paths: ["EFI"] }], paths: ["EFI"] },
    { id: "nf", name: "NF", lanes: [{ id: "nf", name: "NF", paths: ["NF"] }, { id: "ln", name: "LN", paths: ["NF"] }], paths: ["NF"] },
  ],
};
const CWD = "/projects/VibeSquad";
const mk = (id, role, lane = "vibesquad", extra = {}) => ({ id, title: id, cwd: CWD, status: "idle", provider: "claude", labels: { team: "vibesquad", lane, role, ...extra } });

async function pluginHarness(sb, agents, extra = {}) {
  const { createPlugin } = await import("../server/hooks/agent-duties.ts");
  const sent = [];
  const server = { before: () => () => {}, on: () => () => {} };
  const stop = createPlugin({
    startWatcher: false,
    briefRoot: sb.dir,
    debounceMs: 20,
    retryBaseMs: 10,
    leadWakeCooldownMs: 40,
    firstPromptRedeliverMs: 60_000,
    setLabels: async () => {},
    archiveAgent: async () => {},
    watchSets: { home: sb.home, tmpdir: sb.tmp, retryMs: 0, ...(extra.watchSets ?? {}) },
  })(server);
  const paseo = {
    agents: {
      ref: (id) => ({
        refresh: async () => {
          extra.onRefresh?.(id);
          return agents.has(id) ? { agent: agents.get(id) } : null;
        },
        send: async (text) => void sent.push({ to: id, text }),
        archive: async () => {},
        detach: async () => {},
        timeline: { refetch: async () => ({ entries: extra.timelineFor?.(id) ?? [] }) },
      }),
      list: async () => ({ entries: [...agents.values()].map((agent) => ({ agent })) }),
      create: extra.create,
    },
  };
  stop.setPaseo(paseo);
  return { stop, sent, watch: stop.watchSets, scanLogs: stop.scanLogs };
}

function withPluginEnv(fn) {
  return async () => {
    const sb = sandbox();
    const teamsFile = join(sb.home, "teams.json");
    writeFileSync(teamsFile, JSON.stringify(TEAMS_DOC), "utf8");
    const prev = { VIBESQUAD_HOME: process.env.VIBESQUAD_HOME, VIBESQUAD_TEAMS_FILE: process.env.VIBESQUAD_TEAMS_FILE };
    process.env.VIBESQUAD_HOME = sb.home;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    try {
      await fn(sb);
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      sb.cleanup();
    }
  };
}

function writeLog(sb, entries) {
  mkdirSync(join(sb.home, "teams", "vibesquad"), { recursive: true });
  appendFileSync(join(sb.home, "teams", "vibesquad", "log.jsonl"), entries.map((e) => JSON.stringify(e) + "\n").join(""));
}

test(
  "plugin: watched workers' done entries produce no normal wake to the owner, the owner gets exactly one watch ping, an unwatched done still wakes",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["lead-1", mk("lead-1", "lead")],
      ["w-1", mk("w-1", "worker")],
      ["w-2", mk("w-2", "worker")],
      ["w-3", mk("w-3", "worker")],
      ["dg-2", mk("dg-2", "worker", "vibesquad", { digestFor: "w-2" })],
    ]);
    const now = Date.now();
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }, { kind: "agent", ref: "w-2" }] }, { home: sb.home, now: now - 1000 });
    const h = await pluginHarness(sb, agents);
    try {
      writeLog(sb, [
        { ts: iso(now), agent: "w-1", lane: "vibesquad", type: "done", text: "PASS: w1 shipped", refs: [] },
        { ts: iso(now + 1), agent: "dg-2", lane: "vibesquad", type: "done", text: "PASS: w2 verified", refs: ["w-2"] },
        { ts: iso(now + 2), agent: "w-3", lane: "vibesquad", type: "done", text: "PASS: w3 unwatched", refs: [] },
      ]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250); // debounce (20) + cooldown (40) + rechecks
      await h.watch.tick();
      const toLead = h.sent.filter((s) => s.to === "lead-1");
      const pings = toLead.filter((s) => s.text.includes(`Watch ${id}`));
      assert.equal(pings.length, 1, JSON.stringify(toLead));
      assert.match(pings[0].text, /complete: all 2 items done/);
      const normal = toLead.filter((s) => s.text.startsWith("New team log event"));
      assert.equal(normal.length, 1, JSON.stringify(toLead));
      assert.match(normal[0].text, /\[done\] PASS: w3 unwatched\. Run/, "only the unwatched entry, no (+N more)");
      assert.equal(toLead.length, 2);
      const ping = h.watch.get(id).pings[0];
      assert.ok(ping.attemptedAt && ping.deliveredAt);
      assert.equal(ping.to, "lead-1");
    } finally {
      h.stop();
    }
  }),
);

test(
  "plugin: a retired owner's ping goes to the lane's live lead (successor), and the watched done does not also wake the successor",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["lead-old", mk("lead-old", "former-lead")],
      ["lead-new", mk("lead-new", "lead")],
      ["w-1", mk("w-1", "worker")],
    ]);
    const now = Date.now();
    const { id } = addWatch({ owner: "lead-old", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: now - 1000 });
    const h = await pluginHarness(sb, agents);
    try {
      writeLog(sb, [{ ts: iso(now), agent: "w-1", lane: "vibesquad", type: "done", text: "PASS: w1", refs: [] }]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      assert.equal(h.sent.filter((s) => s.to === "lead-old").length, 0);
      const toNew = h.sent.filter((s) => s.to === "lead-new");
      assert.equal(toNew.length, 1, JSON.stringify(h.sent));
      assert.match(toNew[0].text, new RegExp(`Watch ${id} complete`));
      assert.match(toNew[0].text, /Watch owner lead-old is retired; delivered to you/);
      assert.equal(h.watch.get(id).pings[0].to, "lead-new");
    } finally {
      h.stop();
    }
  }),
);

test(
  "plugin: the hold is per owner: an Overlord watching a feature-lane worker does not swallow that lane lead's normal wake",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["ovl", mk("ovl", "lead", "vibesquad")],
      ["lead-fa", mk("lead-fa", "lead", "feat-alpha")],
      ["w-9", mk("w-9", "worker", "feat-alpha")],
    ]);
    const now = Date.now();
    const { id } = addWatch({ owner: "ovl", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-9" }] }, { home: sb.home, now: now - 1000 });
    const h = await pluginHarness(sb, agents);
    try {
      writeLog(sb, [{ ts: iso(now), agent: "w-9", lane: "feat-alpha", type: "done", text: "PASS: w9", refs: [] }]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      const toOvl = h.sent.filter((s) => s.to === "ovl");
      const toFa = h.sent.filter((s) => s.to === "lead-fa");
      assert.equal(toOvl.length, 1);
      assert.match(toOvl[0].text, new RegExp(`Watch ${id} complete`));
      assert.equal(toFa.length, 1);
      assert.match(toFa[0].text, /\[done\] PASS: w9/);
    } finally {
      h.stop();
    }
  }),
);

test(
  "plugin: a ping waiting for a busy owner survives a server restart and is delivered exactly once by the next server",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["lead-1", { ...mk("lead-1", "lead"), status: "running" }],
      ["w-1", mk("w-1", "worker")],
    ]);
    const now = Date.now();
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: now - 1000 });
    const a = await pluginHarness(sb, agents);
    writeLog(sb, [{ ts: iso(now), agent: "w-1", lane: "vibesquad", type: "done", text: "PASS: w1", refs: [] }]);
    a.scanLogs(false);
    await a.watch.tick();
    await wait(150);
    assert.equal(a.sent.length, 0, "the lead is mid-turn: held");
    assert.ok(a.watch.get(id).firedAt);
    assert.equal(a.watch.get(id).pings[0].attemptedAt, undefined);
    a.stop(); // server restart: the in-memory pendingWake is gone

    agents.get("lead-1").status = "idle";
    const b = await pluginHarness(sb, agents);
    try {
      await b.watch.tick();
      await wait(150);
      await b.watch.tick();
      assert.equal(a.sent.length, 0);
      assert.equal(b.sent.length, 1);
      assert.match(b.sent[0].text, new RegExp(`Watch ${id} complete`));
      assert.equal(b.watch.get(id).pings.length, 1, "redelivered, not re-fired");
    } finally {
      b.stop();
    }
    const c = await pluginHarness(sb, agents);
    try {
      await c.watch.tick();
      await wait(100);
      assert.equal(c.sent.length, 0, "attempted: never again");
    } finally {
      c.stop();
    }
  }),
);

test(
  "plugin: an over-long watch ping is merged by the Flash worker and the merged digest is delivered to the owner",
  withPluginEnv(async (sb) => {
    const refs = ["w-1", "w-2", "w-3", "w-4", "w-5", "w-6"];
    const agents = new Map([["lead-1", mk("lead-1", "lead")], ...refs.map((r) => [r, mk(r, "worker")])]);
    const now = Date.now();
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: refs.map((ref) => ({ kind: "agent", ref })) }, { home: sb.home, now: now - 1000 });
    const spawns = [];
    const h = await pluginHarness(sb, agents, {
      create: async (payload) => {
        spawns.push(payload);
        return { id: "flash-1", waitForFinish: async () => ({ status: "idle" }) };
      },
      timelineFor: (aid) => (aid === "flash-1" ? [{ item: { type: "assistant_message", text: "MERGED: 6 done, all PASS" } }] : []),
    });
    try {
      writeLog(sb, refs.map((ref, i) => ({ ts: iso(now + i), agent: ref, lane: "vibesquad", type: "done", text: longReport(ref), refs: [] })));
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      await h.watch.tick();
      const toLead = h.sent.filter((s) => s.to === "lead-1");
      assert.equal(spawns.length, 1, "one Flash worker spawned");
      assert.equal(toLead.length, 1, JSON.stringify(h.sent));
      assert.match(toLead[0].text, /MERGED: 6 done, all PASS/);
      assert.doesNotMatch(toLead[0].text, /\(\+\d+ chars, see vs log\)$/, "no truncated fallback when the merge succeeds");
    } finally {
      h.stop();
    }
  }),
);

test(
  "plugin: a failed Flash merge falls back to the truncated raw text, delivered once",
  withPluginEnv(async (sb) => {
    const refs = ["w-1", "w-2", "w-3", "w-4", "w-5", "w-6"];
    const agents = new Map([["lead-1", mk("lead-1", "lead")], ...refs.map((r) => [r, mk(r, "worker")])]);
    const now = Date.now();
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: refs.map((ref) => ({ kind: "agent", ref })) }, { home: sb.home, now: now - 1000 });
    const spawns = [];
    const h = await pluginHarness(sb, agents, {
      create: async () => {
        spawns.push(1);
        return { id: "flash-1", waitForFinish: async () => ({ status: "error" }) };
      },
      timelineFor: () => [],
    });
    try {
      writeLog(sb, refs.map((ref, i) => ({ ts: iso(now + i), agent: ref, lane: "vibesquad", type: "done", text: longReport(ref), refs: [] })));
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      await h.watch.tick();
      const toLead = h.sent.filter((s) => s.to === "lead-1");
      assert.equal(spawns.length, 1, "one Flash worker was attempted");
      assert.equal(toLead.length, 1, JSON.stringify(h.sent));
      assert.match(toLead[0].text, /\(\+\d+ chars, see vs log\)$/, "truncated raw fallback delivered");
      assert.doesNotMatch(toLead[0].text, /MERGED/, "no merged digest on failure");
    } finally {
      h.stop();
    }
  }),
);

test("F6: cancelWatch honours an `allow(set)` predicate and never flips the set when refused", () => {
  const sb = sandbox();
  try {
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "suite" }] }, { home: sb.home, now: T0 });
    const refused = cancelWatch(id, "lead-2", { home: sb.home, now: T0 + 1, allow: (set) => set.owner === "lead-2" });
    assert.equal(refused.ok, false);
    assert.equal(refused.refused, true);
    assert.match(refused.error, /only its owner or the same-Squad Overlord may cancel/);
    const still = listWatches({ owner: "lead-1" }, { home: sb.home })[0];
    assert.equal(still.status, "armed");
    assert.equal(still.cancelledBy, undefined);
    assert.deepEqual(cancelWatch(id, "lead-1", { home: sb.home, now: T0 + 2, allow: (set) => set.owner === "lead-1" }), { ok: true, id });
    // no predicate = legacy trust-the-caller behaviour (W1 callers that already authorized)
    const other = addWatch({ owner: "lead-3", team: "vibesquad", lane: "x", items: [{ kind: "suite" }] }, { home: sb.home, now: T0 }).id;
    assert.deepEqual(cancelWatch(other, "anyone", { home: sb.home, now: T0 + 3 }), { ok: true, id: other });
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// idea-160: idle-no-report escalation (owner re-ping, then Overlord, plus one auto-nudge)
// ---------------------------------------------------------------------------

function escEngine(sb, extra = {}) {
  const nudges = [];
  const r = engineFor(sb, { nudge: (ref, text) => nudges.push({ ref, text }), ...extra });
  return { ...r, nudges };
}

test("escalation: idle-no-report stall ping, then owner re-ping 25 min later, then Overlord 25 min after that; each once; one nudge", async () => {
  const sb = sandbox();
  try {
    const { id } = addWatch({ owner: "lead-1", team: "t", lane: "l", items: [{ kind: "agent", ref: "w-idle" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock, nudges } = escEngine(sb);
    engine.onRunnerEvent(agentEv("w-idle", "idle"));
    await engine.tick();
    clock.t = T0 + 16 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 1, "stall ping");
    assert.equal(delivered[0].target, undefined);
    clock.t = T0 + 16 * MIN + 24 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 1, "inside the escalation window");
    assert.equal(nudges.length, 0);
    clock.t = T0 + 16 * MIN + 25 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1].target, "owner");
    assert.match(delivered[1].text, /still idle/i);
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0].ref, "w-idle");
    assert.match(nudges[0].text, /went idle without a report/);
    clock.t += 24 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 2);
    clock.t += 1 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 3);
    assert.equal(delivered[2].target, "overlord");
    for (let i = 0; i < 4; i++) {
      clock.t += 30 * MIN;
      await engine.tick();
    }
    assert.equal(delivered.length, 4, "stall, esc1, esc2, then the one completion ping; each once");
    assert.equal(delivered.filter((d) => d.pingKey === "done").length, 1);
    assert.equal(nudges.length, 1, "nudge once");
    assert.ok(engine.get(id).firedAt, "the set closes after the last step");
  } finally {
    sb.cleanup();
  }
});

test("escalation: escalateMin is configurable per set; nudge:false in engine opts is off by omitting the hook", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", stallMin: 5, escalateMin: 3, items: [{ kind: "agent", ref: "w-idle" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = engineFor(sb);
    engine.onRunnerEvent(agentEv("w-idle", "idle"));
    await engine.tick();
    clock.t = T0 + 6 * MIN;
    await engine.tick();
    clock.t += 3 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 2);
    clock.t += 3 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 3);
    assert.equal(delivered[2].target, "overlord");
  } finally {
    sb.cleanup();
  }
});

test("escalation stops when the worker starts a turn or reports", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", team: "t", lane: "l", items: [{ kind: "agent", ref: "w-a" }, { kind: "agent", ref: "w-b" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock, nudges } = escEngine(sb);
    engine.onRunnerEvent(agentEv("w-a", "idle"));
    engine.onRunnerEvent(agentEv("w-b", "idle"));
    await engine.tick();
    clock.t = T0 + 16 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 1);
    // w-a starts a turn (nudge from nobody, e.g. the lead), w-b reports
    clock.t = T0 + 30 * MIN;
    engine.onRunnerEvent(agentEv("w-a", "running", { turnStartedAt: clock.t }));
    engine.onLogEntry("t", doneEntry("w-b", clock.t));
    clock.t = T0 + 16 * MIN + 26 * MIN;
    engine.onRunnerEvent({ kind: "timeline", agentId: "w-a" });
    await engine.tick();
    assert.equal(delivered.length, 1, "no escalation for a running or reported worker");
    assert.equal(nudges.length, 0);
  } finally {
    sb.cleanup();
  }
});

test("escalation: only idle-no-report stalls escalate (a closed worker is not nudged or escalated)", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", team: "t", lane: "l", items: [{ kind: "agent", ref: "w-x" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock, nudges } = escEngine(sb);
    engine.onRunnerEvent(agentEv("w-x", "closed"));
    await engine.tick();
    assert.equal(delivered.length, 1, "stall ping for closed");
    clock.t = T0 + 120 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.equal(nudges.length, 0);
  } finally {
    sb.cleanup();
  }
});

test("escalation: a cancelled set never escalates", async () => {
  const sb = sandbox();
  try {
    const { id } = addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-idle" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock, nudges } = escEngine(sb);
    engine.onRunnerEvent(agentEv("w-idle", "idle"));
    await engine.tick();
    clock.t = T0 + 16 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 1);
    cancelWatch(id, "lead-1", { home: sb.home, now: clock.t });
    clock.t += 100 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.equal(nudges.length, 0);
  } finally {
    sb.cleanup();
  }
});

test("escalation (H1): siblings finishing after the stall ping do not close the set; it escalates, then completes once", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", team: "t", lane: "l", items: [{ kind: "agent", ref: "w-idle" }, { kind: "agent", ref: "w-a" }, { kind: "agent", ref: "w-b" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock, nudges } = escEngine(sb);
    for (const id of ["w-idle", "w-a", "w-b"]) engine.onRunnerEvent(agentEv(id, "idle"));
    await engine.tick();
    clock.t = T0 + 16 * MIN;
    await engine.tick(); // stall ping (w-idle; w-a/w-b stall too unless they report): report them first
    clock.t = T0 + 20 * MIN;
    engine.onLogEntry("t", doneEntry("w-a", clock.t));
    engine.onLogEntry("t", doneEntry("w-b", clock.t));
    await engine.tick();
    assert.equal(engine.list()[0].firedAt, undefined, "the set stays armed while the idle worker owes escalation");
    clock.t = T0 + 16 * MIN + 25 * MIN;
    await engine.tick();
    assert.equal(delivered.at(-1).target, "owner");
    assert.equal(nudges.length, 1);
    clock.t += 25 * MIN;
    await engine.tick();
    assert.equal(delivered.at(-1).target, "overlord");
    // escalation exhausted: the completion ping may now close the set, and nothing escalates afterwards
    clock.t += 5 * MIN;
    await engine.tick();
    assert.ok(engine.list()[0].firedAt, "completion fires after the escalation is exhausted");
    const n = delivered.length;
    clock.t += 200 * MIN;
    await engine.tick();
    assert.equal(delivered.length, n);
    assert.equal(nudges.length, 1);
  } finally {
    sb.cleanup();
  }
});

test("escalation (H1): a 1-of-1 idle set escalates owner then Overlord", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-only" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = escEngine(sb);
    engine.onRunnerEvent(agentEv("w-only", "idle"));
    await engine.tick();
    clock.t = T0 + 16 * MIN;
    await engine.tick();
    clock.t += 25 * MIN;
    await engine.tick();
    clock.t += 25 * MIN;
    await engine.tick();
    assert.deepEqual(delivered.map((d) => d.target), [undefined, "owner", "overlord"]);
  } finally {
    sb.cleanup();
  }
});

test("escalation (H2): a turn started by our own nudge does not stop the Overlord step", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-n" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock, nudges } = escEngine(sb);
    engine.onRunnerEvent(agentEv("w-n", "idle"));
    await engine.tick();
    clock.t = T0 + 16 * MIN;
    await engine.tick();
    clock.t += 25 * MIN;
    await engine.tick(); // esc1 + nudge
    assert.equal(nudges.length, 1);
    // the worker answers the nudge: a turn starts right after, runs, and ends with no report
    clock.t += 10_000;
    engine.onRunnerEvent(agentEv("w-n", "running"));
    engine.onRunnerEvent({ kind: "turn_started", agentId: "w-n" });
    await engine.tick();
    clock.t += 2 * MIN;
    engine.onRunnerEvent(agentEv("w-n", "idle"));
    await engine.tick();
    clock.t += 30 * MIN; // idle again past stallMin, 25+ min after esc1
    await engine.tick();
    assert.equal(delivered.at(-1).target, "overlord", "still escalates to the Overlord");
    assert.equal(nudges.length, 1);
  } finally {
    sb.cleanup();
  }
});

test("escalation (H2): a real turn (not the nudge's) stops escalation, as does a report", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-r" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = escEngine(sb);
    engine.onRunnerEvent(agentEv("w-r", "idle"));
    await engine.tick();
    clock.t = T0 + 16 * MIN;
    await engine.tick();
    clock.t += 25 * MIN;
    await engine.tick(); // esc1 + nudge (ignored by this worker)
    // minutes later the lead pokes it: a real turn, no report
    clock.t += 10 * MIN;
    engine.onRunnerEvent(agentEv("w-r", "running"));
    engine.onRunnerEvent({ kind: "turn_started", agentId: "w-r" });
    await engine.tick();
    clock.t += 2 * MIN;
    engine.onRunnerEvent(agentEv("w-r", "idle"));
    await engine.tick();
    clock.t += 60 * MIN;
    await engine.tick();
    assert.equal(delivered.filter((d) => d.target === "overlord").length, 0, "a real turn ends the episode");
  } finally {
    sb.cleanup();
  }
});

test("escalation (Medium): a tick before the first agent snapshot holds the state, then resumes", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-s" }] }, { home: sb.home, now: T0 });
    const clock = { t: T0 };
    const a = escEngine(sb, { clock });
    a.engine.onRunnerEvent(agentEv("w-s", "idle"));
    await a.engine.tick();
    clock.t = T0 + 16 * MIN;
    await a.engine.tick();
    clock.t += 25 * MIN;
    await a.engine.tick(); // esc1
    clock.t += 24 * MIN;
    // restart: a tick runs before any snapshot arrives
    const b = escEngine(sb, { clock });
    clock.t += 1 * MIN;
    await b.engine.tick();
    assert.equal(b.delivered.length, 0, "nothing fires before the first snapshot");
    assert.equal(b.engine.list()[0].items[0].reason, "idle-no-report", "the idle state is held, not reset to no-events");
    b.engine.onRunnerEvent(agentEv("w-s", "idle"));
    await b.engine.tick();
    assert.equal(b.delivered.length, 1);
    assert.equal(b.delivered[0].target, "overlord", "resumes at the Overlord step");
  } finally {
    sb.cleanup();
  }
});

test("escalation survives a server restart: persisted steps are not re-fired, the pending one still fires", async () => {
  const sb = sandbox();
  try {
    addWatch({ owner: "lead-1", team: "t", lane: "l", items: [{ kind: "agent", ref: "w-idle" }] }, { home: sb.home, now: T0 });
    const clock = { t: T0 };
    let a = escEngine(sb, { clock });
    a.engine.onRunnerEvent(agentEv("w-idle", "idle"));
    await a.engine.tick();
    clock.t = T0 + 16 * MIN;
    await a.engine.tick();
    clock.t += 25 * MIN;
    await a.engine.tick();
    assert.equal(a.delivered.length, 2);
    // restart: a new engine on the same home
    const b = escEngine(sb, { clock });
    b.engine.onRunnerEvent(agentEv("w-idle", "idle"));
    await b.engine.tick();
    assert.equal(b.delivered.length, 0, "stall + owner re-ping not re-sent");
    assert.equal(b.nudges.length, 0, "nudge not re-sent");
    clock.t += 25 * MIN;
    await b.engine.tick();
    assert.equal(b.delivered.length, 1);
    assert.equal(b.delivered[0].target, "overlord");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// idea-160 R3: plugin-level Overlord fallback chain + idle nudge (resolveWatchOverlord / nudgeIdleWorker)
// ---------------------------------------------------------------------------

const ag = (id, team, lane, role, status = "idle") => ({
  id,
  title: id,
  cwd: `/projects/${team === "efi" ? "EFI" : team === "nf" ? "NF" : "VibeSquad"}`,
  status,
  provider: "claude",
  labels: { team, lane, role },
});

/** Runs a watch through stall + esc1 + esc2 on a fake clock inside the real plugin; returns what each agent was sent and the plugin log. */
async function escalateInPlugin(sb, agents, { team, lane, owner = "own", worker = "w", onRefresh } = {}) {
  const clock = { t: Date.now() };
  addWatch({ owner, team, lane, items: [{ kind: "agent", ref: worker }] }, { home: sb.home, now: clock.t });
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = console.error = (...a) => void logs.push(a.join(" "));
  const h = await pluginHarness(sb, agents, { watchSets: { now: () => clock.t }, onRefresh });
  const step = async (min) => {
    clock.t += min * MIN;
    await h.watch.tick();
    await wait(250);
    await h.watch.tick();
  };
  try {
    await h.watch.tick();
    await step(16);
    await step(26);
    await step(26);
  } finally {
    console.log = origLog;
    console.error = origErr;
    h.stop();
  }
  return { sent: h.sent, logs };
}

const esc2 = /escalation 2\/2/;

test(
  "plugin R3: Overlord step goes to the Squad's flagged hub Lead (EFI), the owner gets the stall + esc1 pings",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["own", ag("own", "efi", "main-game", "lead")],
      ["hub", ag("hub", "efi", "efi", "lead")],
      ["vs-hub", ag("vs-hub", "vibesquad", "vibesquad", "lead")],
      ["w", ag("w", "efi", "main-game", "worker")],
    ]);
    const { sent, logs } = await escalateInPlugin(sb, agents, { team: "efi", lane: "main-game" });
    assert.equal(sent.filter((x) => x.to === "hub" && esc2.test(x.text)).length, 1, JSON.stringify(sent));
    assert.equal(sent.filter((x) => x.to === "own" && /escalation 1\/2/.test(x.text)).length, 1);
    assert.equal(sent.filter((x) => x.to === "vs-hub").length, 0);
    assert.ok(!logs.some((l) => /escalation 2 goes to/.test(l)), "no fallback needed");
  }),
);

test(
  "plugin R3: a Squad with no hub flag but lane id == team id still resolves its hub Lead (isHubCwd fallback)",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["own", ag("own", "nf", "ln", "lead")],
      ["hub", ag("hub", "nf", "nf", "lead")],
      ["w", ag("w", "nf", "ln", "worker")],
    ]);
    const { sent } = await escalateInPlugin(sb, agents, { team: "nf", lane: "ln" });
    assert.equal(sent.filter((x) => x.to === "hub" && esc2.test(x.text)).length, 1, JSON.stringify(sent));
  }),
);

test(
  "plugin R3: no live hub Lead in the Squad -> the vibesquad Overlord, logged",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["own", ag("own", "efi", "main-game", "lead")],
      ["vs-hub", ag("vs-hub", "vibesquad", "vibesquad", "lead")],
      ["w", ag("w", "efi", "main-game", "worker")],
    ]);
    const { sent, logs } = await escalateInPlugin(sb, agents, { team: "efi", lane: "main-game" });
    assert.equal(sent.filter((x) => x.to === "vs-hub" && esc2.test(x.text)).length, 1, JSON.stringify(sent));
    assert.ok(logs.some((l) => /escalation 2 goes to the vibesquad Overlord vs-hub/.test(l)), logs.join("\n"));
  }),
);

test(
  "plugin R3: no Overlord anywhere -> the watch owner's target, logged (the ping is not dropped)",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["own", ag("own", "efi", "main-game", "lead")],
      ["w", ag("w", "efi", "main-game", "worker")],
    ]);
    const { sent, logs } = await escalateInPlugin(sb, agents, { team: "efi", lane: "main-game" });
    assert.equal(sent.filter((x) => x.to === "own" && esc2.test(x.text)).length, 1, JSON.stringify(sent));
    assert.ok(logs.some((l) => /no live Overlord anywhere; escalation 2 goes to the owner's target own/.test(l)), logs.join("\n"));
  }),
);

test(
  "plugin R3: nudgeIdleWorker sends the nudge once to an idle worker",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["own", ag("own", "efi", "main-game", "lead")],
      ["w", ag("w", "efi", "main-game", "worker")],
    ]);
    const { sent } = await escalateInPlugin(sb, agents, { team: "efi", lane: "main-game" });
    assert.equal(sent.filter((x) => x.to === "w" && /went idle without a report/.test(x.text)).length, 1, JSON.stringify(sent));
  }),
);

test(
  "plugin R3: nudgeIdleWorker never sends to a worker that is running at send time",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["own", ag("own", "efi", "main-game", "lead")],
      ["w", ag("w", "efi", "main-game", "worker")],
    ]);
    // the worker is idle for the engine's snapshots, then busy by the time the nudge re-reads it
    // reads of "w": 1 first tick, 2 stall tick, 3 esc1 tick (engine snapshot), 4 = the nudge's own re-read
    let reads = 0;
    const onRefresh = (id) => {
      if (id === "w" && ++reads >= 4) agents.get("w").status = "running";
    };
    const { sent } = await escalateInPlugin(sb, agents, { team: "efi", lane: "main-game", onRefresh });
    assert.equal(sent.filter((x) => x.to === "w").length, 0, JSON.stringify(sent));
  }),
);

test("idea-209/210: a cancelled set never fires again (stall or completion), also after a restart; list hides closed sets; prune at 24h", async () => {
  const sb = sandbox();
  try {
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }, { kind: "agent", ref: "w-2" }] }, { home: sb.home, now: T0 });
    const keep = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-9" }] }, { home: sb.home, now: T0 }).id;
    const a = engineFor(sb);
    a.engine.onRunnerEvent(agentEv("w-1", "running"));
    a.engine.onRunnerEvent(agentEv("w-2", "running"));
    assert.deepEqual(cancelWatch(id, "lead-1", { home: sb.home, now: T0 + 1 }), { ok: true, id });
    // Stall + completion conditions after the cancel: nothing is delivered.
    a.engine.onRunnerEvent({ kind: "roster", agents: [{ id: "w-1", status: "closed", lost: true, resumable: true }] });
    a.clock.t = T0 + 30 * MIN;
    await a.engine.tick();
    a.engine.onRunnerEvent(agentEv("w-1", "idle"));
    a.engine.onRunnerEvent(agentEv("w-2", "idle"));
    a.engine.onLogEntry("vibesquad", doneEntry("w-1", a.clock.t + 1));
    a.engine.onLogEntry("vibesquad", doneEntry("w-2", a.clock.t + 2));
    a.clock.t += 60 * MIN;
    await a.engine.tick();
    assert.equal(a.delivered.filter((d) => d.setId === id).length, 0, "no ping for the cancelled set");
    assert.equal(a.engine.get(id).firedAt, undefined);
    a.engine.stop?.();
    // Server restart: a fresh engine reloads the persisted set and still never fires it.
    const b = engineFor(sb, { clock: { t: a.clock.t + MIN } });
    b.engine.onRunnerEvent({ kind: "roster", agents: [{ id: "w-1", status: "closed", lost: true }, { id: "w-2", status: "idle" }] });
    b.clock.t += 60 * MIN;
    await b.engine.tick();
    b.clock.t += 60 * MIN;
    await b.engine.tick();
    assert.equal(b.delivered.filter((d) => d.setId === id).length, 0, "no ping after a restart");
    assert.equal(b.engine.get(id).firedAt, undefined);
    // list: default hides cancelled, --all shows it.
    assert.deepEqual(listWatches({}, { home: sb.home }).map((s) => s.id), [keep]);
    assert.equal(listWatches({ all: true }, { home: sb.home }).length, 2);
    // prune: a cancelled set older than 24h is dropped from the file on the next write.
    addWatch({ owner: "lead-1", items: [{ kind: "suite" }] }, { home: sb.home, now: T0 + 25 * 60 * MIN });
    assert.equal(listWatches({ all: true }, { home: sb.home }).some((s) => s.id === id), false, "pruned after 24h");
    b.engine.stop?.();
  } finally {
    sb.cleanup();
  }
});
