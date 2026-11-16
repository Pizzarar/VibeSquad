import assert from "node:assert/strict";
import test from "node:test";
import { STALLED_IN_NEEDS_YOU, attentionItems, clearItem, needsYouCount, stalledCount, stalledReason } from "../src/attentionItems.ts";
import { attentionOf } from "../src/teams.ts";
import { dismissLocal, resetAttentionLocal } from "../src/attentionLocal.ts";

// R4-1 interim: while STALLED_IN_NEEDS_YOU is false these stall-in-count tests are inert; the follow-up flips the switch and they run again.
const stallTest = STALLED_IN_NEEDS_YOU ? test : (name, fn) => test(name, { skip: "R4-1 interim: stalled is out of Needs you" }, fn);

test("R4-1 interim: a quiet running agent is NOT in Needs you (list, count, stalledCount); a real attention reason still is", () => {
  resetAttentionLocal();
  const quiet = member(agent("slow", { status: "running", updatedAt: ago(3000) }));
  const perm = member(agent("p", { status: "running", updatedAt: ago(3000), pendingPermissions: [{ id: "r", kind: "tool" }] }));
  if (!STALLED_IN_NEEDS_YOU) {
    assert.deepEqual(attentionItems([quiet], NOW), []);
    assert.equal(needsYouCount([quiet], NOW), 0);
    assert.equal(stalledCount([quiet], NOW), 0);
  }
  assert.deepEqual(attentionItems([quiet, perm], NOW).map((i) => [i.id, i.kind]), [["p", "permission"]]);
  assert.equal(stalledReason(quiet.agent, NOW) !== null, true); // helper itself is intact
});

const NOW = Date.parse("2026-11-15T12:00:00Z");
const ago = (s) => new Date(NOW - s * 1000).toISOString();
const agent = (id, extra = {}) => ({ id, title: `Agent ${id}`, status: "idle", labels: {}, ...extra });
const member = (a) => ({ agent: a, kind: "worker", attention: attentionOf(a) });

stallTest("stalled is an attention kind: a quiet running agent lists as stalled, only when `now` is passed", () => {
  resetAttentionLocal();
  const quiet = member(agent("slow", { status: "running", updatedAt: ago(700) }));
  const busy = member(agent("busy", { status: "running", updatedAt: ago(20) }));
  assert.deepEqual(attentionItems([quiet, busy]).map((i) => i.kind), []); // opt-in: badges stay unchanged
  const items = attentionItems([quiet, busy], NOW);
  assert.deepEqual(items.map((i) => [i.id, i.kind]), [["slow", "stalled"]]);
  assert.equal(items[0].reason, "Stalled: no update for 12m");
});

stallTest("stalled: a pending permission or an existing attention wins; dismissing hides it", async () => {
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

stallTest("stalled dismiss is keyed to activity: new activity then a fresh stall shows again", async () => {
  resetAttentionLocal();
  const quiet = (updatedAt) => member(agent("slow", { status: "running", updatedAt }));
  const [item] = attentionItems([quiet(ago(700))], NOW);
  await clearItem(item, { dismissLocal, refresh: () => {} });
  assert.equal(attentionItems([quiet(ago(700))], NOW).length, 0); // same stall stays dismissed
  assert.equal(attentionItems([quiet(ago(650))], NOW + 1000).length, 1); // it moved, then stalled again
});

stallTest("R3.2: stalled needs ~10 min quiet AND no tool in flight; below that it is out of list and count", () => {
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

stallTest("R3.2 parity: with everything collapsed, sum of per-container badges == Needs-you count (busy fixture, >10-min stalled agent)", () => {
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

stallTest("R3-2: an open tool_call (from timeline entries) keeps a quiet agent out of Needs you; once the result lands it is stalled", async () => {
  const { noteOpenTools, openToolSeconds, toolRunningSecondsAt, clearOpenTools } = await import("../src/openTools.ts");
  resetAttentionLocal();
  clearOpenTools();
  const quiet = member(agent("tooly", { status: "running", updatedAt: ago(700) }));
  noteOpenTools("tooly", [{ item: { type: "tool_call", status: "running", name: "Bash" }, timestamp: ago(690) }, { item: { type: "assistant_message" }, timestamp: ago(800) }]);
  assert.equal(openToolSeconds("tooly", NOW), 690);
  const cb = toolRunningSecondsAt(NOW);
  assert.equal(needsYouCount([quiet], NOW, cb), 0);
  assert.equal(stalledCount([quiet], NOW, cb), 0);
  assert.deepEqual(attentionItems([quiet], NOW, cb), []);
  noteOpenTools("tooly", [{ item: { type: "tool_call", status: "completed", name: "Bash" }, timestamp: ago(690) }]);
  assert.equal(openToolSeconds("tooly", NOW), null);
  assert.equal(needsYouCount([quiet], NOW, cb), 1);
  assert.equal(stalledCount([quiet], NOW, cb), 1);
  // never loaded timeline: plain 10-minute rule
  assert.equal(needsYouCount([member(agent("unseen", { status: "running", updatedAt: ago(700) }))], NOW, cb), 1);
  clearOpenTools();
});

stallTest("R3 L1: one shared `now` gives badge sum == list count at the 600s boundary; BoringInbox owns no tick", async () => {
  const { readFileSync } = await import("node:fs");
  resetAttentionLocal();
  const a = member(agent("a", { status: "running", updatedAt: ago(599) }));
  const b = member(agent("b", { status: "running", updatedAt: ago(10) }));
  for (const [now, want] of [[NOW, 0], [NOW + 1000, 1]]) {
    const list = needsYouCount([a, b], now);
    const badges = stalledCount([a], now) + stalledCount([b], now); // per-container badges at the SAME now
    assert.equal(list, want);
    assert.equal(badges, list);
  }
  const inbox = readFileSync(new URL("../src/BoringInbox.tsx", import.meta.url), "utf8");
  assert.ok(!/setInterval/.test(inbox), "BoringInbox must take `now` from BoringApp");
  const ade = readFileSync(new URL("../src/BoringAde.tsx", import.meta.url), "utf8");
  assert.ok(/<BoringInbox[\s\S]*?now=\{now\}/.test(ade));
});
