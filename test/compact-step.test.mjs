import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startTokenWatcher, BRAINSTORM_WARN_NUDGE, WARN_LABEL } from "../server/token-watch.mjs";
import { appendVsLogEntry } from "../server/brainstorm.mjs";
import { createCompactor, compactLanding, COMPACTED_AT_LABEL, COMPACT_TIMEOUT_MS, BUDDY_COMPACT_FOCUS, LEAD_COMPACT_FOCUS } from "../server/compact-step.mjs";
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
    async updateAgent(_id, { labels }) { labelWrites.push(labels); agent.labels = { ...labels }; },
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
