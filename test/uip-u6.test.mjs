import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const app = read("src/App.tsx");
const crumb = read("src/Breadcrumb.tsx");
const rail = read("src/FocusRail.tsx");
const panes = read("src/AgentPanes.tsx");

test("SQUADS button resets FULL and focus before entering Squads Home", () => {
  const i = app.search(/\n\s*SQUADS\r?\n/);
  assert.ok(i > 0);
  const block = app.slice(i - 400, i);
  assert.match(block, /setFullView\(false\)/);
  assert.match(block, /setFocus\(false\)/);
  assert.match(block, /enterSquadsHome\(\)/);
});

test("breadcrumb Squads crumb resets FULL and focus", () => {
  assert.match(crumb, /function goSquadsHome\(\)\s*\{\s*setFullView\(false\);\s*setFocus\(false\);\s*enterSquadsHome\(\);/);
  assert.match(crumb, /c\.key === "squads" \? goSquadsHome/);
});

test("onTeam and onTeamHeaderClick leave FULL and focus and land on the squad grid", () => {
  for (const fn of ["onTeam", "onTeamHeaderClick"]) {
    const m = app.match(new RegExp(String.raw`const ${fn} = useCallback\(\(id: string\) => \{([\s\S]*?)\}, \[\]\)`));
    assert.ok(m, fn);
    assert.match(m[1], /setFullView\(false\);\s*setFocus\(false\);\s*exitSquadsHome\(\);/);
  }
});

test("FocusRail ◂ TEAM does the same reset", () => {
  assert.match(rail, /const backToTeam = \(\) => \{\s*setFocus\(false\);\s*setFullView\(false\);\s*exitSquadsHome\(\);/);
  assert.match(rail, /onClick=\{backToTeam\}/);
  assert.doesNotMatch(rail, /onClick=\{toggleFocus\}/);
});

test("TabStrip has a ⊞ TEAMS button with the same reset", () => {
  const i = panes.indexOf('data-testid="pane-teams-home-btn"');
  assert.ok(i > 0);
  const block = panes.slice(i, i + 400);
  assert.match(block, /setFocus\(false\);\s*setFullView\(false\);\s*exitSquadsHome\(\);/);
  assert.match(block, /<PixelIcon name="teams"[^>]*fallback="⊞"[^>]*\/>\s*TEAMS/);
});

test("rail alerts skip finished items and rows drop the role tags", () => {
  assert.match(rail, /m\.attention\.tone !== "finished"/);
  assert.doesNotMatch(rail, /rail-role-tag/);
  assert.doesNotMatch(rail, /> · TALK HERE/);
  assert.doesNotMatch(rail, /> · RUNS THE WORK/);
});

test("leaving FULL / focus does not override an explicit Squads Home request", () => {
  assert.match(app, /leftPinLayout\.current && !getSquadsHome\(\)\) exitSquadsHome\(\)/);
});
