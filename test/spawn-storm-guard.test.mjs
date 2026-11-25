// idea-820/826/821 (dups 660/825/846/727/787): the spawn-storm guard.
// - providerFaultOf sorts runner events into provider faults (balance / binary-missing / upstream) vs task faults.
// - an "Insufficient Balance" error event caps the provider for 60 min and never shortens a longer cap.
// - a lane whose last 3 worker spawns failed at start is held; a completed first turn clears it.
// - spawn_worker into a held lane is refused, with exactly one needs-you line per hold.
// - a spawn ENOENT whose cwd is gone reads "working directory not found", not "binary not found".
import "./helpers/clean-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BALANCE_CAP_TTL_MS, BINARY_CAP_TTL_MS, SPAWN_FAIL_WINDOW_MS, UPSTREAM_CAP_TTL_MS,
  capProviderOnUpstreamExit, providerFaultOf, spawnOutcomeOf,
} from "../server/backend/runner-backend.mjs";
import {
  FAIL_STREAK_COOLDOWN_MAX_MS, FAIL_STREAK_COOLDOWN_MS, FAIL_STREAK_MAX,
  claimHoldNotice, laneSpawnHold, noteLaneSpawnOutcome, spawnStreakPath, stepLaneStreak,
} from "../server/spawn-streak.mjs";
import { spawnErrorMessage } from "../runner/spawn.mjs";
import { callTool, createContext } from "../server/mcp/tools.mjs";
import { verifiedIdentity } from "./helpers/agent-token.mjs";
import { USER_PROFILES } from "./helpers/route-golden.mjs";

process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
const dirs = [];
test.after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), "vs-storm-")); dirs.push(d); return d; };
const MIN = 60_000;
const BALANCE = "Internal error: Insufficient Balance";

// ---- providerFaultOf ----

test("providerFaultOf: balance on error and exit events is a 60-min balance fault", () => {
  for (const e of [
    { type: "error", message: BALANCE },
    { type: "exit", code: 1, error: `opencode exited (code 1) after: ${BALANCE}` },
    { type: "error", message: "Your credit balance is too low to access the API" },
    { type: "error", message: "429 insufficient_quota: You exceeded your current quota" },
  ]) {
    const f = providerFaultOf(e);
    assert.equal(f?.kind, "balance", JSON.stringify(e));
    assert.equal(f.ttlMs, BALANCE_CAP_TTL_MS);
  }
  assert.equal(BALANCE_CAP_TTL_MS, 60 * MIN);
});

test("providerFaultOf: a missing binary is a 10-min fault only while the agent's cwd exists", () => {
  const cwd = tmp();
  const e = { type: "exit", code: null, error: "claude binary not found at /home/u/.local/bin/claude" };
  assert.deepEqual(providerFaultOf(e, { cwd }), { kind: "binary-missing", ttlMs: BINARY_CAP_TTL_MS, msg: e.error });
  assert.equal(providerFaultOf({ type: "exit", error: 'executable "agy" not found on PATH' }, { cwd })?.kind, "binary-missing");
  // The cited runs: the binary was there, the swept worktree was not. Not a provider fault, so no cap.
  assert.equal(providerFaultOf(e, { cwd: path.join(cwd, "swept-worktree") }), null);
  assert.equal(providerFaultOf(e, { cwd: "/x", exists: () => { throw new Error("EACCES"); } }), null);
});

test("providerFaultOf: upstream exits keep idea-442; task errors, cancels and other events are not provider faults", () => {
  assert.equal(providerFaultOf({ type: "exit", code: 1, error: "Internal service failure", upstream: true })?.kind, "upstream");
  assert.equal(providerFaultOf({ type: "exit", code: 1, error: "Internal service failure", upstream: true }).ttlMs, UPSTREAM_CAP_TTL_MS);
  assert.equal(providerFaultOf({ type: "error", message: "x", upstream: true }), null); // upstream only via an exit
  for (const e of [
    { type: "exit", code: 1, error: "tool call failed: bad schema" },
    { type: "exit", code: 0 },
    { type: "error", message: "permission denied for Bash" },
    { type: "status", status: "idle", message: BALANCE },
    { type: "output", text: BALANCE },
    null,
  ]) assert.equal(providerFaultOf(e), null, JSON.stringify(e));
});

// ---- the provider breaker on a balance error event ----

test("an Insufficient Balance ERROR event (agent stays parked) caps the provider for 60 min", () => {
  const calls = [], logs = [], now = Date.now();
  const r = capProviderOnUpstreamExit("opencode", { type: "error", message: BALANCE, ts: now }, { cap: (...a) => calls.push(a), readCaps: () => ({}), log: (m) => logs.push(m), now });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "opencode");
  assert.equal(calls[0][2].ttlMs, BALANCE_CAP_TTL_MS);
  assert.match(calls[0][2].reason, /^insufficient balance: /);
  assert.match(logs[0], /opencode capped for 60 min: insufficient balance/);
  assert.equal(r.kind, "balance");
});

test("the breaker never shortens a longer cap: manual (no resetsAt) and later resetsAt are kept; a shorter one is extended", () => {
  const now = Date.now();
  const run = (have) => {
    const calls = [];
    const r = capProviderOnUpstreamExit("opencode", { type: "error", message: BALANCE, ts: now }, { cap: (...a) => calls.push(a), readCaps: () => have, log() {}, now });
    return { r, calls };
  };
  for (const have of [{ opencode: { reason: "manual vs cap" } }, { opencode: { resetsAt: now + 3 * 60 * MIN } }, { opencode: { resetsAt: now + BALANCE_CAP_TTL_MS } }]) {
    const { r, calls } = run(have);
    assert.equal(r, null, JSON.stringify(have));
    assert.equal(calls.length, 0, JSON.stringify(have));
  }
  // A 10-min upstream cap already on: the balance fault extends it to 60 min.
  const { calls } = run({ opencode: { resetsAt: now + UPSTREAM_CAP_TTL_MS } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].ttlMs, BALANCE_CAP_TTL_MS);
  // An upstream fault never cuts a live balance cap down to 10 min.
  const calls2 = [];
  assert.equal(capProviderOnUpstreamExit("opencode", { type: "exit", upstream: true, error: "Internal service failure", ts: now }, { cap: (...a) => calls2.push(a), readCaps: () => ({ opencode: { resetsAt: now + 50 * MIN } }), log() {}, now }), null);
  assert.equal(calls2.length, 0);
});

test("a gone-cwd 'binary not found' exit caps nothing (the provider is fine)", () => {
  const cap = () => assert.fail("must not cap");
  const e = { type: "exit", code: null, error: "claude binary not found at /home/u/.local/bin/claude" };
  assert.equal(capProviderOnUpstreamExit("claude", e, { cwd: path.join(tmp(), "gone"), cap, readCaps: () => ({}), log() {} }), null);
});

// ---- the lane streak ----

test("stepLaneStreak: 3 failed first turns trip a hold; a completed first turn clears it", () => {
  const now = 1_000_000_000;
  let rec;
  for (let i = 1; i <= FAIL_STREAK_MAX; i++) {
    const out = stepLaneStreak(rec, { agentId: `rn-f${i}`, outcome: "failed", error: BALANCE, now: now + i });
    rec = out.rec;
    assert.equal(out.tripped, i === FAIL_STREAK_MAX, `after ${i}`);
  }
  assert.equal(FAIL_STREAK_MAX, 3);
  assert.equal(rec.heldUntil, now + 3 + FAIL_STREAK_COOLDOWN_MS);
  assert.equal(rec.trips, 1);
  const cleared = stepLaneStreak(rec, { agentId: "rn-ok", outcome: "completed", now: now + 10 }).rec;
  assert.deepEqual([cleared.fails, cleared.trips, cleared.heldUntil], [[], 0, 0]);
});

test("stepLaneStreak: later turns of a worker that completed are ignored; repeat ids, cancels and stale fails don't count", () => {
  const now = 1_000_000_000;
  let { rec } = stepLaneStreak(undefined, { agentId: "rn-a", outcome: "completed", now });
  for (let i = 0; i < 5; i++) rec = stepLaneStreak(rec, { agentId: "rn-a", outcome: "failed", now: now + i }).rec; // a running worker's later turns
  rec = stepLaneStreak(rec, { agentId: "rn-b", outcome: "failed", now }).rec;
  rec = stepLaneStreak(rec, { agentId: "rn-b", outcome: "failed", now }).rec; // same id twice: one failure
  rec = stepLaneStreak(rec, { agentId: "rn-c", outcome: "cancelled", now }).rec;
  assert.equal(rec.fails.length, 1);
  assert.equal(rec.heldUntil, 0);
  // A failure older than the window drops out: two fresh fails after it do not trip.
  const later = now + 2 * 60 * MIN;
  rec = stepLaneStreak(rec, { agentId: "rn-d", outcome: "failed", now: later }).rec;
  const out = stepLaneStreak(rec, { agentId: "rn-e", outcome: "failed", now: later });
  assert.equal(out.tripped, false);
  assert.equal(out.rec.fails.length, 2);
});

test("stepLaneStreak: a failed probe after the cooldown re-trips with a doubled cooldown, capped at 60 min", () => {
  let now = 1_000_000_000, rec, n = 0;
  const fail = () => { const out = stepLaneStreak(rec, { agentId: `rn-${++n}`, outcome: "failed", now }); rec = out.rec; return out.tripped; };
  fail(); fail(); assert.equal(fail(), true);
  const cooldowns = [rec.heldUntil - now];
  for (let trip = 2; trip <= 5; trip++) {
    now = rec.heldUntil + 1;
    assert.equal(fail(), true, `trip ${trip}`);
    cooldowns.push(rec.heldUntil - now);
  }
  assert.deepEqual(cooldowns, [10, 20, 40, 60, 60].map((m) => m * MIN));
  assert.equal(FAIL_STREAK_COOLDOWN_MAX_MS, 60 * MIN);
  // A failure inside a live hold extends nothing.
  const held = rec.heldUntil;
  assert.equal(fail(), false);
  assert.equal(rec.heldUntil, held);
  // A hold that ended longer than the window ago starts fresh: one failure doesn't re-trip; the third trips a 10-min hold.
  now = held + 2 * 60 * MIN;
  assert.equal(fail(), false);
  assert.equal(fail(), false);
  assert.equal(fail(), true);
  assert.equal(rec.heldUntil - now, FAIL_STREAK_COOLDOWN_MS);
});

test("noteLaneSpawnOutcome + laneSpawnHold: the hold holds after 3 failures and clears on a success (shared file)", async () => {
  const file = path.join(tmp(), "lane-spawn-streaks.json");
  const now = Date.now();
  for (let i = 1; i <= 3; i++) await noteLaneSpawnOutcome({ team: "MX", lane: "Feat", agentId: `rn-${i}`, outcome: "failed", error: `boom ${i}`, now }, { file });
  const hold = laneSpawnHold({ team: "mx", lane: "feat", now }, { file }); // key is case-insensitive
  assert.ok(hold);
  assert.equal(hold.streak, 3);
  assert.deepEqual(hold.ids, ["rn-1", "rn-2", "rn-3"]);
  assert.equal(hold.lastError, "boom 3");
  assert.equal(hold.until, now + FAIL_STREAK_COOLDOWN_MS);
  assert.equal(laneSpawnHold({ team: "mx", lane: "other", now }, { file }), null);
  assert.equal(laneSpawnHold({ team: "mx", lane: "feat", now: hold.until }, { file }), null); // expired
  assert.equal(await claimHoldNotice({ team: "mx", lane: "feat", now }, { file }), true);
  assert.equal(await claimHoldNotice({ team: "mx", lane: "feat", now }, { file }), false);
  await noteLaneSpawnOutcome({ team: "mx", lane: "feat", agentId: "rn-ok", outcome: "completed", now }, { file });
  assert.equal(laneSpawnHold({ team: "mx", lane: "feat", now }, { file }), null);
  // Unknown outcomes and missing lanes are no-ops.
  assert.equal(await noteLaneSpawnOutcome({ team: "mx", lane: "feat", agentId: "rn-x", outcome: "cancelled", now }, { file }), null);
  assert.equal(await noteLaneSpawnOutcome({ team: "mx", lane: "", agentId: "rn-x", outcome: "failed", now }, { file }), null);
  assert.equal(spawnStreakPath({ VIBESQUAD_HOME: "/h" }), path.join("/h", "lane-spawn-streaks.json"));
});

test("spawnOutcomeOf: only a fresh worker's turn_ended in a lane feeds the streak", () => {
  const now = Date.now();
  const worker = (over = {}) => ({ id: "rn-w", createdAt: new Date(now - MIN).toISOString(), labels: { role: "worker", lane: "feat", team: "mx" }, ...over });
  const ended = (kind, message) => ({ kind: "turn_ended", outcome: kind === "failed" ? { kind, error: { message } } : { kind } });
  assert.deepEqual(spawnOutcomeOf(worker(), ended("failed", BALANCE), { at: now }), { team: "mx", lane: "feat", agentId: "rn-w", outcome: "failed", error: BALANCE });
  assert.equal(spawnOutcomeOf(worker(), ended("completed"), { at: now }).outcome, "completed");
  assert.equal(spawnOutcomeOf(worker(), ended("cancelled"), { at: now }), null);
  assert.equal(spawnOutcomeOf(worker(), { kind: "turn_started" }, { at: now }), null);
  assert.equal(spawnOutcomeOf(worker({ labels: { role: "worker" } }), ended("failed", "x"), { at: now }), null); // no lane
  assert.equal(spawnOutcomeOf(worker({ labels: { role: "lead", lane: "feat", lead: "feat" } }), ended("failed", "x"), { at: now }), null);
  assert.equal(spawnOutcomeOf(worker({ labels: { role: "brainstorm", lane: "feat" } }), ended("failed", "x"), { at: now }), null);
  // A parked worker re-prompted hours later into a swept worktree (rn-bc6c5973958c) is stale reuse, not a failed spawn.
  const old = worker({ createdAt: new Date(now - SPAWN_FAIL_WINDOW_MS - 1).toISOString() });
  assert.equal(spawnOutcomeOf(old, ended("failed", "working directory not found: /w"), { at: now }), null);
  assert.equal(spawnOutcomeOf(old, ended("completed"), { at: now }).outcome, "completed"); // a success still clears
  assert.equal(spawnOutcomeOf(worker({ createdAt: undefined }), ended("failed", "x"), { at: now }), null);
});

// ---- spawn_worker refusal ----

const TEAMS = [{ id: "mx", name: "Matrix", paths: ["matrix"], lanes: [{ id: "feat", name: "Feat" }, { id: "calm", name: "Calm" }, { id: "hub", name: "Hub", hub: true }] }];

function spawnCtx(home, identity) {
  const creates = [], logs = [];
  const backend = {
    createAgent: async (req) => { creates.push(req); return { id: `rn-new${creates.length}`, title: req.config.title }; },
    sendAgentPrompt: async () => {},
    fetchAgents: async () => ({ entries: [] }),
  };
  const ctx = createContext({
    env: { VIBESQUAD_HOME: home, VS_EXP6_END: "2999-01-01T00:00:00Z" },
    ...verifiedIdentity(identity, { backend, teams: TEAMS }),
    cwd: "/w",
    teams: TEAMS,
    loadProfiles: async () => USER_PROFILES,
    withBackend: async (_t, fn) => fn(backend),
    findLiveLeads: async () => [],
    writeLog: async (entry) => { logs.push(entry); return entry; },
  });
  return { ctx, creates, logs };
}
const spawn = (ctx, args) => callTool(ctx, "spawn_worker", { title: "t", prompt: "go", profile: "Implement", labels: { ab: "pin" }, ...args });
const callError = async (p) => { try { const r = await p; return r?.isError ? String(r.content?.[0]?.text ?? JSON.stringify(r)) : null; } catch (e) { return String(e?.message ?? e); } };

async function holdLane(home, lane = "feat") {
  const file = spawnStreakPath({ VIBESQUAD_HOME: home });
  for (let i = 1; i <= 3; i++) await noteLaneSpawnOutcome({ team: "mx", lane, agentId: `rn-dead${i}`, outcome: "failed", error: BALANCE }, { file });
  assert.ok(laneSpawnHold({ team: "mx", lane }, { file }));
}

test("spawn_worker into a held lane is refused, and only the first refusal logs a needs-you", async () => {
  const home = tmp();
  await holdLane(home);
  const { ctx, creates, logs } = spawnCtx(home, { agentId: "rn-lead1", team: "mx", lane: "feat", role: "lead" });
  const e1 = await callError(spawn(ctx));
  const e2 = await callError(spawn(ctx));
  assert.match(e1 ?? "", /SPAWN HOLD lane feat: last 3 worker spawns failed at start \(rn-dead1, rn-dead2, rn-dead3; last: Internal error: Insufficient Balance\)/);
  assert.match(e2 ?? "", /SPAWN HOLD lane feat/);
  assert.equal(creates.length, 0);
  const needs = logs.filter((l) => l.type === "needs-you");
  assert.equal(needs.length, 1);
  assert.match(needs[0].text, /^SPAWN HOLD lane feat: .* spawn_worker refused until \d{1,2}:\d{2} [AP]M E[SD]T/);
});

test("a held lane does not block other lanes, lead spawns, or spawns after a success clears it", async () => {
  const home = tmp();
  await holdLane(home);
  const calm = spawnCtx(home, { agentId: "rn-lead2", team: "mx", lane: "calm", role: "lead" });
  assert.equal(await callError(spawn(calm.ctx)), null);
  assert.equal(calm.creates.length, 1);
  // A Buddy starting the lane's lead is exempt (the lead is how the owner's side fixes the cause).
  const bud = spawnCtx(home, { agentId: "rn-bud1", team: "mx", lane: "feat", role: "brainstorm" });
  assert.equal(await callError(spawn(bud.ctx, { profile: "lead", labels: { role: "lead" } })), null);
  assert.equal(bud.creates[0]?.labels.role, "lead");
  assert.equal(bud.logs.filter((l) => l.type === "needs-you").length, 0);
  await noteLaneSpawnOutcome({ team: "mx", lane: "feat", agentId: "rn-fine", outcome: "completed" }, { file: spawnStreakPath({ VIBESQUAD_HOME: home }) });
  const lead = spawnCtx(home, { agentId: "rn-lead1", team: "mx", lane: "feat", role: "lead" });
  assert.equal(await callError(spawn(lead.ctx)), null);
  assert.equal(lead.creates.length, 1);
});

test("a worker caller refused by a hold does not spend the one needs-you (it may not log needs-you); the lead's refusal logs it", async () => {
  const home = tmp();
  await holdLane(home);
  const w = spawnCtx(home, { agentId: "rn-wk1", team: "mx", lane: "feat", role: "worker" });
  assert.match((await callError(spawn(w.ctx))) ?? "", /SPAWN HOLD/);
  assert.equal(w.logs.length, 0);
  const lead = spawnCtx(home, { agentId: "rn-lead1", team: "mx", lane: "feat", role: "lead" });
  assert.match((await callError(spawn(lead.ctx))) ?? "", /SPAWN HOLD/);
  assert.equal(lead.logs.filter((l) => l.type === "needs-you").length, 1);
});

// ---- the cwd-gone diagnosis ----

test("spawnErrorMessage: ENOENT with a gone cwd names the working directory, not the binary", () => {
  const live = tmp();
  const gone = path.join(live, "swept-worktree");
  const err = { code: "ENOENT", path: "/home/u/.local/bin/claude" };
  assert.equal(spawnErrorMessage("claude", err, { cwd: gone }), `working directory not found: ${gone} (spawn claude ENOENT; worktree removed?)`);
  assert.equal(spawnErrorMessage("claude", err, { cwd: live }), "claude binary not found at /home/u/.local/bin/claude");
  assert.equal(spawnErrorMessage("claude", err), "claude binary not found at /home/u/.local/bin/claude");
  // Its wording never matches the binary-missing provider fault, so a swept worktree never caps the provider.
  assert.equal(providerFaultOf({ type: "exit", error: spawnErrorMessage("agy", err, { cwd: gone }) }), null);
  writeFileSync(path.join(live, "f"), "x"); // a cwd that exists stays a binary miss even with content in it
  assert.match(spawnErrorMessage("agy", err, { cwd: live }), /^agy binary not found/);
});
