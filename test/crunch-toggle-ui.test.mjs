import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// C3 (PLAN_CRUNCH_MODE): one registry field (vibeMode), three surfaces through one component, so a click anywhere syncs the rest.
const src = (f) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", f), "utf8");

test("CrunchToggle writes only vibeMode on the matching Squad and reads it live from the registry", () => {
  const c = src("CrunchToggle.tsx");
  assert.match(c, /saveTeams\(\(cur\) => cur\.map\(\(t\) => \(t\.id === teamId \? \{ \.\.\.t, vibeMode: on \} : t\)\)\)/);
  assert.match(c, /rollback: resetTeamsToDisk/, "failed save rolls back");
  assert.match(c, /aria-busy/, "pill is busy while saving");
  assert.match(c, /disabled: busy/);
  assert.match(c, /useTeams\(\);[\s\S]*vibeMode === true/, "subscribes to the registry so the other surfaces re-render");
  assert.match(c, /setCrunchMode\(teamId, !on\)/, "click flips the current state");
  assert.match(c, /Crunch \$\{state\}/, "Normal pill shows its state");
  assert.match(c, /"aria-pressed": on/);
  assert.match(c, /`Crunch \$\{state\}`/, "chips show both states");
  assert.ok(!/opacity/.test(c), "dim by colour, never opacity");
});

test("all three surfaces use the Crunch label and the shared state", () => {
  const ade = src("BoringAde.tsx"), app = src("App.tsx"), modal = src("TeamSettingsModal.tsx");
  assert.ok(ade.includes('<CrunchToggle key={view.team.id} teamId={view.team.id} variant="boring" />'), "Normal topbar pill");
  assert.ok(ade.indexOf("<CrunchToggle") > ade.indexOf('data-testid="boring-details-toggle"'), "last in the actions cluster, after Split/Details (does not shift)");
  assert.ok(ade.includes("<ProjectTabs projectId={view.team.id}"), "Code|Storybook tabs intact");
  assert.ok(app.includes('<CrunchToggle key={props.squadId} teamId={props.squadId} variant="psycho" />'), "Psycho chip, always rendered");
  assert.ok(!app.includes("vibe-mode-chip") && !/Vibe mode/.test(app), "old one-way chip is gone");
  assert.match(modal, /aria-label="Crunch mode"/);
  assert.match(modal, /checked=\{t\.vibeMode === true\}/, "same field");
  assert.match(modal, /Crunch mode: lanes act on their leans/);
  assert.ok(!/Vibe mode/.test(modal), "no stale 'Vibe mode' label");
});

test("N1: light-mode active Code|Storybook label uses --text; Crunch pill styled, no opacity", () => {
  const b = src("boring.css");
  assert.match(b, /\[data-theme="light"\] \.project-tabs \.boring-switch-pill\.on \{ color: var\(--text\); \}/);
  assert.match(b, /\.boring-crunch-pill\[aria-pressed="true"\]\.on \{[^}]*box-shadow: inset 0 0 0 1px var\(--accent\)/);
  assert.ok(!/boring-crunch-pill[^{]*\{[^}]*opacity: (?!1;)/.test(b), "colour not opacity (opacity: 1 only)");
});

test("phone drawer row, palette command and settings search find Crunch mode", () => {
  const ph = src("PhoneCockpit.tsx"), pal = src("CommandPalette.tsx"), prefs = src("prefs.ts"), css = src("styles.css");
  assert.ok(ph.includes('<CrunchToggle key={view.team.id} teamId={view.team.id} variant="phone" />'));
  assert.ok(ph.indexOf("<CrunchToggle") < ph.indexOf('data-testid="phone-usage-btn"'), "near Usage");
  assert.match(css, /\.phone-crunch-btn \{ min-height: 44px;/, "44px touch target");
  assert.match(src("crunchMode.ts"), /Turn Crunch \$\{s\.on \? "off" : "on"\} · \$\{s\.name\}/);
  assert.match(pal, /id\.startsWith\("crunch:"\)/);
  assert.match(prefs, /id: "crunch-mode"[^}]*keywords: \["crunch"/);
});

test("UX m3: sb-head pill type (weight 600) is Psycho-only so Normal keeps the topbar weight", () => {
  const css = src("storybook.css");
  assert.ok(!/\n\.sb-head \.project-tabs \.boring-switch-pill \{[^}]*font-weight/.test(css));
  assert.match(css, /html:not\(\[data-vibe="boring"\]\) \.sb-head \.project-tabs \.boring-switch-pill \{[^}]*font-weight: 600/);
});

test("r2: keyed toggles, current-Squad settings target, Normal sb-head 13px, failed colour wins hover, phone edge", () => {
  assert.ok(src("BoringAde.tsx").includes('<CrunchToggle key={view.team.id} teamId'));
  assert.ok(src("PhoneCockpit.tsx").includes('<CrunchToggle key={view.team.id} teamId'));
  assert.match(src("TeamSettingsModal.tsx"), /data-setting-id=\{t\.id === crunchTargetId \? "crunch-mode" : undefined\}/);
  assert.match(src("storybook.css"), /\n\.sb-head \.project-tabs \.boring-switch-pill \{[^}]*font-size: 13px/);
  assert.match(src("boring.css"), /boring-crunch-pill\[data-failed\]\[aria-pressed\]:hover:not\(:disabled\) \{ color: var\(--st-err/);
  const css = src("styles.css");
  assert.match(css, /\.phone-crunch-btn\[data-failed\] \{ color: var\(--st-err/);
  assert.match(css, /\.phone-crunch-btn\.on \{[^}]*box-shadow: inset 3px 0 0 var\(--cyan\)/);
});

test("r3: Psycho chip keyed, flip hook resets on Squad change, Storybook-aware current Squad, Normal phone colours", () => {
  assert.ok(src("App.tsx").includes('<CrunchToggle key={props.squadId} teamId={props.squadId} variant="psycho" />'));
  assert.match(src("CrunchToggle.tsx"), /setBusy\(false\); setFailed\(false\); \}, \[teamId\]/);
  assert.match(src("App.tsx"), /setCurrentSquadId\(resolveCurrentSquad\(view\?\.team\.id, sbTarget\?\.projectId, deviceRole\)\)/);
  const b = src("boring.css");
  assert.match(b, /html\[data-vibe="boring"\] \.btn\.phone-crunch-btn\.on \{[^}]*box-shadow: inset 3px 0 0 var\(--accent\)/);
  assert.match(b, /\.btn\.phone-crunch-btn\[data-failed\] \{ color: var\(--st-err/);
  assert.ok(!/phone-crunch-btn[^{]*\{[^}]*opacity: (?!1;)/.test(b));
});
