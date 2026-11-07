import assert from "node:assert/strict";
import test from "node:test";
import { formatAge, squadQueue } from "../src/attentionItems.ts";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const member = (id, attention, { updatedAt = ago(1), labels = {}, status = "idle", archivedAt = null, kind = "worker", pending } = {}) => ({
  agent: { id, title: id, status, updatedAt, labels, archivedAt, pendingPermissions: pending },
  attention,
  kind,
});
const needs = { tone: "needs-you", reason: "decide" };
const perm = { tone: "permission", reason: "1 permission request(s)" };

test("a newest permission sorts above an older needs-you; the rest oldest first", () => {
  const q = squadQueue([
    member("new-needs", needs, { labels: { "needs-you-at": ago(10) } }),
    member("perm-new", perm, { updatedAt: ago(1), pending: [{ id: "r1" }] }),
    member("old-needs", needs, { labels: { "needs-you-at": ago(300) } }),
    member("err", { tone: "error", reason: "boom" }, { updatedAt: ago(60) }),
  ]);
  assert.deepEqual(q.map((i) => i.id), ["perm-new", "old-needs", "err", "new-needs"]);
  assert.deepEqual(q[0].quickPermission, { requestId: "r1" });
});

test("needs-you without a stamp falls back to updatedAt", () => {
  const q = squadQueue([member("a", needs, { updatedAt: ago(5) }), member("b", needs, { updatedAt: ago(50) })]);
  assert.deepEqual(q.map((i) => i.id), ["b", "a"]);
});

test("retired, closed and archived agents are excluded", () => {
  const q = squadQueue([
    member("retired", needs, { kind: "old-lead" }),
    member("closed", needs, { status: "closed" }),
    member("archived", needs, { archivedAt: ago(1) }),
    member("live", needs),
  ]);
  assert.deepEqual(q.map((i) => i.id), ["live"]);
});

test("formatAge", () => {
  assert.equal(formatAge(NOW - 4 * 60_000, NOW), "4m");
  assert.equal(formatAge(NOW - 2 * 3_600_000, NOW), "2h");
  assert.equal(formatAge(NOW - 3 * 86_400_000, NOW), "3d");
  assert.equal(formatAge(NOW - 5_000, NOW), "now");
  assert.equal(formatAge(null, NOW), "");
});
