// idea-1073: an indefinite `vs cap` (no reset time) survives restarts and time; only `vs cap clear` lifts it. A cap with a
// reset time still lapses at it, and every lapse writes a log line (stderr + <home>/teams/_unassigned/log.jsonl metric).
import "./setup/hermetic.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isProviderOverQuota, readLiveCapDoc, setProviderCapped } from "../server/provider-failover.mjs";
import { capProviderOnUpstreamExit } from "../server/backend/runner-backend.mjs";
import { isProviderDeliberatelyCapped } from "../server/credit-guard.mjs";

const VS = path.resolve(import.meta.dirname, "..", "cli", "vs.mjs");
const MOD = pathToFileURL(path.resolve(import.meta.dirname, "..", "server", "provider-failover.mjs")).href;
const DAY = 24 * 3600_000;

function tmpHome() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vs-1073-"));
  const home = path.join(dir, ".vibesquad");
  mkdirSync(home, { recursive: true });
  return { dir, home, file: path.join(home, "capped-providers.json"), log: path.join(home, "teams", "_unassigned", "log.jsonl") };
}

function vs(h, ...args) {
  const r = spawnSync(process.execPath, [VS, ...args], {
    encoding: "utf8",
    env: { ...process.env, VIBESQUAD_HOME: h.home, PASEO_HOME: path.join(h.dir, ".paseo") },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const lapseLines = (h) => (existsSync(h.log) ? readFileSync(h.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => /^cap lapsed:/.test(e.text)) : []);

test("vs cap add opencode survives a restart and 30 days; only vs cap clear lifts it", async () => {
  const h = tmpHome();
  try {
    assert.equal(vs(h, "cap", "add", "opencode"), "capped opencode\n");
    // Time passes (the old code dropped it at updatedAt + 5 h) and the server restarts: a fresh module instance re-reads the store.
    const doc = JSON.parse(readFileSync(h.file, "utf8"));
    doc.capped.opencode.updatedAt = new Date(Date.now() - 30 * DAY).toISOString();
    writeFileSync(h.file, JSON.stringify(doc));
    const fresh = await import(`${MOD}?restart=${Date.now()}`);
    assert.equal(fresh.readLiveCapDoc({ cappedProvidersPath: h.file, now: Date.now() + 365 * DAY }).capped.opencode?.reason, "cli cap");
    assert.equal(fresh.isProviderOverQuota("opencode", [], undefined, { cappedProvidersPath: h.file, useDiskCaps: true }).overQuota, true);
    // A new CLI process (the post-restart `vs cap list`) still lists it, and the file still holds it.
    assert.match(vs(h, "cap", "list"), /^opencode: cli cap /m);
    assert.ok(JSON.parse(readFileSync(h.file, "utf8")).capped.opencode);
    assert.deepEqual(lapseLines(h), [], "nothing lapsed");
    assert.equal(vs(h, "cap", "clear", "opencode"), "cleared opencode\n");
    assert.equal(vs(h, "cap", "list"), "(no capped providers)\n");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("a legacy cli cap with no reset time (written before the fix) is kept, not pruned", () => {
  const h = tmpHome();
  try {
    writeFileSync(h.file, JSON.stringify({ capped: { opencode: { reason: "cli cap", updatedAt: "2026-11-25T23:24:47.382Z" }, deepseek: { reason: "cli cap", updatedAt: "2026-11-25T23:24:47.525Z" } } }));
    const caps = readLiveCapDoc({ cappedProvidersPath: h.file, now: Date.parse("2026-11-27T00:00:00Z") }).capped;
    assert.deepEqual(Object.keys(caps).sort(), ["deepseek", "opencode"]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(h.file, "utf8")).capped).sort(), ["deepseek", "opencode"]);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("an expiring cap lapses at its reset time and writes a log line saying which cap, why and when", () => {
  const h = tmpHome();
  try {
    const now = Date.parse("2026-11-26T01:00:00Z");
    setProviderCapped("opencode", true, { cappedProvidersPath: h.file, reason: "upstream failure: boom", ttlMs: 600_000, now });
    assert.ok(readLiveCapDoc({ cappedProvidersPath: h.file, now: now + 599_000 }).capped.opencode, "still live before its reset");
    assert.deepEqual(lapseLines(h), []);
    assert.equal(readLiveCapDoc({ cappedProvidersPath: h.file, now: now + 601_000 }).capped.opencode, undefined, "lapsed after its reset");
    const lines = lapseLines(h);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].type, "metric");
    assert.equal(lines[0].ts, new Date(now + 601_000).toISOString());
    assert.match(lines[0].text, /^cap lapsed: opencode \(reason "upstream failure: boom", set 2026-11-26T01:00:00\.000Z\): reset 2026-11-26T01:10:00\.000Z passed, removed 2026-11-26T01:10:01\.000Z$/);
    // A second read finds nothing more to drop: one lapse, one line.
    readLiveCapDoc({ cappedProvidersPath: h.file, now: now + 700_000 });
    assert.equal(lapseLines(h).length, 1);
    // The write path logs too: a later setProviderCapped that drops an expired neighbour says so.
    setProviderCapped("codex", true, { cappedProvidersPath: h.file, reason: "x", ttlMs: 60_000, now });
    setProviderCapped("claude", true, { cappedProvidersPath: h.file, reason: "manual cap", now: now + 120_000 });
    assert.match(lapseLines(h).at(-1).text, /^cap lapsed: codex /);
    assert.equal(lapseLines(h).length, 2);
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

test("an auto cap lift never removes the owner's cli cap on the same provider (or its capKin)", () => {
  const h = tmpHome();
  try {
    const now = Date.now();
    const cap = (p, c, o) => setProviderCapped(p, c, { ...o, cappedProvidersPath: h.file });
    const e = { type: "exit", upstream: true, error: "Internal service failure", ts: now };
    // Same key: the breaker keeps the owner cap as is (no resetsAt written), so nothing ever lapses it.
    setProviderCapped("opencode", true, { cappedProvidersPath: h.file, reason: "cli cap", normalizeKey: false, now });
    assert.equal(capProviderOnUpstreamExit("opencode", e, { cap, readCaps: () => ({}), log() {}, now }), null);
    let caps = readLiveCapDoc({ cappedProvidersPath: h.file, now: now + 30 * DAY }).capped;
    assert.deepEqual(caps.opencode, { reason: "cli cap", updatedAt: new Date(now).toISOString() });
    // Kin key: owner caps deepseek, the breaker caps opencode for its TTL; the breaker cap lapses (logged), the owner cap stays.
    setProviderCapped("opencode", false, { cappedProvidersPath: h.file, normalizeKey: false, now });
    setProviderCapped("deepseek", true, { cappedProvidersPath: h.file, reason: "cli cap", normalizeKey: false, now });
    const r = capProviderOnUpstreamExit("opencode", e, { cap, readCaps: () => ({}), log() {}, now });
    assert.equal(r?.kind, "upstream");
    const after = now + r.ttlMs + 1000;
    caps = readLiveCapDoc({ cappedProvidersPath: h.file, now: after }).capped;
    assert.equal(caps.opencode, undefined, "the auto cap lapsed");
    assert.equal(caps.deepseek?.reason, "cli cap", "the owner cap is still there");
    assert.match(lapseLines(h).at(-1).text, /^cap lapsed: opencode \(reason "upstream failure/);
    assert.equal(isProviderOverQuota("opencode", [], undefined, { cappedProvidersPath: h.file, useDiskCaps: true, now: after }).overQuota, true, "opencode still capped via capKin");
    assert.equal(isProviderDeliberatelyCapped("deepseek", caps), true, "credit guard still reads it as an owner cap");
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});
