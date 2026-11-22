// idea-197 (docs/PLAN_PER_POST03.md P4): the D2 coordinated-drain window guards the full-suite slot (scripts/run-tests.mjs)
// and the runtime sync (server/sync-runtime.mjs runSync). restartDrainPending reads the same deferralChain as the D2
// restart guard. Every test uses its own VIBESQUAD_HOME / VIBESQUAD_TEST_LOCK_DIR / LOCALAPPDATA, never the live ones.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDrainGuard, DRAIN_WINDOW_MS, drainedLeadIds, drainOverrideRequested, drainPendingMessage, restartDrainPending } from "../server/restart-coord.mjs";
import { runSync } from "../server/sync-runtime.mjs";
import { finishSlot, readQueue, suitePaths, tryAcquireSlot } from "../scripts/suite-lock.mjs";
import { readLock } from "../runner/lock.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_TESTS = path.join(root, "scripts", "run-tests.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmp(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const LEAD = { team: "efi", lane: "godot", leadId: "rn-lead1", leadTitle: "Godot3", heldAgents: ["rn-suite"] };
const stamp = (ms) => new Date(ms).toISOString();
const fileName = (ms) => `restart-${stamp(ms).replace(/[:.]/g, "-")}.json`;

/** A restart-<ts>.json as scripts/restart-runtime.mjs writes it: deferred (exit 4), ok, or a dry run. */
function restartRecord(home, { startedMs, finishedMs = startedMs + 60000, ok = false, deferred = true, dryRun = false, leads = [LEAD] }) {
  const rec = { ok, dryRun, startedAt: stamp(startedMs), finishedAt: stamp(finishedMs), errors: [] };
  if (deferred) rec.deferred = { held: 1, heldAgents: leads.flatMap((l) => l.heldAgents), running: 0, leads, unresolved: [] };
  writeFileSync(path.join(home, fileName(startedMs)), JSON.stringify(rec));
}

test("restartDrainPending: a deferral inside the D2 window is pending; a later ok restart, an expired window or a dry run is not", (t) => {
  const now = Date.parse("2026-11-17T12:00:00.000Z");
  const home = tmp(t, "vs-drain-home-");
  assert.equal(restartDrainPending(home, { now }), null, "no restart records");

  restartRecord(home, { startedMs: now - 15 * 60000, finishedMs: now - 10 * 60000 });
  const p = restartDrainPending(home, { now });
  assert.ok(p, "deferred 10 min ago");
  assert.equal(p.ageMin, 10);
  assert.equal(p.leftMin, 20);
  assert.deepEqual(p.leads.map((l) => l.leadId), ["rn-lead1"]);
  assert.match(p.deferral.file, /restart-2026-11-17T11-45-00-000Z\.json$/);

  // The D2 window is measured from the deferral's end, the same edge the restart guard uses.
  assert.equal(restartDrainPending(home, { now: now - 10 * 60000 + DRAIN_WINDOW_MS + 1000 }), null, "window over");

  // A dry run after it does not settle the drain; a successful restart does.
  restartRecord(home, { startedMs: now - 5 * 60000, dryRun: true, deferred: false });
  assert.ok(restartDrainPending(home, { now }), "dry run skipped");
  restartRecord(home, { startedMs: now - 2 * 60000, ok: true, deferred: false });
  assert.equal(restartDrainPending(home, { now }), null, "restart went through");
});

test("drainPendingMessage names the action, the asked leads, the record file and the remaining window", () => {
  const msg = drainPendingMessage("npm test", { deferral: { file: "/h/restart-x.json" }, leads: [LEAD], ageMin: 4, leftMin: 26 }, "Targeted runs still go.");
  assert.match(msg, /^npm test refused: a VS restart is waiting on a coordinated drain \(it deferred 4 min ago, \/h\/restart-x\.json; leads asked to drain: godot lead rn-lead1 \(Godot3\)\)\./);
  assert.match(msg, /'restart-done'/);
  assert.match(msg, /30-min drain window ends \(~26 min left\)/);
  assert.match(msg, /no timer retries\. Targeted runs still go\. Owner override \(the owner's shell only, per-run OK, logged as restart-feedback\): rerun with --ignore-drain or VIBESQUAD_IGNORE_DRAIN=1\.$/);
  assert.doesNotMatch(drainPendingMessage("sync-runtime", { deferral: null, leads: [], ageMin: 0, leftMin: 30 }), /leads asked/);
});

/** An owner's home: the local token readable (what ownerProofFromEnv / drainOverrideOwner check). */
function ownerHome(t) {
  const home = tmp(t, "vs-drain-home-");
  writeFileSync(path.join(home, "local-token"), "ab".repeat(32));
  return home;
}

test("drainOverrideRequested: the --ignore-drain flag or VIBESQUAD_IGNORE_DRAIN=1, nothing else", () => {
  assert.equal(drainOverrideRequested(["--ignore-drain"], {}), true);
  assert.equal(drainOverrideRequested([], { VIBESQUAD_IGNORE_DRAIN: "1" }), true);
  assert.equal(drainOverrideRequested([], { VIBESQUAD_IGNORE_DRAIN: "0" }), false);
  assert.equal(drainOverrideRequested(["--queue"], {}), false);
});

test("checkDrainGuard: the owner's override goes ahead and logs one restart-feedback line that never counts as a drain", (t) => {
  const now = Date.parse("2026-11-17T12:00:00.000Z");
  const home = ownerHome(t);
  const calls = [];
  const logVs = (args, env) => { calls.push({ args, env }); return { ok: true }; };
  const env = { VIBESQUAD_HOME: home };

  assert.deepEqual(checkDrainGuard("npm test", { vsHome: home, env, override: true, now, logVs }), { ok: true }, "no drain: nothing to override");
  assert.equal(calls.length, 0);

  restartRecord(home, { startedMs: now - 6 * 60000, finishedMs: now - 3 * 60000 });
  const refused = checkDrainGuard("npm test", { vsHome: home, env, override: false, now, logVs });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /^npm test refused: .*--ignore-drain/);

  const g = checkDrainGuard("npm test", { vsHome: home, env, override: true, now, logVs });
  assert.equal(g.ok, true);
  assert.equal(g.overridden, true);
  assert.equal(calls.length, 1, "exactly one log line");
  const [verb, type, text, ...where] = calls[0].args;
  assert.deepEqual([verb, type, where], ["log", "restart-feedback", ["--team", "efi", "--lane", "godot"]], "existing type, the first asked lead's lane");
  assert.match(text, /^drain-override npm test: the owner went ahead during the coordinated drain \(restart deferred 3 min ago, restart-2026-11-17T11-54-00-000Z\.json\)$/);
  assert.match(g.note, /--ignore-drain: going ahead .*logged restart-feedback in efi\/godot/);

  // The bypass line must never satisfy the D2 restart guard: it is not a 'drained restart'.
  mkdirSync(path.join(home, "teams", "efi"), { recursive: true });
  writeFileSync(path.join(home, "teams", "efi", "log.jsonl"), JSON.stringify({ ts: new Date(now).toISOString(), type: "metric", agent: "rn-lead1", text: `restart-feedback: ${text}` }) + "\n");
  assert.equal(drainedLeadIds(home, ["efi"], new Date(now - 3 * 60000).toISOString()).size, 0);

  // A failed log does not undo the owner's OK, and says so.
  const failed = checkDrainGuard("sync-runtime", { vsHome: home, env, override: true, now, logVs: () => ({ ok: false, error: "server down" }) });
  assert.equal(failed.ok, true);
  assert.match(failed.note, /restart-feedback log failed \(server down\); tell the asked leads/);
});

test("checkDrainGuard: the override from an agent shell, or without the owner's local token, is refused and logs nothing", (t) => {
  const now = Date.now();
  const home = ownerHome(t);
  restartRecord(home, { startedMs: now - 6 * 60000, finishedMs: now - 3 * 60000 });
  const logVs = () => assert.fail("no log for a refused override");
  for (const env of [{ VIBESQUAD_HOME: home, VS_AGENT_ID: "rn-lead1" }, { VIBESQUAD_HOME: home, VS_AGENT_TOKEN: "x" }, { VIBESQUAD_HOME: tmp(t, "vs-drain-notoken-") }]) {
    const g = checkDrainGuard("sync-runtime", { vsHome: home, env, override: true, now, logVs });
    assert.equal(g.ok, false, JSON.stringify(env));
    assert.match(g.message, /^sync-runtime --ignore-drain: needs the owner's per-run OK; only the owner's shell may pass it \(an agent or Overlord may not\)\. sync-runtime refused: /);
  }
});

/** A child env with this shell's agent identity stripped: drainOverrideOwner (server/restart-coord.mjs) reads all three
 *  keys to spot an agent shell, so an agent-run `node --test` passes the owner-path tests too. NODE_TEST_CONTEXT keeps
 *  the child out of the parent's test reporter. */
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ["VS_AGENT_ID", "PASEO_AGENT_ID", "VS_AGENT_TOKEN", "NODE_TEST_CONTEXT"]) delete env[k];
  return env;
}

test("run-tests.mjs: a full run is refused during a pending drain (with and without --queue); a targeted run still goes", { timeout: 60000 }, (t) => {
  const home = tmp(t, "vs-drain-home-");
  const dir = tmp(t, "vs-drain-lock-");
  restartRecord(home, { startedMs: Date.now() - 5 * 60000, finishedMs: Date.now() - 60000 });
  const env = cleanEnv({ VIBESQUAD_HOME: home, VIBESQUAD_TEST_LOCK_DIR: dir });
  for (const args of [[], ["--queue"]]) {
    const r = spawnSync(process.execPath, [RUN_TESTS, ...args], { cwd: root, env, encoding: "utf8", timeout: 30000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`^npm test${args.length ? " -- --queue" : ""} refused: a VS restart is waiting on a coordinated drain .*godot lead rn-lead1`, "m"));
    assert.match(r.stderr, /Targeted runs \(npm test -- <files>\) still go\./);
    assert.doesNotMatch(r.stdout, /ℹ tests/, "no suite ran");
  }
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("vibesquad-")), [], "no lock, queue or last record");

  const pass = path.join(dir, "pass.test.mjs");
  writeFileSync(pass, 'import test from "node:test";\ntest("ok case", () => {});\n');
  const targeted = spawnSync(process.execPath, [RUN_TESTS, pass], { cwd: root, env, encoding: "utf8", timeout: 30000 });
  assert.equal(targeted.status, 0, targeted.stdout + targeted.stderr);
  assert.match(targeted.stdout, /ℹ pass 1/);
});

test("run-tests.mjs: a queued full run leaves the queue when a drain starts while it waits", { timeout: 60000 }, async (t) => {
  const home = tmp(t, "vs-drain-home-");
  const dir = tmp(t, "vs-drain-lock-");
  const paths = suitePaths(dir);
  const held = tryAcquireSlot(paths, { agentId: "holder" });
  const q = spawn(process.execPath, [RUN_TESTS, "--queue"], { cwd: root, env: cleanEnv({ VIBESQUAD_HOME: home, VIBESQUAD_TEST_LOCK_DIR: dir }), stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => q.kill());
  let out = "";
  q.stdout.on("data", (d) => (out += d));
  q.stderr.on("data", (d) => (out += d));
  const code = new Promise((r) => q.on("exit", r));
  for (let i = 0; !out.includes("npm test queued: #1 of 1"); i++) {
    assert.ok(i < 400, `never queued: ${out}`);
    await sleep(25);
  }
  restartRecord(home, { startedMs: Date.now() - 5 * 60000, finishedMs: Date.now() });
  assert.equal(await code, 1, out);
  assert.match(out, /npm test -- --queue \(left the queue\) refused: a VS restart is waiting on a coordinated drain/);
  assert.doesNotMatch(out, /ℹ tests/, "never took the slot");
  assert.equal(readQueue(paths).known.size, 0, "the waiter wrote its done line on the way out");
  finishSlot(paths, held);
});

test("run-tests.mjs: the owner's --ignore-drain gets a full run past the drain guard (here into the queue) after one log attempt", { timeout: 60000 }, async (t) => {
  const home = ownerHome(t);
  const dir = tmp(t, "vs-drain-lock-");
  const paths = suitePaths(dir);
  restartRecord(home, { startedMs: Date.now() - 5 * 60000, finishedMs: Date.now() - 60000 });
  // The slot is held so the full run stops in the queue instead of running the whole suite; port 1 keeps the `vs log`
  // attempt off the live server (it fails fast, and the run still goes: the owner's OK stands).
  const held = tryAcquireSlot(paths, { agentId: "holder" });
  const q = spawn(process.execPath, [RUN_TESTS, "--queue", "--ignore-drain"], { cwd: root, env: cleanEnv({ VIBESQUAD_HOME: home, VIBESQUAD_TEST_LOCK_DIR: dir, VIBESQUAD_PORT: "1" }), stdio: ["ignore", "pipe", "pipe"] });
  const code = new Promise((r) => q.on("exit", r));
  let out = "";
  q.stdout.on("data", (d) => (out += d));
  q.stderr.on("data", (d) => (out += d));
  for (let i = 0; !out.includes("npm test queued: #1 of 1"); i++) {
    assert.ok(i < 1200, `never queued: ${out}`);
    await sleep(25);
  }
  await sleep(2500); // past one DRAIN_POLL_MS tick: the waiter stays queued and logs nothing more
  q.kill();
  await code;
  assert.equal(readLock(paths.lock)?.agentId, "holder", "the slot rules still apply: it waited behind the holder");
  finishSlot(paths, held);
  assert.doesNotMatch(out, /refused/);
  assert.equal(out.match(/npm test -- --queue: --ignore-drain: going ahead during the coordinated drain/g)?.length, 1, out);
});

// sync-runtime: a git repo on master, clean, with a fake runtime under LOCALAPPDATA (never the live one).
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
function syncRepo(t) {
  const dir = tmp(t, "vs-drain-repo-");
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(path.join(dir, "server"), { recursive: true });
  writeFileSync(path.join(dir, "server", "x.mjs"), "export const x = 1;\n");
  writeFileSync(path.join(dir, ".gitignore"), "dist/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  const lad = tmp(t, "vs-drain-lad-");
  const runtime = path.join(lad, "VibeSquad", "runtime");
  mkdirSync(runtime, { recursive: true });
  return { dir, runtime, env: { LOCALAPPDATA: lad, VIBESQUAD_HOME: tmp(t, "vs-drain-home-") } };
}

test("runSync: refused during a pending drain (even with --force), a dry run still reports, and it syncs once the restart went through", (t) => {
  const { dir, runtime, env } = syncRepo(t);
  const now = Date.now();
  restartRecord(env.VIBESQUAD_HOME, { startedMs: now - 5 * 60000, finishedMs: now - 2 * 60000 });
  const noBuild = () => assert.fail("no UI input: no build");
  for (const force of [false, true]) {
    const lines = [];
    const res = runSync({ repoRoot: dir, env, force, build: noBuild, log: (l) => lines.push(l) });
    assert.equal(res.synced, false);
    assert.equal(res.drainPending, true);
    assert.match(res.refused, /^sync-runtime refused: a VS restart is waiting on a coordinated drain \(it deferred 2 min ago/);
    assert.match(lines.join("\n"), /\[sync-runtime\] sync-runtime refused: .*godot lead rn-lead1.* The live runtime is unchanged\./);
    assert.equal(existsSync(path.join(runtime, "server")), false, "nothing copied");
    assert.equal(existsSync(path.join(runtime, "build-stamp.json")), false);
  }
  const dry = runSync({ repoRoot: dir, env, dryRun: true, build: noBuild, log: () => {} });
  assert.equal(dry.dryRun, true, "a dry run copies nothing, so it is not guarded");

  restartRecord(env.VIBESQUAD_HOME, { startedMs: now - 60000, finishedMs: now - 30000, ok: true, deferred: false });
  const res = runSync({ repoRoot: dir, env, build: noBuild, log: () => {} });
  assert.equal(res.synced, true, JSON.stringify(res));
  assert.equal(existsSync(path.join(runtime, "server", "x.mjs")), true);
});

test("runSync: the owner's ignoreDrain syncs during a pending drain and logs one restart-feedback line; from an agent shell it is refused", (t) => {
  const { dir, runtime, env } = syncRepo(t);
  writeFileSync(path.join(env.VIBESQUAD_HOME, "local-token"), "cd".repeat(32));
  const now = Date.now();
  restartRecord(env.VIBESQUAD_HOME, { startedMs: now - 5 * 60000, finishedMs: now - 2 * 60000 });
  const noBuild = () => assert.fail("no UI input: no build");
  const calls = [];
  const logVs = (args) => { calls.push(args); return { ok: true }; };

  const agent = runSync({ repoRoot: dir, env: { ...env, VS_AGENT_ID: "rn-lead1" }, ignoreDrain: true, logVs, build: noBuild, log: () => {} });
  assert.equal(agent.synced, false);
  assert.match(agent.refused, /^sync-runtime --ignore-drain: needs the owner's per-run OK/);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(path.join(runtime, "server")), false);

  const lines = [];
  const res = runSync({ repoRoot: dir, env, ignoreDrain: true, logVs, build: noBuild, log: (l) => lines.push(l) });
  assert.equal(res.synced, true, JSON.stringify(res));
  assert.equal(existsSync(path.join(runtime, "server", "x.mjs")), true);
  assert.equal(calls.length, 1, "exactly one log line");
  assert.deepEqual(calls[0].slice(0, 2), ["log", "restart-feedback"]);
  assert.match(calls[0][2], /^drain-override sync-runtime: /);
  assert.deepEqual(res.drainOverride, { logged: true, text: calls[0][2] });
  assert.match(lines.join("\n"), /\[sync-runtime\] sync-runtime: --ignore-drain: going ahead during the coordinated drain/);
});

test("sync-runtime CLI accepts --ignore-drain (not an unknown flag)", () => {
  // A copy of server/ + runner/ in a temp repo on a unit branch: the skip guard fires, so no sync (or build) runs on any real checkout.
  const copy = mkdtempSync(path.join(tmpdir(), "vs-sync-copy-"));
  for (const d of ["server", "runner"]) cpSync(path.join(root, d), path.join(copy, d), { recursive: true });
  spawnSync("git", ["-C", copy, "init", "-q", "-b", "unit-x"]);
  const r = spawnSync(process.execPath, [path.join(copy, "server", "sync-runtime.mjs"), "--ignore-drain"], { cwd: copy, encoding: "utf8", env: cleanEnv({ VIBESQUAD_SYNC_FORCE: "", LOCALAPPDATA: mkdtempSync(path.join(tmpdir(), "vs-sync-lad-")), VIBESQUAD_RUNTIME_DIR: mkdtempSync(path.join(tmpdir(), "vs-sync-rt-")) }) });
  assert.doesNotMatch(r.stdout + r.stderr, /unknown flag/);
  assert.notEqual(r.status, 2);
});
