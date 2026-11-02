import assert from "node:assert/strict";
import test from "node:test";
import { bulkStopTargets, deleteGuard, runningCwds } from "../src/paseoAgentOpsLogic.ts";
import { runWait, summarizeWait } from "../cli/vs.mjs";

const ag = (id, extra = {}) => ({ id, title: id, status: "idle", cwd: "C:\\w\\a", labels: {}, ...extra });

test("deleteGuard warns for live lead and buddy only, by label", () => {
  assert.match(deleteGuard(ag("l", { labels: { role: "lead" } })).warning, /live Lead/);
  assert.match(deleteGuard(ag("b", { labels: { role: "brainstorm" } })).warning, /live Buddy/);
  assert.equal(deleteGuard(ag("w", { labels: { role: "worker" } })).warning, null);
  assert.equal(deleteGuard(ag("old", { labels: { role: "lead" }, archivedAt: "2026-01-01" })).warning, null);
  assert.equal(deleteGuard(ag("c", { labels: { role: "lead" }, status: "closed" })).warning, null);
  // a title that says "Lead" does not count
  assert.equal(deleteGuard(ag("t", { title: "★ Hub1 · lead", labels: {} })).warning, null);
});

test("bulkStopTargets: team scope takes only running, non-archived members of that team", () => {
  const c = [
    { agent: ag("a", { status: "running" }), teamId: "t1" },
    { agent: ag("b", { status: "idle" }), teamId: "t1" },
    { agent: ag("c", { status: "running" }), teamId: "t2" },
    { agent: ag("d", { status: "running", archivedAt: "x" }), teamId: "t1" },
  ];
  assert.deepEqual(bulkStopTargets(c, { teamId: "t1" }).map((a) => a.id), ["a"]);
});

test("bulkStopTargets: cwd scope ignores slash style, case and trailing slash", () => {
  const c = [
    { agent: ag("a", { status: "running", cwd: "C:\\W\\A\\" }) },
    { agent: ag("b", { status: "running", cwd: "c:/w/a" }) },
    { agent: ag("c", { status: "running", cwd: "c:/w/other" }) },
    { agent: ag("d", { status: "running", cwd: null }) },
  ];
  assert.deepEqual(bulkStopTargets(c, { cwd: "c:/w/a/" }).map((a) => a.id), ["a", "b"]);
  assert.deepEqual(bulkStopTargets(c, { cwd: "" }), []);
});

test("runningCwds counts running agents per cwd", () => {
  const out = runningCwds([ag("a", { status: "running" }), ag("b", { status: "running", cwd: "c:/w/a" }), ag("c", { status: "running", cwd: "/x" }), ag("d")]);
  assert.deepEqual(out.map((o) => o.count), [2, 1]);
});

test("vs wait: exit codes and client call", async () => {
  assert.equal(summarizeWait("a", { status: "idle" }).code, 0);
  assert.equal(summarizeWait("a", { status: "timeout" }).code, 2);
  assert.equal(summarizeWait("a", { status: "permission" }).code, 1);
  assert.equal(summarizeWait("a", { status: "error", error: "boom" }).line, "a: error (boom)");
  const calls = [];
  const client = { waitForFinish: async (id, ms) => (calls.push([id, ms]), { status: "idle" }) };
  assert.equal((await runWait(client, "agent1", 5)).code, 0);
  assert.deepEqual(calls, [["agent1", 5000]]);
  await runWait(client, "agent2");
  assert.deepEqual(calls[1], ["agent2", undefined]);
});
