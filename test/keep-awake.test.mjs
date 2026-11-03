import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  ES_CONTINUOUS,
  ES_HOLD_FLAGS,
  ES_SYSTEM_REQUIRED,
  countRunningAgents,
  createKeepAwakeController,
  createWindowsWakeLockApplier,
  handleKeepAwakeRequest,
} from "../server/keep-awake.mjs";

test("execution state constants match Windows kernel32 flags", () => {
  assert.equal(ES_CONTINUOUS, 0x80000000);
  assert.equal(ES_SYSTEM_REQUIRED, 0x00000001);
  assert.equal(ES_HOLD_FLAGS, 0x80000001);
});

test("countRunningAgents counts only non-archived running agents", () => {
  assert.equal(countRunningAgents(), 0);
  assert.equal(countRunningAgents(null), 0);
  assert.equal(
    countRunningAgents([
      null,
      undefined,
      { id: "a1", status: "running" },
      { id: "a2", status: "running", archivedAt: "2026-11-02T00:00:00.000Z" },
      { id: "a3", status: "idle" },
      { id: "a4", status: "closed" },
      { id: "a5", status: "error" },
      { id: "a6", status: "running", archivedAt: "" },
    ]),
    2,
  );
});

test("createKeepAwakeController acquires on running, skips redundant updates, and releases when idle", () => {
  const calls = [];
  const ctrl = createKeepAwakeController({
    enabled: true,
    applyState: (hold) => calls.push(hold),
  });

  assert.deepEqual(ctrl.getState(), {
    enabled: true,
    holding: false,
    runningCount: 0,
    lastChangedAt: null,
    transitions: 0,
  });

  // Idle agents -> does not acquire
  ctrl.update([{ id: "1", status: "idle" }]);
  assert.equal(ctrl.getState().holding, false);
  assert.equal(calls.length, 0);

  // 1 running agent -> acquires wake lock
  ctrl.update([
    { id: "1", status: "running" },
    { id: "2", status: "idle" },
  ]);
  assert.equal(ctrl.getState().holding, true);
  assert.equal(ctrl.getState().runningCount, 1);
  assert.equal(ctrl.getState().transitions, 1);
  assert.deepEqual(calls, [true]);

  // Redundant update with 2 running agents -> does not re-invoke applyState
  ctrl.update([
    { id: "1", status: "running" },
    { id: "2", status: "running" },
  ]);
  assert.equal(ctrl.getState().holding, true);
  assert.equal(ctrl.getState().runningCount, 2);
  assert.equal(ctrl.getState().transitions, 1);
  assert.deepEqual(calls, [true]);

  // All agents become idle/closed -> releases wake lock
  ctrl.update([
    { id: "1", status: "idle" },
    { id: "2", status: "closed" },
  ]);
  assert.equal(ctrl.getState().holding, false);
  assert.equal(ctrl.getState().runningCount, 0);
  assert.equal(ctrl.getState().transitions, 2);
  assert.deepEqual(calls, [true, false]);
});

test("setEnabled(false) releases immediately while holding, and setEnabled(true) re-acquires when running", () => {
  const calls = [];
  const ctrl = createKeepAwakeController({
    enabled: true,
    applyState: (hold) => calls.push(hold),
  });

  ctrl.update([{ id: "1", status: "running" }]);
  assert.equal(ctrl.getState().holding, true);
  assert.deepEqual(calls, [true]);

  // Disable while holding -> immediately releases
  ctrl.setEnabled(false);
  assert.equal(ctrl.getState().enabled, false);
  assert.equal(ctrl.getState().holding, false);
  assert.equal(ctrl.getState().runningCount, 1);
  assert.deepEqual(calls, [true, false]);

  // Updates while disabled do not acquire
  ctrl.update([{ id: "1", status: "running" }, { id: "2", status: "running" }]);
  assert.equal(ctrl.getState().holding, false);
  assert.equal(ctrl.getState().runningCount, 2);
  assert.deepEqual(calls, [true, false]);

  // Re-enabling while agents are still running re-acquires
  ctrl.setEnabled(true);
  assert.equal(ctrl.getState().enabled, true);
  assert.equal(ctrl.getState().holding, true);
  assert.deepEqual(calls, [true, false, true]);

  // Dispose releases
  ctrl.dispose();
  assert.equal(ctrl.getState().holding, false);
  assert.deepEqual(calls, [true, false, true, false]);
});

test("createWindowsWakeLockApplier spawns powershell helper on hold and stops it on release", () => {
  const spawned = [];
  const spawnImpl = (cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.cmd = cmd;
    proc.args = args;
    proc.opts = opts;
    proc.exitCode = null;
    proc.killed = false;
    proc.stdinWrites = [];
    proc.stdin = {
      write: (s) => proc.stdinWrites.push(s),
      end: () => {},
    };
    proc.kill = () => {
      proc.killed = true;
    };
    proc.unref = () => {};
    spawned.push(proc);
    return proc;
  };

  const apply = createWindowsWakeLockApplier({ spawnImpl });
  apply(true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, "powershell.exe");

  // Calling apply(true) again while child is alive does not spawn a second process
  apply(true);
  assert.equal(spawned.length, 1);

  // Releasing writes release and kills the child
  apply(false);
  assert.equal(spawned[0].killed, true);
  assert.deepEqual(spawned[0].stdinWrites, ["release\n"]);
});

test("handleKeepAwakeRequest handles GET and POST", async () => {
  const calls = [];
  const ctrl = createKeepAwakeController({
    enabled: true,
    applyState: (hold) => calls.push(hold),
  });

  const makeRes = () => {
    const headers = {};
    let body = "";
    return {
      statusCode: 200,
      setHeader(k, v) {
        headers[k.toLowerCase()] = v;
      },
      end(str) {
        body = str;
      },
      json() {
        return JSON.parse(body);
      },
    };
  };

  // GET initial state
  const resGet = makeRes();
  await handleKeepAwakeRequest({ method: "GET" }, resGet, ctrl);
  assert.equal(resGet.statusCode, 200);
  assert.equal(resGet.json().ok, true);
  assert.equal(resGet.json().enabled, true);
  assert.equal(resGet.json().holding, false);

  // POST with running agent
  const postReq1 = new EventEmitter();
  postReq1.method = "POST";
  const resPost1 = makeRes();
  const p1 = handleKeepAwakeRequest(postReq1, resPost1, ctrl);
  postReq1.emit("data", JSON.stringify({ enabled: true, agents: [{ id: "a1", status: "running" }] }));
  postReq1.emit("end");
  await p1;

  assert.equal(resPost1.statusCode, 200);
  assert.equal(resPost1.json().holding, true);
  assert.equal(resPost1.json().runningCount, 1);
  assert.deepEqual(calls, [true]);

  // POST disable
  const postReq2 = new EventEmitter();
  postReq2.method = "POST";
  const resPost2 = makeRes();
  const p2 = handleKeepAwakeRequest(postReq2, resPost2, ctrl);
  postReq2.emit("data", JSON.stringify({ enabled: false }));
  postReq2.emit("end");
  await p2;

  assert.equal(resPost2.statusCode, 200);
  assert.equal(resPost2.json().enabled, false);
  assert.equal(resPost2.json().holding, false);
  assert.deepEqual(calls, [true, false]);
});
