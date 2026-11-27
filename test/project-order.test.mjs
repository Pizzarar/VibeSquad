import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformSync } from "rolldown/utils";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// PLAN_PROJECT_ORDER O1 (+O2 source checks): order + Main model, pure.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => readFileSync(join(root, "src", f), "utf8");
const dir = mkdtempSync(join(tmpdir(), "po-"));
writeFileSync(join(dir, "projectOrder.mjs"), transformSync("projectOrder.ts", src("projectOrder.ts"), { lang: "ts" }).code);
const po = await import(pathToFileURL(join(dir, "projectOrder.mjs")).href); // a C:\ path is not an import URL on win32

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
  await ops.drop("a", "c", "before", known); // b is Main now: hidden, so the visible list is c, a
  assert.deepEqual(ids(cur), ["a", "c", "b"]);
  ok = false;
  assert.equal(await ops.move("c", "up", known), false);
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

test("sidebar sources its order from teams.json via buildTeamViews; Main is lifted out by mainView", () => {
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
  assert.match(block, /\.boring-main-line\.boring-project-line \{[^}]*min-height: 54px/, "~1.5x the 36px row");
  assert.ok(!/opacity: 0\./.test(block) && !/image-rendering: auto/.test(block), "dim by colour, no fractional opacity");
  assert.match(css, /\.boring-project-line:focus-within \.boring-drag-grip/, "grip shows on hover/focus/active row (a touch tap sticks :hover); the keyboard path is ⋯ → Move up/down");
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

test("r1: Main sharing a list is never a visible neighbour (Move up/down, drop)", () => {
  const M = (id, folder) => T(id, folder, true);
  // Main first in the list: the first visible row's Move up is disabled, not a hidden swap
  let teams = [M("m"), T("a"), T("b")];
  assert.equal(po.canMove(teams, "a", "up", known), false);
  assert.equal(po.moveTeam(teams, "a", "up", known), teams);
  assert.equal(po.canMove(teams, "a", "down", known), true);
  // Main last: the last visible row's Move down is disabled
  teams = [T("a"), T("b"), M("m")];
  assert.equal(po.canMove(teams, "b", "down", known), false);
  assert.equal(po.moveTeam(teams, "b", "down", known), teams);
  // Main between two visible rows: one click moves one visible step, Main keeps its slot
  teams = [T("a"), M("m"), T("b")];
  assert.deepEqual(ids(po.moveTeam(teams, "a", "down", known)), ["b", "m", "a"]);
  assert.deepEqual(ids(po.moveTeam(teams, "b", "up", known)), ["b", "m", "a"]);
  // Main has no Move of its own
  assert.equal(po.canMove(teams, "m", "up", known), false);
  assert.equal(po.canMove(teams, "m", "down", known), false);
  assert.equal(po.moveTeam(teams, "m", "down", known), teams);
  // Same list only: a Main in another folder never interferes
  teams = [T("a"), M("m", "Work"), T("b")];
  assert.deepEqual(ids(po.moveTeam(teams, "a", "down", known)), ["b", "m", "a"]);
  // drop: never onto/with Main; a drop that only hops the hidden Main slot is not a write
  teams = [T("a"), M("m"), T("b")];
  assert.equal(po.dropTeam(teams, "a", "m", "after", known), teams);
  assert.equal(po.dropTeam(teams, "m", "a", "before", known), teams);
  assert.equal(po.dropTeam(teams, "a", "b", "before", known), teams, "visibly identical = no write");
  assert.deepEqual(ids(po.dropTeam(teams, "b", "a", "before", known)), ["b", "a", "m"].sort((x, y) => 0) && ["b", "a", "m"]);
});

test("r1: the Main menu has no Move items; the drag cancels on Escape; the chevron toggles from the shown state", () => {
  const cp = src("CommandPalette.tsx"), ade = src("BoringAde.tsx");
  assert.match(cp, /if \(!isMain\) \{\s*items\.push\(\{ label: "Move up"/);
  assert.match(ade, /e\.key === "Escape"[\s\S]{0,60}dragCancel\(\)/);
  assert.match(ade, /releasePointerCapture/);
  assert.match(ade, /const setDragNow = \(d: typeof drag\) => \{ dragRef\.current = d;/, "ref set synchronously so pointerup after Escape commits nothing");
  assert.match(ade, /\[v\.team\.id\]: !open \}\)\), v\.team\.name/, "Main chevron negates the shown state, not projectIsOpen");
  assert.ok(!/className="boring-drag-grip" role=/.test(ade), "pointer-only grip is not a fake button");
  const css = src("boring.css"), block = css.slice(css.indexOf("PLAN_PROJECT_ORDER O2"), css.indexOf("end PLAN_PROJECT_ORDER O2"));
  assert.match(block, /\.boring-main-pin \{ flex: 0 1 auto; min-height: 60px; overflow-y: auto; border: 1px solid var\(--accent\)/, "shrinks + scrolls inside to keep the footer, never below its header");
  assert.match(block, /\.boring-main-pin:has\(\.boring-project-block\.open\) \{ min-height: 220px; \}/, "expanded floor");
  assert.match(block, /\.boring-main-pin \.boring-project-block\.open \{ background: transparent; border: 0; border-radius: 0; padding: 0 9px;/, "no open-card chrome in the pin: header does not jump on expand");
  assert.ok(!/max-height/.test(block));
  assert.match(block, /\.boring-main-line\.boring-project-line \{ position: sticky;/, "sticky beats .boring-project-line { position: relative }");
  assert.match(block, /\.boring-main-pin ~ \.boring-project-tree \{ flex-basis: 0; min-height: 120px; \}/, "tree floor = master 120px");
  assert.ok(!/max-height: 40%/.test(block));
  assert.match(block, /\.boring-drag-grip \{ position: absolute; left: -8px;/, "grip sits in the row's left padding, clear of the 16px chevron");
  assert.ok(!/boring-project-row\.on\) \.boring-drag-grip/.test(block), "not shown on the selected row without hover");
  assert.ok(!/const toggleProject/.test(ade), "dead toggleProject removed");
  assert.match(ade, /activeTeamId === mainV\?\.team\.id \? o\[activeTeamId\] : o\[activeTeamId\] \?\? true/, "leaving a collapsed Main does not expand it");
  assert.match(ade, /boring-main-bust" src=\{bustUrl\("riffbot", theme\)\} alt="" width=\{24\} height=\{24\}/, "img attrs match the 24px CSS");
});

test("r1: phone project picker lists Main first, then teams.json order (no drag, no Move)", () => {
  const ph = src("PhoneCockpit.tsx");
  assert.match(ph, /import \{ orderViews \} from "\.\/projectOrder"/);
  assert.match(ph, /orderViews\(views\)\.map\(\(v\) =>/);
  assert.ok(!/projectOrder\.|Move up|boring-drag-grip/.test(ph));
  const views = [T("a"), T("b"), T("c", null, true)].map((team) => ({ team }));
  assert.deepEqual(po.orderViews(views).map((v) => v.team.id), ["c", "a", "b"]);
});

// MM1 (@ui-bois): Main project pin marker, skip-if-absent + reduced motion (src/MainMarker.tsx + MainMarker.css).
test("MM1 main marker renders nothing until the sheet loads, decorative, blink contract", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const root = resolve(import.meta.dirname, "..");
  const tsx = readFileSync(resolve(root, "src", "MainMarker.tsx"), "utf8");
  const ade = readFileSync(resolve(root, "src", "BoringAde.tsx"), "utf8");
  const css = readFileSync(resolve(root, "src", "MainMarker.css"), "utf8");
  assert.match(tsx, /const ok = useImageOk\(sheet\);\s*if \(!ok\) return null;/);
  assert.match(tsx, /aria-hidden="true"/);
  assert.match(ade, /\{isMain && <MainMarker \/>\}/);
  assert.match(css, /\.boring-main-marker \{[^}]*background-size: 300% 100%[^}]*image-rendering: pixelated[^}]*animation: main-marker-blink 4s/);
  assert.match(css, /@keyframes main-marker-blink \{[^@]*50% 0[^@]*100% 0/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{[^}]*\.boring-main-marker \{ animation: none; \}/);
});

test("MM1 mainMarkerSheetSrc picks the theme and the 1x/2x sheet by device px", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const dir = mkdtempSync(join(tmpdir(), "mm1-"));
  const code = transformSync("MainMarker.tsx", readFileSync(join(root, "src", "MainMarker.tsx"), "utf8"), { lang: "tsx", jsx: { runtime: "classic" } }).code
    .replace(/import "\.\/MainMarker\.css";/, "")
    .replace(/from "\.\/pins"/, 'from "./pins.mjs"').replace(/from "\.\/uiScale"/, 'from "./uiScale.mjs"').replace(/from "\.\/useBotFace"/, 'from "./useBotFace.mjs"');
  writeFileSync(join(dir, "MainMarker.mjs"), code);
  writeFileSync(join(dir, "pins.mjs"), 'export function integerSheetSrc(base, devicePx = 32) { return Math.round(devicePx) % 32 === 0 ? `${base}@2x.png` : `${base}.png`; }');
  writeFileSync(join(dir, "uiScale.mjs"), "export const snapDeviceSize = () => ({ device: 16, css: 16 }); export const useUiScale = () => 1;");
  writeFileSync(join(dir, "useBotFace.mjs"), 'export const useDpr = () => 1; export const useImageOk = () => false; export const useTheme = () => "dark";');
  const { mainMarkerSheetSrc } = await import(pathToFileURL(join(dir, "MainMarker.mjs")).href);
  assert.equal(mainMarkerSheetSrc("dark", 16), "/ui/main-marker-dark.png");
  assert.equal(mainMarkerSheetSrc("light", 16), "/ui/main-marker-light.png");
  assert.equal(mainMarkerSheetSrc("dark", 32), "/ui/main-marker-dark@2x.png");
  assert.equal(mainMarkerSheetSrc("light", 32), "/ui/main-marker-light@2x.png");
});
