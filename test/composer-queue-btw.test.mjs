import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Composer queue + /btw: pure helpers are mirrored here (Node-only, no DOM),
// plus source assertions that the Composer/Drawer wiring is actually present.

const src = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");

const FALLBACK_COMMANDS = ["/btw", "/compact", "/clear", "/help", "/model", "/mode", "/rewind"];

function filterSlash(cmds, query) {
  const q = query.toLowerCase();
  return cmds.filter((c) => c.replace(/^\//, "").toLowerCase().startsWith(q)).slice(0, 8);
}

function formatBtwPrompt(text) {
  const m = /^\s*\/btw(?:\s+([\s\S]*))?$/i.exec(text);
  if (!m) return text;
  const body = (m[1] ?? "").trim();
  if (!body) return text;
  return `[BTW side-note — answer briefly in 1-2 lines or note in SPEC.md without stopping or changing current task]: ${body}`;
}

function shouldQueueOnSend(agentStatus, forceImmediate = false) {
  return agentStatus === "running" && !forceImmediate;
}

test("composer-queue-btw: FALLBACK_COMMANDS includes /btw and filters to it", () => {
  assert.ok(FALLBACK_COMMANDS.includes("/btw"), "FALLBACK_COMMANDS should include /btw");
  assert.deepEqual(filterSlash(FALLBACK_COMMANDS, "b"), ["/btw"]);
  assert.equal(FALLBACK_COMMANDS.length, 7);

  // The real source list must also carry /btw first (not just this mirror).
  assert.match(src("Composer.tsx"), /export const FALLBACK_COMMANDS = \["\/btw", "\/compact", "\/clear", "\/help", "\/model", "\/mode", "\/rewind"\];/);
});

test("composer-queue-btw: formatBtwPrompt rewrites /btw and leaves normal text alone", () => {
  assert.equal(
    formatBtwPrompt("/btw why did paseo hang?"),
    "[BTW side-note — answer briefly in 1-2 lines or note in SPEC.md without stopping or changing current task]: why did paseo hang?",
  );
  // leading/trailing whitespace is tolerated and body is trimmed
  assert.equal(
    formatBtwPrompt("  /btw   please note this   "),
    "[BTW side-note — answer briefly in 1-2 lines or note in SPEC.md without stopping or changing current task]: please note this",
  );
  // bare /btw with no body is left unchanged
  assert.equal(formatBtwPrompt("/btw"), "/btw");
  // case-insensitive command
  assert.equal(
    formatBtwPrompt("/BTW case check"),
    "[BTW side-note — answer briefly in 1-2 lines or note in SPEC.md without stopping or changing current task]: case check",
  );
  // normal messages are untouched
  assert.equal(formatBtwPrompt("fix the bug please"), "fix the bug please");
  assert.equal(formatBtwPrompt("btw is not a command"), "btw is not a command");
});

test("composer-queue-btw: shouldQueueOnSend only queues while running without forceImmediate", () => {
  assert.equal(shouldQueueOnSend("running", false), true);
  assert.equal(shouldQueueOnSend("idle", false), false);
  assert.equal(shouldQueueOnSend("running", true), false);
  assert.equal(shouldQueueOnSend(undefined, false), false);
});

test("composer-queue-btw: Composer renders queued banner and Send this now, Drawer wires sendQueuedNow", () => {
  const comp = src("Composer.tsx");
  const drawer = src("AgentDrawer.tsx");

  assert.match(comp, /data-testid="composer-queued-banner"/);
  assert.match(comp, /data-testid="composer-send-now-btn"/);
  assert.match(comp, /data-testid="composer-queued-cancel-btn"/);
  assert.match(comp, /export function formatBtwPrompt/);
  assert.match(comp, /export function shouldQueueOnSend/);
  assert.match(comp, /export type QueuedTurnItem/);

  assert.match(drawer, /sendQueuedNow/);
  assert.match(drawer, /formatBtwPrompt/);
  assert.match(drawer, /shouldQueueOnSend/);
  assert.match(drawer, /queuedItems=\{queuedItems\}/);
  assert.match(drawer, /onSendQueuedNow=\{\(\) => void sendQueuedNow\(\)\}/);
  assert.match(drawer, /activeTurnBehavior: "steer"/);
});
