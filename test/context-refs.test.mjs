import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("parseContextRef: msg:-N (1..20) and idea-N only; rejects out-of-range and extra text", async () => {
  const { parseContextRef } = await import("../src/contextRefs.ts");
  assert.deepEqual(parseContextRef("msg:-1"), { kind: "msg", n: 1 });
  assert.deepEqual(parseContextRef("msg:-20"), { kind: "msg", n: 20 });
  assert.deepEqual(parseContextRef("msg:-12"), { kind: "msg", n: 12 });
  assert.deepEqual(parseContextRef("idea-1"), { kind: "idea", id: "idea-1" });
  assert.deepEqual(parseContextRef("idea-729"), { kind: "idea", id: "idea-729" });
  for (const bad of [
    "msg:-0", "msg:-21", "msg:0", "msg:1", "msg:-", "msg:-x", "msg:--1", "msg:-1.5",
    "idea-0", "idea", "idea-", "idea-x", "idea-1x",
    "", " ", " msg:-1", "msg:-1 ", "see msg:-1", "msg:-1 more", "Msg:-1", "IDEA-3",
    "msg:+1", "`msg:-1`", "idea-1 ",
  ]) {
    assert.equal(parseContextRef(bad), null, JSON.stringify(bad));
  }
});

test("resolveMsgRef: same-agent counting, skips user/tool/reasoning/other-agent, out-of-range -> not-loaded", async () => {
  const { resolveMsgRef } = await import("../src/contextRefs.ts");
  const A = "agent-a";
  const entries = [
    { item: { type: "user_message", text: "hello" } },
    { item: { type: "assistant_message", text: "a1", agentId: A } },
    { item: { type: "tool_call", name: "Bash" } },
    { item: { type: "assistant_message", text: "b1", agentId: "agent-b" } },
    { item: { type: "reasoning", text: "thinking" } },
    { item: { type: "assistant_message", text: "a2", agentId: A } },
    { item: { type: "assistant_message", text: "citing", agentId: A } },
  ];
  const citing = entries[6];
  assert.deepEqual(resolveMsgRef(entries, citing, 1, A), { status: "ok", entry: entries[5] });
  assert.deepEqual(resolveMsgRef(entries, citing, 2, A), { status: "ok", entry: entries[1] });
  assert.deepEqual(resolveMsgRef(entries, citing, 3, A), { status: "not-loaded" });
});

test("resolveMsgRef: single-agent timeline (no per-entry agent) counts every earlier assistant message", async () => {
  const { resolveMsgRef } = await import("../src/contextRefs.ts");
  const entries = [
    { item: { type: "user_message", text: "u" } },
    { item: { type: "assistant_message", text: "m1" } },
    { item: { type: "assistant_message", text: "m2" } },
    { item: { type: "assistant_message", text: "citing" } },
  ];
  assert.deepEqual(resolveMsgRef(entries, entries[3], 1, "agent-x"), { status: "ok", entry: entries[2] });
  assert.deepEqual(resolveMsgRef(entries, entries[3], 2, "agent-x"), { status: "ok", entry: entries[1] });
  assert.deepEqual(resolveMsgRef(entries, entries[3], 3, "agent-x"), { status: "not-loaded" });
  // citing entry not in the list -> not-loaded
  assert.deepEqual(resolveMsgRef(entries, { item: { type: "assistant_message", text: "nope" } }, 1, "agent-x"), { status: "not-loaded" });
});

test("Timeline wires context refs through the inline-code branch as tl-ref-link, file/commit keep priority", () => {
  const t = src("Timeline.tsx");
  assert.match(t, /!tgt && !sha && citing \? parseContextRef\(m\[7\]\)/);
  assert.match(t, /<RefLink[^>]*token=\{m\[7\]\}/);
  const r = src("RefPopover.tsx");
  assert.match(r, /className="tl-icode tl-ref-link"/);
  assert.match(r, /data-testid="tl-ref-link"/);
  assert.match(r, /role="button"/);
  assert.match(src("styles.css"), /\.tl-ref-link\.tl-icode/);
});

test("demo fixture carries ref tokens and the demo inbox seeds idea-729 so the popover is exercised", () => {
  const d = src("demo.tsx");
  assert.match(d, /`msg:-1`/);
  assert.match(d, /`msg:-20`/);
  assert.match(d, /`idea-729`/);
  assert.match(d, /`idea-999`/);
  const inbox = src("IdeaInbox.tsx");
  assert.match(inbox, /id: "idea-729"/);
});
