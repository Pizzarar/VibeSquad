import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addWatch, cancelWatch } from "../server/watch-sets.mjs";
import { startTokenWatcher, BRAINSTORM_WARN_NUDGE, WARN_LABEL } from "../server/token-watch.mjs";
import { SOFT_FLAG_NUDGE, LEAD_FLAG_DEFAULT, LEAD_HARD_CAP_DEFAULT, PROVIDER_PREAMBLE_TOKENS, NON_CLAUDE_LEAD_CAP_RULES, buildSuccessorPrompt } from "../server/lead-handoff.mjs";

process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";

const tick = () => new Promise((r) => setTimeout(r, 15));

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });
const mkTmp = () => { const d = mkdtempSync(join(tmpdir(), "vs-token-watch-")); tmpDirs.push(d); return d; };

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
    async sendAgentPrompt(id, text, opts) {
      sent.push({ id, text, ...(opts?.steerOnly ? { steerOnly: true } : {}) });
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
  const dir = mkTmp();
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
  assert.equal(r.sent[0].steerOnly, true, "idea-353: the 150k wrap-up first tries a steer (joins an open turn, no new turn)");
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

test("idea-214: the hard-cap handoff re-points a busy worker with a steer-only notice through the token-watch wiring", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  const w1 = { ...worker("rn-w1"), status: "running", labels: { ...worker("rn-w1").labels, "vs.parent": "rn-lead" } };
  r.agents.set("rn-w1", w1);
  const w = startTokenWatcher({ runner: r, rootDir, baseHome: join(rootDir, "home") });
  r.emit({ kind: "agent", agent: { ...w1, labels: { ...w1.labels } } }); // the watcher's live roster sees the busy worker
  r.usage("rn-lead", LEAD_HARD_CAP_DEFAULT + 1);
  await tick();
  await tick();
  assert.equal(r.created.length, 1);
  const notice = r.sent.filter((s) => s.id === "rn-w1");
  assert.equal(notice.length, 1);
  assert.match(notice[0].text, /^Report to /);
  assert.equal(notice[0].steerOnly, true, "steerOnly reaches runner.sendAgentPrompt: a worker idle by now is never woken");
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
  // idea-214: a plain send. It starts the brief-update turn that compaction/restart waits on, and fires once (WARN_LABEL).
  assert.equal(r.sent[0].steerOnly, undefined, "the Buddy warn nudge may wake an idle Buddy");
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

test("idle workers (idea-162 P0: never an input to an idle worker) and closed agents: nothing at any size", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  r.agents.set("rn-w", worker("rn-w"));
  r.agents.set("rn-closed", { ...lead("rn-closed"), status: "closed" });
  const w = startTokenWatcher({ runner: r, rootDir, restartBuddy: async () => assert.fail("no restart") });
  r.usage("rn-w", 900_000);
  r.usage("rn-closed", 900_000);
  await tick();
  assert.equal(r.sent.length, 0); // worker-context-guard.test.mjs covers the running-worker rungs
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
  r.agents.get("rn-bud").labels[WARN_LABEL] = "1"; // warned at 80k: this test is the restart wiring
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

// idea-353: the wrap-up notice must not cost an idle, watch-armed lead its own turn, and must never be dropped.
function idleAwareRunner(r, state) {
  r.sendAgentPrompt = async (id, text, opts) => {
    if (opts?.steerOnly) {
      if (state.running) {
        r.sent.push({ id, text, steerOnly: true });
        return { delivered: true };
      }
      r.steerDrops = (r.steerDrops ?? 0) + 1;
      return { delivered: false, reason: "idle" };
    }
    r.sent.push({ id, text });
  };
  return r;
}

test("idea-353: running lead gets the wrap-up as a steer (delivered, no wake)", async () => {
  const rootDir = makeRoot();
  const r = idleAwareRunner(makeRunner(), { running: true });
  r.agents.set("rn-lead", { ...lead("rn-lead"), status: "running" });
  const w = startTokenWatcher({ runner: r, rootDir, baseHome: makeRoot() });
  r.usage("rn-lead", LEAD_FLAG_DEFAULT + 10);
  await tick();
  assert.deepEqual(r.sent, [{ id: "rn-lead", text: SOFT_FLAG_NUDGE, steerOnly: true }]);
  w.stop();
});

test("idea-353: idle lead, nothing armed, no wake coming: held one cycle, then woken exactly once", async () => {
  const rootDir = makeRoot();
  const r = idleAwareRunner(makeRunner(), { running: false });
  r.agents.set("rn-lead", lead("rn-lead"));
  const w = startTokenWatcher({ runner: r, rootDir, baseHome: makeRoot(), noticeRecheckMs: 30 });
  r.usage("rn-lead", LEAD_FLAG_DEFAULT + 10);
  await tick();
  assert.equal(r.sent.length, 0, "not woken on the first idle attempt");
  await new Promise((x) => setTimeout(x, 80));
  assert.deepEqual(r.sent, [{ id: "rn-lead", text: SOFT_FLAG_NUDGE }]);
  await new Promise((x) => setTimeout(x, 80));
  assert.equal(r.sent.length, 1, "once");
  w.stop();
});

test("idea-353: idle lead with nothing armed but a wake starting a turn meanwhile: the notice steers into it, no extra turn", async () => {
  const rootDir = makeRoot();
  const state = { running: false };
  const r = idleAwareRunner(makeRunner(), state);
  r.agents.set("rn-lead", lead("rn-lead"));
  const w = startTokenWatcher({ runner: r, rootDir, baseHome: makeRoot(), noticeRecheckMs: 30 });
  r.usage("rn-lead", LEAD_FLAG_DEFAULT + 10);
  await tick();
  state.running = true; // a pending log wake started a turn
  await new Promise((x) => setTimeout(x, 80));
  assert.deepEqual(r.sent, [{ id: "rn-lead", text: SOFT_FLAG_NUDGE, steerOnly: true }]);
  w.stop();
});

test("idea-353: idle lead with an armed watch: notice held (no wake), then steered into the turn the watch ping starts; flushed once if the watch is cancelled", async () => {
  const rootDir = makeRoot();
  const home = makeRoot();
  const state = { running: false };
  const r = idleAwareRunner(makeRunner(), state);
  r.agents.set("rn-lead", lead("rn-lead"));
  const { id } = addWatch({ owner: "rn-lead", team: "t", lane: "l", items: [{ kind: "agent", ref: "rn-w" }] }, { home });
  const w = startTokenWatcher({ runner: r, rootDir, baseHome: home, noticeRecheckMs: 25 });
  r.usage("rn-lead", LEAD_FLAG_DEFAULT + 10);
  await new Promise((x) => setTimeout(x, 90));
  assert.equal(r.sent.length, 0, "armed + idle: held, not woken");
  state.running = true; // the watch ping started a turn
  await new Promise((x) => setTimeout(x, 60));
  assert.deepEqual(r.sent, [{ id: "rn-lead", text: SOFT_FLAG_NUDGE, steerOnly: true }]);
  w.stop();

  // cancel path: a held notice is flushed as one plain send once nothing is armed
  const r2 = idleAwareRunner(makeRunner(), { running: false });
  r2.agents.set("rn-lead", lead("rn-lead"));
  const home2 = makeRoot();
  const s2 = addWatch({ owner: "rn-lead", team: "t", lane: "l", items: [{ kind: "agent", ref: "rn-w" }] }, { home: home2 });
  const w2 = startTokenWatcher({ runner: r2, rootDir, baseHome: home2, noticeRecheckMs: 25 });
  r2.usage("rn-lead", LEAD_FLAG_DEFAULT + 10);
  await new Promise((x) => setTimeout(x, 60));
  assert.equal(r2.sent.length, 0);
  cancelWatch(s2.id, "rn-lead", { home: home2 });
  await new Promise((x) => setTimeout(x, 100));
  await new Promise((x) => setTimeout(x, 100)); // the flush path is the same idle+unarmed rule: one more cycle, then one plain send
  assert.deepEqual(r2.sent, [{ id: "rn-lead", text: SOFT_FLAG_NUDGE }]);
  w2.stop();
  void id;
});

// G1 (unit-buddy-midturn-restart): Usage's agy Buddy went 21k->158k in ONE turn and was restarted mid-reply 3x in 26 min.
// Warned at 80k already (the usual path); the jump-past-the-warn case is its own test below.
// K2b: agy compacts now (compact-step COMPACT_PROVIDERS), so the no-compaction G1 path is pinned on codex; the errored case stays agy.
const agyBuddy = (id, status = "running", provider = "codex") => { const b = { ...buddy(id), provider, status }; b.labels = { ...b.labels, [WARN_LABEL]: "1" }; return b; };

test("G1: a non-Claude Buddy over the cap mid-turn is NOT restarted until its turn ends, then exactly once", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  r.agents.set("rn-agy", agyBuddy("rn-agy"));
  const restarts = [];
  const w = startTokenWatcher({ runner: r, rootDir, restartBuddy: async (b) => { restarts.push(b); } });
  r.usage("rn-agy", 21_000);
  r.usage("rn-agy", 158_000);
  await tick();
  r.usage("rn-agy", 170_000); // still the same turn
  await tick();
  assert.equal(restarts.length, 0, "never restarted mid-turn");
  r.agents.get("rn-agy").status = "idle"; // the turn ends: the runner's idle upsert
  r.emit({ kind: "agent", agent: { ...r.agents.get("rn-agy"), labels: { ...r.agents.get("rn-agy").labels } } });
  await tick();
  assert.equal(restarts.length, 1);
  assert.equal(restarts[0].agentId, "rn-agy");
  assert.equal(restarts[0].reason, "auto-token-limit");
  r.usage("rn-agy", 171_000);
  await tick();
  assert.equal(restarts.length, 1, "one restart per Buddy");
  w.stop();
});

test("G1: a stale idle snapshot does not restart a Buddy the runner reports running; its turn_ended does", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  r.agents.set("rn-agy", agyBuddy("rn-agy"));
  const restarts = [];
  const w = startTokenWatcher({ runner: r, rootDir, restartBuddy: async (b) => { restarts.push(b); } });
  const a = r.agents.get("rn-agy");
  a.lastUsage = { contextWindowUsedTokens: 160_000, inputTokens: 160_000 };
  r.emit({ kind: "agent", agent: { ...a, status: "idle", labels: { ...a.labels } } }); // replayed / lagging snapshot
  await tick();
  assert.equal(restarts.length, 0, "the runner's status now (running) wins over the snapshot");
  a.status = "idle";
  r.emit({ kind: "turn_ended", agentId: "rn-agy", turnId: "9", outcome: { kind: "completed" }, agent: { ...a, labels: { ...a.labels } } });
  await tick();
  assert.equal(restarts.length, 1, "the deferred restart runs at turn end without another usage event");
  w.stop();
});

test("G1: an errored (not running) non-Claude Buddy over the cap still restarts", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  r.agents.set("rn-agy", agyBuddy("rn-agy", "error", "antigravity-cli")); // K2b: a compacting provider too (no turn to compact in)
  const restarts = [];
  const w = startTokenWatcher({ runner: r, rootDir, restartBuddy: async (b) => { restarts.push(b); } });
  r.usage("rn-agy", 160_000);
  await tick();
  assert.equal(restarts.length, 1);
  w.stop();
});

test("K2b: an errored Claude Buddy over the cap restarts too (no turn to compact in; it used to wait in the compaction branch forever)", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  r.agents.set("rn-cle", agyBuddy("rn-cle", "error", "claude"));
  const restarts = [];
  const w = startTokenWatcher({ runner: r, rootDir, restartBuddy: async (b) => { restarts.push(b); } });
  r.usage("rn-cle", 160_000);
  await tick();
  assert.equal(restarts.length, 1);
  assert.equal(r.sent.filter((x) => x.text.startsWith("/compact")).length, 0);
  w.stop();
});

test("G1: an unrelated turn_ended (no deferred restart) evaluates nothing", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  r.agents.set("rn-agy", agyBuddy("rn-agy", "idle"));
  r.agents.get("rn-agy").lastUsage = { contextWindowUsedTokens: 160_000, inputTokens: 160_000 };
  const restarts = [];
  const w = startTokenWatcher({ runner: r, rootDir, restartBuddy: async (b) => { restarts.push(b); } });
  const a = r.agents.get("rn-agy");
  r.emit({ kind: "turn_ended", agentId: "rn-agy", turnId: "1", outcome: { kind: "completed" }, agent: { ...a, labels: { ...a.labels } } });
  await tick();
  assert.equal(restarts.length, 0, "turn_ended alone only re-checks a Buddy whose restart is waiting");
  w.stop();
});

test("G1: a Claude Buddy already compacted once and still over the cap waits for its turn to end too (no second /compact)", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  const b = { ...buddy("rn-cl"), provider: "claude", status: "running" };
  b.labels = { ...b.labels, [WARN_LABEL]: "1", "vs.compacted-at": "2026-11-19T00:00:00Z" };
  r.agents.set("rn-cl", b);
  const restarts = [];
  const w = startTokenWatcher({ runner: r, rootDir, restartBuddy: async (x) => { restarts.push(x); } });
  r.usage("rn-cl", 160_000);
  await tick();
  assert.equal(restarts.length, 0);
  r.agents.get("rn-cl").status = "idle";
  r.usage("rn-cl", 160_500);
  await tick();
  assert.equal(restarts.length, 1);
  assert.equal(r.sent.filter((s) => s.text.startsWith("/compact")).length, 0);
  w.stop();
});

test("G1 R2: a non-compacting Buddy that jumps past the warn in ONE turn gets the brief nudge at turn end, then restarts after that brief turn", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  const b = { ...buddy("rn-agy"), provider: "codex", status: "running" };
  r.agents.set("rn-agy", b);
  const restarts = [];
  const w = startTokenWatcher({ runner: r, rootDir, restartBuddy: async (x) => { restarts.push(x); } });
  const snap = () => ({ ...r.agents.get("rn-agy"), labels: { ...r.agents.get("rn-agy").labels } });
  r.usage("rn-agy", 21_000);
  r.usage("rn-agy", 158_000); // same turn: 21k -> 158k, past warn and cap
  await tick();
  assert.equal(r.sent.length, 0, "no nudge into the running turn");
  assert.equal(restarts.length, 0);
  r.agents.get("rn-agy").status = "idle"; // the owner's turn ends
  r.emit({ kind: "agent", agent: snap() });
  r.emit({ kind: "turn_ended", agentId: "rn-agy", turnId: "1", outcome: { kind: "completed" }, agent: snap() });
  await tick();
  assert.deepEqual(r.sent.map((s) => s.text), [BRAINSTORM_WARN_NUDGE]);
  assert.equal(restarts.length, 0, "the brief update comes first");
  r.agents.get("rn-agy").status = "running"; // the brief turn
  r.emit({ kind: "agent", agent: snap() });
  await tick();
  assert.equal(restarts.length, 0);
  r.agents.get("rn-agy").status = "idle"; // brief turn ends: idle upsert and turn_ended back to back (the busy gate must not drop it)
  r.emit({ kind: "agent", agent: snap() });
  r.emit({ kind: "turn_ended", agentId: "rn-agy", turnId: "2", outcome: { kind: "completed" }, agent: snap() });
  await tick();
  assert.equal(restarts.length, 1);
  assert.equal(r.sent.length, 1, "one nudge");
  w.stop();
});

test("G1 R2: the brief turn never comes -> the restart still runs once briefWaitMs is up (idle)", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  r.agents.set("rn-agy", { ...buddy("rn-agy"), provider: "codex", status: "idle" });
  const restarts = [];
  const w = startTokenWatcher({ runner: r, rootDir, briefWaitMs: 60, restartBuddy: async (x) => { restarts.push(x); } });
  r.usage("rn-agy", 160_000);
  await tick();
  assert.deepEqual(r.sent.map((s) => s.text), [BRAINSTORM_WARN_NUDGE]);
  assert.equal(restarts.length, 0);
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(restarts.length, 1);
  w.stop();
});

test("G2: an agy lead is measured in working tokens (meter minus the fixed preamble)", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  r.agents.set("rn-agy-lead", { ...lead("rn-agy-lead"), provider: "antigravity-cli" });
  // K2b: agy compacts first now; a failed compaction falls through to the nudge, so the stub pins the working-token gate.
  const tries = [];
  const compactor = { run: async (a, o) => { tries.push(o.cap); return { outcome: "failed", reason: "test" }; } };
  const w = startTokenWatcher({ runner: r, rootDir, compactor });
  r.usage("rn-agy-lead", LEAD_FLAG_DEFAULT + 10); // raw over the flag, working tokens under it: no nudge
  await tick();
  assert.equal(r.sent.length, 0, "agy lead under the preamble-adjusted flag is not nudged");
  assert.equal(tries.length, 0, "nor compacted");
  r.usage("rn-agy-lead", LEAD_FLAG_DEFAULT + PROVIDER_PREAMBLE_TOKENS["antigravity-cli"] + 10);
  await tick();
  assert.deepEqual(tries, [LEAD_FLAG_DEFAULT]);
  assert.deepEqual(r.sent.map((s) => s.text), [SOFT_FLAG_NUDGE], "nudged once working tokens pass the flag");
  w.stop();
});

test("G2: the non-Claude lead cap rules ride the successor prompt, claude's does not", () => {
  const base = { laneId: "x", nextOrd: 2, oldLead: { id: "a" }, trigger: "auto-250", packetPath: "p", summaryPath: "s", latestPlan: "l" };
  assert.ok(buildSuccessorPrompt({ ...base, provider: "antigravity-cli" }).includes(NON_CLAUDE_LEAD_CAP_RULES));
  assert.ok(!buildSuccessorPrompt({ ...base, provider: "claude" }).includes(NON_CLAUDE_LEAD_CAP_RULES));
});

test("G2 review M: the preamble subtraction never delays the 300k hard cap (raw meter)", async () => {
  const rootDir = makeRoot();
  const r = makeRunner();
  r.agents.set("rn-agy-hard", { ...lead("rn-agy-hard"), provider: "antigravity-cli" });
  const w = startTokenWatcher({ runner: r, rootDir, baseHome: join(rootDir, "home") });
  r.usage("rn-agy-hard", LEAD_HARD_CAP_DEFAULT + 1); // raw over the cap, working tokens (265k) under it
  await tick();
  await tick();
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].labels["vs.handoff-trigger"], "hard-300");
  w.stop();
});
