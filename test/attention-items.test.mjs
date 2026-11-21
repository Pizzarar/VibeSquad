import assert from "node:assert/strict";
import test from "node:test";
import { STALLED_IN_NEEDS_YOU, attentionItems, openToolOf, clearItem, needsYouCount, needsYouTotal, stalledCount, stalledReason } from "../src/attentionItems.ts";
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
  // a tool call in flight (server openToolSince, under its ceiling) is never stalled, however quiet
  assert.equal(attentionItems([member(agent("t", { status: "running", updatedAt: ago(3000), openToolSince: NOW - 240_000 }))], NOW).length, 0);
  assert.equal(stalledReason(agent("x", { status: "running", updatedAt: ago(3000), openToolSince: NOW - 1000 }), NOW), null);
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
  const toolBusy = member(agent("tb", { status: "running", updatedAt: ago(4000), openToolSince: NOW - 120_000 }));
  const projects = [[perm("p1"), stalled, fin], [perm("p2"), brief], [toolBusy, perm("p3")]];
  const badge = (ms) => needsYouCount(ms) + stalledCount(ms, NOW); // pin.needsYou-style base + stalled delta
  const sum = projects.reduce((n, ms) => n + badge(ms), 0);
  assert.equal(sum, needsYouCount(projects.flat(), NOW));
  assert.equal(sum, 4); // 3 permissions + 1 stalled; finished, <10m and tool-in-flight agents are not counted
});

test("R5-3: no timeline hint: a quiet agent is stalled unless its payload reports a tool in flight (openToolSince)", () => {
  resetAttentionLocal();
  const quiet = member(agent("q", { status: "running", updatedAt: ago(700) }));
  assert.equal(needsYouCount([quiet], NOW), 1); // absent field == no tool in flight
  const tooly = member(agent("tooly", { status: "running", updatedAt: ago(700), openToolSince: NOW - 690_000 }));
  assert.equal(needsYouCount([tooly], NOW), 0);
  assert.equal(openToolOf(tooly.agent, NOW).seconds, 690);
});

test("R5-2: needsYouTotal == the sum of per-project needsYouCount at one `now` (title/favicon number == the Needs-you heading)", () => {
  resetAttentionLocal();
  const perm = member(agent("p", { status: "idle", requiresAttention: true, attentionReason: "permission", pendingPermissions: [{ id: "r", kind: "tool" }] }));
  const fin = member(agent("f", { status: "idle", requiresAttention: true, attentionReason: "finished" }));
  const stalled = member(agent("s", { status: "running", updatedAt: ago(900) }));
  const views = [{ members: [perm, fin] }, { members: [stalled] }];
  assert.equal(needsYouTotal(views, NOW), 2); // permission + stalled; finished never counts
  assert.equal(needsYouTotal(views, NOW - 800_000), 1); // before the 10-minute threshold the stalled agent is not counted
  assert.equal(needsYouTotal([], NOW), 0);
});

test("R3 L1: one shared `now` gives badge sum == list count at the 600s boundary; BoringInbox owns no tick", async () => {
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

// ---- R4-1 option (a): the server's openToolSince / openToolName / openToolTimeoutMs drive the one stall rule ---------------------

const MIN = 60;
test("R4-1: the switch is on: stalled is back in the Needs-you list, count and stalledCount", () => {
  resetAttentionLocal();
  assert.equal(STALLED_IN_NEEDS_YOU, true);
  const quiet = member(agent("slow", { status: "running", updatedAt: ago(11 * MIN), openToolSince: null }));
  assert.deepEqual(attentionItems([quiet], NOW).map((i) => [i.id, i.kind, i.reason]), [["slow", "stalled", "Stalled: no update for 11m"]]);
  assert.equal(needsYouCount([quiet], NOW), 1);
  assert.equal(stalledCount([quiet], NOW), 1);
});

test("R4-1 rule: quiet >= 10m with no open tool, OR open tool >= ceiling (its own timeout, else 60m); reason names the tool", () => {
  resetAttentionLocal();
  const run = (extra) => agent("a", { status: "running", updatedAt: ago(30 * MIN), ...extra });
  // open tool under the 60m default ceiling: not stalled however quiet
  assert.equal(stalledReason(run({ openToolSince: NOW - 59 * MIN * 1000, openToolName: "Bash", openToolTimeoutMs: null }), NOW), null);
  // at / past the default ceiling
  assert.equal(stalledReason(run({ openToolSince: NOW - 60 * MIN * 1000, openToolName: "Bash", openToolTimeoutMs: null }), NOW), "Tool Bash running 60m");
  assert.equal(stalledReason(run({ openToolSince: NOW - 75 * MIN * 1000, openToolName: "Task", openToolTimeoutMs: null }), NOW), "Tool Task running 75m");
  // the tool's own timeout replaces the 60m ceiling
  // R5-5: + 60s grace over the tool's own timeout (120s -> 180s)
  assert.equal(stalledReason(run({ openToolSince: NOW - 3 * MIN * 1000, openToolName: "Bash", openToolTimeoutMs: 120000 }), NOW), "Tool Bash running 3m");
  assert.equal(stalledReason(run({ openToolSince: NOW - 179 * 1000, openToolName: "Bash", openToolTimeoutMs: 120000 }), NOW), null);
  // R5-5: a whole script as the tool name shows as its first word, capped
  assert.equal(stalledReason(run({ openToolSince: NOW - 70 * MIN * 1000, openToolName: "$iso = Join-Path $env:TEMP x git status", openToolTimeoutMs: null }), NOW), "Tool $iso running 70m");
  // the ceiling case fires even with a fresh updatedAt (a hung tool whose agent keeps streaming usage)
  assert.equal(stalledReason(agent("a", { status: "running", updatedAt: ago(5), openToolSince: NOW - 61 * MIN * 1000, openToolName: "Bash" }), NOW), "Tool Bash running 61m");
  // server says no tool: the 10m quiet rule
  assert.equal(stalledReason(run({ openToolSince: null }), NOW), "Stalled: no update for 30m");
  assert.equal(stalledReason(agent("a", { status: "running", updatedAt: ago(9 * MIN), openToolSince: null }), NOW), null);
  // not running / pending permission: never stalled, tool or not
  assert.equal(stalledReason(run({ status: "idle", openToolSince: NOW - 90 * MIN * 1000 }), NOW), null);
  assert.equal(stalledReason(run({ pendingPermissions: [{ id: "r" }], openToolSince: NOW - 90 * MIN * 1000 }), NOW), null);
  // a missing / invalid updatedAt never hides the tool-ceiling reason (that branch does not read it); it only rules out "quiet"
  for (const updatedAt of [undefined, "", "not-a-date"]) {
    assert.equal(stalledReason(agent("a", { status: "running", updatedAt, openToolSince: NOW - 61 * MIN * 1000, openToolName: "Bash" }), NOW), "Tool Bash running 61m", String(updatedAt));
    assert.equal(stalledReason(agent("a", { status: "running", updatedAt, openToolSince: null }), NOW), null, `no quiet stall without a time: ${updatedAt}`);
  }
  // the item reason and the count follow the same rule
  const hung = member(run({ openToolSince: NOW - 61 * MIN * 1000, openToolName: "Bash" }));
  assert.deepEqual(attentionItems([hung], NOW).map((i) => [i.kind, i.reason]), [["stalled", "Tool Bash running 61m"]]);
  assert.equal(needsYouCount([hung], NOW), 1);
});

test("R4-1/R5-3: the server field is the only source (no timeline hint); absent reads as no tool in flight", () => {
  resetAttentionLocal();
  const quiet = (extra) => agent("q", { status: "running", updatedAt: ago(20 * MIN), ...extra });
  assert.equal(stalledReason(quiet({ openToolSince: null }), NOW), "Stalled: no update for 20m");
  assert.equal(needsYouCount([member(quiet({ openToolSince: null }))], NOW), 1);
  assert.equal(stalledReason(quiet({}), NOW), "Stalled: no update for 20m");
  assert.deepEqual(openToolOf(quiet({ openToolSince: NOW - 5000, openToolName: "Read", openToolTimeoutMs: 0 }), NOW), { seconds: 5, name: "Read", timeoutMs: null });
  assert.equal(openToolOf(quiet({}), NOW), null);
});


// ---- R6-2: Ctrl+J and the Needs-you count share one list; a closed/retired agent appears nowhere -------------------------------
test("R6-2: Ctrl+J reads the Needs-you list (not the rail); railAlerts and the header drop retired agents", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const app = read("../src/App.tsx");
  assert.match(app, /topNeedsYouId\(derived\(\)\.views, nowTickValue\(\)\)/);
  assert.match(app, /vs:boring-open-agent/);
  const top = read("../src/needsYouTop.ts");
  assert.match(top, /needsYouRows\(views, now\)\.filter\(\(r\) => r\.item\.kind !== "finished"\)/);
  assert.match(read("../src/FocusRail.tsx"), /!m\.agent\.archivedAt && !isRetiredAgent\(m\.agent\)/);
  assert.match(read("../src/BoringAgentHeader.tsx"), /showNeedsYou = !isRetiredAgent\(agent\)/);
  // attentionItems already drops closed/archived, so a closed lead with a needs-you label never reaches the list or the count.
  resetAttentionLocal();
  const closed = member(agent("c", { status: "closed", labels: { "needs-you": "pick" } }));
  assert.deepEqual(attentionItems([closed], NOW), []);
});

test("idea-493: glyphStatusOf = 90s quiet glyph rule; isNeedsYouStalled = the 10m Needs-you rule (tool in flight clears the glyph)", async () => {
  const { glyphStatusOf, isNeedsYouStalled } = await import("../src/attentionItems.ts");
  const now = Date.now();
  const ago = (s) => new Date(now - s * 1000).toISOString();
  const w = (status, s, extra = {}) => ({ kind: "worker", laneId: "x", attention: null, agent: { id: "w", status, updatedAt: ago(s), ...extra } });
  assert.equal(glyphStatusOf(w("running", 30).agent, now), "running");
  assert.equal(glyphStatusOf(w("running", 120).agent, now), "quiet");
  assert.equal(glyphStatusOf(w("running", 120, { openToolSince: now - 60_000 }).agent, now), "running");
  assert.equal(glyphStatusOf(w("idle", 9999).agent, now), "idle");
  assert.equal(isNeedsYouStalled(w("running", 120), now), false);
  assert.equal(isNeedsYouStalled(w("running", 2400), now), true);
});

test("idea-493 R2: hung tool past its ceiling = stalled glyph; in-ceiling tool = running; quiet 90s-10m = quiet; isInNeedsYou covers permission/error/stalled, not finished", async () => {
  const { glyphStatusOf, isInNeedsYou } = await import("../src/attentionItems.ts");
  const now = Date.now();
  const w = (status, s, extra = {}, attention = null) => ({ kind: "worker", laneId: "x", attention, agent: { id: "w", status, updatedAt: new Date(now - s * 1000).toISOString(), ...extra } });
  assert.equal(glyphStatusOf(w("running", 30, { openToolSince: now - 65 * 60_000 }).agent, now), "stalled");
  assert.equal(glyphStatusOf(w("running", 30, { openToolSince: now - 5 * 60_000 }).agent, now), "running");
  assert.equal(glyphStatusOf(w("running", 120).agent, now), "quiet");
  assert.equal(glyphStatusOf(w("running", 2400).agent, now), "stalled");
  assert.equal(isInNeedsYou(w("running", 30), now), false);
  assert.equal(isInNeedsYou(w("running", 30, {}, { tone: "permission", reason: "Allow?" }), now), true);
  assert.equal(isInNeedsYou(w("running", 30, {}, { tone: "finished", reason: "done" }), now), false);
  assert.equal(isInNeedsYou(w("running", 2400), now), true);
});
