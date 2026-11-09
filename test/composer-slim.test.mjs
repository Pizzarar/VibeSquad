import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Slim composer (PLAN_CHAT_ROOM C4): source assertions (Node-only, no DOM).
const comp = readFileSync(new URL("../src/Composer.tsx", import.meta.url), "utf8");
const more = readFileSync(new URL("../src/ComposerMore.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("composer-slim: Stop is an icon button rendered only while running", () => {
  const m = /\{agent\.status === "running" && \(\s*<button\s+className="btn ghost composer-stop-btn"[\s\S]*?<\/button>\s*\)\}/.exec(comp);
  assert.ok(m);
  assert.match(m[0], /aria-label="Stop"/);
  assert.match(m[0], /data-testid="composer-stop-btn"/);
  assert.doesNotMatch(m[0], /disabled/);
  assert.doesNotMatch(m[0], /■ Stop/);
});

test("composer-slim: attach, secret and park-inbox live in the menu, not the row", () => {
  const menu = /<ComposerMore[\s\S]*?\/>\n/.exec(comp)[0];
  for (const id of ["composer-attach-btn", "composer-secret-btn", "composer-park-inbox-btn"]) {
    assert.ok(menu.includes(`testid: "${id}"`), id);
    assert.ok(!comp.includes(`data-testid="${id}"`), `${id} no longer a bare row button`);
  }
  assert.match(menu, /isBs/);
  assert.match(comp, /<button className="btn" disabled=\{busy/); // Send/Queue unchanged
});

test("composer-slim: menu is a keyboard-reachable portaled popover", () => {
  assert.match(more, /createPortal\(/);
  assert.match(more, /placePinMenu/);
  assert.match(more, /aria-haspopup="menu"/);
  assert.match(more, /e\.key !== "Escape"/);
  assert.match(more, /addEventListener\("mousedown", away\)/);
  assert.match(more, /placePinMenuZoomed\(.*rootZoom\(\)/); // placement divides by the root UI-scale zoom
  assert.match(more, /ArrowDown/);
  assert.ok(more.includes('e.key === "Tab") return close(false)')); // Tab leaves and closes
  assert.match(more, /tab\.current\?\.focus\(\)/); // focus returns to the tab
  assert.match(more, /const close = \(refocus = true\)/);
});

test("composer-slim: css uses kit tokens, no animation", () => {
  assert.match(css, /\.composer-more-tab \{[^}]*var\(--sp-/);
  assert.match(css, /\.composer-more-list \{ position: fixed;/);
  const block = css.slice(css.indexOf(".composer-more-tab {"));
  assert.doesNotMatch(block, /transition|animation/);
});
