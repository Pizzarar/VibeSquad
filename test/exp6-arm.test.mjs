// R0 (PLAN_PER_ROLES_LADDER_1125): stakes=normal implementer spawns alternate per lane between the Sonnet and Neon arms,
// visible (arm + reason + model in the result and labels). DSP is never an arm. Grew out of the EXP6 pick (idea-440).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { callTool, createContext } from "../server/mcp/tools.mjs";
import { verifiedIdentity } from "./helpers/agent-token.mjs";
import { USER_PROFILES } from "./helpers/route-golden.mjs";
import { ARMS, IMPLEMENTER_ARMS, armCapKey, armCapped, armOfProfile, armProvider, countArms, decideArm, experimentOpen, hasVerdictEntry, pickArm, readArmCaps, readPerfectionVerdict } from "../server/exp6-arm.mjs";

process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
const SONNET = "Implement - Sonnet";
const NEON = "Implement - Gemini (trial)";
const DSP = "Work Order - DSP";
const ag = (arm, over = {}) => ({ createdAt: "2026-11-25T00:00:00Z", labels: { lane: "feat", team: "mx", role: "worker", ...(arm ? { "vs.arm": arm } : {}), ...over.labels }, ...over.rec });
const base = (extra = {}) => ({ team: "mx", profile: SONNET, stakes: "", labels: {}, lane: "feat", listAgents: async () => [], capProbe: async () => ({}), ...extra });
const pick3 = (r) => [r.arm, r.reason, r.swapped, r.profile];

test("arm table: Sonnet + Neon only, DSP is never an arm", () => {
  assert.deepEqual(IMPLEMENTER_ARMS, ["sonnet", "neon"]);
  assert.deepEqual(IMPLEMENTER_ARMS.map((wf) => ARMS[wf].profile), [SONNET, NEON]);
  assert.equal(armOfProfile(SONNET).wf, "sonnet");
  assert.equal(armOfProfile("worker").wf, "sonnet");
  assert.equal(armOfProfile(NEON).wf, "neon");
  for (const name of [DSP, "Mechanical - DSF", "Implement - Opus", "Review - Gemini", "review", "Work Order", "Planner - Sonnet", "Spec - Opus", "Senior Reasoning - DSP"]) assert.equal(armOfProfile(name), null, name);
  // R1: the role name joins (requested arm = the ladder default, Sonnet) and is flagged so it is never swapped to an old name.
  for (const name of ["implement", "Implement", " IMPLEMENT "]) assert.deepEqual([armOfProfile(name)?.wf, armOfProfile(name)?.role], ["sonnet", true], name);
  assert.equal(armOfProfile(SONNET).role, undefined);
  assert.deepEqual([armProvider("sonnet"), armProvider("neon"), armProvider("NEON"), armProvider("dsp"), armProvider("")], ["claude", "antigravity-cli", "antigravity-cli", "", ""]);
});

test("decideArm: per-lane alternation sonnet -> neon -> sonnet (only vs.arm picks count)", async () => {
  const lane = [];
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const r = await decideArm(base({ listAgents: async () => lane }));
    seen.push(r.arm);
    assert.equal(r.reason, "alternation");
    lane.push(ag(r.arm));
  }
  assert.deepEqual(seen, ["sonnet", "neon", "sonnet", "neon"]);
  // EXP6-era history (wf only, no vs.arm), other lanes/teams, respawned, digests, non-normal and leads never count.
  const noise = [ag(null, { labels: { wf: "sonnet" } }), ag("sonnet", { labels: { lane: "other" } }), ag("sonnet", { labels: { team: "zz" } }), ag("sonnet", { labels: { respawnedAs: "x" } }), ag("sonnet", { labels: { digestFor: "x" } }), ag("sonnet", { labels: { stakes: "tierA-invariant" } }), ag("sonnet", { labels: { role: "lead" } })];
  assert.deepEqual(countArms(noise, { lane: "feat", team: "mx" }), { sonnet: 0, neon: 0 });
  const r = await decideArm(base({ listAgents: async () => [ag("sonnet")] }));
  assert.deepEqual(pick3(r), ["neon", "alternation", true, NEON]);
  assert.deepEqual(r.counts, { sonnet: 1, neon: 0 });
  // A Neon request on a tie keeps Neon; lagging Sonnet swaps a Neon request back.
  assert.deepEqual(pick3(await decideArm(base({ profile: NEON }))), ["neon", "alternation", false, NEON]);
  assert.deepEqual(pick3(await decideArm(base({ profile: NEON, listAgents: async () => [ag("neon")] }))), ["sonnet", "alternation", true, SONNET]);
  // Worker alias joins as the Sonnet arm.
  assert.deepEqual(pick3(await decideArm(base({ profile: "Worker", listAgents: async () => [ag("sonnet")] }))), ["neon", "alternation", true, NEON]);
  assert.deepEqual(pick3(await decideArm(base({ profile: "Worker" }))), ["sonnet", "alternation", false, "Worker"]);
});

test("decideArm caps (idea-703): a capped arm is never picked; both capped keeps the requested profile", async () => {
  const sonnetAhead = async () => [ag("sonnet")];
  for (const caps of [{ "antigravity-cli": {} }, { gemini: {} }, ["antigravity"], { "gemini-4-neon": {} }]) {
    const r = await decideArm(base({ listAgents: sonnetAhead, capProbe: async () => caps }));
    assert.deepEqual(pick3(r), ["sonnet", `capped:${armCapKey("neon", caps)}`, false, SONNET], JSON.stringify(caps));
    assert.equal(r.capped, true);
  }
  // Capped claude: Neon even when Sonnet's turn.
  const c = await decideArm(base({ capProbe: async () => ({ claude: { reason: "cap" } }) }));
  assert.deepEqual(pick3(c), ["neon", "capped:claude", true, NEON]);
  // A cap on the arm that would not be picked anyway is not a reason.
  assert.deepEqual(pick3(await decideArm(base({ capProbe: async () => ({ claude: {} }), listAgents: async () => [ag("sonnet")] }))), ["neon", "alternation", true, NEON]);
  // DSP cap is irrelevant (not an arm).
  assert.deepEqual(pick3(await decideArm(base({ capProbe: async () => ({ deepseek: {}, opencode: {} }) }))), ["sonnet", "alternation", false, SONNET]);
  const both = await decideArm(base({ capProbe: async () => ({ claude: {}, "antigravity-cli": {} }) }));
  assert.deepEqual(pick3(both), ["sonnet", "capped:claude+antigravity-cli", false, SONNET]);
  // Probe error / agent-list error: fail open, requested kept.
  assert.deepEqual(pick3(await decideArm(base({ capProbe: async () => { throw new Error("disk"); } }))), ["sonnet", "fail-open", false, SONNET]);
  assert.deepEqual(pick3(await decideArm(base({ listAgents: async () => { throw new Error("boom"); } }))), ["sonnet", "fail-open", false, SONNET]);
  assert.equal(armCapped("neon", { "antigravity-cli/gemini-4-neon": {} }), true);
  assert.equal(armCapped("sonnet", {}), false);
});

test("decideArm opt-outs and non-arm requests", async () => {
  const skew = async () => [ag("sonnet"), ag("sonnet")];
  assert.deepEqual(pick3(await decideArm(base({ labels: { ab: "pin" }, listAgents: skew }))), ["sonnet", "pin", false, SONNET]);
  assert.deepEqual(pick3(await decideArm(base({ labels: { wf: "sonnet" }, listAgents: skew }))), ["sonnet", "wf", false, SONNET]);
  for (const stakes of ["tierA-invariant", "tierA-security", "mechanical"]) assert.equal(await decideArm(base({ stakes, listAgents: skew })), null, stakes);
  assert.equal(await decideArm(base({ asLead: true, listAgents: skew })), null);
  assert.equal(await decideArm(base({ lane: "", listAgents: skew })), null);
  for (const profile of [DSP, "Mechanical - DSF", "Implement - Opus", "Review - Gemini", "review", "Work Order"]) assert.equal(await decideArm(base({ profile, listAgents: skew })), null, profile);
  // Arm set off ([] or one arm) = no pick at all.
  assert.equal(await decideArm(base({ arms: [], listAgents: skew })), null);
  assert.equal(await decideArm(base({ arms: ["sonnet"], listAgents: skew })), null);
  assert.equal(pickArm(ARMS.sonnet, { sonnet: 0, neon: 0 }, { capped: new Set(["sonnet", "neon"]) }), null);
});

const PLANNING = [
  { name: "Planner - Sonnet", role: "worker", provider: "claude", model: "claude-sonnet-5-5", modeId: "auto", thinkingOptionId: "medium" },
  { name: "Spec - Opus", role: "worker", provider: "claude", model: "claude-opus-5-5", modeId: "auto", thinkingOptionId: "medium" },
  { name: "Senior Reasoning - DSP", role: "worker", provider: "opencode", model: "deepseek/deepseek-v4-pro", modeId: "build", thinkingOptionId: "high" },
];

test("R1 decideArm: the role name Implement alternates but keeps its name; the arm only picks the provider", async () => {
  const r1 = await decideArm(base({ profile: "Implement", listAgents: async () => [ag("sonnet")] }));
  assert.deepEqual([r1.arm, r1.reason, r1.swapped, r1.profile, r1.role, r1.provider], ["neon", "alternation", true, "Implement", true, "antigravity-cli"]);
  const r2 = await decideArm(base({ profile: "implement", listAgents: async () => [ag("sonnet"), ag("neon")] }));
  assert.deepEqual([r2.arm, r2.swapped, r2.profile, r2.provider], ["sonnet", false, "implement", "claude"]);
  // Shared per-lane counts: old-name and role-name picks feed one alternation.
  const r3 = await decideArm(base({ profile: SONNET, listAgents: async () => [ag("neon")] }));
  assert.equal(r3.arm, "sonnet");
  const pin = await decideArm(base({ profile: "Implement", labels: { ab: "pin" }, listAgents: async () => [ag("sonnet")] }));
  assert.deepEqual([pin.arm, pin.reason, pin.swapped, pin.profile, pin.role, pin.provider], ["sonnet", "pin", false, "Implement", true, undefined]);
  for (const stakes of ["tierA-invariant", "mechanical"]) assert.equal(await decideArm(base({ profile: "Implement", stakes })), null, stakes);
  const capped = await decideArm(base({ profile: "Implement", capProbe: async () => ({ "antigravity-cli": {} }), listAgents: async () => [ag("sonnet")] }));
  assert.deepEqual([capped.arm, capped.reason, capped.profile, capped.provider], ["sonnet", "capped:antigravity-cli", "Implement", "claude"]);
});

test("D1b decideArm: planning/spec profiles never join the alternation", async () => {
  for (const { name } of PLANNING) assert.equal(await decideArm(base({ profile: name, stakes: "normal", listAgents: async () => [ag("sonnet")] })), null, name);
});

test("EXP6 history readers: open/closed and verdict probe (read-only now)", () => {
  const NOW = Date.parse("2026-11-23T12:00:00Z");
  assert.equal(experimentOpen({ now: NOW }), true);
  assert.equal(experimentOpen({ now: NOW, verdict: true }), false);
  assert.equal(hasVerdictEntry([{ type: "decision", text: "@per EXP6 verdict: BOTH-ARMS" }]), true);
  const home = mkdtempSync(join(tmpdir(), "exp6-verdict-"));
  mkdirSync(join(home, "logs"));
  assert.equal(readPerfectionVerdict({ home }), false);
  writeFileSync(join(home, "logs", "vibesquad--perfection.jsonl"), JSON.stringify({ type: "decision", text: "@per EXP6 VERDICT: x" }) + "\n");
  assert.equal(readPerfectionVerdict({ home }), true);
});

test("readArmCaps: caller home's file; a corrupt or wrong-shape file throws -> decideArm fails open", async () => {
  const home = mkdtempSync(join(tmpdir(), "exp6-caps-"));
  assert.deepEqual(await readArmCaps({ env: { VIBESQUAD_HOME: home } }), {});
  writeFileSync(join(home, "capped-providers.json"), JSON.stringify({ capped: { gemini: { reason: "cli cap", updatedAt: new Date().toISOString() } } }));
  assert.equal(armCapped("neon", await readArmCaps({ env: { VIBESQUAD_HOME: home } })), true);
  for (const body of ["{ torn", "[1,2]", "\"x\""]) {
    const bad = mkdtempSync(join(tmpdir(), "exp6-badcaps-"));
    writeFileSync(join(bad, "capped-providers.json"), body);
    await assert.rejects(readArmCaps({ env: { VIBESQUAD_HOME: bad } }), undefined, body);
    const r = await decideArm(base({ capProbe: () => readArmCaps({ env: { VIBESQUAD_HOME: bad } }) }));
    assert.deepEqual(pick3(r), ["sonnet", "fail-open", false, SONNET], body);
  }
});

// ---- spawn_worker: result + labels carry arm / reason / model ----
const PROFILES = [...USER_PROFILES, ...PLANNING];
function home(caps) {
  const h = mkdtempSync(join(tmpdir(), "r0-home-"));
  if (caps) writeFileSync(join(h, "capped-providers.json"), JSON.stringify({ capped: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, { reason: "cap", updatedAt: new Date().toISOString(), ...v }])) }));
  return h;
}
function ctxWith(agents, logs, over = {}) {
  const creates = [];
  const backend = {
    createAgent: async (req) => { creates.push(req); agents.push({ createdAt: new Date().toISOString(), labels: req.labels }); return { id: "a1", title: req.config.title }; },
    sendAgentPrompt: async () => {},
    fetchAgents: async () => ({ entries: agents.map((agent) => ({ agent })) }),
  };
  const TEAMS = [{ id: "mx", name: "Matrix", paths: ["matrix"], lanes: [{ id: "feat", name: "Feat" }, { id: "hub", name: "Hub", hub: true }] }];
  const ctx = createContext({
    env: { VIBESQUAD_HOME: home() },
    ...verifiedIdentity({ agentId: "rn-bud1", team: "mx", lane: "feat", role: "brainstorm" }, { backend, teams: TEAMS }),
    cwd: "/w", teams: TEAMS, loadProfiles: async () => PROFILES, ...over,
    withBackend: async (_t, fn) => fn(backend), findLiveLeads: async () => [],
    writeLog: async (e) => { logs.push(e); },
  });
  return { ctx, creates };
}
const go = (ctx, args) => callTool(ctx, "spawn_worker", { title: "t", prompt: "go", ...args });

test("spawn_worker: normal implementer spawns alternate Sonnet -> Neon -> Sonnet, visibly (result + labels + metric)", async () => {
  const agents = [];
  const logs = [];
  const { ctx, creates } = ctxWith(agents, logs);
  const want = [
    ["sonnet", SONNET, "claude", "claude-sonnet-5-5", false],
    ["neon", NEON, "antigravity-cli", "gemini-4-neon", true],
    ["sonnet", SONNET, "claude", "claude-sonnet-5-5", false],
  ];
  for (const [i, [arm, profile, provider, model, swapped]] of want.entries()) {
    const res = await go(ctx, { profile: SONNET, stakes: "normal" });
    const c = creates[i];
    assert.deepEqual([c.labels.profile, c.config.provider, c.config.model], [profile, provider, model], `spawn ${i}`);
    assert.deepEqual([c.labels["vs.arm"], c.labels["vs.arm-reason"], c.labels["vs.model"]], [arm, "alternation", model], `spawn ${i}`);
    assert.equal(c.labels.wf, undefined, "wf is derived by the hook after failover (vs.arm=neon on Gemini -> wf=neon)");
    assert.deepEqual([res.ab.arm, res.ab.reason, res.ab.model, res.ab.profile, res.ab.swapped], [arm, "alternation", model, profile, swapped], `spawn ${i}`);
    assert.equal(res.ab.requested, swapped ? SONNET : undefined);
    assert.equal(res.route, `arm=${arm} reason=alternation model=${model}${swapped ? ` (${SONNET} -> ${NEON})` : ""}`);
    assert.match(logs[i].text, new RegExp(`^implementer-arm: ${SONNET} -> ${profile.replace(/[()]/g, "\\$&")} arm=${arm} reason=alternation model=${model} lane=feat counts=`));
  }
});

test("spawn_worker: capped Neon keeps Sonnet; capped claude picks Neon; both capped keeps the request", async () => {
  const cases = [
    [{ "antigravity-cli": {} }, [ag("sonnet")], SONNET, "claude", "capped:antigravity-cli"],
    [{ claude: {} }, [], NEON, "antigravity-cli", "capped:claude"],
    [{ claude: {}, gemini: {} }, [], SONNET, "claude", "capped:claude+antigravity-cli"],
  ];
  for (const [caps, agents, profile, provider, reason] of cases) {
    const { ctx, creates } = ctxWith([...agents], [], { env: { VIBESQUAD_HOME: home(caps) } });
    const res = await go(ctx, { profile: SONNET, stakes: "normal" });
    assert.deepEqual([creates[0].labels.profile, creates[0].config.provider, res.ab.reason, creates[0].labels["vs.arm-reason"], res.ab.capped], [profile, provider, reason, reason, true], JSON.stringify(caps));
  }
});

test("spawn_worker: pin, wf and explicit provider/model opt out (visible reason, not counted)", async () => {
  for (const [args, reason] of [[{ labels: { ab: "pin" } }, "pin"], [{ labels: { wf: "sonnet" } }, "wf"], [{ model: "claude-opus-5-5" }, "override"], [{ provider: "claude", model: "claude-sonnet-5-5" }, "override"]]) {
    const logs = [];
    const { ctx, creates } = ctxWith([ag("sonnet"), ag("sonnet")], logs);
    const res = await go(ctx, { profile: SONNET, stakes: "normal", ...args });
    assert.equal(creates[0].labels.profile, SONNET, reason);
    assert.equal(creates[0].config.provider, "claude", reason);
    assert.equal(res.ab.swapped, false, reason);
    assert.equal(res.ab.reason, reason);
    assert.equal(creates[0].labels["vs.arm"], undefined, `${reason}: opt-outs never count toward the next pick`);
    assert.equal(creates[0].labels["vs.arm-reason"], reason);
    assert.match(res.route, new RegExp(`reason=${reason}`));
  }
});

test("spawn_worker: DSP never comes from the pick; a DSP request runs DSP, unlabelled", async () => {
  for (const caps of [undefined, { claude: {} }, { claude: {}, "antigravity-cli": {} }]) {
    for (let i = 0; i < 3; i++) {
      const agents = [];
      const { ctx, creates } = ctxWith(agents, [], { env: { VIBESQUAD_HOME: home(caps) } });
      for (let j = 0; j <= i; j++) await go(ctx, { profile: j % 2 ? "Worker" : SONNET, stakes: "normal" });
      for (const c of creates) assert.notEqual(c.config.provider, "opencode", JSON.stringify(caps));
    }
  }
  const logs = [];
  const { ctx, creates } = ctxWith([ag("sonnet"), ag("sonnet")], logs);
  const res = await go(ctx, { profile: DSP, stakes: "normal" });
  assert.deepEqual([creates[0].labels.profile, creates[0].config.provider, res.ab, creates[0].labels["vs.arm"]], [DSP, "opencode", undefined, undefined]);
  assert.equal(logs.length, 0);
});

test("spawn_worker: tierA/mechanical/lead-less/planning/role-name spawns keep today's route, no arm", async () => {
  for (const [args, want] of [
    [{ profile: SONNET, stakes: "tierA-invariant" }, SONNET],
    [{ profile: "Implement - Opus", stakes: "tierA-security" }, "Implement - Opus"],
    [{ profile: "Mechanical - DSF", stakes: "mechanical" }, "Mechanical - DSF"],
    [{ profile: SONNET, stakes: "mechanical" }, SONNET],
    [{ profile: "implement", stakes: "tierA-invariant" }, "Implement"],
    [{ profile: "Implement", stakes: "mechanical" }, "Implement"],
    ...PLANNING.map((p) => [{ profile: p.name, stakes: "normal" }, p.name]),
  ]) {
    const logs = [];
    const { ctx, creates } = ctxWith([ag("sonnet"), ag("sonnet")], logs);
    const res = await go(ctx, args);
    assert.equal(creates[0].labels.profile, want, JSON.stringify(args));
    assert.equal(res.ab, undefined, JSON.stringify(args));
    assert.equal(creates[0].labels["vs.arm-reason"], undefined);
    assert.equal(logs.length, 0);
  }
});

test("R1 spawn_worker: role-name Implement alternates Sonnet -> Neon visibly, keeps profile=Implement, model from the ladder", async () => {
  const agents = [];
  const logs = [];
  const { ctx, creates } = ctxWith(agents, logs);
  const want = [
    ["sonnet", "claude", "claude-sonnet-5-5", false],
    ["neon", "antigravity-cli", "gemini-4-neon", true],
    ["sonnet", "claude", "claude-sonnet-5-5", false],
  ];
  for (const [i, [arm, provider, model, swapped]] of want.entries()) {
    const res = await go(ctx, { profile: "Implement", stakes: "normal" });
    const c = creates[i];
    assert.deepEqual([c.labels.profile, c.config.provider, c.config.model], ["Implement", provider, model], `spawn ${i}`);
    assert.deepEqual([c.labels["vs.arm"], c.labels["vs.arm-reason"], c.labels["vs.model"]], [arm, "alternation", model], `spawn ${i}`);
    assert.deepEqual([res.ab.arm, res.ab.reason, res.ab.model, res.ab.profile, res.ab.swapped, res.ab.requested], [arm, "alternation", model, "Implement", swapped, undefined], `spawn ${i}`);
    assert.equal(res.route, `arm=${arm} reason=alternation model=${model}${swapped ? " (Implement -> antigravity-cli)" : ""}`);
    assert.match(logs[i].text, new RegExp(`^implementer-arm: Implement -> Implement@${provider} arm=${arm} reason=alternation model=${model} lane=feat counts=`));
  }
  // Opt-outs on the role name: visible, not counted, ladder default route.
  for (const [args, reason] of [[{ labels: { ab: "pin" } }, "pin"], [{ provider: "antigravity-cli", model: "gemini-4-neon" }, "override"]]) {
    const { ctx: c2, creates: cr2 } = ctxWith([ag("sonnet")], []);
    const res = await go(c2, { profile: "Implement", stakes: "normal", ...args });
    assert.deepEqual([res.ab.reason, res.ab.swapped, cr2[0].labels["vs.arm"], cr2[0].labels.profile], [reason, false, undefined, "Implement"], reason);
  }
  // Capped Gemini: the Neon arm is skipped, the role stays on Claude.
  const { ctx: c3, creates: cr3 } = ctxWith([ag("sonnet")], [], { env: { VIBESQUAD_HOME: home({ "antigravity-cli": {} }) } });
  const r3 = await go(c3, { profile: "Implement", stakes: "normal" });
  assert.deepEqual([cr3[0].config.provider, r3.ab.reason, cr3[0].labels.profile], ["claude", "capped:antigravity-cli", "Implement"]);
});

test("spawn_worker: caller-supplied vs.arm / vs.model labels are replaced; a throwing writeLog never fails the spawn", async () => {
  const { ctx, creates } = ctxWith([], []);
  ctx.writeLog = async () => { throw new Error("log down"); };
  const res = await go(ctx, { profile: "Review - Gemini", labels: { "vs.arm": "neon", "vs.model": "fake", "vs.arm-reason": "x" } });
  assert.equal(res.id, "a1");
  // R2: vs.model is always this tool's own pick (the model the spawn runs), never the caller's.
  assert.deepEqual([creates[0].labels["vs.arm"], creates[0].labels["vs.model"], creates[0].labels["vs.arm-reason"]], [undefined, creates[0].config.model, undefined]);
  assert.notEqual(creates[0].labels["vs.model"], "fake");
  const r2 = await go(ctx, { profile: SONNET, labels: { "vs.arm": "neon" } });
  assert.equal(r2.ab.arm, "sonnet");
  assert.equal(creates[1].labels["vs.arm"], "sonnet");
});

test("spawn_worker: an uninstalled Neon profile falls back to the requested Sonnet, reason says so", async () => {
  const base0 = createContext({ env: {} });
  const resolveProfile = async (n, ps, o) => (n === NEON ? null : base0.resolveProfile(n, ps, o));
  const { ctx, creates } = ctxWith([ag("sonnet")], [], { resolveProfile });
  const res = await go(ctx, { profile: SONNET, stakes: "normal" });
  assert.deepEqual([creates[0].labels.profile, res.ab.swapped, res.ab.reason, creates[0].labels["vs.arm"]], [SONNET, false, "fail-open:not-installed", "sonnet"]);
});

test("ctx.implementerArms: [] turns the alternation off (R3/R8 seam)", async () => {
  const { ctx, creates } = ctxWith([ag("sonnet")], [], { implementerArms: [] });
  const res = await go(ctx, { profile: SONNET, stakes: "normal" });
  assert.deepEqual([creates[0].labels.profile, res.ab], [SONNET, undefined]);
});
