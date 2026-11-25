// idea-162 (unit-worker-context-guard): the worker rung of the context ladder. Leads have lead-handoff.mjs evaluateLead, Buddies
// token-watch.mjs evaluateBuddy; workers (incl. digest workers and reviewers) get a soft wrap-up nudge + lead ping and, while still
// running past the hard mark in the same episode, one "respawn fresh now" ping to the lead. Each mark fires at most once per worker,
// across restarts. P0 fix round: only fresh usage from a turn that is live now; the startup / backfill pass and idle, queued, closed
// or archived workers never get an input and never cause a lead ping.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startTokenWatcher, BRAINSTORM_WARN_NUDGE } from "../server/token-watch.mjs";
import { LEAD_AUTO_HANDOFF_DEFAULT, LEAD_FLAG_DEFAULT, SOFT_FLAG_NUDGE } from "../server/lead-handoff.mjs";
import {
  WORKER_HARD_DEFAULT,
  WORKER_SOFT_DEFAULT,
  WORKER_WIP_DEFAULT,
  WORKER_WIP_NUDGE,
  WORKER_WRAP_NUDGE,
  createWorkerContextGuard,
  loadWorkerThresholds,
  workerGuardMarksPath,
} from "../server/worker-context-guard.mjs";

process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";

const tick = () => new Promise((r) => setTimeout(r, 15));

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });

/** Fake RunnerBackend. fetchAgent answers the runner's status NOW (the map); emitted snapshots may differ (a replay). */
function makeRunner() {
  const agents = new Map();
  const sent = [];
  const cancelled = [];
  const timelines = new Map();
  const listeners = new Set();
  const failSendTo = new Set();
  const dropSteerTo = new Set(); // the runner answers a steerOnly send with { delivered: false } (its turn ended first)
  return {
    agents,
    sent,
    cancelled,
    timelines,
    failSendTo,
    dropSteerTo,
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
    async sendAgentPrompt(id, text, opts = {}) {
      if (failSendTo.has(id)) throw new Error(`send to ${id} failed`);
      if (opts.steerOnly && dropSteerTo.has(id)) return { queued: false, delivered: false, reason: "idle" };
      sent.push({ id, text, ...(opts.steerOnly ? { steerOnly: true } : {}) });
      return opts.steerOnly ? { queued: false, delivered: true, steer: true } : undefined;
    },
    async createAgent() {
      throw new Error("the worker guard must never spawn");
    },
    async cancelAgent(id) {
      cancelled.push(id);
    },
    async archiveAgent(id) {
      cancelled.push(`archive:${id}`);
    },
    async fetchAgent(id) {
      return { agent: agents.get(id) };
    },
    async fetchAgentTimeline(id) {
      return { entries: (timelines.get(id) ?? []).map((text, i) => ({ seqStart: i, item: { type: "assistant_message", text } })) };
    },
    async deleteHeartbeat() {},
    usage(id, tokens, patch = {}) {
      const a = agents.get(id);
      Object.assign(a, patch);
      a.lastUsage = { contextWindowUsedTokens: tokens, inputTokens: tokens };
      this.emit({ kind: "agent", agent: { ...a, labels: { ...a.labels } } });
    },
    /** The startup / reconnect seed (runner-backend seedRoster / seedListener). */
    roster() {
      this.emit({ kind: "roster", agents: [...agents.values()].map((a) => ({ ...a, labels: { ...a.labels } })) });
    },
    /** A snapshot as the event saw it, which may differ from the runner's status now (catch-up replay). */
    emitAgent(snapshot) {
      this.emit({ kind: "agent", agent: snapshot });
    },
  };
}

function makeEnv(teamsExtra = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), "vs-wcg-root-")); tmpDirs.push(rootDir);
  mkdirSync(join(rootDir, "docs", "brainstorm"), { recursive: true });
  writeFileSync(
    join(rootDir, "teams.json"),
    JSON.stringify({ teams: [{ id: "t", name: "T", lanes: [{ id: "l", name: "L" }, { id: "m", name: "M" }] }], ...teamsExtra }),
  );
  process.env.VIBESQUAD_ROOT = rootDir;
  const home = mkdtempSync(join(tmpdir(), "vs-wcg-home-")); tmpDirs.push(home);
  process.env.VIBESQUAD_HOME = home;
  return { rootDir, home };
}

const lead = (id, lane = "l") => ({ id, title: "★ L1", status: "idle", cwd: "/x", createdAt: "2026-11-11T00:00:00Z", labels: { role: "lead", team: "t", lane, ord: "1" } });
const buddy = (id) => ({ id, title: "Buddy", status: "idle", labels: { role: "brainstorm", team: "t", lane: "l" } });
const worker = (id, labels = {}, extra = {}) => ({ id, title: `W-${id}`, status: "running", labels: { role: "worker", team: "t", lane: "l", "vs.parent": "rn-lead", ...labels }, ...extra });
const idleOver = (id, tokens, extra = {}) => worker(id, {}, { status: "idle", lastUsage: { contextWindowUsedTokens: tokens }, ...extra });

const to = (r, id) => r.sent.filter((s) => s.id === id);
const metrics = (home) => {
  const f = join(home, "teams", "t", "log.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === "metric") : [];
};

test("thresholds: wip 120k + same constant family as the lead ladder (soft 150k / hard 250k), team and top-level overridable", () => {
  assert.equal(WORKER_WIP_DEFAULT, 120_000);
  assert.equal(WORKER_SOFT_DEFAULT, LEAD_FLAG_DEFAULT);
  assert.equal(WORKER_HARD_DEFAULT, LEAD_AUTO_HANDOFF_DEFAULT);
  const { rootDir } = makeEnv({ workerWipTokens: 100_000, workerSoftTokens: 120_000 });
  assert.deepEqual(loadWorkerThresholds(worker("w"), rootDir), { wipTokens: 100_000, softTokens: 120_000, hardTokens: 250_000 });
  writeFileSync(join(rootDir, "teams.json"), JSON.stringify({ workerWipTokens: 100_000, workerSoftTokens: 120_000, teams: [{ id: "t", workerWipTokens: 80_000, workerHardTokens: 200_000, workerSoftTokens: 90_000, lanes: [{ id: "l" }] }] }));
  assert.deepEqual(loadWorkerThresholds(worker("w"), rootDir), { wipTokens: 80_000, softTokens: 90_000, hardTokens: 200_000 });
});

test("P0: the startup / backfill pass over idle, queued, errored, closed and archived over-threshold workers sends 0 inputs and 0 lead pings", async () => {
  const { rootDir, home } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  const idle = [];
  for (const [i, tokens] of [158_000, 210_000, 300_000, 870_000].entries()) {
    r.agents.set(`rn-idle${i}`, idleOver(`rn-idle${i}`, tokens));
    idle.push(`rn-idle${i}`);
  }
  r.agents.set("rn-queued", idleOver("rn-queued", 400_000, { status: "initializing", queued: { ahead: 1 } }));
  r.agents.set("rn-err", idleOver("rn-err", 400_000, { status: "error" }));
  r.agents.set("rn-closed", idleOver("rn-closed", 400_000, { status: "closed" }));
  r.agents.set("rn-closed-res", idleOver("rn-closed-res", 400_000, { status: "closed", resumable: true }));
  r.agents.set("rn-arch", idleOver("rn-arch", 400_000, { archivedAt: "2026-11-11T00:00:00Z" }));
  r.agents.set("rn-running-old", idleOver("rn-running-old", 500_000, { status: "running" })); // running at startup: the seed count is old data too
  const w = startTokenWatcher({ runner: r, rootDir });
  r.roster();
  await tick();
  r.roster(); // a reconnect re-seeds the same roster
  await tick();
  // Stale upserts after startup (a label write, a meta event): same counts, nothing live.
  for (const id of [...idle, "rn-queued", "rn-err", "rn-closed", "rn-closed-res", "rn-arch", "rn-running-old"]) {
    const a = r.agents.get(id);
    r.emitAgent({ ...a, labels: { ...a.labels, job: "x" } });
  }
  await tick();
  w.stop();
  assert.deepEqual(r.sent, [], "no input to any worker and no lead ping");
  const marks = JSON.parse(readFileSync(workerGuardMarksPath(home), "utf8"));
  for (const id of idle) assert.equal(typeof marks[id]?.seen?.tokens, "number", `${id} marked seen`);
  for (const id of ["rn-closed", "rn-closed-res", "rn-arch"]) assert.equal(marks[id], undefined, `${id} untouched`);
  assert.equal(metrics(home).filter((e) => /worker-context/.test(e.text)).length, 0);
});

test("P0: a catch-up replay whose snapshot reads running for a turn the runner says is over sends nothing", async () => {
  const { rootDir } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", idleOver("rn-w", 100_000)); // the runner's status now: idle
  const w = startTokenWatcher({ runner: r, rootDir });
  r.roster();
  await tick();
  const a = r.agents.get("rn-w");
  r.emitAgent({ ...a, status: "running", lastUsage: { contextWindowUsedTokens: 180_000 } }); // replayed usage from a past turn
  await tick();
  r.emitAgent({ ...a, status: "running", lastUsage: { contextWindowUsedTokens: 260_000 } });
  await tick();
  w.stop();
  assert.deepEqual(r.sent, []);
});

test("P0: an idle (or queued) worker over the line never gets an input, even on fresh usage readings", async () => {
  const { rootDir } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w", {}, { status: "idle" }));
  const w = startTokenWatcher({ runner: r, rootDir });
  for (const t of [160_000, 170_000, 260_000, 900_000]) {
    r.usage("rn-w", t, { status: "idle" });
    await tick();
  }
  r.usage("rn-w", 910_000, { status: "initializing", queued: { ahead: 0 } });
  await tick();
  w.stop();
  assert.deepEqual(r.sent, []);
});

test("P0: a running worker crossing 150k gets exactly one wrap-up and its lead exactly one ping, plus one metric line", async () => {
  const { rootDir, home } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  const w = startTokenWatcher({ runner: r, rootDir });
  r.roster();
  for (const t of [90_000, 110_000, 151_000, 151_000, 155_000, 170_000, 200_000]) {
    r.usage("rn-w", t);
    await tick();
  }
  w.stop();
  assert.deepEqual(to(r, "rn-w").map((s) => s.text), [WORKER_WRAP_NUDGE]);
  const leadMsgs = to(r, "rn-lead").map((s) => s.text);
  assert.equal(leadMsgs.length, 1);
  assert.match(leadMsgs[0], /W-rn-w \(rn-w\) at 151k: wrapping; spawn a fresh worker from its final note/);
  const m = metrics(home).filter((e) => /worker-context/.test(e.text));
  assert.equal(m.length, 1);
  assert.match(m[0].text, /worker-context soft rn-w 151k/);
  assert.deepEqual(r.cancelled, []);
});

test("P0: a worker woken by someone else, then running, crosses the line correctly (a seen-at-startup one only on fresh usage)", async () => {
  const { rootDir } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-a", idleOver("rn-a", 100_000));
  r.agents.set("rn-b", idleOver("rn-b", 870_000));
  const w = startTokenWatcher({ runner: r, rootDir });
  r.roster();
  await tick();
  assert.equal(r.sent.length, 0);
  // The lead sends rn-a a follow-up: its turn runs and grows past 120k (WIP) and 150k (soft).
  r.usage("rn-a", 100_000, { status: "running" });
  await tick();
  r.usage("rn-a", 119_000);
  await tick();
  assert.equal(r.sent.length, 0);
  r.usage("rn-a", 152_000);
  await tick();
  assert.deepEqual(to(r, "rn-a").map((s) => s.text), [WORKER_WRAP_NUDGE]);
  // rn-b was seen idle at 870k: an upsert that only flips its status re-carries the old count (stale); the turn's own usage is fresh.
  r.usage("rn-b", 870_000, { status: "running" });
  await tick();
  assert.equal(to(r, "rn-b").length, 0, "stale count: nothing");
  r.usage("rn-b", 872_000);
  await tick();
  w.stop();
  assert.deepEqual(to(r, "rn-b").map((s) => s.text), [WORKER_WRAP_NUDGE]);
  const leadMsgs = to(r, "rn-lead").map((s) => s.text);
  assert.equal(leadMsgs.length, 3, "rn-a wrapping; rn-b wrapping + respawn (running past hard in the episode its soft fired in)");
  assert.match(leadMsgs[0], /rn-a\) at 152k: wrapping/);
  assert.match(leadMsgs[1], /rn-b\) at 872k: wrapping/);
  assert.match(leadMsgs[2], /rn-b\) at 872k and still running: respawn fresh now/);
});

test("hard while running, same episode: one 'respawn fresh now' to the lead carrying the last message; never cancels or respawns", async () => {
  const { rootDir } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  r.timelines.set("rn-w", ["older note", "Done: A. Left: B. Branch unit-x @ abc123. Next: C."]);
  const w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 1);
  await tick();
  assert.equal(to(r, "rn-lead").length, 1);
  r.usage("rn-w", WORKER_HARD_DEFAULT + 2_000);
  await tick();
  r.usage("rn-w", WORKER_HARD_DEFAULT + 4_000);
  await tick();
  w.stop();
  const leadMsgs = to(r, "rn-lead").map((s) => s.text);
  assert.equal(leadMsgs.length, 2);
  assert.match(leadMsgs[1], /W-rn-w \(rn-w\) at 252k and still running: respawn fresh now/);
  assert.match(leadMsgs[1], /Branch unit-x @ abc123/);
  assert.doesNotMatch(leadMsgs[1], /older note/);
  assert.equal(to(r, "rn-w").length, 1, "the worker gets only the soft wrap-up");
  assert.deepEqual(r.cancelled, []);
});

test("hard needs the soft rung in the SAME running episode: soft, idle, then a new turn past hard pings nobody", async () => {
  const { rootDir } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  const w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 1);
  await tick();
  assert.equal(r.sent.length, 2);
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 2, { status: "idle" });
  r.emit({ kind: "turn_ended", agentId: "rn-w", turnId: "9", outcome: { kind: "completed" } });
  await tick();
  r.usage("rn-w", WORKER_HARD_DEFAULT + 1, { status: "idle" }); // idle past hard: no input, no ping
  await tick();
  r.usage("rn-w", WORKER_HARD_DEFAULT + 5_000, { status: "running" }); // the lead woke it: a new episode, soft already spent
  await tick();
  r.usage("rn-w", WORKER_HARD_DEFAULT + 9_000);
  await tick();
  w.stop();
  assert.equal(r.sent.length, 2, "no hard ping without a soft rung in this episode");
});

test("turn_ended ends the episode even when the idle upsert was dropped (busy): the next turn past hard pings nobody", async () => {
  const { rootDir } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  const w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 1);
  await tick();
  r.emit({ kind: "turn_ended", agentId: "rn-w", turnId: "9", outcome: { kind: "completed" } }); // no idle upsert seen
  r.usage("rn-w", WORKER_HARD_DEFAULT + 1);
  await tick();
  w.stop();
  assert.equal(r.sent.length, 2);
});

test("a worker that jumps straight past hard while running gets the soft wrap-up and the lead both pings, once", async () => {
  const { rootDir } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  const w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", 260_000);
  await tick();
  r.usage("rn-w", 270_000);
  await tick();
  w.stop();
  assert.equal(to(r, "rn-w").length, 1);
  const leadMsgs = to(r, "rn-lead").map((s) => s.text);
  assert.equal(leadMsgs.length, 2);
  assert.match(leadMsgs[0], /wrapping/);
  assert.match(leadMsgs[1], /respawn fresh now/);
});

test("restart: fired marks persist under VIBESQUAD_HOME (temp+rename), so a new watcher never repeats a mark", async () => {
  const { rootDir, home } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  r.agents.set("rn-w2", worker("rn-w2"));
  let w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 1);
  r.usage("rn-w2", WORKER_SOFT_DEFAULT + 1);
  await tick();
  r.usage("rn-w2", WORKER_HARD_DEFAULT + 1);
  await tick();
  w.stop();
  assert.equal(r.sent.length, 5, "w: wrap + ping; w2: wrap + ping + hard ping");
  const file = workerGuardMarksPath(home);
  assert.equal(file, join(home, "worker-context-guard.json"));
  const marks = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(marks["rn-w"]?.soft, "soft mark persisted");
  assert.equal(marks["rn-w"].hard, undefined);
  assert.ok(marks["rn-w2"]?.hard, "hard mark persisted");
  assert.deepEqual(readdirSync(home).filter((f) => f.endsWith(".tmp")), [], "no temp file left behind");

  w = startTokenWatcher({ runner: r, rootDir }); // server restart: empty memory, same home
  r.roster();
  await tick();
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 3_000);
  r.usage("rn-w2", WORKER_HARD_DEFAULT + 3_000);
  await tick();
  // rn-w crosses hard after the restart: its soft fired in the previous process, so this episode never saw it (fails quiet).
  r.usage("rn-w", WORKER_HARD_DEFAULT + 1);
  await tick();
  w.stop();
  assert.equal(r.sent.length, 5, "no repeat of either mark after a restart");
});

test("leads, Buddies and Overlords keep their own ladders (roster pass included); the worker guard never touches them", async () => {
  const { rootDir, home } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-buddy", buddy("rn-buddy"));
  r.agents.set("rn-ovl", { ...lead("rn-ovl", "vibesquad"), labels: { role: "lead", team: "t", lane: "vibesquad", ord: "9" } });
  const w = startTokenWatcher({ runner: r, rootDir, compactor: { run: async () => ({ outcome: "skipped", reason: "not-claude" }), tried: new Set() } });
  r.usage("rn-lead", LEAD_FLAG_DEFAULT + 10);
  r.usage("rn-ovl", LEAD_FLAG_DEFAULT + 10);
  r.usage("rn-buddy", 90_000);
  await tick();
  r.roster();
  await tick();
  w.stop();
  assert.deepEqual(to(r, "rn-lead").map((s) => s.text), [SOFT_FLAG_NUDGE]);
  assert.deepEqual(to(r, "rn-ovl").map((s) => s.text), [SOFT_FLAG_NUDGE]);
  assert.deepEqual(to(r, "rn-buddy").map((s) => s.text), [BRAINSTORM_WARN_NUDGE]);
  assert.ok(!r.sent.some((s) => s.text === WORKER_WRAP_NUDGE));
  assert.equal(existsSync(workerGuardMarksPath(home)), false);

  const guard = createWorkerContextGuard({ rootDir, sendMessage: async () => assert.fail("must not send"), currentStatus: async () => "running" });
  for (const a of [lead("x1"), buddy("x2"), { ...lead("x3"), labels: { role: "former-lead", team: "t", lane: "l" } }]) {
    a.status = "running";
    a.lastUsage = { contextWindowUsedTokens: 400_000 };
    assert.equal((await guard.evaluateWorker(a)).stage, "skip");
    assert.equal(guard.observeWorker(a).stage, "skip");
  }
});

test("digest workers and reviewers are workers: both get the guard", async () => {
  const { rootDir } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-dig", worker("rn-dig", { role: "digest", digestFor: "rn-w" }));
  r.agents.set("rn-rev", worker("rn-rev", { profile: "Review - Gemini" }));
  const w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-dig", WORKER_SOFT_DEFAULT + 1);
  r.usage("rn-rev", WORKER_SOFT_DEFAULT + 1);
  await tick();
  w.stop();
  assert.deepEqual(to(r, "rn-dig").map((s) => s.text), [WORKER_WRAP_NUDGE]);
  assert.deepEqual(to(r, "rn-rev").map((s) => s.text), [WORKER_WRAP_NUDGE]);
  assert.equal(to(r, "rn-lead").length, 2);
});

test("closed or archived workers never trigger (including closed-but-resumable), whatever the runner says", async () => {
  const { rootDir, home } = makeEnv();
  const sent = [];
  const guard = createWorkerContextGuard({
    rootDir,
    sendMessage: async (id, text) => sent.push({ id, text }),
    listAgents: async () => [lead("rn-lead")],
    currentStatus: async () => "running",
  });
  const big = { lastUsage: { contextWindowUsedTokens: 300_000 } };
  for (const a of [
    worker("c1", {}, { ...big, status: "closed" }),
    worker("c2", {}, { ...big, status: "closed", resumable: true }),
    worker("c3", {}, { ...big, archivedAt: "2026-11-11T00:00:00Z" }),
  ]) {
    assert.equal((await guard.evaluateWorker(a)).stage, "skip", a.id);
    assert.equal(guard.observeWorker(a).stage, "skip", a.id);
  }
  assert.deepEqual(sent, []);
  assert.equal(existsSync(workerGuardMarksPath(home)), false);
});

test("an unknown or absent token count never triggers", async () => {
  const { rootDir, home } = makeEnv();
  const sent = [];
  const guard = createWorkerContextGuard({ rootDir, sendMessage: async (id, text) => sent.push({ id, text }), listAgents: async () => [], currentStatus: async () => "running" });
  for (const extra of [
    {},
    { lastUsage: {} },
    { lastUsage: { contextWindowUsedTokens: Number.NaN, inputTokens: null } },
    { contextUsage: { usedTokens: "lots" } },
    { usedTokens: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal((await guard.evaluateWorker(worker("u", {}, extra))).stage, "none", JSON.stringify(extra));
  }
  assert.deepEqual(sent, []);
  assert.equal(existsSync(workerGuardMarksPath(home)), false);
});

test("lead lookup: parent when it is a live lead, else the lane's `vs who lead`; no lead still nudges the worker and logs it", async () => {
  const { rootDir, home } = makeEnv();
  const sent = [];
  const agents = [
    lead("rn-lead-l"),
    lead("rn-lead-m", "m"),
    { ...lead("rn-old"), labels: { role: "former-lead", team: "t", lane: "l" } },
  ];
  const guard = createWorkerContextGuard({
    rootDir,
    sendMessage: async (id, text) => sent.push({ id, text }),
    listAgents: async () => agents,
    getAgent: async (id) => agents.find((a) => a.id === id) ?? null,
    lastMessage: async () => "",
    currentStatus: async () => "running",
  });
  const used = { lastUsage: { contextWindowUsedTokens: WORKER_SOFT_DEFAULT } };
  await guard.evaluateWorker(worker("a", { "vs.parent": "rn-lead-m" }, used)); // parent lead wins (it may sit in another lane)
  await guard.evaluateWorker(worker("b", { "vs.parent": "rn-old" }, used)); // retired parent -> lane lead
  await guard.evaluateWorker(worker("c", { "vs.parent": "" }, used));
  await guard.evaluateWorker(worker("d", { lane: "nolane", "vs.parent": "" }, used)); // no lead anywhere
  const leadIds = sent.filter((s) => s.text !== WORKER_WRAP_NUDGE).map((s) => s.id);
  assert.deepEqual(leadIds, ["rn-lead-m", "rn-lead-l", "rn-lead-l"]);
  assert.equal(sent.filter((s) => s.text === WORKER_WRAP_NUDGE).length, 4);
  assert.ok(metrics(home).some((e) => /worker-context soft d 150k .*lead=none/.test(e.text)));
});

test("a failed worker send is not marked (the next fresh usage event retries); a failed lead ping does not re-nudge the worker", async () => {
  const { rootDir, home } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  r.failSendTo.add("rn-w");
  const w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 1);
  await tick();
  assert.equal(r.sent.length, 0);
  const file = workerGuardMarksPath(home);
  assert.equal(existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))["rn-w"] : undefined, undefined, "rolled back");
  r.failSendTo.delete("rn-w");
  r.failSendTo.add("rn-lead");
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 2);
  await tick();
  r.failSendTo.delete("rn-lead");
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 3);
  await tick();
  w.stop();
  assert.deepEqual(to(r, "rn-w").map((s) => s.text), [WORKER_WRAP_NUDGE]);
  assert.equal(to(r, "rn-lead").length, 0);
});

test("idea-169: the wrap-up goes out steer-only (it can never start a turn); lead pings stay plain sends that wake the lead", async () => {
  const { rootDir } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  const w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", WORKER_HARD_DEFAULT + 1);
  await tick();
  w.stop();
  assert.deepEqual(to(r, "rn-w"), [{ id: "rn-w", text: WORKER_WRAP_NUDGE, steerOnly: true }]);
  const pings = to(r, "rn-lead");
  assert.equal(pings.length, 2, "soft + hard lead pings");
  assert.ok(pings.every((p) => !p.steerOnly), "lead pings are plain sends");
});

test("idea-169: a dropped steer-only wrap-up still fires the soft rung: lead pinged (nudge not delivered), mark kept, no worker re-nudge", async () => {
  const { rootDir, home } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  r.dropSteerTo.add("rn-w");
  const w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 1);
  await tick();
  assert.deepEqual(to(r, "rn-w"), [], "dropped nudge: no input reached the worker");
  const pings = to(r, "rn-lead");
  assert.equal(pings.length, 1, "the lead still gets the soft ping");
  assert.ok(!pings[0].steerOnly, "the lead ping is a plain send");
  assert.match(pings[0].text, /W-rn-w \(rn-w\) at 150k: wrap-up nudge not delivered \(idle\); spawn a fresh worker from its final note/);
  const file = workerGuardMarksPath(home);
  assert.ok(JSON.parse(readFileSync(file, "utf8"))["rn-w"]?.soft, "soft mark kept");
  const m = metrics(home).filter((e) => /worker-context/.test(e.text));
  assert.equal(m.length, 1);
  assert.match(m[0].text, /worker-context soft rn-w 150k .* \(nudge dropped: idle\)/);
  r.dropSteerTo.delete("rn-w");
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 2); // fresh usage below hard: the soft rung already fired, nothing repeats
  await tick();
  w.stop();
  assert.deepEqual(to(r, "rn-w"), [], "no retry nudge to the worker");
  assert.equal(to(r, "rn-lead").length, 1, "no second soft ping");
});

test("idea-169: soft nudge dropped, still running past hard in the same episode: the lead gets the hard ping too (ACP-style worker)", async () => {
  const { rootDir } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  r.timelines.set("rn-w", ["still going"]);
  r.dropSteerTo.add("rn-w");
  const w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 1);
  await tick();
  r.usage("rn-w", WORKER_HARD_DEFAULT + 1);
  await tick();
  w.stop();
  assert.deepEqual(to(r, "rn-w"), [], "the worker never got an input");
  const pings = to(r, "rn-lead").map((s) => s.text);
  assert.equal(pings.length, 2, "soft + hard");
  assert.match(pings[0], /wrap-up nudge not delivered/);
  assert.match(pings[1], /and still running: respawn fresh now/);
});

test("idea-1069: running worker crossing 120k gets one WIP nudge (steer-only, no lead ping), never twice across restarts, and soft/lead ping still fire at 150k", async () => {
  const { rootDir, home } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  let w = startTokenWatcher({ runner: r, rootDir });
  r.roster();
  for (const t of [90_000, 119_000, 120_000, 125_000, 140_000]) {
    r.usage("rn-w", t);
    await tick();
  }
  assert.deepEqual(to(r, "rn-w"), [{ id: "rn-w", text: WORKER_WIP_NUDGE, steerOnly: true }]);
  assert.equal(to(r, "rn-lead").length, 0, "WIP nudge is worker-only; no lead ping at 120k");
  const marks = JSON.parse(readFileSync(workerGuardMarksPath(home), "utf8"));
  assert.ok(marks["rn-w"]?.wip, "wip mark persisted");
  assert.equal(marks["rn-w"]?.soft, undefined);
  const wipMetrics = metrics(home).filter((e) => /worker-context wip/.test(e.text));
  assert.equal(wipMetrics.length, 1);
  assert.match(wipMetrics[0].text, /worker-context wip rn-w 120k \(wip 120k\)/);
  w.stop();

  // Restart: persisted wip mark prevents any repeat at 120k-149k, while crossing 150k still fires soft + lead ping.
  w = startTokenWatcher({ runner: r, rootDir });
  r.roster();
  await tick();
  r.usage("rn-w", 145_000);
  await tick();
  assert.equal(to(r, "rn-w").length, 1, "no second WIP nudge after restart");
  r.usage("rn-w", 151_000);
  await tick();
  w.stop();
  assert.deepEqual(to(r, "rn-w").map((s) => s.text), [WORKER_WIP_NUDGE, WORKER_WRAP_NUDGE]);
  const leadMsgs = to(r, "rn-lead").map((s) => s.text);
  assert.equal(leadMsgs.length, 1, "lead ping still works at soft threshold");
  assert.match(leadMsgs[0], /W-rn-w \(rn-w\) at 151k: wrapping; spawn a fresh worker from its final note/);
});

test("idea-1069: WIP threshold is configurable via teams.json (team overrides top-level)", async () => {
  const { rootDir } = makeEnv({ workerWipTokens: 95_000 });
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  const w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", 94_000);
  await tick();
  assert.equal(to(r, "rn-w").length, 0);
  r.usage("rn-w", 96_000);
  await tick();
  w.stop();
  assert.deepEqual(to(r, "rn-w"), [{ id: "rn-w", text: WORKER_WIP_NUDGE, steerOnly: true }]);
});

test("idea-1069: idle/done worker crossing 120k is NOT woken; WIP nudge is delivered as a steer on its next running turn (once)", async () => {
  const { rootDir } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w", {}, { status: "idle" }));
  const w = startTokenWatcher({ runner: r, rootDir });
  // Turn ends idle at 125k: must NOT wake the idle worker.
  r.usage("rn-w", 125_000, { status: "idle" });
  await tick();
  assert.deepEqual(r.sent, [], "never wakes an idle worker");

  // Later, the worker is woken for a next turn (same token count 125k, now running): note is delivered into that turn as a steer.
  r.usage("rn-w", 125_000, { status: "running" });
  await tick();
  assert.deepEqual(to(r, "rn-w"), [{ id: "rn-w", text: WORKER_WIP_NUDGE, steerOnly: true }]);

  // Further usage in the same or later turn never repeats the WIP nudge.
  r.usage("rn-w", 130_000, { status: "running" });
  await tick();
  w.stop();
  assert.equal(to(r, "rn-w").length, 1);
  assert.equal(to(r, "rn-lead").length, 0);
});

test("idea-1069: dropped steer-only WIP nudge (turn ended mid-flight) does not mark or wake; delivers on next running turn", async () => {
  const { rootDir, home } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  r.dropSteerTo.add("rn-w");
  const w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", 122_000);
  await tick();
  assert.deepEqual(to(r, "rn-w"), [], "dropped steer sends nothing");
  const file = workerGuardMarksPath(home);
  assert.equal(existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))["rn-w"]?.wip : undefined, undefined, "dropped wip steer is not marked");

  // Next turn runs (steer now accepted): delivered once.
  r.dropSteerTo.delete("rn-w");
  r.usage("rn-w", 122_000, { status: "running" });
  await tick();
  w.stop();
  assert.deepEqual(to(r, "rn-w"), [{ id: "rn-w", text: WORKER_WIP_NUDGE, steerOnly: true }]);
  assert.ok(JSON.parse(readFileSync(file, "utf8"))["rn-w"]?.wip, "marked once delivered");
});

test("idea-1069: WIP nudge never fires for lead or brainstorm (Buddy) roles at 120k-149k", async () => {
  const { rootDir, home } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", { ...lead("rn-lead"), status: "running" });
  r.agents.set("rn-buddy", { ...buddy("rn-buddy"), status: "running" });
  const w = startTokenWatcher({ runner: r, rootDir, compactor: { run: async () => ({ outcome: "skipped", reason: "not-claude" }), tried: new Set() } });
  r.usage("rn-lead", 130_000);
  r.usage("rn-buddy", 130_000);
  await tick();
  w.stop();
  assert.ok(!r.sent.some((s) => s.text === WORKER_WIP_NUDGE), "neither lead nor Buddy ever gets WORKER_WIP_NUDGE");
  assert.equal(to(r, "rn-lead").length, 0, "lead below 150k gets no nudge");
  assert.deepEqual(to(r, "rn-buddy").map((s) => s.text), [BRAINSTORM_WARN_NUDGE], "Buddy keeps its own warn nudge");
  assert.equal(existsSync(workerGuardMarksPath(home)), false);
});

test("idea-1069: a failed WIP nudge send is rolled back and retried on the next fresh usage event", async () => {
  const { rootDir, home } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  r.failSendTo.add("rn-w");
  const w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", 121_000);
  await tick();
  assert.equal(to(r, "rn-w").length, 0);
  const file = workerGuardMarksPath(home);
  assert.equal(existsSync(file) ? JSON.parse(readFileSync(file, "utf8"))["rn-w"]?.wip : undefined, undefined, "rolled back on error");
  r.failSendTo.delete("rn-w");
  r.usage("rn-w", 123_000);
  await tick();
  w.stop();
  assert.deepEqual(to(r, "rn-w"), [{ id: "rn-w", text: WORKER_WIP_NUDGE, steerOnly: true }]);
});
