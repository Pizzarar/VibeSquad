// X2 (@per PLAN_PER_CRUNCH_1127, idea-1118): Gemini Carbon is a third Implement arm next to Neon (EXP13 quality trial).
// Weights sonnet 1 : neon 1 : carbon 1 keep G1's Claude:Gemini split (1:2); Carbon shares Neon's family, so one
// antigravity-cli cap (or soft line) caps both; tierA stakes never get an arm; wf=carbon is stamped; tierA-security
// Implement with no override lands on Opus (idea-1191 regression).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { callTool, createContext } from "../server/mcp/tools.mjs";
import { ARMS, ARM_WEIGHTS, IMPLEMENTER_ARMS, armCapKey, armModel, armRouteFor, decideArm } from "../server/exp6-arm.mjs";
import { GEMINI_CARBON_MODEL } from "../server/model-ids.mjs";
import { roleSpawnProfile } from "../server/spawn-route.mjs";
import { deriveWfArm, resolveWfLabel } from "../server/wf-label.mjs";
import { verifiedIdentity } from "./helpers/agent-token.mjs";
import { USER_PROFILES } from "./helpers/route-golden.mjs";

process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";

const ag = (arm, labels = {}) => ({ createdAt: "2026-11-27T00:00:00Z", labels: { lane: "feat", team: "mx", role: "worker", ...(arm ? { "vs.arm": arm } : {}), ...labels } });
const base = (extra = {}) => ({ team: "mx", profile: "Implement", stakes: "normal", labels: {}, lane: "feat", listAgents: async () => [], capProbe: async () => ({}), ...extra });

function home(caps) {
  const h = mkdtempSync(join(tmpdir(), "x2-carbon-home-"));
  if (caps) {
    const capped = Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, { reason: "cap", updatedAt: new Date().toISOString(), ...v }]));
    writeFileSync(join(h, "capped-providers.json"), JSON.stringify({ capped }));
  }
  return h;
}

function ctxWith(agents, over = {}) {
  const creates = [];
  const backend = {
    createAgent: async (req) => {
      creates.push(req);
      agents.push({ createdAt: new Date().toISOString(), labels: req.labels });
      return { id: `a${creates.length}`, title: req.config.title };
    },
    sendAgentPrompt: async () => {},
    fetchAgents: async () => ({ entries: agents.map((agent) => ({ agent })) }),
  };
  const TEAMS = [{ id: "mx", name: "Matrix", paths: ["matrix"], lanes: [{ id: "feat", name: "Feat" }] }];
  const ctx = createContext({
    env: { VIBESQUAD_HOME: home() },
    ...verifiedIdentity({ agentId: "rn-bud1", team: "mx", lane: "feat", role: "brainstorm" }, { backend, teams: TEAMS }),
    cwd: "/w",
    teams: TEAMS,
    loadProfiles: async () => USER_PROFILES,
    ...over,
    withBackend: async (_t, fn) => fn(backend),
    findLiveLeads: async () => [],
    writeLog: async () => {},
  });
  return { ctx, creates };
}
const go = (ctx, args) => callTool(ctx, "spawn_worker", { title: "t", prompt: "go", ...args });

test("X2 arm table: carbon is an antigravity-cli arm with its own model, role spawns only", () => {
  assert.deepEqual(IMPLEMENTER_ARMS, ["sonnet", "neon", "carbon"]);
  assert.deepEqual(ARM_WEIGHTS, { sonnet: 1, neon: 1, carbon: 1 });
  assert.equal(GEMINI_CARBON_MODEL, "gemini-4-carbon");
  assert.deepEqual([ARMS.carbon.provider, ARMS.carbon.model, ARMS.carbon.profile, ARMS.carbon.legacyAs], ["antigravity-cli", "gemini-4-carbon", null, "neon"]);
  assert.deepEqual([armModel("carbon"), armModel("CARBON"), armModel("neon"), armModel("")], ["gemini-4-carbon", "gemini-4-carbon", "", ""]);
  assert.deepEqual(armRouteFor("Implement", "carbon"), { prefer: "antigravity-cli", tier: "", armModel: "gemini-4-carbon" });
  assert.deepEqual(armRouteFor("Review", "carbon"), { prefer: "", tier: "" });
});

test("X2 alternation: role Implement picks sonnet/neon/carbon 1:1:1 (Gemini keeps 2 of 3); old names fold carbon into neon", async () => {
  const lane = [];
  const seen = [];
  for (let i = 0; i < 9; i++) {
    const r = await decideArm(base({ listAgents: async () => lane }));
    assert.equal(r.reason, "alternation");
    seen.push(r.arm);
    lane.push(ag(r.arm));
  }
  assert.deepEqual(seen, ["sonnet", "neon", "carbon", "sonnet", "neon", "carbon", "sonnet", "neon", "carbon"]);
  assert.equal(seen.filter((a) => a === "sonnet").length / seen.length, 1 / 3, "Claude share unchanged from G1");
  const c = await decideArm(base({ listAgents: async () => [ag("sonnet"), ag("neon")] }));
  assert.deepEqual([c.arm, c.provider, c.armModel, c.swapped, c.profile], ["carbon", "antigravity-cli", "gemini-4-carbon", true, "Implement"]);
  assert.deepEqual(c.counts, { sonnet: 1, neon: 1, carbon: 0 });
  const n = await decideArm(base({ listAgents: async () => [ag("sonnet")] }));
  assert.equal(n.armModel, undefined, "neon names no model: the ladder rung does");
  // Old name (`Implement - Sonnet`): carbon has no old profile, so it folds into neon (weight 2, picks summed) = G1's S,N,N.
  const old = [];
  const oseq = [];
  for (let i = 0; i < 6; i++) {
    const r = await decideArm(base({ profile: "Implement - Sonnet", listAgents: async () => [...old] }));
    oseq.push(r.arm);
    old.push(ag(r.arm));
  }
  assert.deepEqual(oseq, ["sonnet", "neon", "neon", "sonnet", "neon", "neon"]);
  // Role-spawn carbon picks count as Gemini for an old-name spawn: 1 sonnet + 2 carbon -> sonnet's turn.
  const mixed = await decideArm(base({ profile: "Implement - Sonnet", listAgents: async () => [ag("sonnet"), ag("carbon"), ag("carbon")] }));
  assert.deepEqual([mixed.arm, mixed.counts], ["sonnet", { sonnet: 1, neon: 2 }]);
});

test("X2 caps: a capped (or past-soft-line) antigravity-cli caps neon and carbon together", async () => {
  for (const caps of [{ "antigravity-cli": {} }, { agy: {} }, { gemini: {} }, ["antigravity"], { "gemini-4-neon": {} }, { "gemini-4-carbon": {} }, { "antigravity-cli/gemini-4-carbon": {} }]) {
    assert.notEqual(armCapKey("neon", caps), "", JSON.stringify(caps));
    assert.equal(armCapKey("carbon", caps), armCapKey("neon", caps), JSON.stringify(caps));
    assert.equal(armCapKey("sonnet", caps), "", JSON.stringify(caps));
  }
  assert.equal(armCapKey("carbon", { claude: {}, "agy-claude": {}, opencode: {} }), "");
  // Carbon's turn (sonnet + neon picked) with Gemini hard-capped: sonnet, reason names the cap.
  const turn = async () => [ag("sonnet"), ag("neon")];
  const hard = await decideArm(base({ listAgents: turn, capProbe: async () => ({ "antigravity-cli": {} }) }));
  assert.deepEqual([hard.arm, hard.reason, hard.capped, hard.provider], ["sonnet", "capped:antigravity-cli", true, "claude"]);
  // Past the soft line (non-interruptible normal work): both Gemini arms skipped, Sonnet runs, reported soft (not capped).
  const soft = await decideArm(base({ listAgents: turn, capProbe: async () => ({ "antigravity-cli": { soft: true, reason: "pool 78% >= soft 70: interruptible only" } }) }));
  assert.deepEqual([soft.arm, soft.soft, soft.capped], ["sonnet", true, undefined]);
  assert.match(soft.reason, /^antigravity-cli pool 78% >= soft 70: interruptible only -> claude$/);
  // Claude capped on both routes: Gemini arms keep alternating between themselves.
  const cl = await decideArm(base({ listAgents: async () => [ag("neon")], capProbe: async () => ({ claude: {}, "agy-claude": {} }) }));
  assert.deepEqual([cl.arm, cl.reason], ["carbon", "capped:claude"]);
  // spawn_worker end to end: a capped Gemini never lands a Carbon spawn.
  const { ctx, creates } = ctxWith([ag("sonnet"), ag("neon")], { env: { VIBESQUAD_HOME: home({ "antigravity-cli": {} }) } });
  const res = await go(ctx, { profile: "Implement", stakes: "normal" });
  assert.deepEqual([res.ab.arm, creates[0].labels["vs.arm"], creates[0].config.model], ["sonnet", "sonnet", "claude-sonnet-5-5-medium"]);
});

test("X2 spawn_worker: a Carbon pick runs gemini-4-carbon on antigravity-cli, visibly", async () => {
  const { ctx, creates } = ctxWith([ag("sonnet"), ag("neon")]);
  const res = await go(ctx, { profile: "Implement", stakes: "normal" });
  const c = creates[0];
  assert.deepEqual([c.labels.profile, c.config.provider, c.config.model], ["Implement", "antigravity-cli", "gemini-4-carbon"]);
  assert.deepEqual([c.labels["vs.arm"], c.labels["vs.arm-reason"], c.labels["vs.model"]], ["carbon", "alternation", "gemini-4-carbon"]);
  assert.equal(res.route, "arm=carbon reason=alternation model=gemini-4-carbon (Implement -> antigravity-cli)");
});

test("X2 tierA: tierA-invariant / tierA-security Implement never gets the carbon arm or model", async () => {
  const carbonTurn = async () => [ag("sonnet"), ag("neon")];
  for (const stakes of ["tierA-invariant", "tierA-security"]) {
    assert.equal(await decideArm(base({ stakes, listAgents: carbonTurn })), null, stakes);
    // An inherited vs.arm=carbon (respawn) at tierA keeps the ladder rung: never Carbon.
    const hit = roleSpawnProfile("Implement", { stakes, ...armRouteFor("Implement", "carbon") });
    assert.notEqual(hit.profile.model, "gemini-4-carbon", stakes);
    assert.equal(hit.route.tier, "top", stakes);
    const { ctx, creates } = ctxWith([ag("sonnet"), ag("neon")]);
    const res = await go(ctx, { profile: "Implement", stakes });
    assert.equal(res.ab, undefined, stakes);
    assert.equal(creates[0].labels["vs.arm"], undefined, stakes);
    assert.doesNotMatch(String(creates[0].config.model), /carbon/, stakes);
  }
  // Mechanical keeps today's route too (cheap rung), even with an inherited carbon label.
  const mech = roleSpawnProfile("Implement", { stakes: "mechanical", ...armRouteFor("Implement", "carbon") });
  assert.notEqual(mech.profile.model, "gemini-4-carbon");
  // Normal: the arm model applies only on its own family; a capped Gemini hops with the rung model of the hop.
  const normal = roleSpawnProfile("Implement", { stakes: "normal", ...armRouteFor("Implement", "carbon") });
  assert.deepEqual([normal.profile.provider, normal.profile.model, normal.route.model], ["antigravity-cli", "gemini-4-carbon", "gemini-4-carbon"]);
  const hop = roleSpawnProfile("Implement", { stakes: "normal", caps: ["antigravity-cli"], ...armRouteFor("Implement", "carbon") });
  assert.doesNotMatch(String(hop.profile.model), /carbon/);
  // A caller override wins over the arm model.
  const ov = roleSpawnProfile("Implement", { stakes: "normal", ...armRouteFor("Implement", "carbon"), override: { provider: "antigravity-cli", model: "gemini-4-neon" } });
  assert.equal(ov.profile.model, "gemini-4-neon");
});

test("idea-1191 regression: tierA-security Implement with no override lands on Opus", async () => {
  const hit = roleSpawnProfile("Implement", { stakes: "tierA-security" });
  assert.match(hit.profile.model, /^claude-opus-/);
  assert.equal(hit.route.tier, "top");
  assert.equal(hit.override, null);
  const { ctx, creates } = ctxWith([]);
  await go(ctx, { profile: "Implement", stakes: "tierA-security" });
  assert.match(String(creates[0].config.model), /^claude-opus-/);
  assert.doesNotMatch(String(creates[0].config.model), /fable/);
});

test("X2 wf-label: Carbon runs are wf=carbon; a carbon pick that hopped off Carbon derives what it ran", () => {
  assert.equal(deriveWfArm({ provider: "antigravity-cli", model: "gemini-4-carbon" }), "carbon");
  assert.equal(deriveWfArm({ provider: "antigravity-cli", model: "gemini-4-carbon-medium" }), "carbon");
  assert.equal(deriveWfArm({ provider: "antigravity-cli", model: "gemini-4-neon" }), "gemini");
  assert.equal(resolveWfLabel({ labels: { "vs.arm": "carbon" }, provider: "antigravity-cli", model: "gemini-4-carbon" }), "carbon");
  assert.equal(resolveWfLabel({ labels: { "vs.arm": "carbon" }, provider: "antigravity-cli", model: "claude-sonnet-5-5-medium" }), "sonnet");
  assert.equal(resolveWfLabel({ labels: { "vs.arm": "neon" }, provider: "antigravity-cli", model: "gemini-4-neon" }), "neon");
  assert.equal(resolveWfLabel({ labels: { wf: "[wf:carbon]" } }), "carbon");
});
