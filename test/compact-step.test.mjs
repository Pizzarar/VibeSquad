import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startTokenWatcher, BRAINSTORM_WARN_NUDGE, WARN_LABEL } from "../server/token-watch.mjs";
import { appendVsLogEntry } from "../server/brainstorm.mjs";
import { createCompactor, COMPACTED_AT_LABEL, BUDDY_COMPACT_FOCUS, LEAD_COMPACT_FOCUS } from "../server/compact-step.mjs";
import { LEAD_FLAG_DEFAULT, LEAD_HARD_CAP_DEFAULT, SOFT_FLAG_NUDGE } from "../server/lead-handoff.mjs";

process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Fake runner. `mode` decides what a `/compact` turn does: ok | over | timeout | fail. */
function makeRunner(mode = "ok") {
  const agents = new Map();
  const sent = [];
  const created = [];
  const listeners = new Set();
  let seq = 0;
  const runner = {
    mode, agents, sent, created,
    subscribeEvents(l) { listeners.add(l); return () => listeners.delete(l); },
    emit(ev) { for (const l of listeners) l(ev); },
    async updateAgent(id, { labels }) { const a = agents.get(id); if (a && labels) a.labels = { ...labels }; },
    async sendAgentPrompt(id, text) {
      sent.push({ id, text });
      if (!text.startsWith("/compact")) return;
      if (runner.mode === "fail") throw new Error("runner down");
      if (runner.mode === "timeout") return;
      const a = agents.get(id);
      const after = runner.mode === "ok" ? 40_000 : a.lastUsage.contextWindowUsedTokens;
      setTimeout(() => {
        runner.emit({ kind: "timeline", agentId: id, seq: ++seq, type: "compacted" });
        a.lastUsage = { contextWindowUsedTokens: after, inputTokens: after };
        runner.emit({ kind: "agent", agent: { ...a, labels: { ...a.labels } } });
      }, 5);
    },
    async createAgent(p) {
      const id = `rn-new${created.length}`;
      created.push({ id, ...p });
      agents.set(id, { id, provider: "claude", title: p.config?.title ?? id, labels: p.labels, status: "idle" });
      return { id, labels: p.labels, status: "idle" };
    },
    async fetchAgent(id) { return { agent: agents.get(id) }; },
    async deleteHeartbeat() {},
    usage(id, tokens) {
      const a = agents.get(id);
      a.lastUsage = { contextWindowUsedTokens: tokens, inputTokens: tokens };
      this.emit({ kind: "agent", agent: { ...a, labels: { ...a.labels } } });
    },
  };
  return runner;
}

function setup(mode) {
  const dir = mkdtempSync(join(tmpdir(), "vs-compact-step-"));
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  writeFileSync(join(dir, "teams.json"), JSON.stringify({ teams: [{ id: "t", name: "T", lanes: [{ id: "l", name: "L" }] }] }));
  process.env.VIBESQUAD_ROOT = dir;
  process.env.VIBESQUAD_HOME = join(dir, "home");
  const r = makeRunner(mode);
  const compactor = createCompactor({
    runner: r, timeoutMs: 120, settleMs: 40,
    log: ({ agent, text, teamId, laneId }) => appendVsLogEntry({ teamId, laneId, agent, type: "metric", text }),
  });
  const restarts = [];
  const watch = () => startTokenWatcher({ runner: r, rootDir: dir, baseHome: join(dir, "home"), compactor, restartBuddy: async (b) => { restarts.push(b); } });
  const laneLog = () => { const p = join(dir, "home", "logs", "t--l.jsonl"); return existsSync(p) ? readFileSync(p, "utf8") : ""; };
  return { dir, r, compactor, restarts, watch, laneLog };
}

const buddy = (id, provider = "claude") => ({ id, provider, title: "Buddy", status: "idle", labels: { role: "brainstorm", team: "t", lane: "l", [WARN_LABEL]: "1" } });
const lead = (id, provider = "claude") => ({ id, provider, title: "★ L1", status: "idle", cwd: "/x", labels: { role: "lead", team: "t", lane: "l", ord: "1" } });
const compacts = (r) => r.sent.filter((s) => s.text.startsWith("/compact"));

test("buddy: compaction under the cap -> no restart, same id, outcome in its own lane log", async () => {
  const { r, restarts, watch, laneLog } = setup("ok");
  r.agents.set("rn-b", buddy("rn-b"));
  const w = watch();
  r.usage("rn-b", 151_000);
  await tick(250);
  assert.equal(restarts.length, 0);
  assert.deepEqual(compacts(r).map((s) => s.text), [`/compact ${BUDDY_COMPACT_FOCUS}`]);
  assert.ok(r.agents.get("rn-b").labels[COMPACTED_AT_LABEL]);
  assert.match(laneLog(), /compact-step buddy agent=rn-b outcome=ok before=151000 after=40000/);
  w.stop();
});

test("buddy: still over the cap after compaction -> handoff proceeds", async () => {
  const { r, restarts, watch, laneLog } = setup("over");
  r.agents.set("rn-b", buddy("rn-b"));
  const w = watch();
  r.usage("rn-b", 160_000);
  await tick(400);
  assert.equal(compacts(r).length, 1);
  assert.equal(restarts.length, 1);
  assert.match(laneLog(), /outcome=still-over/);
  w.stop();
});

test("buddy: compaction timeout -> handoff proceeds", async () => {
  const { r, restarts, watch, laneLog } = setup("timeout");
  r.agents.set("rn-b", buddy("rn-b"));
  const w = watch();
  r.usage("rn-b", 160_000);
  await tick(400);
  assert.equal(restarts.length, 1);
  assert.match(laneLog(), /outcome=timeout/);
  w.stop();
});

test("buddy: a failed send -> handoff proceeds", async () => {
  const { r, restarts, watch } = setup("fail");
  r.agents.set("rn-b", buddy("rn-b"));
  const w = watch();
  r.usage("rn-b", 160_000);
  await tick(300);
  assert.equal(restarts.length, 1);
  w.stop();
});

test("non-Claude (agy / opencode) agents: no /compact, old ladder untouched", async () => {
  const { r, restarts, watch } = setup("ok");
  r.agents.set("rn-b", buddy("rn-b", "antigravity-cli"));
  r.agents.set("rn-l", lead("rn-l", "opencode"));
  const w = watch();
  r.usage("rn-b", 160_000);
  r.usage("rn-l", LEAD_FLAG_DEFAULT + 5);
  await tick(200);
  assert.equal(compacts(r).length, 0);
  assert.equal(restarts.length, 1);
  assert.deepEqual(r.sent.map((s) => s.text), [SOFT_FLAG_NUDGE]);
  w.stop();
});

test("second crossing: no second compaction, the handoff runs", async () => {
  const { r, restarts, watch } = setup("ok");
  r.agents.set("rn-b", buddy("rn-b"));
  const w = watch();
  r.usage("rn-b", 151_000);
  await tick(250);
  assert.equal(restarts.length, 0);
  r.usage("rn-b", 152_000); // grew back over the cap
  await tick(150);
  assert.equal(compacts(r).length, 1);
  assert.equal(restarts.length, 1);
  w.stop();
  // a restarted server (empty memory) still honours the label
  const c2 = createCompactor({ runner: r });
  assert.equal((await c2.run(r.agents.get("rn-b"), { focus: "x", cap: 1 })).reason, "already-compacted");
});

test("buddy mid-turn is not compacted; it waits for idle", async () => {
  const { r, restarts, watch } = setup("ok");
  r.agents.set("rn-b", { ...buddy("rn-b"), status: "running" });
  const w = watch();
  r.usage("rn-b", 160_000);
  await tick(100);
  assert.equal(compacts(r).length, 0);
  assert.equal(restarts.length, 0);
  r.agents.get("rn-b").status = "idle";
  r.usage("rn-b", 160_001);
  await tick(250);
  assert.equal(compacts(r).length, 1);
  assert.equal(restarts.length, 0);
  w.stop();
});

test("buddy that jumped past the warn: no /compact until the brief turn ends, then compacted", async () => {
  const { r, restarts, watch } = setup("ok");
  const b = buddy("rn-b");
  delete b.labels[WARN_LABEL];
  r.agents.set("rn-b", b);
  const w = watch();
  r.usage("rn-b", 160_000);
  await tick(60);
  assert.deepEqual(r.sent.map((s) => s.text), [BRAINSTORM_WARN_NUDGE]);
  r.usage("rn-b", 160_001); // stale "idle" upsert before the brief turn starts: must NOT compact
  r.usage("rn-b", 160_002);
  await tick(100);
  assert.equal(compacts(r).length, 0);
  assert.equal(restarts.length, 0);
  r.emit({ kind: "turn_ended", agentId: "rn-b", outcome: { kind: "completed" } });
  r.usage("rn-b", 160_003);
  await tick(250);
  assert.equal(compacts(r).length, 1);
  assert.equal(restarts.length, 0);
  w.stop();
});

test("lead: compacted under the soft flag -> no nudge, no handoff, same id", async () => {
  const { r, watch, laneLog } = setup("ok");
  r.agents.set("rn-l", lead("rn-l"));
  const w = watch();
  r.usage("rn-l", LEAD_FLAG_DEFAULT + 5);
  await tick(250);
  assert.deepEqual(r.sent.map((s) => s.text), [`/compact ${LEAD_COMPACT_FOCUS}`]);
  assert.equal(r.created.length, 0);
  assert.match(laneLog(), /compact-step lead agent=rn-l outcome=ok/);
  w.stop();
});

test("lead: still over / timeout -> the unchanged ladder runs (hard cap successor)", async () => {
  for (const mode of ["over", "timeout"]) {
    const { r, watch } = setup(mode);
    r.agents.set("rn-l", lead("rn-l"));
    const w = watch();
    r.usage("rn-l", LEAD_HARD_CAP_DEFAULT + 1);
    await tick(500);
    assert.equal(compacts(r).length, 1, mode);
    assert.equal(r.created.length, 1, mode);
    assert.equal(r.created[0].labels["vs.handoff-trigger"], "hard-300");
    w.stop();
  }
});

test("lead: running lead past the soft flag defers: no nudge, no stamp, compacted on the idle upsert", async () => {
  const { r, watch } = setup("ok");
  r.agents.set("rn-l", { ...lead("rn-l"), status: "running" });
  const w = watch();
  r.usage("rn-l", LEAD_FLAG_DEFAULT + 5);
  await tick(100);
  assert.equal(r.sent.length, 0);
  assert.equal(r.created.length, 0);
  assert.equal(r.agents.get("rn-l").labels["handoff-nudged"], undefined);
  assert.equal(r.agents.get("rn-l").labels["needs-you"], undefined);
  r.agents.get("rn-l").status = "idle";
  r.usage("rn-l", LEAD_FLAG_DEFAULT + 6);
  await tick(250);
  assert.deepEqual(r.sent.map((s) => s.text), [`/compact ${LEAD_COMPACT_FOCUS}`]);
  w.stop();
});

test("lead: running lead past the hard cap still goes to the forced handoff (no deferral)", async () => {
  const { r, watch } = setup("ok");
  r.agents.set("rn-l", { ...lead("rn-l"), status: "running" });
  const w = watch();
  r.usage("rn-l", LEAD_HARD_CAP_DEFAULT + 1);
  await tick(300);
  assert.equal(compacts(r).length, 0);
  assert.equal(r.created.length, 1);
  w.stop();
});

test("compact-step logs the /compact turn costUsd + tokens (growth of cumulative usage across it)", async () => {
  const lines = [];
  const listeners = new Set();
  const a = { id: "rn-c", provider: "claude", status: "idle", labels: {}, lastUsage: { contextWindowUsedTokens: 150_000, inputTokens: 1000, outputTokens: 200, costUsd: 1.5 } };
  const runner = {
    subscribeEvents(l) { listeners.add(l); return () => listeners.delete(l); },
    async updateAgent() {},
    async sendAgentPrompt() {
      setTimeout(() => {
        a.lastUsage = { contextWindowUsedTokens: 30_000, inputTokens: 1900, outputTokens: 350, costUsd: 1.75 };
        for (const l of listeners) l({ kind: "timeline", agentId: "rn-c", type: "compacted" });
      }, 5);
    },
    async fetchAgent() { return { agent: a }; },
  };
  const c = createCompactor({ runner, timeoutMs: 200, settleMs: 40, log: (e) => lines.push(e.text) });
  const res = await c.run(a, { focus: "x", cap: 100_000 });
  assert.equal(res.outcome, "ok");
  assert.equal(res.costUsd, 0.25);
  assert.equal(res.tokens, 1050);
  assert.match(lines[0], /outcome=ok before=150000 after=30000 cap=100000 ms=\d+ costUsd=0\.25 tokens=1050/);
});

test("compact-step without usage totals omits costUsd/tokens instead of guessing", async () => {
  const lines = [];
  const listeners = new Set();
  const a = { id: "rn-d", provider: "claude", status: "idle", labels: {}, usedTokens: 150_000 };
  const runner = {
    subscribeEvents(l) { listeners.add(l); return () => listeners.delete(l); },
    async updateAgent() {},
    async sendAgentPrompt() { setTimeout(() => { a.usedTokens = 20_000; for (const l of listeners) l({ kind: "timeline", agentId: "rn-d", type: "compacted" }); }, 5); },
    async fetchAgent() { return { agent: a }; },
  };
  const c = createCompactor({ runner, timeoutMs: 200, settleMs: 40, log: (e) => lines.push(e.text) });
  const res = await c.run(a, { cap: 100_000 });
  assert.equal(res.outcome, "ok");
  assert.equal(res.costUsd, undefined);
  assert.doesNotMatch(lines[0], /costUsd=|tokens=/);
});
