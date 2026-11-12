import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startTokenWatcher, BRAINSTORM_WARN_NUDGE, WARN_LABEL } from "../server/token-watch.mjs";
import { SOFT_FLAG_NUDGE, LEAD_FLAG_DEFAULT, LEAD_HARD_CAP_DEFAULT } from "../server/lead-handoff.mjs";

process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";

const tick = () => new Promise((r) => setTimeout(r, 15));

/** Fake RunnerBackend: stores agents, records writes, and replays events to listeners. Labels persist across watcher instances. */
function makeRunner() {
  const agents = new Map();
  const sent = [];
  const created = [];
  const listeners = new Set();
  const runner = {
    agents,
    sent,
    created,
    subscribeEvents(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    emit(ev) {
      for (const l of listeners) l(ev);
    },
    async updateAgent(id, { name, labels }) {
      const a = agents.get(id);
      if (!a) return;
      if (labels) a.labels = { ...labels };
      if (name) a.title = name;
    },
    async sendAgentPrompt(id, text) {
      sent.push({ id, text });
    },
    async createAgent(p) {
      const id = `rn-new${created.length}`;
      created.push({ id, ...p });
      agents.set(id, { id, title: p.config?.title ?? id, labels: p.labels, status: "idle" });
      return { id, labels: p.labels, status: "idle" };
    },
    async fetchAgent(id) {
      return { agent: agents.get(id) };
    },
    async deleteHeartbeat() {},
    usage(id, tokens) {
      const a = agents.get(id);
      a.lastUsage = { contextWindowUsedTokens: tokens, inputTokens: tokens };
      this.emit({ kind: "agent", agent: { ...a, labels: { ...a.labels } } });
    },
  };
  return runner;
}

function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), "vs-token-watch-"));
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  writeFileSync(join(dir, "teams.json"), JSON.stringify({ teams: [{ id: "t", name: "T", lanes: [{ id: "l", name: "L" }] }] }));
  process.env.VIBESQUAD_ROOT = dir;
  return dir;
}

const lead = (id) => ({ id, title: "★ L1", status: "idle", cwd: "/x", labels: { role: "lead", team: "t", lane: "l", ord: "1" } });
const buddy = (id) => ({ id, title: "Buddy", status: "idle", labels: { role: "brainstorm", team: "t", lane: "l" } });
const worker = (id) => ({ id, title: "w", status: "idle", labels: { role: "worker", team: "t", lane: "l" } });

test("lead: one soft nudge + needs-you at 150k, none again after a restarted watcher", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  let w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-lead", LEAD_FLAG_DEFAULT - 1);
  await tick();
  assert.equal(r.sent.length, 0);
  r.usage("rn-lead", LEAD_FLAG_DEFAULT + 10);
  r.usage("rn-lead", LEAD_FLAG_DEFAULT + 20);
  await tick();
  assert.deepEqual(r.sent.map((s) => s.text), [SOFT_FLAG_NUDGE]);
  assert.equal(r.agents.get("rn-lead").labels["handoff-flagged"], "1");
  assert.ok(r.agents.get("rn-lead").labels["needs-you"]);
  // server restart: new watcher over the same labels, roster replay + more usage
  w.stop();
  w = startTokenWatcher({ runner: r, rootDir });
  r.emit({ kind: "roster", agents: [{ ...r.agents.get("rn-lead") }] });
  r.usage("rn-lead", LEAD_FLAG_DEFAULT + 30);
  await tick();
  assert.equal(r.sent.length, 1);
  w.stop();
});

test("lead: hard cap runs one successor handoff, none again after restart", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  let w = startTokenWatcher({ runner: r, rootDir, baseHome: join(rootDir, "home") });
  r.usage("rn-lead", LEAD_HARD_CAP_DEFAULT + 1);
  r.usage("rn-lead", LEAD_HARD_CAP_DEFAULT + 2);
  await tick();
  await tick();
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].labels["vs.handoff-from"], "rn-lead");
  assert.equal(r.created[0].labels["vs.handoff-trigger"], "hard-300");
  w.stop();
  w = startTokenWatcher({ runner: r, rootDir, baseHome: join(rootDir, "home") });
  r.usage("rn-lead", LEAD_HARD_CAP_DEFAULT + 3);
  await tick();
  await tick();
  assert.equal(r.created.length, 1);
  w.stop();
});

test("buddy: one warn at 80k, one restart at the hard limit, none after restart", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  r.agents.set("rn-bud", buddy("rn-bud"));
  const restarts = [];
  const opts = { runner: r, rootDir, restartBuddy: async (b) => { restarts.push(b); } };
  let w = startTokenWatcher(opts);
  r.usage("rn-bud", 79_999);
  await tick();
  assert.equal(r.sent.length, 0);
  r.usage("rn-bud", 85_000);
  r.usage("rn-bud", 90_000);
  await tick();
  assert.deepEqual(r.sent.map((s) => s.text), [BRAINSTORM_WARN_NUDGE]);
  assert.equal(r.agents.get("rn-bud").labels[WARN_LABEL], "1");
  assert.equal(restarts.length, 0);
  w.stop();
  w = startTokenWatcher(opts);
  r.usage("rn-bud", 95_000);
  await tick();
  assert.equal(r.sent.length, 1);
  r.usage("rn-bud", 150_000);
  r.usage("rn-bud", 151_000);
  await tick();
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].agentId, "rn-bud");
  assert.ok(restarts[0].reason.startsWith("auto"));
  // restarted Buddy (label set by the restart) is never restarted again, even by a fresh watcher
  r.agents.get("rn-bud").labels["vs.restarted-into"] = "rn-new";
  w.stop();
  w = startTokenWatcher(opts);
  r.usage("rn-bud", 200_000);
  await tick();
  assert.equal(restarts.length, 1);
  w.stop();
});

test("buddy: team thresholds override defaults", async () => {
  const rootDir = makeRoot();
  writeFileSync(join(rootDir, "teams.json"), JSON.stringify({ teams: [{ id: "t", name: "T", brainstormWarnTokens: 10_000, brainstormRestartTokens: 20_000, lanes: [{ id: "l", name: "L" }] }] }));
  const r = makeRunner();
  r.agents.set("rn-bud", buddy("rn-bud"));
  const w = startTokenWatcher({ runner: r, rootDir, restartBuddy: async () => {} });
  r.usage("rn-bud", 10_500);
  await tick();
  assert.equal(r.sent.length, 1);
  w.stop();
});

test("workers: only the worker context guard's wrap-up (idea-162), never a spawn or restart; closed agents: nothing at any size", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  r.agents.set("rn-w", worker("rn-w"));
  r.agents.set("rn-closed", { ...lead("rn-closed"), status: "closed" });
  const w = startTokenWatcher({ runner: r, rootDir, restartBuddy: async () => assert.fail("no restart") });
  r.usage("rn-w", 900_000);
  r.usage("rn-closed", 900_000);
  await tick();
  assert.deepEqual(r.sent.map((s) => s.id), ["rn-w"]); // idle worker, no lead in the lane: the wrap-up only (worker-context-guard.test.mjs covers the rest)
  assert.match(r.sent[0].text, /worker soft limit/);
  assert.equal(r.created.length, 0);
  w.stop();
});

test("Root cause: a lead whose handoff-flagged/needs-you were pre-set by the browser still gets the nudge, once", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  const l = lead("rn-lead");
  l.labels["handoff-flagged"] = "1"; // what src/App.tsx used to write at 150k: this suppressed the nudge for good
  l.labels["needs-you"] = "Lead at 150k+ tokens: wrap up and hand off at a good stopping point";
  r.agents.set("rn-lead", l);
  const w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-lead", 160_000);
  r.usage("rn-lead", 161_000);
  await tick();
  assert.deepEqual(r.sent.map((s) => s.text), [SOFT_FLAG_NUDGE]);
  assert.equal(r.agents.get("rn-lead").labels["handoff-nudged"], "1");
  w.stop();
});

test("buddy: the default performBrainstormRestart wiring restarts once (reason auto-token-limit) and never loops", async () => {
  const rootDir = makeRoot();
  writeFileSync(join(rootDir, "docs", "brainstorm", "l.md"), "# Brief\n\n## Open\n- x\n", "utf8");
  const { seedDefaultPack } = await import("../server/profiles.mjs");
  const { resetBrainstormRestartState } = await import("../server/brainstorm.mjs");
  const profilesPath = join(rootDir, "profiles.json");
  seedDefaultPack(profilesPath);
  resetBrainstormRestartState();
  const r = makeRunner();
  r.agents.set("rn-bud", buddy("rn-bud"));
  const creates = [];
  const updates = [];
  const agentClient = {
    async fetchAgents() { return []; },
    async createAgent(req) { creates.push(req); return { id: `bs-${creates.length}`, labels: req.labels }; },
    async updateAgent(id, patch) { updates.push({ id, patch }); if (id === "rn-bud" && patch.labels) r.agents.get(id).labels = { ...patch.labels }; },
    async archiveAgent() {},
    async cancelAgent() {},
  };
  const w = startTokenWatcher({ runner: r, rootDir, restartExtra: { agentClient, profilesPath, backstopDelayMs: 60_000 } });
  r.usage("rn-bud", 150_000);
  r.usage("rn-bud", 151_000);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(creates.length, 1, "exactly one replacement Buddy");
  assert.equal(creates[0].labels["vs.restart-reason"], "auto-token-limit");
  assert.equal(creates[0].labels["vs.restarted-from"], "rn-bud");
  // the restarted Buddy's next usage event (labels now carry vs.restarted-into) must not restart again
  r.usage("rn-bud", 152_000);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(creates.length, 1, "no restart loop");
  w.stop();
});

test("token-watch coordinator: a transient fetchAgent error is not 'dead' (confirmTakeover throws); only not-found reads as missing", async () => {
  const runner = makeRunner();
  const rootDir = makeRoot();
  runner.agents.set("rn-succ", { id: "rn-succ", title: "S", status: "idle", labels: { role: "lead", "vs.handoff-from": "rn-old" } });
  const realFetch = runner.fetchAgent.bind(runner);
  let mode = "transient";
  runner.fetchAgent = async (id) => {
    if (mode === "transient") throw new Error("socket hang up");
    if (mode === "missing") throw new Error("agent rn-succ not found");
    return realFetch(id);
  };
  const w = startTokenWatcher({ runner, rootDir });
  try {
    await assert.rejects(w.coordinator.confirmTakeover("rn-succ"), /socket hang up/);
    mode = "missing";
    const r = await w.coordinator.confirmTakeover("rn-succ");
    assert.equal(r.confirmed, false);
  } finally { w.stop(); }
});
