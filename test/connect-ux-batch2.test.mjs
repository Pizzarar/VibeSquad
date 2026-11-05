import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("userName.ts: setLocalAccess checks !isRemote(), dismissStaleBuild persists, useStaleBuildDismissed exported", () => {
  const userName = read("src/userName.ts");
  assert.match(userName, /const next = !isRemote\(\) && access === "read-only";/);
  assert.match(userName, /=> \(isRemote\(\) \? false : localReadOnly\),/);
  assert.match(userName, /DISMISSED_STALE_BUILD_KEY = "vs\.dismissedStaleBuild";/);
  assert.match(userName, /localStorage\.setItem\(DISMISSED_STALE_BUILD_KEY, dismissedStaleBuildKey\)/);
  assert.match(userName, /export const getStaleBuild = \(\) => staleBuild;/);
  assert.match(userName, /export function staleBuildKey\(s: \{ built: string; head: string \} \| null\): string/);
  assert.match(userName, /export function dismissStaleBuild\(\): void/);
  assert.match(userName, /export function useStaleBuildDismissed\(\): boolean/);
});

test("DiagnosticsModal.tsx: bundle includes staleBuild and modal renders diagnostics-build-status", () => {
  const modal = read("src/DiagnosticsModal.tsx");
  assert.match(modal, /staleBuild: \{ built: string; head: string; behind: number \} \| null;/);
  assert.match(modal, /staleBuild: getStaleBuild\(\),/);
  assert.match(modal, /data-testid="diagnostics-build-status"/);
  assert.match(modal, /const staleBuild = useStaleBuild\(\);/);
  assert.match(modal, /const updaterStatus = useUpdaterStatus\(\);/);
});

test("App.tsx: stale-build popup is a role=status, gated, dismissible and floats", () => {
  const app = read("src/App.tsx");
  assert.match(app, /staleBuild && !isRemote\(\) && !staleBuildDismissed/);
  assert.match(app, /className="stale-build-banner"\s+data-testid="stale-build-banner"\s+role="status"/);
  assert.match(app, /data-testid="dismiss-stale-build-btn"/);
  assert.match(app, /localReadOnly && !isRemote\(\)/);
});

test("App.tsx: Sidebar zones and preserved controls", () => {
  const app = read("src/App.tsx");
  assert.match(app, /data-testid="sidebar-scroll"/);
  assert.match(app, /data-testid="sidebar-dock"/);
  assert.match(app, /data-testid="sidebar-signals-toggle"/);
  for (const id of [
    "sidebar-settings-btn",
    "open-diagnostics-btn",
    "open-help-btn",
    "about-licenses-btn",
    "sidebar-unpair-btn",
    "sidebar-ui-scale-btn",
    "sidebar-new-squad-btn",
  ]) {
    assert.match(app, new RegExp(`data-testid="${id}"`), `missing data-testid ${id}`);
  }
});

test("styles.css: sidebar stops whole-nav scroll and sidebar-scroll takes over", () => {
  const css = read("src/styles.css");
  assert.match(css, /\.sidebar\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /\.sidebar-scroll\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.sidebar-dock\s*\{/);
  assert.match(css, /\.sidebar-signals-toggle\s*\{/);
  assert.match(css, /\.sidebar-signals-dots\s*\{/);
  assert.match(css, /\.sidebar-footer-left,\s*\.sidebar-footer-right\s*\{/);
  assert.match(css, /\.sidebar-icon-btn\s*\{/);
  assert.match(css, /\.sidebar-cog-btn\s*\{/);
  assert.match(css, /\.sidebar-stale-dot\s*\{/);
  assert.match(css, /\.diag-build-status\s*\{/);
  assert.match(css, /\.diag-build-status\.stale\s*\{/);
  assert.match(css, /\.diag-build-status\.ok\s*\{/);
});
