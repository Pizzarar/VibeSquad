// Unit U15 — Top bar declutter & sub-menu consolidation (PinFocusBar + drawer-head-compact, Option A).
// Source + behavioral verification against src/PinRail.tsx, src/DrawerHeader.tsx and src/styles.css.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const pin = read("src/PinRail.tsx");
const dh = read("src/DrawerHeader.tsx");
const css = read("src/styles.css");

describe("U15: PinFocusBar declutter (PinRail.tsx)", () => {
  test("PinFocusBar no longer renders the pin-focus-plumbing (Lead: … N workers ▸) button", () => {
    assert.ok(!pin.includes("data-testid=\"pin-focus-plumbing\""), "plumbing testid removed");
    assert.ok(!pin.includes("pin-focus-plumbing"), "plumbing className removed");
    assert.ok(!pin.includes("Open this team's Lead"), "plumbing title removed");
    assert.ok(!pin.includes("worker"), "worker count readout removed");
    assert.ok(!pin.includes("const openLead"), "openLead removed");
    assert.ok(!pin.includes("statusWord"), "statusWord removed");
  });

  test(".pin-focus-plumbing CSS rule is retained for backwards compatibility", () => {
    assert.ok(css.includes(".pin-focus-plumbing"), "CSS rule retained");
  });
});

describe("U15: compactIdentity (DrawerHeader.tsx)", () => {
  const ci = dh.slice(dh.indexOf("const compactIdentity"), dh.indexOf("if (compact)"));

  test("renders only StatusDot when isBs && !isTopicBs", () => {
    assert.match(ci, /const compactIdentity = isBs && !isTopicBs \? \(\s*\n?\s*<StatusDot agent=\{agent\} \/>/);
  });

  test("renders Avatar + drawer-head-compact-title otherwise (Lead / worker / topic Buddy)", () => {
    assert.match(ci, /<Avatar id=\{agent\.id\} provider=\{agent\.provider\} agentType=\{agentType\} variant=\{leadVariant\(agent\)\} size=\{24\} \/>/);
    assert.match(ci, /className="drawer-head-compact-title"/);
    assert.match(ci, /<AgentTitleEdit agent=\{agent\}>/);
  });
});

describe("U15: dockBtns (DrawerHeader.tsx)", () => {
  test("omits the ✕ close button when compact is true", () => {
    const dock = dh.slice(dh.indexOf("const dockBtns"), dh.indexOf("const inspector"));
    // G8: the ✕ is also gated on !chatOnly (the sky chat panel has its own ✕), so the gate may read `!compact && !chatOnly`.
    assert.match(dock, /\{!compact && (!chatOnly && )?\(/);
    assert.match(dock, /onClick=\{onClose\}/);
    assert.match(dock, /✕/);
    // The gate must precede the close button so compact hides it.
    assert.ok(dock.search(/\{!compact && (!chatOnly && )?\(/) < dock.indexOf("onClick={onClose}"), "✕ gated behind !compact");
  });
});

describe("U15: drawer-config-menu (DrawerHeader.tsx)", () => {
  test("thinkingSelect + modeSelect are wrapped in a details sub-menu", () => {
    const open = dh.indexOf('<details className="drawer-config-menu" data-testid="drawer-config-menu">');
    const close = dh.indexOf("</details>");
    assert.ok(open > -1 && close > open, "details block found");
    const details = dh.slice(open, close);
    assert.match(details, /\{thinkingSelect\}/);
    assert.match(details, /\{modeSelect\}/);
    assert.match(details, /className="drawer-config-popover"/);
  });

  test("summary renders ⚙ thinking · mode label with the config-menu-btn testid", () => {
    assert.ok(dh.includes('data-testid="drawer-config-menu-btn"'), "summary testid present");
    assert.ok(dh.includes('title="Thinking effort & permission mode"'), "summary title present");
    assert.ok(dh.includes('⚙ {stagedThinking || "medium"} · {activeModeLabel} ▾'), "summary readout present");
  });

  test("drawer-head-compact keeps provider/model/thinking/mode/WorkingChip in order", () => {
    const i = dh.indexOf('data-testid="drawer-head-compact"');
    const blk = dh.slice(i, i + 900);
    const order = ["{providerSelect}", "{modelControl}", "{thinkingSelect}", "{modeSelect}", "<WorkingChip"].map((k) => blk.indexOf(k));
    assert.ok(order.every((n) => n > 0), "all compact controls present within 900 chars");
    assert.deepEqual([...order].sort((x, y) => x - y), order, "controls stay in order");
  });
});

describe("U15: CSS overflow + popover (styles.css)", () => {
  test(".pin-focus-bar (desktop) and .drawer-head-compact use overflow: visible", () => {
    assert.match(css, /\.pin-focus-bar \{ height: 44px;[^}]*overflow: visible/);
    assert.match(css, /\.drawer-head-compact \{ display: flex;[^}]*overflow: visible/);
  });

  test(".drawer-config-popover drops down absolutely over the timeline (z-index 40)", () => {
    assert.match(css, /\.drawer-config-popover \{[^}]*position: absolute;[^}]*z-index: 40/);
    assert.match(css, /\.drawer-config-popover \{[^}]*top: calc\(100% \+ 4px\)/);
  });

  test(".drawer-config-menu / -summary / -row styles exist", () => {
    assert.match(css, /\.drawer-config-menu \{ position: relative; \}/);
    assert.match(css, /\.drawer-config-summary \{ list-style: none;/);
    assert.match(css, /\.drawer-config-summary::-webkit-details-marker \{ display: none; \}/);
    assert.match(css, /\.drawer-config-row \{ display: flex;[^}]*justify-content: space-between/);
  });
});
