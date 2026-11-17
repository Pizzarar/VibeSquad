// idea-197 (docs/PLAN_PER_POST03.md P4): the D2 coordinated-drain window guards the full-suite slot (scripts/run-tests.mjs)
// and the runtime sync (server/sync-runtime.mjs runSync). restartDrainPending reads the same deferralChain as the D2
// restart guard. Every test uses its own VIBESQUAD_HOME / VIBESQUAD_TEST_LOCK_DIR / LOCALAPPDATA, never the live ones.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DRAIN_WINDOW_MS, drainPendingMessage, restartDrainPending } from "../server/restart-coord.mjs";
import { runSync } from "../server/sync-runtime.mjs";
import { finishSlot, readQueue, suitePaths, tryAcquireSlot } from "../scripts/suite-lock.mjs";

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
  assert.match(msg, /no timer retries\. Targeted runs still go\.$/);
  assert.doesNotMatch(drainPendingMessage("sync-runtime", { deferral: null, leads: [], ageMin: 0, leftMin: 30 }), /leads asked/);
});

function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ["VS_AGENT_ID", "PASEO_AGENT_ID", "NODE_TEST_CONTEXT"]) delete env[k];
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
