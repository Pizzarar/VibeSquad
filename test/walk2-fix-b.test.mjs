import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Source-wiring checks for WALK2-FIX-B (ADE job walk v2 fixes).
const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("FilesPanel handles images, binary, oversize and not-found", () => {
  const s = src("FilesPanel.tsx");
  assert.match(s, /files-image-view/);
  assert.match(s, /Binary file, \$\{kb\} KB, not shown/);
  assert.match(s, /MAX_TEXT_BYTES/);
  assert.match(s, /!notFound && !notice && !imgUrl/); // Edit hidden for non-text
});

test("terminal tabs are one-line with ellipsis and a title", () => {
  assert.match(src("TerminalPanel.tsx"), /title=\{t\.name\}/);
  assert.match(src("styles.css"), /\.terminal-tab-name \{[^}]*text-overflow: ellipsis/);
});

test("settings modal is titled Settings", () => {
  assert.match(src("TeamSettingsModal.tsx"), /title="Settings"/);
});

test("Ago has a full-time title", () => {
  assert.match(src("ui.tsx"), /title=\{full/);
});

test("diagnostics retry is time-capped", () => {
  assert.match(src("DiagnosticsModal.tsx"), /Promise\.race\(\[attempt/);
});

test("App restores focus to modal opener", () => {
  assert.match(src("App.tsx"), /el\.focus\(\)/);
});

test("round 2: Files short-circuits big/binary before readFile, caps images, svg via data:, notFound only in catch", () => {
  const s = src("FilesPanel.tsx");
  assert.ok(s.indexOf("known > cap") < s.indexOf("daemonClient.readFile(cwd, path, undefined, cap + 1)"));
  assert.match(s, /MAX_IMG_BYTES/);
  assert.match(s, /data:image\/svg\+xml;base64/);
  assert.doesNotMatch(s, /Could not read file/);
  assert.match(s, /void openFileNode\(targetFile\)/);
});

test("round 2: Modal and palette restore focus; diagnostics guards in-flight retry", () => {
  assert.match(src("TeamActions.tsx"), /stranded && opener/);
  assert.match(src("CommandPalette.tsx"), /dismissRef\.current\(\)/);
  assert.match(src("CommandPalette.tsx"), /onMouseDown=\{dismiss\}/);
  const d = src("DiagnosticsModal.tsx");
  assert.match(d, /inFlight\.current/);
  assert.match(d, /clearTimeout\(timer\)/);
});
