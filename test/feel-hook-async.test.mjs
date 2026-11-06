import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspectGitSpawnState } from "../plugin/index.server.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("inspectGitSpawnState is async: returns a promise and keeps the event loop turning while git runs", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const p = inspectGitSpawnState(REPO_ROOT);
  assert.ok(p instanceof Promise);
  const state = await p;
  clearInterval(timer);
  assert.match(
    state,
    /^Starting git state \(snapshot at spawn — re-check before commit\/push\/merge\): branch=\S+, origin=\d+ behind \/ \d+ ahead, dirty=\d+ files\.$/,
  );
  assert.ok(ticks > 0, "event loop never ran during git calls");
});

test("inspectGitSpawnState resolves null for empty or missing cwd, and for a non-repo dir", async () => {
  assert.equal(await inspectGitSpawnState(""), null);
  assert.equal(await inspectGitSpawnState(path.join(REPO_ROOT, "definitely-not-here")), null);
  assert.equal(await inspectGitSpawnState(path.parse(REPO_ROOT).root), null);
});

test("inspectGitSpawnState matches plain git for branch and dirty count", async () => {
  const git = (...a) => spawnSync("git", a, { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim();
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const dirty = git("status", "--porcelain", "-uno").split(/\r?\n/).filter((l) => l.trim()).length;
  const state = await inspectGitSpawnState(REPO_ROOT);
  assert.ok(state.includes(`branch=${branch},`), state);
  assert.ok(state.endsWith(`dirty=${dirty} files.`), state);
});

test("label writes and archive use the daemon client, not a CLI process", async () => {
  const { daemonSetLabels, daemonArchive } = await import("../plugin/index.server.ts");
  await assert.rejects(daemonSetLabels("bad id; rm", { a: "b" }), /invalid agent id/);
  await assert.rejects(daemonArchive("bad id"), /invalid agent id/);
  const src = readFileSync(new URL("../plugin/index.server.ts", import.meta.url), "utf8");
  assert.ok(!/spawn\(cli,/.test(src), "plugin must not spawn the paseo CLI for label/archive writes");
  assert.match(src, /setLabels: daemonSetLabels,/);
  assert.match(src, /archiveAgent: daemonArchive,/);
});
