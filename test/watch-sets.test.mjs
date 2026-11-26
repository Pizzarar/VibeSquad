// Watch sets (docs/PLAN_COMPLETION_DIGEST_RELAY.md W1): registry, state machine, one-shot fire, persistence across a restart,
// stall pings, retired-owner reroute, and the hold-back of watched items from the normal per-event wakes.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunnerBackend } from "../server/backend/runner-backend.mjs";
import { addWatch, cancelWatch, createWatchEngine, listWatches, reownWatches, reownWatchesAsync, watchesPath, DIGEST_MERGE_MAX, SUITE_LOCK_FILE, SUITE_RESULT_FILE, FINAL_TOTAL_CAP, completedTurnText, finalsBlock, finalsTextFor, itemVerdict, verdictBlock, maskVerdictWords } from "../server/watch-sets.mjs";

const T0 = Date.parse("2026-11-10T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "vs-watch-"));
  const home = join(dir, "home");
  const tmp = join(dir, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 }); // the watcher refuses suite files from a group/other-open dir (checkTestLockDir)
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

// Tier A review M1 (forge 11-23): the suite files live in a shared /tmp. A dir another user could write (open mode, a symlink)
// must read as no result, so a forged PASS never satisfies a suite item; once the dir is private again it counts.
test("suite item: a last-run record in a group/other-open or symlinked lock dir is ignored", { skip: process.platform === "win32" && "POSIX modes" }, async () => {
  const sb = sandbox();
  try {
    const pass = JSON.stringify({ agentId: "rn-runner", pid: 111, startedAt: iso(T0 + 1000), full: true, files: [], finishedAt: iso(T0 + 2000), tests: 5, pass: 5, fail: 0, failingFiles: [] });
    // A symlinked dir pointing at a dir holding a PASS record.
    const real = join(sb.dir, "elsewhere");
    mkdirSync(real, { mode: 0o700 });
    writeFileSync(join(real, SUITE_RESULT_FILE), pass);
    const link = join(sb.dir, "linked");
    symlinkSync(real, link);
    const a = addWatch({ owner: "lead-1", items: [{ kind: "suite", ref: "rn-runner" }] }, { home: sb.home, now: T0 });
    const viaLink = engineFor({ ...sb, tmp: link }, { clock: { t: T0 + 3000 } });
    await viaLink.engine.tick();
    assert.equal(viaLink.delivered.length, 0, "a symlinked lock dir is not read");
    viaLink.engine.stop?.();
    // The sandbox's own dir, opened up to group/other.
    writeFileSync(join(sb.tmp, SUITE_RESULT_FILE), pass);
    chmodSync(sb.tmp, 0o775);
    const { engine, delivered, clock } = engineFor(sb, { clock: { t: T0 + 3000 } });
    await engine.tick();
    assert.equal(delivered.length, 0, "an open lock dir is not read");
    assert.notEqual(engine.get(a.id).items[0].state, "done");
    chmodSync(sb.tmp, 0o700);
    clock.t += 1000;
    await engine.tick();
    assert.equal(engine.get(a.id).items[0].state, "done", "the same record counts from a private dir");
    assert.match(delivered[0]?.text ?? "", /suite \(rn-runner\): done — PASS 5\/5 pass/);
  } finally {
    sb.cleanup();
  }
});

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

// idea-996: the stall clock of a restart item starts at the request's window, not when the watch was armed.
test("restart item: a request queued for a future window is not stalled before the window; a past window that never ran stalls after window + stall", async () => {
  const sb = sandbox();
  try {
    const win = T0 + 6 * 60 * MIN;
    writeFileSync(join(sb.home, "restart-request.json"), JSON.stringify({ current: { id: "rr-7560", tip: "abc", state: "queued", windowAt: iso(win) }, history: [] }));
    const w = addWatch({ owner: "lead-1", stallMin: 15, items: [{ kind: "restart", ref: "rr-7560" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = engineFor(sb);
    clock.t = T0 + 60 * MIN; // armed long ago, window still ahead: the old clock would have stalled it
    await engine.tick();
    clock.t = win - MIN;
    await engine.tick();
    assert.equal(delivered.length, 0, "not stalled before the window");
    clock.t = win + 10 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 0, "not stalled inside window + stallMin");
    clock.t = win + 16 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].text, /stalled \(no-result\)/);
    assert.equal(delivered[0].setId, w.id);
  } finally {
    sb.cleanup();
  }
});

test("restart item (idea-996): no-ref watch follows the open request; draining waits for its deadline, urgent promotion ignores the stale window; done/aborted and other ids are ignored", async () => {
  const run = async (reqDoc, ref, probes) => {
    const sb = sandbox();
    try {
      writeFileSync(join(sb.home, "restart-request.json"), JSON.stringify(reqDoc));
      addWatch({ owner: "lead-1", stallMin: 15, items: [{ kind: "restart", ...(ref ? { ref } : {}) }] }, { home: sb.home, now: T0 });
      const { engine, delivered, clock } = engineFor(sb);
      const out = [];
      for (const at of probes) { clock.t = at; await engine.tick(); out.push(delivered.length); }
      return out;
    } finally { sb.cleanup(); }
  };
  const win = T0 + 6 * 60 * MIN;
  // no ref, queued future window: quiet until window + 15
  assert.deepEqual(await run({ current: { id: "rr-1", state: "queued", windowAt: iso(win) }, history: [] }, "", [T0 + MIN, T0 + 60 * MIN, win + 10 * MIN, win + 16 * MIN]), [0, 0, 0, 1]);
  // draining: window long past, deadline ahead
  assert.deepEqual(await run({ current: { id: "rr-1", state: "draining", windowAt: iso(T0 + 10 * MIN), deadline: iso(T0 + 120 * MIN) }, history: [] }, "", [T0 + MIN, T0 + 100 * MIN, T0 + 130 * MIN, T0 + 136 * MIN]), [0, 0, 0, 1]);
  // urgent-promoted: state requested, old future windowAt, near deadline -> clock follows the deadline
  assert.deepEqual(await run({ current: { id: "rr-1", state: "requested", windowAt: iso(win), deadline: iso(T0 + 30 * MIN) }, history: [] }, "", [T0 + MIN, T0 + 40 * MIN, T0 + 46 * MIN]), [0, 0, 1]);
  // a done request is ignored (armed-time clock), as is a different id (rr-1 vs rr-10)
  assert.deepEqual(await run({ current: { id: "rr-1", state: "done", windowAt: iso(win) }, history: [] }, "", [T0 + 16 * MIN]), [1]);
  assert.deepEqual(await run({ current: { id: "rr-10", state: "queued", windowAt: iso(win) }, history: [] }, "rr-1", [T0 + 16 * MIN]), [1]);
});

// idea-398 fix round (Hub13): the 11-20 02:54 silent old-code restart. A restart fired by a request whose sync was
// skipped pings with the runtime NOT updated note; a request fired long before, or one that synced, adds nothing.
test("restart item: a restart fired after a skipped sync pings 'runtime NOT updated: still <sha>, N behind <tip>, reason <why>'", async () => {
  const sb = sandbox();
  try {
    const note = "runtime NOT updated: still 1111111, 3 behind abc1234def, reason skipped: working tree not clean (server/a.mjs)";
    writeFileSync(join(sb.home, "restart-request.json"), JSON.stringify({
      current: { id: "rr-new", tip: "abc1234def", state: "firing", firedAt: iso(T0 + MIN), sync: { ok: false, at: iso(T0 + MIN), reason: "skipped: x", note } },
      history: [
        { id: "rr-old", tip: "0000000aaa", state: "done", firedAt: iso(T0 - 5 * 60 * MIN), sync: { ok: false, note: "runtime NOT updated: still OLDOLD" } },
        { id: "rr-ok", tip: "2222222bbb", state: "done", firedAt: iso(T0 - 30 * MIN), sync: { ok: true, commit: "2222222bbb" } },
      ],
    }));
    addWatch({ owner: "lead-1", items: [{ kind: "restart" }] }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = engineFor(sb);
    writeFileSync(join(sb.home, "restart-2026-11-10T12-02-00-000Z.json"), JSON.stringify({ startedAt: iso(T0 + 2 * MIN), finishedAt: iso(T0 + 3 * MIN), ok: true, cutAgents: ["rn-1"], resumedAgents: ["rn-1"] }));
    clock.t = T0 + 4 * MIN;
    await engine.tick();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].text, /restart: done — restart ok: cut 1, resumed 1/);
    assert.ok(delivered[0].text.includes(note), delivered[0].text);
    assert.ok(!delivered[0].text.includes("OLDOLD"), "a request fired hours before is not this restart's");

    const sb2 = sandbox();
    try {
      // A later request that synced supersedes an earlier skipped one: this restart runs the synced runtime.
      writeFileSync(join(sb2.home, "restart-request.json"), JSON.stringify({
        current: { id: "rr-ok", tip: "x", state: "done", firedAt: iso(T0 + MIN), sync: { ok: true } },
        history: [{ id: "rr-skip", tip: "y", state: "done", firedAt: iso(T0 - 10 * MIN), sync: { ok: false, note: "runtime NOT updated: still SKIPPED" } }],
      }));
      addWatch({ owner: "lead-1", items: [{ kind: "restart" }] }, { home: sb2.home, now: T0 });
      const e2 = engineFor(sb2);
      writeFileSync(join(sb2.home, "restart-2026-11-10T12-02-00-000Z.json"), JSON.stringify({ startedAt: iso(T0 + 2 * MIN), finishedAt: iso(T0 + 3 * MIN), ok: true, cutAgents: [] }));
      e2.clock.t = T0 + 4 * MIN;
      await e2.engine.tick();
      assert.equal(e2.delivered.length, 1);
      assert.ok(!e2.delivered[0].text.includes("NOT updated"), e2.delivered[0].text);
    } finally {
      sb2.cleanup();
    }
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

test("idea-219: a set that fired, whose ping is still queued (unsent), can be cancelled: the ping is never delivered", async () => {
  const sb = sandbox();
  try {
    const { id } = addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: T0 });
    const { engine, delivered } = engineFor(sb, { attempt: false, deliver: () => {} }); // owner busy: ping queued, not attempted
    engine.onRunnerEvent(agentEv("w-1", "idle"));
    engine.onLogEntry("vibesquad", doneEntry("w-1", T0 + 1000));
    await engine.tick();
    const fired = engine.get(id);
    assert.ok(fired.firedAt && fired.pings.length === 1 && !fired.pings[0].attemptedAt, "fired, ping pending");
    const key = `${id}#${fired.pings[0].key}`;
    assert.equal(engine.isCancelled(key), false);
    assert.deepEqual(cancelWatch(id, "lead-1", { home: sb.home, now: T0 + 5 }), { ok: true, id }, "cancel accepted while the ping is unsent");
    assert.equal(engine.isCancelled(key), true, "delivery recheck sees the cancel");
    const b = engineFor(sb);
    await b.engine.tick();
    assert.equal(b.delivered.length, 0, "no delivery after cancel, also after a restart");
    assert.equal(listWatches({ owner: "lead-1", all: true }, { home: sb.home })[0].status, "cancelled");
    assert.equal(delivered.length, 0);
    // Once the ping was attempted (sent), cancel is too late.
    const { id: id2 } = addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-2" }] }, { home: sb.home, now: T0 });
    const c = engineFor(sb);
    c.engine.onRunnerEvent(agentEv("w-2", "idle"));
    c.engine.onLogEntry("vibesquad", doneEntry("w-2", T0 + 1000));
    await c.engine.tick();
    assert.equal(c.delivered.length, 1);
    assert.equal(cancelWatch(id2, "lead-1", { home: sb.home }).ok, false);
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
    // idea-883: the code-read verdict block leads the fallback, then the raw text's prefix.
    assert.match(delivered[0].text, /^Verdicts \(read in code[^\n]*\n- agent w-1: NO VERDICT\n/, "verdict block leads the fallback");
    assert.equal(delivered[0].text.includes(`\n${ping.text.slice(0, DIGEST_MERGE_MAX)}`), true, "fallback carries the raw text's prefix");
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

test("reownWatches (idea-418): moves armed and fired-but-unsent sets to the successor, leaves history and other owners alone", () => {
  const sb = sandbox();
  try {
    const opts = { home: sb.home, now: T0 };
    const armed = addWatch({ owner: "old", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }] }, opts).id;
    const pending = addWatch({ owner: "old", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-2" }] }, opts).id;
    const sent = addWatch({ owner: "old", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-3" }] }, opts).id;
    const cancelled = addWatch({ owner: "old", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-4" }] }, opts).id;
    const other = addWatch({ owner: "someone", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-5" }] }, opts).id;
    cancelWatch(cancelled, "old", opts);
    // Hand-fire two sets: one whose ping is still queued (no attemptedAt), one already sent.
    const file = watchesPath({ home: sb.home });
    const doc = JSON.parse(readFileSync(file, "utf8"));
    for (const s of doc.sets) {
      if (s.id === pending) Object.assign(s, { firedAt: iso(T0), pings: [{ key: "done", at: iso(T0), text: "x" }] });
      if (s.id === sent) Object.assign(s, { firedAt: iso(T0), pings: [{ key: "done", at: iso(T0), text: "x", attemptedAt: iso(T0) }] });
    }
    writeFileSync(file, JSON.stringify(doc));

    const res = reownWatches({ from: "old", to: "new", reason: "handoff trigger=self" }, { home: sb.home, now: T0 + MIN });
    assert.deepEqual([...res.reowned].sort(), [armed, pending].sort());
    const all = new Map(listWatches({ all: true }, { home: sb.home }).map((s) => [s.id, s]));
    assert.equal(all.get(armed).owner, "new");
    assert.equal(all.get(pending).owner, "new");
    assert.deepEqual(all.get(armed).reowned, [{ from: "old", at: iso(T0 + MIN), reason: "handoff trigger=self" }]);
    assert.equal(all.get(sent).owner, "old", "a fully sent set is history");
    assert.equal(all.get(cancelled).owner, "old", "a cancelled set is history");
    assert.equal(all.get(other).owner, "someone");
    // Idempotent: a repeat moves nothing; the successor may now cancel what it owns (idea-219: even the queued ping).
    assert.deepEqual(reownWatches({ from: "old", to: "new" }, { home: sb.home }).reowned, []);
    assert.equal(cancelWatch(pending, "new", { home: sb.home, allow: (s) => s.owner === "new" }).ok, true);
    assert.equal(cancelWatch(armed, "new", { home: sb.home, allow: (s) => s.owner === "new" }).ok, true);
    // `ids` limits the move; from === to is a no-op; a blank side throws.
    const a2 = addWatch({ owner: "new", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-6" }] }, opts).id;
    const b2 = addWatch({ owner: "new", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-7" }] }, opts).id;
    assert.deepEqual(reownWatches({ from: "new", to: "newer", ids: [b2] }, { home: sb.home }).reowned, [b2]);
    assert.deepEqual(listWatches({ owner: "new" }, { home: sb.home }).map((s) => s.id), [a2]);
    assert.deepEqual(reownWatches({ from: "new", to: "new" }, { home: sb.home }).reowned, []);
    assert.throws(() => reownWatches({ from: "", to: "x" }, { home: sb.home }), /from and to are required/);
  } finally {
    sb.cleanup();
  }
});

test("reownWatchesAsync (idea-418): concurrent re-owns under the file lock move each set exactly once", async () => {
  const sb = sandbox();
  try {
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(addWatch({ owner: "old", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: `w-${i}` }] }, { home: sb.home, now: T0 }).id);
    const results = await Promise.all([
      reownWatchesAsync({ from: "old", to: "new" }, { home: sb.home }),
      reownWatchesAsync({ from: "old", to: "new" }, { home: sb.home }),
      reownWatchesAsync({ from: "old", to: "new" }, { home: sb.home }),
    ]);
    const moved = results.flatMap((r) => r.reowned);
    assert.deepEqual([...moved].sort(), [...ids].sort(), "every set moved once, by exactly one writer");
    for (const s of listWatches({}, { home: sb.home })) {
      assert.equal(s.owner, "new");
      assert.equal(s.reowned.length, 1);
    }
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
    ...(extra.deps ?? {}),
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
      assert.match(toNew[0].text, /Watch owner lead-old is retired; the watch is now yours as the lane's lead/);
      assert.match(toNew[0].text, new RegExp(`vs watch cancel ${id}`));
      assert.equal(h.watch.get(id).pings[0].to, "lead-new");
      // idea-418: the first fallback delivery re-owned the set, so the successor may cancel it.
      assert.equal(h.watch.get(id).owner, "lead-new");
      assert.equal(h.watch.get(id).reowned?.[0]?.from, "lead-old");
      assert.equal(h.watch.get(id).reowned?.[0]?.reason, "retired-owner delivery");
    } finally {
      h.stop();
    }
  }),
);

test(
  "plugin (idea-871): a live '(old)'-titled lead that armed the watch is skipped: the ping goes to the new lead, the old one gets nothing",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["lead-old", { ...mk("lead-old", "lead"), title: "(old) Bug1" }],
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
      assert.equal(h.sent.filter((s) => s.to === "lead-old").length, 0, JSON.stringify(h.sent));
      const toNew = h.sent.filter((s) => s.to === "lead-new" && s.text.includes(`Watch ${id}`));
      assert.equal(toNew.length, 1, JSON.stringify(h.sent));
    } finally {
      h.stop();
    }
  }),
);

test(
  "plugin (idea-871): a former-lead owner gets nothing; a lone '(old)' lead with no successor keeps today's delivery",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["lead-old", { ...mk("lead-old", "lead"), title: "(old) Bug1" }],
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
      const toOld = h.sent.filter((s) => s.to === "lead-old" && s.text.includes(`Watch ${id}`));
      assert.equal(toOld.length, 1, "no lead at all: the owner still gets its ping");
    } finally {
      h.stop();
    }
  }),
);

test(
  "plugin (idea-418): a stall ping for a retired owner re-owns the still-armed set, which the successor may then cancel",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["lead-old", mk("lead-old", "former-lead")],
      ["lead-new", mk("lead-new", "lead")],
      ["w-1", mk("w-1", "worker", "vibesquad", { "vs.parent": "lead-new" })],
      ["w-2", mk("w-2", "worker", "vibesquad", { "vs.parent": "lead-new" })],
    ]);
    const now = Date.now();
    const { id } = addWatch(
      { owner: "lead-old", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }, { kind: "agent", ref: "w-2" }] },
      { home: sb.home, now: now - 1000 },
    );
    const h = await pluginHarness(sb, agents);
    try {
      writeLog(sb, [{ ts: iso(now), agent: "w-1", lane: "vibesquad", type: "blocker", text: "BLOCKED: w1 needs a decision", refs: [] }]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      const first = h.sent.filter((s) => s.to === "lead-new" && s.text.includes(`Watch ${id}`));
      assert.equal(first.length, 1, JSON.stringify(h.sent));
      assert.match(first[0].text, /the watch is now yours/);
      const set = listWatches({ owner: "lead-new" }, { home: sb.home }).find((x) => x.id === id);
      assert.ok(set, "the armed set is listed under the successor");
      assert.equal(set.status, "armed");
      assert.equal(listWatches({ owner: "lead-old" }, { home: sb.home }).length, 0);
      // The successor (owner now) passes the verb's owner rule.
      const res = cancelWatch(id, "lead-new", { home: sb.home, allow: (x) => x.owner === "lead-new" });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(h.sent.filter((s) => s.to === "lead-old").length, 0);
    } finally {
      h.stop();
    }
  }),
);

test(
  "plugin (idea-418): an owner the refresh cannot read (hiccup) only reroutes the ping; the set is not re-owned",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["lead-new", mk("lead-new", "lead")],
      ["w-1", mk("w-1", "worker")],
    ]);
    const now = Date.now();
    const { id } = addWatch({ owner: "lead-ghost", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: now - 1000 });
    const h = await pluginHarness(sb, agents);
    try {
      writeLog(sb, [{ ts: iso(now), agent: "w-1", lane: "vibesquad", type: "done", text: "PASS: w1", refs: [] }]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      const toNew = h.sent.filter((s) => s.to === "lead-new");
      assert.equal(toNew.length, 1, JSON.stringify(h.sent));
      assert.match(toNew[0].text, /Watch owner lead-ghost is retired; delivered to you as the lane's lead\./);
      assert.equal(h.watch.get(id).owner, "lead-ghost", "no positive retired read: ownership unchanged");
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
      assert.match(toLead[0].text, /MERGED: 6 done, all \[verdict↑\]/, "idea-883: the merge worker's verdict word is masked");
      assert.match(toLead[0].text, /^Verdicts \(read in code[^\n]*\n- agent w-1: NO VERDICT\n/, "idea-883: the code-read verdict block leads");
      assert.doesNotMatch(toLead[0].text, /\(\+\d+ chars, see vs log\)$/, "no truncated fallback when the merge succeeds");
    } finally {
      h.stop();
    }
  }),
);

test(
  "plugin (idea-418): an over-long completion ping for a retired owner spawns the Flash merge for the successor; the fired set stays history",
  withPluginEnv(async (sb) => {
    const refs = ["w-1", "w-2", "w-3", "w-4", "w-5", "w-6"];
    const agents = new Map([
      ["lead-old", mk("lead-old", "former-lead")],
      ["lead-new", mk("lead-new", "lead")],
      ...refs.map((r) => [r, mk(r, "worker")]),
    ]);
    const now = Date.now();
    const { id } = addWatch({ owner: "lead-old", team: "vibesquad", lane: "vibesquad", items: refs.map((ref) => ({ kind: "agent", ref })) }, { home: sb.home, now: now - 1000 });
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
      assert.equal(spawns.length, 1, "one Flash worker spawned");
      assert.equal(h.sent.filter((s) => s.to === "lead-old").length, 0, "nothing goes to the retired owner");
      const toNew = h.sent.filter((s) => s.to === "lead-new");
      assert.equal(toNew.length, 1, JSON.stringify(h.sent));
      assert.match(toNew[0].text, /MERGED: 6 done, all \[verdict↑\]/);
      // W4 marks the ping attempted before the spawn: the fired set has nothing left to send or cancel, so it is not re-owned.
      const set = h.watch.get(id);
      assert.ok(set.firedAt && set.pings.every((p) => p.attemptedAt));
      assert.equal(set.owner, "lead-old");
      assert.equal(set.reowned, undefined);
    } finally {
      h.stop();
    }
  }),
);

test(
  "plugin (idea-418): an over-long stall ping for a retired owner spawns the Flash merge for the successor and re-owns the still-armed set",
  withPluginEnv(async (sb) => {
    const refs = ["w-1", "w-2", "w-3", "w-4", "w-5", "w-6"];
    const agents = new Map([
      ["lead-old", mk("lead-old", "former-lead")],
      ["lead-new", mk("lead-new", "lead")],
      ...refs.map((r) => [r, mk(r, "worker")]),
    ]);
    const now = Date.now();
    const { id } = addWatch({ owner: "lead-old", team: "vibesquad", lane: "vibesquad", items: refs.map((ref) => ({ kind: "agent", ref })) }, { home: sb.home, now: now - 1000 });
    const spawns = [];
    const h = await pluginHarness(sb, agents, {
      create: async (payload) => {
        spawns.push(payload);
        return { id: "flash-1", waitForFinish: async () => ({ status: "idle" }) };
      },
      timelineFor: (aid) => (aid === "flash-1" ? [{ item: { type: "assistant_message", text: "MERGED: 5 blocked" } }] : []),
    });
    try {
      // Five long blockers (w-6 still running): one stall ping over DIGEST_MERGE_MAX, and the set stays armed.
      writeLog(sb, refs.slice(0, 5).map((ref, i) => ({ ts: iso(now + i), agent: ref, lane: "vibesquad", type: "blocker", text: `BLOCKED: ${longReport(ref)}`, refs: [] })));
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      await h.watch.tick();
      const set = h.watch.get(id);
      assert.ok(!set.firedAt, "the set is still armed");
      assert.ok(set.pings[0].text.length > DIGEST_MERGE_MAX, `stall ping is over-long (${set.pings[0].text.length})`);
      assert.equal(spawns.length, 1, "one Flash worker spawned");
      assert.equal(h.sent.filter((s) => s.to === "lead-old").length, 0, "nothing goes to the retired owner");
      const toNew = h.sent.filter((s) => s.to === "lead-new");
      assert.equal(toNew.length, 1, JSON.stringify(h.sent));
      assert.match(toNew[0].text, /MERGED: 5 blocked/);
      assert.equal(set.owner, "lead-new", "the digest path adopts the armed set for the successor");
      assert.deepEqual(set.reowned.map((r) => [r.from, r.reason]), [["lead-old", "retired-owner delivery"]]);
      assert.equal(cancelWatch(id, "lead-new", { home: sb.home, allow: (x) => x.owner === "lead-new" }).ok, true);
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

// ---- idea-351 / idea-353: notices that need no decision must not cost the lead a turn -------------------------------------

test(
  "plugin idea-351: only events for agents IN the lead's watch are suppressed: an unwatched done, and a pre-watch done naming a watched agent, still wake an idle lead",
  withPluginEnv(async (sb) => {
    const agents = new Map([["lead-1", mk("lead-1", "lead")], ["w-1", mk("w-1", "worker")], ["w-2", mk("w-2", "worker")]]);
    const now = Date.now();
    addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now });
    const h = await pluginHarness(sb, agents);
    try {
      writeLog(sb, [{ ts: iso(now + 5), agent: "w-2", lane: "vibesquad", type: "done", text: "PASS: w2 unwatched", refs: [] }]);
      h.scanLogs(false);
      await wait(150);
      assert.equal(h.sent.length, 1, JSON.stringify(h.sent));
      assert.match(h.sent[0].text, /PASS: w2 unwatched/);
      writeLog(sb, [{ ts: iso(now - 60_000), agent: "w-1", lane: "vibesquad", type: "done", text: "PASS: old w1", refs: [] }]);
      h.scanLogs(false);
      await wait(200);
      assert.equal(h.sent.length, 2, "a pre-watch done is not covered by the set: it wakes");
    } finally {
      h.stop();
    }
  }),
);

test(
  "plugin idea-351: a watched worker's done is still held for the owner (one ping, no extra wake); a blocker from anyone wakes",
  withPluginEnv(async (sb) => {
    const agents = new Map([["lead-1", mk("lead-1", "lead")], ["w-1", mk("w-1", "worker")], ["w-2", mk("w-2", "worker")]]);
    const now = Date.now();
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: now - 1000 });
    const h = await pluginHarness(sb, agents);
    try {
      writeLog(sb, [{ ts: iso(now), agent: "w-1", lane: "vibesquad", type: "done", text: "PASS: w1", refs: [] }]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      assert.equal(h.sent.length, 1, JSON.stringify(h.sent));
      assert.match(h.sent[0].text, new RegExp(`Watch ${id} complete`));
      writeLog(sb, [{ ts: iso(now + 20), agent: "w-2", lane: "vibesquad", type: "blocker", text: "stuck", refs: [] }]);
      h.scanLogs(false);
      await wait(150);
      assert.equal(h.sent.length, 2, "blocker always wakes");
    } finally {
      h.stop();
    }
  }),
);

test(
  "plugin idea-351 (race): a late digest PASS/done within 120s of the watch completing is covered (no extra wake); a late FAIL still wakes; an armed watch's unknown-author done for a watched agent is held",
  withPluginEnv(async (sb) => {
    const agents = new Map([["lead-1", mk("lead-1", "lead")], ["w-1", mk("w-1", "worker")], ["w-2", mk("w-2", "worker")]]);
    const now = Date.now();
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: now - 1000 });
    const h = await pluginHarness(sb, agents);
    try {
      writeLog(sb, [{ ts: iso(now), agent: "w-1", lane: "vibesquad", type: "done", text: "PASS: w1", refs: [] }]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      assert.equal(h.sent.length, 1);
      assert.match(h.sent[0].text, new RegExp(`Watch ${id} complete`));
      writeLog(sb, [{ ts: iso(now + 500), agent: "digest-1", lane: "vibesquad", type: "done", text: "PASS: w1 digest", refs: ["w-1"] }]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      assert.equal(h.sent.length, 1, "late PASS covered by the completed watch: " + JSON.stringify(h.sent));
      writeLog(sb, [{ ts: iso(now + 600), agent: "digest-1", lane: "vibesquad", type: "done", text: "FAIL: w1 late verdict", refs: ["w-1"] }]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      assert.equal(h.sent.length, 2, "FAIL still wakes");
      assert.match(h.sent[1].text, /FAIL: w1 late verdict/);
    } finally {
      h.stop();
    }
  }),
);

test(
  "idea-374: a late NO-VERDICT digest for a watched agent wakes the lead (it is a FAIL-class report, not a covered PASS)",
  withPluginEnv(async (sb) => {
    const agents = new Map([["lead-1", mk("lead-1", "lead")], ["w-1", mk("w-1", "worker")]]);
    const now = Date.now();
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: now - 1000 });
    const h = await pluginHarness(sb, agents);
    try {
      writeLog(sb, [{ ts: iso(now), agent: "w-1", lane: "vibesquad", type: "done", text: "PASS: w1", refs: [] }]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      assert.equal(h.sent.length, 1);
      assert.match(h.sent[0].text, new RegExp(`Watch ${id} complete`));
      writeLog(sb, [{ ts: iso(now + 500), agent: "digest-1", lane: "vibesquad", type: "done", text: "NO-VERDICT: w1 reviewer line missing", refs: ["w-1"] }]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      assert.equal(h.sent.length, 2, "late NO-VERDICT still wakes: " + JSON.stringify(h.sent));
      assert.match(h.sent[1].text, /NO-VERDICT: w1 reviewer line missing/);
    } finally {
      h.stop();
    }
  }),
);

test(
  "plugin idea-351: an armed watch holds an unknown-author done naming its agent (no wake) and an unrelated agent's done still wakes",
  withPluginEnv(async (sb) => {
    const agents = new Map([["lead-1", mk("lead-1", "lead")], ["w-1", mk("w-1", "worker")], ["w-2", mk("w-2", "worker")]]);
    const now = Date.now();
    addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: now - 1000 });
    const h = await pluginHarness(sb, agents);
    try {
      writeLog(sb, [{ ts: iso(now), agent: "digest-9", lane: "vibesquad", type: "done", text: "done: w1 summary", refs: ["w-1"] }]);
      h.scanLogs(false);
      await wait(150);
      assert.equal(h.sent.length, 0, JSON.stringify(h.sent));
      writeLog(sb, [{ ts: iso(now + 10), agent: "w-2", lane: "vibesquad", type: "done", text: "PASS: w2", refs: [] }]);
      h.scanLogs(false);
      await wait(150);
      assert.equal(h.sent.length, 1);
    } finally {
      h.stop();
    }
  }),
);

test("idea-352: the completion ping carries each watched worker's final message once (capped, outside the merge text); a worker's own report is not duplicated", async () => {
  const sb = sandbox();
  try {
    const clock = { t: T0 };
    const long = "PASS: shipped\n" + "detail line ".repeat(300); // > REPORT_CAP and > FINAL_CAP
    const { engine, delivered } = engineFor(sb, { clock, lastMessage: async (ref) => (ref === "w-1" ? long : "PASS: own") });
    engine.onRunnerEvent(agentEv("w-1", "running"));
    engine.onRunnerEvent(agentEv("w-2", "running"));
    const { id } = addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }, { kind: "agent", ref: "w-2" }] }, { home: sb.home, now: clock.t });
    clock.t += MIN;
    engine.onRunnerEvent(agentEv("w-1", "idle"));
    engine.onRunnerEvent(agentEv("w-2", "idle"));
    engine.onRunnerEvent({ kind: "turn_ended", agentId: "w-1" });
    engine.onRunnerEvent({ kind: "turn_ended", agentId: "w-2" });
    // w-2 also filed its own report (author = the worker): its final must not ride the ping a second time
    engine.onLogEntry("vibesquad", { ts: iso(clock.t), agent: "w-2", lane: "vibesquad", type: "done", text: "PASS: own report", refs: ["w-2"] });
    await engine.tick();
    assert.equal(delivered.length, 1, "one completion ping");
    assert.match(delivered[0].text, new RegExp(`Watch ${id} complete`));
    assert.ok(delivered[0].text.length <= DIGEST_MERGE_MAX, "the final messages are not in the W4 merge text");
    assert.match(delivered[0].detail, /Final message of w-1 \(auto-forwarded report\):\nPASS: shipped/);
    assert.match(delivered[0].detail, /truncated; `vs status w-1`/);
    assert.ok(!delivered[0].detail.includes("w-2"), "own report: no second copy");
    assert.ok(delivered[0].detail.length < 1500, "per-item cap");
  } finally {
    sb.cleanup();
  }
});

// ---- idea-419: every relay path to an agent redacts host-path tokens (the ping text, the plain [done] wake, the W4 merge) ----
const HOSTY = /file:|%3A|%5C|Ann|Lee|Program Files|My App|[A-Za-z]:[\\/]|secret/;

test(
  "idea-419 plugin: the watch ping's item reports and the plain [done] wake line are token-redacted (encoded file://, spaced, multi-space paths); the rest stays",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["lead-1", mk("lead-1", "lead")],
      ["w-1", mk("w-1", "worker")],
      ["w-2", mk("w-2", "worker")],
      ["w-3", mk("w-3", "worker")],
    ]);
    const now = Date.now();
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }, { kind: "agent", ref: "w-2" }] }, { home: sb.home, now: now - 1000 });
    const h = await pluginHarness(sb, agents);
    try {
      writeLog(sb, [
        { ts: iso(now), agent: "w-1", lane: "vibesquad", type: "done", text: "PASS: fixed [a.ts](file:///C%3A/Users/Ann%20Lee/AppData/Local/VibeSquad/worktrees/VibeSquad/unit-z/server/a.ts#L3) ok", refs: [] },
        { ts: iso(now + 1), agent: "w-2", lane: "vibesquad", type: "done", text: String.raw`PASS: verified D:\work\Ann  Lee\secret.txt and file://nas/share/secret.md done`, refs: [] },
        { ts: iso(now + 2), agent: "w-3", lane: "vibesquad", type: "done", text: "PASS: w3 ran C:/Program Files/My App/x.exe, ok", refs: [] },
      ]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      await h.watch.tick();
      const toLead = h.sent.filter((s) => s.to === "lead-1");
      const ping = toLead.find((s) => s.text.includes(`Watch ${id}`));
      assert.ok(ping, JSON.stringify(toLead));
      assert.match(ping.text, /PASS: fixed \[a\.ts\]\(server\/a\.ts#L3\) ok/);
      assert.match(ping.text, /PASS: verified <host-path> and <host-path> done/);
      const normal = toLead.find((s) => s.text.startsWith("New team log event"));
      assert.ok(normal, JSON.stringify(toLead));
      assert.match(normal.text, /\[done\] PASS: w3 ran <host-path>, ok\. Run/);
      for (const s of h.sent) {
        assert.doesNotMatch(s.text, HOSTY, s.text);
        assert.doesNotMatch(s.text, /request failed|detail names a host path/, s.text);
      }
    } finally {
      h.stop();
    }
  }),
);

test(
  "idea-419 plugin: the W4 merge worker's prompt and the merged digest it returns are token-redacted",
  withPluginEnv(async (sb) => {
    const refs = ["w-1", "w-2", "w-3", "w-4", "w-5", "w-6"];
    const agents = new Map([["lead-1", mk("lead-1", "lead")], ...refs.map((r) => [r, mk(r, "worker")])]);
    const now = Date.now();
    addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: refs.map((ref) => ({ kind: "agent", ref })) }, { home: sb.home, now: now - 1000 });
    const spawns = [];
    const h = await pluginHarness(sb, agents, {
      create: async (payload) => {
        spawns.push(payload);
        return { id: "flash-1", waitForFinish: async () => ({ status: "idle" }) };
      },
      timelineFor: (aid) => (aid === "flash-1" ? [{ item: { type: "assistant_message", text: String.raw`MERGED: 6 PASS, log at C:\Users\Ann Lee\AppData\x.log ok` } }] : []),
    });
    try {
      writeLog(sb, refs.map((ref, i) => ({ ts: iso(now + i), agent: ref, lane: "vibesquad", type: "done", text: `see file:///C%3A%5CUsers%5CAnn%20Lee%5C${ref}.md ${longReport(ref)}`, refs: [] })));
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      await h.watch.tick();
      assert.equal(spawns.length, 1, "one Flash worker spawned");
      assert.doesNotMatch(spawns[0].prompt, HOSTY, "the merge worker is an agent: no host path in its prompt");
      assert.match(spawns[0].prompt, /see <host-path>/);
      const toLead = h.sent.filter((s) => s.to === "lead-1");
      assert.equal(toLead.length, 1, JSON.stringify(h.sent));
      assert.match(toLead[0].text, /MERGED: 6 \[verdict↑\], log at <host-path> ok/);
      assert.doesNotMatch(toLead[0].text, HOSTY);
    } finally {
      h.stop();
    }
  }),
);

// ---- idea-450: a worker's final message reaches its lead exactly once (watch ping OR [done] relay, never both / N times) ----

test(
  "idea-450: a watched worker's final rides the completion ping once, and a late digest [done] relay does not send it a second time",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["lead-1", mk("lead-1", "lead")],
      ["w-1", mk("w-1", "worker")],
    ]);
    const final = "PASS 0/0/0 deadbeef\n" + "fidelity-detail ".repeat(50); // > REPORT_CAP so it rides the ping's detail
    const clock = { t: Date.now() };
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: clock.t });
    const h = await pluginHarness(sb, agents, {
      timelineFor: (aid) => (aid === "w-1" ? [{ item: { type: "assistant_message", text: final } }] : []),
      watchSets: { now: () => clock.t },
    });
    try {
      // The reviewer finishes its turn (idle + final message): the watch fires on finalText alone, before any digest [done].
      h.watch.onRunnerEvent({ kind: "turn_started", agentId: "w-1" });
      h.watch.onRunnerEvent(agentEv("w-1", "running"));
      clock.t += MIN;
      h.watch.onRunnerEvent(agentEv("w-1", "idle"));
      h.watch.onRunnerEvent({ kind: "turn_ended", agentId: "w-1" });
      clock.t += 20 * MIN;
      await h.watch.tick();
      await wait(250);
      const pings = h.sent.filter((s) => s.to === "lead-1" && s.text.includes(`Watch ${id}`));
      assert.equal(pings.length, 1, JSON.stringify(h.sent));
      assert.match(pings[0].text, /Final message of w-1 \(auto-forwarded report\):/);
      // The digest's [done] lands > COVER_AFTER_FIRE_MS after the fire: the watch no longer holds it, so it relays.
      clock.t += 601_000;
      writeLog(sb, [{ ts: iso(clock.t), agent: "dig-1", lane: "vibesquad", type: "done", text: "PASS 0/0/0 deadbeef: w1 digest verdict", refs: ["w-1"] }]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      const leadText = h.sent.filter((s) => s.to === "lead-1").map((s) => s.text).join("\n");
      assert.equal(leadText.split("auto-forwarded report").length - 1, 1, leadText);
      assert.ok(!leadText.includes("Worker w-1 final message"), "the relay must not re-forward the final: " + leadText);
    } finally {
      h.stop();
    }
  }),
);

test(
  "idea-450: a digest re-running `vs log done` writes a duplicate [done], but the lead is woken once (deduped relay, one forwarded final)",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["lead-1", mk("lead-1", "lead")],
      ["w-1", mk("w-1", "worker")],
    ]);
    const h = await pluginHarness(sb, agents, {
      timelineFor: (aid) => (aid === "w-1" ? [{ item: { type: "assistant_message", text: "PASS: w1 final body" } }] : []),
    });
    try {
      const now = Date.now();
      const done = { ts: iso(now), agent: "dig-1", lane: "vibesquad", type: "done", text: "PASS 0/0/0 abc: w1 done", refs: ["w-1"] };
      writeLog(sb, [done, { ...done, ts: iso(now + 10) }]);
      h.scanLogs(false);
      await wait(250);
      const toLead = h.sent.filter((s) => s.to === "lead-1");
      const relays = toLead.filter((s) => s.text.startsWith("New team log event"));
      assert.equal(relays.length, 1, JSON.stringify(toLead));
      assert.match(toLead[0].text, /Worker w-1 final message \(auto-forwarded report\):/);
      assert.equal(toLead.map((s) => s.text).join("\n").split("auto-forwarded report").length - 1, 1, JSON.stringify(toLead));
    } finally {
      h.stop();
    }
  }),
);

test(
  "idea-450: a duplicate [done] from a SECOND digest agent (same worker + verdict, reworded) is still deduped",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["lead-1", mk("lead-1", "lead")],
      ["w-1", mk("w-1", "worker")],
    ]);
    const h = await pluginHarness(sb, agents, {
      timelineFor: (aid) => (aid === "w-1" ? [{ item: { type: "assistant_message", text: "PASS 1/0/0 deadbeef: w1 body" } }] : []),
    });
    try {
      const now = Date.now();
      writeLog(sb, [
        { ts: iso(now), agent: "dig-1", lane: "vibesquad", type: "done", text: "PASS 1/0/0 deadbeef: w1 done", refs: ["w-1"] },
        { ts: iso(now + 10), agent: "dig-2", lane: "vibesquad", type: "done", text: "PASS 1/0/0 deadbeef: w1 done (retry)", refs: ["w-1"] },
      ]);
      h.scanLogs(false);
      await wait(250);
      const toLead = h.sent.filter((s) => s.to === "lead-1");
      const relays = toLead.filter((s) => s.text.startsWith("New team log event"));
      assert.equal(relays.length, 1, JSON.stringify(toLead));
      assert.equal(toLead.map((s) => s.text).join("\n").split("auto-forwarded report").length - 1, 1, JSON.stringify(toLead));
    } finally {
      h.stop();
    }
  }),
);

test(
  "idea-450 H1: an Overlord's watch ping and the lane lead's [done] relay each get the final (keyed by recipient, not worker)",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["ovl", mk("ovl", "lead", "vibesquad")],
      ["lead-fa", mk("lead-fa", "lead", "feat-alpha")],
      ["w-1", mk("w-1", "worker", "feat-alpha")],
    ]);
    const final = "PASS 0/0/0 deadbeef\n" + "fidelity-detail ".repeat(50);
    const now = Date.now();
    const { id } = addWatch({ owner: "ovl", team: "vibesquad", lane: "feat-alpha", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: now - 1000 });
    const h = await pluginHarness(sb, agents, {
      timelineFor: (aid) => (aid === "w-1" ? [{ item: { type: "assistant_message", text: final } }] : []),
    });
    try {
      writeLog(sb, [{ ts: iso(now), agent: "dig-1", lane: "feat-alpha", type: "done", text: "PASS 0/0/0 deadbeef: w1 done", refs: ["w-1"] }]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      const toOvl = h.sent.filter((s) => s.to === "ovl").map((s) => s.text).join("\n");
      const toFa = h.sent.filter((s) => s.to === "lead-fa").map((s) => s.text).join("\n");
      assert.match(toOvl, new RegExp(`Watch ${id} complete`));
      assert.match(toOvl, /Final message of w-1 \(auto-forwarded report\):/);
      assert.match(toFa, /Worker w-1 final message \(auto-forwarded report\):/, "the lane lead's relay must still carry the final (not suppressed by the Overlord's ping): " + toFa);
    } finally {
      h.stop();
    }
  }),
);

/**
 * idea-524: `owner`'s watch on w-1 (feat-alpha) fires on w-1's final through the real watch ping (marked forwarded on delivery);
 * then (optionally after a later turn with a different final) w-1's digest dg-1 turns up orphaned (a restart left it open past
 * digestStaleMs) and the sweep runs at `now`. Returns the [done] entries the sweep wrote for w-1.
 */
async function orphanSweepAfterWatchPing(sb, owner, { laterFinal = "" } = {}) {
  const agents = new Map([
    ["ovl", mk("ovl", "lead", "vibesquad")],
    ["lead-fa", mk("lead-fa", "lead", "feat-alpha")],
    ["w-1", mk("w-1", "worker", "feat-alpha")],
  ]);
  let current = "PASS 0/0/0 deadbeef: w1 shipped";
  const clock = { t: Date.now() };
  const { id } = addWatch({ owner, team: "vibesquad", lane: "feat-alpha", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: clock.t });
  const h = await pluginHarness(sb, agents, {
    timelineFor: (aid) => (aid === "w-1" ? [{ item: { type: "assistant_message", text: current } }] : []),
    watchSets: { now: () => clock.t },
  });
  try {
    h.watch.onRunnerEvent({ kind: "turn_started", agentId: "w-1" });
    h.watch.onRunnerEvent(agentEv("w-1", "running"));
    clock.t += MIN;
    h.watch.onRunnerEvent(agentEv("w-1", "idle"));
    h.watch.onRunnerEvent({ kind: "turn_ended", agentId: "w-1" });
    clock.t += 20 * MIN;
    await h.watch.tick();
    await wait(250);
    const pings = h.sent.filter((s) => s.to === owner && s.text.includes(`Watch ${id}`));
    assert.equal(pings.length, 1, JSON.stringify(h.sent));
    assert.match(pings[0].text, /PASS 0\/0\/0 deadbeef: w1 shipped/, "the ping carried w-1's final");
    if (laterFinal) current = laterFinal;
    const now = Date.now();
    agents.set("dg-1", { ...mk("dg-1", "worker", "feat-alpha", { digestFor: "w-1" }), createdAt: iso(now - 20 * MIN) });
    assert.deepEqual(await h.stop.sweepStaleDigests(now), ["dg-1"], "the orphaned digest is archived");
    const log = join(sb.home, "teams", "vibesquad", "log.jsonl");
    const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    return lines.filter((e) => e.type === "done" && (e.refs ?? []).includes("w-1"));
  } finally {
    h.stop();
  }
}

test(
  "idea-524: orphan sweep — the lane lead's own watch ping already delivered w-1's final, so no duplicate UNVERIFIED [done]",
  withPluginEnv(async (sb) => {
    const done = await orphanSweepAfterWatchPing(sb, "lead-fa");
    assert.equal(done.length, 0, JSON.stringify(done));
  }),
);

test(
  "idea-524 H1: orphan sweep — an Overlord's watch ping does not suppress the lane lead's UNVERIFIED [done]",
  withPluginEnv(async (sb) => {
    const done = await orphanSweepAfterWatchPing(sb, "ovl");
    assert.equal(done.length, 1, JSON.stringify(done));
    assert.equal(done[0].text, "UNVERIFIED (digest orphaned): PASS 0/0/0 deadbeef: w1 shipped");
  }),
);

test(
  "idea-524: orphan sweep — a later turn's different final is still written after the lead got the earlier one",
  withPluginEnv(async (sb) => {
    const done = await orphanSweepAfterWatchPing(sb, "lead-fa", { laterFinal: "FAIL 1/0/0 cafef00d: w1 round two" });
    assert.equal(done.length, 1, JSON.stringify(done));
    assert.equal(done[0].text, "UNVERIFIED (digest orphaned): FAIL 1/0/0 cafef00d: w1 round two");
  }),
);

test(
  "idea-450 H2: digest-first order forwards once — the lead's own watch holds the [done], the watch ping is the one copy",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["lead-1", mk("lead-1", "lead")],
      ["w-1", mk("w-1", "worker")],
    ]);
    const final = "PASS 0/0/0 deadbeef\n" + "fidelity-detail ".repeat(50);
    const now = Date.now();
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: now - 1000 });
    const h = await pluginHarness(sb, agents, {
      timelineFor: (aid) => (aid === "w-1" ? [{ item: { type: "assistant_message", text: final } }] : []),
    });
    try {
      writeLog(sb, [{ ts: iso(now), agent: "dig-1", lane: "vibesquad", type: "done", text: "PASS 0/0/0 deadbeef: w1 done", refs: ["w-1"] }]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      const leadText = h.sent.filter((s) => s.to === "lead-1").map((s) => s.text).join("\n");
      assert.match(leadText, new RegExp(`Watch ${id} complete`));
      assert.equal(leadText.split("auto-forwarded report").length - 1, 1, leadText);
      assert.ok(!leadText.includes("Worker w-1 final message"), "no separate relay in the digest-first order: " + leadText);
    } finally {
      h.stop();
    }
  }),
);

test(
  "idea-450: a short final (carried in the item line, no detail) is still marked forwarded, so the late [done] relay does not double it",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["lead-1", mk("lead-1", "lead")],
      ["w-1", mk("w-1", "worker")],
    ]);
    const short = "PASS: w1 shipped";
    const clock = { t: Date.now() };
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: clock.t });
    const h = await pluginHarness(sb, agents, {
      timelineFor: (aid) => (aid === "w-1" ? [{ item: { type: "assistant_message", text: short } }] : []),
      watchSets: { now: () => clock.t },
    });
    try {
      h.watch.onRunnerEvent({ kind: "turn_started", agentId: "w-1" });
      h.watch.onRunnerEvent(agentEv("w-1", "running"));
      clock.t += MIN;
      h.watch.onRunnerEvent(agentEv("w-1", "idle"));
      h.watch.onRunnerEvent({ kind: "turn_ended", agentId: "w-1" });
      clock.t += 20 * MIN;
      await h.watch.tick();
      await wait(250);
      assert.equal(h.sent.filter((s) => s.to === "lead-1" && s.text.includes(`Watch ${id}`)).length, 1);
      // The digest's [done] lands > COVER_AFTER_FIRE_MS after the fire, so it relays (not held) — but must not re-send the short final.
      clock.t += 601_000;
      writeLog(sb, [{ ts: iso(clock.t), agent: "dig-1", lane: "vibesquad", type: "done", text: "PASS 0/0/0 abc: w1 done", refs: ["w-1"] }]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      const leadText = h.sent.filter((s) => s.to === "lead-1").map((s) => s.text).join("\n");
      assert.equal(leadText.split(short).length - 1, 1, "the short final appears once (item line), not again in the relay: " + leadText);
    } finally {
      h.stop();
    }
  }),
);

// ---- idea-366: a fired watch covers the subject agent's late notices for ~10 min; decision-bearing events still wake ----

/** Fire a one-item watch on w-1 for lead-1, then return the harness and the (advanceable) clock. */
async function firedWatchHarness(sb, extraAgents = []) {
  const agents = new Map([["lead-1", mk("lead-1", "lead")], ["w-1", mk("w-1", "worker")], ...extraAgents]);
  const clock = { t: Date.now() };
  const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: clock.t });
  const h = await pluginHarness(sb, agents, {
    timelineFor: (aid) => (aid === "w-1" ? [{ item: { type: "assistant_message", text: "PASS: w1 shipped" } }] : []),
    watchSets: { now: () => clock.t },
  });
  h.watch.onRunnerEvent({ kind: "turn_started", agentId: "w-1" });
  h.watch.onRunnerEvent(agentEv("w-1", "running"));
  clock.t += MIN;
  h.watch.onRunnerEvent(agentEv("w-1", "idle"));
  h.watch.onRunnerEvent({ kind: "turn_ended", agentId: "w-1" });
  clock.t += MIN;
  await h.watch.tick();
  await wait(250);
  assert.equal(h.sent.filter((s) => s.to === "lead-1" && s.text.includes(`Watch ${id}`)).length, 1, JSON.stringify(h.sent));
  return { h, clock, id };
}
const relaysTo = (h, to) => h.sent.filter((s) => s.to === to && s.text.startsWith("New team log event"));
const logLines = (sb) => readFileSync(join(sb.home, "teams", "vibesquad", "log.jsonl"), "utf8");

test(
  "idea-366: a [done] for a watched agent 5 min after its watch completed is suppressed (still logged)",
  withPluginEnv(async (sb) => {
    const { h, clock } = await firedWatchHarness(sb);
    try {
      clock.t += 5 * MIN;
      writeLog(sb, [{ ts: iso(clock.t), agent: "dig-1", lane: "vibesquad", type: "done", text: "PASS 0/0/0 abc: w1 digest verdict", refs: ["w-1"] }]);
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      assert.equal(relaysTo(h, "lead-1").length, 0, JSON.stringify(h.sent));
      assert.match(logLines(sb), /w1 digest verdict/, "the event stays in the team log");
    } finally {
      h.stop();
    }
  }),
);

test(
  "idea-366: an UNVERIFIED (digest logged nothing) [done] for a recently watched agent is suppressed",
  withPluginEnv(async (sb) => {
    const { h, clock } = await firedWatchHarness(sb);
    try {
      clock.t += 5 * MIN;
      writeLog(sb, [{ ts: iso(clock.t), agent: "dig-1", lane: "vibesquad", type: "done", text: "UNVERIFIED (digest logged nothing): w1 report unread", refs: ["w-1"] }]);
      h.scanLogs(false);
      await wait(250);
      assert.equal(relaysTo(h, "lead-1").length, 0, JSON.stringify(h.sent));
    } finally {
      h.stop();
    }
  }),
);

test(
  "idea-366: a [done] for an UNWATCHED agent still wakes the lead",
  withPluginEnv(async (sb) => {
    const { h, clock } = await firedWatchHarness(sb, [["w-2", mk("w-2", "worker")]]);
    try {
      clock.t += MIN;
      writeLog(sb, [{ ts: iso(clock.t), agent: "dig-2", lane: "vibesquad", type: "done", text: "PASS 0/0/0 abc: w2 done", refs: ["w-2"] }]);
      h.scanLogs(false);
      await wait(250);
      assert.equal(relaysTo(h, "lead-1").length, 1, JSON.stringify(h.sent));
    } finally {
      h.stop();
    }
  }),
);

test(
  "idea-366: a FAIL verdict for a watched agent after its watch ping, and a needs-you, still wake the lead",
  withPluginEnv(async (sb) => {
    const { h, clock } = await firedWatchHarness(sb);
    try {
      clock.t += 3 * MIN;
      writeLog(sb, [{ ts: iso(clock.t), agent: "dig-1", lane: "vibesquad", type: "done", text: "FAIL 1/0/0 abc: w1 regressed", refs: ["w-1"] }]);
      h.scanLogs(false);
      await wait(250);
      assert.equal(relaysTo(h, "lead-1").length, 1, "late FAIL wakes: " + JSON.stringify(h.sent));
      clock.t += MIN;
      writeLog(sb, [{ ts: iso(clock.t), agent: "w-1", lane: "vibesquad", type: "needs-you", text: "w1 needs a decision", refs: ["w-1"] }]);
      h.scanLogs(false);
      await wait(250);
      assert.equal(relaysTo(h, "lead-1").length, 2, "needs-you wakes: " + JSON.stringify(h.sent));
    } finally {
      h.stop();
    }
  }),
);

test(
  "idea-366: a [done] for a watched agent more than 10 min after the watch completed relays again",
  withPluginEnv(async (sb) => {
    const { h, clock } = await firedWatchHarness(sb);
    try {
      clock.t += 11 * MIN;
      writeLog(sb, [{ ts: iso(clock.t), agent: "dig-1", lane: "vibesquad", type: "done", text: "PASS 0/0/0 abc: w1 late", refs: ["w-1"] }]);
      h.scanLogs(false);
      await wait(250);
      assert.equal(relaysTo(h, "lead-1").length, 1, JSON.stringify(h.sent));
    } finally {
      h.stop();
    }
  }),
);

test(
  "idea-450: a new turn re-forwards a NEW final (the dedupe keys on the final hash, not the worker alone)",
  withPluginEnv(async (sb) => {
    const agents = new Map([
      ["lead-1", mk("lead-1", "lead")],
      ["w-1", mk("w-1", "worker")],
    ]);
    let final = "PASS 0/0/0 first\n" + "fidelity-detail ".repeat(50);
    const h = await pluginHarness(sb, agents, {
      timelineFor: (aid) => (aid === "w-1" ? [{ item: { type: "assistant_message", text: final } }] : []),
    });
    try {
      const now = Date.now();
      // First completion: the relay forwards the first final once (no watch).
      writeLog(sb, [{ ts: iso(now), agent: "dig-1", lane: "vibesquad", type: "done", text: "PASS 0/0/0 first: done", refs: ["w-1"] }]);
      h.scanLogs(false);
      await wait(250);
      let leadText = h.sent.filter((s) => s.to === "lead-1").map((s) => s.text).join("\n");
      assert.match(leadText, /PASS 0\/0\/0 first/);
      // A fix round produces a NEW final: it must still forward.
      final = "PASS 0/0/0 second\n" + "fidelity-detail ".repeat(50);
      writeLog(sb, [{ ts: iso(now + 1000), agent: "dig-1", lane: "vibesquad", type: "done", text: "PASS 0/0/0 second: done", refs: ["w-1"] }]);
      h.scanLogs(false);
      await wait(250);
      leadText = h.sent.filter((s) => s.to === "lead-1").map((s) => s.text).join("\n");
      assert.match(leadText, /PASS 0\/0\/0 second/, "the new final must still forward after a new turn: " + leadText);
      assert.equal(leadText.split("auto-forwarded report").length - 1, 2, "two completions, two forwarded finals: " + leadText);
    } finally {
      h.stop();
    }
  }),
);

test("idea-450 unit: finalsBlock refs = full finals delivered (short-in-itemline + long-in-detail), excluding the overflow worker; finalsTextFor drops a skip ref", () => {
  const long = (ch) => "PASS: " + ch.repeat(1300);
  const mkItem = (ref, final, report) => ({ kind: "agent", ref, state: "done", final, report });
  const set = {
    items: [
      mkItem("w-short", "PASS: short", "PASS: short"),
      mkItem("w-l1", long("a"), long("a")),
      mkItem("w-l2", long("b"), long("b")),
      mkItem("w-l3", long("c"), long("c")),
      mkItem("w-l4", long("d"), long("d")),
      mkItem("w-over", long("e"), long("e")),
    ],
  };
  const b = finalsBlock(set);
  // w-short rides the item line; w-l1..w-l4 fill FINAL_TOTAL_CAP (1200 each = 4800, so w-l4 is truncated and w-over is dropped).
  assert.ok(b.refs.includes("w-short"), "short final is marked forwarded (delivered in the item line)");
  assert.ok(b.refs.includes("w-l1") && b.refs.includes("w-l2") && b.refs.includes("w-l3"));
  assert.ok(!b.refs.includes("w-over"), "overflow worker's full final is not delivered, so it is not marked forwarded");
  assert.ok(!b.text.includes("w-over"));
  const filtered = finalsTextFor(set, ["w-l1"]);
  assert.ok(!filtered.includes("w-l1"), "finalsTextFor omits a skip ref (already delivered to this recipient)");
  assert.ok(filtered.includes("w-l2"));
});


test("idea-572: offerPending consults the teams registry (asleep) only for sets with an unsent ping", async () => {
  const sb = sandbox();
  try {
    for (let i = 0; i < 25; i++) addWatch({ owner: "lead-1", team: "quiet", lane: "quiet", items: [{ kind: "agent", ref: `q-${i}` }] }, { home: sb.home, now: T0 });
    const { id } = addWatch({ owner: "lead-1", team: "game", lane: "game", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: T0 });
    const asked = [];
    let sleepy = true;
    const { engine, delivered } = engineFor(sb, { asleep: (team) => { asked.push(team); return sleepy && team === "game"; } });
    engine.onRunnerEvent(agentEv("w-1", "idle"));
    engine.onLogEntry("vibesquad", doneEntry("w-1", T0 + 1000));
    await engine.tick();
    assert.ok(engine.get(id).pings.length >= 1 && engine.get(id).pings.every((p) => !p.attemptedAt), "fired and held (asleep)");
    asked.length = 0;
    await engine.tick();
    assert.equal(delivered.length, 0, "asleep: still held");
    assert.ok(asked.length >= 1, "the set with an unsent ping is checked");
    assert.deepEqual([...new Set(asked)], ["game"], "the 25 sets with nothing to offer never touch the registry");
    sleepy = false;
    await engine.tick();
    assert.equal(delivered.length, 1, "delivered on the first tick after the wake");
    asked.length = 0;
    await engine.tick();
    assert.deepEqual(asked, [], "nothing unsent anywhere: zero registry reads per tick");
    assert.equal(delivered.length, 1);
  } finally {
    sb.cleanup();
  }
});

test("idea-572: isCancelled re-reads the registry only when the file changed, and still sees a cancel at once", async () => {
  const sb = sandbox();
  const fsMod = (await import("node:fs")).default;
  const realRead = fsMod.readFileSync;
  let reads = 0;
  try {
    const { id } = addWatch({ owner: "lead-1", items: [{ kind: "agent", ref: "w-1" }] }, { home: sb.home, now: T0 });
    const { engine } = engineFor(sb, { attempt: false, deliver: () => {} });
    engine.onRunnerEvent(agentEv("w-1", "idle"));
    engine.onLogEntry("vibesquad", doneEntry("w-1", T0 + 1000));
    await engine.tick();
    const key = `${id}#${engine.get(id).pings[0].key}`;
    const wp = watchesPath({ home: sb.home });
    fsMod.readFileSync = function (p, ...rest) { if (String(p) === wp) reads++; return realRead.call(this, p, ...rest); };
    for (let i = 0; i < 5; i++) assert.equal(engine.isCancelled(key), false);
    assert.equal(reads, 0, "an unchanged registry is not re-parsed per check");
    assert.deepEqual(cancelWatch(id, "lead-1", { home: sb.home, now: T0 + 5 }), { ok: true, id });
    reads = 0;
    assert.equal(engine.isCancelled(key), true, "the cancel is seen on the very next check");
    assert.equal(engine.isCancelled(key), true);
    assert.equal(reads, 1, "one re-read for the one change");
  } finally {
    fsMod.readFileSync = realRead;
    sb.cleanup();
  }
});

test(
  "idea-366 H1a: a fix-round [done] after the agent started a NEW turn (post-fire) is not swallowed by the fired watch",
  withPluginEnv(async (sb) => {
    const { h, clock } = await firedWatchHarness(sb);
    try {
      clock.t += 2 * MIN;
      h.watch.onRunnerEvent({ kind: "turn_started", agentId: "w-1" }); // the lead re-prompts the worker without a new watch
      h.watch.onRunnerEvent(agentEv("w-1", "running"));
      clock.t += MIN;
      writeLog(sb, [{ ts: iso(clock.t), agent: "dig-1", lane: "vibesquad", type: "done", text: "PASS 0/0/0 abc: w1 fix round", refs: ["w-1"] }]);
      h.scanLogs(false);
      await wait(250);
      assert.equal(relaysTo(h, "lead-1").length, 1, "the second-turn PASS wakes: " + JSON.stringify(h.sent));
    } finally {
      h.stop();
    }
  }),
);

test(
  "idea-366 H1b: a stalled item's real [done] after its set closed (sibling done) is not swallowed; the done sibling's late digest is",
  withPluginEnv(async (sb) => {
    const agents = new Map([["lead-1", mk("lead-1", "lead")], ["w-1", { ...mk("w-1", "worker"), status: "running" }], ["w-2", { ...mk("w-2", "worker"), status: "closed" }]]);
    let w1Final = false;
    const clock = { t: Date.now() };
    const { id } = addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: [{ kind: "agent", ref: "w-1" }, { kind: "agent", ref: "w-2" }] }, { home: sb.home, now: clock.t });
    const h = await pluginHarness(sb, agents, {
      timelineFor: (aid) => (aid === "w-1" && w1Final ? [{ item: { type: "assistant_message", text: "PASS: w1 shipped" } }] : []),
      watchSets: { now: () => clock.t },
    });
    try {
      for (const w of ["w-1", "w-2"]) {
        h.watch.onRunnerEvent({ kind: "turn_started", agentId: w });
        h.watch.onRunnerEvent(agentEv(w, "running"));
      }
      clock.t += MIN;
      h.watch.onRunnerEvent(agentEv("w-2", "closed")); // w-2 stalls (exited) before reporting: its stall ping goes first
      await h.watch.tick();
      await wait(250);
      clock.t += MIN;
      w1Final = true;
      agents.get("w-1").status = "idle";
      h.watch.onRunnerEvent(agentEv("w-1", "idle")); // then w-1 finishes: the set closes with w-2 still stalled
      h.watch.onRunnerEvent({ kind: "turn_ended", agentId: "w-1" });
      clock.t += MIN;
      await h.watch.tick();
      await wait(250);
      const set = h.watch.get(id);
      assert.ok(set.firedAt, "set closed: " + JSON.stringify(set.items));
      assert.equal(set.items.find((i) => i.ref === "w-2").state, "stalled");
      const before = relaysTo(h, "lead-1").length;
      clock.t += MIN;
      writeLog(sb, [
        { ts: iso(clock.t), agent: "dig-2", lane: "vibesquad", type: "done", text: "PASS 0/0/0 abc: w2 real report", refs: ["w-2"] },
        { ts: iso(clock.t + 1), agent: "dig-1", lane: "vibesquad", type: "done", text: "PASS 0/0/0 def: w1 late digest", refs: ["w-1"] },
      ]);
      h.scanLogs(false);
      await wait(250);
      const relays = relaysTo(h, "lead-1").slice(before).map((s) => s.text).join("\n");
      assert.match(relays, /w2 real report/, "the stalled item's report wakes: " + JSON.stringify(h.sent));
      assert.doesNotMatch(relays, /w1 late digest/, "the done item's late digest stays covered");
    } finally {
      h.stop();
    }
  }),
);

test(
  "idea-366 M1: after a restart (no turn signal) a fired watch covers a [done] at +1 min but a [done] at +5 min wakes",
  withPluginEnv(async (sb) => {
    const { h, clock, id } = await firedWatchHarness(sb);
    h.stop();
    // Simulated restart: a fresh engine/plugin over the same watches.json and log, with an empty in-memory agents map.
    const h2 = await pluginHarness(sb, new Map([["lead-1", mk("lead-1", "lead")], ["w-1", mk("w-1", "worker")]]), { watchSets: { now: () => clock.t } });
    try {
      const fired = timeOfFired(sb, id);
      clock.t = fired + MIN;
      writeLog(sb, [{ ts: iso(clock.t), agent: "dig-1", lane: "vibesquad", type: "done", text: "PASS 0/0/0 abc: w1 digest +1m", refs: ["w-1"] }]);
      h2.scanLogs(false);
      await wait(250);
      assert.equal(relaysTo(h2, "lead-1").length, 0, "+1 min covered: " + JSON.stringify(h2.sent));
      clock.t = fired + 5 * MIN;
      writeLog(sb, [{ ts: iso(clock.t), agent: "w-1", lane: "vibesquad", type: "done", text: "PASS 0/0/0 def: w1 new turn +5m", refs: ["w-1"] }]);
      h2.scanLogs(false);
      await wait(250);
      assert.equal(relaysTo(h2, "lead-1").length, 1, "+5 min wakes: " + JSON.stringify(h2.sent));
    } finally {
      h2.stop();
    }
  }),
);
const timeOfFired = (sb, id) => Date.parse(JSON.parse(readFileSync(join(sb.home, "watches.json"), "utf8")).sets.find((s) => s.id === id).firedAt);

test("idea-575: closed sets past 2h are pruned on any mutation; open and recently fired sets are kept; file round-trips", () => {
  const sb = sandbox();
  try {
    const old = addWatch({ owner: "o", items: [{ kind: "agent", ref: "a-old" }] }, { home: sb.home, now: T0 }).id;
    const fresh = addWatch({ owner: "o", items: [{ kind: "agent", ref: "a-fresh" }] }, { home: sb.home, now: T0 }).id;
    const open = addWatch({ owner: "o", items: [{ kind: "agent", ref: "a-open" }] }, { home: sb.home, now: T0 }).id;
    const file = watchesPath({ home: sb.home });
    const doc = JSON.parse(readFileSync(file, "utf8"));
    const by = (id) => doc.sets.find((s) => s.id === id);
    by(old).firedAt = iso(T0 + 1 * MIN);
    by(old).pings = [{ key: "complete", attemptedAt: iso(T0 + 2 * MIN) }];
    by(fresh).firedAt = iso(T0 + 3 * 60 * MIN - 5 * MIN); // fired 5 min before "now"
    by(fresh).pings = [{ key: "complete", attemptedAt: iso(T0 + 3 * 60 * MIN - 4 * MIN) }];
    writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    // Any mutation (here a new add) at T0+3h prunes the 3h-old done set only.
    const now = T0 + 3 * 60 * MIN;
    const extra = addWatch({ owner: "o", items: [{ kind: "agent", ref: "a-x" }] }, { home: sb.home, now }).id;
    const ids = JSON.parse(readFileSync(file, "utf8")).sets.map((s) => s.id);
    assert.deepEqual(ids, [fresh, open, extra]);
    assert.equal(listWatches({ all: true }, { home: sb.home }).length, 3, "file round-trips and still lists");
  } finally {
    sb.cleanup();
  }
});

test("idea-575: start() prunes a closed set past retention and logs one metric line", async () => {
  const sb = sandbox();
  try {
    const clock = { t: T0 };
    const id = addWatch({ owner: "o", items: [{ kind: "agent", ref: "a-old" }] }, { home: sb.home, now: T0 }).id;
    const file = watchesPath({ home: sb.home });
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.sets[0].firedAt = iso(T0 - 3 * 60 * MIN);
    doc.sets[0].pings = [{ key: "complete", attemptedAt: iso(T0 - 3 * 60 * MIN) }];
    writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    const logs = [];
    const { engine } = engineFor(sb, { clock, log: (m) => logs.push(m) });
    await wait(100);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).sets.some((s) => s.id === id), false, "pruned on load");
    assert.equal(logs.filter((m) => /pruned 1 closed/.test(m)).length, 1, `one metric line: ${logs}`);
  } finally {
    sb.cleanup();
  }
});

test("idea-596: prune metric goes to the mutating engine's own log (not a shared module logger); a fired set with an unsent ping survives; cancel/reown prune", async () => {
  const sb = sandbox();
  try {
    const file = watchesPath({ home: sb.home });
    const mk = (ref) => addWatch({ owner: "o", items: [{ kind: "agent", ref }] }, { home: sb.home, now: T0 }).id;
    const stuck = mk("a-stuck"); const gone = mk("a-gone"); const live = mk("a-live");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    const by = (id) => doc.sets.find((s) => s.id === id);
    by(stuck).firedAt = iso(T0 - 3 * 60 * MIN); by(stuck).pings = [{ key: "complete" }]; // >2h fired, ping never attempted
    by(gone).firedAt = iso(T0 - 3 * 60 * MIN); by(gone).pings = [{ key: "complete", attemptedAt: iso(T0 - 3 * 60 * MIN) }];
    writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    // Engine A is created second-last, engine B last: B's log must receive the line, A's must not (the old module-level logger was last-writer-wins).
    const logsA = []; const logsB = [];
    engineFor(sb, { clock: { t: T0 + 10 * MIN }, log: (m) => logsA.push(m) });
    const { engine: b } = engineFor(sb, { clock: { t: T0 + 10 * MIN }, log: (m) => logsB.push(m) });
    await wait(150);
    const ids = JSON.parse(readFileSync(file, "utf8")).sets.map((s) => s.id);
    assert.equal(ids.includes(stuck), true, "unsent ping keeps a >2h fired set");
    assert.equal(ids.includes(gone), false);
    assert.equal(logsA.filter((m) => /pruned/.test(m)).length + logsB.filter((m) => /pruned/.test(m)).length, 1, `exactly one metric line: ${logsA} | ${logsB}`);
    // cancel prunes a closed set too (sync path: no log, still prunes)
    const doc2 = JSON.parse(readFileSync(file, "utf8"));
    doc2.sets.find((s) => s.id === stuck).cancelledAt = iso(T0 - 3 * 60 * MIN);
    writeFileSync(file, JSON.stringify(doc2, null, 2) + "\n");
    cancelWatch(live, "o", { home: sb.home, now: T0 + 10 * MIN });
    assert.equal(JSON.parse(readFileSync(file, "utf8")).sets.some((s) => s.id === stuck), false, "cancel mutation prunes a closed set");
  } finally {
    sb.cleanup();
  }
});

// ---- idea-883: a watch summary's verdict is read in code from the agent's own verdict line, never from prose/test counts ----

/** The w-d81540c8 shape: a review that opens with passing test counts and puts its FAIL verdict on the LAST line. */
const failLastReview = (hash) =>
  [
    `Reviewed commit \`${hash}\` on \`unit-bug-795-sweep\`.`,
    "### Verification",
    "- `node --test test/worktree-sweep-fetch.test.mjs` — **3/3 pass**",
    "- `node --test test/*worktree*.test.mjs` — **65/65 pass**",
    `- ${"Hard rule: Pass. ".repeat(30)}`,
    "### Findings",
    "- **[High]** fetch throttle is in-memory only.",
    "",
    `FAIL 1/0/3 ${hash}`,
  ].join("\n");

test("idea-883 itemVerdict: the agent's own verdict line, a FAIL anywhere wins, null without one", () => {
  const agent = (report, final) => ({ kind: "agent", ref: "r", state: "done", report, ...(final ? { final } : {}) });
  assert.equal(itemVerdict(agent(failLastReview("4c288c19"))), "FAIL 1/0/3 4c288c19", "trailing FAIL after passing counts");
  assert.equal(itemVerdict(agent("PASS 0/0/2 9aa9be4e\nbody\nFAIL 1/0/0 9aa9be4e")), "FAIL 1/0/0 9aa9be4e", "FAIL beats an earlier PASS");
  assert.equal(itemVerdict(agent("PASS 0/0/2 9aa9be4e — done", "body\nFAIL 0/1/0 9aa9be4e")), "FAIL 0/1/0 9aa9be4e", "a FAIL in the final wins over the report's PASS");
  assert.equal(itemVerdict(agent("**VERDICT: PASS 0/0/1 abcdef12**")), "PASS 0/0/1 abcdef12");
  assert.equal(itemVerdict(agent("tests 3/3 pass, 65/65 pass, all good")), null, "test counts are not a verdict");
  assert.equal(itemVerdict({ kind: "suite", ref: "", state: "done", report: "PASS 3/3 pass" }), null, "only agent items carry reviewer verdicts");
  // Review Low: an orphan-sweep report with no final still reads its verdict under the UNVERIFIED prefix.
  assert.equal(itemVerdict(agent("UNVERIFIED (digest failed): FAIL 1/0/3 4c288c19 reviewer=Review - Gemini: High")), "FAIL 1/0/3 4c288c19");
  assert.equal(itemVerdict(agent("UNVERIFIED (digest orphaned): PASS 0/0/1 9aa9be4e")), "PASS 0/0/1 9aa9be4e");
});

test("idea-883 maskVerdictWords masks Title-case verdict words too; lowercase test counts stay", () => {
  assert.equal(maskVerdictWords("- w-3: Pass | Passed review; Fail, Failed, Fails; No verdict"), "- w-3: [verdict↑] | [verdict↑] review; [verdict↑], [verdict↑], [verdict↑]; [verdict↑]");
  assert.equal(maskVerdictWords("count: 3/3 pass, 65 passed, 0 failed, 1 fail"), "count: 3/3 pass, 65 passed, 0 failed, 1 fail");
  assert.equal(maskVerdictWords("Passport and Failover stay"), "Passport and Failover stay", "whole words only");
});

test("idea-883 completion ping: a FAIL on a long review's last line leads its item line and the head tally; no verdict reads NO VERDICT", async () => {
  const sb = sandbox();
  try {
    const { id } = addWatch({ owner: "lead-1", items: ["rv-1", "rv-2", "im-1"].map((ref) => ({ kind: "agent", ref })) }, { home: sb.home, now: T0 });
    const { engine, delivered, clock } = engineFor(sb);
    for (const ref of ["rv-1", "rv-2", "im-1"]) engine.onRunnerEvent(agentEv(ref, "idle"));
    engine.onLogEntry("vibesquad", doneEntry("rv-1", T0 + 1000, failLastReview("4c288c19")));
    engine.onLogEntry("vibesquad", doneEntry("rv-2", T0 + 1000, "PASS 0/0/2 9aa9be4e\nlooks good"));
    engine.onLogEntry("vibesquad", doneEntry("im-1", T0 + 1000, "Implemented it; 12/12 tests pass. Committed abc1234."));
    clock.t = T0 + 2000;
    await engine.tick();
    const text = engine.get(id).pings[0].text;
    assert.match(text, /^Watch \S+ complete: all 3 items done\. Verdicts: 1 FAIL, 1 PASS, 1 NO VERDICT\./);
    assert.match(text, /\n- agent rv-1: done — FAIL 1\/0\/3 4c288c19 — Reviewed commit/, "the FAIL leads, before the 400-char cap");
    assert.match(text, /\n- agent rv-2: done — PASS 0\/0\/2 9aa9be4e looks good/, "a report already opening with its tag is not double-tagged");
    assert.match(text, /\n- agent im-1: done — NO VERDICT — Implemented it/, "no verdict line: NO VERDICT, never PASS");
    assert.equal(delivered.length, 1);
  } finally {
    sb.cleanup?.();
  }
});

test("idea-883 verdictBlock / maskVerdictWords", () => {
  const set = {
    items: [
      { kind: "agent", ref: "rv-1", state: "done", report: failLastReview("4c288c19") },
      { kind: "agent", ref: "im-1", state: "done", report: "shipped, 3/3 pass" },
      { kind: "agent", ref: "wt-1", state: "waiting" },
      { kind: "suite", ref: "", state: "done", report: "PASS 10/10 pass, 0 fail" },
    ],
  };
  assert.equal(verdictBlock(set).split("\n").slice(1).join("\n"), "- agent rv-1: FAIL 1/0/3 4c288c19\n- agent im-1: NO VERDICT");
  assert.equal(verdictBlock({ items: [{ kind: "agent", ref: "x", state: "waiting" }] }), "");
  assert.equal(maskVerdictWords("rv-1: PASS | commit 4c288c19 | count: 3/3 pass; im-1 FAILED; NO-VERDICT"), "rv-1: [verdict↑] | commit 4c288c19 | count: 3/3 pass; im-1 [verdict↑]; [verdict↑]");
});

test(
  "idea-883 plugin repro (w-d81540c8): the Flash merge's guessed PASS never reaches the lead; the code-read FAIL does",
  withPluginEnv(async (sb) => {
    const refs = ["w-1", "w-2", "w-3", "w-4", "w-5", "w-6"];
    const agents = new Map([["lead-1", mk("lead-1", "lead")], ...refs.map((r) => [r, mk(r, "worker")])]);
    const now = Date.now();
    addWatch({ owner: "lead-1", team: "vibesquad", lane: "vibesquad", items: refs.map((ref) => ({ kind: "agent", ref })) }, { home: sb.home, now: now - 1000 });
    const spawns = [];
    const h = await pluginHarness(sb, agents, {
      create: async (payload) => {
        spawns.push(payload);
        return { id: "flash-1", waitForFinish: async () => ({ status: "idle" }) };
      },
      // What rn-aa8e6664c934 actually wrote for the FAIL 1/0/3 review.
      timelineFor: (aid) => (aid === "flash-1" ? [{ item: { type: "assistant_message", text: "- w-3: PASS | commit 4c288c19 | count: 3/3 fetch, 65/65 worktree pass" } }] : []),
    });
    try {
      const text = (ref) => (ref === "w-3" ? failLastReview("4c288c19") : `PASS 0/0/1 ${"a".repeat(7)}${refs.indexOf(ref)}\n${longReport(ref)}`);
      writeLog(sb, refs.map((ref, i) => ({ ts: iso(now + i), agent: ref, lane: "vibesquad", type: "done", text: text(ref), refs: [] })));
      h.scanLogs(false);
      await h.watch.tick();
      await wait(250);
      await h.watch.tick();
      assert.equal(spawns.length, 1, "one Flash worker spawned");
      assert.match(spawns[0].prompt, /- agent w-3: done — FAIL 1\/0\/3 4c288c19 — /, "the merge input leads w-3's line with its FAIL");
      assert.match(spawns[0].prompt, /Do NOT write PASS, FAIL or any verdict word/);
      const toLead = h.sent.filter((s) => s.to === "lead-1");
      assert.equal(toLead.length, 1, JSON.stringify(h.sent));
      assert.match(toLead[0].text, /\n- agent w-3: FAIL 1\/0\/3 4c288c19\n/);
      assert.doesNotMatch(toLead[0].text, /PASS \| commit 4c288c19/);
      assert.match(toLead[0].text, /- w-3: \[verdict↑\] \| commit 4c288c19/);
    } finally {
      h.stop();
    }
  }),
);

// ---- idea-897: a delivered report must not read as idle-no-report when the turn events were missed ----

test("idea-897: an idle worker whose snapshot lastProgressAt is after the watch was armed counts its final message as the report (no turn events seen)", async () => {
  const sb = mkdtempSync(join(tmpdir(), "vs-watch-897-"));
  try {
    const clock = { t: Date.now() };
    const { id } = addWatch({ owner: "lead-1", team: "t", lane: "l", items: [{ kind: "agent", ref: "rn-w" }], stallMin: 30 }, { home: sb, now: clock.t });
    const snap = { id: "rn-w", status: "idle", lastProgressAt: new Date(clock.t - 60_000).toISOString() }; // last turn progress BEFORE arming
    const sent = [];
    const eng = createWatchEngine({ home: sb, now: () => clock.t, getAgent: async () => snap, lastMessage: async () => "PASS 0/0/0 abc1234 TOTAL 101 specs", deliver: (d) => { sent.push(d); return true; }, retryMs: 0 });
    await eng.tick();
    clock.t += 5 * 60_000;
    snap.lastProgressAt = new Date(clock.t).toISOString(); // the re-task ran and reported; no turn_started/turn_ended reached the engine
    clock.t += 61_000;
    await eng.tick();
    clock.t += 31 * 60_000;
    await eng.tick();
    const w = listWatches({ all: true }, { home: sb }).find((x) => x.id === id);
    assert.equal(w.items[0].state, "done", JSON.stringify(w.items[0]));
    assert.ok(!w.pings.some((p) => /idle-no-report/.test(p.text)), JSON.stringify(w.pings));
    eng.stop?.();
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("idea-897 review H2: a non-turn write (updatedAt moves, lastProgressAt does not) leaves an old final message as idle-no-report", async () => {
  const sb = mkdtempSync(join(tmpdir(), "vs-watch-897b-"));
  try {
    const clock = { t: Date.now() };
    const { id } = addWatch({ owner: "lead-1", team: "t", lane: "l", items: [{ kind: "agent", ref: "rn-w" }], stallMin: 30 }, { home: sb, now: clock.t });
    const snap = { id: "rn-w", status: "idle", lastProgressAt: new Date(clock.t - 60_000).toISOString(), updatedAt: new Date(clock.t - 60_000).toISOString() };
    const sent = [];
    const eng = createWatchEngine({ home: sb, now: () => clock.t, getAgent: async () => snap, lastMessage: async () => "OLD round report", deliver: (d) => { sent.push(d); return true; }, retryMs: 0 });
    await eng.tick();
    clock.t += 5 * 60_000;
    snap.updatedAt = new Date(clock.t).toISOString(); // a label/meta write, not a turn
    clock.t += 61_000;
    await eng.tick();
    clock.t += 31 * 60_000;
    await eng.tick();
    const w = listWatches({ all: true }, { home: sb }).find((x) => x.id === id);
    assert.notEqual(w.items[0].state, "done", JSON.stringify(w.items[0]));
    eng.stop?.();
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("idea-897 review M3: progress advancing past a cached finalText re-reads the timeline instead of delivering the old round's text", async () => {
  const sb = mkdtempSync(join(tmpdir(), "vs-watch-897c-"));
  try {
    const clock = { t: Date.now() };
    const { id } = addWatch({ owner: "lead-1", team: "t", lane: "l", items: [{ kind: "agent", ref: "rn-w" }], stallMin: 30 }, { home: sb, now: clock.t });
    const snap = { id: "rn-w", status: "idle", lastProgressAt: new Date(clock.t - 60_000).toISOString() };
    let msg = "ROUND1 report";
    const eng = createWatchEngine({ home: sb, now: () => clock.t, getAgent: async () => snap, lastMessage: async () => msg, deliver: () => true, retryMs: 0 });
    await eng.tick(); // caches ROUND1 as finalText (floor not met, so not done)
    clock.t += 5 * 60_000;
    msg = "ROUND2 report"; // new turn ran; turn_started/turn_ended never reached the engine
    snap.lastProgressAt = new Date(clock.t).toISOString();
    clock.t += 61_000;
    await eng.tick();
    const w = listWatches({ all: true }, { home: sb }).find((x) => x.id === id);
    assert.equal(w.items[0].state, "done", JSON.stringify(w.items[0]));
    assert.match(String(w.items[0].report ?? ""), /ROUND2/, JSON.stringify(w.items[0]));
    eng.stop?.();
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

test("idea-897 integration: a real idle agent read through RunnerBackend.fetchAgent carries lastProgressAt, and the engine counts the re-task report (meta writes do not)", async () => {
  const sb = mkdtempSync(join(tmpdir(), "vs-watch-897d-"));
  try {
    mkdirSync(join(sb, "agents"), { recursive: true });
    const logFile = join(sb, "agents", "rn-w.jsonl");
    const clock = { t: Date.now() };
    const ev = (seq, ts, type, extra = {}) => JSON.stringify({ seq, ts, type, ...extra }) + "\n";
    writeFileSync(logFile, ev(1, clock.t - 120_000, "input", { text: "go" }) + ev(2, clock.t - 60_000, "output", { text: "round1" }));
    const rec = { id: "rn-w", provider: "claude", status: "idle", cwd: sb, createdAt: clock.t - 120_000, updatedAt: clock.t - 60_000, lastSeq: 2, meta: {} };
    const backend = new RunnerBackend({ client: { home: sb, request: async () => ({ ...rec }) }, hooks: false });
    const { id } = addWatch({ owner: "lead-1", team: "t", lane: "l", items: [{ kind: "agent", ref: "rn-w" }], stallMin: 30 }, { home: sb, now: clock.t });
    let msg = "ROUND1 report";
    const eng = createWatchEngine({ home: sb, now: () => clock.t, getAgent: async (ref) => (await backend.fetchAgent(ref)).agent, lastMessage: async () => msg, deliver: () => true, retryMs: 0 });
    const first = (await backend.fetchAgent("rn-w")).agent;
    assert.ok(first.lastProgressAt, "idle agent read via fetchAgent exposes lastProgressAt");
    await eng.tick(); // caches ROUND1 (progress predates the watch)
    clock.t += 5 * 60_000;
    // a meta/label write moves updatedAt only: must not count as progress
    rec.updatedAt = clock.t; rec.lastSeq = 3;
    appendFileSync(logFile, ev(3, clock.t, "meta", { labels: { a: "b" } }));
    clock.t += 61_000;
    await eng.tick();
    assert.notEqual(listWatches({ all: true }, { home: sb }).find((x) => x.id === id).items[0].state, "done");
    // the re-task ran: real turn output lands in the log
    clock.t += 60_000;
    msg = "ROUND2 report";
    rec.updatedAt = clock.t; rec.lastSeq = 5;
    appendFileSync(logFile, ev(4, clock.t - 1000, "input", { text: "again" }) + ev(5, clock.t, "output", { text: "round2" }));
    await eng.tick();
    const w = listWatches({ all: true }, { home: sb }).find((x) => x.id === id);
    assert.equal(w.items[0].state, "done", JSON.stringify(w.items[0]));
    assert.match(String(w.items[0].report ?? ""), /ROUND2/, JSON.stringify(w.items[0]));
    eng.stop?.();
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});

// ---- idea-942: an archived worker that finished with a final message is done, not STALLED (archived) ----

const A = (text, turnEnd = false) => ({ item: { type: "assistant_message", text }, turnEnd });
const U = { item: { type: "user_message", text: "go" } };
const TOOL = { item: { type: "tool_call", name: "bash" } };
const ERR = { item: { type: "error", message: "boom" } };

// The stub applies the same completedTurnText the production lastMessage uses for an archived worker (completedOnly).
async function archivedRun(entries, status = "idle") {
  const sb = mkdtempSync(join(tmpdir(), "vs-watch-942-"));
  try {
    const clock = { t: Date.now() };
    const { id } = addWatch({ owner: "lead-1", team: "t", lane: "l", items: [{ kind: "agent", ref: "rn-w" }], stallMin: 30 }, { home: sb, now: clock.t });
    const snap = { id: "rn-w", status, archivedAt: new Date(clock.t).toISOString(), lastProgressAt: new Date(clock.t + 1000).toISOString() };
    const eng = createWatchEngine({ home: sb, now: () => clock.t, getAgent: async () => snap, lastMessage: async (_ref, o) => (o?.completedOnly ? completedTurnText(entries) : "NOT-COMPLETED-ONLY"), deliver: () => true, retryMs: 0 });
    await eng.tick();
    clock.t += 61_000;
    await eng.tick();
    const w = listWatches({ all: true }, { home: sb }).find((x) => x.id === id);
    eng.stop?.();
    return { item: w.items[0], pings: w.pings };
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
}

test("idea-942: an archived idle worker whose last turn completed (turn_done) is done and carries the final message", async () => {
  const r = await archivedRun([U, A("PASS 0/0/0 abc1234 TOTAL 5 specs", true)]);
  assert.equal(r.item.state, "done", JSON.stringify(r.item));
  assert.ok(!r.pings.some((p) => /STALLED|archived/.test(p.text)), JSON.stringify(r.pings));
  assert.match(JSON.stringify(r.pings), /PASS 0\/0\/0 abc1234/);
});

test("idea-942: an archived worker with no final message still stalls as archived", async () => {
  const r = await archivedRun([U]);
  assert.equal(r.item.state, "stalled", JSON.stringify(r.item));
  assert.equal(r.item.reason, "archived");
});

test("idea-942: archived mid-turn (intermediate assistant message, no turn_done) stays stalled archived", async () => {
  for (const entries of [[U, A("Let me look at the code")], [U, A("Let me look", false), TOOL]]) {
    const r = await archivedRun(entries);
    assert.equal(r.item.state, "stalled", JSON.stringify(r.item));
    assert.equal(r.item.reason, "archived");
  }
});

test("idea-942: closed (killed mid-turn) and archived is stalled, not done, with or without an intermediate message", async () => {
  for (const entries of [[U, A("partial plan"), TOOL], [U]]) {
    const r = await archivedRun(entries, "closed");
    assert.equal(r.item.state, "stalled", JSON.stringify(r.item));
    assert.notEqual(r.item.state, "done");
  }
});

test("idea-942: crashed-then-archived (error entry, status closed) never reads as done, even after a reply", async () => {
  for (const entries of [[U, ERR], [U, A("reply before the crash", true), U, ERR], [U, A("half a reply"), ERR]]) {
    const r = await archivedRun(entries, "closed");
    assert.equal(r.item.state, "stalled", JSON.stringify(r.item));
  }
  assert.equal(completedTurnText([U, A("done", true)]), "done");
  assert.equal(completedTurnText([U, A("done", true), U, A("new turn, mid")]), "", "a newer unfinished turn is not the final message");
});

test("idea-942: a completed turn on a closed+archived worker is done (the archive killed an already-finished session)", async () => {
  const r = await archivedRun([U, A("PASS 0/0/0 deadbee", true)], "closed");
  assert.equal(r.item.state, "done", JSON.stringify(r.item));
});

// ---- idea-1083: archived worker whose last-seen status is stale "running" (remove event, no fresh snapshot) ----

test("idea-1083: archived worker with a stale running status and a completed final report is done with the report", async () => {
  const r = await archivedRun([U, A("PASS 0/0/3 abc1234 TOTAL 9 specs", true)], "running");
  assert.equal(r.item.state, "done", JSON.stringify(r.item));
  assert.match(JSON.stringify(r.pings), /PASS 0\/0\/3 abc1234/);
});

test("idea-1083: archived worker with a stale running status and NO completed report still stalls as archived", async () => {
  for (const entries of [[U], [U, A("working on it"), TOOL]]) {
    const r = await archivedRun(entries, "running");
    assert.equal(r.item.state, "stalled", JSON.stringify(r.item));
    assert.equal(r.item.reason, "archived");
  }
});

test("idea-1091: archived mid-second-turn with a stale running status does not reuse the prior turn's report", async () => {
  const r = await archivedRun([U, A("old report", true), U, A("mid")], "running");
  assert.equal(r.item.state, "stalled", JSON.stringify(r.item));
  assert.equal(r.item.reason, "archived");
});

test("idea-1093: a remove event inside SNAP_REFRESH_MS of an idle final-read still reads the completed report (finalChecked reset)", async () => {
  const sb = mkdtempSync(join(tmpdir(), "vs-watch-1093-"));
  try {
    const clock = { t: Date.now() };
    const { id } = addWatch({ owner: "lead-1", team: "t", lane: "l", items: [{ kind: "agent", ref: "rn-w" }], stallMin: 30 }, { home: sb, now: clock.t });
    const snap = { id: "rn-w", status: "idle", lastProgressAt: new Date(clock.t + 1000).toISOString() };
    const reads = [];
    const eng = createWatchEngine({ home: sb, now: () => clock.t, getAgent: async () => snap, lastMessage: async (_ref, o) => { reads.push(!!o?.completedOnly); return o?.completedOnly ? completedTurnText([U, A("PASS 0/0/0 abc1234 TOTAL 5 specs", true)]) : ""; }, deliver: () => true, retryMs: 0 });
    await eng.tick(); // idle: the plain final read runs (finalChecked = now) and finds nothing
    assert.deepEqual(reads, [false], "the idle tick did the throttled plain read");
    clock.t += 5_000; // well inside SNAP_REFRESH_MS
    eng.onRunnerEvent({ kind: "remove", agentId: "rn-w" });
    await eng.tick();
    const w = listWatches({ all: true }, { home: sb }).find((x) => x.id === id);
    eng.stop?.();
    assert.deepEqual(reads, [false, true], "the archive read was not throttled by the earlier idle read");
    assert.equal(w.items[0].state, "done", JSON.stringify(w.items[0]));
    assert.match(JSON.stringify(w.pings), /PASS 0\/0\/0 abc1234/);
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
});
