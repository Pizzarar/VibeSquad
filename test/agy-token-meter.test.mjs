// docs/PLAN_AGY_TOKEN_USAGE.md (Block 2): every row/card/pill must reflect `usedTokens(m)`,
// not just `lastUsage.contextWindowUsedTokens`, so changes to the brainstorm fallback re-render.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { brainstormUsedTokens, usedTokens } from "../src/teams.ts";
import { leadUsedTokens } from "../server/lead-handoff.mjs";

// ---- fixtures ---------------------------------------------------------------------

const agent = (over = {}) => ({ labels: {}, lastUsage: {}, ...over });
const member = (a, over = {}) => ({ agent: a, kind: "worker", ...over });

// ---- usedTokens -------------------------------------------------------------------

test("usedTokens returns lastUsage.contextWindowUsedTokens when set", () => {
  assert.equal(usedTokens(member(agent({ lastUsage: { contextWindowUsedTokens: 42000 } }))), 42000);
  // also accepts a raw PaseoAgent (no `agent` wrapper)
  assert.equal(usedTokens(agent({ lastUsage: { contextWindowUsedTokens: 1337 } })), 1337);
});

test("usedTokens falls back to brainstormUsedTokens (inputTokens) when contextWindowUsedTokens is absent", () => {
  const m = member(agent({ lastUsage: { inputTokens: 7500 } }));
  assert.equal(usedTokens(m), 7500);
  assert.equal(usedTokens(m), brainstormUsedTokens(m.agent));
});

test("usedTokens honors labels['vs.mock-tokens'] over real usage", () => {
  const m = member(
    agent({ labels: { "vs.mock-tokens": "1234" }, lastUsage: { contextWindowUsedTokens: 999999 } }),
  );
  assert.equal(usedTokens(m), 1234);
});

test("usedTokens treats a brainstorm agent via the brainstorm path", () => {
  const m = member(agent({ labels: { role: "brainstorm" }, lastUsage: { inputTokens: 500 } }));
  assert.equal(usedTokens(m), 500);
});

test("usedTokens returns 0 when nothing is set", () => {
  assert.equal(usedTokens(member(agent({}))), 0);
});

// ---- leadUsedTokens (server handoff path) -----------------------------------------

test("leadUsedTokens prefers an explicit override", () => {
  assert.equal(leadUsedTokens({ lastUsage: { contextWindowUsedTokens: 5 } }, 100), 100);
});

test("leadUsedTokens prefers lead.usedTokens", () => {
  assert.equal(leadUsedTokens({ usedTokens: 42, lastUsage: { contextWindowUsedTokens: 5 } }), 42);
});

test("leadUsedTokens honors labels['vs.mock-tokens']", () => {
  assert.equal(leadUsedTokens({ labels: { "vs.mock-tokens": "777" }, lastUsage: { contextWindowUsedTokens: 5 } }), 777);
});

test("leadUsedTokens reads contextUsage.usedTokens", () => {
  assert.equal(leadUsedTokens({ contextUsage: { usedTokens: 123 } }), 123);
});

test("leadUsedTokens reads lastUsage.contextWindowUsedTokens", () => {
  assert.equal(leadUsedTokens({ lastUsage: { contextWindowUsedTokens: 456 } }), 456);
});

test("leadUsedTokens falls back to inputTokens, then 0", () => {
  assert.equal(leadUsedTokens({ lastUsage: { inputTokens: 90 } }), 90);
  assert.equal(leadUsedTokens({}), 0);
});

// ---- src/ui.tsx wiring (source inspection) ----------------------------------------

const uiSrc = readFileSync(new URL("../src/ui.tsx", import.meta.url), "utf8");

test("AgentRow and TreeRow both pass used={usedTokens(m)} into TokenMeter", () => {
  const wiring = uiSrc.match(/used=\{usedTokens\(m\)\}/g) ?? [];
  assert.equal(wiring.length, 2, "expected exactly one wiring in AgentRow and one in TreeRow");
  assert.equal(uiSrc.includes("used={a.lastUsage?.contextWindowUsedTokens}"), false, "old wiring must be gone");
});

test("sameMember compares usedTokens(a) === usedTokens(b)", () => {
  const start = uiSrc.indexOf("export function sameMember");
  const end = uiSrc.indexOf("const diagKey", start);
  assert.ok(start >= 0 && end > start, "could not locate sameMember body");
  const body = uiSrc.slice(start, end);
  assert.match(body, /usedTokens\(a\) === usedTokens\(b\)/);
});
