import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { LATER_MS, answerItem, attentionItems, clearAll, clearItem, countedItems, laterItem } from "../src/attentionItems.ts";
import { attentionOf } from "../src/teams.ts";
import {
  clearUnreadLocal,
  dismissLocal,
  markUnreadLocal,
  resetAttentionLocal,
  snoozeLocal,
} from "../src/attentionLocal.ts";

const agent = (id, extra = {}) => ({ id, title: `Agent ${id}`, status: "idle", labels: {}, ...extra });
const member = (a) => ({ agent: a, kind: "lead", attention: attentionOf(a) });

function mkDeps(clock = { t: 1_000_000 }) {
  const calls = [];
  const timers = [];
  const rec = (name) => async (...args) => void calls.push([name, ...args]);
  return {
    calls,
    timers,
    clock,
    deps: {
      clearNeedsYou: rec("clearNeedsYou"),
      snoozeNeedsYou: rec("snoozeNeedsYou"),
      clearAgentAttention: rec("clearAgentAttention"),
      respondToPermission: rec("respondToPermission"),
      snoozeLocal: (...a) => (calls.push(["snoozeLocal", ...a]), snoozeLocal(...a)),
      dismissLocal: (...a) => (calls.push(["dismissLocal", ...a]), dismissLocal(...a)),
      clearUnreadLocal: (...a) => (calls.push(["clearUnreadLocal", ...a]), clearUnreadLocal(...a)),
      now: () => clock.t,
      after: (ms, fn) => timers.push({ at: clock.t + ms, fn }),
      refresh: () => {},
    },
  };
}

const fixtures = () => ({
  perm: agent("perm", { pendingPermissions: [{ id: "req1", kind: "tool", name: "Bash" }] }),
  question: agent("q", { pendingPermissions: [{ id: "req2", kind: "question" }] }),
  label: agent("label", { labels: { "needs-you": "merge", "needs-you-reason": "approve merge" } }),
  err: agent("err", { status: "error", lastError: "boom" }),
  fin: agent("fin", { requiresAttention: true, attentionReason: "finished" }),
});

test("each attention kind maps to the right list kind; finished is listed but not counted", () => {
  resetAttentionLocal();
  const f = fixtures();
  const items = attentionItems(Object.values(f).map(member));
  assert.deepEqual(items.map((i) => [i.id, i.kind]), [
    ["perm", "permission"],
    ["q", "permission"],
    ["label", "label"],
    ["err", "error"],
    ["fin", "finished"],
  ]);
  assert.equal(countedItems(items).length, 4);
  assert.ok(items[0].quickPermission, "plain tool permission is answerable inline");
  assert.equal(items[1].quickPermission, undefined, "question needs the chat");
});

test("Clear: label → clearNeedsYou; error/finished → dismiss locally + Paseo clear_agent_attention", async () => {
  resetAttentionLocal();
  const f = fixtures();
  const items = attentionItems(Object.values(f).map(member));
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  let h = mkDeps();
  await clearItem(byId.label, h.deps);
  assert.deepEqual(h.calls, [["clearNeedsYou", f.label]]);
  h = mkDeps();
  await clearItem(byId.err, h.deps);
  assert.deepEqual(h.calls, [["dismissLocal", "err", "boom"], ["clearAgentAttention", "err"]]);
  h = mkDeps();
  await clearItem(byId.fin, h.deps);
  assert.deepEqual(h.calls, [["dismissLocal", "fin", "finished"], ["clearAgentAttention", "fin"]]);
  await assert.rejects(clearItem(byId.perm, mkDeps().deps), /Approve/);
});

test("Clear drops the badge count at once (local dismissal), error and finished", async () => {
  resetAttentionLocal();
  const f = fixtures();
  const count = () => countedItems(attentionItems([f.err, f.fin].map(member))).length;
  assert.equal(count(), 1);
  const items = attentionItems([f.err, f.fin].map(member));
  await clearItem(items.find((i) => i.id === "err"), mkDeps().deps);
  assert.equal(count(), 0);
  assert.equal(attentionOf(f.fin)?.tone, "finished", "finished is untouched until cleared");
});

test("Approve / Deny call respondToPermission with the request id; questions refuse", async () => {
  resetAttentionLocal();
  const f = fixtures();
  const [perm, q] = attentionItems([f.perm, f.question].map(member));
  const h = mkDeps();
  await answerItem(perm, "allow", h.deps);
  await answerItem(perm, "deny", h.deps);
  assert.deepEqual(h.calls, [
    ["respondToPermission", "perm", "req1", { behavior: "allow" }],
    ["respondToPermission", "perm", "req1", { behavior: "deny" }],
  ]);
  await assert.rejects(answerItem(q, "allow", h.deps), /chat/);
});

test("Later: label → snoozeNeedsYou 2h; error → local snooze that expires after 2h (fake clock)", async () => {
  resetAttentionLocal();
  const f = fixtures();
  const items = attentionItems(Object.values(f).map(member));
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  let h = mkDeps();
  await laterItem(byId.label, h.deps);
  assert.deepEqual(h.calls, [["snoozeNeedsYou", f.label, 2 * 3_600_000]]);

  h = mkDeps({ t: Date.now() });
  await laterItem(byId.err, h.deps);
  assert.equal(h.calls[0][0], "snoozeLocal");
  assert.equal(h.timers.length, 1, "a refresh is scheduled for expiry");
  assert.ok(h.timers[0].at >= h.clock.t + LATER_MS);
  assert.equal(attentionOf(f.err), null, "hidden while snoozed");
  // Real clock can't be faked inside attentionOf; re-snooze into the past to model "2h later".
  snoozeLocal("err", Date.now() - 1);
  assert.equal(attentionOf(f.err)?.tone, "error", "returns after the snooze ends");
});

test("Clear all clears every non-permission row and reports failures", async () => {
  resetAttentionLocal();
  const f = fixtures();
  const items = attentionItems(Object.values(f).map(member));
  const h = mkDeps();
  h.deps.clearNeedsYou = async () => {
    throw new Error("nope");
  };
  const r = await clearAll(items, h.deps);
  assert.deepEqual(r, { cleared: 2, failed: 1 });
  assert.ok(!h.calls.some((c) => c[0] === "respondToPermission"));
});

test("Mark unread puts a quiet chat back in the list; Later hides it, Clear removes it", async () => {
  resetAttentionLocal();
  const quiet = agent("quiet");
  assert.equal(attentionOf(quiet), null);
  markUnreadLocal("quiet");
  let items = attentionItems([member(quiet)]);
  assert.deepEqual(items.map((i) => i.kind), ["unread"]);
  const h = mkDeps({ t: Date.now() });
  await laterItem(items[0], h.deps);
  assert.equal(attentionOf(quiet), null);
  snoozeLocal("quiet", Date.now() - 1);
  items = attentionItems([member(quiet)]);
  assert.equal(items[0].kind, "unread");
  await clearItem(items[0], h.deps);
  assert.equal(attentionOf(quiet), null);
});

test("wiring: both badges open the list; ⋯ More has Mark unread; classes styled", () => {
  const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  assert.match(src("App.tsx"), /<AttentionBadge view=\{v\} onOpen=\{pick\} hubQueueInstead \/>/);
  assert.match(src("PinGrid.tsx"), /<AttentionBadge view=\{v\}/);
  assert.match(src("DrawerHeader.tsx"), /markAgentUnread\(agent\)/);
  assert.match(src("paseo.ts"), /daemonClient\.clearAgentAttention\(agentId\)/);
  assert.match(src("paseo.ts"), /daemonClient\.markWorkspaceUnread\(ws\)/);
});

import { applyLabelsOptimistic } from "../src/attentionItems.ts";
import { loadAttentionLocal, snapshotAttentionLocal } from "../src/attentionLocal.ts";

test("optimistic label update: a daemon push survives a failing update's rollback", async () => {
  let labels = { "needs-you": "merge", other: "a" };
  let status = "idle";
  const io = {
    get: () => labels,
    patch: (fn) => void (labels = fn(labels)),
    send: async () => {
      status = "running"; // live push lands mid-flight, plus a newer value for another key
      labels = { ...labels, other: "pushed" };
      throw new Error("daemon down");
    },
  };
  await assert.rejects(applyLabelsOptimistic({ "needs-you": "cleared", "needs-you-until": "" }, io), /daemon down/);
  assert.equal(status, "running");
  assert.equal(labels.other, "pushed");
  assert.equal(labels["needs-you"], "merge", "our key rolled back");
  assert.ok(!("needs-you-until" in labels), "key we added is removed");
});

test("optimistic label update: rollback leaves a key a newer edit owns; two quick edits both survive", async () => {
  let labels = { a: "1" };
  const patch = (fn) => void (labels = fn(labels));
  let failFirst;
  const first = applyLabelsOptimistic({ a: "2" }, { get: () => labels, patch, send: () => new Promise((_, rej) => (failFirst = rej)) });
  await applyLabelsOptimistic({ b: "x" }, { get: () => labels, patch, send: async () => {} });
  assert.deepEqual(labels, { a: "2", b: "x" });
  failFirst(new Error("late fail"));
  await assert.rejects(first);
  assert.deepEqual(labels, { a: "1", b: "x" }, "only the failed edit's key reverts");
});

test("attentionLocal: invalid JSON shapes reset to empty", () => {
  for (const raw of ["null", "42", '"x"', "[]", "{bad", '{"unread":"nope","snoozed":[],"dismissed":5}']) {
    loadAttentionLocal(raw);
    assert.deepEqual(snapshotAttentionLocal(), { snoozed: {}, dismissed: {}, unread: [] }, raw);
  }
});

test("attentionLocal: expired snoozes are pruned on load; entries capped; bad values dropped", () => {
  const now = 1_000_000;
  const snoozedIn = { old: now - 1, live: now + 5, bad: "x" };
  for (let i = 0; i < 300; i++) snoozedIn[`s${i}`] = now + 1000 + i;
  loadAttentionLocal(JSON.stringify({ snoozed: snoozedIn, dismissed: { a: "sig", b: 3 }, unread: ["u", 7, ...Array.from({ length: 300 }, (_, i) => `n${i}`)] }), now);
  const s = snapshotAttentionLocal(now);
  assert.ok(!("old" in s.snoozed) && !("bad" in s.snoozed));
  assert.equal(Object.keys(s.snoozed).length, 200);
  assert.deepEqual(s.dismissed, { a: "sig" });
  assert.equal(s.unread.length, 200);
  assert.ok(s.unread.every((u) => typeof u === "string"));
  resetAttentionLocal();
});
