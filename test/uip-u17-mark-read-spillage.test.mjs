// Unit U17 — First-Class '✓ Mark read' / 'Mark unread' Toggle & 260px Right-Rail Menu Spillage Fixes (Option A).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test, beforeEach } from "node:test";
import {
  clearUnreadLocal,
  dismissLocal,
  isLocallyHidden,
  isMarkedUnread,
  markUnreadLocal,
  resetAttentionLocal,
} from "../src/attentionLocal.ts";
import { attentionOf, countsAsNeedsYou } from "../src/teams.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("U17: markAgentRead in src/paseo.ts & local attention state transitions", () => {
  const paseoSrc = read("src/paseo.ts");

  beforeEach(() => {
    resetAttentionLocal();
  });

  test("src/paseo.ts imports clearUnreadLocal and dismissLocal (no daemon workspace-flag clear)", () => {
    assert.match(paseoSrc, /import \{[^}]*clearUnreadLocal[^}]*dismissLocal[^}]*\} from "\.\/attentionLocal"/);
    assert.doesNotMatch(paseoSrc, /clearWorkspaceIfQuiet/);
  });

  test("markAgentRead is exported next to markAgentUnread with all 4 required steps", () => {
    const start = paseoSrc.indexOf("export async function markAgentRead(agent: PaseoAgent): Promise<void>");
    assert.ok(start > -1, "markAgentRead signature found in src/paseo.ts");
    const block = paseoSrc.slice(start, start + 900);
    assert.match(block, /clearUnreadLocal\(agent\.id\)/);
    assert.match(
      block,
      /if \(agent\.status === "error" \|\| agent\.requiresAttention\)[\s\S]*?dismissLocal\(agent\.id, agent\.status === "error" \? \(agent\.lastError \?\? "error"\) : \(agent\.attentionReason \?\? "attention"\)\)/,
    );
    assert.match(
      block,
      /\(agent\.labels\?\.\["needs-you"\] && agent\.labels\["needs-you"\] !== "cleared"\) \|\|\s*\(agent\.labels\?\.\[LEGACY_NEEDS_LABEL\] && agent\.labels\[LEGACY_NEEDS_LABEL\] !== "cleared"\)/,
    );
    assert.match(block, /await clearNeedsYou\(agent, \{ optimistic: true \}\)/);
    assert.match(block, /await clearAgentAttention\(agent\.id\)/);
    assert.doesNotMatch(block, /clearWorkspaceIfQuiet/);
  });

  test("behavioral: unread, error, and requiresAttention transition from needs-you to quiet after mark-read steps", () => {
    const baseAgent = {
      id: "agent-u17-1",
      title: "💬 UIP · Buddy",
      status: "idle",
      cwd: "C:/Users/you/projects/VibeSquad",
      labels: { team: "vs", lane: "uip", role: "brainstorm" },
    };

    // 1. Marked unread -> countsAsNeedsYou true -> clearUnreadLocal -> false
    markUnreadLocal(baseAgent.id);
    assert.equal(isMarkedUnread(baseAgent.id), true);
    const unreadAtt = attentionOf(baseAgent);
    assert.deepEqual(unreadAtt, { tone: "needs-you", reason: "marked unread" });
    assert.equal(countsAsNeedsYou({ agent: baseAgent, kind: "brainstorm", attention: unreadAtt }), true);

    clearUnreadLocal(baseAgent.id);
    assert.equal(isMarkedUnread(baseAgent.id), false);
    assert.equal(attentionOf(baseAgent), null);

    // 2. Error status -> dismissLocal hides until error signature changes
    const errAgent = { ...baseAgent, id: "agent-u17-2", status: "error", lastError: "rate limit" };
    assert.deepEqual(attentionOf(errAgent), { tone: "error", reason: "rate limit" });
    dismissLocal(errAgent.id, errAgent.status === "error" ? (errAgent.lastError ?? "error") : "attention");
    assert.equal(isLocallyHidden(errAgent.id, "rate limit"), true);
    assert.equal(attentionOf(errAgent), null);

    // 3. requiresAttention -> dismissLocal hides attentionReason
    const reqAgent = { ...baseAgent, id: "agent-u17-3", requiresAttention: true, attentionReason: "error" };
    assert.deepEqual(attentionOf(reqAgent), { tone: "error", reason: "error" });
    dismissLocal(reqAgent.id, reqAgent.attentionReason ?? "attention");
    assert.equal(attentionOf(reqAgent), null);
  });
});

describe("U17: markPinRead & clickable NeedsBadge in src/PinGrid.tsx and src/PinRail.tsx", () => {
  const pgSrc = read("src/PinGrid.tsx");
  const prSrc = read("src/PinRail.tsx");

  test("PinGrid exports markPinRead and makes NeedsBadge a clickable button", () => {
    assert.match(pgSrc, /import \{[^}]*markAgentRead[^}]*\} from "\.\/paseo"/);
    assert.match(pgSrc, /export async function markPinRead\(pin: Pin\): Promise<void>/);
    assert.match(pgSrc, /\.filter\(countsAsNeedsYou\)\.map\(\(m\) => markAgentRead\(m\.agent\)\)/);

    const badgeIdx = pgSrc.indexOf("export function NeedsBadge");
    assert.ok(badgeIdx > -1, "NeedsBadge found");
    const badgeBlock = pgSrc.slice(badgeIdx, badgeIdx + 500);
    assert.match(badgeBlock, /<button/);
    assert.match(badgeBlock, /type="button"/);
    assert.match(badgeBlock, /className="badge alert pin-needs"/);
    assert.match(badgeBlock, /data-testid=\{`pin-needs-\$\{pin\.lane\.id\}`\}/);
    assert.match(badgeBlock, /title=\{`\$\{pin\.needsYou\} need you — click to mark read`\}/);
    assert.match(badgeBlock, /e\.stopPropagation\(\);\s*void markPinRead\(pin\);/);
  });

  test("PinRail active head renders pin-rail-mark-read button beside NeedsBadge when active.needsYou > 0", () => {
    assert.match(prSrc, /import \{[^}]*markPinRead[^}]*NeedsBadge[^}]*\} from "\.\/PinGrid"/);
    const headIdx = prSrc.indexOf('<div className="pin-rail-active-head">');
    assert.ok(headIdx > -1, "pin-rail-active-head found");
    const headBlock = prSrc.slice(headIdx, headIdx + 650);
    assert.match(headBlock, /\{active && <NeedsBadge pin=\{active\} \/>\}/);
    assert.match(headBlock, /\{active && active\.needsYou > 0 && \(/);
    assert.match(headBlock, /className="btn ghost small pin-rail-mark-read"/);
    assert.match(headBlock, /data-testid="pin-rail-mark-read"/);
    assert.match(headBlock, /title="Mark all in this team read"/);
    assert.match(headBlock, /onClick=\{\(\) => void markPinRead\(active\)\}/);
    assert.match(headBlock, /✓ Mark read/);
  });
});

describe("U17: DrawerHeader first-class Mark read / Mark unread toggle & More button", () => {
  const dhSrc = read("src/DrawerHeader.tsx");

  test("computes isUnreadOrAttention from isMarkedUnread, needsYouFlagged, att, and requiresAttention", () => {
    assert.match(dhSrc, /import \{ isLocallyHidden, isMarkedUnread \} from "\.\/attentionLocal"/);
    assert.match(
      dhSrc,
      /const isUnreadOrAttention =\s*isMarkedUnread\(agent\.id\) \|\|\s*needsYouFlagged \|\|\s*Boolean\(att && att\.tone !== "finished"\) \|\|\s*Boolean\(agent\.requiresAttention && !isLocallyHidden\(agent\.id, agent\.attentionReason \?\? "attention"\)\);/,
    );
  });

  test("NeedsYouControls treats isMarkedUnread(agent.id) as flagged and Clear calls markAgentRead(agent)", () => {
    const nyc = dhSrc.slice(dhSrc.indexOf("function NeedsYouControls"), dhSrc.indexOf("function HardeningBanner"));
    assert.match(nyc, /const unread = isMarkedUnread\(agent\.id\)/);
    assert.match(nyc, /const flagged = hasNeedsLabel \|\| unread/);
    assert.match(nyc, /UNREAD/);
    assert.match(nyc, /markAgentRead\(agent\)/);
  });

  test("primaryUtils renders ✓ Mark read / Mark unread toggle button", () => {
    const primary = dhSrc.slice(dhSrc.indexOf("const primaryUtils"), dhSrc.indexOf("const extraActions"));
    assert.match(primary, /isUnreadOrAttention \?/);
    assert.match(primary, /data-testid="mark-read"/);
    assert.match(primary, /className="btn ok small"/);
    assert.match(primary, /title="Mark this chat read and clear attention"/);
    assert.match(primary, /onClick=\{\(\) => void markAgentRead\(agent\)\}/);
    assert.match(primary, /✓ Mark read/);
    assert.match(primary, /data-testid="mark-unread"/);
    assert.match(primary, /className="btn ghost small"/);
    assert.match(primary, /title="Put this chat back in the team's needs-you list"/);
    assert.match(primary, /onClick=\{\(\) => void markAgentUnread\(agent\)\}/);
    assert.match(primary, /Mark unread/);
  });

  test("drawer-more-toggle in pin-rail-buddy-tools is always visible (not hidden when needsYouFlagged)", () => {
    const compact = dhSrc.slice(dhSrc.indexOf("if (compact)"));
    const toolsIdx = compact.indexOf('data-testid="pin-rail-buddy-tools"');
    assert.ok(toolsIdx > -1, "pin-rail-buddy-tools found");
    const toolsBlock = compact.slice(toolsIdx, compact.indexOf("{moreOpen && ("));
    assert.match(toolsBlock, /data-testid="drawer-more-toggle"/);
    assert.doesNotMatch(toolsBlock, /!needsYouFlagged/);
  });

  test("duplicate Mark unread button is removed from moreOpen and .drawer-labels-list spans full width", () => {
    const compact = dhSrc.slice(dhSrc.indexOf("if (compact)"));
    const moreBlock = compact.slice(compact.indexOf("{moreOpen && ("));
    assert.doesNotMatch(moreBlock, /data-testid="mark-unread"/);
    assert.match(
      moreBlock,
      /className="labels drawer-labels-list" style=\{\{ display: "flex", flexWrap: "wrap", gap: 4, padding: "2px 4px", border: "none", minWidth: 0, maxWidth: "100%" \}\}/,
    );
  });
});

describe("U17: 260px Right Rail menu spillage CSS fixes (src/styles.css)", () => {
  const css = read("src/styles.css");

  test("1. .brainstorm-warn-banner & .brainstorm-handoff-banner wrap cleanly inside the card", () => {
    const warn = css.match(/\.brainstorm-warn-banner \{[^}]*\}/)?.[0] ?? "";
    const handoff = css.match(/\.brainstorm-handoff-banner \{[^}]*\}/)?.[0] ?? "";
    for (const rule of [warn, handoff]) {
      assert.ok(rule.length > 0);
      assert.match(rule, /flex-wrap: wrap/);
      assert.match(rule, /min-width: 0/);
      assert.match(rule, /max-width: 100%/);
      assert.match(rule, /box-sizing: border-box/);
    }
    assert.match(
      css,
      /\.brainstorm-warn-banner > span,\s*\.brainstorm-handoff-banner > span\s*\{\s*flex: 1 1 130px;\s*min-width: 0;\s*overflow-wrap: anywhere;\s*\}/,
    );
    assert.match(
      css,
      /\.brainstorm-warn-banner \.btn,\s*\.brainstorm-handoff-banner \.btn\s*\{\s*white-space: normal;\s*max-width: 100%;\s*\}/,
    );
  });

  test("2. .brainstorm-feedback-bar & .brainstorm-feedback-actions wrap cleanly inside the card", () => {
    const bar = css.match(/\.brainstorm-feedback-bar \{[^}]*\}/)?.[0] ?? "";
    assert.ok(bar.length > 0);
    assert.match(bar, /flex-wrap: wrap/);
    assert.match(bar, /min-width: 0/);
    assert.match(bar, /max-width: 100%/);
    assert.match(bar, /box-sizing: border-box/);

    const actions = css.match(/\.brainstorm-feedback-actions \{[^}]*\}/)?.[0] ?? "";
    assert.ok(actions.length > 0);
    assert.match(actions, /flex-wrap: wrap/);
    assert.match(actions, /min-width: 0/);
    assert.match(actions, /max-width: 100%/);

    assert.match(
      css,
      /\.pin-rail-active-inspector \.brainstorm-feedback-bar\s*\{\s*margin: 4px 0 0;\s*padding: 6px 8px;\s*gap: 6px;\s*\}/,
    );
  });

  test("3. .you-bar, .you-flag, .lint-bar and .you-flag input wrap cleanly inside the card", () => {
    const youRule = css.match(/\.you-bar,\s*\.you-flag,\s*\.lint-bar\s*\{[^}]*\}/)?.[0] ?? "";
    assert.ok(youRule.length > 0);
    assert.match(youRule, /flex-wrap: wrap/);
    assert.match(youRule, /min-width: 0/);
    assert.match(youRule, /max-width: 100%/);
    assert.match(youRule, /box-sizing: border-box/);

    const inputRule = css.match(/\.you-flag input\s*\{[^}]*\}/)?.[0] ?? "";
    assert.ok(inputRule.length > 0);
    assert.match(inputRule, /flex: 1 1 110px/);
    assert.match(inputRule, /min-width: 0/);
    assert.match(inputRule, /max-width: 100%/);
    assert.match(inputRule, /padding: 3px 8px/);

    assert.match(
      css,
      /\.pin-rail-active-inspector \.you-bar,\s*\.pin-rail-active-inspector \.you-flag,\s*\.pin-rail-active-inspector \.lint-bar\s*\{\s*margin: 4px 0 0;\s*padding: 6px 8px;\s*gap: 6px;\s*\}/,
    );
  });

  test("4. .drawer-labels-list .chip wraps long UUIDs cleanly", () => {
    assert.match(
      css,
      /\.drawer-labels-list \.chip\s*\{\s*max-width: 100%;\s*overflow-wrap: anywhere;\s*word-break: break-all;\s*white-space: normal;\s*\}/,
    );
  });
});
