// idea-162 (unit-worker-context-guard): the worker rung of the context ladder. Leads have lead-handoff.mjs evaluateLead, Buddies
// token-watch.mjs evaluateBuddy; workers (incl. digest workers and reviewers) get a soft wrap-up nudge + lead ping and, while still
// running past the hard mark, one "respawn fresh now" ping to the lead. Each mark fires at most once per worker, across restarts.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startTokenWatcher, BRAINSTORM_WARN_NUDGE } from "../server/token-watch.mjs";
import { LEAD_AUTO_HANDOFF_DEFAULT, LEAD_FLAG_DEFAULT, SOFT_FLAG_NUDGE } from "../server/lead-handoff.mjs";
import {
  WORKER_HARD_DEFAULT,
  WORKER_SOFT_DEFAULT,
  WORKER_WRAP_NUDGE,
  createWorkerContextGuard,
  loadWorkerThresholds,
  workerGuardMarksPath,
} from "../server/worker-context-guard.mjs";

process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";

const tick = () => new Promise((r) => setTimeout(r, 15));

function makeRunner() {
  const agents = new Map();
  const sent = [];
  const cancelled = [];
  const timelines = new Map();
  const listeners = new Set();
  const failSendTo = new Set();
  return {
    agents,
    sent,
    cancelled,
    timelines,
    failSendTo,
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
      if (failSendTo.has(id)) throw new Error(`send to ${id} failed`);
      sent.push({ id, text });
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
  };
}

function makeEnv(teamsExtra = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), "vs-wcg-root-"));
  mkdirSync(join(rootDir, "docs", "brainstorm"), { recursive: true });
  writeFileSync(
    join(rootDir, "teams.json"),
    JSON.stringify({ teams: [{ id: "t", name: "T", lanes: [{ id: "l", name: "L" }, { id: "m", name: "M" }] }], ...teamsExtra }),
  );
  process.env.VIBESQUAD_ROOT = rootDir;
  const home = mkdtempSync(join(tmpdir(), "vs-wcg-home-"));
  process.env.VIBESQUAD_HOME = home;
  return { rootDir, home };
}

const lead = (id, lane = "l") => ({ id, title: "★ L1", status: "idle", cwd: "/x", createdAt: "2026-11-11T00:00:00Z", labels: { role: "lead", team: "t", lane, ord: "1" } });
const buddy = (id) => ({ id, title: "Buddy", status: "idle", labels: { role: "brainstorm", team: "t", lane: "l" } });
const worker = (id, labels = {}, extra = {}) => ({ id, title: `W-${id}`, status: "running", labels: { role: "worker", team: "t", lane: "l", "vs.parent": "rn-lead", ...labels }, ...extra });

const to = (r, id) => r.sent.filter((s) => s.id === id);
const metrics = (home) => {
  const f = join(home, "teams", "t", "log.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === "metric") : [];
};

test("thresholds: same constant family as the lead ladder (soft 150k / hard 250k), team and top-level overridable", () => {
  assert.equal(WORKER_SOFT_DEFAULT, LEAD_FLAG_DEFAULT);
  assert.equal(WORKER_HARD_DEFAULT, LEAD_AUTO_HANDOFF_DEFAULT);
  const { rootDir } = makeEnv({ workerSoftTokens: 120_000 });
  assert.deepEqual(loadWorkerThresholds(worker("w"), rootDir), { softTokens: 120_000, hardTokens: 250_000 });
  writeFileSync(join(rootDir, "teams.json"), JSON.stringify({ workerSoftTokens: 120_000, teams: [{ id: "t", workerHardTokens: 200_000, workerSoftTokens: 90_000, lanes: [{ id: "l" }] }] }));
  assert.deepEqual(loadWorkerThresholds(worker("w"), rootDir), { softTokens: 90_000, hardTokens: 200_000 });
});

test("soft: worker gets one wrap-up input, its lead one ping, one metric line; repeats are silent", async () => {
  const { rootDir, home } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  const w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", WORKER_SOFT_DEFAULT - 1);
  await tick();
  assert.equal(r.sent.length, 0);
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 5_000);
  await tick();
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 9_000);
  await tick();
  w.stop();
  assert.deepEqual(to(r, "rn-w").map((s) => s.text), [WORKER_WRAP_NUDGE]);
  const leadMsgs = to(r, "rn-lead").map((s) => s.text);
  assert.equal(leadMsgs.length, 1);
  assert.match(leadMsgs[0], /W-rn-w \(rn-w\) at 155k: wrapping; spawn a fresh worker from its final note/);
  const m = metrics(home).filter((e) => /worker-context/.test(e.text));
  assert.equal(m.length, 1);
  assert.match(m[0].text, /worker-context soft rn-w 155k/);
  assert.deepEqual(r.cancelled, []);
});

test("hard while running: one 'respawn fresh now' to the lead carrying the last message; never cancels or respawns", async () => {
  const { rootDir } = makeEnv();
  const r = makeRunner();
  r.agents.set("rn-lead", lead("rn-lead"));
  r.agents.set("rn-w", worker("rn-w"));
  r.timelines.set("rn-w", ["older note", "Done: A. Left: B. Branch unit-x @ abc123. Next: C."]);
  const w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 1);
  await tick();
  r.usage("rn-w", WORKER_HARD_DEFAULT + 1, { status: "idle" }); // idle past hard: its final note is out, the digest covers it
  await tick();
  assert.equal(to(r, "rn-lead").length, 1);
  r.usage("rn-w", WORKER_HARD_DEFAULT + 2_000, { status: "running" });
  await tick();
  r.usage("rn-w", WORKER_HARD_DEFAULT + 4_000, { status: "running" });
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
  let w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 1);
  await tick();
  w.stop();
  const file = workerGuardMarksPath(home);
  assert.equal(file, join(home, "worker-context-guard.json"));
  const marks = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(marks["rn-w"]?.soft, "soft mark persisted");
  assert.equal(marks["rn-w"].hard, undefined);
  assert.deepEqual(readdirSync(home).filter((f) => f.endsWith(".tmp")), [], "no temp file left behind");

  w = startTokenWatcher({ runner: r, rootDir }); // server restart: empty memory, same home
  r.usage("rn-w", WORKER_SOFT_DEFAULT + 3_000);
  await tick();
  assert.equal(r.sent.length, 2, "no repeat of the soft mark after a restart");
  r.usage("rn-w", WORKER_HARD_DEFAULT + 1);
  await tick();
  w.stop();
  assert.equal(r.sent.length, 3);

  w = startTokenWatcher({ runner: r, rootDir });
  r.usage("rn-w", WORKER_HARD_DEFAULT + 9_000);
  await tick();
  w.stop();
  assert.equal(r.sent.length, 3, "no repeat of the hard mark after a restart");
});

test("leads, Buddies and Overlords keep their own ladders; the worker guard never touches them", async () => {
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
  w.stop();
  assert.deepEqual(to(r, "rn-lead").map((s) => s.text), [SOFT_FLAG_NUDGE]);
  assert.deepEqual(to(r, "rn-ovl").map((s) => s.text), [SOFT_FLAG_NUDGE]);
  assert.deepEqual(to(r, "rn-buddy").map((s) => s.text), [BRAINSTORM_WARN_NUDGE]);
  assert.ok(!r.sent.some((s) => s.text === WORKER_WRAP_NUDGE));
  assert.equal(existsSync(workerGuardMarksPath(home)), false);

  const guard = createWorkerContextGuard({ rootDir, sendMessage: async () => assert.fail("must not send") });
  for (const a of [lead("x1"), buddy("x2"), { ...lead("x3"), labels: { role: "former-lead", team: "t", lane: "l" } }]) {
    a.lastUsage = { contextWindowUsedTokens: 400_000 };
    assert.equal((await guard.evaluateWorker(a)).stage, "skip");
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

test("closed or archived workers never trigger (including closed-but-resumable)", async () => {
  const { rootDir, home } = makeEnv();
  const sent = [];
  const guard = createWorkerContextGuard({ rootDir, sendMessage: async (id, text) => sent.push({ id, text }), listAgents: async () => [lead("rn-lead")] });
  const big = { lastUsage: { contextWindowUsedTokens: 300_000 } };
  for (const a of [
    worker("c1", {}, { ...big, status: "closed" }),
    worker("c2", {}, { ...big, status: "closed", resumable: true }),
    worker("c3", {}, { ...big, archivedAt: "2026-11-11T00:00:00Z" }),
  ]) {
    assert.equal((await guard.evaluateWorker(a)).stage, "skip", a.id);
  }
  assert.deepEqual(sent, []);
  assert.equal(existsSync(workerGuardMarksPath(home)), false);
});

test("an unknown or absent token count never triggers", async () => {
  const { rootDir, home } = makeEnv();
  const sent = [];
  const guard = createWorkerContextGuard({ rootDir, sendMessage: async (id, text) => sent.push({ id, text }), listAgents: async () => [] });
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

test("a failed worker send is not marked (the next usage event retries); a failed lead ping does not re-nudge the worker", async () => {
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
