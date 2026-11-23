import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkQuotaAlerts, activeQuotaAlerts, readQuotaState } from "../server/quota-alert.mjs";

const T = Date.parse("2026-11-24T00:00:00Z");
const R1 = "2026-11-26T07:00:00.000Z", R2 = "2026-12-03T07:00:00.000Z";

function rig({ pushEnabled = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-quota-"));
  const r = { home, pushes: [], logs: [], sample: null };
  r.limits = () => [r.sample];
  r.set = (usedPct, resetsAt = R1, provider = "claude") => { r.sample = { provider, window: "weekly", usedPct, resetsAt }; };
  r.check = (extra = {}) => checkQuotaAlerts({
    home, readLimits: r.limits, now: () => T, pushEnabled: () => pushEnabled,
    push: async (p) => { r.pushes.push(p); }, runVs: async (a) => { r.logs.push(a); return { ok: true }; }, ...extra,
  });
  return r;
}

test("97 -> 98 -> 99 -> 98.5 same resetsAt fires exactly once", async () => {
  const r = rig();
  for (const v of [97, 98, 99, 98.5]) { r.set(v); await r.check(); }
  assert.equal(r.pushes.length, 1);
  assert.equal(r.logs.length, 1);
  assert.equal(r.pushes[0].title, "Claude weekly: 2% left");
  assert.equal(r.pushes[0].body, "resets in 2d; spend a reset now?");
  assert.equal(r.pushes[0].url, "/?focus=usage");
  assert.equal(r.pushes[0].kind, "needs-you");
  assert.deepEqual(r.logs[0], ["log", "needs-you", `Claude weekly 2% left, resets ${R1}`, "--team", "vibesquad", "--lane", "usage"]);
});

test("a new resetsAt at 98 fires again", async () => {
  const r = rig();
  r.set(98); await r.check();
  r.set(98, R2); await r.check();
  assert.equal(r.pushes.length, 2);
  assert.equal(r.logs.length, 2);
});

test("re-instantiating (state re-read from disk) does not re-fire", async () => {
  const r = rig();
  r.set(99); await r.check();
  assert.ok(readQuotaState(r.home).fired[`claude|weekly|${R1}`]);
  r.set(99); await r.check();
  assert.equal(r.pushes.length, 1);
  assert.equal(r.logs.length, 1);
});

test("needsYou push disabled: no push, still logs", async () => {
  const r = rig({ pushEnabled: false });
  r.set(98); await r.check();
  assert.equal(r.pushes.length, 0);
  assert.equal(r.logs.length, 1);
});

test("86% and non-claude providers do not fire", async () => {
  const r = rig();
  r.set(86); await r.check();
  r.set(99, R1, "gemini"); await r.check();
  assert.equal(r.pushes.length + r.logs.length, 0);
});

test("past resetsAt does not fire", async () => {
  const r = rig();
  r.set(99, "2026-11-23T07:00:00.000Z"); await r.check();
  assert.equal(r.pushes.length, 0);
});

test("a failing push still logs and does not re-fire", async () => {
  const r = rig();
  r.set(98);
  await r.check({ push: async () => { throw new Error("boom"); } });
  await r.check();
  assert.equal(r.logs.length, 1);
});

test("activeQuotaAlerts: fired + still >=98 + before resetsAt, payload shape", async () => {
  const r = rig();
  r.set(98); 
  assert.deepEqual(activeQuotaAlerts([r.sample], r.home, { now: T }), []); // not fired yet
  await r.check();
  assert.deepEqual(activeQuotaAlerts([r.sample], r.home, { now: T }), [
    { provider: "claude", window: "weekly", usedPct: 98, resetsAt: R1, firedAt: new Date(T).toISOString() },
  ]);
  assert.deepEqual(activeQuotaAlerts([{ ...r.sample, usedPct: 90 }], r.home, { now: T }), []);
  assert.deepEqual(activeQuotaAlerts([r.sample], r.home, { now: Date.parse(R1) + 1 }), []);
});

test("watcher: mtime/size short-circuit, no overlap while busy, stop() clears the timer", async () => {
  const { startQuotaAlertWatcher } = await import("../server/quota-alert.mjs");
  let st = { mtimeMs: 1, size: 10 };
  let reads = 0, cleared = null, release;
  const gate = new Promise((r) => { release = r; });
  let block = false;
  const handle = {};
  const w = startQuotaAlertWatcher({
    home: "/nonexistent-vs-home", stat: () => st, setIntervalFn: () => handle, clearIntervalFn: (t) => { cleared = t; },
    readLimits: () => { reads++; return []; }, push: async () => {}, runVs: async () => ({ ok: true }),
    now: () => T, pushEnabled: () => true,
  });
  await w.tick(); await w.tick();
  assert.equal(reads, 1, "unchanged signature skips the read");
  st = { mtimeMs: 2, size: 20 };
  block = true;
  // second watcher-style overlap: a blocked check must not be re-entered
  const w2 = startQuotaAlertWatcher({
    home: "/nonexistent-vs-home", stat: () => st, setIntervalFn: () => handle, clearIntervalFn: () => {},
    readLimits: () => { reads++; return [{ provider: "claude", window: "weekly", usedPct: 99, resetsAt: R1 }]; },
    push: async () => { await gate; }, runVs: async () => ({ ok: true }), now: () => T, pushEnabled: () => true,
  });
  const before = reads;
  const p1 = w2.tick(); const p2 = w2.tick();
  await p2;
  release(); await p1;
  assert.ok(reads - before <= 1, "overlapping tick did not run a second check");
  w.stop();
  assert.equal(cleared, handle);
  void block;
});

test("quota-alerts route: light payload, no usage fold", async () => {
  const { handleProvidersApi } = await import("../server/providers-catalog.mjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vs-quota-"));
  let out;
  await handleProvidersApi({ method: "GET", url: "/__vibesquad/providers/quota-alerts" }, {}, { home, sendJson: (_r, code, data) => { out = { code, data }; } });
  assert.equal(out.code, 200);
  assert.deepEqual(out.data, { quotaAlerts: [] });
});
