// K2c (docs/PLAN_PER_K2_1124.md): compaction once per threshold CROSSING for leads and Buddies, before each soft handoff
// stage, with a life cap; the hard cap never waits on it.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BRAINSTORM_WARN_NUDGE, startTokenWatcher, WARN_LABEL } from "../server/token-watch.mjs";
import { appendVsLogEntry } from "../server/brainstorm.mjs";
import { createCompactor, LEAD_COMPACT_FOCUS } from "../server/compact-step.mjs";
import {
  COMPACT_COUNT_LABEL,
  COMPACT_LIFE_CAP,
  COMPACT_STAGE_LABEL,
  COMPACTED_AT,
  createCrossingTracker,
} from "../server/compact-crossing.mjs";
import {
  createLeadHandoffCoordinator,
  LEAD_AUTO_HANDOFF_DEFAULT,
  LEAD_FLAG_DEFAULT,
  LEAD_HARD_CAP_DEFAULT,
  resetLeadHandoffState,
  SOFT_FLAG_NUDGE,
  SOFT_FLAG_REASON,
  WRITE_HANDOFF_PROMPT,
} from "../server/lead-handoff.mjs";

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const FLAG = LEAD_FLAG_DEFAULT;
const AUTO = LEAD_AUTO_HANDOFF_DEFAULT;
const BUDDY_CAP = 150_000; // BRAINSTORM_RESTART_DEFAULT
const REARM_LINE = 135_000; // 90% of 150k

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });

/** Fake runner. r.mode decides what the next `/compact` turn does: ok (-> r.okAfter) | over | timeout | fail. Labels merge (runner fold). */
function makeRunner(mode = "ok") {
  const agents = new Map();
  const sent = [];
  const created = [];
  const labelWrites = [];
  const listeners = new Set();
  let seq = 0;
  const runner = {
    mode, okAfter: 40_000, agents, sent, created, labelWrites,
    subscribeEvents(l) { listeners.add(l); return () => listeners.delete(l); },
    emit(ev) { for (const l of listeners) l(ev); },
    async updateAgent(id, { labels }) {
      const a = agents.get(id);
      labelWrites.push({ id, labels: { ...labels } });
      if (a && labels) a.labels = { ...a.labels, ...labels };
    },
    async sendAgentPrompt(id, text) {
      sent.push({ id, text });
      if (!text.startsWith("/compact")) return;
      if (runner.mode === "fail") throw new Error("runner down");
      if (runner.mode === "timeout") return;
      const a = agents.get(id);
      const after = runner.mode === "ok" ? runner.okAfter : a.lastUsage.contextWindowUsedTokens;
      setTimeout(() => {
        runner.emit({ kind: "timeline", agentId: id, seq: ++seq, type: "compacted" });
        a.lastUsage = { contextWindowUsedTokens: after, inputTokens: after };
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

function setup(mode = "ok", { compactor } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vs-compact-crossing-")); tmpDirs.push(dir);
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  writeFileSync(join(dir, "teams.json"), JSON.stringify({ teams: [{ id: "t", name: "T", lanes: [{ id: "l", name: "L" }] }] }));
  process.env.VIBESQUAD_ROOT = dir;
  process.env.VIBESQUAD_HOME = join(dir, "home");
  const r = makeRunner(mode);
  const c = compactor ?? createCompactor({
    runner: r, timeoutMs: 120, settleMs: 20,
    log: ({ agent, text, teamId, laneId }) => appendVsLogEntry({ teamId, laneId, agent, type: "metric", text }),
  });
  const restarts = [];
  const w = startTokenWatcher({ runner: r, rootDir: dir, baseHome: join(dir, "home"), compactor: c, restartBuddy: async (b) => { restarts.push(b); } });
  const laneLog = () => { const p = join(dir, "home", "logs", "t--l.jsonl"); return existsSync(p) ? readFileSync(p, "utf8") : ""; };
  return { r, w, restarts, laneLog };
}

const buddy = (id, extra = {}) => ({ id, provider: "claude", title: "Buddy", status: "idle", labels: { role: "brainstorm", team: "t", lane: "l", [WARN_LABEL]: "1", ...extra } });
const lead = (id, extra = {}) => ({ id, provider: "claude", title: "★ L1", status: "idle", cwd: "/x", labels: { role: "lead", team: "t", lane: "l", ord: "1", ...extra } });
const compacts = (r) => r.sent.filter((s) => s.text.startsWith("/compact"));
const texts = (r) => r.sent.map((s) => (s.text.startsWith("/compact") ? "/compact" : s.text === SOFT_FLAG_NUDGE ? "nudge" : s.text === WRITE_HANDOFF_PROMPT ? "packet" : s.text));
/** Settle one usage upsert (its evaluation, the compaction and its settle). */
async function step(r, id, tokens, ms = 120) { r.usage(id, tokens); await tick(ms); }

// ---- pure tracker ----

test("tracker: armed -> compact; same stage again -> none; higher stage -> compact; drop under 90% of the lowest -> rearm", () => {
  const t = createCrossingTracker();
  const a = { id: "x", labels: {} };
  const p1 = t.decide(a, FLAG + 1, [FLAG, AUTO]);
  assert.equal(p1.action, "compact");
  assert.equal(p1.cap, FLAG);
  assert.deepEqual(p1.labels, { [COMPACT_STAGE_LABEL]: String(FLAG), [COMPACT_COUNT_LABEL]: "1" }); // a patch: compact-step adds vs.compacted-at
  t.record("x", p1.cap, p1.count);
  assert.equal(t.decide(a, FLAG + 9, [FLAG, AUTO]).action, "none"); // mem covers a snapshot without the label yet
  assert.equal(t.decide(a, 140_000, [FLAG, AUTO]).action, "none"); // inside the hysteresis band
  const p2 = t.decide(a, AUTO + 1, [FLAG, AUTO]);
  assert.deepEqual([p2.action, p2.cap, p2.count], ["compact", AUTO, 2]);
  t.record("x", p2.cap, p2.count);
  const re = t.decide(a, REARM_LINE - 1, [FLAG, AUTO]);
  assert.equal(re.action, "rearm");
  assert.deepEqual(re.labels, { [COMPACTED_AT]: "", [COMPACT_STAGE_LABEL]: "" }); // only the two keys: never the snapshot (count)
  t.rearm("x", re.count);
  assert.deepEqual(t.decide(a, FLAG, [FLAG, AUTO]).count, 3);
});

test("K2b r1 (Review-Gemini note 2): the post-compact ESTIMATE never re-arms; the next real reading decides", () => {
  const t = createCrossingTracker();
  const est = { id: "x", labels: {}, lastUsage: { contextWindowUsedTokens: 4_000, compactEstimate: true } };
  const p = t.decide(est, BUDDY_CAP + 1, [BUDDY_CAP]);
  t.record("x", p.cap, p.count);
  assert.equal(t.decide(est, 4_000, [BUDDY_CAP]).action, "none", "an estimate under the re-arm line does not re-arm");
  const real = { id: "x", labels: {}, lastUsage: { contextWindowUsedTokens: 4_000 } };
  assert.equal(t.decide(real, 4_000, [BUDDY_CAP]).action, "rearm", "a real reading under it does");
});

test("tracker: pre-K2c label (vs.compacted-at only) reads as one attempt at the lowest stage; life cap from the count label", () => {
  const t = createCrossingTracker();
  const legacy = { id: "x", labels: { [COMPACTED_AT]: "2026-11-20T00:00:00Z" } };
  assert.equal(t.decide(legacy, FLAG + 1, [FLAG, AUTO]).action, "none");
  assert.deepEqual(t.decide(legacy, AUTO + 1, [FLAG, AUTO]).count, 2);
  assert.equal(t.decide(legacy, 10_000, [FLAG, AUTO]).action, "rearm");
  const spent = { id: "y", labels: { [COMPACT_COUNT_LABEL]: String(COMPACT_LIFE_CAP) } };
  assert.deepEqual(t.decide(spent, FLAG + 1, [FLAG, AUTO]), { action: "life-cap", cap: FLAG, count: COMPACT_LIFE_CAP, labels: { [COMPACT_STAGE_LABEL]: String(FLAG) } });
});

// ---- lead ladder ----

test("lead: re-armed after the meter drops; the second crossing compacts again (no nudge, same id)", async () => {
  const { r, w } = setup("ok");
  r.agents.set("rn-l", lead("rn-l"));
  await step(r, "rn-l", FLAG + 5, 250);
  assert.equal(r.agents.get("rn-l").labels[COMPACT_COUNT_LABEL], "1");
  await step(r, "rn-l", 40_000); // the next turn's upsert, under the re-arm line
  const l = r.agents.get("rn-l").labels;
  assert.deepEqual([l[COMPACTED_AT], l[COMPACT_STAGE_LABEL], l[COMPACT_COUNT_LABEL]], ["", "", "1"]);
  await step(r, "rn-l", FLAG + 7, 250);
  assert.deepEqual(texts(r), ["/compact", "/compact"]);
  assert.equal(r.agents.get("rn-l").labels[COMPACT_COUNT_LABEL], "2");
  assert.ok(r.agents.get("rn-l").labels[COMPACTED_AT]);
  assert.equal(r.created.length, 0);
  w.stop();
});

test("lead: a compaction that lands inside the hysteresis band is not re-armed: the next crossing nudges", async () => {
  const { r, w } = setup("ok");
  r.okAfter = 140_000;
  r.agents.set("rn-l", lead("rn-l"));
  await step(r, "rn-l", FLAG + 5, 250);
  await step(r, "rn-l", 140_000);
  await step(r, "rn-l", FLAG + 7);
  assert.deepEqual(texts(r), ["/compact", "nudge"]);
  w.stop();
});

test("lead: a compaction attempt comes before each soft stage (150k nudge, 250k packet); each stage tried once per crossing", async () => {
  const { r, w } = setup("over");
  r.agents.set("rn-l", lead("rn-l"));
  await step(r, "rn-l", FLAG + 5, 250);
  assert.deepEqual(texts(r), ["/compact", "nudge"]);
  await step(r, "rn-l", FLAG + 9); // same crossing, same stage: no second attempt (loop guard)
  assert.deepEqual(texts(r), ["/compact", "nudge"]);
  await step(r, "rn-l", AUTO + 5, 250);
  assert.deepEqual(texts(r), ["/compact", "nudge", "/compact", "packet"]);
  assert.equal(r.agents.get("rn-l").labels[COMPACT_STAGE_LABEL], String(AUTO));
  await step(r, "rn-l", AUTO + 9);
  assert.equal(compacts(r).length, 2);
  w.stop();
});

test("lead: an ok compaction at the 250k stage skips the packet stage", async () => {
  const { r, w } = setup("over");
  r.agents.set("rn-l", lead("rn-l"));
  await step(r, "rn-l", FLAG + 5, 250); // still over -> nudge
  r.mode = "ok";
  r.okAfter = 200_000;
  r.agents.get("rn-l").lastUsage = { contextWindowUsedTokens: AUTO + 5, inputTokens: AUTO + 5 };
  const res = await w.evaluate({ ...r.agents.get("rn-l"), labels: { ...r.agents.get("rn-l").labels } });
  assert.equal(res.result.stage, "compact");
  assert.deepEqual(texts(r), ["/compact", "nudge", "/compact"]);
  w.stop();
});

test("lead: a failed compaction falls through to the unchanged nudge; not retried in the same crossing", async () => {
  const { r, w } = setup("fail");
  r.agents.set("rn-l", lead("rn-l"));
  await step(r, "rn-l", FLAG + 5, 200);
  assert.deepEqual(texts(r), ["/compact", "nudge"]);
  await step(r, "rn-l", FLAG + 6);
  await step(r, "rn-l", FLAG + 7);
  assert.equal(compacts(r).length, 1);
  assert.equal(r.agents.get("rn-l").labels[COMPACT_STAGE_LABEL], String(FLAG));
  w.stop();
});

test("lead: life cap -> hand off instead of a 6th compaction, logged reason=life-cap (not as a compact-step attempt)", async () => {
  const { r, w, laneLog } = setup("ok");
  r.agents.set("rn-l", lead("rn-l"));
  for (let i = 0; i < COMPACT_LIFE_CAP; i++) {
    await step(r, "rn-l", FLAG + 5, 250);
    await step(r, "rn-l", 40_000, 60);
  }
  assert.equal(compacts(r).length, COMPACT_LIFE_CAP);
  await step(r, "rn-l", FLAG + 5);
  await step(r, "rn-l", FLAG + 6);
  assert.equal(compacts(r).length, COMPACT_LIFE_CAP);
  assert.equal(texts(r).at(-1), "nudge");
  const capLines = laneLog().split("\n").filter((l) => l.includes("reason=life-cap"));
  assert.equal(capLines.length, 1); // once per crossing
  assert.match(capLines[0], new RegExp(`compact-life-cap lead agent=rn-l count=${COMPACT_LIFE_CAP} cap=${FLAG}`));
  assert.equal(laneLog().split("\n").filter((l) => l.includes("compact-step lead")).length, COMPACT_LIFE_CAP);
  w.stop();
});

test("lead: a busy skip (K2a: running or queued) defers to the next idle: no nudge, no stamp, no attempt counted", async () => {
  const outcomes = [{ outcome: "skipped", reason: "busy" }, { outcome: "ok", after: 40_000 }];
  const calls = [];
  const compactor = { tried: new Set(), run: async (agent, opts) => { calls.push({ labels: { ...agent.labels }, opts }); return outcomes.shift(); } };
  const { r, w } = setup("ok", { compactor });
  r.agents.set("rn-l", lead("rn-l"));
  r.agents.get("rn-l").lastUsage = { contextWindowUsedTokens: FLAG + 5, inputTokens: FLAG + 5 };
  const first = await w.evaluate({ ...r.agents.get("rn-l") });
  assert.equal(first.result.stage, "compact-deferred");
  assert.equal(r.sent.length, 0);
  assert.equal(r.labelWrites.length, 0);
  const second = await w.evaluate({ ...r.agents.get("rn-l") });
  assert.equal(second.result.stage, "compact");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.labels[COMPACT_COUNT_LABEL], "1"); // the busy skip did not count
  assert.equal(calls[1].opts.focus, LEAD_COMPACT_FOCUS);
  assert.equal(calls[1].opts.armed, true); // the crossing tracker is the loop guard (no tried/label workaround)
  assert.equal(calls[1].opts.hardCap, LEAD_HARD_CAP_DEFAULT);
  w.stop();
});

test("lead: the hard cap stays immediate on the raw meter, also when the crossing is armed or a compaction is busy", async () => {
  const compactor = { tried: new Set(), run: async () => ({ outcome: "skipped", reason: "busy" }) };
  const { r, w } = setup("ok", { compactor });
  r.agents.set("rn-l", { ...lead("rn-l"), status: "running" });
  await step(r, "rn-l", LEAD_HARD_CAP_DEFAULT + 1, 200);
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].labels["vs.handoff-trigger"], "hard-300");
  w.stop();
});

test("lead: a handoff already under way (packet prompted) is not compacted", async () => {
  const { r, w } = setup("ok");
  r.agents.set("rn-l", lead("rn-l", { "handoff-write-prompted": "1", "handoff-nudged": "1" }));
  await step(r, "rn-l", AUTO + 5);
  assert.equal(compacts(r).length, 0);
  w.stop();
});

test("lead: the stage write after a failed attempt keeps the attempt labels (runner merges labels; no stale clear)", async () => {
  const { r, w } = setup("fail");
  r.agents.set("rn-l", lead("rn-l", { [COMPACTED_AT]: "", [COMPACT_STAGE_LABEL]: "", [COMPACT_COUNT_LABEL]: "2" }));
  await step(r, "rn-l", FLAG + 5, 200);
  const l = r.agents.get("rn-l").labels;
  assert.ok(l[COMPACTED_AT]);
  assert.equal(l[COMPACT_STAGE_LABEL], String(FLAG));
  assert.equal(l[COMPACT_COUNT_LABEL], "3");
  assert.equal(l["handoff-nudged"], "1");
  w.stop();
});

// ---- Buddy path ----

test("buddy: re-armed after the meter drops (warn re-armed too); the second crossing updates the brief, then compacts, no restart", async () => {
  const { r, w, restarts } = setup("ok");
  r.agents.set("rn-b", buddy("rn-b"));
  await step(r, "rn-b", BUDDY_CAP + 1, 250);
  await step(r, "rn-b", 40_000);
  const l = r.agents.get("rn-b").labels;
  assert.deepEqual([l[COMPACT_STAGE_LABEL], l[WARN_LABEL]], ["", ""]);
  const rearmWrite = r.labelWrites.at(-1);
  assert.deepEqual(rearmWrite.labels, { [COMPACTED_AT]: "", [COMPACT_STAGE_LABEL]: "", [WARN_LABEL]: "" }); // a patch, no snapshot spread
  await step(r, "rn-b", BUDDY_CAP + 2, 100);
  assert.deepEqual(texts(r), ["/compact", BRAINSTORM_WARN_NUDGE]); // the brief is updated before this crossing's compaction
  r.emit({ kind: "turn_ended", agentId: "rn-b", agent: { ...r.agents.get("rn-b") } }); // the brief turn ends
  await step(r, "rn-b", BUDDY_CAP + 3, 250);
  assert.equal(compacts(r).length, 2);
  assert.equal(restarts.length, 0);
  w.stop();
});

test("buddy: no re-arm inside the hysteresis band -> the next crossing restarts", async () => {
  const { r, w, restarts } = setup("ok");
  r.okAfter = 140_000;
  r.agents.set("rn-b", buddy("rn-b"));
  await step(r, "rn-b", BUDDY_CAP + 1, 250);
  await step(r, "rn-b", 140_000);
  await step(r, "rn-b", BUDDY_CAP + 2);
  assert.equal(compacts(r).length, 1);
  assert.equal(restarts.length, 1);
  w.stop();
});

// K2b r1: agy's meter after /compact is the adapter's estimate (the summary) until the next real turn. A compaction that did not
// shrink the session must not re-arm on that estimate and compact again at the next turn: the real reading restarts instead.
const estimate = (r, id, tokens) => {
  const a = r.agents.get(id);
  a.lastUsage = { contextWindowUsedTokens: tokens, inputTokens: tokens, compactEstimate: true };
  r.emit({ kind: "agent", agent: { ...a, labels: { ...a.labels } } });
};
test("K2b r1: agy Buddy: the post-compact estimate does not re-arm; a still-over real reading restarts (no 2nd /compact)", async () => {
  const { r, w, restarts } = setup("ok");
  r.okAfter = 4_000;
  r.agents.set("rn-b", { ...buddy("rn-b"), provider: "antigravity-cli" });
  await step(r, "rn-b", BUDDY_CAP + 1, 250);
  assert.equal(compacts(r).length, 1);
  const writes = r.labelWrites.length;
  estimate(r, "rn-b", 4_000);
  await tick(100);
  assert.equal(r.labelWrites.length, writes, "no re-arm write on the estimate");
  assert.equal(r.agents.get("rn-b").labels[COMPACT_STAGE_LABEL], String(BUDDY_CAP));
  await step(r, "rn-b", BUDDY_CAP + 2);
  assert.equal(compacts(r).length, 1, "this crossing was tried: no second /compact");
  assert.equal(restarts.length, 1);
  w.stop();
});

test("K2b r1: agy lead: the post-compact estimate does not re-arm; a still-over real reading nudges (no 2nd /compact)", async () => {
  const { r, w } = setup("ok");
  r.okAfter = 4_000;
  r.agents.set("rn-l", { ...lead("rn-l"), provider: "antigravity-cli" });
  const AGY = 35_000; // lead-handoff PROVIDER_PREAMBLE_TOKENS: the agy lead ladder runs on working tokens
  await step(r, "rn-l", FLAG + AGY + 5, 250);
  assert.equal(compacts(r).length, 1);
  estimate(r, "rn-l", 4_000);
  await tick(100);
  assert.equal(r.agents.get("rn-l").labels[COMPACT_STAGE_LABEL], String(FLAG), "not re-armed on the estimate");
  await step(r, "rn-l", FLAG + AGY + 7, 250);
  assert.deepEqual(texts(r), ["/compact", "nudge"]);
  w.stop();
});

test("buddy: a failed compaction falls through to the restart; not retried", async () => {
  const { r, w, restarts } = setup("fail");
  r.agents.set("rn-b", buddy("rn-b"));
  await step(r, "rn-b", BUDDY_CAP + 1, 200);
  assert.equal(compacts(r).length, 1);
  assert.equal(restarts.length, 1);
  w.stop();
});

test("buddy: life cap -> restart, logged reason=life-cap", async () => {
  const { r, w, restarts, laneLog } = setup("ok");
  r.agents.set("rn-b", buddy("rn-b", { [COMPACT_COUNT_LABEL]: String(COMPACT_LIFE_CAP) }));
  await step(r, "rn-b", BUDDY_CAP + 1);
  assert.equal(compacts(r).length, 0);
  assert.equal(restarts.length, 1);
  assert.match(laneLog(), new RegExp(`compact-life-cap buddy agent=rn-b count=${COMPACT_LIFE_CAP} cap=${BUDDY_CAP}.*reason=life-cap`));
  w.stop();
});

test("buddy: a busy skip defers (no restart, not counted); the next idle compacts", async () => {
  const outcomes = [{ outcome: "skipped", reason: "busy" }, { outcome: "ok", after: 40_000 }];
  const calls = [];
  const compactor = { tried: new Set(), run: async (_agent, opts) => { calls.push({ ...opts.labels }); return outcomes.shift(); } };
  const { r, w, restarts } = setup("ok", { compactor });
  r.agents.set("rn-b", buddy("rn-b"));
  await step(r, "rn-b", BUDDY_CAP + 1);
  assert.equal(restarts.length, 0);
  await step(r, "rn-b", BUDDY_CAP + 2);
  assert.equal(restarts.length, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][COMPACT_COUNT_LABEL], "1");
  w.stop();
});

// ---- K2a+K2c fix round ----

test("tracker: re-arm needs a real drop -- 25% under the tried stage as well as under 90% of the lowest stage", () => {
  const t = createCrossingTracker();
  const a = { id: "x", labels: {} };
  t.record("x", FLAG, 1);
  assert.equal(t.decide(a, 130_000, [FLAG, AUTO]).action, "none"); // 150k -> 130k: under 135k but not a 25% drop
  assert.equal(t.decide(a, 113_000, [FLAG, AUTO]).action, "none");
  assert.equal(t.decide(a, 112_000, [FLAG, AUTO]).action, "rearm"); // < 112.5k
  t.record("y", AUTO, 2);
  assert.equal(t.decide({ id: "y", labels: {} }, 134_000, [FLAG, AUTO]).action, "rearm"); // 250k stage: the 135k line binds
});

test("lead: an ok compaction clears the stale 150k soft flag (needs-you trio, handoff-nudged/-flagged, flagged150); the next crossing nudges again", async () => {
  const { r, w } = setup("over");
  r.agents.set("rn-l", lead("rn-l"));
  await step(r, "rn-l", FLAG + 5, 250); // still over -> nudge + needs-you
  assert.equal(r.agents.get("rn-l").labels["needs-you"], SOFT_FLAG_REASON);
  r.mode = "ok";
  await step(r, "rn-l", AUTO + 5, 250); // 250k stage compacts ok
  let l = r.agents.get("rn-l").labels;
  assert.deepEqual([l["needs-you"], l["needs-you-reason"], l["needs-you-at"], l["handoff-nudged"], l["handoff-flagged"]], ["", "", "", "", ""]);
  assert.equal(w.coordinator.state.flagged150.has("rn-l"), false);
  await step(r, "rn-l", 40_000); // re-arm
  r.mode = "over";
  await step(r, "rn-l", FLAG + 7, 250);
  assert.deepEqual(texts(r), ["/compact", "nudge", "/compact", "/compact", "nudge"]);
  w.stop();
});

test("lead: re-arm clears the soft flag too, but never an owner-facing needs-you that is not the soft flag's", async () => {
  const { r, w } = setup("ok");
  r.agents.set("rn-l", lead("rn-l", { [COMPACT_STAGE_LABEL]: String(FLAG), [COMPACT_COUNT_LABEL]: "1", "handoff-nudged": "1", "needs-you": SOFT_FLAG_REASON, "needs-you-reason": SOFT_FLAG_REASON }));
  r.agents.set("rn-m", lead("rn-m", { [COMPACT_STAGE_LABEL]: String(FLAG), [COMPACT_COUNT_LABEL]: "1", "handoff-nudged": "1", "needs-you": "pick a schema", ord: "2" }));
  await step(r, "rn-l", 40_000);
  await step(r, "rn-m", 40_000);
  assert.deepEqual([r.agents.get("rn-l").labels["needs-you"], r.agents.get("rn-l").labels["handoff-nudged"]], ["", ""]);
  assert.deepEqual([r.agents.get("rn-m").labels["needs-you"], r.agents.get("rn-m").labels["handoff-nudged"]], ["pick a schema", ""]);
  const rearm = r.labelWrites.find((x) => x.id === "rn-m").labels;
  assert.equal(COMPACT_COUNT_LABEL in rearm, false); // a patch: the count is never written back from a snapshot
  w.stop();
});

test("lead: a compaction in flight (shared pending) defers another coordinator's soft stages; the hard cap still acts", async () => {
  const { r, w } = setup("ok");
  r.agents.set("rn-l", lead("rn-l"));
  const pending = new Set(["rn-l"]);
  const http = createLeadHandoffCoordinator({
    rootDir: process.env.VIBESQUAD_ROOT, baseHome: process.env.VIBESQUAD_HOME, compactPending: pending,
    usageProviders: () => [],
    setLabels: (id, labels) => r.updateAgent(id, { labels }), sendMessage: (id, text) => r.sendAgentPrompt(id, text),
    createAgent: (p) => r.createAgent(p), listAgents: async () => [...r.agents.values()], getAgent: async (id) => r.agents.get(id) ?? null,
    deleteHeartbeat: async () => {},
  });
  const res = await http.evaluateLead({ ...r.agents.get("rn-l"), lastUsage: { contextWindowUsedTokens: FLAG + 5 } });
  assert.equal(res.stage, "compact-deferred");
  assert.equal(r.sent.length, 0);
  const hard = await http.evaluateLead({ ...r.agents.get("rn-l"), lastUsage: { contextWindowUsedTokens: LEAD_HARD_CAP_DEFAULT + 1 } });
  assert.equal(hard.stage, "hard-300");
  assert.equal(r.created.length, 1);
  w.stop();
});

test("lead: a self handoff through another coordinator (shared slot maps) is under way: no compaction", async () => {
  resetLeadHandoffState();
  const { r, w } = setup("ok");
  r.agents.set("rn-l", lead("rn-l"));
  const http = createLeadHandoffCoordinator({
    rootDir: process.env.VIBESQUAD_ROOT, baseHome: process.env.VIBESQUAD_HOME, sharedSlots: true,
    usageProviders: () => [],
    setLabels: (id, labels) => r.updateAgent(id, { labels }), sendMessage: (id, text) => r.sendAgentPrompt(id, text),
    createAgent: (p) => r.createAgent({ ...p, labels: p.labels }), listAgents: async () => [...r.agents.values()], getAgent: async (id) => r.agents.get(id) ?? null,
    deleteHeartbeat: async () => {},
  });
  const res = await http.triggerSelfHandoff(r.agents.get("rn-l"));
  assert.equal(res.ok, true, JSON.stringify(res));
  await step(r, "rn-l", FLAG + 5, 200);
  assert.equal(compacts(r).length, 0);
  w.stop();
  resetLeadHandoffState();
});

test("lead: a compaction stopped at the hard cap (reason=hard-cap) hands off in the same evaluation", async () => {
  const compactor = { tried: new Set(), run: async () => ({ outcome: "failed", reason: "hard-cap", rawUsed: LEAD_HARD_CAP_DEFAULT + 10 }) };
  const { r, w } = setup("ok", { compactor });
  r.agents.set("rn-l", lead("rn-l"));
  r.agents.get("rn-l").lastUsage = { contextWindowUsedTokens: AUTO + 5, inputTokens: AUTO + 5 };
  const res = await w.evaluate({ ...r.agents.get("rn-l") });
  assert.equal(res.result.stage, "hard-300");
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].labels["vs.handoff-trigger"], "hard-300");
  w.stop();
});

test("life cap: vs.compact-stage persisted, so a server restart does not log the same crossing's life-cap line again", async () => {
  const { r, w, restarts, laneLog } = setup("ok");
  r.agents.set("rn-b", buddy("rn-b", { [COMPACT_COUNT_LABEL]: String(COMPACT_LIFE_CAP) }));
  await step(r, "rn-b", BUDDY_CAP + 1);
  assert.equal(r.agents.get("rn-b").labels[COMPACT_STAGE_LABEL], String(BUDDY_CAP));
  w.stop();
  const w2 = startTokenWatcher({ runner: r, rootDir: process.env.VIBESQUAD_ROOT, baseHome: process.env.VIBESQUAD_HOME, compactor: createCompactor({ runner: r }), restartBuddy: async (b) => { restarts.push(b); } });
  await step(r, "rn-b", BUDDY_CAP + 2);
  assert.equal(laneLog().split("\n").filter((x) => x.includes("reason=life-cap")).length, 1);
  w2.stop();
});
