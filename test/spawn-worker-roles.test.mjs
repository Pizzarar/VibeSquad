// P5c fix round (idea-77, Review - Gemini H1): spawn_worker / create_agent / `vs spawn` accept ROLE names ("Implement",
// "Review", "Work Order", "Pre-check", "Art Painter", "Art Director", lowercase "lead") through the real
// createContext().resolveProfile, label the spawn with the role, and keep old names + aliases on today's findProfile path.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callTool, createContext } from "../server/mcp/tools.mjs";
import { verifiedIdentity } from "./helpers/agent-token.mjs";
import { USER_PROFILES } from "./helpers/route-golden.mjs";

process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
// Host-independent EXP6 state (review r2 M1): an empty temp home (no verdict, no caps) and an end date far out, so the
// EXP6 pick neither reads the real ~/.vibesquad nor flips when the default end date passes.
const EMPTY_HOME = mkdtempSync(join(tmpdir(), "spawn-roles-home-"));
const TEAMS = [{ id: "mx", name: "Matrix", paths: ["matrix"], lanes: [{ id: "feat", name: "Feat" }, { id: "hub", name: "Hub", hub: true }] }];

function ctxFor(identity = { agentId: "rn-bud1", team: "mx", lane: "feat", role: "brainstorm" }) {
  const creates = [];
  let n = 0;
  const backend = {
    createAgent: async (req) => {
      const id = `rn-${++n}`;
      creates.push(req);
      return { id, title: req.config.title };
    },
    sendAgentPrompt: async () => {},
    fetchAgents: async () => ({ entries: [] }),
  };
  const ctx = createContext({
    env: { VIBESQUAD_HOME: EMPTY_HOME, VS_EXP6_END: "2999-01-01T00:00:00Z" },
    ...verifiedIdentity(identity, { backend, teams: TEAMS }),
    cwd: "/w",
    teams: TEAMS,
    loadProfiles: async () => USER_PROFILES,
    withBackend: async (_t, fn) => fn(backend),
    findLiveLeads: async () => [],
    writeLog: async () => {},
  });
  return { ctx, creates };
}

const spawn = (ctx, args) => callTool(ctx, "spawn_worker", { title: "t", prompt: "go", ...args });

test("role names spawn as the role: labels.profile = role, config pre-filled from the role route", async () => {
  const rows = [
    ["Implement", "Implement", "claude", "claude-sonnet-5-5", "medium"],
    ["implement", "Implement", "claude", "claude-sonnet-5-5", "medium"],
    ["Review", "Review", "antigravity-cli", "gemini-4-neon", undefined],
    ["Work Order", "Work Order", "opencode", undefined, undefined],
    ["Pre-check", "Pre-check", "antigravity-cli", "gemini-3.8-flash", undefined],
  ];
  for (const [asked, label, provider, model, effort] of rows) {
    const { ctx, creates } = ctxFor();
    await spawn(ctx, { profile: asked });
    assert.equal(creates.length, 1, asked);
    const req = creates[0];
    assert.equal(req.labels.profile, label, asked);
    assert.equal(req.env.VS_PROFILE, label, asked);
    assert.equal(req.labels.role, "worker", asked);
    assert.equal(req.config.provider, provider, asked);
    if (model) assert.equal(req.config.model, model, asked);
    if (effort) assert.equal(req.config.thinkingOptionId, effort, asked);
  }
});

test("role name + stakes tierA-invariant pre-fills the top rung (the hook re-routes it the same way)", async () => {
  const { ctx, creates } = ctxFor();
  await spawn(ctx, { profile: "Implement", stakes: "tierA-invariant" });
  assert.equal(creates[0].config.model, "claude-opus-5-5");
  assert.equal(creates[0].config.thinkingOptionId, "high");
  assert.equal(creates[0].labels.stakes, "tierA-invariant");
  assert.equal(creates[0].labels["vs.profile-derived"], "model,thinking");
});

test("old names and aliases keep today's findProfile path and their old label", async () => {
  for (const [asked, label] of [
    ["Implement - Sonnet", "Implement - Sonnet"],
    ["Review - Gemini", "Review - Gemini"],
    ["Lead", "Lead - Claude"],
    ["worker", "Implement - Sonnet"],
  ]) {
    const { ctx, creates } = ctxFor();
    await spawn(ctx, { profile: asked });
    assert.equal(creates[0].labels.profile, label, asked);
  }
  const { ctx } = ctxFor();
  await assert.rejects(spawn(ctx, { profile: "No Such Thing" }), /unknown profile "No Such Thing"/);
});

test("a Buddy spawns its lane lead by the lead ROLE (profile 'lead'), labelled lowercase lead; a worker role is refused", async () => {
  {
    const { ctx, creates } = ctxFor();
    await spawn(ctx, { profile: "lead", labels: { role: "lead" } });
    assert.equal(creates[0].labels.profile, "lead");
    assert.equal(creates[0].labels.role, "lead");
    assert.equal(creates[0].labels.lead, "feat");
    assert.equal(creates[0].config.provider, "claude");
    assert.equal(creates[0].config.model, "claude-opus-5-5");
    assert.equal(creates[0].config.thinkingOptionId, "high");
  }
  {
    const { ctx, creates } = ctxFor();
    await spawn(ctx, { profile: "Lead - Gemini", labels: { role: "lead" } });
    assert.equal(creates[0].labels.profile, "Lead - Gemini");
  }
  {
    const { ctx, creates } = ctxFor();
    await assert.rejects(spawn(ctx, { profile: "Implement", labels: { role: "lead" } }), /is not a "Lead - " profile/);
    assert.equal(creates.length, 0);
  }
});

test("Art Painter role spawn starts the Art Director role partner (role names pair with role names)", async () => {
  const { ctx, creates } = ctxFor({ agentId: "rn-lead", team: "mx", lane: "feat", role: "lead" });
  const out = await spawn(ctx, { title: "neon", profile: "Art Painter", prompt: "draw it" });
  assert.equal(creates.length, 2);
  assert.equal(creates[0].labels.profile, "Art Painter");
  assert.equal(creates[1].labels.profile, "Art Director");
  assert.equal(creates[1].config.provider, "antigravity-cli");
  assert.match(creates[1].initialPrompt, /Painter is agent rn-1/);
  assert.equal(out.partner, "rn-2");
});

// H1 (R1 fix, idea-974): a role-name spawn's caller provider/model are named in vs.route-override so the spawn hook can
// tell them from a filled-in default; the role route pre-fills THAT provider's rung. Old names never get the label.
test("H1: role spawn + caller provider/model stamps vs.route-override and pre-fills the caller provider's rung", async () => {
  {
    const { ctx, creates } = ctxFor();
    await spawn(ctx, { profile: "Review", provider: "claude", model: "claude-sonnet-5-5", stakes: "tierA-invariant" });
    const req = creates[0];
    assert.equal(req.labels["vs.route-override"], "provider=claude model=claude-sonnet-5-5");
    assert.deepEqual([req.config.provider, req.config.model, req.config.thinkingOptionId], ["claude", "claude-sonnet-5-5", "high"]);
    assert.equal(req.labels.profile, "Review");
  }
  {
    const { ctx, creates } = ctxFor();
    await spawn(ctx, { profile: "Review", provider: "claude", stakes: "tierA-invariant" });
    const req = creates[0];
    assert.equal(req.labels["vs.route-override"], "provider=claude");
    assert.deepEqual([req.config.provider, req.config.model, req.config.thinkingOptionId], ["claude", "claude-opus-5-5", "high"]);
    assert.equal(req.labels["vs.profile-derived"], "model,thinking"); // the rung is not the caller's model
  }
  {
    const { ctx, creates } = ctxFor();
    await spawn(ctx, { profile: "Review", model: "claude-sonnet-5-5" });
    assert.equal(creates[0].labels["vs.route-override"], "model=claude-sonnet-5-5");
    assert.equal(creates[0].config.provider, "claude");
  }
});

test("H1: no override = no label; a caller-forged vs.route-override is stripped; old names never get it", async () => {
  {
    const { ctx, creates } = ctxFor();
    await spawn(ctx, { profile: "Review", labels: { "vs.route-override": "provider=claude" } });
    assert.equal(creates[0].labels["vs.route-override"], undefined);
    assert.equal(creates[0].config.provider, "antigravity-cli");
  }
  {
    const { ctx, creates } = ctxFor();
    await spawn(ctx, { profile: "Review - Gemini", provider: "claude" });
    assert.equal(creates[0].labels["vs.route-override"], undefined);
  }
});

test("Gemini L2: Implement + explicit provider keeps role: true on result.ab, so result.ab.provider is reported", async () => {
  const { ctx, creates } = ctxFor();
  const res = await spawn(ctx, { profile: "Implement", provider: "antigravity-cli" });
  assert.equal(res.ab?.reason, "override");
  assert.equal(res.ab?.provider, "antigravity-cli");
  assert.equal(creates[0].labels.profile, "Implement");
  assert.equal(creates[0].labels["vs.route-override"], "provider=antigravity-cli");
  assert.equal(creates[0].config.model, "gemini-4-neon");
});
