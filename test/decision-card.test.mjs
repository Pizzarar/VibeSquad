// E2: parser + dismiss-id behaviour of the Overlord decision card (src/decisionLogic.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  alternativeText, approvalText, decisionCardId, decisionFromEntries, decisionFromText, hasActiveNeedsYou, parseDecision, parseRiffLane,
} from "../src/decisionLogic.ts";

const FENCE = (body) => "Blocked.\n\n```vs:decision\n" + body + "\n```\n";
const GOOD = "summary: Merge blocked, 2 tests fail.\ndo: Rebase and rerun the suite\nalt: Merge anyway\nalt: Hold the merge\nvs:riff @and";

test("well-formed fence parses every field", () => {
  const d = parseDecision(GOOD);
  assert.deepEqual(d, { summary: "Merge blocked, 2 tests fail.", action: "Rebase and rerun the suite", alternatives: ["Merge anyway", "Hold the merge"], riffLane: "and" });
});

test("missing summary or do rejects the card", () => {
  assert.equal(parseDecision("do: x\nalt: y"), null);
  assert.equal(parseDecision("summary: x\nalt: y"), null);
  assert.equal(parseDecision("summary:   \ndo: x"), null);
  assert.equal(parseDecision(""), null);
  assert.equal(parseDecision(undefined), null);
});

test("malformed lines are skipped, first summary/do wins, whitespace collapses", () => {
  const d = parseDecision("garbage line\nsummary:  a   b \nsummary: later\ndo: first\ndo: second\nnonsense: z\n- bullet");
  assert.equal(d.summary, "a b");
  assert.equal(d.action, "first");
  assert.deepEqual(d.alternatives, []);
  assert.equal(d.riffLane, null);
});

test("alternatives: several, capped, duplicates of the action dropped, CRLF ok", () => {
  const body = ["summary: s", "do: Fix it", ...Array.from({ length: 9 }, (_, i) => `alt: option ${i}`), "alt: fix it"].join("\r\n");
  const d = parseDecision(body);
  assert.equal(d.alternatives.length, 6);
  assert.ok(!d.alternatives.includes("fix it"));
});

test("riff lane must be a lane slug", () => {
  for (const ok of ["@and", "and", "`@ade`", "@bug-chaser", "@art_2"]) assert.ok(parseRiffLane(ok), ok);
  for (const bad of ["@", "../etc", "@a/b", "@a b", "@<script>", "@-x", "@" + "a".repeat(33), "http://x", ""]) assert.equal(parseRiffLane(bad), null, bad);
  const d = parseDecision("summary: s\ndo: d\nvs:riff @../evil");
  assert.ok(d, "a bad lane drops the riff button, not the card");
  assert.equal(d.riffLane, null);
  assert.equal(parseDecision("summary: s\ndo: d\nriff: @and").riffLane, "and");
});

test("decisionFromText finds the last real fence and ignores nested examples", () => {
  const o = decisionFromText("a", FENCE(GOOD));
  assert.equal(o.action, "Rebase and rerun the suite");
  assert.match(o.id, /^decision:\*:and:/);
  const nested = "Example:\n````md\n```vs:decision\nsummary: s\ndo: d\n```\n````\n";
  assert.equal(decisionFromText("a", nested), null);
  const two = FENCE("summary: one\ndo: a") + FENCE("summary: two\ndo: b");
  assert.equal(decisionFromText("a", two).summary, "two");
  assert.equal(decisionFromText("a", "```vs:decision\nsummary: cut\ndo: off").summary, "cut");
  assert.equal(decisionFromText("a", "no fence here"), null);
});

test("dismiss id: agent-independent, content-stable, changes with content", () => {
  const d = parseDecision(GOOD);
  assert.equal(decisionCardId("agent-1", d), decisionCardId("agent-2", d));
  assert.equal(decisionCardId("a", d), decisionFromText("b", FENCE(GOOD)).id, "inline (parsed body) and pinned (parsed message) share one id");
  assert.notEqual(decisionCardId("a", d), decisionCardId("a", { ...d, action: "Something else" }));
  assert.notEqual(decisionCardId("a", d), decisionCardId("a", { ...d, riffLane: null }));
});

test("decisionFromEntries uses only the newest assistant message", () => {
  const msg = (text) => ({ item: { type: "assistant_message", text } });
  assert.ok(decisionFromEntries("a", [msg(FENCE(GOOD)), { item: { type: "user_message", text: "ok" } }]));
  assert.equal(decisionFromEntries("a", [msg(FENCE(GOOD)), msg("Done, thanks.")]), null);
  assert.equal(decisionFromEntries("a", []), null);
});

test("reply texts are plain sentences carrying the chosen action", () => {
  assert.match(approvalText({ action: "Rebase" }), /^Approved: Rebase/);
  assert.match(alternativeText("Hold"), /Hold$/);
});

test("needs-you is active on the current or legacy label, not once cleared", () => {
  assert.equal(hasActiveNeedsYou({ "needs-you": "x" }, "legacy"), true);
  assert.equal(hasActiveNeedsYou({ legacy: "x" }, "legacy"), true);
  assert.equal(hasActiveNeedsYou({ "needs-you": "cleared", legacy: "cleared" }, "legacy"), false);
  assert.equal(hasActiveNeedsYou(undefined, "legacy"), false);
});

test("double-tap: the second synchronous acquire is refused until released", async () => {
  const { createSendLock, tryAcquire } = await import("../src/sendGuard.ts");
  const lock = createSendLock();
  assert.equal(tryAcquire(lock), true);
  assert.equal(tryAcquire(lock), false);
  lock.held = false;
  assert.equal(tryAcquire(lock), true);
});

test("wiring: pinned in the Overlord chat, inline in Timeline, bug pill in the cockpit slot, duties teach the fence", () => {
  assert.match(readFileSync("src/PhoneCockpit.tsx", "utf8"), /chatOnly pinDecisions/);
  assert.match(readFileSync("src/Timeline.tsx", "utf8"), /vs:decision/);
  assert.match(readFileSync("src/App.tsx", "utf8"), /bugSlot=\{view \? <PhoneBugPill view=\{view\} \/> : undefined\}/);
  assert.match(readFileSync("server/hooks/agent-duties.ts", "utf8"), /```vs:decision/);
});
