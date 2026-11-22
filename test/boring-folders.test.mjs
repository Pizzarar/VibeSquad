// B11b: Normal-mode sidebar project folders (docs/PLAN_BORING_MODE_B10.md).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { transformSync } from "rolldown/utils";

const dir = mkdtempSync(join(tmpdir(), "vs-b11b-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const read = (f) => readFileSync(resolve(import.meta.dirname, "..", "src", f), "utf8");
writeFileSync(join(dir, "teams.mjs"), `
export const isTeamAsleep = (team, cfg) => !!(cfg.folders || []).find((f) => f.name === team.folder)?.asleep;
export const refreshTeams = async () => { globalThis.__refreshed = (globalThis.__refreshed ?? 0) + 1; return true; };`);
writeFileSync(join(dir, "boringFolders.mjs"), transformSync("boringFolders.ts", read("boringFolders.ts"), { lang: "ts" }).code.replace("./teams.ts", "./teams.mjs"));
const F = await import(pathToFileURL(join(dir, "boringFolders.mjs")).href);

const view = (id, folder) => ({ team: { id, name: id, folder, lanes: [] }, members: [] });
const folders = [{ name: "Backlog", asleep: true }, { name: "Ideas", asleep: false }];
const views = [view("a"), view("b", "Backlog"), view("c", "Ghost"), view("d", "Ideas"), view("e", "Backlog")];

test("partitionViews: unfoldered + unknown-folder projects stay active, folders keep order", () => {
  const stat = (v) => ({ needsYou: v.team.id === "b" ? 2 : v.team.id === "e" ? 1 : 0, err: v.team.id === "e" });
  const { activeViews, folderGroups } = F.partitionViews(views, folders, stat);
  assert.deepEqual(activeViews.map((v) => v.team.id), ["a", "c"]);
  assert.deepEqual(folderGroups.map((g) => g.folder.name), ["Backlog", "Ideas"]);
  assert.equal(folderGroups[0].count, 2);
  assert.equal(folderGroups[0].needsYou, 3);
  assert.equal(folderGroups[0].err, true);
  assert.equal(folderGroups[1].needsYou, 0);
});

test("isViewAsleep / filterAwakeViews drop asleep-folder projects only", () => {
  assert.equal(F.isViewAsleep(views[1], folders), true);
  assert.equal(F.isViewAsleep(views[2], folders), false);
  assert.deepEqual(F.filterAwakeViews(views, folders).map((v) => v.team.id), ["a", "c", "d"]);
});

test("R11 fixes (source): Ctrl+J skips asleep projects, honest Wake label, muted badge, a11y, open-folder migration", () => {
  const app = read("App.tsx");
  const ade = read("BoringAde.tsx");
  const css = read("boring.css");
  // Ctrl+J target = top of the awake-only list: asleep projects are filtered out first.
  assert.match(app, /topNeedsYouId\(filterAwakeViews\(derived\(\)\.views, getFolders\(\)\)/);
  assert.deepEqual(F.filterAwakeViews(views, folders).map((v) => v.team.id).filter((id) => id === "b" || id === "e"), []);
  assert.match(ade, /Wake project/);
  assert.match(ade, /op: "setTeamFolder", teamId: view\.team\.id, folder: null/);
  assert.match(ade, /aria-label=\{`Sleep \$\{g\.folder\.name\}`\} aria-pressed=\{asleep\}/);
  assert.match(ade, /migrateOpenFolder\(f\.name, n\)/);
  assert.match(ade, /migrateOpenFolder\(f\.name\)/);
  assert.ok(!/\.boring-badge\.muted \{[^}]*opacity/.test(css));
  assert.match(css, /\.boring-badge\.muted \{[^}]*background: transparent[^}]*border: 1px solid var\(--border\)/);
  assert.match(css, /\[data-theme="light"\] \.boring-badge:not\(\.muted\) \{ color: #ffffff !important/);
});

test("R11-6/R11-2 (source): light .err badge stays red; muted folder badge drops legacy .badge", () => {
  const css = read("boring.css");
  const ade = read("BoringAde.tsx");
  assert.match(css, /\[data-theme="light"\] \.boring-badge:not\(\.muted\):not\(\.err\) \{ background: #8a5700/);
  assert.match(css, /\.boring-badge\.err \{ background: var\(--st-err\)/);
  assert.doesNotMatch(css, /\.boring-badge:not\(\.muted\) \{ background: #8a5700/);
  assert.match(ade, /asleep \? `boring-badge\$\{g\.err \? " err" : ""\} muted` : `badge boring-badge/);
});

test("folderSlug", () => assert.equal(F.folderSlug("Back log!"), "back-log"));

test("patchTeamsFolder PATCHes /api/teams and refreshes; surfaces server errors", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init]); return calls.length === 1 ? { ok: true, json: async () => ({}) } : { ok: false, status: 409, json: async () => ({ error: "conflict" }) }; };
  const ok = await F.patchTeamsFolder({ op: "setFolderAsleep", name: "Backlog", asleep: false }, "r1");
  assert.equal(ok.ok, true);
  assert.equal(calls[0][0], "/api/teams");
  assert.equal(calls[0][1].method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0][1].body), { op: "setFolderAsleep", name: "Backlog", asleep: false, revision: "r1" });
  assert.equal(globalThis.__refreshed, 1);
  const bad = await F.patchTeamsFolder({ op: "deleteFolder", name: "x" });
  assert.deepEqual(bad, { ok: false, error: "conflict" });
});

test("sidebar wiring (source): folder rows, toggle, asleep bar, awake-only inbox, menu items, R10 polish", () => {
  const ade = read("BoringAde.tsx");
  const pal = read("CommandPalette.tsx");
  const app = read("App.tsx");
  const css = read("boring.css");
  assert.match(ade, /boring-folder-row-\$\{slug\}/);
  assert.match(ade, /boring-folder-sleep-\$\{slug\}/);
  assert.match(ade, /vs\.boringOpenFolders/);
  assert.match(ade, /openFolders\[g\.folder\.name\] === true/); // collapsed by default
  assert.match(ade, /💤/);
  assert.match(ade, /Rename folder…/);
  assert.match(ade, /Delete folder/);
  assert.match(ade, /<BoringInbox views=\{awakeViews\}/);
  assert.match(ade, /boring-asleep-bar/);
  assert.match(ade, /boring-asleep-wake-btn/);
  assert.match(ade, /Asleep · Automated wake-ups paused/);
  assert.ok(ade.indexOf("partition.activeViews.map(renderProject)") < ade.indexOf("partition.folderGroups.map"));
  assert.match(pal, /Move to \$\{f\.name\}/);
  assert.match(pal, /Remove from folder/);
  assert.match(pal, /New folder…/);
  assert.match(app, /useAttentionTitle\(filterAwakeViews\(/);
  assert.match(app, /folders=\{getFolders\(\)\}/);
  assert.match(ade, /className="boring-row-label" title=/);
  assert.match(css, /\.boring-project-block \{[^}]*padding-inline: 9px/);
  const added = css.slice(css.indexOf("B11b: sidebar project folders"));
  assert.ok(!/!important|@media/.test(added.slice(0, 3000)));
  assert.ok(!/Hypnospace/.test(ade.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")));
});

function withStore(fn) {
  const m = new Map();
  const prev = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
  try { fn(m); } finally { if (prev === undefined) delete globalThis.localStorage; else globalThis.localStorage = prev; }
}

test("B11d lastFolder helpers: set/get/clear, rename, delete, corrupt JSON, no localStorage", () => {
  assert.equal(F.LAST_FOLDER_KEY, "vs.boringLastFolder");
  assert.equal(F.getLastFolder("a"), undefined);
  F.setLastFolder("a", "x");
  withStore((m) => {
    assert.equal(F.getLastFolder("a"), undefined);
    F.setLastFolder("a", "Backlog");
    F.setLastFolder("b", "Backlog");
    F.setLastFolder("c", "Ideas");
    assert.equal(F.getLastFolder("a"), "Backlog");
    F.migrateLastFolder("Backlog", "Later");
    assert.equal(F.getLastFolder("a"), "Later");
    assert.equal(F.getLastFolder("b"), "Later");
    assert.equal(F.getLastFolder("c"), "Ideas");
    F.migrateLastFolder("Later");
    assert.equal(F.getLastFolder("a"), undefined);
    assert.equal(F.getLastFolder("c"), "Ideas");
    F.setLastFolder("c", null);
    assert.equal(F.getLastFolder("c"), undefined);
    m.set("vs.boringLastFolder", "{not json");
    assert.equal(F.getLastFolder("a"), undefined);
    F.setLastFolder("a", "Z");
    assert.equal(F.getLastFolder("a"), "Z");
    m.set("vs.boringLastFolder", "[1]");
    assert.equal(F.getLastFolder("a"), undefined);
  });
});

test("B11d (source): Back to <lastFolder>, Remove/Wake remember folder, R11-5/R11-7 CSS", () => {
  const cp = read("CommandPalette.tsx");
  const ade = read("BoringAde.tsx");
  const css = read("boring.css");
  assert.match(cp, /getLastFolder\(view\.team\.id\)/);
  assert.match(cp, /label: `Back to \$\{back\}`/);
  assert.match(cp, /f\.name !== back/);
  assert.match(cp, /if \(r\.ok\) setLastFolder\(view\.team\.id, cur\)/);
  assert.match(cp, /if \(r\.ok\) setLastFolder\(view\.team\.id, null\)/);
  assert.match(ade, /setLastFolder\(view\.team\.id, prev \?\? null\)/);
  assert.match(ade, /migrateLastFolder\(f\.name, n\)/);
  assert.match(ade, /migrateLastFolder\(f\.name\)/);
  assert.ok(!/\.boring-folder\.asleep \.boring-folder-projects \{[^}]*opacity/.test(css));
  assert.match(css, /\.boring-folder\.asleep \.boring-folder-projects \.boring-project-name \{ color: var\(--text-2\)/);
  assert.match(ade, /boring-folder-dot-spacer/);
  assert.match(css, /\.boring-folder-dot-spacer \{ width: 8px/);
});
