// The shared runner backend is built once and outlives env changes. A test (or anything) that sets a temp VIBESQUAD_HOME
// after the first use must never reach the real ~/.vibesquad/runner: the client resolves its home per call.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerClient } from "../server/backend/runner-client.mjs";
import { sharedRunnerBackend } from "../server/backend/index.mjs";

const realHome = path.join(os.homedir(), ".vibesquad");

test("shared runner backend follows VIBESQUAD_HOME set after first use and never touches the real home", async () => {
  const prev = process.env.VIBESQUAD_HOME;
  const first = mkdtempSync(path.join(os.tmpdir(), "vs-home-a-"));
  const second = mkdtempSync(path.join(os.tmpdir(), "vs-home-b-"));
  try {
    process.env.VIBESQUAD_HOME = first;
    const rc = sharedRunnerBackend().rc;
    assert.equal(rc.home, path.join(first, "runner"));
    process.env.VIBESQUAD_HOME = second;
    assert.equal(rc.home, path.join(second, "runner"), "home follows the env, not the first construction");
    assert.ok(!rc.home.startsWith(realHome));
    // No runner in the temp home: connect-only calls are RUNNER_DOWN, nothing is sent anywhere else.
    await assert.rejects(rc.requireRunning(), { code: "RUNNER_DOWN" });
  } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prev;
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("a cached connection is dropped when the home changes; an explicit home stays fixed", async () => {
  const prev = process.env.VIBESQUAD_HOME;
  const a = mkdtempSync(path.join(os.tmpdir(), "vs-home-c-"));
  const b = mkdtempSync(path.join(os.tmpdir(), "vs-home-d-"));
  const urls = [];
  const fetchImpl = async (url) => (urls.push(url), { ok: true, json: async () => ({}) });
  const put = (home, port) => {
    mkdirSync(path.join(home, "runner"), { recursive: true });
    writeFileSync(path.join(home, "runner", "runner.json"), JSON.stringify({ port, pid: process.pid }));
    writeFileSync(path.join(home, "runner", "token"), "t");
  };
  try {
    put(a, 11111);
    put(b, 22222);
    process.env.VIBESQUAD_HOME = a;
    const rc = new RunnerClient({ fetchImpl });
    await rc.request("GET", "/health");
    process.env.VIBESQUAD_HOME = b;
    await rc.request("GET", "/health");
    assert.deepEqual(urls.map((u) => new URL(u).port), ["11111", "22222"]);
    const fixed = new RunnerClient({ fetchImpl, home: path.join(a, "runner") });
    process.env.VIBESQUAD_HOME = b;
    assert.equal(fixed.home, path.join(a, "runner"));
  } finally {
    if (prev === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prev;
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
