import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const panel = read("src", "BoringContextPanel.tsx");
const css = read("src", "boring.css");
const d4 = css.slice(css.indexOf("D4 polish"));

test("D4: idle workers disclosure expands and lists idle workers", () => {
  assert.match(panel, /data-testid="boring-ctx-idle-toggle"/);
  assert.match(panel, /aria-expanded=\{showIdle\}/);
  assert.match(panel, /idleMembers\.map/);
  assert.doesNotMatch(panel, /idle workers? hidden|worker\{idle === 1 \? "" : "s"\} hidden/);
});

test("D4: collapsed rail shows worst-state badge (err else attn) with count", () => {
  assert.match(panel, /const n = err \+ attn;/);
  assert.match(panel, /tone: err > 0 \? "err" : "attn", n/);
  assert.match(css, /\.boring-hdr-btn\[data-testid="boring-dock-toggle"\] \{ display: none; \}/);
  assert.match(panel, /data-testid="boring-ctx-rail-badge"/);
  assert.match(d4, /\.boring-ctx-rail-badge\.st-err \{ background: var\(--st-err\)/);
  assert.match(d4, /\.boring-ctx-rail-badge \{[^}]*background: var\(--st-attn\)/);
});

test("D4: 36px tabs with 2px accent underline on the active tab", () => {
  assert.match(d4, /\.boring-ctx-tabs \{ min-height: 36px/);
  assert.match(d4, /\.boring-ctx-tab \{ height: 36px[^}]*border-bottom: 2px solid transparent/);
  assert.match(d4, /\.boring-ctx-tab\.on \{[^}]*border-bottom-color: var\(--accent\)/);
});

test("D4: Plan tab open hides the pinned todo bar; panel exposes data-tab", () => {
  assert.match(panel, /data-tab=\{tab\}/);
  assert.match(d4, /\[data-tab="Plan"\]\) \[data-testid="tl-pinned-todo"\] \{ display: none/);
  assert.match(read("src", "Timeline.tsx"), /data-testid="tl-pinned-todo"/);
});

test("D4: composer seam stops at the panel edge and continues the panel surface", () => {
  assert.match(d4, /--d4-panel-w: 460px/);
  assert.match(d4, /> \.composer::before \{[^}]*right: var\(--d4-panel-w\)/);
  assert.match(d4, /border-top-color: transparent/);
});

test("D4: section is scoped to Normal mode with no new @media", () => {
  assert.doesNotMatch(d4, /@media/);
  for (const line of d4.split("\n").filter((l) => /\{/.test(l))) assert.match(line, /^html\[data-vibe="boring"\]/);
});
