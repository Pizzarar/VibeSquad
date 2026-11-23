import test from "node:test";
import assert from "node:assert/strict";
import { createDiskAlarm, startDiskAlarm, driveOf, defaultVolumeKey } from "../server/disk-alarm.mjs";

const MIN = 60_000;
// Volume labels: win32 keys a volume by drive letter; elsewhere by device id (dev:<id>), so the fixture maps C:/D: to two fake devices.
const WIN = process.platform === "win32";
const LBL = { c: WIN ? "C:" : "dev:1", d: WIN ? "D:" : "dev:2" };
const fakeVolumeKey = async (p) => (driveOf(p) === "C:" ? "dev:1" : "dev:2");
function setup(pctRef) {
  let t = 1_000_000;
  const logs = [];
  const alarm = createDiskAlarm({
    targets: ["C:\\data\\sanctuary", "D:\\projects"],
    stat: async (p) => ({ total: 1000 * 1024 ** 3, free: (driveOf(p) === "C:" ? pctRef.c : pctRef.d) * 10 * 1024 ** 3 }),
    now: () => t,
    ...(WIN ? {} : { volumeKey: fakeVolumeKey }),
    log: async (type, text) => logs.push({ type, text }),
  });
  return { alarm, logs, advance: (m) => (t += m * MIN) };
}

test("driveOf normalizes to uppercase X: for backslash, forward-slash and mixed-case roots", () => {
  assert.equal(driveOf("C:\\a\\b"), "C:");
  assert.equal(driveOf("c:\\a\\b"), "C:");
  assert.equal(driveOf("c:/a/b"), "C:");
  assert.equal(driveOf("D:\\"), "D:");
  assert.equal(driveOf("D:"), "D:");
});

test("logs a metric per drive, then at most hourly unless pct moves >2", async () => {
  const p = { c: 50, d: 50 };
  const { alarm, logs, advance } = setup(p);
  await alarm.tick();
  assert.deepEqual(logs.map((l) => l.text), [`disk-free drive=${LBL.c} free=500.0 pct=50`, `disk-free drive=${LBL.d} free=500.0 pct=50`]);
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
  assert.ok(needs()[0].text.includes(LBL.c), needs()[0].text);
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

test("paths on one drive (any case/slash) give one reading", async () => {
  const logs = [];
  let stats = 0;
  const alarm = createDiskAlarm({
    targets: ["C:\\data\\sanctuary", "c:\\work\\projects", "C:/other"],
    stat: async () => { stats++; return { total: 1000, free: 500 }; },
    log: async (type, text) => logs.push({ type, text }),
  });
  const r = await alarm.tick();
  assert.equal(stats, 1);
  assert.equal(r.length, 1);
  assert.equal(logs.length, 1);
});

test("a failed needs-you write is retried next tick (alarmed only set after success)", async () => {
  let fail = true;
  const logs = [];
  const alarm = createDiskAlarm({
    targets: ["C:\\data"],
    stat: async () => ({ total: 1000, free: 100 }),
    now: () => 1,
    log: async (type, text) => {
      if (type === "needs-you" && fail) throw new Error("disk full");
      logs.push({ type, text });
    },
  });
  await assert.rejects(alarm.tick(), /disk full/);
  fail = false;
  await alarm.tick();
  assert.equal(logs.filter((l) => l.type === "needs-you").length, 1);
});

test("enabled startDiskAlarm ticks at start and stop() clears the interval", async () => {
  let called = 0;
  const h = startDiskAlarm({ env: {}, tickMs: 5, targets: ["C:\\data"], stat: async () => { called++; return { free: 900, total: 1000 }; }, log: async () => {} });
  assert.notEqual(h.disabled, true);
  await new Promise((r) => setTimeout(r, 40));
  h.stop();
  const n = called;
  assert.ok(n >= 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(called, n);
});

test("off win32 a volume is its device id: dev:<id>, shared by paths on one device, from the nearest existing ancestor", async () => {
  const probe = async (p) => {
    if (p === "/mnt/a" || p === "/mnt/a/sub") return { dev: 7 };
    if (p === "/") return { dev: 1 };
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  assert.equal(await defaultVolumeKey("/mnt/a/sub", "linux", probe), "dev:7");
  assert.equal(await defaultVolumeKey("/mnt/a/not/yet/created", "linux", probe), "dev:7");
  assert.equal(await defaultVolumeKey("/home/u", "linux", probe), "dev:1");
  assert.equal(await defaultVolumeKey("D:/x", "win32", probe), "D:");
});
