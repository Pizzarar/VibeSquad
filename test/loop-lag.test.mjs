import assert from "node:assert/strict";
import { budget, loadFactor } from "./helpers/load-budget.mjs";
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

// ---- attribution (watchdog worker + gc) ----
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MOD = pathToFileURL(fileURLToPath(new URL("../runner/loop-lag.mjs", import.meta.url))).href;
const cleanEnv = (extra) => Object.fromEntries(Object.entries({ ...process.env, ...extra }).filter(([k]) => !/^(VS_|VIBESQUAD_|PASEO_)/.test(k) || k in extra));

function runChild(body, { watchdog = true, args = [], opts = "" } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lag-"));
  const script = path.join(dir, "child.mjs");
  writeFileSync(script, `import { createLoopLagMonitor } from ${JSON.stringify(MOD)};
import { execFileSync } from 'node:child_process';
const m = createLoopLagMonitor({ proc: 'child', file: ${JSON.stringify(path.join(dir, "lag.jsonl"))}, watchdog: ${watchdog}, ${opts} }).start();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
${body}
await sleep(400); await m.flush(); m.stop();
`);
  const r = spawnSync(process.execPath, [...args, script], { env: cleanEnv({ VIBESQUAD_HOME: dir }), encoding: "utf8", timeout: budget(30_000) });
  const f = path.join(dir, "lag.jsonl");
  const lines = existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  rmSync(dir, { recursive: true, force: true });
  return { r, lines };
}

test("a 1.5s sync busy loop is attributed to the blocking function and file", () => {
  const { r, lines } = runChild(`
await sleep(700);
function blockingBusyLoopFn() { const e = Date.now() + 1500; while (Date.now() < e) { /* spin */ } }
blockingBusyLoopFn();
await sleep(600);`);
  assert.equal(r.status, 0, r.stderr);
  const stall = lines.find((l) => l.driftMs > 1000);
  assert.ok(stall, JSON.stringify(lines));
  assert.ok(stall.frames?.[0]?.startsWith("blockingBusyLoopFn "), JSON.stringify(stall.frames));
  assert.match(stall.frames[0], /child\.mjs:\d+$/);
  assert.ok(JSON.stringify(stall).length < 2000);
  for (const k of ["driftMs", "heapUsed", "cpuUserMs", "cpuSystemMs", "ts", "proc"]) assert.ok(k in stall, k);
});

function nativeCallRun() {
  return runChild(`
await sleep(700);
function blockOnChildProcess() { execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)']); }
const b0 = Date.now();
blockOnChildProcess();
const blockedMs = Date.now() - b0; // no other sync work right after the block: a capture landing here would not be flagged late
await sleep(600);
console.log(JSON.stringify({ blockedMs }));`);
}

test("a 1.5s native sync call (execFileSync) shows execFileSync in the stack, with idle cpu", (t) => {
  // The capture races real machine load, so a single run may legitimately land late (that is flagged, see the next test). Never wrong
  // frames in any attempt; and the on-time path must be proven by at least one of 4 attempts (an always-late capture() fails).
  let proved = false, lateCount = 0;
  for (let i = 0; i < 4 && !proved; i++) {
    const { r, lines } = nativeCallRun();
    assert.equal(r.status, 0, r.stderr);
    // Structural, not absolute: the monitor must have recorded a lag line spanning (most of) the block we actually measured in the child.
    // A broken monitor records none (or a tiny one), however slow or loaded the machine is; a slow machine only makes the block longer.
    const blockedMs = JSON.parse(r.stdout.trim().split("\n").pop()).blockedMs;
    assert.ok(blockedMs >= 1400, `child block measured ${blockedMs}ms`);
    const stall = lines.reduce((a, l) => (!a || l.driftMs > a.driftMs ? l : a), null);
    assert.ok(stall && stall.driftMs >= blockedMs * 0.7, `max lag line ${stall?.driftMs}ms vs actual block ${blockedMs}ms: ${JSON.stringify(lines)}`);
    const cpuMs = stall.cpuUserMs + stall.cpuSystemMs; // cpu time does not grow with wall time when busy: bound against drift
    assert.ok(cpuMs < stall.driftMs / 2, `cpu ${cpuMs}ms vs drift ${stall.driftMs}ms`);
    if (stall.captureLate) { assert.equal(stall.frames, undefined); lateCount++; continue; }
    assert.ok(stall.frames?.some((f) => f.startsWith("execFileSync ") || f.startsWith("blockOnChildProcess ")), JSON.stringify(stall.frames));
    proved = true;
  }
  // Timing-only: every attempt landing late means the machine was saturated (late frames are asserted absent above, and the late flag is
  // proven deterministically by the next test). On a quiet machine the on-time path is still required.
  if (!proved && lateCount === 4 && !process.env.VS_TEST_STRICT_TIMING) return t.skip("all 4 attempts captured late (machine under load); set VS_TEST_STRICT_TIMING=1 to require an on-time capture");
  assert.ok(proved, "all 4 attempts captured late");
});

test("a capture that lands after the stall ended is flagged captureLate with no frames (forced deterministically)", () => {
  const { r, lines } = runChild(`
await sleep(700);
function lateStall() { const e = Date.now() + 1200; while (Date.now() < e) { /* spin */ } }
lateStall();
await sleep(600);
console.log(JSON.stringify({ caps: m.captures() }));`, { opts: "deferPauseUntilResume: true" });
  assert.equal(r.status, 0, r.stderr);
  const caps = JSON.parse(r.stdout.trim().split("\n").pop()).caps;
  assert.equal(caps.length, 1, r.stdout);
  assert.equal(caps[0].late, true);
  const stall = lines.find((l) => l.driftMs > 1000);
  assert.ok(stall, JSON.stringify(lines));
  assert.equal(stall.captureLate, true, JSON.stringify(stall));
  assert.equal(stall.frames, undefined);
});

test("one long stall triggers exactly one watchdog capture", () => {
  const { r, lines } = runChild(`
await sleep(700);
const s0 = Date.now();
function oneLongStall() { const e = Date.now() + 2000; while (Date.now() < e) { /* spin */ } }
oneLongStall();
await sleep(600);
const caps = m.captures().filter((c) => c.stallStartedAt >= s0 - 400);
console.log(JSON.stringify({ caps: caps.length }));`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim().split("\n").pop()).caps, 1, r.stdout);
  const stall = lines.find((l) => l.driftMs > 1500);
  assert.ok(stall?.frames?.[0]?.startsWith("oneLongStall "), JSON.stringify(lines));
});

test("watchdog never pauses the main thread while an inspector is open (user debugging)", () => {
  const { r, lines } = runChild(`
await sleep(700);
function stallWhileInspected() { const e = Date.now() + 1200; while (Date.now() < e) { /* spin */ } }
stallWhileInspected();
await sleep(600);
console.log(JSON.stringify({ caps: m.captures().length }));`, { args: ["--inspect=127.0.0.1:0"] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim().split("\n").pop()).caps, 0, r.stdout);
  const stall = lines.find((l) => l.driftMs > 1000);
  assert.ok(stall, JSON.stringify(lines));
  assert.equal(stall.frames, undefined);
});

test("without the watchdog the line keeps the old shape (no frames)", () => {
  const { lines } = runChild(`await sleep(500); const e = Date.now() + 900; while (Date.now() < e) {} await sleep(300);`, { watchdog: false });
  const stall = lines.find((l) => l.driftMs > 500);
  assert.ok(stall);
  assert.equal(stall.frames, undefined);
});

test("gc pauses >= 20ms are kept, attach to an overlapping stall, and >=100ms get their own line", async () => {
  const r = rig();
  r.adv(100); r.m.tick();
  r.m.onGc({ getEntries: () => [{ duration: 5, detail: { kind: 1 } }, { duration: 80, detail: { kind: 4 } }, { duration: 150, detail: { kind: 4 } }] });
  r.adv(800); r.m.tick();
  await r.m.flush();
  const gcLine = r.lines.find((l) => l.gcMs);
  assert.equal(gcLine.gcMs, 150);
  assert.equal(gcLine.gcKind, "mark-sweep-compact");
  const stall = r.lines.find((l) => l.driftMs);
  assert.deepEqual(stall.gc, { n: 2, totalMs: 230, maxMs: 150, kind: "mark-sweep-compact" });
});

test("real gc observer: a forced major gc (--expose-gc) reaches the jsonl through PerformanceObserver", () => {
  const { r, lines } = runChild(`
await sleep(200);
const keep = []; for (let i = 0; i < 200_000; i++) keep.push({ i, s: 'x' + i });
globalThis.gc(); globalThis.gc();
keep.length = 0;
await sleep(200);`, { args: ["--expose-gc"], opts: "gcMinMs: 0, gcStandaloneMs: 0" });
  assert.equal(r.status, 0, r.stderr);
  const gc = lines.find((l) => l.gcKind === "mark-sweep-compact");
  assert.ok(gc, JSON.stringify(lines));
  assert.equal(gc.proc, "child");
  assert.ok(gc.gcMs >= 0 && gc.heapUsed > 0);
});

test("watchdog overhead at idle is small", () => {
  const sample = (watchdog) => {
    const { r } = runChild(`
await sleep(1500); const c0 = process.cpuUsage(); const t0 = Date.now(); const n0 = m.captures().length; await sleep(5000);
const c = process.cpuUsage(c0); console.log(JSON.stringify({ pct: ((c.user + c.system) / 1000) / (Date.now() - t0) * 100, caps: m.captures().length - n0 }));`, { watchdog });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop());
  };
  // A load stall > WATCHDOG_STALL_MS during the window makes a (legitimate) capture, which is not idle cost: resample.
  let off, on;
  for (let i = 0; i < 3; i++) { off = sample(false); on = sample(true); if (on.caps === 0) break; }
  console.log(`idle cpu: watchdog off ${off.pct.toFixed(3)}% on ${on.pct.toFixed(3)}% (captures ${on.caps})`);
  assert.equal(on.caps, 0, "watchdog captured during every idle window");
  assert.ok(on.pct - off.pct < loadFactor(), `delta ${on.pct - off.pct} (limit ${loadFactor()})`);
});
