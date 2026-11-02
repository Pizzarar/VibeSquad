import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(root, f), "utf8");
const timeline = read("src/Timeline.tsx");
const terminal = read("src/TerminalPanel.tsx");
const css = read("src/styles.css");

describe("U1: chat hover no-reflow + click-to-select", () => {
  test("exports shouldSelectMessageOnClick guard", () => {
    assert.match(timeline, /export function shouldSelectMessageOnClick\(targetTagNames: string\[\], selectionText: string\): boolean/);
    for (const t of ["a", "button", "input", "textarea", "select", "img"]) assert.ok(timeline.includes(`"${t}"`));
  });
  test("selection state, Escape and selected marker", () => {
    assert.ok(timeline.includes("selectedEntryKey"));
    assert.ok(timeline.includes('"Escape"'));
    assert.ok(timeline.includes("data-selected"));
    assert.ok(timeline.includes("tl-selected"));
  });
  test(".tl-actions is an absolute overlay and hover does not touch layout", () => {
    const actions = css.match(/\.tl-actions \{[^}]*\}/)[0];
    assert.match(actions, /position: absolute/);
    const hover = css.match(/\.tl-user:hover,\s*\.tl-assistant:hover \{[^}]*\}/)[0];
    assert.doesNotMatch(hover, /height|margin|padding|border/);
    assert.doesNotMatch(css, /\.tl:hover \.tl-park-btn/);
  });
});

describe("U2: dock terminal", () => {
  test("exports neon-noir TERMINAL_THEME and passes it to xterm", () => {
    assert.match(terminal, /export const TERMINAL_THEME/);
    assert.ok(terminal.includes('background: "#0d111c"'));
    assert.ok(terminal.includes("theme: TERMINAL_THEME"));
    assert.ok(terminal.includes("lineHeight: 1.35"));
  });
  test("refits on resize, window resize and tab switch, and syncs PTY size", () => {
    assert.ok(terminal.includes("new ResizeObserver(refit)"));
    assert.ok(terminal.includes('addEventListener("resize", refit)'));
    assert.ok(terminal.includes("requestAnimationFrame(refit)"));
    assert.ok(terminal.includes("resizeTerminal(activeId, inst.term.cols, inst.term.rows)"));
  });
  test("panel and output fill the dock", () => {
    assert.match(css, /\.terminal-panel \{[^}]*height: 100%[^}]*\}/);
    assert.match(css, /\.terminal-output \{[^}]*flex: 1[^}]*background: #0d111c[^}]*\}/);
    assert.match(css, /\.terminal-tab-close \{[^}]*margin-left: 6px/);
  });
});

describe("U4: no horizontal clipping", () => {
  test("push controls wrap", () => {
    assert.match(css, /\.push-controls-row \{[^}]*flex-wrap: wrap/);
    assert.match(css, /\.push-test-btn \{[^}]*min-width: 0/);
  });
  test("top bar summary and agent rows shrink instead of clipping", () => {
    assert.match(css, /\.pin-focus-bar \{ height: auto; min-height: 40px; flex-wrap: wrap/);
    assert.match(css, /\.pin-focus-plumbing \{[^}]*text-overflow: ellipsis/);
    assert.match(css, /\.row-meter \{ min-width: 0/);
  });
});
