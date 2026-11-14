import assert from "node:assert/strict";
import test from "node:test";
import { createLoopLagMonitor } from "../runner/loop-lag.mjs";

function rig() {
  let t = 1_000_000;
  let cpu = { user: 0, system: 0 };
  const lines = [];
  const m = createLoopLagMonitor({ proc: "t", file: "x", now: () => t, cpuUsage: () => ({ ...cpu }), heapUsed: () => 42, append: async (_f, l) => { lines.push(JSON.parse(l)); } });
  return { m, lines, adv: (ms) => { t += ms; }, burn: (u, s = 0) => { cpu = { user: cpu.user + u, system: cpu.system + s }; } };
}

test("no line for normal ticks or drift under 500ms", async () => {
  const r = rig();
  r.adv(100); r.m.tick(); r.adv(550); r.m.tick(); // drift 450
  await r.m.flush();
  assert.equal(r.lines.length, 0);
  assert.equal(r.m.stats().lagMaxMs, 0);
});

test("drift over 500ms logs one line with heap and cpu delta; stats count >1s", async () => {
  const r = rig();
  r.adv(100); r.m.tick();
  r.burn(300_000, 100_000); r.adv(700); r.m.tick(); // drift 600
  r.adv(1300); r.m.tick(); // drift 1200
  await r.m.flush();
  assert.equal(r.lines.length, 2);
  assert.deepEqual({ proc: r.lines[0].proc, driftMs: r.lines[0].driftMs, heapUsed: r.lines[0].heapUsed, cpuUserMs: r.lines[0].cpuUserMs, cpuSystemMs: r.lines[0].cpuSystemMs }, { proc: "t", driftMs: 600, heapUsed: 42, cpuUserMs: 300, cpuSystemMs: 100 });
  assert.deepEqual(r.m.stats(), { lagMaxMs: 1200, lagOver1sLast5m: 1 });
  r.adv(301_000); // window slides past both
  assert.equal(r.m.stats().lagOver1sLast5m, 0);
  assert.equal(r.m.stats().lagMaxMs, 1200);
});

test("cpu window above 50% of a core logs cpuPct; below does not", async () => {
  const r = rig();
  r.adv(30_000); r.burn(10_000_000, 1_000_000); r.m.cpuTick(); // 11s / 30s = 37%
  r.adv(30_000); r.burn(14_000_000, 2_000_000); r.m.cpuTick(); // 16s / 30s = 53%
  await r.m.flush();
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].cpuPct, 53);
});
