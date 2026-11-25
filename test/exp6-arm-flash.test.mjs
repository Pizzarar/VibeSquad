// R8 (PLAN_PER_ROLES_LADDER_1125 Amend 11-25): opt-in Gemini Flash tier arm for stakes=normal Implement spawns.
// Flash never joins IMPLEMENTER_ARMS; it routes to the antigravity-cli cheap ladder rung (gemini-3.8-flash) when opted in,
// stamps vs.arm=flash with reason=opt-in, and respects ARM_CAP_FAMILIES (capped antigravity keeps the requested profile).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { callTool, createContext } from "../server/mcp/tools.mjs";
import { ARMS, IMPLEMENTER_ARMS, armRouteFor, armCapKey, armCapped, armProvider, armTier, countArms, decideArm } from "../server/exp6-arm.mjs";
import { roleSpawnConfig, roleSpawnProfile } from "../server/spawn-route.mjs";
import { verifiedIdentity } from "./helpers/agent-token.mjs";
import { USER_PROFILES } from "./helpers/route-golden.mjs";

process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";

const ag = (arm, over = {}) => ({
  createdAt: "2026-11-25T00:00:00Z",
  labels: { lane: "feat", team: "mx", role: "worker", ...(arm ? { "vs.arm": arm } : {}), ...over.labels },
});
const base = (extra = {}) => ({
  team: "mx",
  profile: "Implement",
  stakes: "normal",
  labels: {},
  lane: "feat",
  listAgents: async () => [],
  capProbe: async () => ({}),
  ...extra,
});

function home(caps) {
  const h = mkdtempSync(join(tmpdir(), "r8-flash-home-"));
  if (caps) {
    writeFileSync(
      join(h, "capped-providers.json"),
      JSON.stringify({ capped: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, { reason: "cap", updatedAt: new Date().toISOString(), ...v }])) }),
    );
  }
  return h;
}

function ctxWith(agents, logs, over = {}) {
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
    writeLog: async (e) => { logs.push(e); },
  });
  return { ctx, creates };
}

const go = (ctx, args) => callTool(ctx, "spawn_worker", { title: "t", prompt: "go", ...args });

test("R8 flash arm config: opt-in only, provider antigravity-cli + tier cheap, not in IMPLEMENTER_ARMS", () => {
  assert.deepEqual(IMPLEMENTER_ARMS, ["sonnet", "neon"]);
  assert.equal(IMPLEMENTER_ARMS.includes("flash"), false);
  assert.deepEqual(
    [ARMS.flash.provider, ARMS.flash.tier, ARMS.flash.optIn, armProvider("flash"), armTier("flash")],
    ["antigravity-cli", "cheap", true, "antigravity-cli", "cheap"],
  );
  assert.deepEqual([armTier("neon"), armTier("sonnet"), armTier("")], ["", "", ""]);
  assert.equal(armCapped("flash", { "antigravity-cli": {} }), true);
  assert.equal(armCapped("flash", { gemini: {} }), true);
  assert.equal(armCapped("flash", { "gemini-3.8-flash": {} }), true);
  assert.equal(armCapped("flash", { claude: {} }), false);
});

test("R8 decideArm: opt-in flash via labels.ab or labels.wf, capped antigravity falls back, probe error fails open", async () => {
  for (const labels of [{ ab: "flash" }, { ab: "FLASH" }, { wf: "flash" }]) {
    const r = await decideArm(base({ labels }));
    assert.deepEqual(
      [r.arm, r.reason, r.swapped, r.profile, r.role, r.provider, r.tier],
      ["flash", "opt-in", true, "Implement", true, "antigravity-cli", "cheap"],
      JSON.stringify(labels),
    );
  }
  // Capped antigravity keeps the requested profile with reason capped:<family>.
  for (const caps of [{ "antigravity-cli": {} }, { gemini: {} }, { agy: {} }, { "gemini-3.8-flash": {} }]) {
    const r = await decideArm(base({ labels: { ab: "flash" }, capProbe: async () => caps }));
    assert.deepEqual(
      [r.arm, r.reason, r.swapped, r.profile, r.capped, r.provider, r.tier],
      ["sonnet", `capped:${armCapKey("flash", caps)}`, false, "Implement", true, undefined, undefined],
      JSON.stringify(caps),
    );
  }
  // Cap probe error fails open: keeps requested profile, never stamps flash.
  const err = await decideArm(base({ labels: { ab: "flash" }, capProbe: async () => { throw new Error("disk"); } }));
  assert.deepEqual([err.arm, err.reason, err.swapped, err.tier], ["sonnet", "fail-open", false, undefined]);
  // Pin beats wf=flash.
  const pin = await decideArm(base({ labels: { ab: "pin", wf: "flash" } }));
  assert.deepEqual([pin.arm, pin.reason, pin.swapped], ["sonnet", "pin", false]);
  // Non-normal stakes never take the opt-in flash arm.
  for (const stakes of ["tierA-invariant", "tierA-security", "mechanical"]) {
    assert.equal(await decideArm(base({ stakes, labels: { ab: "flash" } })), null, stakes);
  }
});

test("R8 spawn-route: roleSpawnProfile / roleSpawnConfig land on cheap rung (gemini-3.8-flash) for Implement + flash", () => {
  const cfg = roleSpawnConfig("Implement", { profiles: USER_PROFILES, prefer: "antigravity-cli", tier: "cheap" });
  assert.deepEqual(
    [cfg.profileName, cfg.spawnCfg.provider, cfg.spawnCfg.model, cfg.spawnCfg.modeId, cfg.route.tier],
    ["Implement", "antigravity-cli", "gemini-3.8-flash", "accept-edits", "cheap"],
  );
  // Capped antigravity fails over to Claude at the role's default mid tier (not cheap).
  const capped = roleSpawnProfile("Implement", { prefer: "antigravity-cli", tier: "cheap", caps: ["antigravity-cli"] });
  assert.deepEqual([capped.profile.provider, capped.profile.model, capped.route.tier, capped.route.reason], ["claude", "claude-sonnet-5-5", "mid", "failover"]);
  // tierA stakes still force top tier even if tier=cheap is passed.
  const tierA = roleSpawnProfile("Implement", { prefer: "antigravity-cli", tier: "cheap", stakes: "tierA-invariant" });
  assert.deepEqual([tierA.profile.provider, tierA.profile.model, tierA.route.tier], ["antigravity-cli", "gemini-4-neon", "top"]);
});

test("R8 spawn_worker: opt-in flash stamps vs.arm=flash and routes to gemini-3.8-flash; default alternates sonnet|neon only", async () => {
  const agents = [];
  const logs = [];
  const { ctx, creates } = ctxWith(agents, logs);

  // Opt-in flash spawn
  const fl = await go(ctx, { profile: "Implement", stakes: "normal", labels: { ab: "flash" } });
  assert.deepEqual([creates[0].labels.profile, creates[0].config.provider, creates[0].config.model], ["Implement", "antigravity-cli", "gemini-3.8-flash"]);
  assert.deepEqual([creates[0].labels["vs.arm"], creates[0].labels["vs.arm-reason"], creates[0].labels["vs.model"]], ["flash", "opt-in", "gemini-3.8-flash"]);
  assert.deepEqual([fl.ab.arm, fl.ab.reason, fl.ab.model, fl.ab.provider], ["flash", "opt-in", "gemini-3.8-flash", "antigravity-cli"]);
  assert.equal(fl.route, "arm=flash reason=opt-in model=gemini-3.8-flash (Implement -> antigravity-cli)");
  assert.deepEqual(countArms(agents, { lane: "feat", team: "mx" }), { sonnet: 0, neon: 0 }, "flash does not skew sonnet/neon counts");

  // Default normal Implement spawns still alternate sonnet, neon, neon (2:1 Neon:Sonnet, @per G1; never flash).
  const seq = [];
  for (let i = 0; i < 4; i++) {
    const r = await go(ctx, { profile: "Implement", stakes: "normal" });
    seq.push([r.ab.arm, creates[i + 1].config.model]);
  }
  assert.deepEqual(seq, [
    ["sonnet", "claude-sonnet-5-5"],
    ["neon", "gemini-4-neon"],
    ["neon", "gemini-4-neon"],
    ["sonnet", "claude-sonnet-5-5"],
  ]);

  // Capped antigravity falls back to Claude Sonnet with reason capped:antigravity-cli.
  const { ctx: c2, creates: cr2 } = ctxWith([], [], { env: { VIBESQUAD_HOME: home({ "antigravity-cli": {} }) } });
  const capped = await go(c2, { profile: "Implement", stakes: "normal", labels: { ab: "flash" } });
  assert.deepEqual([cr2[0].labels.profile, cr2[0].config.provider, cr2[0].config.model], ["Implement", "claude", "claude-sonnet-5-5"]);
  assert.deepEqual([cr2[0].labels["vs.arm"], cr2[0].labels["vs.arm-reason"], capped.ab.reason, capped.ab.capped], ["sonnet", "capped:antigravity-cli", "capped:antigravity-cli", true]);
});

test("armtier-gate armRouteFor: only the Implement role takes the arm's provider/tier", () => {
  assert.deepEqual(armRouteFor("Implement", "flash"), { prefer: "antigravity-cli", tier: "cheap" });
  assert.equal(armRouteFor("implement", "neon").prefer, "antigravity-cli");
  for (const role of ["Review", "Pre-check", "Planner", "Implement - Sonnet", ""]) {
    assert.deepEqual(armRouteFor(role, "flash"), { prefer: "", tier: "" }, role);
  }
});
