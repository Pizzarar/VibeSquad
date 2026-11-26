import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startTokenWatcher, BRAINSTORM_WARN_NUDGE, WARN_LABEL } from "../server/token-watch.mjs";
import { appendVsLogEntry } from "../server/brainstorm.mjs";
import { createCompactor, compactLanding, compactSpendFromLog, canCompact, compactCommand, COMPACTED_AT_LABEL, COMPACT_TIMEOUT_MS, BUDDY_COMPACT_FOCUS, LEAD_COMPACT_FOCUS } from "../server/compact-step.mjs";
import { compactNotAttempted } from "../server/compact-crossing.mjs";
import { LEAD_FLAG_DEFAULT, LEAD_HARD_CAP_DEFAULT, SOFT_FLAG_NUDGE } from "../server/lead-handoff.mjs";

process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });

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
    async updateAgent(id, { labels }) { const a = agents.get(id); if (a && labels) a.labels = { ...a.labels, ...labels }; }, // runner fold: key-by-key merge
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
  const dir = mkdtempSync(join(tmpdir(), "vs-compact-step-")); tmpDirs.push(dir);
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

test("providers without a working /compact (codex / opencode): no /compact, old ladder untouched", async () => {
  const { r, restarts, watch } = setup("ok");
  r.agents.set("rn-b", buddy("rn-b", "codex"));
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

// ---- K2b (docs/lanes/perfection/K2B.md): agy compacts in place with a bare /compact ----

test("K2b agy Buddy over the cap: bare /compact (no focus), compacted -> no restart, same id", async () => {
  const { r, restarts, watch, laneLog } = setup("ok");
  r.agents.set("rn-ab", buddy("rn-ab", "antigravity-cli"));
  const w = watch();
  r.usage("rn-ab", 160_000);
  await tick(250);
  assert.deepEqual(compacts(r).map((s) => s.text), ["/compact"]);
  assert.equal(restarts.length, 0);
  assert.match(laneLog(), /compact-step buddy agent=rn-ab outcome=ok before=160000 after=40000/);
  w.stop();
});

test("K2b agy Buddy: second crossing without a drop under the re-arm line -> no second compaction, the restart runs", async () => {
  const { r, restarts, watch } = setup("ok");
  r.agents.set("rn-ab", buddy("rn-ab", "agy")); // alias spelling
  const w = watch();
  r.usage("rn-ab", 151_000);
  await tick(250);
  r.usage("rn-ab", 140_000);
  await tick(50);
  r.usage("rn-ab", 152_000);
  await tick(150);
  assert.equal(compacts(r).length, 1);
  assert.equal(restarts.length, 1);
  w.stop();
});

test("K2b agy Buddy still over after /compact (meter not lowered) -> restart proceeds", async () => {
  const { r, restarts, watch } = setup("over");
  r.agents.set("rn-ab", buddy("rn-ab", "antigravity-cli"));
  const w = watch();
  r.usage("rn-ab", 160_000);
  await tick(300);
  assert.equal(compacts(r).length, 1);
  assert.equal(restarts.length, 1);
  w.stop();
});

test("K2b agy Buddy busy (runner says running): no /compact, no restart, compacted at the next idle", async () => {
  const { r, restarts, watch } = setup("ok");
  r.agents.set("rn-ab", buddy("rn-ab", "antigravity-cli"));
  const realFetch = r.fetchAgent;
  let busy = true;
  r.fetchAgent = async (id) => ({ agent: { ...(await realFetch(id)).agent, ...(busy && id === "rn-ab" ? { status: "running" } : {}) } });
  const w = watch();
  r.usage("rn-ab", 160_000); // snapshot idle, runner running (C1)
  await tick(150);
  assert.equal(compacts(r).length, 0);
  assert.equal(restarts.length, 0);
  busy = false;
  r.emit({ kind: "turn_ended", agentId: "rn-ab", agent: { ...r.agents.get("rn-ab") } });
  await tick(250);
  assert.equal(compacts(r).length, 1);
  assert.equal(restarts.length, 0);
  w.stop();
});

test("K2b agy lead past the soft flag: bare /compact, compacted -> no nudge, no handoff", async () => {
  const { r, watch, laneLog } = setup("ok");
  r.agents.set("rn-al", lead("rn-al", "antigravity-cli"));
  const w = watch();
  r.usage("rn-al", LEAD_FLAG_DEFAULT + 35_000 + 5); // G2: agy working tokens = meter - 35k preamble
  await tick(300);
  assert.deepEqual(r.sent.map((s) => s.text), ["/compact"]);
  assert.equal(r.created.length, 0);
  assert.match(laneLog(), /compact-step lead agent=rn-al outcome=ok/);
  w.stop();
});

test("K2b agy lead past the hard cap: forced handoff at once, no compaction first", async () => {
  const { r, watch } = setup("ok");
  r.agents.set("rn-al", lead("rn-al", "antigravity-cli"));
  const w = watch();
  r.usage("rn-al", LEAD_HARD_CAP_DEFAULT + 1);
  await tick(300);
  assert.equal(compacts(r).length, 0);
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].labels["vs.handoff-trigger"], "hard-300");
  w.stop();
});

test("second crossing without a drop under the re-arm line: no second compaction, the handoff runs", async () => {
  const { r, restarts, watch } = setup("ok");
  r.agents.set("rn-b", buddy("rn-b"));
  const w = watch();
  r.usage("rn-b", 151_000);
  await tick(250);
  assert.equal(restarts.length, 0);
  r.usage("rn-b", 140_000); // K2c: above 90% of the cap (135k) -> not re-armed
  await tick(50);
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

test("lead: still over / timeout -> the unchanged ladder runs (soft nudge)", async () => {
  for (const mode of ["over", "timeout"]) {
    const { r, watch } = setup(mode);
    r.agents.set("rn-l", lead("rn-l"));
    const w = watch();
    r.usage("rn-l", LEAD_FLAG_DEFAULT + 5);
    await tick(500);
    assert.deepEqual(r.sent.map((s) => s.text), [`/compact ${LEAD_COMPACT_FOCUS}`, SOFT_FLAG_NUDGE], mode);
    assert.equal(r.created.length, 0, mode);
    w.stop();
  }
});

test("lead: past the hard cap -> forced handoff at once, no compaction attempt first (K2c)", async () => {
  const { r, watch } = setup("ok");
  r.agents.set("rn-l", lead("rn-l"));
  const w = watch();
  r.usage("rn-l", LEAD_HARD_CAP_DEFAULT + 1);
  await tick(300);
  assert.equal(compacts(r).length, 0);
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].labels["vs.handoff-trigger"], "hard-300");
  w.stop();
});

for (const [label, extra] of [["errored", { status: "error" }], ["lost", { status: "idle", lost: true }]]) {
  test(`K2b lead ${label} past the soft flag: no /compact, no stamp, the pre-K2 ladder runs (nudge) instead of deferring forever`, async () => {
    const { r, watch } = setup("ok");
    r.agents.set("rn-le", { ...lead("rn-le"), ...extra });
    const w = watch();
    r.usage("rn-le", LEAD_FLAG_DEFAULT + 5);
    await tick(150);
    assert.equal(compacts(r).length, 0);
    const l = r.agents.get("rn-le").labels;
    assert.equal(l["vs.compacted-at"], undefined);
    assert.equal(l["handoff-nudged"] ?? l["handoff-flagged"], "1", "the 150k soft stage ran");
    w.stop();
  });
}

test("K2b lead queued past the soft flag still defers (not dead): no nudge, compacted on the idle upsert", async () => {
  const { r, watch } = setup("ok");
  r.agents.set("rn-lq", { ...lead("rn-lq"), status: "queued" });
  const w = watch();
  r.usage("rn-lq", LEAD_FLAG_DEFAULT + 5);
  await tick(100);
  assert.equal(r.sent.length, 0);
  assert.equal(r.agents.get("rn-lq").labels["handoff-nudged"], undefined);
  r.agents.get("rn-lq").status = "idle";
  r.usage("rn-lq", LEAD_FLAG_DEFAULT + 6);
  await tick(250);
  assert.equal(compacts(r).length, 1);
  w.stop();
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

// Real claude-adapter log shapes: usage never carries costUsd; turn_done carries the session-cumulative total_cost_usd;
// after `compacted` the adapter emits a synthetic usage { inputTokens: post_tokens, outputTokens: 0 }.
const ev = (type, o = {}) => ({ type, ...o });

function fakeRun(agent, events) {
  const listeners = new Set();
  const runner = {
    subscribeEvents(l) { listeners.add(l); return () => listeners.delete(l); },
    async updateAgent() {},
    async sendAgentPrompt() { setTimeout(() => { agent.usedTokens = 30_000; for (const l of listeners) l({ kind: "timeline", agentId: agent.id, type: "compacted" }); }, 5); },
    async fetchAgent() { return { agent }; },
  };
  const lines = [];
  const c = createCompactor({ runner, timeoutMs: 200, settleMs: 80, log: (e) => lines.push(e.text), readEvents: () => events });
  return { c, lines };
}

test("compact-step logs the /compact turn costUsd + tokens from the log (turn_done cumulative cost, post_tokens usage after compacted counts)", async () => {
  const a = { id: "rn-c", provider: "claude", status: "idle", labels: {}, usedTokens: 150_000 };
  const { c, lines } = fakeRun(a, [
    ev("input", { text: "work" }), ev("usage", { inputTokens: 5000, outputTokens: 500 }), ev("turn_done", { costUsd: 1.5 }),
    ev("input", { text: "/compact keep the brief" }),
    ev("compacted", { before: 150000, after: 30000 }), // real /compact: no usage before compacted
    ev("usage", { contextTokens: 30000, inputTokens: 30000, outputTokens: 0 }), // the only usage in the turn: adapter post_tokens
    ev("turn_done", { costUsd: 1.75 }),
  ]);
  const res = await c.run(a, { focus: "x", cap: 100_000 });
  assert.equal(res.outcome, "ok");
  assert.equal(res.costUsd, 0.25);
  assert.equal(res.tokens, 30000);
  assert.match(lines[0], /outcome=ok before=150000 after=30000 cap=100000 ms=\d+ costUsd=0\.25 tokens=30000/);
});

test("compact-step: /compact arriving mid-turn -> the prior turn_done only moves the baseline", async () => {
  const a = { id: "rn-m", provider: "claude", status: "idle", labels: {}, usedTokens: 150_000 };
  const { c } = fakeRun(a, [
    ev("input", { text: "work" }), ev("usage", { inputTokens: 100000, outputTokens: 9000 }),
    ev("input", { text: "/compact" }),
    ev("usage", { inputTokens: 4000, outputTokens: 1000 }), // still the old turn
    ev("turn_done", { costUsd: 3.0 }), // old turn ends: reset
    ev("compacted", { before: 150000, after: 30000 }),
    ev("usage", { inputTokens: 30000, outputTokens: 0 }),
    ev("turn_done", { costUsd: 3.2 }),
  ]);
  const res = await c.run(a, { cap: 100_000 });
  assert.equal(res.costUsd, 0.2);
  assert.equal(res.tokens, 30000);
});

test("compact-step without a readable log omits costUsd/tokens instead of guessing", async () => {
  const a = { id: "rn-d", provider: "claude", status: "idle", labels: {}, usedTokens: 150_000 };
  const { c, lines } = fakeRun(a, []);
  const res = await c.run(a, { cap: 100_000 });
  assert.equal(res.outcome, "ok");
  assert.equal(res.costUsd, undefined);
  assert.doesNotMatch(lines[0], /costUsd=|tokens=/);
});

test("compactSpendFromLog matches a /compact line after a coalesced wake prefix (ignores earlier /compact)", () => {
  const events = [
    ev("input", { text: "/compact earlier" }),
    ev("compacted", { before: 120000, after: 25000 }),
    ev("turn_done", { costUsd: 0.5 }),
    ev("input", { text: "work" }),
    ev("usage", { inputTokens: 8000, outputTokens: 1000 }),
    ev("turn_done", { costUsd: 1.5 }),
    ev("input", { text: "<wake>\n\n/compact keep the brief" }),
    ev("compacted", { before: 150000, after: 30000 }),
    ev("usage", { inputTokens: 30000, outputTokens: 0 }),
    ev("turn_done", { costUsd: 1.8 }),
  ];
  assert.deepEqual(compactSpendFromLog(events), { costUsd: 0.3, tokens: 30000 });
});

test("compactSpendFromLog does not match /compact mentioned mid-sentence", () => {
  const events = [
    ev("input", { text: "work" }),
    ev("turn_done", { costUsd: 1.0 }),
    ev("input", { text: "please run /compact later\nand mention /compact mid-line too" }),
    ev("compacted", { before: 150000, after: 30000 }),
    ev("usage", { inputTokens: 30000, outputTokens: 0 }),
    ev("turn_done", { costUsd: 1.25 }),
  ];
  assert.equal(compactSpendFromLog(events), null);
});

// ---- K2a (docs/lanes/perfection/K2A.md): per-cause guards ----

/**
 * Scripted runner for one agent. onSend(n, emit) runs on the n-th send and returns the runner's answer ({ queued }); emit pushes a
 * backend event for the agent (turn_started / turn_ended / timeline compacted). fresh(fetchCount) is the runner's status now.
 */
function scripted(agent, { onSend = () => ({ ok: true, queued: false }), fresh, events = () => [], opts = {} } = {}) {
  const listeners = new Set();
  const sends = [];
  const labelWrites = [];
  let fetches = 0;
  const emit = (ev) => { for (const l of listeners) l({ agentId: agent.id, ...ev }); };
  const later = (ms, ev) => setTimeout(() => emit(ev), ms);
  const runner = {
    subscribeEvents(l) { listeners.add(l); return () => listeners.delete(l); },
    async updateAgent(_id, { labels }) { labelWrites.push(labels); agent.labels = { ...agent.labels, ...labels }; },
    async sendAgentPrompt(_id, text) { sends.push({ text, at: Date.now() }); return onSend(sends.length, later); },
    async fetchAgent() { fetches++; return { agent: fresh ? { ...agent, ...fresh(fetches, emit) } : agent }; },
  };
  const lines = [];
  const c = createCompactor({
    runner, timeoutMs: 150, queueTimeoutMs: 600, settleMs: 20, idlePollMs: 10, lateBoundaryMs: 150,
    log: (e) => lines.push(e.text), readEvents: () => events(), ...opts,
  });
  return { c, sends, labelWrites, lines, emit };
}
const K = (id) => ({ id, provider: "claude", status: "idle", labels: {}, usedTokens: 150_000 });
const ENDED = { kind: "turn_ended", outcome: { kind: "completed" } };
const STARTED = { kind: "turn_started" };
const COMPACTED = { kind: "timeline", type: "compacted" };
const DIRECT_LOG = () => [ev("status", { status: "idle" }), ev("input", { text: "/compact x" }), ev("status", { status: "running" })];
const STEERED_LOG = () => [ev("status", { status: "idle" }), ev("input", { text: "New team log event" }), ev("status", { status: "running" }), ev("input", { text: "/compact x" }), ev("status", { status: "running" })];

test("K2a defaults: 240s per-attempt timeout", () => {
  assert.equal(COMPACT_TIMEOUT_MS, 240_000);
});

test("K2a C1: snapshot idle but the runner says running (or queued) -> skipped busy, no label, no send, retried at the next idle", async () => {
  for (const now of [{ status: "running" }, { status: "initializing", queued: { ahead: 2 } }, { status: "idle", queued: { ahead: 0 } }]) {
    const a = K("rn-c1");
    let state = now;
    const { c, sends, labelWrites, lines } = scripted(a, { fresh: () => state, onSend: (_n, later) => { later(5, COMPACTED); return { ok: true, queued: false }; }, events: DIRECT_LOG });
    const res = await c.run(a, { focus: "x", cap: 200_000 });
    assert.deepEqual(res, { outcome: "skipped", reason: "busy" }, JSON.stringify(now));
    assert.equal(sends.length, 0);
    assert.equal(labelWrites.length, 0);
    assert.equal(a.labels[COMPACTED_AT_LABEL], undefined);
    assert.equal(c.tried.has(a.id), false);
    assert.equal(lines.length, 0);
    state = { status: "idle" }; // the next idle re-evaluates and compacts
    assert.equal((await c.run(a, { focus: "x", cap: 200_000 })).outcome, "ok");
    assert.equal(sends.length, 1);
  }
});

test("K2a C2: queued /compact -> a turn end before its turn starts (park) is ignored; the later start + boundary is ok", async () => {
  const a = K("rn-c2");
  const { c, sends, lines } = scripted(a, {
    onSend: (_n, later) => { later(10, ENDED); later(40, STARTED); later(70, COMPACTED); return { ok: true, queued: true, ahead: 2 }; },
    events: DIRECT_LOG,
  });
  const res = await c.run(a, { focus: "x", cap: 200_000 });
  assert.equal(res.outcome, "ok");
  assert.equal(res.attempts, 1);
  assert.equal(sends.length, 1);
  assert.match(lines[0], /outcome=ok .* attempts=1$/);
});

test("K2a C2: a queued /compact that never starts -> timeout reason=queue (bounded, no hang)", async () => {
  const a = K("rn-c2q");
  const { c, lines } = scripted(a, { onSend: (_n, later) => { later(10, ENDED); return { ok: true, queued: true }; }, events: DIRECT_LOG, opts: { queueTimeoutMs: 120 } });
  const res = await c.run(a, { focus: "x", cap: 200_000 });
  assert.equal(res.outcome, "timeout");
  assert.equal(res.reason, "queue");
  assert.match(lines[0], /outcome=timeout .* reason=queue attempts=1 -> falling through to handoff/);
});

test("K2a C3/C4: first attempt ends without a boundary -> re-sent alone once idle -> ok, attempts=2, one label write", async () => {
  const a = K("rn-c3");
  const { c, sends, labelWrites, lines } = scripted(a, {
    onSend: (n, later) => { later(10, n === 1 ? ENDED : COMPACTED); return { ok: true, queued: false }; },
    events: DIRECT_LOG,
  });
  const res = await c.run(a, { focus: "x", cap: 200_000 });
  assert.equal(res.outcome, "ok");
  assert.equal(res.attempts, 2);
  assert.deepEqual(sends.map((s) => s.text), ["/compact x", "/compact x"]);
  assert.equal(labelWrites.length, 1);
  assert.match(lines[0], /outcome=ok before=150000 after=\S+ cap=200000 ms=\d+ attempts=2$/);
});

test("K2a: every attempt ends without a boundary -> failed reason=no-boundary after maxAttempts sends (no hang)", async () => {
  const a = K("rn-nb");
  const { c, sends, lines } = scripted(a, { onSend: (_n, later) => { later(10, ENDED); return { ok: true, queued: false }; }, events: DIRECT_LOG });
  const res = await c.run(a, { focus: "x", cap: 200_000 });
  assert.equal(res.outcome, "failed");
  assert.equal(res.reason, "no-boundary");
  assert.equal(res.attempts, 3);
  assert.equal(sends.length, 3);
  assert.match(lines[0], /outcome=failed .* reason=no-boundary attempts=3 -> falling through to handoff/);
  assert.equal((await c.run(a, { focus: "x" })).reason, "already-compacted"); // one run per crossing
  assert.equal(sends.length, 3);
});

test("K2a C5: the per-attempt clock starts at turn start, not at send", async () => {
  const a = K("rn-c5");
  // Queued 120ms, then a 100ms compaction: 220ms after the send, past the 150ms budget only if it counted from the send.
  const { c } = scripted(a, { onSend: (_n, later) => { later(120, STARTED); later(220, COMPACTED); return { ok: true, queued: true }; }, events: DIRECT_LOG });
  const res = await c.run(a, { focus: "x", cap: 200_000 });
  assert.equal(res.outcome, "ok");
  // A turn that runs past the budget from its start still times out (reason=turn).
  const b = K("rn-c5b");
  const s2 = scripted(b, { onSend: (_n, later) => { later(10, STARTED); later(400, COMPACTED); return { ok: true, queued: true }; }, events: DIRECT_LOG });
  const r2 = await s2.c.run(b, { focus: "x", cap: 200_000 });
  assert.equal(r2.outcome, "timeout");
  assert.equal(r2.reason, "turn");
  assert.match(s2.lines[0], /reason=turn attempts=1/);
});

test("K2a: a wake turn that ran between attempts is not read as the retry's turn", async () => {
  const a = K("rn-wake");
  let sentCount = 0;
  const { c, sends } = scripted(a, {
    onSend: (n, later) => { sentCount = n; if (n === 1) later(10, ENDED); else later(40, COMPACTED); return { ok: true, queued: false }; },
    // fetch 1 = the gate (idle). After the no-boundary end: running twice (a wake turn), then idle -- the wake's start/end land
    // right before the idle read, still unconsumed when the retry is sent.
    fresh: (n, emit) => {
      if (sentCount === 0 || n === 1) return { status: "idle" };
      if (n < 4) return { status: "running" };
      if (n === 4) { emit(STARTED); emit(ENDED); }
      return { status: "idle" };
    },
    events: DIRECT_LOG,
  });
  const res = await c.run(a, { focus: "x", cap: 200_000 });
  assert.equal(res.outcome, "ok");
  assert.equal(res.attempts, 2);
  assert.equal(sends.length, 2);
});

test("K2a C1 late boundary: a /compact steered into a live turn waits for the CLI's own /compact turn (no second send)", async () => {
  const a = K("rn-late");
  const { c, sends } = scripted(a, { onSend: (_n, later) => { later(10, ENDED); later(80, COMPACTED); return { ok: true, queued: false }; }, events: STEERED_LOG, opts: { lateBoundaryMs: 1_000 } });
  const res = await c.run(a, { focus: "x", cap: 200_000 });
  assert.equal(res.outcome, "ok");
  assert.equal(res.attempts, 1);
  assert.equal(sends.length, 1);
});

test("K2a C1 late boundary: none within the window -> re-sent; a park after the steer stops the wait early", async () => {
  const a = K("rn-late2");
  const s1 = scripted(a, { onSend: (n, later) => { later(10, n === 1 ? ENDED : COMPACTED); return { ok: true, queued: false }; }, events: STEERED_LOG, opts: { lateBoundaryMs: 60 } });
  const r1 = await s1.c.run(a, { focus: "x", cap: 200_000 });
  assert.equal(r1.outcome, "ok");
  assert.equal(r1.attempts, 2);
  assert.ok(s1.sends[1].at - s1.sends[0].at >= 60, "the re-send waited for the late window");

  const b = K("rn-late3");
  const parked = () => [...STEERED_LOG(), ev("turn_done", {}), ev("status", { status: "idle" }), ev("parked", {}), ev("status", { status: "parked" })];
  const s2 = scripted(b, { onSend: (n, later) => { later(10, n === 1 ? ENDED : COMPACTED); return { ok: true, queued: false }; }, events: parked, opts: { lateBoundaryMs: 5_000 } });
  const t0 = Date.now();
  const r2 = await s2.c.run(b, { focus: "x", cap: 200_000 });
  assert.equal(r2.outcome, "ok");
  assert.equal(r2.attempts, 2);
  assert.ok(Date.now() - t0 < 2_000, "parked: no 5s late wait");
});

test("K2a compactLanding: steered / direct / gone from the runner log", () => {
  assert.equal(compactLanding(STEERED_LOG()), "steered");
  assert.equal(compactLanding(DIRECT_LOG()), "direct");
  assert.equal(compactLanding([ev("status", { status: "idle" }), ev("input", { text: "/compact" }), ev("status", { status: "queued" })]), "direct");
  assert.equal(compactLanding([...STEERED_LOG(), ev("exit", { code: 0 })]), "gone");
  assert.equal(compactLanding([]), "direct");
});

test("K2a: a failed send -> failed reason=send, label written once, no retry", async () => {
  const a = K("rn-send");
  const listeners = new Set();
  let sends = 0;
  const runner = {
    subscribeEvents(l) { listeners.add(l); return () => listeners.delete(l); },
    async updateAgent(_id, { labels }) { a.labels = labels; },
    async sendAgentPrompt() { sends++; throw new Error("runner down"); },
    async fetchAgent() { return { agent: a }; },
  };
  const lines = [];
  const res = await createCompactor({ runner, timeoutMs: 100, log: (e) => lines.push(e.text) }).run(a, { focus: "x" });
  assert.equal(res.outcome, "failed");
  assert.equal(res.reason, "send");
  assert.equal(sends, 1);
  assert.ok(a.labels[COMPACTED_AT_LABEL]);
  assert.equal(listeners.size, 0, "the event subscription is released");
  assert.match(lines[0], /reason=send attempts=1 -> falling through to handoff/);
});

// ---- K2a+K2c fix round (Gemini K2a FAIL 0/2/1/1, Sonnet K2a/K2c minors) ----

test("K2a fix: a steered /compact on the LAST attempt still gets its late boundary window (no handoff on top of the held /compact)", async () => {
  const a = K("rn-lastlate");
  const { c, sends } = scripted(a, {
    onSend: (_n, later) => { later(10, ENDED); later(80, COMPACTED); return { ok: true, queued: false }; },
    events: STEERED_LOG, opts: { maxAttempts: 1, lateBoundaryMs: 1_000 },
  });
  const res = await c.run(a, { focus: "x", cap: 200_000 });
  assert.equal(res.outcome, "ok");
  assert.equal(res.attempts, 1);
  assert.equal(sends.length, 1);
  // Not steered on the last attempt: no late wait, it fails at once.
  const b = K("rn-lastdirect");
  const s2 = scripted(b, { onSend: (_n, later) => { later(10, ENDED); return { ok: true, queued: false }; }, events: DIRECT_LOG, opts: { maxAttempts: 1, lateBoundaryMs: 5_000 } });
  const t0 = Date.now();
  const r2 = await s2.c.run(b, { focus: "x", cap: 200_000 });
  assert.equal(r2.reason, "no-boundary");
  assert.ok(Date.now() - t0 < 2_000, "direct: no late wait");
});

test("K2a fix: compactLanding is anchored to the current send (an earlier attempt's steered input is not this one's)", () => {
  const log = [
    ev("status", { ts: 90, status: "running" }), ev("input", { ts: 100, text: "/compact x" }), ev("status", { ts: 101, status: "running" }),
    ev("turn_done", { ts: 150 }), ev("status", { ts: 190, status: "idle" }),
    ev("input", { ts: 200, text: "New team log event\n\n/compact x" }), ev("status", { ts: 201, status: "running" }), // C3 coalesced
  ];
  assert.equal(compactLanding(log.slice(0, 3)), "steered");
  assert.equal(compactLanding(log, { since: 195 }), "direct"); // the coalesced input is this send's; idle before it
  assert.equal(compactLanding(log.slice(0, 5), { since: 195 }), "direct"); // this send's input not logged: never attempt 1's
  assert.equal(compactLanding(log.slice(0, 3), { since: 50 }), "steered");
});

test("K2a fix: attempt 2 coalesced after a steered attempt 1 -> no spurious late-boundary wait", async () => {
  const a = K("rn-anch");
  const t = Date.now();
  // Attempt 1's steered input is logged before attempt 2's send; attempt 2's input (coalesced) is not steered.
  const log = () => [
    ev("status", { ts: t - 10, status: "running" }), ev("input", { ts: t, text: "/compact x" }), ev("status", { ts: t + 1, status: "running" }),
    ...(a._sent2 ? [ev("status", { ts: a._sent2, status: "idle" }), ev("input", { ts: a._sent2 + 1, text: "wake\n\n/compact x" })] : []),
  ];
  const { c, sends } = scripted(a, {
    onSend: (n, later) => { if (n === 2) a._sent2 = Date.now(); later(10, ENDED); return { ok: true, queued: false }; },
    events: log, opts: { maxAttempts: 2, lateBoundaryMs: 100 },
  });
  const t0 = Date.now();
  const res = await c.run(a, { focus: "x", cap: 200_000 });
  assert.equal(res.reason, "no-boundary");
  assert.equal(sends.length, 2);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 190, `one late window (attempt 1), not two: ${elapsed}ms`);
});

test("K2c fix: hardCap -> the retry loop stops with reason=hard-cap once the fresh raw meter reaches it (no re-send)", async () => {
  const a = K("rn-hc");
  let sent = 0;
  const { c, sends, lines } = scripted(a, {
    onSend: (n, later) => { sent = n; later(10, ENDED); return { ok: true, queued: false }; },
    // After the no-boundary end, a steered wake turn pushed the raw meter over the cap.
    fresh: () => (sent ? { status: "running", usedTokens: 301_000 } : { status: "idle" }),
    events: DIRECT_LOG,
  });
  const res = await c.run(a, { focus: "x", cap: 200_000, hardCap: 300_000 });
  assert.equal(res.outcome, "failed");
  assert.equal(res.reason, "hard-cap");
  assert.equal(res.rawUsed, 301_000);
  assert.equal(sends.length, 1);
  assert.match(lines[0], /reason=hard-cap attempts=1 -> falling through to handoff/);
});

test("K2 tail A1: a started /compact turn that runs past the hard cap stops at once with reason=hard-cap (no wait for the turn timeout)", async () => {
  const a = K("rn-a1");
  let fetched = 0;
  const { c, sends } = scripted(a, {
    onSend: () => ({ ok: true, queued: false }), // the turn opens and never ends (no boundary, no turn_ended)
    fresh: (n) => { fetched = n; return n === 1 ? { status: "idle" } : { status: "running", usedTokens: n >= 3 ? 305_000 : 160_000 }; },
    events: DIRECT_LOG,
  });
  const t0 = Date.now();
  const res = await c.run(a, { focus: "x", cap: 200_000, hardCap: 300_000 });
  assert.equal(res.outcome, "failed");
  assert.equal(res.reason, "hard-cap");
  assert.equal(res.rawUsed, 305_000);
  assert.equal(sends.length, 1);
  assert.ok(Date.now() - t0 < 120, `stopped by the poll, not the 150ms turn timeout: ${Date.now() - t0}ms`);
  assert.equal(fetched, 3); // A2: the reading that tripped the cap is reported, no refetch after the stop
});

test("K2 tail A1: without a hardCap the started turn still waits out its own timeout (no meter polling)", async () => {
  const a = K("rn-a1b");
  let fetched = 0;
  const { c } = scripted(a, { onSend: () => ({ ok: true, queued: false }), fresh: (n) => { fetched = n; return { status: n === 1 ? "idle" : "running", usedTokens: 999_000 }; }, events: DIRECT_LOG });
  const res = await c.run(a, { focus: "x", cap: 200_000 });
  assert.equal(res.outcome, "timeout");
  assert.equal(res.reason, "turn");
  assert.equal(fetched, 1); // only the pre-send busy check
});

test("K2 tail A1: a queued /compact is not meter-polled before its turn starts (the hard cap stop needs a started turn)", async () => {
  const a = K("rn-a1q");
  let fetched = 0;
  const { c } = scripted(a, {
    onSend: (_n, later) => { later(40, STARTED); return { ok: true, queued: true }; },
    fresh: (n) => { fetched = n; return n === 1 ? { status: "idle" } : { status: "running", usedTokens: 305_000 }; },
    events: DIRECT_LOG,
  });
  const res = await c.run(a, { focus: "x", cap: 200_000, hardCap: 300_000 });
  assert.equal(res.reason, "hard-cap");
  assert.equal(res.rawUsed, 305_000);
  assert.equal(fetched, 2); // first poll after the turn started
});

test("K2 tail A2: a hard-cap stop from awaitIdle reports the raw value it saw, even when a later fetch would read lower", async () => {
  const a = K("rn-a2");
  let fetched = 0;
  const { c, sends } = scripted(a, {
    onSend: (_n, later) => { later(10, ENDED); return { ok: true, queued: false }; },
    // 1: pre-send busy check; 2: awaitIdle sees the wake turn over the cap; later reads drop (meter reset / stale snapshot).
    fresh: (n) => { fetched = n; return n === 1 ? { status: "idle" } : n === 2 ? { status: "running", usedTokens: 310_000 } : { status: "idle", usedTokens: 1_000 }; },
    events: DIRECT_LOG,
  });
  const res = await c.run(a, { focus: "x", cap: 200_000, hardCap: 300_000 });
  assert.equal(res.reason, "hard-cap");
  assert.equal(res.rawUsed, 310_000);
  assert.equal(fetched, 2);
  assert.equal(sends.length, 1);
});

test("K2b compact-step: agy gets a bare /compact (focus dropped); codex / opencode skip no-compact (no label, no send, not an attempt)", async () => {
  const a = { ...K("rn-k2b"), provider: "antigravity-cli" };
  const { c, sends, labelWrites } = scripted(a, { onSend: (_n, later) => { later(5, COMPACTED); return { ok: true, queued: false }; }, events: DIRECT_LOG });
  const res = await c.run(a, { focus: "keep the plan", cap: 200_000, armed: true, labels: {} });
  assert.equal(res.outcome, "ok");
  assert.deepEqual(sends.map((x) => x.text), ["/compact"]);
  assert.equal(labelWrites.length, 1);
  for (const provider of ["codex", "opencode", "", undefined]) {
    const o = { ...K(`rn-${provider}`), provider };
    const s2 = scripted(o);
    const r2 = await s2.c.run(o, { focus: "x", cap: 1, armed: true });
    assert.deepEqual(r2, { outcome: "skipped", reason: "no-compact" });
    assert.equal(compactNotAttempted(r2), true);
    assert.equal(s2.sends.length + s2.labelWrites.length, 0);
  }
  assert.equal(compactCommand({ provider: "claude" }, "keep it"), "/compact keep it");
  assert.equal(compactCommand({ provider: "agy" }, "keep it"), "/compact");
  assert.deepEqual(["claude", "antigravity-cli", "agy", "Antigravity", "opencode", "codex"].map((p) => canCompact({ provider: p })), [true, true, true, true, false, false]);
});

test("K2b compact-step: agy /compact turn running past the hard cap stops with reason=hard-cap (the forced handoff wins)", async () => {
  const a = { ...K("rn-k2bh"), provider: "antigravity-cli" };
  const { c, sends } = scripted(a, {
    onSend: () => ({ ok: true, queued: false }),
    fresh: (n) => (n === 1 ? { status: "idle" } : { status: "running", usedTokens: 302_000 }),
    events: DIRECT_LOG,
  });
  const res = await c.run(a, { cap: 150_000, hardCap: 300_000, armed: true, labels: {} });
  assert.equal(res.reason, "hard-cap");
  assert.equal(res.rawUsed, 302_000);
  assert.equal(sends.length, 1);
});

test("K2c fix: armed run skips the once-per-life guards and writes only the label patch + vs.compacted-at", async () => {
  const a = { ...K("rn-arm"), labels: { role: "lead", [COMPACTED_AT_LABEL]: "2026-11-20T00:00:00Z", "vs.compact-count": "1" } };
  const { c, labelWrites } = scripted(a, { onSend: (_n, later) => { later(5, COMPACTED); return { ok: true, queued: false }; }, events: DIRECT_LOG });
  assert.equal((await c.run(a, { focus: "x" })).reason, "already-compacted"); // unarmed: the label guard holds
  const res = await c.run(a, { focus: "x", cap: 200_000, armed: true, labels: { "vs.compact-stage": "150000", "vs.compact-count": "2" } });
  assert.equal(res.outcome, "ok");
  assert.deepEqual(Object.keys(labelWrites[0]).sort(), ["vs.compact-count", "vs.compact-stage", COMPACTED_AT_LABEL].sort());
  assert.equal(a.labels.role, "lead"); // merged, not replaced
  assert.equal((await c.run(a, { focus: "x", armed: true, labels: {} })).outcome, "ok"); // armed again (tracker decides)
});

test("K2a fix: pending -- an in-flight run is visible to others and a second run for the same agent is a busy skip", async () => {
  const a = K("rn-pend");
  const pending = new Set();
  let seen = null;
  let c2 = null;
  const { c } = scripted(a, {
    onSend: (_n, later) => { seen = pending.has(a.id); later(30, COMPACTED); return { ok: true, queued: false }; },
    events: DIRECT_LOG, opts: { pending },
  });
  const p = c.run(a, { focus: "x", cap: 200_000 });
  await tick(10);
  c2 = await c.run(a, { focus: "x", armed: true });
  assert.deepEqual(c2, { outcome: "skipped", reason: "busy" });
  assert.equal((await p).outcome, "ok");
  assert.equal(seen, true);
  assert.equal(pending.has(a.id), false); // cleared after the run
});

test("K2a: RunnerBackend.sendAgentPrompt returns the runner's { ok, queued, ahead } (the C2 queued detection depends on it)", async () => {
  const { RunnerBackend } = await import("../server/backend/runner-backend.mjs");
  const calls = [];
  const b = new RunnerBackend({ client: { request: async (...args) => { calls.push(args); return { ok: true, queued: true, ahead: 2 }; } }, hooks: false });
  assert.deepEqual(await b.sendAgentPrompt("rn-q", "/compact x"), { ok: true, queued: true, ahead: 2 });
  assert.equal(calls[0][1], "/agents/rn-q/input");
});

test("K2a fix: a Buddy busy skip defers (no restart) and its turn_ended alone re-evaluates and compacts", async () => {
  const { r, restarts } = setup("ok");
  const outcomes = [{ outcome: "skipped", reason: "busy" }, { outcome: "ok", after: 40_000 }];
  const calls = [];
  const compactor = { tried: new Set(), run: async (agent, opts) => { calls.push(opts); return outcomes.shift(); } };
  r.agents.set("rn-bb", buddy("rn-bb"));
  const w = startTokenWatcher({ runner: r, rootDir: process.env.VIBESQUAD_ROOT, baseHome: process.env.VIBESQUAD_HOME, compactor, restartBuddy: async (b) => { restarts.push(b); } });
  r.usage("rn-bb", 151_000);
  await tick(60);
  assert.equal(calls.length, 1);
  assert.equal(restarts.length, 0);
  r.emit({ kind: "turn_ended", agentId: "rn-bb", agent: { ...r.agents.get("rn-bb") } }); // no idle upsert follows
  await tick(60);
  assert.equal(calls.length, 2);
  assert.equal(restarts.length, 0);
  w.stop();
});
