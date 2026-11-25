import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "rolldown/utils";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// PLAN_PROJECT_ORDER O1 (+O2 source checks): order + Main model, pure.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => readFileSync(join(root, "src", f), "utf8");
const dir = mkdtempSync(join(tmpdir(), "po-"));
writeFileSync(join(dir, "projectOrder.mjs"), transformSync("projectOrder.ts", src("projectOrder.ts"), { lang: "ts" }).code);
const po = await import(join(dir, "projectOrder.mjs"));

const T = (id, folder, main) => ({ id, name: id, ...(folder ? { folder } : {}), ...(main ? { main: true } : {}) });
const ids = (ts) => ts.map((t) => t.id);
const known = new Set(["Backlog", "Work"]);

test("at most one Main: setting one clears the rest, unsetting drops the key", () => {
  const a = po.setMainTeams([T("a", null, true), T("b"), T("c")], "c", true);
  assert.deepEqual(a.filter((t) => t.main).map((t) => t.id), ["c"]);
  assert.ok(!("main" in a[0]));
  const off = po.setMainTeams(a, "c", false);
  assert.ok(off.every((t) => !("main" in t)));
});

test("Main renders first regardless of folder; order unchanged with no Main", () => {
  const views = [T("a"), T("b", "Work"), T("c", "Backlog", true), T("d")].map((team) => ({ team }));
  assert.deepEqual(ids(po.orderViews(views).map((v) => v.team)), ["c", "a", "b", "d"]);
  const plain = views.map((v) => ({ team: { ...v.team, main: undefined } }));
  assert.equal(po.orderViews(plain), plain, "no Main = same array, same order");
  assert.equal(po.mainView(views).team.id, "c");
  assert.equal(po.mainView(plain), null);
});

test("Move up/down swaps within the same folder/list only; ends are inert", () => {
  const teams = [T("a"), T("w1", "Work"), T("b"), T("w2", "Work"), T("c")];
  assert.deepEqual(ids(po.moveTeam(teams, "b", "up", known)), ["b", "w1", "a", "w2", "c"]);
  assert.deepEqual(ids(po.moveTeam(teams, "w1", "down", known)), ["a", "w2", "b", "w1", "c"]);
  assert.equal(po.moveTeam(teams, "a", "up", known), teams);
  assert.equal(po.moveTeam(teams, "c", "down", known), teams);
  assert.equal(po.canMove(teams, "a", "up", known), false);
  assert.equal(po.canMove(teams, "a", "down", known), true);
  assert.equal(po.canMove(teams, "w2", "down", known), false);
  // an unknown folder name counts as the unfoldered list, like partitionViews
  assert.equal(po.canMove([T("a"), T("x", "Gone")], "x", "up", known), true);
});

test("drop reorders inside one list and refuses cross-list drops", () => {
  const teams = [T("a"), T("w1", "Work"), T("b"), T("c")];
  assert.deepEqual(ids(po.dropTeam(teams, "c", "a", "before", known)), ["c", "a", "w1", "b"]);
  assert.deepEqual(ids(po.dropTeam(teams, "a", "b", "after", known)), ["w1", "b", "a", "c"]);
  assert.equal(po.dropTeam(teams, "a", "w1", "after", known), teams, "other folder: no-op");
  assert.equal(po.dropTeam(teams, "a", "a", "after", known), teams);
  assert.equal(po.dropTeam(teams, "b", "c", "before", known), teams, "already there: no write");
});

test("ops persist the new array order through save, serialized, and roll back on a failed save", async () => {
  let cur = [T("a"), T("b"), T("c")];
  const saves = [];
  let rolled = 0, ok = true;
  const ops = po.createOrderOps({
    save: async (u) => { saves.push(ids(u(cur))); if (ok) cur = u(cur); return { disk: ok }; },
    rollback: () => { rolled++; },
  });
  await Promise.all([ops.move("c", "up", known), ops.move("c", "up", known), ops.setMain("b", true)]);
  assert.deepEqual(saves[0], ["a", "c", "b"]);
  assert.deepEqual(saves[1], ["c", "a", "b"], "second write sees the first");
  assert.deepEqual(ids(cur), ["c", "a", "b"]);
  assert.equal(cur.find((t) => t.main).id, "b");
  assert.equal(rolled, 0);
  await ops.drop("b", "c", "before", known);
  assert.deepEqual(ids(cur), ["b", "c", "a"]);
  ok = false;
  assert.equal(await ops.move("a", "up", known), false);
  assert.equal(rolled, 1, "failed save rolls back to disk");
});

test("menu labels flip and disable at the ends (source)", () => {
  const cp = src("CommandPalette.tsx");
  assert.match(cp, /isMain \? "Unset main project" : "Make main project"/);
  assert.match(cp, /label: "Move up", disabled: !canMove\(order, view\.team\.id, "up", known\)/);
  assert.match(cp, /label: "Move down", disabled: !canMove\(order, view\.team\.id, "down", known\)/);
  assert.match(cp, /projectOrder\.setMain\(view\.team\.id, !isMain\)/);
  const idx = cp.indexOf("Make main project"), opts = cp.lastIndexOf("if (opts?.folders)", idx);
  assert.ok(opts > 0 && cp.indexOf("return items;", idx) > idx, "Normal-only: inside the opts.folders block, so Psycho gets none");
  assert.match(src("teams.ts"), /main\?: boolean;/);
  assert.match(src("projectOrderActions.ts"), /saveTeams\(\(cur\) => update\(cur\) as TeamDef\[\]\)[\s\S]*rollback: resetTeamsToDisk/);
});

test("sidebar sources its order from teams.json via buildTeamViews, then orderViews", () => {
  assert.match(src("teams.ts"), /const all = \[\.\.\.TEAMS, UNASSIGNED\]/);
  assert.match(src("BoringAde.tsx"), /partitionViews\(mainV \? allViews\.filter\(\(v\) => v !== mainV\) : allViews, folders, stat\)/);
});

test("O2: Main row is pinned outside the scrolling tree, compact, with an Open target to the Buddy chat", () => {
  const ade = src("BoringAde.tsx"), css = src("boring.css");
  assert.ok(ade.indexOf('data-testid="boring-main-pin"') < ade.indexOf('data-testid="boring-project-tree"'), "pin sits above the tree (and its scroll/folders)");
  assert.match(ade, /renderProject\(mainV, true\)/);
  assert.match(ade, /pickCore\("_riffbot", m\.core\.riffbot\.agentId, v\.team\.id\)/, "Open goes straight to that Squad's Buddy chat");
  assert.match(ade, /projectOpen\[v\.team\.id\] \?\? false/, "starts compact");
  const block = css.slice(css.indexOf("PLAN_PROJECT_ORDER O2"), css.indexOf("end PLAN_PROJECT_ORDER O2"));
  assert.match(block, /\.boring-main-pin \{[^}]*border: 1px solid var\(--accent\)/);
  assert.match(block, /\.boring-main-line \{[^}]*min-height: 54px/, "~1.5x the 36px row");
  assert.ok(!/opacity: 0\./.test(block) && !/image-rendering: auto/.test(block), "dim by colour, no fractional opacity");
  assert.match(css, /\.boring-project-line:focus-within \.boring-drag-grip/, "grip shows on hover/focus/active row (a touch tap sticks :hover); phones also have Move up/down");
});

test("O2: drag uses pointer events (mouse + touch), same-list guard, drop persists through projectOrder.drop", () => {
  const ade = src("BoringAde.tsx"), css = src("boring.css");
  assert.match(ade, /onPointerDown=.*setPointerCapture/);
  assert.match(ade, /dataset\.orderGroup !== orderGroup\(v\)/, "cross-list targets are ignored");
  assert.match(ade, /projectOrder\.drop\(d\.id, d\.over, d\.where, knownF\)/);
  assert.match(css, /\.boring-drag-grip \{[^}]*touch-action: none/);
  assert.match(css, /drop-before \{ box-shadow: inset 0 2px 0 var\(--accent\)/, "visible drop indicator");
  assert.ok(!/boring-drag-grip/.test(src("App.tsx")), "Psycho gets no new UI");
});
