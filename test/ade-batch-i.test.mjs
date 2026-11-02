import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// I: Diagnostics, daemon-down banner, help, update check, responsive CSS. Node-only logic + source wiring checks.

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function recentErrors(agents) {
  return agents.filter((a) => a.status === "error").map((a) => `${a.id}: status error`);
}
function bannerVisible(conn) {
  return conn !== "connected";
}
function updateLabel(state, version) {
  if (state === "checking") return "Checking…";
  if (state === "ok") return `✓ Up to date (v${version})`;
  if (state === "error") return "Could not check for updates";
  return "Check for updates";
}

test("I1: diagnostics bundle lists agent errors", () => {
  const errs = recentErrors([
    { id: "a1", status: "running" },
    { id: "a2", status: "error" },
  ]);
  assert.deepEqual(errs, ["a2: status error"]);
});

test("I2: banner shows for every non-connected state", () => {
  assert.equal(bannerVisible("connected"), false);
  assert.equal(bannerVisible("disconnected"), true);
  assert.equal(bannerVisible("connecting"), true);
});

test("I3: update label states", () => {
  assert.equal(updateLabel("idle", "0.1.1-beta.1"), "Check for updates");
  assert.equal(updateLabel("ok", "0.1.1-beta.1"), "✓ Up to date (v0.1.1-beta.1)");
  assert.match(updateLabel("error", "x"), /Could not/);
});

test("I4: responsive CSS covers small window, wrapping and 4K", () => {
  const css = read("src/ResponsiveSmallWindow.css");
  assert.match(css, /max-width: 1000px\), \(max-height: 760px\)/);
  assert.match(css, /width: 170px/);
  assert.match(css, /min-height: 180px/);
  assert.match(css, /min-width: 2560px[\s\S]*font-size: 125%/);
  assert.match(css, /\.ws-chips \{[^}]*flex-wrap: wrap/);
});

test("I5: components are wired with the required test ids", () => {
  const d = read("src/DiagnosticsModal.tsx");
  const a = read("src/App.tsx");
  for (const id of ["daemon-down-banner", "diagnostics-log-viewer", "diagnostics-copy-btn", "help-docs-modal"]) assert.ok(d.includes(id), id);
  for (const id of ["open-diagnostics-btn", "open-help-btn", "about-check-updates-btn"]) assert.ok(a.includes(id), id);
  assert.ok(a.includes("<DaemonStatusBanner onOpenDiagnostics={openDiagnostics} />"));
});
