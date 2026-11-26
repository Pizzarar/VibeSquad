// idea-1101 (@bug, PLAN_PER_QUOTA_FIT_1126 block B): mid-run quota-wall resume across all providers
// (agy third-party quota, Claude 5h/weekly limit, Gemini quota, OpenCode/DeepSeek credit).
// Extends idea-1077's 0-turn re-route to mid-run workers: resumes on the next uncapped chain provider in the
// SAME linked worktree with a resume brief (original goal + git commits/diff + last report), links old->new
// agent id (labels + decision log + watch retargeting), keeps 0-turn behavior intact, enforces all 4 invariants.
// Temp homes and temp git repos only: never touches the host's ~/.vibesquad or the real repo.
import "./helpers/clean-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDirs = [];
test.after(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  }
});
const tmp = (prefix = "vs-1101-") => {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

const VS_HOME = tmp("vs-1101-home-");
process.env.VIBESQUAD_HOME = VS_HOME;
process.env.VIBESQUAD_ROOT = tmp("vs-1101-root-");
const CAPS = path.join(VS_HOME, "capped-providers.json");
process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = CAPS;

// Build a real temp git repo + a linked worktree in the temp sanctuary.
const REPO_PARENT = tmp("vs-1101-repo-");
const MAIN_REPO = path.join(REPO_PARENT, "DemoRepo");
mkdirSync(MAIN_REPO, { recursive: true });
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
git(["init", "-b", "master"], MAIN_REPO);
git(["config", "user.name", "Test Bot"], MAIN_REPO);
git(["config", "user.email", "test@example.com"], MAIN_REPO);
writeFileSync(path.join(MAIN_REPO, "app.js"), "export const x = 1;\n");
git(["add", "app.js"], MAIN_REPO);
git(["commit", "-m", "initial commit"], MAIN_REPO);

const WORKTREE_ROOT = path.join(VS_HOME, "worktrees", "DemoRepo");
mkdirSync(WORKTREE_ROOT, { recursive: true });
const LINKED_WT = path.join(WORKTREE_ROOT, "unit-1101-demo");
git(["worktree", "add", "-b", "unit-1101-demo", LINKED_WT, "master"], MAIN_REPO);

// Seed real mid-run work in the linked worktree: one WIP commit + one uncommitted edit.
writeFileSync(path.join(LINKED_WT, "app.js"), "export const x = 2;\n");
git(["add", "app.js"], LINKED_WT);
git(["commit", "-m", "wip: step 1 done"], LINKED_WT);
writeFileSync(path.join(LINKED_WT, "app.js"), "export const x = 3;\n// uncommitted step 2\n");

writeFileSync(
  path.join(VS_HOME, "teams.json"),
  JSON.stringify({
    teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "bug-chaser", paths: ["DemoRepo", "unit-1101-demo"] }], paths: ["DemoRepo", "unit-1101-demo"] }],
  }),
);

const rb = await import("../server/backend/runner-backend.mjs");
const {
  RunnerBackend,
  claudeQuotaOf,
  geminiQuotaOf,
  providerFaultOf,
  capProviderOnUpstreamExit,
  PROVIDER_QUOTA_DEFAULT_TTL_MS,
} = rb;
const { createRunnerHookHost } = await import("../server/backend/runner-hooks.mjs");
const {
  RESPAWN_OF_LABEL,
  RESPAWNED_AS_LABEL,
  RESUME_MODE_LABEL,
  resolveWorkerWorktree,
  extractLastWorkerReport,
} = await import("../server/hooks/agent-duties.ts");
const { FAILOVER_FROM_LABEL } = await import("../server/lead-handoff.mjs");
const { readLiveCapDoc, spawnFamily } = await import("../server/provider-failover.mjs");
const { AGY_CLAUDE_FAMILY } = await import("../server/model-ids.mjs");
const { isDeliberateCap } = await import("../server/credit-guard.mjs");
const { addWatch, retargetWatches, createWatchEngine, verdictBlock } = await import("../server/watch-sets.mjs");

const AGY_NOTICE = "⚠ Third-party quota reached. Please switch to Gemini models or upgrade your subscription to increase your limits. Resets in 3h45m18s.";
const CLAUDE_LIMIT = "You've hit your limit · resets 5pm (America/New_York)";
const GEMINI_QUOTA = "You have exhausted your capacity on this model. Your quota will reset after 2h15m.";
const DEEPSEEK_CREDIT = "Internal error: Insufficient Balance";

const writeCaps = (capped) => writeFileSync(CAPS, JSON.stringify({ capped }));
const liveCaps = (now = Date.now()) => readLiveCapDoc({ cappedProvidersPath: CAPS, now }).capped;
const LOG = path.join(VS_HOME, "teams", "vibesquad", "log.jsonl");
const teamLog = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const metricsFor = (id) => teamLog().filter((e) => e.type === "metric" && e.text.includes(`agent=${id} `));

const ORIG_PROMPT = "Unit 1101: finish app.js step 2 and add tests.\nSetup: vs worktree create unit-1101-demo, cd in.";
const LAST_REPORT = "Completed step 1 and committed wip: step 1 done. Starting step 2 edits in app.js.";

const MIDRUN_TIMELINE = (quotaText) => [
  { item: { type: "user_message", text: ORIG_PROMPT } },
  { item: { type: "tool_call", name: "Edit app.js", detail: { kind: "edit" } } },
  { item: { type: "tool_call", name: "git commit", detail: { kind: "execute" } } },
  { item: { type: "assistant_message", text: LAST_REPORT }, turnEnd: true },
  { item: { type: "user_message", text: "continue with step 2" } },
  { item: { type: "tool_call", name: "Edit app.js", detail: { kind: "edit" } } },
  { item: { type: "assistant_message", text: quotaText }, turnEnd: true },
];

async function backendEvents(events, agent) {
  const vs = tmp("vs-1101-be-");
  const rc = { vs, home: path.join(vs, "runner"), request: async () => { throw new Error("unused"); }, stream: () => ({ close() {} }) };
  const b = new RunnerBackend({ client: rc, buildPrefix: async () => "" });
  b.live.hwm = new Map();
  b.noteSeen = () => {};
  b.emitTimeline = () => {};
  b.refreshLaneWhosHere = async () => {};
  b.fetchAgent = async () => ({ agent });
  const out = [];
  b.emitEvent = (e) => out.push(e);
  for (const event of events) await b.handleLogEvent({ id: agent.id, event });
  return out;
}

function fakeRunner({ id, provider, model, cwd = LINKED_WT, labels = {}, timeline, status = "idle", archivedAt = null }) {
  const agents = new Map();
  const timelines = new Map();
  const created = [];
  const fullLabels = {
    team: "vibesquad",
    lane: "bug-chaser",
    role: "worker",
    profile: "Implement",
    job: "1101-test",
    ord: "1",
    stakes: "tierA-invariant",
    "vs.parent": "rn-lead1",
    provider,
    model,
    ...labels,
  };
  const backend = {
    async getAgent(aid) {
      const a = agents.get(aid);
      if (!a) throw new Error(`no agent ${aid}`);
      return { ...a, labels: { ...a.labels } };
    },
    async fetchAgentTimeline(aid, opts = {}) {
      const all = timelines.get(aid) ?? [];
      return { entries: Number(opts.limit) > 0 ? all.slice(-Number(opts.limit)) : all.slice() };
    },
    async listAgents(opts) {
      const all = [...agents.values()].filter((a) => opts?.filter?.includeArchived || !a.archivedAt);
      return all.map((a) => ({ ...a, labels: { ...a.labels } }));
    },
    async createAgent({ config, cwd: spawnCwd, prompt, labels: l, env }) {
      const nid = `rn-resumed-${created.length + 1}`;
      const a = {
        id: nid,
        title: config.title ?? "resumed",
        cwd: spawnCwd ?? config.cwd,
        provider: config.provider,
        model: config.model,
        status: "running",
        labels: { ...l },
        archivedAt: null,
      };
      agents.set(nid, a);
      timelines.set(nid, [{ item: { type: "user_message", text: prompt }, seqStart: 1, seqEnd: 1 }]);
      created.push({ ...a, prompt, env });
      return { ...a };
    },
    async sendAgentPrompt() { return { queued: false }; },
    async archiveAgent(aid) { const a = agents.get(aid); if (a) a.archivedAt = new Date().toISOString(); },
    async updateAgent(aid, { labels: l } = {}) {
      const a = agents.get(aid);
      if (a && l) a.labels = { ...a.labels, ...l };
    },
    async cancelAgent() {},
    async deleteHeartbeat() {},
  };
  agents.set(id, { id, title: "Bug7 · 1101-test", cwd, provider, model, status, labels: fullLabels, archivedAt });
  timelines.set(id, timeline.map((r, i) => ({ ...r, seqStart: i + 1, seqEnd: i + 1 })));
  return { backend, agents, timelines, created };
}

async function emitQuotaWall(f, id, errorText, { cappedProviders = [], watchSets = false, ts = Date.now(), outcomeQuota = true } = {}) {
  writeCaps({});
  const host = await createRunnerHookHost(f.backend, {
    startWatcher: false,
    deps: { cappedProviders, retryBaseMs: 30, watchSets },
    pollMs: 20,
  });
  try {
    const agent = await f.backend.getAgent(id);
    await host.emit("agent.turn_ended", { agent, turnId: "7", outcome: { kind: "failed", error: { message: errorText, ...(outcomeQuota ? { quota: true } : {}) } } });
    await host.emit("agent.upstream_exit", { agent, error: errorText, ts, quota: true });
  } finally {
    host.dispose();
  }
}

// ---- 1. Per-provider error shapes -> mid-run resume ----

test("1101-1: agy third-party quota mid-run -> resumes on native claude in SAME linked worktree with resume brief + id link", async () => {
  const f = fakeRunner({
    id: "rn-mid-agy",
    provider: "antigravity-cli",
    model: "claude-opus-5-5-high",
    timeline: MIDRUN_TIMELINE(AGY_NOTICE),
  });
  await emitQuotaWall(f, "rn-mid-agy", AGY_NOTICE, { cappedProviders: [AGY_CLAUDE_FAMILY] });
  assert.equal(f.created.length, 1);
  const n = f.created[0];
  assert.equal(spawnFamily(n.provider, n.model), "claude", n.provider);
  assert.equal(n.cwd, LINKED_WT, "resumes in the SAME linked worktree");
  assert.equal(n.labels[RESPAWN_OF_LABEL], "rn-mid-agy");
  assert.equal(n.labels[RESUME_MODE_LABEL], "midrun");
  assert.equal(n.labels[FAILOVER_FROM_LABEL], "Implement");
  assert.equal(f.agents.get("rn-mid-agy").labels[RESPAWNED_AS_LABEL], n.id);
  // Resume brief carries original goal, git commit + uncommitted diff, last report, and R17 guard.
  assert.match(n.prompt, /\[MID-RUN QUOTA RESUME from rn-mid-agy \(agy-claude -> claude\)\]/);
  assert.match(n.prompt, /unit-1101-demo/, "branch name");
  assert.match(n.prompt, /wip: step 1 done/, "commits so far");
  assert.match(n.prompt, /uncommitted step 2/, "git diff so far");
  assert.match(n.prompt, /Completed step 1 and committed/, "last worker report");
  assert.match(n.prompt, /Unit 1101: finish app\.js step 2/, "original task prompt");
  assert.match(n.prompt, /Never run git writes in the main checkout/);
  // Decision log + metric link old -> new id.
  const dec = teamLog().filter((e) => e.type === "decision" && e.refs?.includes("rn-mid-agy")).at(-1);
  assert.ok(dec);
  assert.deepEqual(dec.refs, ["rn-mid-agy", n.id]);
  assert.match(dec.text, new RegExp(`^RESUMED rn-mid-agy -> ${n.id}:.*mid-run`));
  assert.match(metricsFor("rn-mid-agy").at(-1).text, /result=resumed .*mode=midrun/);
});

test("1101-2: Claude 5h/weekly limit -> classified, caps claude (auto), emits upstream_exit(quota:true), resumes mid-run on agy Gemini", async () => {
  // Classifier checks (standalone output + error + prose rejection).
  assert.ok(claudeQuotaOf(CLAUDE_LIMIT, { wholeEvent: true }));
  assert.ok(claudeQuotaOf("Claude usage limit reached. Resets in 2h30m.", { wholeEvent: true }));
  assert.equal(claudeQuotaOf("Claude usage limit reached. Resets in 2h30m.").resetInMs, (2 * 3600 + 30 * 60) * 1000);
  assert.ok(claudeQuotaOf("API Error: You have reached your 5-hour limit", { wholeEvent: false }));
  assert.equal(claudeQuotaOf(`The user told me: ${CLAUDE_LIMIT}`, { wholeEvent: true }), null, "prose quoting it never triggers on output");
  assert.equal(providerFaultOf({ type: "error", message: CLAUDE_LIMIT, subtype: "error_during_execution" }), null, "error_* subtype stays task fault");

  // RunnerBackend: error event on claude -> caps claude (auto cap), emits upstream_exit(quota:true).
  writeCaps({});
  const ts = Date.now();
  const claudeAgent = { id: "rn-cl-1", provider: "claude", model: "claude-opus-5-5", status: "idle", cwd: LINKED_WT, labels: { role: "worker" } };
  const ev = await backendEvents([
    { seq: 0, ts, type: "created", provider: "claude", model: "claude-opus-5-5" },
    { seq: 1, ts, type: "input", text: ORIG_PROMPT },
    { seq: 2, ts, type: "status", status: "running" },
    { seq: 3, ts, type: "error", message: CLAUDE_LIMIT, subtype: "success" },
    { seq: 4, ts, type: "turn_done", stopReason: "end_turn" },
    { seq: 5, ts, type: "status", status: "idle" },
  ], claudeAgent);
  const ux = ev.filter((e) => e.kind === "upstream_exit");
  assert.equal(ux.length, 1);
  assert.equal(ux[0].quota, true);
  const caps = liveCaps();
  assert.deepEqual(Object.keys(caps), ["claude"]);
  assert.equal(isDeliberateCap(caps.claude), false, "auto cap, not deliberate owner cap");

  // Mid-run resume on next uncapped chain provider (antigravity-cli Gemini, since agy-claude is also capped here).
  const f = fakeRunner({
    id: "rn-mid-claude",
    provider: "claude",
    model: "claude-opus-5-5",
    timeline: MIDRUN_TIMELINE(CLAUDE_LIMIT),
  });
  await emitQuotaWall(f, "rn-mid-claude", CLAUDE_LIMIT, { cappedProviders: ["claude", AGY_CLAUDE_FAMILY] });
  assert.equal(f.created.length, 1);
  assert.equal(spawnFamily(f.created[0].provider, f.created[0].model), "antigravity-cli");
  assert.equal(f.created[0].cwd, LINKED_WT);
  assert.equal(f.created[0].labels[RESPAWN_OF_LABEL], "rn-mid-claude");
});

test("1101-3: Gemini quota -> classified with reset TTL, caps antigravity-cli, emits upstream_exit(quota:true), resumes mid-run on claude", async () => {
  const g1 = geminiQuotaOf(GEMINI_QUOTA, { wholeEvent: true });
  assert.equal(g1?.resetInMs, (2 * 3600 + 15 * 60) * 1000);
  const g2 = providerFaultOf({ type: "error", message: "RESOURCE_EXHAUSTED: Quota exceeded for quota metric" });
  assert.equal(g2?.kind, "quota");
  assert.equal(g2?.ttlMs, PROVIDER_QUOTA_DEFAULT_TTL_MS);
  assert.equal(geminiQuotaOf("We fixed the RESOURCE_EXHAUSTED bug in tests.", { wholeEvent: true }), null, "prose never triggers on output");

  // RunnerBackend: Gemini quota error on antigravity-cli -> caps antigravity-cli, emits upstream_exit(quota:true).
  writeCaps({});
  const ts = Date.now();
  const gemAgent = { id: "rn-gem-1", provider: "antigravity-cli", model: "gemini-4-neon-medium", status: "idle", cwd: LINKED_WT, labels: { role: "worker" } };
  const ev = await backendEvents([
    { seq: 0, ts, type: "created", provider: "antigravity-cli", model: "gemini-4-neon-medium" },
    { seq: 1, ts, type: "input", text: ORIG_PROMPT },
    { seq: 2, ts, type: "status", status: "running" },
    { seq: 3, ts, type: "error", message: GEMINI_QUOTA },
    { seq: 4, ts, type: "status", status: "idle" },
  ], gemAgent);
  const ux = ev.filter((e) => e.kind === "upstream_exit");
  assert.equal(ux.length, 1);
  assert.equal(ux[0].quota, true);
  assert.deepEqual(Object.keys(liveCaps()), ["antigravity-cli"]);

  // Mid-run resume on next chain provider (claude).
  const f = fakeRunner({
    id: "rn-mid-gem",
    provider: "antigravity-cli",
    model: "gemini-4-neon-medium",
    labels: { profile: "Review" },
    timeline: MIDRUN_TIMELINE(GEMINI_QUOTA),
  });
  await emitQuotaWall(f, "rn-mid-gem", GEMINI_QUOTA, { cappedProviders: ["antigravity-cli", AGY_CLAUDE_FAMILY] });
  assert.equal(f.created.length, 1);
  assert.equal(spawnFamily(f.created[0].provider, f.created[0].model), "claude");
  assert.equal(f.created[0].cwd, LINKED_WT);
});

test("1101-3b: M1 — a Gemini quota error naming its googleapis service is flagged quota, skips A4, and still resumes", async () => {
  const GAPI = "RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate Content API requests per minute' of service 'generativelanguage.googleapis.com'";
  writeCaps({});
  const ts = Date.now();
  const ev = await backendEvents([
    { seq: 0, ts, type: "created", provider: "antigravity-cli", model: "gemini-4-neon-medium" },
    { seq: 1, ts, type: "input", text: ORIG_PROMPT },
    { seq: 2, ts, type: "status", status: "running" },
    { seq: 3, ts, type: "error", message: GAPI },
    { seq: 4, ts, type: "status", status: "idle" },
  ], { id: "rn-gapi-1", provider: "antigravity-cli", model: "gemini-4-neon-medium", status: "idle", cwd: LINKED_WT, labels: { role: "worker" } });
  const ended = ev.filter((e) => e.kind === "turn_ended");
  assert.equal(ended[0].outcome.kind, "failed");
  assert.equal(ended[0].outcome.error.quota, true, "turn outcome carries the quota flag");
  assert.equal(ev.filter((e) => e.kind === "upstream_exit" && e.quota).length, 1);

  // Mid-turn exit whose own reason is the wall (no prior error event) is flagged too.
  writeCaps({});
  const ex = await backendEvents([
    { seq: 0, ts, type: "created", provider: "antigravity-cli", model: "gemini-4-neon-medium" },
    { seq: 1, ts, type: "input", text: ORIG_PROMPT },
    { seq: 2, ts, type: "status", status: "running" },
    { seq: 3, ts, type: "exit", code: 1, error: `agy exited (code 1) after: ${GAPI}`, upstream: false },
  ], { id: "rn-gapi-2", provider: "antigravity-cli", model: "gemini-4-neon-medium", status: "idle", cwd: LINKED_WT, labels: { role: "worker" } });
  assert.equal(ex.find((e) => e.kind === "turn_ended").outcome.error.quota, true);
  assert.equal(ex.filter((e) => e.kind === "upstream_exit" && e.quota).length, 1);

  // Hook: the quota-flagged failed turn schedules no A4 resend, so the resume is not pre-empted (a4-retry-scheduled).
  const f = fakeRunner({ id: "rn-mid-gapi", provider: "antigravity-cli", model: "gemini-4-neon-medium", labels: { profile: "Review" }, timeline: MIDRUN_TIMELINE(GAPI) });
  const sends = [];
  f.backend.sendAgentPrompt = async (aid, p) => { sends.push([aid, p]); return { queued: false }; };
  await emitQuotaWall(f, "rn-mid-gapi", GAPI, { cappedProviders: ["antigravity-cli", AGY_CLAUDE_FAMILY] });
  await new Promise((r) => setTimeout(r, 150)); // past retryBaseMs: a scheduled A4 resend would have fired
  assert.equal(f.created.length, 1, "resumed, not skipped as a4-retry-scheduled");
  assert.equal(spawnFamily(f.created[0].provider, f.created[0].model), "claude");
  assert.equal(sends.filter(([aid]) => aid === "rn-mid-gapi").length, 0, "no A4 resend to the capped provider");
  assert.doesNotMatch(metricsFor("rn-mid-gapi").at(-1).text, /a4-retry-scheduled/);
});

test("1101-4: OpenCode / DeepSeek credit error -> caps opencode, emits single upstream_exit(quota:true), resumes mid-run on claude", async () => {
  writeCaps({});
  const ts = Date.now();
  const ocAgent = { id: "rn-oc-1", provider: "opencode", model: "deepseek/deepseek-v4-pro", status: "idle", cwd: LINKED_WT, labels: { role: "worker" } };
  // Both parked-error and exit-after-error must emit exactly ONE upstream_exit(quota:true).
  const ev = await backendEvents([
    { seq: 0, ts, type: "created", provider: "opencode", model: "deepseek/deepseek-v4-pro" },
    { seq: 1, ts, type: "input", text: ORIG_PROMPT },
    { seq: 2, ts, type: "status", status: "running" },
    { seq: 3, ts, type: "error", message: DEEPSEEK_CREDIT },
    { seq: 4, ts, type: "exit", code: 1, error: DEEPSEEK_CREDIT, upstream: false },
  ], ocAgent);
  const ux = ev.filter((e) => e.kind === "upstream_exit");
  assert.equal(ux.length, 1, "exactly one upstream_exit even when error is followed by exit");
  assert.equal(ux[0].quota, true);
  assert.deepEqual(Object.keys(liveCaps()), ["opencode"]);

  const f = fakeRunner({
    id: "rn-mid-oc",
    provider: "opencode",
    model: "deepseek/deepseek-v4-pro",
    labels: { profile: "Work Order" },
    timeline: MIDRUN_TIMELINE(DEEPSEEK_CREDIT),
  });
  await emitQuotaWall(f, "rn-mid-oc", DEEPSEEK_CREDIT, { cappedProviders: ["opencode", AGY_CLAUDE_FAMILY] });
  assert.equal(f.created.length, 1);
  assert.equal(spawnFamily(f.created[0].provider, f.created[0].model), "claude");
  assert.equal(f.created[0].cwd, LINKED_WT);
});

// ---- 2. Watch retargeting & verdict handoff ----

test("1101-5: open watch set retargets from deadId -> newId so watches and verdicts follow the resumed worker", async () => {
  const watchHome = tmp("vs-1101-watch-");
  const { id: watchId } = addWatch(
    { owner: "rn-lead1", team: "vibesquad", lane: "bug-chaser", items: [{ kind: "agent", ref: "rn-mid-watch" }] },
    { home: watchHome },
  );
  const f = fakeRunner({
    id: "rn-mid-watch",
    provider: "antigravity-cli",
    model: "claude-opus-5-5-high",
    timeline: MIDRUN_TIMELINE(AGY_NOTICE),
  });
  await emitQuotaWall(f, "rn-mid-watch", AGY_NOTICE, {
    cappedProviders: [AGY_CLAUDE_FAMILY],
    watchSets: { home: watchHome },
  });
  assert.equal(f.created.length, 1);
  const newId = f.created[0].id;

  const engine = createWatchEngine({ home: watchHome });
  const set = engine.get(watchId);
  assert.equal(set.items[0].ref, newId, "watch item now points to the resumed successor");
  assert.equal(set.items[0].state, "waiting");
  assert.equal(set.items[0].retargeted[0].from, "rn-mid-watch");
  assert.equal(set.items[0].retargeted[0].to, newId);

  // When the successor completes with a verdict, verdictBlock reports it under newId.
  set.items[0].state = "done";
  set.items[0].report = "PASS 0/0/0 abc1234";
  assert.match(verdictBlock(set), new RegExp(`- agent ${newId}: PASS 0/0/0 abc1234`));

  // Direct retargetWatches: already-done items are not overwritten.
  const doneWatch = addWatch(
    { owner: "rn-lead1", team: "vibesquad", lane: "bug-chaser", items: [{ kind: "agent", ref: "rn-other" }] },
    { home: watchHome },
  );
  assert.deepEqual(retargetWatches({ from: "rn-other", to: "rn-other-2", reason: "test" }, { home: watchHome }), { retargeted: [doneWatch.id] });
});

// ---- 3. 0-turn path unchanged ----

test("1101-6: 0-turn / read-only quota death still takes the verbatim 1077 respawn path (no mid-run wrapper)", async () => {
  const zeroTl = [
    { item: { type: "user_message", text: ORIG_PROMPT } },
    { item: { type: "tool_call", name: "Read app.js", detail: { kind: "read" } } },
    { item: { type: "assistant_message", text: AGY_NOTICE }, turnEnd: true },
  ];
  const f = fakeRunner({
    id: "rn-zero-1",
    provider: "antigravity-cli",
    model: "claude-opus-5-5-high",
    timeline: zeroTl,
  });
  await emitQuotaWall(f, "rn-zero-1", AGY_NOTICE, { cappedProviders: [AGY_CLAUDE_FAMILY] });
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].prompt, ORIG_PROMPT, "verbatim original prompt");
  assert.equal(f.created[0].labels[RESUME_MODE_LABEL], undefined, "not marked midrun");
  const dec = teamLog().filter((e) => e.type === "decision" && e.refs?.includes("rn-zero-1")).at(-1);
  assert.match(dec.text, /^RESPAWNED rn-zero-1 ->/);
});

// ---- 4. Invariant #1: at most one live successor, idempotent across restart, no respawn storms ----

test("1101-7: Invariant 1 — no double resume in-process, across restart (respawnedAs + respawnOf), or on resumed successor", async () => {
  const f = fakeRunner({
    id: "rn-once",
    provider: "antigravity-cli",
    model: "claude-opus-5-5-high",
    timeline: MIDRUN_TIMELINE(AGY_NOTICE),
  });
  // First wall: resumes once.
  await emitQuotaWall(f, "rn-once", AGY_NOTICE, { cappedProviders: [AGY_CLAUDE_FAMILY] });
  assert.equal(f.created.length, 1);
  // Simulated server restart replays the wall: respawnedAs blocks it.
  await emitQuotaWall(f, "rn-once", AGY_NOTICE, { cappedProviders: [AGY_CLAUDE_FAMILY] });
  assert.equal(f.created.length, 1);
  assert.match(metricsFor("rn-once").at(-1).text, /reason=already-respawned/);
  // Even if respawnedAs write was lost, successor's respawnOf blocks it (even when archived).
  delete f.agents.get("rn-once").labels[RESPAWNED_AS_LABEL];
  f.agents.get(f.created[0].id).archivedAt = new Date().toISOString();
  await emitQuotaWall(f, "rn-once", AGY_NOTICE, { cappedProviders: [AGY_CLAUDE_FAMILY] });
  assert.equal(f.created.length, 1);
  assert.match(metricsFor("rn-once").at(-1).text, new RegExp(`reason=already-respawned\\(${f.created[0].id}\\)`));
  // The resumed successor itself hits a quota wall -> no storm (already-a-respawn).
  const succId = f.created[0].id;
  f.agents.get(succId).archivedAt = null;
  f.agents.get(succId).status = "idle";
  f.timelines.set(succId, MIDRUN_TIMELINE(CLAUDE_LIMIT).map((r, i) => ({ ...r, seqStart: i + 1, seqEnd: i + 1 })));
  await emitQuotaWall(f, succId, CLAUDE_LIMIT, { cappedProviders: [AGY_CLAUDE_FAMILY, "claude"] });
  assert.equal(f.created.length, 1, "no respawn storm");
  assert.match(metricsFor(succId).at(-1).text, /reason=already-a-respawn/);
});

// ---- 5. Invariant #2: never resume onto a capped provider (incl. indefinite No-DeepSeek cap) ----

test("1101-8: Invariant 2 — capped next provider skipped; indefinite No-DeepSeek cap never bypassed", async () => {
  const noDs = { opencode: { reason: "cli cap", updatedAt: new Date().toISOString() } };
  const f1 = fakeRunner({
    id: "rn-cap-skip",
    provider: "antigravity-cli",
    model: "claude-opus-5-5-high",
    timeline: MIDRUN_TIMELINE(AGY_NOTICE),
  });
  await emitQuotaWall(f1, "rn-cap-skip", AGY_NOTICE, {
    cappedProviders: { [AGY_CLAUDE_FAMILY]: { reason: "q" }, claude: { reason: "q" }, ...noDs },
  });
  assert.equal(f1.created.length, 1);
  assert.equal(spawnFamily(f1.created[0].provider, f1.created[0].model), "antigravity-cli", "skips capped claude -> agy Gemini");

  const f2 = fakeRunner({
    id: "rn-cap-all",
    provider: "antigravity-cli",
    model: "claude-opus-5-5-high",
    timeline: MIDRUN_TIMELINE(AGY_NOTICE),
  });
  await emitQuotaWall(f2, "rn-cap-all", AGY_NOTICE, {
    cappedProviders: { [AGY_CLAUDE_FAMILY]: { reason: "q" }, claude: { reason: "q" }, "antigravity-cli": { reason: "q" }, ...noDs },
  });
  assert.equal(f2.created.length, 0, "never lands on capped opencode");
  assert.match(metricsFor("rn-cap-all").at(-1).text, /reason=no-alternate/);
});

// ---- 6. Invariant #3: normal completion / archived / cancelled worker never resumed ----

test("1101-9: Invariant 3 — normal completion, archived, or cancelled worker is never resumed", async () => {
  // Normal completion emits no upstream_exit.
  const ts = Date.now();
  const normAgent = { id: "rn-norm", provider: "claude", model: "claude-opus-5-5", status: "idle", cwd: LINKED_WT, labels: { role: "worker" } };
  const normEv = await backendEvents([
    { seq: 0, ts, type: "created", provider: "claude", model: "claude-opus-5-5" },
    { seq: 1, ts, type: "input", text: ORIG_PROMPT },
    { seq: 2, ts, type: "status", status: "running" },
    { seq: 3, ts, type: "output", text: "All tests pass. Done." },
    { seq: 4, ts, type: "turn_done", stopReason: "end_turn" },
    { seq: 5, ts, type: "status", status: "idle" },
  ], normAgent);
  assert.equal(normEv.filter((e) => e.kind === "upstream_exit").length, 0);

  // Cancelled worker emits no upstream_exit even if a quota error arrives.
  const cancelEv = await backendEvents([
    { seq: 0, ts, type: "created", provider: "claude", model: "claude-opus-5-5" },
    { seq: 1, ts, type: "input", text: ORIG_PROMPT },
    { seq: 2, ts, type: "status", status: "running" },
    { seq: 3, ts, type: "cancel" },
    { seq: 4, ts, type: "error", message: CLAUDE_LIMIT },
    { seq: 5, ts, type: "status", status: "idle" },
  ], normAgent);
  assert.equal(cancelEv.filter((e) => e.kind === "upstream_exit").length, 0);

  // Archived worker is never resumed.
  const f = fakeRunner({
    id: "rn-arch-mid",
    provider: "antigravity-cli",
    model: "claude-opus-5-5-high",
    archivedAt: new Date().toISOString(),
    timeline: MIDRUN_TIMELINE(AGY_NOTICE),
  });
  await emitQuotaWall(f, "rn-arch-mid", AGY_NOTICE, { cappedProviders: [AGY_CLAUDE_FAMILY] });
  assert.equal(f.created.length, 0);
  assert.match(metricsFor("rn-arch-mid").at(-1).text, /reason=archived/);
});

test("1101-9b: H1 — assistant text quoting a quota wall never caps a provider, fails a turn, or resumes a finished worker", async () => {
  // Classifier: streamed assistant output only ever matches agy's own whole-event pool notice.
  for (const text of [
    "RESOURCE_EXHAUSTED is now classified as a Gemini quota wall.",
    "Usage limit reached handling is covered by test 1101-2.",
    CLAUDE_LIMIT,
    GEMINI_QUOTA,
    "Quota exceeded for quota metric 'generate_content' in tests.",
  ]) assert.equal(providerFaultOf({ type: "output", text }), null, `output never a quota fault: ${text}`);
  assert.equal(providerFaultOf({ type: "output", text: AGY_NOTICE })?.kind, "quota", "agy's own pool notice still is (idea-1077)");

  // RunnerBackend, reviewer repro: a normally finished Gemini (ACP: one output per chunk) and Claude worker.
  const ts = Date.now();
  const cases = [
    { provider: "antigravity-cli", model: "gemini-4-neon-medium", chunk: "RESOURCE_EXHAUSTED is now classified as a Gemini quota wall." },
    { provider: "claude", model: "claude-opus-5-5", chunk: "Usage limit reached handling is covered by test 1101-2." },
    { provider: "claude", model: "claude-opus-5-5", chunk: CLAUDE_LIMIT },
  ];
  for (const [i, c] of cases.entries()) {
    writeCaps({});
    const agent = { id: `rn-h1-${i}`, provider: c.provider, model: c.model, status: "idle", cwd: LINKED_WT, labels: { role: "worker" } };
    const ev = await backendEvents([
      { seq: 0, ts, type: "created", provider: c.provider, model: c.model },
      { seq: 1, ts, type: "input", text: ORIG_PROMPT },
      { seq: 2, ts, type: "status", status: "running" },
      { seq: 3, ts, type: "output", text: c.chunk },
      { seq: 4, ts, type: "tool", phase: "call", id: "t1", name: "Bash", input: { command: "npm test" } },
      { seq: 5, ts, type: "tool", phase: "result", id: "t1", isError: false },
      { seq: 6, ts, type: "output", text: "All tests pass.\nPASS: done" },
      { seq: 7, ts, type: "turn_done", stopReason: "end_turn" },
      { seq: 8, ts, type: "status", status: "idle" },
      { seq: 9, ts, type: "exit", code: 0 },
    ], agent);
    assert.equal(ev.filter((e) => e.kind === "upstream_exit").length, 0, `${c.provider}: no upstream_exit`);
    const ended = ev.filter((e) => e.kind === "turn_ended");
    assert.equal(ended.length, 1);
    assert.equal(ended[0].outcome.kind, "completed", `${c.provider}: the worker's real report stays a completed turn`);
    assert.deepEqual(liveCaps(), {}, `${c.provider}: no provider capped`);
  }

  // L1: an exit whose reason quotes a quota wall AFTER the turn completed is not a mid-run death: no hand-off.
  writeCaps({});
  const late = await backendEvents([
    { seq: 0, ts, type: "created", provider: "opencode", model: "deepseek/deepseek-v4-pro" },
    { seq: 1, ts, type: "input", text: ORIG_PROMPT },
    { seq: 2, ts, type: "status", status: "running" },
    { seq: 3, ts, type: "output", text: "Done." },
    { seq: 4, ts, type: "status", status: "idle" },
    { seq: 5, ts, type: "exit", code: 1, error: DEEPSEEK_CREDIT, upstream: false },
  ], { id: "rn-l1", provider: "opencode", model: "deepseek/deepseek-v4-pro", status: "idle", cwd: LINKED_WT, labels: { role: "worker" } });
  assert.equal(late.filter((e) => e.kind === "upstream_exit").length, 0, "exit after a completed turn never resumes");
});

// ---- 7. Invariant #4: successor never runs git writes in the main checkout ----

test("1101-10: Invariant 4 — main checkout with no linked worktree is refused; sanctuary worktree resolves to linked path", async () => {
  // Main checkout with no worktree referenced -> refused with reason=main-checkout.
  const mainOnlyPrompt = "Unit 1101: edit app.js directly.";
  const mainTl = [
    { item: { type: "user_message", text: mainOnlyPrompt } },
    { item: { type: "tool_call", name: "Edit app.js", detail: { kind: "edit" } } },
    { item: { type: "assistant_message", text: AGY_NOTICE }, turnEnd: true },
  ];
  const fMain = fakeRunner({
    id: "rn-main-refuse",
    provider: "antigravity-cli",
    model: "claude-opus-5-5-high",
    cwd: MAIN_REPO,
    timeline: mainTl,
  });
  await emitQuotaWall(fMain, "rn-main-refuse", AGY_NOTICE, { cappedProviders: [AGY_CLAUDE_FAMILY] });
  assert.equal(fMain.created.length, 0, "never spawns mid-run successor in main checkout");
  assert.match(metricsFor("rn-main-refuse").at(-1).text, /reason=main-checkout/);

  // Main checkout worker whose prompt created a verified sanctuary worktree -> resumes INSIDE the linked worktree.
  const fSanctuary = fakeRunner({
    id: "rn-main-to-wt",
    provider: "antigravity-cli",
    model: "claude-opus-5-5-high",
    cwd: MAIN_REPO,
    timeline: MIDRUN_TIMELINE(AGY_NOTICE),
  });
  await emitQuotaWall(fSanctuary, "rn-main-to-wt", AGY_NOTICE, { cappedProviders: [AGY_CLAUDE_FAMILY] });
  assert.equal(fSanctuary.created.length, 1);
  assert.equal(fSanctuary.created[0].cwd, LINKED_WT, "successor cwd is the linked worktree, never main checkout");

  // Direct helper checks.
  assert.equal((await resolveWorkerWorktree(MAIN_REPO, "no worktree here", [], { vsHome: VS_HOME })).kind, "main-checkout");
  assert.equal((await resolveWorkerWorktree(LINKED_WT, "", [], { vsHome: VS_HOME })).kind, "worktree");
  assert.equal(extractLastWorkerReport(MIDRUN_TIMELINE(AGY_NOTICE), AGY_NOTICE), LAST_REPORT);
});
