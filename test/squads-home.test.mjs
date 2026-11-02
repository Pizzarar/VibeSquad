import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { breadcrumbOf, levelUp, pickLead } from "../src/pinFocusLogic.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

// ── H1: chat → squad page → Squads Home ──────────────────────────────────────
test("H1 levelUp climbs chat → squad page → Squads Home and stops", () => {
  assert.equal(levelUp({ focused: true, home: false, squadsHome: false }), "squad-page");
  assert.equal(levelUp({ focused: false, home: true, squadsHome: false }), "squads-home");
  assert.equal(levelUp({ focused: false, home: true, squadsHome: true }), "none");
  // Not home yet (e.g. back from FULL): land on the squad page.
  assert.equal(levelUp({ focused: false, home: false, squadsHome: false }), "squad-page");
});

test("H1 breadcrumb segments per level", () => {
  assert.deepEqual(breadcrumbOf({ squadsHome: true, squadName: "VibeSquad", laneName: null }).map((c) => c.key), ["squads"]);
  assert.deepEqual(breadcrumbOf({ squadsHome: false, squadName: "VibeSquad", laneName: null }).map((c) => c.key), ["squads", "squad"]);
  const chat = breadcrumbOf({ squadsHome: false, squadName: "VibeSquad", laneName: "Pins" });
  assert.deepEqual(chat.map((c) => c.key), ["squads", "squad", "brainstorm"]);
  assert.equal(chat[2].label, "BRAINSTORM · Pins");
  assert.equal(chat[2].current, true);
});

test("H1 pickLead prefers a running lead, else any live lead, else null", () => {
  const a = { agent: { status: "idle" } };
  const b = { agent: { status: "running" } };
  assert.equal(pickLead([{ lead: a }, { lead: b }]), b);
  assert.equal(pickLead([{ lead: null }, { lead: a }]), a);
  assert.equal(pickLead([{ lead: null }]), null);
});

test("H1 store wiring: opening a squad leaves Squads Home; focusPin clears it", () => {
  const pf = src("pinFocus.ts");
  assert.match(pf, /export function enterSquadsHome/);
  assert.match(pf, /export function exitSquadsHome\(\) \{\s*set\(\{ focus: null, home: true, squadsHome: false/);
  assert.match(pf, /home: false,\s*homeActive: null,\s*squadsHome: false,\s*\}\);\s*if \(live\)/);
  const app = src("App.tsx");
  assert.match(app, /const onTeam = useCallback\(\(id: string\) => \{\s*exitSquadsHome\(\);/);
  assert.match(app, /<SquadsHome views=\{sidebarViews\} onSelectSquad=\{onTeam\} onOpenPin=\{onQuickStart\} onNewSquad=\{openNewSquad\}/);
  assert.match(app, /data-testid="squad-page-home-btn"/);
});

test("H1 Squads Home tiles: huddle portraits stop propagation, + NEW SQUAD tile, 390px single column", () => {
  const pg = src("PinGrid.tsx");
  assert.match(pg, /data-testid="squad-home-new-tile"/);
  assert.match(pg, /e\.stopPropagation\(\);\s*void Promise\.resolve\(onOpenPin\(pin\)\)/);
  assert.match(pg, /Lead: \{leadName\} · \{leadState\}/);
  const css = src("styles.css");
  assert.match(css, /@media \(max-width: 520px\) \{ \.squads-home-grid, \.pin-grid \{ grid-template-columns: 1fr; \} \}/);
  assert.match(css, /\.squad-home-portrait:not\(:first-child\) \{ margin-left: -10px; \}/);
});
