// Bor19 (idea-748): Normal-mode permission-card column.
//   n5 — the permission card matches the message column width (--measure-col), not the narrower prose measure.
//   n6 — the Working-now strip + permission cards live INSIDE the chat column (beside, not above, the context
//        panel), so the panel spans full height. Psycho mode is untouched (perm cards stay full-width siblings).
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const drawer = read("src", "AgentDrawer.tsx");
const css = read("src", "boring.css");

test("Bor19 n6: boring mode wraps perm stack + timeline (B15: the strip moved out to a full-width sibling above the shell) in .boring-convo-col; psycho keeps cards above the shell", () => {
  assert.match(drawer, /\{boringChat \? \(\s*<div className="boring-convo-col">/);
  // The perm-card stack and timeline live inside the column, in that order (the strip is a sibling above the shell). <BoringWorkingNow>'s props are
  // intentionally not pinned to an order (a prop reorder must not break this test).
  assert.match(
    drawer,
    /<div className="boring-convo-col">[\s\S]*?boring-perm-stack[\s\S]*?\{timelineEl\}[\s\S]*?<\/div>[\s\S]*?\) : \(\s*timelineEl/,
  );
  assert.match(drawer, /\{!boringChat && permCards\}/);
  assert.match(drawer, /const timelineEl = \(\s*<TimelineErrorBoundary fallbackLabel="timeline">/);
  assert.match(drawer, /const permCards = agent\.pendingPermissions\?\.map/);
});

test("Bor19 n6 CSS: .boring-convo-col is the flex row's left child; strip + perm stack fixed at top; timeline scrolls below", () => {
  assert.match(
    css,
    /\.drawer-shell > \.boring-convo-col \{\s*display: flex; flex-direction: column; flex: 1 1 0; min-width: 0; min-height: 0; overflow: hidden;/,
  );
  assert.match(css, /\.boring-convo-col > \.timeline-col \{ zoom: var\(--chat-zoom, 1\); --u3-px: var\(--u3-px-chat, 2px\); \}/);
  assert.match(css, /\.boring-convo-col > \.boring-now,[\s\S]*?\.boring-convo-col > \.boring-perm-stack \{ flex: none; \}/);
});

test("Bor19 n5 CSS: perm card width = message column (single rule); the ctx-panel width hack is gone", () => {
  // The width/max-width live on the primary .perm-card rule (1.7); the old duplicate width rule is removed.
  assert.match(css, /html\[data-vibe="boring"\] \.perm-card \{ margin: 12px auto 0; width: calc\(100% - 48px\); max-width: var\(--measure-col\);/);
  assert.doesNotMatch(css, /\.perm-card \{ width: calc\(100% - 48px\); max-width: var\(--measure-col\); margin-inline: auto; box-sizing: border-box; \}/);
  assert.doesNotMatch(css, /\.drawer:has\(\.boring-context-panel\) \.perm-card/);
  assert.doesNotMatch(css, /--ctx-panel-w/);
  assert.doesNotMatch(css, /--timeline-col: min\(/);
});

test("Bor19 CSS: Normal-scoped, no !important, no top-level @keyframes in the new block", () => {
  const i = css.indexOf("/* Bor19 (n5/n6):");
  assert.ok(i > 0);
  const sect = css.slice(i, css.indexOf("/* Message avatars:"));
  for (const line of sect.split("\n").filter((l) => /^[.a-z@]/.test(l) && !l.startsWith("@media")))
    assert.match(line.trim(), /^html\[data-vibe="boring"\]/, line.slice(0, 60));
  assert.ok(!/!important/.test(sect));
  assert.ok(!/@keyframes/.test(sect));
});
