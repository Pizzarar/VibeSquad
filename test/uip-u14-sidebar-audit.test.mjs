// Unit U14 — Right Sidebar (PinRail Active Buddy Card) desktop audit & compact layout (Option A).
// 1. Behavioral: detectPromisedRunIdle no longer false-positives on descriptive "running <cmd>" sentences
//    and caps its excerpt at 110 chars.
// 2. CSS: .hard-bar / .hard-text wrap inside the 260px right sidebar.
// 3. PinGrid TeamRow strips leading ★/💬/• glyph prefixes (no double star).
// 4. DrawerHeader compact Active Buddy Card: primary utilities always visible, secondary plumbing behind "More".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { detectPromisedRunIdle } from "../src/antigravity.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const idleAgy = { provider: "antigravity-cli", status: "idle" };
const msg = (text) => [{ item: { type: "assistant_message", text } }];

describe("U14: detectPromisedRunIdle (antigravity.ts)", () => {
  test("descriptive 'running <cmd>' sentences do not false-positive", () => {
    assert.equal(
      detectPromisedRunIdle(idleAgy, msg("Running npm run release:stable updates both endpoints and syncs the beta tag.")),
      null,
    );
    assert.equal(
      detectPromisedRunIdle(idleAgy, msg("Checking the status bar shows 0 errors.")),
      null,
    );
    // The bare-verb "starting" / "dispatching" also no longer trigger on descriptive prose.
    assert.equal(
      detectPromisedRunIdle(idleAgy, msg("Dispatching the results to every worker happens at the end of the cycle.")),
      null,
    );
  });

  test("first-person intent sentences flag when the antigravity-cli agent is idle", () => {
    for (const text of ["Let me check the logs", "I'm running the test suite now", "I will dispatch the worker"]) {
      const res = detectPromisedRunIdle(idleAgy, msg(text));
      assert.ok(res, `expected a flag for "${text}"`);
      assert.equal(res.flagged, true);
      assert.equal(typeof res.excerpt, "string");
      assert.ok(res.excerpt.length > 0);
    }
  });

  test("long promised sentence excerpt is capped at 110 chars and ends with …", () => {
    const long =
      "I will now proceed to carefully analyze every single node in the entire distributed cluster and then compile a comprehensive report for the whole team to review and act upon promptly";
    assert.ok(long.length > 110, "fixture must exceed 110 chars");
    const res = detectPromisedRunIdle(idleAgy, msg(long));
    assert.ok(res, "long first-person sentence should flag");
    assert.ok(res.excerpt.length <= 110, `excerpt length ${res.excerpt.length} should be <= 110`);
    assert.ok(res.excerpt.endsWith("…"), "excerpt should end with the ellipsis character");
  });

  test("non-antigravity or non-idle agents are ignored", () => {
    assert.equal(detectPromisedRunIdle({ provider: "claude", status: "idle" }, msg("Let me check the logs")), null);
    assert.equal(detectPromisedRunIdle({ provider: "antigravity-cli", status: "running" }, msg("Let me check the logs")), null);
  });
});

describe("U14: .hard-bar wrapping (styles.css)", () => {
  const css = read("src/styles.css");

  test(".hard-bar wraps cleanly inside the right sidebar", () => {
    const bar = css.match(/\.hard-bar \{[^}]*\}/)?.[0] ?? "";
    assert.ok(bar.length > 0, ".hard-bar rule found");
    assert.match(bar, /flex-wrap: wrap/);
    assert.match(bar, /min-width: 0/);
    assert.match(bar, /max-width: 100%/);
    assert.match(bar, /box-sizing: border-box/);
  });

  test(".hard-text shrinks and wraps instead of clipping", () => {
    const text = css.match(/\.hard-text \{[^}]*\}/)?.[0] ?? "";
    assert.ok(text.length > 0, ".hard-text rule found");
    assert.match(text, /min-width: 0/);
    assert.match(text, /flex: 1 1 1[56]0px/);
    assert.match(text, /overflow-wrap: anywhere/);
  });

  test(".pin-rail-active-inspector .hard-bar gets compact margin/padding/gap", () => {
    const rule = css.match(/\.pin-rail-active-inspector \.hard-bar \{[^}]*\}/)?.[0] ?? "";
    assert.ok(rule.length > 0, "compact hard-bar rule found");
    assert.match(rule, /margin: 4px 0 0/);
    assert.match(rule, /padding: 6px 8px/);
    assert.match(rule, /gap: 6px/);
  });

  test(".pin-rail-active-inspector .brainstorm-fresh-divider ellipsizes", () => {
    const rule = css.match(/\.pin-rail-active-inspector \.brainstorm-fresh-divider \{[^}]*\}/)?.[0] ?? "";
    assert.ok(rule.length > 0, "compact fresh-divider rule found");
    assert.match(rule, /font-size: 10px/);
    assert.match(rule, /white-space: nowrap/);
    assert.match(rule, /overflow: hidden/);
    assert.match(rule, /text-overflow: ellipsis/);
  });

  test("existing .pin-rail-active-buddy / -inspector / -tools bounds block is preserved", () => {
    const block = css.match(/\.pin-rail-active-buddy,\s*\.pin-rail-active-inspector,[\s\S]*?\n\}/)?.[0] ?? "";
    assert.ok(block.length > 0, "pin-rail overflow block found");
    assert.match(block, /\.pin-rail-buddy-tools\s*\{/);
    assert.match(block, /min-width:\s*0;\s*max-width:\s*100%;\s*overflow:\s*hidden;/);
  });
});

describe("U14: TeamRow duplicate glyph stripping (PinGrid.tsx)", () => {
  const pg = read("src/PinGrid.tsx");

  test("strips leading ★/💬/• prefixes before rendering", () => {
    assert.ok(pg.includes('const cleanTitle = rawTitle.replace(/^(?:[★💬•]\\s*)+/, "")'));
    assert.ok(pg.includes("{glyph} {cleanTitle}"));
    assert.ok(pg.includes("title={`Open ${rawTitle}"));
  });

  test("a Lead titled '★ UIP2 …' renders a single star, not '★ ★ UIP2 …'", () => {
    // Replicate the exact transform to prove single-glyph output.
    const rawTitle = "★ UIP2 · chat header & scroll polish";
    const cleanTitle = rawTitle.replace(/^(?:[★💬•]\s*)+/, "");
    assert.equal(cleanTitle, "UIP2 · chat header & scroll polish");
    const rendered = `★ ${cleanTitle}`;
    assert.equal(rendered, "★ UIP2 · chat header & scroll polish");
    assert.ok(!rendered.includes("★ ★"));
  });
});

describe("U14: compact Active Buddy Card (DrawerHeader.tsx)", () => {
  const dh = read("src/DrawerHeader.tsx");

  test("metaRest omits the leading '· ' when compact", () => {
    assert.ok(dh.includes('{compact ? "" : "· "}{shortPath(agent.cwd)}'));
  });

  test("primaryUtils holds Search + Reload + model/reload errors", () => {
    const primary = dh.slice(dh.indexOf("const primaryUtils"), dh.indexOf("const extraActions"));
    assert.match(primary, /data-testid="drawer-search-btn"/);
    assert.match(primary, /data-testid="drawer-reload-agent-btn"/);
    assert.match(primary, /drawer-reload-error/);
    assert.doesNotMatch(primary, /<AgentActions/);
  });

  test("secondaryPlumbing holds role-tag, prov-pill, featureChips, AgentActions, paseoLink", () => {
    const secondary = dh.slice(dh.indexOf("const secondaryPlumbing"), dh.indexOf("const dockBtns"));
    assert.match(secondary, /role-tag/);
    assert.match(secondary, /prov-pill/);
    assert.match(secondary, /featureChips/);
    assert.match(secondary, /<AgentActions agent=\{agent\} archive \/>/);
    assert.match(secondary, /paseoLink/);
  });

  test("compact card renders Search, Reload and More toggle by default", () => {
    const compact = dh.slice(dh.indexOf("if (compact)"));
    assert.match(compact, /data-testid="pin-rail-buddy-tools"/);
    assert.ok(compact.includes("{primaryUtils}"), "compact utility row includes primaryUtils");
    assert.match(compact, /data-testid="drawer-more-toggle"/);
    assert.ok(compact.includes("setMoreOpen((v) => !v)"));
  });

  test("secondary plumbing is gated behind moreOpen in compact mode", () => {
    const compact = dh.slice(dh.indexOf("if (compact)"));
    const mo = compact.indexOf("{moreOpen && (");
    assert.ok(mo > -1, "compact card gates secondary plumbing behind moreOpen");
    const gated = compact.slice(mo);
    for (const marker of ["{secondaryPlumbing}", "{metaRest}", "brainstorm-fresh-divider", "<SessionActions agent={agent} entries={entries} />"]) {
      assert.ok(gated.includes(marker), `moreOpen block includes ${marker}`);
    }
  });

  test("secondary plumbing remains visible when !compact", () => {
    // Non-compact header always renders badges + metaRest.
    const header = dh.slice(dh.indexOf("const header"), dh.indexOf("if (compact)"));
    assert.match(header, /role-tag/);
    assert.match(header, /prov-pill/);
    assert.match(header, /featureChips/);
    assert.ok(header.includes("{metaRest}"));
    assert.ok(header.includes("{extraActions}"));
    // Non-compact inspector renders fresh-divider + SessionActions without a moreOpen gate.
    assert.match(dh, /\{!compact && agent\.labels\?\.\["vs\.fresh-session"\] === "brief" && \(/);
    assert.match(dh, /\{!compact && <SessionActions agent=\{agent\} entries=\{entries\} \/>\}/);
  });
});
