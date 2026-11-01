import assert from "node:assert/strict";
import test from "node:test";
import { appendBriefLine, briefStamp, completeBlocker, hasLooksDone, patchLane, pinStateOf } from "../src/pins.ts";

const member = (id, status = "idle", perms = 0) => ({
  agent: { id, status, labels: {}, pendingPermissions: Array.from({ length: perms }, (_, i) => ({ id: `p${i}` })) },
});
const pin = (over = {}) => ({ brainstorm: member("bs"), lead: member("lead"), workers: [], ...over });

test("Mark complete is refused while workers run or permissions are open", () => {
  assert.equal(completeBlocker(pin()), null);
  assert.equal(completeBlocker(pin({ workers: [member("w1", "running"), member("w2", "running"), member("w3")] })), "2 workers still running");
  assert.equal(completeBlocker(pin({ workers: [member("w1", "running")] })), "1 worker still running");
  assert.equal(completeBlocker(pin({ lead: member("lead", "running") })), "Lead still running");
  assert.equal(completeBlocker(pin({ brainstorm: member("bs", "idle", 1) })), "1 open permission");
  // The Brainstorm itself running (e.g. posting the looks-done card) does not block.
  assert.equal(completeBlocker(pin({ brainstorm: member("bs", "running"), lead: null })), null);
});

test("looks-done marker is detected only on its own line", () => {
  assert.ok(hasLooksDone("Pinned looks done. ✓ Mark complete · Not yet\n\n```\nvs:looks-done\n```"));
  assert.ok(hasLooksDone("Pinned looks done.\r\n`vs:looks-done`"));
  assert.ok(!hasLooksDone("I will post vs:looks-done when it is finished."));
  assert.ok(!hasLooksDone("No marker here."));
});

test("done/reopen round-trips through patchLane", () => {
  const teams = [{ id: "sq", name: "Squad", lanes: [{ id: "a", name: "A" }, { id: "b", name: "B" }], paths: [] }];
  const done = patchLane(teams, "sq", "a", { state: "done", doneAt: "2026-11-01T00:00:00.000Z" });
  assert.equal(pinStateOf(done[0].lanes[0]), "done");
  assert.equal(pinStateOf(done[0].lanes[1]), "pinned");
  const reopened = JSON.parse(JSON.stringify(patchLane(done, "sq", "a", { state: "pinned", doneAt: undefined })));
  assert.equal(pinStateOf(reopened[0].lanes[0]), "pinned");
  assert.equal("doneAt" in reopened[0].lanes[0], false);
});

test("brief Done line is appended once at the end", () => {
  assert.match(briefStamp(new Date(2026, 10, 1)), /^2026-11-01$/);
  assert.equal(appendBriefLine("# Brief\n\n## Open\n- None.\n\n\n", "Done 2026-11-01"), "# Brief\n\n## Open\n- None.\n\nDone 2026-11-01\n");
});
