#!/usr/bin/env node
import "./setup/hermetic.mjs"; // hermetic env for a direct `node --test <file>` run (run-tests.mjs preloads this)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { applyRolloutWindow, evaluateMergeVerdicts, formatRolloutWarning, formatVerdictRefusal } from "../server/verdict.mjs";
import { closeVerdictWindow, describeVerdictWindow, isAgentShell, openVerdictWindow, parseWindowDuration, readVerdictWindow, VERDICT_WINDOW_FILE, VERDICT_WINDOW_MAX_MS } from "../server/verdict-window.mjs";
import { commandPushGuard } from "../cli/vs.mjs";

const tmp = mkdtempSync(join(tmpdir(), "vs-verdict-window-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const TOKEN = "ab".repeat(32);
/** A fresh VS home with the owner's local token (what the server creates at first boot). */
function ownerHome({ token = TOKEN } = {}) {
  const home = join(tmp, `h${++n}`);
  mkdirSync(home, { recursive: true });
  if (token) writeFileSync(join(home, "local-token"), `${token}\n`);
  return home;
}
const OWNER_ENV = (home) => ({ VIBESQUAD_HOME: home }); // no VS_AGENT_ID / PASEO_AGENT_ID / VS_AGENT_TOKEN
const T0 = Date.parse("2026-11-25T20:00:00.000Z");
const H = 3600_000;

describe("verdict rollout window (idea-941): fail closed unless the owner opened a valid, unexpired window", () => {
  test("no file -> none; the default is fail closed", () => {
    const home = ownerHome();
    const w = readVerdictWindow({ home, now: T0 });
    assert.equal(w.state, "none");
    assert.equal(w.active, false);
    assert.match(describeVerdictWindow(w), /none \(the verdict gate fails closed\)/);
  });

  test("owner opens -> active until expiry, then expired (inactive) on its own", () => {
    const home = ownerHome();
    const rec = openVerdictWindow({ home, env: OWNER_ENV(home), durationMs: 2 * H, reason: "restart pending", now: T0 });
    assert.equal(rec.until, "2026-11-25T22:00:00.000Z");
    const live = readVerdictWindow({ home, now: T0 + H });
    assert.equal(live.state, "active");
    assert.equal(live.active, true);
    assert.equal(live.reason, "restart pending");
    assert.match(describeVerdictWindow(live), /ACTIVE until 2026-11-25T22:00:00.000Z \(1h00m left/);
    const gone = readVerdictWindow({ home, now: T0 + 2 * H });
    assert.equal(gone.state, "expired");
    assert.equal(gone.active, false);
    assert.match(describeVerdictWindow(gone), /expired at .*fails closed/);
  });

  test("an agent cannot open it: agent shell env refused, no owner token refused, hand-written/forged file ignored", () => {
    const home = ownerHome();
    for (const k of ["VS_AGENT_ID", "PASEO_AGENT_ID", "VS_AGENT_TOKEN"]) {
      const env = { ...OWNER_ENV(home), [k]: "ag-1" };
      assert.equal(isAgentShell(env), true);
      assert.throws(() => openVerdictWindow({ home, env, durationMs: H, now: T0 }), /owner verb; it never runs from an agent shell/);
    }
    const noTok = ownerHome({ token: null });
    assert.throws(() => openVerdictWindow({ home: noTok, env: OWNER_ENV(noTok), durationMs: H, now: T0 }), /no owner proof/);
    assert.equal(readVerdictWindow({ home, now: T0 }).state, "none");

    // An agent writes the file by hand (no owner secret -> no valid MAC): ignored.
    const until = new Date(T0 + H).toISOString();
    writeFileSync(join(home, VERDICT_WINDOW_FILE), JSON.stringify({ openedAt: new Date(T0).toISOString(), until, reason: "", mac: "0".repeat(64) }));
    const forged = readVerdictWindow({ home, now: T0 });
    assert.equal(forged.state, "invalid");
    assert.equal(forged.active, false);
    assert.match(forged.problem, /MAC does not verify/);
    // MACed with a different key (e.g. a guessed/old token): ignored.
    const other = ownerHome({ token: "cd".repeat(32) });
    openVerdictWindow({ home: other, env: OWNER_ENV(other), durationMs: H, now: T0 });
    writeFileSync(join(home, VERDICT_WINDOW_FILE), readFileSync(join(other, VERDICT_WINDOW_FILE)));
    assert.equal(readVerdictWindow({ home, now: T0 }).state, "invalid");
    // Malformed / not JSON: ignored.
    writeFileSync(join(home, VERDICT_WINDOW_FILE), "{not json");
    assert.equal(readVerdictWindow({ home, now: T0 }).state, "invalid");
  });

  test("an owner window cannot be extended, back-dated past the cap, or verified once the owner secret is gone", () => {
    const home = ownerHome();
    openVerdictWindow({ home, env: OWNER_ENV(home), durationMs: H, now: T0 });
    const file = join(home, VERDICT_WINDOW_FILE);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...rec, until: new Date(T0 + 20 * H).toISOString() })); // tampered expiry
    assert.equal(readVerdictWindow({ home, now: T0 + 2 * H }).state, "invalid");
    writeFileSync(file, JSON.stringify(rec));
    assert.equal(readVerdictWindow({ home, now: T0 + 30 * 60_000 }).state, "active");
    rmSync(join(home, "local-token"));
    const w = readVerdictWindow({ home, now: T0 + 30 * 60_000 });
    assert.equal(w.state, "invalid");
    assert.match(w.problem, /no owner secret/);
    // Cap: > 24h refused at open; a future-dated window is invalid.
    const h2 = ownerHome();
    assert.throws(() => openVerdictWindow({ home: h2, env: OWNER_ENV(h2), durationMs: VERDICT_WINDOW_MAX_MS + 1, now: T0 }), /capped at 24h/);
    openVerdictWindow({ home: h2, env: OWNER_ENV(h2), durationMs: H, now: T0 + 2 * H });
    assert.equal(readVerdictWindow({ home: h2, now: T0 }).state, "invalid");
  });

  test("close removes it (only tightens the gate); parseWindowDuration", () => {
    const home = ownerHome();
    openVerdictWindow({ home, env: OWNER_ENV(home), durationMs: H, now: T0 });
    assert.equal(closeVerdictWindow({ home }), true);
    assert.equal(closeVerdictWindow({ home }), false);
    assert.equal(readVerdictWindow({ home, now: T0 }).state, "none");
    assert.equal(parseWindowDuration("90m"), 90 * 60_000);
    assert.equal(parseWindowDuration("4h"), 4 * H);
    assert.equal(parseWindowDuration("1d"), 24 * H);
    for (const bad of ["", "4", "0h", "-1h", "soon", null]) assert.equal(parseWindowDuration(bad), null);
  });

  test("applyRolloutWindow: inactive changes nothing; active downgrades only missing verdicts, a FAIL still refuses", () => {
    const merges = [
      { sha: "a".repeat(40), subject: "Merge unit-x-miss: m (@alp)", tip: "1".repeat(40) },
      { sha: "b".repeat(40), subject: "Merge unit-x-fail: f (@alp)", tip: "2".repeat(40) },
    ];
    const recorded = (tip) => (tip === "2".repeat(40) ? { verdict: "FAIL", line: "FAIL 1/0/0 22222222" } : null);
    const v = evaluateMergeVerdicts({ merges, recorded });
    assert.equal(v.ok, false);
    const off = applyRolloutWindow(v, { active: false });
    assert.equal(off.ok, false);
    assert.equal(off.refused.length, 2);
    assert.deepEqual(off.warned, []);
    const on = applyRolloutWindow(v, { active: true });
    assert.equal(on.ok, false, "a FAIL refuses inside the window");
    assert.deepEqual(on.refused.map((r) => r.reason), ["fail"]);
    assert.deepEqual(on.warned.map((r) => r.tip), ["1".repeat(40)]);
    const onlyMissing = applyRolloutWindow(evaluateMergeVerdicts({ merges: [merges[0]], recorded }), { active: true });
    assert.equal(onlyMissing.ok, true);
    const banner = formatRolloutWarning(onlyMissing, { action: "merge", windowLine: "verdict rollout window: ACTIVE until X" });
    assert.match(banner, /OWNER ROLLOUT WINDOW ACTIVE \(idea-941\)/);
    assert.match(banner, /WARNING: allowing merge of aaaaaaaa Merge unit-x-miss/);
    assert.match(banner, /never get the `verdict` field retroactively/);
    // The refusal keeps the pre-restart note (re-review or override).
    assert.match(formatVerdictRefusal(v, { action: "push", squads: ["squad-a"] }), /Pre-restart PASS digests .* re-review the tip or use an override/);
  });

  test("vs push-guard window: open refused from an agent shell; owner opens, status shows it, close", async () => {
    const home = ownerHome();
    const outs = [];
    const out = (s) => outs.push(s);
    await assert.rejects(commandPushGuard({ _: ["window", "open", "4h"] }, { env: { VIBESQUAD_HOME: home, VS_AGENT_ID: "ag-lead" }, out }), /owner verb/);
    await assert.rejects(commandPushGuard({ _: ["window", "open", "4h"] }, { env: { VIBESQUAD_HOME: home, VS_AGENT_TOKEN: "t" }, out }), /owner verb/);
    assert.equal(readVerdictWindow({ home }).state, "none");
    await assert.rejects(commandPushGuard({ _: ["window", "open", "48h"] }, { env: OWNER_ENV(home), out }), /capped at 24h/);
    await assert.rejects(commandPushGuard({ _: ["window", "open"] }, { env: OWNER_ENV(home), out }), /usage: vs push-guard window open/);
    assert.equal(await commandPushGuard({ _: ["window", "status"] }, { env: OWNER_ENV(home), out }), 1);
    assert.equal(await commandPushGuard({ _: ["window", "open", "2h"], reason: "restart at 9 PM ET" }, { env: OWNER_ENV(home), out }), 0);
    assert.match(outs.join(""), /verdict rollout window OPEN until .*a FAIL still refuses/);
    assert.equal(await commandPushGuard({ _: ["window", "status"] }, { env: OWNER_ENV(home), out }), 0);
    assert.match(outs.at(-1), /ACTIVE until .*restart at 9 PM ET/);
    // close works from any shell (it only tightens).
    assert.equal(await commandPushGuard({ _: ["window", "close"] }, { env: { VIBESQUAD_HOME: home, VS_AGENT_ID: "ag-lead" }, out }), 0);
    assert.equal(readVerdictWindow({ home }).state, "none");
  });
});
