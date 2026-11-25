import test from "node:test";
import assert from "node:assert/strict";
import { createCrunchSetter } from "../src/crunchMode.ts";

// C3 r1 (Review-Gemini M1/M2/L1): behaviour of the Crunch writer, no source regexes.
function harness(disk = () => true) {
  const log = { starts: [], ends: [], rollbacks: 0, inflight: 0, maxInflight: 0 };
  const gates = [];
  const setCrunch = createCrunchSetter({
    save: (teamId, on) => new Promise((resolve) => {
      log.starts.push([teamId, on]);
      log.inflight++; log.maxInflight = Math.max(log.maxInflight, log.inflight);
      gates.push(() => { log.inflight--; log.ends.push([teamId, on]); resolve({ disk: disk(teamId, on) }); });
    }),
    rollback: () => { log.rollbacks++; },
  });
  const tick = () => new Promise((r) => setImmediate(r));
  return { setCrunch, log, gates, tick };
}

test("double flip on one Squad serializes: one write at a time, one write each, final state wins", async () => {
  const h = harness();
  const a = h.setCrunch("vs", true);
  const b = h.setCrunch("vs", false);
  await h.tick();
  assert.deepEqual(h.log.starts, [["vs", true]], "second write waits for the first");
  h.gates.shift()();
  assert.equal(await a, true);
  await h.tick();
  assert.deepEqual(h.log.starts, [["vs", true], ["vs", false]]);
  h.gates.shift()();
  assert.equal(await b, true);
  assert.equal(h.log.maxInflight, 1);
  assert.deepEqual(h.log.ends, [["vs", true], ["vs", false]], "last write is the final state");
  assert.equal(h.log.rollbacks, 0);
});

test("different Squads do not block each other", async () => {
  const h = harness();
  const a = h.setCrunch("a", true);
  const b = h.setCrunch("b", true);
  await h.tick();
  assert.equal(h.log.maxInflight, 2);
  h.gates.splice(0).forEach((g) => g());
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
});

test("a failed save rolls back and resolves false; the queue keeps going", async () => {
  const h = harness((_t, on) => on === false); // turning ON fails, OFF lands
  const a = h.setCrunch("vs", true);
  const b = h.setCrunch("vs", false);
  await h.tick(); h.gates.shift()();
  assert.equal(await a, false);
  assert.equal(h.log.rollbacks, 1);
  await h.tick(); h.gates.shift()();
  assert.equal(await b, true);
  assert.equal(h.log.rollbacks, 1, "no rollback for the write that landed");
});

test("a save that throws counts as failed and rolls back", async () => {
  let rolled = 0;
  const s = createCrunchSetter({ save: async () => { throw new Error("net"); }, rollback: () => { rolled++; } });
  assert.equal(await s("vs", true), false);
  assert.equal(rolled, 1);
});
