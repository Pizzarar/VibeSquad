// idea-1077 (@bug, PLAN_INBOX_1126H H3): antigravity-cli's "⚠ Third-party quota reached ... Resets in 3h45m18s." arrives as plain
// assistant output, then turn_done end_turn (no error, no exit: rn-a98dee240ac9, rn-72c0e3437620). It must cap only the agy pool
// the agent ran on (agy-claude for a Claude id, antigravity-cli for Gemini) until the parsed reset, never touch an owner `vs cap`,
// end the turn failed (no NO-VERDICT digest), and hand a worker with no real turn to the upstream respawn, which walks its own
// role chain past the capped pool. Temp homes only: never reads or writes the host's ~/.vibesquad.
import "./helpers/clean-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), "vs-1077-")); tmpDirs.push(d); return d; };
const VS_HOME = tmp();
process.env.VIBESQUAD_HOME = VS_HOME;
process.env.VIBESQUAD_ROOT = tmp();
const CAPS = path.join(VS_HOME, "capped-providers.json");
process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = CAPS;
const CWD = path.join(tmp(), "VibeSquad");
mkdirSync(CWD, { recursive: true });
writeFileSync(
  path.join(VS_HOME, "teams.json"),
  JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "bug-chaser", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] }),
);

const rb = await import("../server/backend/runner-backend.mjs");
const { RunnerBackend, agyQuotaOf, providerFaultOf, capProviderOnUpstreamExit, markQuotaTurn, reduceTurn, AGY_QUOTA_RE } = rb;
const { createRunnerHookHost } = await import("../server/backend/runner-hooks.mjs");
const { upstreamRespawnPlan, RESPAWN_OF_LABEL } = await import("../server/hooks/agent-duties.ts");
const { FAILOVER_FROM_LABEL } = await import("../server/lead-handoff.mjs");
const { isProviderOverQuota, readLiveCapDoc, setProviderCapped, spawnFamily } = await import("../server/provider-failover.mjs");
const { resolveRoute } = await import("../server/role-route.mjs");
const { QUOTA_WINDOW_MS } = await import("../server/limits-read.mjs");
const { AGY_CLAUDE_FAMILY } = await import("../server/model-ids.mjs");
const { isDeliberateCap } = await import("../server/credit-guard.mjs");

const NOTICE = "\n⚠ Third-party quota reached. Please switch to Gemini models or upgrade your subscription to increase your limits. Resets in 3h45m18s.\n";
const RESET_MS = (3 * 3600 + 45 * 60 + 18) * 1000;
const NOW = Date.now(); // live-ish clock: the respawn hook judges exit age against Date.now()
const MIN = 60_000;
const writeCaps = (capped) => writeFileSync(CAPS, JSON.stringify({ capped }));
const liveCaps = (now) => readLiveCapDoc({ cappedProvidersPath: CAPS, now }).capped;
const LOG = path.join(VS_HOME, "teams", "vibesquad", "log.jsonl");
const teamLog = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// ---- 1. classifier ----

test("1077-1: the agy quota notice is classified, with its reset parsed (XhYmZs, d, clamped to the weekly window)", () => {
  assert.deepEqual(agyQuotaOf(NOTICE), { msg: NOTICE.trim(), resetInMs: RESET_MS });
  assert.equal(agyQuotaOf("⚠ Third-party quota reached. Resets in 45m").resetInMs, 45 * MIN);
  assert.equal(agyQuotaOf("⚠ Third-party quota reached. Resets in 12s.").resetInMs, 12_000);
  assert.equal(agyQuotaOf("Third-party quota reached. Resets in 1d2h").resetInMs, 26 * 3600_000);
  assert.equal(agyQuotaOf("⚠ Third-party quota reached. Resets in 30d").resetInMs, QUOTA_WINDOW_MS.weekly, "clamped (fu3 M1)");
  assert.equal(agyQuotaOf("⚠ Third-party quota reached. Please upgrade.").resetInMs, null, "no reset: null, still a quota notice");
  // Only the whole (short) event: a reply quoting it among other text, or long prose, never counts.
  assert.equal(agyQuotaOf(`The worker said: ${NOTICE.trim()}`), null);
  assert.equal(agyQuotaOf(`${NOTICE.trim()}\nso I switched to Gemini.`), null);
  assert.equal(agyQuotaOf(`⚠ Third-party quota reached. ${"x".repeat(500)}`), null);
  assert.equal(agyQuotaOf("quota reached"), null);
  assert.ok(AGY_QUOTA_RE.test("⚠️ Third-party quota reached. Resets in 1h"), "emoji presentation selector");
  // providerFaultOf: an output event (how agy sends it) and an error event both classify as `quota` with the TTL to the reset.
  const out = providerFaultOf({ type: "output", text: NOTICE });
  assert.equal(out.kind, "quota");
  assert.equal(out.ttlMs, RESET_MS);
  assert.equal(providerFaultOf({ type: "error", message: NOTICE.trim() }).kind, "quota");
  assert.equal(providerFaultOf({ type: "output", text: "Done. All tests pass." }), null, "ordinary output is no fault");
});

// ---- 2. auto cap: agy pool only, until the reset; owner caps untouched ----

test("1077-2: agy-claude is capped until the parsed reset; agy Gemini and native claude stay routable; the cap lifts at the reset", () => {
  writeCaps({});
  const e = { type: "output", text: NOTICE, ts: NOW };
  const out = capProviderOnUpstreamExit(AGY_CLAUDE_FAMILY, e, { now: NOW, pool: () => [], log() {} });
  assert.equal(out?.kind, "quota");
  assert.equal(out.ttlMs, RESET_MS, "exactly to the parsed reset (no 35 min floor when the provider names its reset)");
  const caps = liveCaps(NOW);
  assert.deepEqual(Object.keys(caps), [AGY_CLAUDE_FAMILY], "only the agy Claude pool");
  assert.equal(caps[AGY_CLAUDE_FAMILY].resetsAt, NOW + RESET_MS);
  assert.match(caps[AGY_CLAUDE_FAMILY].reason, /^third-party quota: ⚠ Third-party quota reached/);
  assert.equal(isDeliberateCap(caps[AGY_CLAUDE_FAMILY]), false, "an auto cap, never read as an owner cap");
  const opts = { cappedProvidersPath: CAPS, useDiskCaps: true, now: NOW };
  assert.equal(isProviderOverQuota(spawnFamily("antigravity-cli", "claude-opus-5-5-high"), [], 95, opts).overQuota, true);
  assert.equal(isProviderOverQuota(spawnFamily("antigravity-cli", "gemini-4-neon-medium"), [], 95, opts).overQuota, false, "agy Gemini is a separate pool");
  assert.equal(isProviderOverQuota("claude", [], 95, opts).overQuota, false, "native claude untouched");
  // Lifts at the reset time.
  assert.ok(liveCaps(NOW + RESET_MS - 1000)[AGY_CLAUDE_FAMILY], "still capped a second before the reset");
  assert.equal(liveCaps(NOW + RESET_MS + 1000)[AGY_CLAUDE_FAMILY], undefined, "lifted a second after the reset");
  assert.equal(isProviderOverQuota(AGY_CLAUDE_FAMILY, [], 95, { ...opts, now: NOW + RESET_MS + 1000 }).overQuota, false);
});

test("1077-3: the same notice on agy Gemini caps antigravity-cli (not agy-claude); on native claude it caps nothing", () => {
  writeCaps({});
  const e = { type: "output", text: NOTICE, ts: NOW };
  assert.equal(capProviderOnUpstreamExit(spawnFamily("antigravity-cli", "gemini-4-neon-medium"), e, { now: NOW, pool: () => [], log() {} })?.kind, "quota");
  assert.deepEqual(Object.keys(liveCaps(NOW)), ["antigravity-cli"]);
  writeCaps({});
  assert.equal(capProviderOnUpstreamExit("claude", e, { now: NOW, pool: () => [], log() {} }), null, "a native claude agent quoting it caps nothing");
  assert.deepEqual(liveCaps(NOW), {});
});

test("1077-4: an owner cli cap on agy-claude is never overwritten or cleared: the auto cap lifts, the manual one stays", () => {
  const manual = { reason: "cli cap", updatedAt: new Date(NOW - MIN).toISOString() };
  writeCaps({ [AGY_CLAUDE_FAMILY]: manual, opencode: { reason: "cli cap", updatedAt: new Date(NOW - MIN).toISOString() } });
  const e = { type: "output", text: NOTICE, ts: NOW };
  assert.equal(capProviderOnUpstreamExit(AGY_CLAUDE_FAMILY, e, { now: NOW, pool: () => [], log() {} }), null, "the owner cap already holds the pool");
  assert.deepEqual(JSON.parse(readFileSync(CAPS, "utf8")).capped[AGY_CLAUDE_FAMILY], manual, "byte-for-byte the owner's entry");
  assert.deepEqual(liveCaps(NOW + RESET_MS + 1000)[AGY_CLAUDE_FAMILY], manual, "past the quota reset the manual cap is still there");

  // Auto cap first, then the owner caps the pool by hand (`vs cap add agy-claude`): past the auto reset the manual one stays.
  writeCaps({});
  assert.ok(capProviderOnUpstreamExit(AGY_CLAUDE_FAMILY, { ...e, text: "⚠ Third-party quota reached. Resets in 30m" }, { now: NOW, pool: () => [], log() {} }));
  setProviderCapped(AGY_CLAUDE_FAMILY, true, { reason: "cli cap", cappedProvidersPath: CAPS, now: NOW + MIN });
  // A later quota notice never replaces it either.
  assert.equal(capProviderOnUpstreamExit(AGY_CLAUDE_FAMILY, { ...e, ts: NOW + 2 * MIN }, { now: NOW + 2 * MIN, pool: () => [], log() {} }), null);
  const after = liveCaps(NOW + 31 * MIN)[AGY_CLAUDE_FAMILY];
  assert.equal(after?.reason, "cli cap");
  assert.equal(after.resetsAt, undefined);
});

// ---- 3. routing while the pool is capped ----

test("1077-5: a capped agy-claude pool routes a ladder Claude spawn to native claude, same model; agy Gemini stays routable", () => {
  const top = resolveRoute({ role: "Implement", stakes: "tierA-invariant", caps: [] });
  assert.equal(top.provider, AGY_CLAUDE_FAMILY, "the 1057 agy rung still leads");
  assert.equal(top.model, "claude-opus-5-5-high");
  const capped = resolveRoute({ role: "Implement", stakes: "tierA-invariant", caps: [AGY_CLAUDE_FAMILY] });
  assert.equal(capped.provider, "claude");
  assert.equal(capped.model, "claude-opus-5-5");
  assert.equal(capped.effort, "high");
  assert.ok(capped.reasons.includes("failover"));
  const mid = resolveRoute({ role: "Implement", caps: [AGY_CLAUDE_FAMILY] });
  assert.equal(mid.provider, "claude");
  assert.equal(mid.model, "claude-sonnet-5-5");
  // Next uncapped rung of the same chain: agy-claude and claude both out -> agy Gemini.
  assert.equal(resolveRoute({ role: "Implement", caps: [AGY_CLAUDE_FAMILY, "claude"] }).provider, "antigravity-cli");
});

// ---- 4. the turn: failed (not completed), upstream_exit hand-off ----

/** A RunnerBackend whose fetch returns `agent`; returns the events it emits for the given log events. */
async function backendEvents(events, agent) {
  const vs = tmp();
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

// rn-a98dee240ac9's shape: created, input, session, running, output(notice), turn_done end_turn, idle, parked.
const quotaLog = (provider, model, ts = Date.now()) => [
  { seq: 0, ts, type: "created", provider, model },
  { seq: 1, ts, type: "input", text: "Unit usa-68 ..." },
  { seq: 2, ts, type: "session", sessionId: "s1", model },
  { seq: 3, ts, type: "status", status: "running" },
  { seq: 4, ts, type: "output", text: NOTICE },
  { seq: 5, ts, type: "turn_done", stopReason: "end_turn" },
  { seq: 6, ts, type: "status", status: "idle" },
  { seq: 7, ts, type: "status", status: "parked" },
];

test("1077-6: RunnerBackend: the notice turn on agy-claude ends failed, caps agy-claude, and emits upstream_exit quota:true once", async () => {
  writeCaps({});
  const ts = Date.now();
  const agent = { id: "rn-q1", provider: "antigravity-cli", model: "claude-sonnet-5-5-medium", status: "idle", cwd: CWD, labels: { role: "worker" } };
  const ev = await backendEvents(quotaLog(agent.provider, agent.model, ts), agent);
  const ended = ev.filter((e) => e.kind === "turn_ended");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].outcome.kind, "failed", "never `completed` (that is the NO-VERDICT digest path)");
  assert.equal(ended[0].outcome.error.message, NOTICE.trim());
  const ux = ev.filter((e) => e.kind === "upstream_exit");
  assert.equal(ux.length, 1);
  assert.equal(ux[0].quota, true);
  assert.equal(ux[0].error, NOTICE.trim());
  assert.equal(ux[0].ts, ts);
  assert.ok(ev.indexOf(ended[0]) < ev.indexOf(ux[0]), "turn_ended first (A4 sees it before the respawn claims)");
  const caps = liveCaps(Date.now());
  assert.deepEqual(Object.keys(caps), [AGY_CLAUDE_FAMILY]);
  assert.ok(Math.abs(caps[AGY_CLAUDE_FAMILY].resetsAt - (ts + RESET_MS)) < 5000);
});

test("1077-7: RunnerBackend: the same text from a native claude agent is an ordinary completed turn (no cap, no hand-off)", async () => {
  writeCaps({});
  const agent = { id: "rn-q2", provider: "claude", model: "claude-opus-5-5", status: "idle", cwd: CWD, labels: { role: "worker" } };
  const ev = await backendEvents(quotaLog(agent.provider, agent.model), agent);
  assert.equal(ev.find((e) => e.kind === "turn_ended").outcome.kind, "completed");
  assert.equal(ev.filter((e) => e.kind === "upstream_exit").length, 0);
  assert.deepEqual(liveCaps(Date.now()), {});
  // agy Gemini: its own family is capped, the hand-off still happens.
  const gem = { id: "rn-q3", provider: "antigravity-cli", model: "gemini-4-neon-medium", status: "idle", cwd: CWD, labels: { role: "worker" } };
  const gev = await backendEvents(quotaLog(gem.provider, gem.model), gem);
  assert.equal(gev.find((e) => e.kind === "turn_ended").outcome.kind, "failed");
  assert.deepEqual(Object.keys(liveCaps(Date.now())), ["antigravity-cli"]);
});

test("1077-8: markQuotaTurn / reduceTurn (pure): the next turn starts clean", () => {
  const t = { status: "idle", errored: false };
  assert.equal(markQuotaTurn(t, "x"), false, "outside a turn: nothing");
  reduceTurn(t, { type: "input" });
  reduceTurn(t, { type: "status", status: "running" });
  assert.equal(markQuotaTurn(t, NOTICE.trim()), true);
  assert.deepEqual(reduceTurn(t, { type: "status", status: "idle", seq: 9 }).outcome, { kind: "failed", error: { message: NOTICE.trim() } });
  reduceTurn(t, { type: "input" });
  reduceTurn(t, { type: "status", status: "running" });
  assert.equal(t.quotaFault, undefined);
  assert.equal(reduceTurn(t, { type: "status", status: "idle", seq: 12 }).outcome.kind, "completed");
});

// ---- 5. the respawn: only with 0 finished turns and no side-effecting tool call (reads are fine), down the role chain, failover labels ----

test("1077-9: upstreamRespawnPlan(quota): the closing turnEnd is the death; any earlier finished turn blocks it", () => {
  const w = { role: "worker", quota: true };
  const dead = [{ item: { type: "user_message", text: "go" } }, { item: { type: "assistant_message", text: NOTICE.trim() }, turnEnd: true }];
  assert.deepEqual(upstreamRespawnPlan(dead, {}, w), { prompt: "go" });
  assert.deepEqual(upstreamRespawnPlan(dead, {}, { role: "worker" }), { skip: "not-first-turn" }, "without quota a finished turn still blocks");
  const realTurn = [
    { item: { type: "user_message", text: "go" } },
    { item: { type: "assistant_message", text: "did it" }, turnEnd: true },
    { item: { type: "user_message", text: "now this" } },
    { item: { type: "assistant_message", text: NOTICE.trim() }, turnEnd: true },
  ];
  assert.deepEqual(upstreamRespawnPlan(realTurn, {}, w), { skip: "not-first-turn" });
  const edited = [{ item: { type: "user_message", text: "go" } }, { item: { type: "tool_call", name: "edit", detail: { kind: "edit" } } }, dead[1]];
  assert.match(upstreamRespawnPlan(edited, {}, w).skip, /^tool-edits/);
});

const LABELS = { team: "vibesquad", lane: "bug-chaser", role: "worker", profile: "Implement", job: "usa-68", ord: "2", stakes: "tierA-invariant", "vs.parent": "rn-lead1", provider: "antigravity-cli", model: "claude-opus-5-5-high" };

function fakeRunner(id, timeline) {
  const agents = new Map();
  const created = [];
  const backend = {
    async getAgent(aid) { const a = agents.get(aid); if (!a) throw new Error(`no agent ${aid}`); return { ...a, labels: { ...a.labels } }; },
    async fetchAgentTimeline() { return { entries: timeline.map((r, i) => ({ ...r, seqStart: i + 1, seqEnd: i + 1 })) }; },
    async listAgents() { return [...agents.values()].map((a) => ({ ...a, labels: { ...a.labels } })); },
    async createAgent({ config, prompt, labels: l }) {
      const a = { id: `rn-new-${created.length + 1}`, provider: config.provider, model: config.model, status: "running", labels: { ...l }, archivedAt: null };
      agents.set(a.id, a);
      created.push({ ...a, prompt });
      return { ...a };
    },
    async sendAgentPrompt() { return { queued: false }; },
    async archiveAgent() {},
    async updateAgent(aid, { labels: l } = {}) { const a = agents.get(aid); if (a && l) a.labels = { ...a.labels, ...l }; },
    async cancelAgent() {},
    async deleteHeartbeat() {},
  };
  agents.set(id, { id, title: "Usa3 · implementer", cwd: CWD, provider: "antigravity-cli", model: "claude-opus-5-5-high", status: "idle", labels: { ...LABELS }, archivedAt: null });
  return { backend, created };
}
const DEAD_TL = [{ item: { type: "user_message", text: "Unit usa-68: do the thing." } }, { item: { type: "assistant_message", text: NOTICE.trim() }, turnEnd: true }];

async function respawn(id, cappedProviders, timeline = DEAD_TL) {
  // Hermetic: the hook's failover (isProviderOverQuota) also reads VIBESQUAD_CAPPED_PROVIDERS_PATH for a family missing from
  // the usage list, so a live cap an earlier test left on disk (1077-7's agy Gemini cap) would leak into this route.
  writeCaps({});
  const f = fakeRunner(id, timeline);
  const host = await createRunnerHookHost(f.backend, { startWatcher: false, deps: { cappedProviders, retryBaseMs: 30 }, pollMs: 20 });
  try {
    const agent = await f.backend.getAgent(id);
    // The order RunnerBackend emits them: turn_ended(failed), then upstream_exit(quota).
    await host.emit("agent.turn_ended", { agent, turnId: "6", outcome: { kind: "failed", error: { message: NOTICE.trim() } } });
    await host.emit("agent.upstream_exit", { agent, error: NOTICE.trim(), ts: Date.now(), quota: true });
  } finally {
    host.dispose();
  }
  return f.created;
}

test("1077-10: a quota-dead agy-claude worker with no real turn is re-spawned once on native claude (same model), with failover labels", async () => {
  const created = await respawn("rn-qd1", [AGY_CLAUDE_FAMILY]);
  assert.equal(created.length, 1);
  const n = created[0];
  assert.equal(spawnFamily(n.provider, n.model), "claude", n.provider);
  assert.match(`${n.provider}/${n.model ?? ""}`, /claude-opus-5-5(?!-high)/, "the same ladder model on native claude");
  assert.equal(n.prompt, DEAD_TL[0].item.text);
  assert.equal(n.labels[RESPAWN_OF_LABEL], "rn-qd1");
  assert.equal(n.labels[FAILOVER_FROM_LABEL], "Implement");
  assert.match(n.labels["vs.failover"], /\(quota agy-claude\)$/);
  const decision = teamLog().filter((e) => e.type === "decision" && e.refs?.includes("rn-qd1")).at(-1);
  assert.match(decision.text, /hit the agy-claude quota in its first turn/);
  assert.ok(teamLog().some((e) => e.type === "metric" && /result=respawned agent=rn-qd1 .*cause=quota/.test(e.text)));
});

test("1077-11: with native claude capped too it takes the next uncapped rung of its chain (agy Gemini); a worker with a real turn is not respawned", async () => {
  const created = await respawn("rn-qd2", [AGY_CLAUDE_FAMILY, "claude"]);
  assert.equal(created.length, 1);
  assert.equal(spawnFamily(created[0].provider, created[0].model), "antigravity-cli", created[0].provider);
  const busy = [
    { item: { type: "user_message", text: "go" } },
    { item: { type: "assistant_message", text: "first turn done" }, turnEnd: true },
    { item: { type: "user_message", text: "next" } },
    { item: { type: "assistant_message", text: NOTICE.trim() }, turnEnd: true },
  ];
  assert.equal((await respawn("rn-qd3", [AGY_CLAUDE_FAMILY], busy)).length, 0, "had a real turn: the lead decides");
  assert.ok(teamLog().some((e) => e.type === "metric" && /result=skipped reason=not-first-turn agent=rn-qd3 /.test(e.text)));
});

test("1077-12: under the owner's No-DeepSeek cap (opencode capped) the respawn never lands on opencode: agy Gemini, else no respawn", async () => {
  const noDs = { opencode: { reason: "cli cap", updatedAt: new Date(NOW).toISOString() } };
  const toGemini = await respawn("rn-qd4", { [AGY_CLAUDE_FAMILY]: { reason: "q" }, claude: { reason: "q" }, ...noDs });
  assert.equal(toGemini.length, 1);
  assert.equal(spawnFamily(toGemini[0].provider, toGemini[0].model), "antigravity-cli", toGemini[0].provider);
  // Every rung of the chain out (agy Gemini too): no replacement at all, never opencode; the lead decides.
  const none = await respawn("rn-qd5", { [AGY_CLAUDE_FAMILY]: { reason: "q" }, claude: { reason: "q" }, "antigravity-cli": { reason: "q" }, ...noDs });
  assert.deepEqual(none.map((a) => a.provider), []);
  assert.ok(teamLog().some((e) => e.type === "metric" && /result=skipped reason=no-alternate agent=rn-qd5 /.test(e.text)));
});

// ---- idea-1080 (@bug, PLAN_INBOX_1126I I2): the quota turnEnd guard and the read-only rule, pinned on their own ----

const READ_CALLS = [
  { item: { type: "tool_call", name: "Read AGENTS.md", detail: { kind: "read" } } },
  { item: { type: "tool_call", name: "Grep upstreamRespawnPlan", detail: { kind: "search" } } },
  { item: { type: "tool_call", name: "think", detail: { kind: "think" } } },
  { item: { type: "tool_call", name: "WebFetch", detail: { kind: "fetch" } } },
];

test("1080-L1: 1 prompt + a real turnEnd + the quota turnEnd is NOT a first turn: only the LAST entry's turnEnd is the death", () => {
  const w = { role: "worker", quota: true };
  const tl = [
    { item: { type: "user_message", text: "go" } },
    { item: { type: "assistant_message", text: "done the first bit" }, turnEnd: true }, // a real finished turn (no new prompt after it)
    { item: { type: "assistant_message", text: NOTICE.trim() }, turnEnd: true }, // the quota death
  ];
  assert.equal(tl.filter((e) => e.item.type === "user_message").length, 1, "one prompt: the prompt count can't be what skips it");
  assert.deepEqual(upstreamRespawnPlan(tl, {}, w), { skip: "not-first-turn" });
  // The guard drops exactly one entry: the closing quota turnEnd. Alone it respawns; a turnEnd anywhere before it blocks.
  assert.deepEqual(upstreamRespawnPlan([tl[0], tl[2]], {}, w), { prompt: "go" });
  const midTurnEnd = [tl[0], tl[1], { item: { type: "assistant_message", text: "more" } }, tl[2]];
  assert.deepEqual(upstreamRespawnPlan(midTurnEnd, {}, w), { skip: "not-first-turn" });
});

test("1080-L1: the hook does not respawn a quota-dead worker with one prompt and an earlier finished turn", async () => {
  const tl = [DEAD_TL[0], { item: { type: "assistant_message", text: "first turn done" }, turnEnd: true }, DEAD_TL[1]];
  assert.equal((await respawn("rn-1080a", [AGY_CLAUDE_FAMILY], tl)).length, 0);
  assert.ok(teamLog().some((e) => e.type === "metric" && /result=skipped reason=not-first-turn agent=rn-1080a /.test(e.text)));
});

test("1080-L2: reads don't count as work (respawned); any edit, shell or unknown-kind call does (skipped)", () => {
  const w = { role: "worker", quota: true };
  const readOnly = [DEAD_TL[0], ...READ_CALLS, DEAD_TL[1]];
  assert.deepEqual(upstreamRespawnPlan(readOnly, {}, w), { prompt: DEAD_TL[0].item.text });
  for (const [kind, name] of [["edit", "Edit a.ts"], ["execute", "git commit"], ["delete", "rm x"], ["other", "mcp tool"], [undefined, "no kind"]]) {
    const tl = [DEAD_TL[0], ...READ_CALLS, { item: { type: "tool_call", name, detail: kind ? { kind } : {} } }, DEAD_TL[1]];
    assert.equal(upstreamRespawnPlan(tl, {}, w).skip, `tool-edits(${name})`, String(kind));
  }
});

test("1080-L2: a read-only agy-claude worker that hit the quota mid-turn is respawned once on native claude", async () => {
  const tl = [DEAD_TL[0], ...READ_CALLS, DEAD_TL[1]];
  const created = await respawn("rn-1080b", [AGY_CLAUDE_FAMILY], tl);
  assert.equal(created.length, 1);
  assert.equal(spawnFamily(created[0].provider, created[0].model), "claude", created[0].provider);
  assert.equal(created[0].prompt, DEAD_TL[0].item.text);
  const shell = [DEAD_TL[0], ...READ_CALLS, { item: { type: "tool_call", name: "npm test", detail: { kind: "execute" } } }, DEAD_TL[1]];
  assert.equal((await respawn("rn-1080c", [AGY_CLAUDE_FAMILY], shell)).length, 0, "a shell call may have changed files: the lead decides");
  assert.ok(teamLog().some((e) => e.type === "metric" && /result=skipped reason=tool-edits\(npm test\) agent=rn-1080c /.test(e.text)));
});
