import test from "node:test";
import assert from "node:assert/strict";
import { createDiskAlarm, startDiskAlarm, driveOf } from "../server/disk-alarm.mjs";

const MIN = 60_000;
function setup(pctRef) {
  let t = 1_000_000;
  const logs = [];
  const alarm = createDiskAlarm({
    targets: ["C:\data\sanctuary", "D:\projects"],
    stat: async (p) => ({ total: 1000 * 1024 ** 3, free: (driveOf(p) === "C:" ? pctRef.c : pctRef.d) * 10 * 1024 ** 3 }),
    now: () => t,
    log: async (type, text) => logs.push({ type, text }),
  });
  return { alarm, logs, advance: (m) => (t += m * MIN) };
}

test("driveOf", () => assert.equal(driveOf("C:\a\b"), "C:"));

test("logs a metric per drive, then at most hourly unless pct moves >2", async () => {
  const p = { c: 50, d: 50 };
  const { alarm, logs, advance } = setup(p);
  await alarm.tick();
  assert.deepEqual(logs.map((l) => l.text), ["disk-free drive=C: free=500.0 pct=50", "disk-free drive=D: free=500.0 pct=50"]);
  advance(10); await alarm.tick();
  assert.equal(logs.length, 2);
  p.c = 48; advance(10); await alarm.tick(); // 2 points: not >2
  assert.equal(logs.length, 2);
  p.c = 46; advance(10); await alarm.tick(); // 4 from logged 50
  assert.equal(logs.length, 3);
  advance(61); await alarm.tick(); // hourly
  assert.equal(logs.length, 5);
});

test("crossing below 20% raises one needs-you; none repeat in the episode; re-arms above 25%", async () => {
  const p = { c: 30, d: 50 };
  const { alarm, logs, advance } = setup(p);
  const needs = () => logs.filter((l) => l.type === "needs-you");
  await alarm.tick();
  assert.equal(needs().length, 0);
  p.c = 19; advance(10); await alarm.tick();
  assert.equal(needs().length, 1);
  assert.match(needs()[0].text, /C:/);
  p.c = 10; advance(10); await alarm.tick();
  p.c = 22; advance(10); await alarm.tick(); // recovered but not above 25
  p.c = 19; advance(10); await alarm.tick();
  assert.equal(needs().length, 1);
  p.c = 27; advance(10); await alarm.tick(); // re-arm
  p.c = 15; advance(10); await alarm.tick();
  assert.equal(needs().length, 2);
});

test("exactly 20% is not low", async () => {
  const { alarm, logs } = setup({ c: 20, d: 20 });
  await alarm.tick();
  assert.equal(logs.filter((l) => l.type === "needs-you").length, 0);
});

test("VS_DISK_ALARM=0 opts out", async () => {
  let called = 0;
  const h = startDiskAlarm({ env: { VS_DISK_ALARM: "0" }, stat: async () => { called++; return { free: 1, total: 10 }; }, targets: ["C:\\data"] });
  assert.equal(h.disabled, true);
  assert.deepEqual(await h.tick(), []);
  h.stop();
  assert.equal(called, 0);
});

test("a failing stat is skipped, not thrown", async () => {
  const alarm = createDiskAlarm({ targets: ["C:\\data"], stat: async () => { throw new Error("boom"); }, log: async () => {} });
  assert.deepEqual(await alarm.tick(), []);
});
