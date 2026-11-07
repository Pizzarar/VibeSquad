// PLAN_P5_NATIVE_ROUTES.md block N5: the daemon upload route and GitHub clone are cut, while inline
// text-file attachment (which works on runner agents without the daemon) is kept. Source assertions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("daemon upload is cut, but inline text-file attachment is kept", () => {
  const att = src("attachments.ts");
  const comp = src("Composer.tsx");
  const drawer = src("AgentDrawer.tsx");

  // No daemon upload route, no upload ref generator, no upload stub error.
  assert.doesNotMatch(att, /daemonClient/);
  assert.doesNotMatch(att, /attachedRef/);
  assert.doesNotMatch(comp, /daemonClient/);
  assert.doesNotMatch(drawer, /too big or binary|no upload route yet/);

  // Inline text-file attachment is kept.
  assert.match(att, /export async function composeMessage/);
  assert.match(att, /export function addAttachments/);
  assert.match(att, /export function useAttachments/);
  assert.match(att, /export function formatSize/);
  assert.match(comp, /data-testid="composer-file-chip"/);
  assert.match(comp, /accept=\{FILE_ACCEPT\}/);

  // Large/binary files are rejected at drop time with an inline note, not uploaded.
  assert.match(att, /attach a path instead/);
  assert.match(att, /isBinaryBytes/);
  assert.match(att, /export async function stageFiles/);
  assert.match(att, /export function partitionFiles/);
});

test("GitHub clone entry points are gone from NewSquadModal, TeamActions and App", () => {
  for (const f of ["NewSquadModal.tsx", "TeamActions.tsx"]) {
    const s = src(f);
    assert.doesNotMatch(s, /clone|Clone|github|GitHub/i);
    assert.doesNotMatch(s, /not available yet|Cloning from GitHub/);
    assert.doesNotMatch(s, /clone-repo-btn|cloneProject|cloneRepo|cloneDest|cloning/);
  }
  const ns = src("NewSquadModal.tsx");
  assert.match(ns, /data-testid="new-squad-name"/);
  assert.match(ns, /data-testid="new-squad-start-buddy"/);
  assert.match(ns, /Folder path/);
  const ta = src("TeamActions.tsx");
  assert.match(ta, /add-project-toggle/);
  assert.match(ta, /addLocalProject/);
  const app = src("App.tsx");
  assert.doesNotMatch(app, /project folder or clone repo/);
});
