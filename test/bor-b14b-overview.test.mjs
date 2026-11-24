// @bor B14b: Project Overview Living Signature restyle (docs/PLAN_BORING_MODE_B14.md Block 2).
// Asserts the Overview lane table (src/BoringAde.tsx ~1052-1099) and its src/boring.css section carry the
// B13 Living Signature language: Art14 canon mini-busts on every row, calm segmented tabs that harmonize
// with the living sky, a tone-stepped card container, and WCAG >= 4.5:1 text contrast in dark + light.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (...p) => readFileSync(resolve(root, ...p), "utf8");
const ade = read("src", "BoringAde.tsx");
const css = read("src", "boring.css");

test("B14b: Overview lane table renders Art14 canon mini-busts for Desk (RiffBot/Overlord), Bugs and feature lanes", () => {
  // bust role mapping mirrors bustRoleForAgent (src/boringBusts.ts): Desk -> riffbot/overlord, Bugs -> bugs, lane -> buddy/lead.
  assert.ok(ade.includes('const bust: { bs: BustRole; ld: BustRole } = r.laneId === "_desk" ? { bs: "riffbot", ld: "overlord" }'));
  assert.ok(ade.includes('r.laneId === "_bugs" ? { bs: "bugs", ld: "bugs" } : { bs: "buddy", ld: "lead" }'));
  // Busts use the B13c mini-avatar ring vocabulary and bustUrl with the live theme.
  assert.ok(ade.includes("bustUrl(role, theme)"));
  assert.ok(ade.includes('className="boring-lane-mini none" aria-hidden="true"'));
  assert.ok(ade.includes('className="boring-bust-img"'));
  // working/idle/needs-you state cues: running -> run+lit, error -> err, needs-you -> attn, otherwise idle; no agent -> hollow.
  assert.ok(ade.includes('const bustCell = (role: BustRole, status: string, always: boolean) => {'));
  assert.ok(ade.includes('const state = status === "error" ? "err" : r.needsYou > 0 ? "attn" : live ? "run" : "idle";'));
  assert.ok(ade.includes('live ? " lit" : ""'));
  // The Bugs row is the Bugs mascot itself: its brainstorm bust always renders (never hollow).
  assert.ok(ade.includes('{bustCell(bust.bs, r.brainstorm, r.laneId === "_bugs")}'));
  assert.ok(ade.includes('{bustCell(bust.ld, r.lead, false)}'));
});

test("B14b: Overview keeps the lane identity cell first (dot + name + code + Needs-you badge) and its testids", () => {
  assert.ok(ade.includes('data-testid="boring-lane-table"'));
  assert.ok(ade.includes('data-testid="boring-overview-tabs"'));
  assert.ok(ade.includes('data-testid="boring-overview-new-lane-btn"'));
  assert.ok(ade.includes("data-testid={`boring-lane-row-${r.laneId}`}"));
  // Needs-you cue on the row + badge preserved.
  assert.ok(ade.includes('r.needsYou > 0 ? " attn" : ""'));
  assert.ok(ade.includes('r.kind === "desk" ? " desk" : ""'));
  assert.ok(ade.includes("Needs you · {r.needsYou}"));
});

test("B14b: CSS section is scoped, placed before D4 polish, and has no !important or top-level @keyframes", () => {
  const head = css.indexOf("/* ---- B14b Overview");
  const d4 = css.indexOf("/* --- D4 polish");
  assert.ok(head >= 0, "B14b section header present");
  assert.ok(head < d4, "B14b section sits before the D4 polish marker (never appended at EOF)");
  const section = css.slice(head, d4);
  assert.doesNotMatch(section, /!important/, "no !important in the B14b section");
  assert.doesNotMatch(section, /@keyframes/, "no top-level @keyframes in the B14b section");
  // every rule in the section is scoped under html[data-vibe="boring"] (or inside an @media wrapper whose inner rules are).
  const noComments = section.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const sel of noComments.split("}").map((b) => b.replace(/@media[^{]*\{/g, "").split("{")[0]).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean)) {
    assert.ok(sel.startsWith('html[data-vibe="boring"]'), `unscoped selector in B14b: ${sel}`);
  }
});

test("B14b: segmented tabs + New lane + tone-stepped card + living-sky harmony are all present", () => {
  assert.ok(css.includes('html[data-vibe="boring"] .boring-overview-tabs { display: inline-flex; align-items: center; gap: 2px; padding: 3px; background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; }'));
  assert.ok(css.includes('.boring-overview-tabs .boring-switch-pill.on { background: var(--surface-3); color: var(--text-1); font-weight: 600;'));
  assert.ok(css.includes('html[data-vibe="boring"] [data-squad-state="busy"] .boring-overview-tabs .boring-switch-pill.on { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--living-warm) 55%, var(--border-strong)); }'));
  assert.ok(css.includes('html[data-vibe="boring"] .boring-lane-table { width: 100%; border-collapse: separate; border-spacing: 0; background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius);'));
  assert.ok(css.includes('html[data-vibe="boring"] .boring-lane-stat { font-family: var(--mono); font-size: var(--t-caption, 11px);'));
  // the desk rows dim by tone step (never opacity), keeping the busts full-colour.
  assert.ok(css.includes('.boring-lane-row.desk { opacity: 1; background: color-mix(in srgb, var(--surface-2) 35%, var(--surface-1)); }'));
});

// ── WCAG 2.x contrast: relative luminance + ratio over the token pairs the Overview actually paints. ──
function lum(hex) {
  const c = hex.replace(/^#/, "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(fg, bg) {
  const a = lum(fg), b = lum(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
function blockTokens(anchor) {
  const a = css.indexOf(anchor);
  assert.ok(a >= 0, `token anchor not found: ${anchor}`);
  const open = css.lastIndexOf("{", a);
  const close = css.indexOf("}", a);
  const out = {};
  for (const m of css.slice(open + 1, close).matchAll(/--([\w-]+):\s*([^;]+);/g)) out[`--${m[1]}`] = m[2].trim();
  return out;
}
const dark = blockTokens("--surface-0: #121218;");
const light = blockTokens("--surface-0: #f7f6f3;");

test("B14b: WCAG >= 4.5:1 text contrast in dark and light themes (measured)", () => {
  const pairs = [
    ["text-1 on surface-1 (lane name, active tab)", "--text-1", "--surface-1"],
    ["text-2 on surface-1 (cell / status / tab / New lane)", "--text-2", "--surface-1"],
    ["text-3 on surface-1 (lane code, last event)", "--text-3", "--surface-1"],
    ["text-3 on surface-2 (table header labels)", "--text-3", "--surface-2"],
    ["on-accent on st-attn (Needs-you badge)", "--on-accent", "--st-attn"],
  ];
  const report = [];
  for (const [name, tokens] of [["dark", dark], ["light", light]]) {
    for (const [label, fgKey, bgKey] of pairs) {
      const r = ratio(tokens[fgKey], tokens[bgKey]);
      report.push(`${name} ${label}: ${r.toFixed(2)}:1`);
      assert.ok(r >= 4.5, `${name} ${label} ${tokens[fgKey]} on ${tokens[bgKey]} = ${r.toFixed(2)}:1 < 4.5:1`);
    }
  }
  // Surface the measured ratios in the test output for the report.
  process.stdout.write(`B14b contrast ratios:\n  ${report.join("\n  ")}\n`);
});
