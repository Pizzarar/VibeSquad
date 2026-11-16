import assert from "node:assert/strict";
import test from "node:test";
import { attentionItems, clearItem, needsYouCount, stalledCount, stalledReason } from "../src/attentionItems.ts";
import { attentionOf } from "../src/teams.ts";
import { dismissLocal, resetAttentionLocal } from "../src/attentionLocal.ts";

const NOW = Date.parse("2026-11-15T12:00:00Z");
const ago = (s) => new Date(NOW - s * 1000).toISOString();
const agent = (id, extra = {}) => ({ id, title: `Agent ${id}`, status: "idle", labels: {}, ...extra });
const member = (a) => ({ agent: a, kind: "worker", attention: attentionOf(a) });

test("stalled is an attention kind: a quiet running agent lists as stalled, only when `now` is passed", () => {
  resetAttentionLocal();
  const quiet = member(agent("slow", { status: "running", updatedAt: ago(700) }));
  const busy = member(agent("busy", { status: "running", updatedAt: ago(20) }));
  assert.deepEqual(attentionItems([quiet, busy]).map((i) => i.kind), []); // opt-in: badges stay unchanged
  const items = attentionItems([quiet, busy], NOW);
  assert.deepEqual(items.map((i) => [i.id, i.kind]), [["slow", "stalled"]]);
  assert.equal(items[0].reason, "Stalled: no update for 12m");
});

test("stalled: a pending permission or an existing attention wins; dismissing hides it", async () => {
  resetAttentionLocal();
  const perm = member(agent("p", { status: "running", updatedAt: ago(600), pendingPermissions: [{ id: "r", kind: "tool" }] }));
  assert.equal(attentionItems([perm], NOW)[0].kind, "permission");
  assert.equal(stalledReason(agent("x", { status: "idle", updatedAt: ago(600) }), NOW), null);
  const quiet = member(agent("slow", { status: "running", updatedAt: ago(700) }));
  const [item] = attentionItems([quiet], NOW);
  const calls = [];
  await clearItem(item, { dismissLocal: (...a) => (calls.push(a), dismissLocal(...a)), refresh: () => {} });
  assert.deepEqual(calls, [["slow", `stalled:${ago(700)}`]]);
  assert.equal(attentionItems([quiet], NOW).length, 0);
});

test("stalled dismiss is keyed to activity: new activity then a fresh stall shows again", async () => {
  resetAttentionLocal();
  const quiet = (updatedAt) => member(agent("slow", { status: "running", updatedAt }));
  const [item] = attentionItems([quiet(ago(700))], NOW);
  await clearItem(item, { dismissLocal, refresh: () => {} });
  assert.equal(attentionItems([quiet(ago(700))], NOW).length, 0); // same stall stays dismissed
  assert.equal(attentionItems([quiet(ago(650))], NOW + 1000).length, 1); // it moved, then stalled again
});

test("R3.2: stalled needs ~10 min quiet AND no tool in flight; below that it is out of list and count", () => {
  resetAttentionLocal();
  const at = (s) => member(agent("q", { status: "running", updatedAt: ago(s) }));
  assert.equal(attentionItems([at(599)], NOW).length, 0);
  assert.equal(needsYouCount([at(599)], NOW), 0);
  assert.equal(attentionItems([at(600)], NOW).length, 1);
  assert.equal(needsYouCount([at(600)], NOW), 1);
  // a tool call in flight (running-tool age known) is never stalled, however quiet
  assert.equal(attentionItems([at(3000)], NOW, () => 240).length, 0);
  assert.equal(stalledReason(agent("x", { status: "running", updatedAt: ago(3000) }), NOW, 0), null);
});

test("R3.2: needsYouCount == the counted rows (finished excluded) and matches the sum over any split of members", () => {
  resetAttentionLocal();
  const a = member(agent("a", { status: "running", updatedAt: ago(900) }));
  const b = member(agent("b", { status: "idle", requiresAttention: true, attentionReason: "permission", pendingPermissions: [{ id: "r", kind: "tool" }] }));
  const c = member(agent("c", { status: "idle", requiresAttention: true, attentionReason: "finished" }));
  const all = [a, b, c];
  assert.equal(needsYouCount(all, NOW), attentionItems(all, NOW).filter((i) => i.kind !== "finished").length);
  assert.equal(needsYouCount(all, NOW), needsYouCount([a], NOW) + needsYouCount([b, c], NOW));
});

test("R3.2 parity: with everything collapsed, sum of per-container badges == Needs-you count (busy fixture, >10-min stalled agent)", () => {
  resetAttentionLocal();
  const perm = (id) => member(agent(id, { status: "idle", requiresAttention: true, attentionReason: "permission", pendingPermissions: [{ id: "r", kind: "tool" }] }));
  const fin = member(agent("fin", { status: "idle", requiresAttention: true, attentionReason: "finished" }));
  const stalled = member(agent("st", { status: "running", updatedAt: ago(1500) }));
  const brief = member(agent("brief", { status: "running", updatedAt: ago(300) })); // quiet < 10 min: not stalled
  const toolBusy = member(agent("tb", { status: "running", updatedAt: ago(4000) }));
  const projects = [[perm("p1"), stalled, fin], [perm("p2"), brief], [toolBusy, perm("p3")]];
  const tool = (a) => (a.id === "tb" ? 120 : null);
  const badge = (ms) => needsYouCount(ms, undefined, tool) + stalledCount(ms, NOW, tool); // pin.needsYou-style base + stalled delta
  const sum = projects.reduce((n, ms) => n + badge(ms), 0);
  assert.equal(sum, needsYouCount(projects.flat(), NOW, tool));
  assert.equal(sum, 4); // 3 permissions + 1 stalled; finished, <10m and tool-in-flight agents are not counted
});
