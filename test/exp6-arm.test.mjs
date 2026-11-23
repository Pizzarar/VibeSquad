import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { callTool, createContext } from "../server/mcp/tools.mjs";
import { verifiedIdentity } from "./helpers/agent-token.mjs";
import { USER_PROFILES } from "./helpers/route-golden.mjs";
import { EXP6_WINNER, armCapped, armOfProfile, countArms, decideArm, experimentOpen, hasVerdictEntry, pickArm, readArmCaps, readPerfectionVerdict } from "../server/exp6-arm.mjs";

process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
const NOW = Date.parse("2026-11-23T12:00:00Z");
const ag = (wf, over = {}) => ({ createdAt: "2026-11-20T00:00:00Z", labels: { lane: "feat", team: "mx", role: "worker", wf, ...over.labels }, ...over.rec });
const base = (extra = {}) => ({ team: "mx", profile: "Implement - Sonnet", stakes: "", labels: {}, lane: "feat", now: NOW, listAgents: async () => [], ...extra });

test("experiment open/closed: verdict or end date closes it", () => {
  assert.equal(experimentOpen({ now: NOW }), true);
  assert.equal(experimentOpen({ now: NOW, verdict: true }), false);
  assert.equal(experimentOpen({ now: NOW, endIso: "2026-11-22T00:00:00Z" }), false);
  assert.equal(experimentOpen({ now: Date.parse("2026-11-27T00:00:01Z") }), false);
  assert.equal(hasVerdictEntry([{ type: "decision", text: "@per EXP6 verdict: BOTH-ARMS" }]), true);
  assert.equal(hasVerdictEntry([{ type: "metric", text: "EXP6 verdict" }, { type: "decision", text: "other" }]), false);
});

test("tie keeps the requested profile; lagging arm wins", async () => {
  assert.equal(pickArm(armOfProfile("Implement - Sonnet"), { sonnet: 2, dsp: 2 }).wf, "sonnet");
  assert.equal(pickArm(armOfProfile("Work Order - DSP"), { sonnet: 2, dsp: 2 }).wf, "dsp");
  const skew = [ag("sonnet"), ag("sonnet"), ag("sonnet"), ag("dsp")];
  const r = await decideArm(base({ listAgents: async () => skew }));
  assert.deepEqual([r.arm, r.swapped, r.profile, r.counts], ["dsp", true, "Work Order - DSP", { sonnet: 3, dsp: 1 }]);
  const r2 = await decideArm(base({ profile: "Work Order - DSP", listAgents: async () => [ag("dsp"), ag("dsp"), ag("sonnet")] }));
  assert.deepEqual([r2.arm, r2.swapped], ["sonnet", true]);
});

test("countArms scopes by lane, stakes, role, date", () => {
  const list = [ag("sonnet"), ag("dsp", { labels: { lane: "other" } }), ag("dsp", { labels: { stakes: "tierA-invariant" } }), ag("dsp", { labels: { role: "lead" } }), ag("dsp", { rec: { createdAt: "2026-11-01T00:00:00Z" } }), ag("opus")];
  assert.deepEqual(countArms(list, { lane: "feat" }), { sonnet: 1, dsp: 0 });
});

test("stakes gating, pin opt-out, wf pin, lead, other profiles are untouched", async () => {
  const skew = async () => [ag("sonnet"), ag("sonnet")];
  assert.equal(await decideArm(base({ stakes: "tierA-security", listAgents: skew })), null);
  assert.equal(await decideArm(base({ stakes: "mechanical", listAgents: skew })), null);
  assert.equal(await decideArm(base({ labels: { ab: "pin" }, listAgents: skew })), null);
  assert.equal(await decideArm(base({ labels: { wf: "sonnet" }, listAgents: skew })), null);
  assert.equal(await decideArm(base({ asLead: true, listAgents: skew })), null);
  assert.equal(await decideArm(base({ profile: "Review - Gemini", listAgents: skew })), null);
  assert.equal(await decideArm(base({ stakes: "normal", listAgents: skew })).then((r) => r.swapped), true);
  // Closed: the alternation no longer applies (no counts read); the EXP6_WINNER default does (see the D1 tests below).
  assert.equal((await decideArm(base({ verdictProbe: async () => true, listAgents: async () => { throw new Error("not read"); } }))).mode, "default");
});

test("count or verdict-probe failure fails open", async () => {
  const r = await decideArm(base({ listAgents: async () => { throw new Error("boom"); } }));
  assert.deepEqual([r.arm, r.swapped, r.profile, r.counts], ["sonnet", false, "Implement - Sonnet", null]);
  assert.equal(await decideArm(base({ verdictProbe: async () => { throw new Error("x"); } })), null);
});

const EMPTY_HOME = mkdtempSync(join(tmpdir(), "exp6-home-"));
function ctxWith(agents, logs, over = {}) {
  const creates = [];
  const backend = {
    createAgent: async (req) => { creates.push(req); return { id: "a1", title: req.config.title }; },
    sendAgentPrompt: async () => {},
    fetchAgents: async () => ({ entries: agents.map((agent) => ({ agent })) }),
  };
  const TEAMS = [{ id: "mx", name: "Matrix", paths: ["matrix"], lanes: [{ id: "feat", name: "Feat" }, { id: "hub", name: "Hub", hub: true }] }];
  const ctx = createContext({
    env: { VIBESQUAD_HOME: EMPTY_HOME, VS_EXP6_END: "2999-01-01T00:00:00Z" },
    ...verifiedIdentity({ agentId: "rn-bud1", team: "mx", lane: "feat", role: "brainstorm" }, { backend, teams: TEAMS }),
    cwd: "/w", teams: TEAMS, loadProfiles: async () => USER_PROFILES, ...over,
    withBackend: async (_t, fn) => fn(backend), findLiveLeads: async () => [],
    writeLog: async (e) => { logs.push(e); },
  });
  return { ctx, creates };
}

test("spawn_worker swaps to the lagging arm, stamps wf, returns ab and logs a metric", async () => {
  const logs = [];
  const { ctx, creates } = ctxWith([ag("sonnet"), ag("sonnet")], logs);
  const res = await callTool(ctx, "spawn_worker", { title: "t", prompt: "go", profile: "Implement - Sonnet" });
  assert.equal(creates[0].labels.profile, "Work Order - DSP");
  assert.equal(creates[0].labels.wf, undefined, "wf is derived by the hook after failover, never pre-stamped");
  assert.deepEqual(res.ab, { arm: "dsp", swapped: true, counts: { sonnet: 2, dsp: 0 } });
  assert.match(logs[0].text, /exp6-arm swap/);
  const pinned = await callTool(ctxWith([ag("sonnet"), ag("sonnet")], []).ctx, "spawn_worker", { title: "t", prompt: "go", profile: "Implement - Sonnet", labels: { ab: "pin" } });
  assert.equal(pinned.ab, undefined);
});

test("countArms: team scope, respawn/digest exclusion, bad createdAt, empty lane", async () => {
  const list = [ag("sonnet"), ag("sonnet", { labels: { team: "other" } }), ag("sonnet", { labels: { respawnedAs: "x" } }), ag("sonnet", { labels: { digestFor: "x" } }), ag("dsp", { rec: { createdAt: undefined } }), ag("dsp", { rec: { createdAt: "nope" } })];
  assert.deepEqual(countArms(list, { lane: "feat", team: "mx" }), { sonnet: 1, dsp: 0 });
  assert.deepEqual(countArms(list, { lane: "", team: "mx" }), { sonnet: 0, dsp: 0 });
  assert.equal(await decideArm(base({ lane: "", listAgents: async () => [ag("sonnet"), ag("sonnet")] })), null);
});

test("explicit provider/model skips the pick; an uninstalled swap target falls back to the requested profile", async () => {
  const skew = [ag("sonnet"), ag("sonnet")];
  const r1 = await callTool(ctxWith(skew, []).ctx, "spawn_worker", { title: "t", prompt: "go", profile: "Implement - Sonnet", model: "claude-opus-5-5" });
  assert.equal(r1.ab, undefined);
  const base = createContext({ env: {} });
  const resolveProfile = async (n, ps, o) => (n === "Work Order - DSP" ? null : base.resolveProfile(n, ps, o));
  const { ctx, creates } = ctxWith(skew, [], { resolveProfile });
  const r2 = await callTool(ctx, "spawn_worker", { title: "t", prompt: "go", profile: "Implement - Sonnet" });
  assert.equal(creates[0].labels.profile, "Implement - Sonnet");
  assert.equal(r2.ab.swapped, false);
});

test("verdict probe: reads the given home, case-insensitive, cached by mtime+size", () => {
  const home = mkdtempSync(join(tmpdir(), "exp6-verdict-"));
  mkdirSync(join(home, "logs"));
  const f = join(home, "logs", "vibesquad--perfection.jsonl");
  assert.equal(readPerfectionVerdict({ home }), false);
  writeFileSync(f, JSON.stringify({ type: "decision", text: "@per EXP6 VERDICT: BOTH-ARMS" }) + "\n");
  assert.equal(readPerfectionVerdict({ home }), true);
  assert.equal(readPerfectionVerdict({ home }), true);
  writeFileSync(f, JSON.stringify({ type: "metric", text: "x" }) + "\n");
  assert.equal(readPerfectionVerdict({ home }), false);
});

// ---- D1 (PLAN_EXP6_DSP_DEFAULT): post-verdict default -> EXP6_WINNER; caps checked at the swap (idea-703) ----
const closed = (extra = {}) => base({ verdictProbe: async () => true, ...extra });

test("D1 closed: normal Implement - Sonnet / Worker alias / implement role -> DSP; DSP request untouched", async () => {
  assert.equal(EXP6_WINNER, "dsp");
  const r = await decideArm(closed());
  assert.deepEqual([r.mode, r.arm, r.requestedArm, r.swapped, r.profile], ["default", "dsp", "sonnet", true, "Work Order - DSP"]);
  assert.equal((await decideArm(closed({ stakes: "normal" }))).profile, "Work Order - DSP");
  assert.equal((await decideArm(closed({ profile: "Worker" }))).profile, "Work Order - DSP");
  assert.equal((await decideArm(closed({ profile: "implement" }))).profile, "Work Order");
  assert.equal(await decideArm(closed({ profile: "Work Order - DSP" })), null);
  // End date passed (no verdict) closes it the same way.
  assert.equal((await decideArm(base({ endIso: "2026-11-22T00:00:00Z" }))).profile, "Work Order - DSP");
});

test("D1 closed: tierA-*, mechanical, pins, lead, other profiles unchanged", async () => {
  for (const stakes of ["tierA-invariant", "tierA-security", "mechanical"]) assert.equal(await decideArm(closed({ stakes })), null, stakes);
  assert.equal(await decideArm(closed({ profile: "Implement - Opus" })), null);
  assert.equal(await decideArm(closed({ profile: "Mechanical - DSF" })), null);
  assert.equal(await decideArm(closed({ profile: "Review - Gemini" })), null);
  assert.equal(await decideArm(closed({ labels: { ab: "pin" } })), null);
  assert.equal(await decideArm(closed({ labels: { wf: "sonnet" } })), null);
  assert.equal(await decideArm(closed({ asLead: true })), null);
  assert.equal(await decideArm(closed({ lane: "" })), null);
  // Revert switch for the D3 guard: winner "sonnet" or "" -> no swap.
  assert.equal(await decideArm(closed({ winner: "sonnet" })), null);
  assert.equal(await decideArm(closed({ winner: "" })), null);
});

test("D1 caps (idea-703): capped deepseek/opencode keeps Implement - Sonnet, no swap; probe error keeps it too", async () => {
  for (const caps of [{ deepseek: { reason: "cli cap" } }, { opencode: { reason: "x" } }, ["deepseek"]]) {
    const r = await decideArm(closed({ capProbe: async () => caps }));
    assert.deepEqual([r.mode, r.arm, r.swapped, r.capped, r.profile], ["default", "sonnet", false, true, "Implement - Sonnet"], JSON.stringify(caps));
  }
  const otherCap = await decideArm(closed({ capProbe: async () => ({ claude: {} }) }));
  assert.equal(otherCap.profile, "Work Order - DSP");
  const err = await decideArm(closed({ capProbe: async () => { throw new Error("disk"); } }));
  assert.deepEqual([err.swapped, err.profile], [false, "Implement - Sonnet"]);
  assert.equal(armCapped("dsp", { "opencode/deepseek-v4-pro": {} }), true);
  assert.equal(armCapped("dsp", {}), false);
});

test("open experiment: alternation unchanged, but never swaps to a capped arm (idea-703)", async () => {
  const skew = async () => [ag("sonnet"), ag("sonnet")];
  const r = await decideArm(base({ listAgents: skew }));
  assert.deepEqual([r.mode, r.swapped, r.profile], ["ab", true, "Work Order - DSP"]);
  const capped = await decideArm(base({ listAgents: skew, capProbe: async () => ({ deepseek: {} }) }));
  assert.deepEqual([capped.swapped, capped.capped, capped.profile], [false, true, "Implement - Sonnet"]);
  // Aliases/role names are not arms while the experiment is open.
  assert.equal(await decideArm(base({ profile: "Worker", listAgents: skew })), null);
});

test("readArmCaps reads the caller home's capped-providers.json", async () => {
  const home = mkdtempSync(join(tmpdir(), "exp6-caps-"));
  assert.deepEqual(await readArmCaps({ env: { VIBESQUAD_HOME: home } }), {});
  writeFileSync(join(home, "capped-providers.json"), JSON.stringify({ capped: { deepseek: { reason: "cli cap", updatedAt: new Date().toISOString() } } }));
  assert.equal(armCapped("dsp", await readArmCaps({ env: { VIBESQUAD_HOME: home } })), true);
});

function closedHome(caps) {
  const home = mkdtempSync(join(tmpdir(), "exp6-closed-"));
  mkdirSync(join(home, "logs"));
  writeFileSync(join(home, "logs", "vibesquad--perfection.jsonl"), JSON.stringify({ type: "decision", text: "@per EXP6 verdict change: DSP default" }) + "\n");
  if (caps) writeFileSync(join(home, "capped-providers.json"), JSON.stringify({ capped: caps }));
  return home;
}

test("spawn_worker after verdict: normal Implement - Sonnet spawns as Work Order - DSP and logs exp6-default", async () => {
  const logs = [];
  const { ctx, creates } = ctxWith([ag("dsp"), ag("dsp"), ag("dsp")], logs, { env: { VIBESQUAD_HOME: closedHome(), VS_EXP6_END: "2999-01-01T00:00:00Z" } });
  const res = await callTool(ctx, "spawn_worker", { title: "t", prompt: "go", profile: "Implement - Sonnet", stakes: "normal" });
  assert.equal(creates[0].labels.profile, "Work Order - DSP");
  assert.equal(creates[0].config.provider, "opencode");
  assert.equal(creates[0].labels.wf, undefined, "wf is derived by the hook after failover (dsp, or sonnet on a later failover)");
  assert.deepEqual(res.ab, { arm: "dsp", swapped: true, counts: null, mode: "default" });
  assert.equal(logs.length, 1);
  assert.match(logs[0].text, /^exp6-default: Implement - Sonnet -> Work Order - DSP wf=dsp lane=feat$/);
});

test("spawn_worker after verdict: tierA/mechanical/pin keep the requested profile, no metric", async () => {
  for (const [args, want] of [
    [{ profile: "Implement - Sonnet", stakes: "tierA-invariant" }, "Implement - Sonnet"],
    [{ profile: "Implement - Opus", stakes: "tierA-security" }, "Implement - Opus"],
    [{ profile: "Mechanical - DSF", stakes: "mechanical" }, "Mechanical - DSF"],
    [{ profile: "Implement - Sonnet", stakes: "mechanical" }, "Implement - Sonnet"],
    [{ profile: "Implement - Sonnet", labels: { ab: "pin" } }, "Implement - Sonnet"],
  ]) {
    const logs = [];
    const { ctx, creates } = ctxWith([], logs, { env: { VIBESQUAD_HOME: closedHome(), VS_EXP6_END: "2999-01-01T00:00:00Z" } });
    const res = await callTool(ctx, "spawn_worker", { title: "t", prompt: "go", ...args });
    assert.equal(creates[0].labels.profile, want, JSON.stringify(args));
    assert.equal(res.ab, undefined);
    assert.equal(logs.length, 0);
  }
});

test("spawn_worker after verdict, deepseek capped (idea-703): Implement - Sonnet stays Sonnet, no swap, cap noted", async () => {
  const logs = [];
  const env = { VIBESQUAD_HOME: closedHome({ deepseek: { reason: "cli cap", updatedAt: new Date().toISOString() } }), VS_EXP6_END: "2999-01-01T00:00:00Z" };
  const { ctx, creates } = ctxWith([], logs, { env });
  const res = await callTool(ctx, "spawn_worker", { title: "t", prompt: "go", profile: "Implement - Sonnet", stakes: "normal" });
  assert.equal(creates[0].labels.profile, "Implement - Sonnet");
  assert.equal(creates[0].config.provider, "claude");
  assert.deepEqual(res.ab, { arm: "sonnet", swapped: false, counts: null, mode: "default", capped: true });
  assert.match(logs[0].text, /^exp6-default: Implement - Sonnet -> Implement - Sonnet \(kept: winner capped\) wf=sonnet/);
});

// ---- review r2 ----
test("readArmCaps: a corrupt or wrong-shape cap file throws, so decideArm keeps Implement - Sonnet (m1)", async () => {
  for (const body of ["{ torn", "[1,2]", "\"x\""]) {
    const home = mkdtempSync(join(tmpdir(), "exp6-badcaps-"));
    writeFileSync(join(home, "capped-providers.json"), body);
    await assert.rejects(readArmCaps({ env: { VIBESQUAD_HOME: home } }), undefined, body);
    const r = await decideArm(closed({ capProbe: () => readArmCaps({ env: { VIBESQUAD_HOME: home } }) }));
    assert.deepEqual([r.swapped, r.profile], [false, "Implement - Sonnet"], body);
  }
  const ok = mkdtempSync(join(tmpdir(), "exp6-okcaps-"));
  writeFileSync(join(ok, "capped-providers.json"), "﻿" + JSON.stringify({ capped: {} }));
  assert.deepEqual(await readArmCaps({ env: { VIBESQUAD_HOME: ok } }), {});
});

test("spawn_worker after verdict: corrupt cap file keeps Implement - Sonnet on claude", async () => {
  const home = closedHome();
  writeFileSync(join(home, "capped-providers.json"), "{ torn");
  const { ctx, creates } = ctxWith([], [], { env: { VIBESQUAD_HOME: home, VS_EXP6_END: "2999-01-01T00:00:00Z" } });
  const res = await callTool(ctx, "spawn_worker", { title: "t", prompt: "go", profile: "Implement - Sonnet", stakes: "normal" });
  assert.equal(creates[0].labels.profile, "Implement - Sonnet");
  assert.equal(creates[0].config.provider, "claude");
  assert.equal(res.ab.capped, true);
});

test("spawn_worker after verdict: Worker alias -> Work Order - DSP, implement role -> Work Order role (opencode)", async () => {
  for (const [asked, label] of [["Worker", "Work Order - DSP"], ["implement", "Work Order"], ["Implement", "Work Order"]]) {
    const logs = [];
    const { ctx, creates } = ctxWith([], logs, { env: { VIBESQUAD_HOME: closedHome(), VS_EXP6_END: "2999-01-01T00:00:00Z" } });
    const res = await callTool(ctx, "spawn_worker", { title: "t", prompt: "go", profile: asked, stakes: "normal" });
    assert.equal(creates[0].labels.profile, label, asked);
    assert.equal(creates[0].config.provider, "opencode", asked);
    assert.deepEqual([res.ab.mode, res.ab.swapped, res.ab.arm], ["default", true, "dsp"], asked);
    assert.match(logs[0].text, new RegExp(`^exp6-default: ${asked} -> ${label} wf=dsp`), asked);
  }
});

test("spawn_worker: a throwing writeLog never fails the spawn", async () => {
  for (const writeLog of [async () => { throw new Error("log down"); }, () => { throw new Error("sync throw"); }]) {
    const { ctx, creates } = ctxWith([], [], { env: { VIBESQUAD_HOME: closedHome(), VS_EXP6_END: "2999-01-01T00:00:00Z" } });
    ctx.writeLog = writeLog;
    const res = await callTool(ctx, "spawn_worker", { title: "t", prompt: "go", profile: "Implement - Sonnet", stakes: "normal" });
    assert.equal(res.id, "a1");
    assert.equal(creates[0].labels.profile, "Work Order - DSP");
    assert.equal(res.ab.swapped, true);
  }
});
