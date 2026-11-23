import assert from "node:assert/strict";
import test from "node:test";
import { callTool, createContext } from "../server/mcp/tools.mjs";
import { verifiedIdentity } from "./helpers/agent-token.mjs";
import { USER_PROFILES } from "./helpers/route-golden.mjs";
import { armOfProfile, countArms, decideArm, experimentOpen, hasVerdictEntry, pickArm } from "../server/exp6-arm.mjs";

process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
const NOW = Date.parse("2026-11-23T12:00:00Z");
const ag = (wf, over = {}) => ({ createdAt: "2026-11-20T00:00:00Z", labels: { lane: "feat", role: "worker", wf, ...over.labels }, ...over.rec });
const base = (extra = {}) => ({ profile: "Implement - Sonnet", stakes: "", labels: {}, lane: "feat", now: NOW, listAgents: async () => [], ...extra });

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
  assert.equal(await decideArm(base({ verdictProbe: async () => true, listAgents: skew })), null);
});

test("count or verdict-probe failure fails open", async () => {
  const r = await decideArm(base({ listAgents: async () => { throw new Error("boom"); } }));
  assert.deepEqual([r.arm, r.swapped, r.profile, r.counts], ["sonnet", false, "Implement - Sonnet", null]);
  assert.equal(await decideArm(base({ verdictProbe: async () => { throw new Error("x"); } })), null);
});

function ctxWith(agents, logs) {
  const creates = [];
  const backend = {
    createAgent: async (req) => { creates.push(req); return { id: "a1", title: req.config.title }; },
    sendAgentPrompt: async () => {},
    fetchAgents: async () => ({ entries: agents.map((agent) => ({ agent })) }),
  };
  const TEAMS = [{ id: "mx", name: "Matrix", paths: ["matrix"], lanes: [{ id: "feat", name: "Feat" }, { id: "hub", name: "Hub", hub: true }] }];
  const ctx = createContext({
    env: { VIBESQUAD_HOME: "/nonexistent-exp6" },
    ...verifiedIdentity({ agentId: "rn-bud1", team: "mx", lane: "feat", role: "brainstorm" }, { backend, teams: TEAMS }),
    cwd: "/w", teams: TEAMS, loadProfiles: async () => USER_PROFILES,
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
  assert.equal(creates[0].labels.wf, "dsp");
  assert.deepEqual(res.ab, { arm: "dsp", swapped: true, counts: { sonnet: 2, dsp: 0 } });
  assert.match(logs[0].text, /exp6-arm swap/);
  const pinned = await callTool(ctxWith([ag("sonnet"), ag("sonnet")], []).ctx, "spawn_worker", { title: "t", prompt: "go", profile: "Implement - Sonnet", labels: { ab: "pin" } });
  assert.equal(pinned.ab, undefined);
});
