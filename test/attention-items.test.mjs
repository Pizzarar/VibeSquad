import assert from "node:assert/strict";
import test from "node:test";
import { attentionItems, clearItem, stalledReason } from "../src/attentionItems.ts";
import { attentionOf } from "../src/teams.ts";
import { dismissLocal, resetAttentionLocal } from "../src/attentionLocal.ts";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const ago = (s) => new Date(NOW - s * 1000).toISOString();
const agent = (id, extra = {}) => ({ id, title: `Agent ${id}`, status: "idle", labels: {}, ...extra });
const member = (a) => ({ agent: a, kind: "worker", attention: attentionOf(a) });

test("stalled is an attention kind: a quiet running agent lists as stalled, only when `now` is passed", () => {
  resetAttentionLocal();
  const quiet = member(agent("slow", { status: "running", updatedAt: ago(300) }));
  const busy = member(agent("busy", { status: "running", updatedAt: ago(20) }));
  assert.deepEqual(attentionItems([quiet, busy]).map((i) => i.kind), []); // opt-in: badges stay unchanged
  const items = attentionItems([quiet, busy], NOW);
  assert.deepEqual(items.map((i) => [i.id, i.kind]), [["slow", "stalled"]]);
  assert.equal(items[0].reason, "Stalled: no update for 5m");
});

test("stalled: a pending permission or an existing attention wins; dismissing hides it", async () => {
  resetAttentionLocal();
  const perm = member(agent("p", { status: "running", updatedAt: ago(600), pendingPermissions: [{ id: "r", kind: "tool" }] }));
  assert.equal(attentionItems([perm], NOW)[0].kind, "permission");
  assert.equal(stalledReason(agent("x", { status: "idle", updatedAt: ago(600) }), NOW), null);
  const quiet = member(agent("slow", { status: "running", updatedAt: ago(300) }));
  const [item] = attentionItems([quiet], NOW);
  const calls = [];
  await clearItem(item, { dismissLocal: (...a) => (calls.push(a), dismissLocal(...a)), refresh: () => {} });
  assert.deepEqual(calls, [["slow", `stalled:${ago(300)}`]]);
  assert.equal(attentionItems([quiet], NOW).length, 0);
});

test("stalled dismiss is keyed to activity: new activity then a fresh stall shows again", async () => {
  resetAttentionLocal();
  const quiet = (updatedAt) => member(agent("slow", { status: "running", updatedAt }));
  const [item] = attentionItems([quiet(ago(300))], NOW);
  await clearItem(item, { dismissLocal, refresh: () => {} });
  assert.equal(attentionItems([quiet(ago(300))], NOW).length, 0); // same stall stays dismissed
  assert.equal(attentionItems([quiet(ago(200))], NOW + 1000).length, 1); // it moved, then stalled again
});
