// idea-216: an ACP permission that the policy auto-resolves (request + resolved logged back to back) must reach watch-sets
// with the agent snapshot, so the false 'blocked (permission)' stall never arms.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerBackend } from "../server/backend/runner-backend.mjs";
import { createWatchEngine, addWatch } from "../server/watch-sets.mjs";

test("runner-backend permission event carries the snapshot; an auto-resolved ACP request leaves attention false", async () => {
  const vs = fs.mkdtempSync(path.join(os.tmpdir(), "vs-perm-"));
  const rc = { vs, home: path.join(vs, "runner"), request: async () => { throw new Error("unused"); }, stream: () => ({ close() {} }) };
  const b = new RunnerBackend({ client: rc, buildPrefix: async () => "" });
  b.live.hwm = new Map();
  b.noteSeen = () => {};
  b.emitTimeline = () => {};
  // The fetch runs after both events are logged, so it already shows no pending permission.
  b.fetchAgent = async () => ({ agent: { id: "w-1", status: "running", labels: { role: "worker" }, pendingPermissions: [] } });
  const evs = [];
  b.emitEvent = (e) => evs.push(e);
  await b.handleLogEvent({ id: "w-1", event: { seq: 1, ts: 1, type: "status", status: "running" } });
  await b.handleLogEvent({ id: "w-1", event: { seq: 2, ts: 2, type: "permission", phase: "request", id: "p1", toolName: "Edit" } });
  await b.handleLogEvent({ id: "w-1", event: { seq: 3, ts: 3, type: "permission", phase: "resolved", id: "p1", outcome: "selected" } });
  const perm = evs.find((e) => e.kind === "permission");
  assert.ok(perm, "a permission event is emitted");
  assert.ok(perm.agent, "it carries the agent snapshot");
  assert.deepEqual(perm.agent.pendingPermissions, []);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-perm-w-"));
  const home = path.join(dir, "vs");
  const tmp = path.join(dir, "tmp");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const T0 = Date.parse("2026-11-10T12:00:00.000Z");
  let t = T0;
  const delivered = [];
  addWatch({ owner: "lead-1", stallMin: 15, items: [{ kind: "agent", ref: "w-1" }] }, { home, now: T0 });
  const engine = createWatchEngine({ home, tmpdir: tmp, now: () => t, alive: (pid) => pid === 111, deliver: (d) => { delivered.push(d); engine.markAttempted([d.key], d.owner); }, retryMs: 0 });
  engine.start();
  // Everything up to and including the permission event (the resolved agent event has not been processed yet).
  for (const e of evs.slice(0, evs.findIndex((e) => e.kind === "permission") + 1)) engine.onRunnerEvent(e);
  t = T0 + 20 * 60000;
  await engine.tick();
  assert.doesNotMatch(delivered.map((d) => d.text ?? "").join(" | "), /blocked \(permission\)/);
});
