// PLAN_V03_STABILIZE M1: a message traced agent -> inbox -> vs send -> MCP send -> Send card -> Overlord -> lane Buddy.
// At every hop the message is delivered or the failure reaches the sender (error / card state); nothing drops silently.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { addInboxCards, readInboxCards, sendInboxCard, triageInboxCards, writeInboxCards } from "../server/inbox.mjs";
import { callTool } from "../server/mcp/tools.mjs";
import { runAgentVerb } from "../cli/vs.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const teamsDir = mkdtempSync(path.join(tmpdir(), "vs-trace-teams-"));
const teamsFile = path.join(teamsDir, "teams.json");
writeFileSync(
  teamsFile,
  JSON.stringify({
    teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", name: "VibeSquad", hub: true }, { id: "bug-chaser", name: "Bug Chaser", aliases: ["bug"] }, { id: "empty-lane", name: "Empty" }] }],
  }),
);
process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
test.after(() => rmSync(teamsDir, { recursive: true, force: true }));

const home = (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "vs-trace-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
};
const agent = (id, role, lane) => ({ id, title: `${role} ${id}`, status: "idle", labels: { role, team: "vibesquad", lane } });
const client = (agents, { failSend } = {}) => {
  const sent = [];
  return {
    sent,
    fetchAgents: async () => ({ entries: agents.map((a) => ({ agent: a })) }),
    sendAgentPrompt: async (id, text) => {
      if (failSend) throw new Error(failSend);
      sent.push({ id, text });
    },
  };
};
const ctxWith = (backend, identity = { agentId: "", team: "vibesquad", lane: "bug-chaser", role: "worker" }) => ({
  identity,
  withBackend: async (_o, fn) => fn(backend),
});

// Hop 1: agent -> inbox (`vs inbox add`)
test("hop1 inbox add: a card on a real lane is parked; an unknown lane is refused, not parked where nobody looks", (t) => {
  const baseHome = home(t);
  const ok = addInboxCards({ ideas: ["fix the thing"], laneId: "bug-chaser", teamId: "vibesquad", baseHome }, repoRoot);
  assert.equal(ok.added[0].laneId, "bug-chaser");
  assert.throws(() => addInboxCards({ ideas: ["lost thing"], laneId: "bug-chasr", baseHome }, repoRoot), /unknown lane "bug-chasr"/);
  assert.equal(readInboxCards(baseHome).length, 1);
});

// Hop 2: `vs send` CLI verb + Hop 3: MCP send tool (same tools.mjs path)
test("hop2/3 vs send + MCP send: delivered returns sent:true; backend failure (dead Buddy, runner down) rejects to the sender", async () => {
  const sent = [];
  const good = ctxWith({ sendAgentPrompt: async (id, text) => void sent.push([id, text]) });
  assert.deepEqual(await runAgentVerb("send", { _: ["rn-bud", "hello"] }, good), { id: "rn-bud", sent: true });
  assert.deepEqual(await callTool(good, "send", { id: "rn-bud", text: "hi" }), { id: "rn-bud", sent: true });
  assert.equal(sent.length, 2);
  const dead = ctxWith({ sendAgentPrompt: async () => { throw new Error("agent rn-bud is not running"); } });
  await assert.rejects(runAgentVerb("send", { _: ["rn-bud", "hello"] }, dead), /not running/);
  await assert.rejects(callTool(dead, "send", { id: "rn-bud", text: "hi" }), /not running/);
  const down = { identity: dead.identity, withBackend: async () => { throw new Error("RUNNER_DOWN"); } };
  await assert.rejects(callTool(down, "send", { id: "rn-bud", text: "hi" }), /RUNNER_DOWN/);
  await assert.rejects(callTool(good, "send", { id: "rn-bud", text: "  " }), /text is required/);
});

test("hop2/3 send to a retired Buddy: the redirect target surfaces as redirectedTo to the sender (vs send + MCP)", async () => {
  const redirecting = ctxWith({ sendAgentPrompt: async () => ({ redirectedTo: "rn-new" }) });
  assert.deepEqual(await runAgentVerb("send", { _: ["rn-old", "hello"] }, redirecting), { id: "rn-old", sent: true, redirectedTo: "rn-new" });
  assert.deepEqual(await callTool(redirecting, "send", { id: "rn-old", text: "hi" }), { id: "rn-old", sent: true, redirectedTo: "rn-new" });
});

test("runner backend sendAgentPrompt returns {redirectedTo} when the retired-lead hook redirects", async () => {
  const { RunnerBackend } = await import("../server/backend/runner-backend.mjs");
  const fake = { hookHost: async () => ({ before: async () => ({ redirected: true, agentId: "rn-new", targetAgentId: "rn-new" }) }) };
  const res = await RunnerBackend.prototype.sendAgentPrompt.call(fake, "rn-old", "hi", { senderId: "rn-sender" });
  assert.deepEqual(res, { redirectedTo: "rn-new" });
});

// Hop 4: Send card (UI decision card) -> lane Buddy
test("hop4 Send card: delivered stamps the card; a refused send leaves it undelivered and throws the reason", async (t) => {
  const baseHome = home(t);
  const now = new Date().toISOString();
  writeInboxCards([{ id: "c1", title: "c1", text: "t", teamId: "vibesquad", laneId: "bug-chaser", scope: "other", status: "parked", createdAt: now, updatedAt: now }], baseHome);
  const bad = client([agent("bud", "brainstorm", "bug-chaser")], { failSend: "agent bud is not running" });
  await assert.rejects(sendInboxCard({ cardId: "c1", baseHome, agentClient: bad }, repoRoot), /not running/);
  assert.equal(readInboxCards(baseHome)[0].deliveredAt, undefined);
  const good = client([agent("bud", "brainstorm", "bug-chaser")]);
  const res = await sendInboxCard({ cardId: "c1", baseHome, agentClient: good }, repoRoot);
  assert.equal(res.agentId, "bud");
  assert.ok(readInboxCards(baseHome)[0].deliveredAt);
});

// Hop 5: Overlord route (unassigned -> hub lead), then bounce to a lane
test("hop5 Overlord: unassigned goes to the hub lead; no Overlord throws; a bounce to a typo'd lane is refused", async (t) => {
  const baseHome = home(t);
  const now = new Date().toISOString();
  writeInboxCards([{ id: "u1", title: "u1", text: "t", teamId: "vibesquad", laneId: "_unassigned", scope: "other", status: "parked", createdAt: now, updatedAt: now }], baseHome);
  await assert.rejects(sendInboxCard({ cardId: "u1", baseHome, agentClient: client([]) }, repoRoot), /No live Overlord/);
  const c = client([agent("ovl", "lead", "vibesquad")]);
  await sendInboxCard({ cardId: "u1", baseHome, agentClient: c }, repoRoot);
  assert.equal(c.sent[0].id, "ovl");
  assert.throws(() => triageInboxCards({ action: "bounce", cardId: "u1", laneId: "bug-chasr", baseHome }, repoRoot), /unknown lane "bug-chasr"/);
  triageInboxCards({ action: "bounce", cardId: "u1", laneId: "bug", baseHome }, repoRoot);
  assert.equal(readInboxCards(baseHome)[0].deliveredAt, undefined);
});

// Hop 6: lane Buddy resolution: dead/absent Buddy falls to lead, none at all errors
test("hop6 lane Buddy: archived Buddy is skipped for the lead; a lane with nobody throws", async (t) => {
  const baseHome = home(t);
  const now = new Date().toISOString();
  const card = (id, laneId) => ({ id, title: id, text: "t", teamId: "vibesquad", laneId, scope: "other", status: "parked", createdAt: now, updatedAt: now });
  writeInboxCards([card("a", "bug-chaser"), card("b", "empty-lane")], baseHome);
  const dead = { ...agent("old", "brainstorm", "bug-chaser"), status: "closed", archivedAt: now };
  const c = client([dead, agent("lead", "lead", "bug-chaser")]);
  await sendInboxCard({ cardId: "a", baseHome, agentClient: c }, repoRoot);
  assert.equal(c.sent[0].id, "lead");
  await assert.rejects(sendInboxCard({ cardId: "b", baseHome, agentClient: c }, repoRoot), /No live Buddy or lead/);
});

// Review R1 fixes
const mkCard = (id, laneId, extra = {}) => {
  const now = new Date().toISOString();
  return { id, title: id, text: "t", teamId: "vibesquad", laneId, scope: "other", status: "parked", createdAt: now, updatedAt: now, ...extra };
};

test("R1-H standing bug/audit fallback lanes stay valid even when the registry has no such lane", (t) => {
  const baseHome = home(t);
  for (const lane of ["bug-runner", "perfection"]) {
    const r = addInboxCards({ ideas: [`idea for ${lane}`], laneId: lane, baseHome }, repoRoot);
    assert.equal(r.added[0].laneId, lane);
  }
  assert.throws(() => addInboxCards({ ideas: ["x"], laneId: "nope-lane", baseHome }, repoRoot), /unknown lane/);
});

test("R1-M1 add/bounce store the canonical lane id; a same-lane alias bounce keeps the delivery stamp", (t) => {
  const baseHome = home(t);
  const added = addInboxCards({ ideas: ["alias add"], laneId: "@bug", teamId: "vibesquad", baseHome }, repoRoot);
  assert.equal(added.added[0].laneId, "bug-chaser");
  writeInboxCards([mkCard("d1", "bug-chaser", { deliveredAt: "2026-11-10T00:00:00Z", deliveredTo: "bud", deliveredLane: "bug-chaser" })], baseHome);
  triageInboxCards({ action: "bounce", cardId: "d1", laneId: "bug", baseHome }, repoRoot);
  const c = readInboxCards(baseHome)[0];
  assert.equal(c.laneId, "bug-chaser");
  assert.equal(c.deliveredTo, "bud", "same lane via alias must not re-open delivery (double-send)");
  assert.equal(c.teamId, "vibesquad");
});

test("R1-M2 triage update validates and canonicalizes patch.laneId", (t) => {
  const baseHome = home(t);
  writeInboxCards([mkCard("u1", "empty-lane", { deliveredAt: "2026-11-10T00:00:00Z", deliveredTo: "bud" })], baseHome);
  assert.throws(() => triageInboxCards({ action: "update", cardId: "u1", patch: { laneId: "bug-chasr" }, baseHome }, repoRoot), /unknown lane/);
  assert.equal(readInboxCards(baseHome)[0].laneId, "empty-lane");
  triageInboxCards({ action: "update", cardId: "u1", patch: { laneId: "bug" }, baseHome }, repoRoot);
  const c = readInboxCards(baseHome)[0];
  assert.equal(c.laneId, "bug-chaser");
  assert.equal(c.deliveredAt, undefined, "a real lane move re-opens delivery");
});

test("R1-L vs inbox --lane resolves against the live teams.json, not the module-load snapshot", async (t) => {
  const baseHome = home(t);
  const { main } = await import("../cli/vs.mjs");
  writeFileSync(teamsFile, JSON.stringify({ teams: [
    { id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", hub: true }, { id: "bug-chaser", aliases: ["bug"] }] },
    { id: "late", name: "Late", lanes: [{ id: "late-lane", name: "Late Lane" }] },
  ] }));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = baseHome;
  t.after(() => { if (prev === undefined) delete process.env.VIBESQUAD_HOME; else process.env.VIBESQUAD_HOME = prev; });
  const code = await main(["inbox", "add", "late idea", "--lane", "late-lane", "--team", "vibesquad"]);
  assert.equal(code, 0);
  assert.equal(readInboxCards(baseHome)[0].teamId, "late");
});
