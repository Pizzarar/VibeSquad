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

// ── H2: navigating in the center leaves the sidebar alone ────────────────────
test("H2 only the sidebar callbacks mutate collapsedTeams", () => {
  const app = src("App.tsx").replace(/\r\n/g, "\n");
  const body = (name) => {
    const i = app.indexOf(`const ${name} = useCallback`);
    assert.ok(i > 0, name);
    return app.slice(i, app.indexOf("\n  }, ", i));
  };
  for (const n of ["onTeam", "onAgent", "onQuickStart", "onRailPick"]) assert.doesNotMatch(body(n), /setCollapsedTeams/, n);
  for (const n of ["onToggleTeamExpand", "onTeamHeaderClick", "onToggleAllTeams"]) assert.match(body(n), /setCollapsedTeams/, n);
  // The store functions never see the sidebar state at all.
  assert.doesNotMatch(src("pinFocus.ts"), /collapsedTeams/i);
});

test("H2 centre navigation still moves the active squad and agent", () => {
  const app = src("App.tsx");
  assert.match(app, /const onTeam = useCallback\(\(id: string\) => \{\s*exitSquadsHome\(\);\s*setTeamId\(id\);\s*setScreen\("teams"\);/);
});

// ── H3: a daemon disconnect shows a centered card over a scrim and never reflows the app ──
test("H3 shouldShowDisconnectOverlay debounces blips under 2s", async () => {
  // DiagnosticsModal imports React components; check the helper through its source instead of importing the module.
  const dm = src("DiagnosticsModal.tsx");
  assert.match(dm, /export const DISCONNECT_DEBOUNCE_MS = 2000;/);
  const fn = new Function(
    `const DISCONNECT_DEBOUNCE_MS = 2000; ${dm
      .match(/export function shouldShowDisconnectOverlay[\s\S]*?\n\}/)[0]
      .replace("export ", "")
      .replace(/\(conn: string, disconnectedSinceMs: number \| null, nowMs: number, debounceMs = DISCONNECT_DEBOUNCE_MS\): boolean/, "(conn, disconnectedSinceMs, nowMs, debounceMs = DISCONNECT_DEBOUNCE_MS)")}; return shouldShowDisconnectOverlay;`,
  )();
  assert.equal(fn("connected", 0, 10_000), false);
  assert.equal(fn("disconnected", null, 10_000), false);
  assert.equal(fn("disconnected", 0, 1_999), false);
  assert.equal(fn("disconnected", 0, 2_000), true);
  assert.equal(fn("connecting", 1_000, 2_500, 1_000), true);
});

test("H3 scrim is fixed, does not use role=alert on the outer element, and .app rows ignore it", () => {
  const dm = src("DiagnosticsModal.tsx");
  assert.match(dm, /<div className="daemon-disconnect-scrim" data-testid="daemon-disconnect-scrim">/);
  assert.match(dm, /className="daemon-disconnect-card" data-testid="daemon-down-banner" role="alert"/);
  assert.match(dm, /Daemon disconnected · retrying in \{retryIn\}s/);
  const css = src("ResponsiveSmallWindow.css");
  assert.match(css, /\.daemon-disconnect-scrim \{ position: fixed; inset: 0; z-index: 9500; background: rgba\(5, 6, 13, 0\.72\);/);
  assert.match(css, /\.modal-back:has\(\[data-testid="diagnostics-modal"\]\) \{ z-index: 9600; \}/);
  assert.match(src("styles.css"), /\.app:has\(> \[role="alert"\]:not\(\.daemon-disconnect-scrim\)\)/);
  assert.match(src("App.tsx"), /<DaemonStatusBanner onOpenDiagnostics=\{openDiagnostics\} \/>/);
});
