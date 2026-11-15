// idea-233 (c): "wake dispatch failed: ECONNRESET" right after "runtime runner code changed, restarting". restartRunnerNow
// hard-kills the runner (taskkill /F, deliberate: agents stay resumable) with VS server requests in flight, so runner stop()
// never runs. The in-process RunnerClient must wait (bounded) for the owner's restart instead of failing: a read that the
// kill reset retries on the new runner, a call made mid-restart goes to the new runner, and a reset write is never resent.
import "./helpers/clean-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerClient } from "../server/backend/runner-client.mjs";
import { restartRunnerNow } from "../server/runner-supervisor.mjs";

/** Old runner on port 1 (pid 4242) whose requests hang until killed; new runner on port 2 answers once startOwned writes it. */
function rig({ startGate } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vs-restart-wait-"));
  const home = path.join(dir, "runner");
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "runner.json"), JSON.stringify({ port: 1, pid: 4242 }));
  writeFileSync(path.join(home, "token"), "t");
  const hanging = [];
  const calls = [];
  const fetchImpl = (url, init = {}) => {
    const u = new URL(url);
    const port = Number(u.port);
    calls.push({ port, method: init.method ?? "GET", route: u.pathname });
    if (port === 2) return Promise.resolve({ ok: true, status: 200, json: async () => ({ port: 2, route: u.pathname }) });
    if (port === 1) return new Promise((_, reject) => hanging.push(reject));
    return Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }));
  };
  const rc = new RunnerClient({ home, fetchImpl, caller: null, requestTimeoutMs: 60_000 });
  const killOld = () => {
    for (const reject of hanging.splice(0)) reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
  };
  const owner = {
    rc,
    startOwned: async () => {
      await (startGate ?? Promise.resolve());
      writeFileSync(path.join(home, "runner.json"), JSON.stringify({ port: 2, pid: 5151 }));
      return true;
    },
  };
  const restartOpts = { kill: () => killOld(), alive: () => false, waitMs: 0 };
  return { dir, home, rc, owner, calls, restartOpts, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const tick = () => new Promise((r) => setImmediate(r));

test("a GET reset by the supervisor's hard-kill restart waits for the new runner and answers from it", async () => {
  let release;
  const r = rig({ startGate: new Promise((res) => { release = res; }) });
  try {
    const read = r.rc.request("GET", "/agents");
    await tick();
    const restart = restartRunnerNow(r.owner, r.restartOpts);
    await tick();
    release(); // the new runner finishes booting after the kill reset the read
    assert.deepEqual(await read, { port: 2, route: "/agents" });
    assert.equal(await restart, true);
  } finally {
    r.cleanup();
  }
});

test("a POST made while a restart is in progress waits and goes to the new runner, not the dead port", async () => {
  let release;
  const r = rig({ startGate: new Promise((res) => { release = res; }) });
  try {
    const restart = restartRunnerNow(r.owner, r.restartOpts);
    await tick();
    const write = r.rc.request("POST", "/agents/a1/input", { text: "wake" });
    await tick();
    assert.equal(r.calls.filter((c) => c.method === "POST").length, 0, "nothing sent to the runner being replaced");
    release();
    assert.deepEqual(await write, { port: 2, route: "/agents/a1/input" });
    await restart;
    assert.deepEqual(r.calls.filter((c) => c.method === "POST").map((c) => c.port), [2]);
  } finally {
    r.cleanup();
  }
});

test("a POST the kill reset is not resent (the old runner may have taken it): it still fails, once", async () => {
  const r = rig();
  try {
    const write = r.rc.request("POST", "/agents/a1/input", { text: "wake" });
    await tick();
    const restart = restartRunnerNow(r.owner, r.restartOpts);
    await assert.rejects(write, (e) => e.transport === true && /ECONNRESET/.test(e.message));
    await restart;
    assert.deepEqual(r.calls.filter((c) => c.method === "POST").map((c) => c.port), [1]);
  } finally {
    r.cleanup();
  }
});

test("the restart wait is bounded: a restart that never finishes does not hang the caller", async () => {
  const r = rig({ startGate: new Promise(() => {}) });
  r.rc.restartWaitMs = 50;
  try {
    const read = r.rc.request("GET", "/agents");
    await tick();
    restartRunnerNow(r.owner, r.restartOpts);
    const t0 = Date.now();
    await assert.rejects(read, (e) => e.transport === true);
    assert.ok(Date.now() - t0 < 2000, "gave up after restartWaitMs");
  } finally {
    r.cleanup();
  }
});

test("healthy() during the restart never waits on it (startOwned probes health inside the restart)", async () => {
  let release;
  const r = rig({ startGate: new Promise((res) => { release = res; }) });
  r.rc.restartWaitMs = 5000;
  try {
    const restart = restartRunnerNow(r.owner, r.restartOpts);
    await tick();
    const t0 = Date.now();
    assert.equal(await r.rc.healthy(), false, "old runner gone, new one not written yet");
    assert.ok(Date.now() - t0 < 1000, "no restart wait inside healthy()");
    release();
    await restart;
    assert.equal(r.rc.restarting ?? null, null, "restart marker cleared once the restart settles");
  } finally {
    r.cleanup();
  }
});
