// idea-454: plan lifecycle events. `vs log handoff|done --plan` (+ --pass) stored as plan=<path>; the server path auto-fills
// plan= from the text; a Buddy -> lead spawn/send naming a PLAN path auto-logs one `handoff plan=<path>`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendVsLogEntry } from "../server/brainstorm.mjs";
import { planLogFields, planPathInText, validatePlanPath } from "../server/plan-log.mjs";
import { handoffLogText } from "../server/lead-handoff.mjs";
import { callTool } from "../server/mcp/tools.mjs";
import { verifiedIdentity } from "./helpers/agent-token.mjs";

process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";

function withHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vs-plan-ev-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = dir;
  try { return fn(dir); } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_HOME; else process.env.VIBESQUAD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("validatePlanPath: repo-relative docs/PLAN_*.md only", () => {
  assert.equal(validatePlanPath("docs/PLAN_X.md"), "docs/PLAN_X.md");
  assert.equal(validatePlanPath(""), "");
  for (const bad of ["PLAN_X.md", "/abs/docs/PLAN_X.md", "docs/other.md", "docs/PLAN_X.txt", "../docs/PLAN_X.md", "docs/sub/PLAN_X.md"]) {
    assert.throws(() => validatePlanPath(bad), /docs\/PLAN_\*\.md/, bad);
  }
});

test("(1) --plan on handoff/done is stored as a plan field and a parseable plan= tag; --pass only on done", () => {
  withHome(() => {
    const h = appendVsLogEntry({ teamId: "t", laneId: "l", agent: "buddy", type: "handoff", text: "plan ready", plan: "docs/PLAN_X.md" }).entry;
    assert.equal(h.plan, "docs/PLAN_X.md");
    assert.match(h.text, /plan=docs\/PLAN_X\.md$/);
    assert.equal(h.pass, undefined);
    const d = appendVsLogEntry({ teamId: "t", laneId: "l", agent: "lead", type: "done", text: "all blocks merged", plan: "docs/PLAN_X.md", pass: true }).entry;
    assert.equal(d.pass, true);
    assert.match(d.text, /plan=docs\/PLAN_X\.md PASS$/);
    assert.throws(() => appendVsLogEntry({ teamId: "t", laneId: "l", type: "done", text: "x", plan: "docs/nope.md" }), /PLAN_/);
    const m = appendVsLogEntry({ teamId: "t", laneId: "l", type: "metric", text: "x", plan: "docs/PLAN_X.md" }).entry;
    assert.equal(m.plan, undefined, "other types are untouched");
    const long = planLogFields("handoff", "y".repeat(240), "docs/PLAN_X.md");
    assert.ok(long.text.length <= 240 && long.text.endsWith("plan=docs/PLAN_X.md"));
  });
});

test("(2) the server path auto-fills plan= when the text names a PLAN path and the field is missing", () => {
  withHome((dir) => {
    const e = appendVsLogEntry({ teamId: "t", laneId: "l", type: "done", text: "finished docs/PLAN_Y.md, all merged." }).entry;
    assert.equal(e.plan, "docs/PLAN_Y.md");
    assert.match(e.text, /plan=docs\/PLAN_Y\.md/);
    const none = appendVsLogEntry({ teamId: "t", laneId: "l", type: "done", text: "no plan here" }).entry;
    assert.equal(none.plan, undefined);
    assert.equal(none.text, "no plan here");
    assert.equal(planPathInText("see xdocs/PLAN_Z.md"), "");
    const line = readFileSync(join(dir, "teams", "t", "log.jsonl"), "utf8").split("\n")[0];
    assert.equal(JSON.parse(line).plan, "docs/PLAN_Y.md");
  });
});

function mkCtx(role) {
  const logs = [];
  const sent = [];
  const created = [];
  const teams = [{ id: "mx", name: "Matrix", paths: ["matrix"], lanes: [{ id: "feat", name: "Feat" }, { id: "other", name: "Other" }, { id: "hub", name: "Hub", hub: true }] }];
  const agents = {
    "rn-lead1": { id: "rn-lead1", labels: { team: "mx", lane: "feat", lead: "feat", role: "lead" } },
    "rn-lead2": { id: "rn-lead2", labels: { team: "mx", lane: "other", lead: "other", role: "lead" } },
    "rn-bud2": { id: "rn-bud2", labels: { team: "mx", lane: "feat", role: "brainstorm", lead: "feat" } },
    "rn-wrk1": { id: "rn-wrk1", labels: { team: "mx", lane: "feat", role: "worker" } },
  };
  const backend = {
    async createAgent(req) { created.push(req); return { id: `rn-${created.length}`, title: "L", labels: req.labels }; },
    async sendAgentPrompt(id, text) { sent.push({ id, text }); },
    async fetchAgent(id) { if (!agents[id]) throw Object.assign(new Error("not found"), { status: 404 }); return { agent: agents[id] }; },
    async fetchAgents() { return { entries: [] }; },
    async listAgents() { return { entries: [] }; },
  };
  const identity = { agentId: "rn-bud1", team: "mx", lane: role === "hubLead" ? "hub" : "feat", role: role === "hubLead" ? "lead" : role };
  agents["rn-bud1"] = { id: "rn-bud1", labels: { team: "mx", lane: identity.lane, role: identity.role, lead: identity.lane } };
  const profiles = [{ id: "p-l", name: "Lead - Opus", role: "lead", provider: "claude", model: "m", modeId: "auto", notes: "" }];
  const withBackend = async (_t, fn) => fn(backend);
  const ctx = {
    ...verifiedIdentity(identity, { backend, teams }), cwd: process.cwd(), teams,
    loadProfiles: async () => profiles,
    resolveProfile: async (n) => { const p = profiles.find((x) => x.name === n); return p ? { profile: p, spawn: { provider: p.provider, model: p.model, modeId: p.modeId } } : null; },
    writeLog: async (e) => { logs.push(e); },
    withBackend,
    findLiveLeads: async () => [],
  };
  return { ctx, logs, sent };
}
const spawnLead = (ctx, prompt, labels = { role: "lead" }) => callTool(ctx, "spawn_worker", { title: "L", profile: "Lead - Opus", prompt, labels });

test("(3) Buddy spawn of a lead and send to its own lane lead naming a plan each request a handoff plan= entry", async () => {
  const { ctx, logs, sent } = mkCtx("brainstorm");
  await spawnLead(ctx, "Run docs/PLAN_Q.md block 1");
  assert.deepEqual([logs.length, logs[0].type, logs[0].plan], [1, "handoff", "docs/PLAN_Q.md"]);
  await callTool(ctx, "send", { id: "rn-lead1", text: "go: docs/PLAN_Q.md is ready" });
  assert.equal(sent.length, 1);
  assert.equal(logs.length, 2);
  assert.equal(logs[1].plan, "docs/PLAN_Q.md");
});

test("(3) no log: spawn without a plan path; a send from a non-Buddy; a send to a Buddy, a worker or another lane's lead", async () => {
  const b = mkCtx("brainstorm");
  await spawnLead(b.ctx, "no plan named");
  await callTool(b.ctx, "send", { id: "rn-lead1", text: "hi" });
  for (const id of ["rn-bud2", "rn-wrk1", "rn-lead2", "rn-gone"]) await callTool(b.ctx, "send", { id, text: "see docs/PLAN_Q.md" });
  assert.equal(b.logs.length, 0);
  const l = mkCtx("lead");
  await callTool(l.ctx, "send", { id: "rn-lead1", text: "see docs/PLAN_Q.md" });
  assert.equal(l.logs.length, 0);
});

test("(3) a hub lead spawning another lane's lead is not a Buddy handoff: nothing is logged", async () => {
  const h = mkCtx("hubLead");
  h.ctx.findLiveLeads = async () => [];
  const r = await spawnLead(h.ctx, "Run docs/PLAN_Q.md", { role: "lead", lane: "feat" });
  assert.ok(r.id, "the lead spawn itself succeeded");
  assert.equal(h.logs.length, 0);
});

test("(1) server-side dedupe: the same agent + plan in one lane logs one handoff across calls/processes; other agent, plan or lane logs its own", () => {
  withHome((dir) => {
    const w = (o) => appendVsLogEntry({ teamId: "t", laneId: "l", agent: "bud", type: "handoff", text: "buddy -> lead plan handoff", plan: "docs/PLAN_Q.md", ...o });
    const first = w({});
    const spawnThenSend = w({ text: "buddy -> lead plan handoff (send)" });
    const explicit = w({ text: "plan ready, see docs/PLAN_Q.md" });
    assert.equal(spawnThenSend.deduped, true);
    assert.equal(explicit.deduped, true);
    assert.equal(explicit.entry.ts, first.entry.ts);
    assert.equal(w({ agent: "bud2" }).deduped, undefined);
    assert.equal(w({ plan: "docs/PLAN_R.md" }).deduped, undefined);
    assert.equal(w({ laneId: "l2" }).deduped, undefined);
    const lines = readFileSync(join(dir, "teams", "t", "log.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 4);
    // outside the window it logs again
    const old = JSON.stringify({ ts: new Date(Date.now() - 31 * 60_000).toISOString(), agent: "bud3", lane: "l", type: "handoff", text: "x", refs: [], plan: "docs/PLAN_Q.md" });
    writeFileSync(join(dir, "logs", "t--l.jsonl"), `${old}\n`, { flag: "a" });
    assert.equal(w({ agent: "bud3" }).deduped, undefined);
  });
});

test("(M3) planLogFields never cuts or overflows the plan= tag", () => {
  const p = "docs/PLAN_X.md";
  const text = "a".repeat(240 - ` plan=${p}`.length) + ` plan=${p}`;
  assert.equal(text.length, 240);
  const r = planLogFields("done", text, "", true);
  assert.ok(r.text.length <= 240, `len ${r.text.length}`);
  assert.match(r.text, /plan=docs\/PLAN_X\.md PASS$/);
  const longPath = `docs/PLAN_${"z".repeat(115)}.md`;
  assert.throws(() => validatePlanPath(longPath), /PLAN_/);
  const edge = `docs/PLAN_${"z".repeat(100)}.md`;
  const e = planLogFields("done", "b".repeat(240), edge, true);
  assert.ok(e.text.length <= 240 && e.text.endsWith(`plan=${edge} PASS`));
});

test("(L) plan paths in text: .md.bak is not a plan; lead->lead handoffLogText shares the path regex", () => {
  assert.equal(planPathInText("see docs/PLAN_X.md.bak"), "");
  assert.equal(planPathInText("see docs/PLAN_X.md."), "docs/PLAN_X.md");
  assert.equal(planPathInText("see docs/PLAN_X.md, ok"), "docs/PLAN_X.md");
  assert.match(handoffLogText({ oldId: "a", successorId: "b", oldOrd: 1, nextOrd: 2, trigger: "self", plan: "docs/PLAN_X.md" }), /plan=docs\/PLAN_X\.md/);
  assert.doesNotMatch(handoffLogText({ oldId: "a", successorId: "b", oldOrd: 1, nextOrd: 2, trigger: "self", plan: "docs/x.md" }), /plan=/);
});
