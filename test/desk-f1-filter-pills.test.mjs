// @desk F1 (docs/PLAN_DESK_DD_FILTER.md): unit tests for Decision Desk project filter pills.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { transformSync } from "rolldown/utils";

const ROOT = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "vs-desk-f1-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const readSrc = (name) => readFileSync(join(ROOT, "src", name), "utf8");
writeFileSync(
  join(dir, "teams.mjs"),
  `export const isTeamAsleep = (team, cfg) => Boolean((cfg.folders || []).find((f) => f.name === team.folder)?.asleep);
export const refreshTeams = async () => true;`,
);
writeFileSync(
  join(dir, "boringFolders.mjs"),
  transformSync("boringFolders.ts", readSrc("boringFolders.ts"), { lang: "ts" }).code.replace("./teams.ts", "./teams.mjs"),
);
writeFileSync(
  join(dir, "decisionFilter.mjs"),
  transformSync("decisionFilter.ts", readSrc("decisionFilter.ts"), { lang: "ts" }).code.replace(/from "\.\/(\w+)"/g, (_m, n) => `from "./${n}.mjs"`),
);

const F = await import(pathToFileURL(join(dir, "decisionFilter.mjs")).href);

const makeView = (id, name, folder) => ({ team: { id, name, folder, lanes: [] }, members: [] });
const makeStorage = () => {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
};

const FOLDERS = [
  { name: "ActiveWork", asleep: false },
  { name: "Backlog", asleep: true },
];

const VIEWS = [
  makeView("vs", "VibeSquad", undefined),
  makeView("efi", "Main Game", "ActiveWork"),
  makeView("site", "Site", undefined),
  makeView("forework", "Forework", "Backlog"),
  makeView("sbb", "SBB", "Backlog"),
  makeView("quiet-sleep", "Quiet Hold", "Backlog"),
];

const ITEMS = [
  { id: "d1", squad: "vs", squadName: "VibeSquad", kind: "yesno", lean: "Go" },
  { id: "d2", squad: "vs", squadName: "VibeSquad", kind: "offscreen" },
  { id: "d3", squad: "efi", squadName: "Main Game", kind: "answer" },
  { id: "d4", squad: "forework", squadName: "Forework", kind: "yesno", lean: "Hold" },
  { id: "d5", squad: "sbb", squadName: "SBB", kind: "offscreen" },
];

test("F1 defaults: follow asleep folders (awake ON, asleep with open items OFF in onHold, asleep with 0 items omitted)", () => {
  const pills = F.buildDecisionPills(VIEWS, FOLDERS, ITEMS, {});
  assert.deepEqual(
    pills.awake.map((p) => [p.squadId, p.openCount, p.asleep, p.active]),
    [
      ["vs", 2, false, true],
      ["efi", 1, false, true],
      ["site", 0, false, true],
    ],
  );
  assert.deepEqual(
    pills.onHold.map((p) => [p.squadId, p.openCount, p.asleep, p.active]),
    [
      ["forework", 1, true, false],
      ["sbb", 1, true, false],
    ],
  );
  assert.equal(pills.all.some((p) => p.squadId === "quiet-sleep"), false, "asleep project with 0 open items gets no pill");
  assert.deepEqual(F.decisionFilterPresetState(pills.all), { isActivePreset: true, isAllPreset: false });
});

test("F1 persistence: explicit overrides persist across reload and clear cleanly", () => {
  const st = makeStorage();
  assert.equal(F.DECISION_FILTER_KEY, "vs.decisionFilterOverrides");
  assert.deepEqual(F.readDecisionFilterOverrides(st), {});

  let ov = F.toggleDecisionPill({}, "efi", false); // awake -> OFF
  ov = F.toggleDecisionPill(ov, "forework", true); // asleep -> ON
  assert.deepEqual(ov, { efi: false, forework: true });
  F.writeDecisionFilterOverrides(ov, st);

  // Simulate reload
  const reloaded = F.readDecisionFilterOverrides(st);
  assert.deepEqual(reloaded, { efi: false, forework: true });
  const pills = F.buildDecisionPills(VIEWS, FOLDERS, ITEMS, reloaded);
  assert.deepEqual([...F.visibleSquadIds(pills.all)], ["vs", "site", "forework"]);

  // Toggling back to defaults removes overrides and removes storage key
  ov = F.toggleDecisionPill(reloaded, "efi", false);
  ov = F.toggleDecisionPill(ov, "forework", true);
  assert.deepEqual(ov, {});
  F.writeDecisionFilterOverrides(ov, st);
  assert.equal(st.map.has(F.DECISION_FILTER_KEY), false);

  // Corrupt JSON fails closed to empty overrides
  st.setItem(F.DECISION_FILTER_KEY, "{not-json");
  assert.deepEqual(F.readDecisionFilterOverrides(st), {});
});

test("F1 dynamic folder changes: newly awakened project defaults ON, newly asleep project defaults OFF", () => {
  // User only overrode "vs" OFF; "forework" and "site" have no override.
  const ov = F.toggleDecisionPill({}, "vs", false);
  const movedViews = VIEWS.map((v) =>
    v.team.id === "forework"
      ? makeView("forework", "Forework", undefined) // awakened
      : v.team.id === "site"
        ? makeView("site", "Site", "Backlog") // put to sleep (has 0 items)
        : v,
  );
  const pills = F.buildDecisionPills(movedViews, FOLDERS, ITEMS, ov);
  const fw = pills.all.find((p) => p.squadId === "forework");
  assert.equal(fw?.asleep, false);
  assert.equal(fw?.active, true, "newly awakened project with no override defaults ON");
  assert.equal(pills.all.find((p) => p.squadId === "vs")?.active, false, "explicit override preserved");
  assert.equal(pills.all.some((p) => p.squadId === "site"), false, "newly asleep project with 0 items drops out");

  // If "efi" (which has 1 item) is moved to Backlog with no override, it defaults OFF in onHold
  const efiAsleepViews = VIEWS.map((v) => (v.team.id === "efi" ? makeView("efi", "Main Game", "Backlog") : v));
  const pills2 = F.buildDecisionPills(efiAsleepViews, FOLDERS, ITEMS, {});
  const efi = pills2.onHold.find((p) => p.squadId === "efi");
  assert.equal(efi?.asleep, true);
  assert.equal(efi?.active, false, "newly asleep project with no override defaults OFF");
});

test("F1 presets: Active clears overrides; All shows every pill and stores overrides only for asleep projects", () => {
  const initial = F.buildDecisionPills(VIEWS, FOLDERS, ITEMS, {});
  const allOv = F.applyAllPreset(initial.all);
  assert.deepEqual(allOv, { forework: true, sbb: true });
  const allPills = F.buildDecisionPills(VIEWS, FOLDERS, ITEMS, allOv);
  assert.deepEqual(F.decisionFilterPresetState(allPills.all), { isActivePreset: false, isAllPreset: true });
  assert.deepEqual([...F.visibleSquadIds(allPills.all)], ["vs", "efi", "site", "forework", "sbb"]);

  const activeOv = F.applyActivePreset();
  assert.deepEqual(activeOv, {});
  const activePills = F.buildDecisionPills(VIEWS, FOLDERS, ITEMS, activeOv);
  assert.deepEqual(F.decisionFilterPresetState(activePills.all), { isActivePreset: true, isAllPreset: false });
  assert.deepEqual([...F.visibleSquadIds(activePills.all)], ["vs", "efi", "site"]);
});

test("F1 filtering + staged answers: covers feed/offscreen/rail; staged survive toggles; Send counts only visible", () => {
  const staged = {
    d1: { choice: "lean" },
    d3: { choice: "reply", text: " 42 " },
    d4: { choice: "alt:0" },
    d5: { choice: "reply", text: "   " }, // blank reply is not sendable
  };

  // Default Active: vs, efi, site visible; forework, sbb hidden
  const activePills = F.buildDecisionPills(VIEWS, FOLDERS, ITEMS, {});
  const vis1 = F.visibleSquadIds(activePills.all);
  assert.deepEqual(F.filterDecisionItems(ITEMS, vis1).map((i) => i.id), ["d1", "d2", "d3"]);
  assert.deepEqual(
    F.filterStatusGroups([{ squadId: "vs" }, { squadId: "forework" }, { squadId: "efi" }], vis1).map((g) => g.squadId),
    ["vs", "efi"],
  );
  assert.equal(F.countHiddenStaged(ITEMS, vis1, staged), 1, "only d4 is a sendable hidden staged answer (d5 is blank)");

  // Hide efi: d3 becomes hidden too (staged map untouched)
  const ov2 = F.toggleDecisionPill({}, "efi", false);
  const vis2 = F.visibleSquadIds(F.buildDecisionPills(VIEWS, FOLDERS, ITEMS, ov2).all);
  assert.deepEqual(F.filterDecisionItems(ITEMS, vis2).map((i) => i.id), ["d1", "d2"]);
  assert.equal(F.countHiddenStaged(ITEMS, vis2, staged), 2, "d3 and d4 are both hidden now");

  // Unhide efi + forework: staged answers are still intact and hidden count drops to 0
  let ov3 = F.toggleDecisionPill(ov2, "efi", false);
  ov3 = F.toggleDecisionPill(ov3, "forework", true);
  const vis3 = F.visibleSquadIds(F.buildDecisionPills(VIEWS, FOLDERS, ITEMS, ov3).all);
  assert.equal(F.countHiddenStaged(ITEMS, vis3, staged), 0);
  assert.deepEqual(staged.d3, { choice: "reply", text: " 42 " });
  assert.deepEqual(staged.d4, { choice: "alt:0" });
});

test("F1 visible count (UX R45 M1): badge count matches filtered page count by default, with overrides, and when only on-hold projects have items", () => {
  // Default Active: vs (2) + efi (1) = 3 visible; forework (1) + sbb (1) hidden
  assert.equal(F.countVisibleDecisions(VIEWS, FOLDERS, ITEMS, {}), 3);

  // Explicit overrides: efi OFF, forework ON -> vs (2) + forework (1) = 3
  assert.equal(F.countVisibleDecisions(VIEWS, FOLDERS, ITEMS, { efi: false, forework: true }), 3);

  // All preset -> all 5 items visible
  const allOv = F.applyAllPreset(F.buildDecisionPills(VIEWS, FOLDERS, ITEMS, {}).all);
  assert.equal(F.countVisibleDecisions(VIEWS, FOLDERS, ITEMS, allOv), 5);

  // Only on-hold (asleep) projects have items -> default count is 0, All preset count is 2
  const onHoldOnly = ITEMS.filter((i) => i.squad === "forework" || i.squad === "sbb");
  assert.equal(F.countVisibleDecisions(VIEWS, FOLDERS, onHoldOnly, {}), 0);
  const allOnHold = F.applyAllPreset(F.buildDecisionPills(VIEWS, FOLDERS, onHoldOnly, {}).all);
  assert.equal(F.countVisibleDecisions(VIEWS, FOLDERS, onHoldOnly, allOnHold), 2);
});

test("F1 source contracts: BoringAde passes allViews+folders, CSS scoped to .boring-decision-pill*, no @media/@container, leans stay opt-in", () => {
  const ade = readSrc("BoringAde.tsx");
  const dd = readSrc("BoringDecisionDesk.tsx");
  const css = readSrc("boring.css");
  assert.match(ade, /useDecisionCount\(allViews, folders\)/);
  assert.match(ade, /<BoringDecisionDesk views=\{allViews\} folders=\{folders\}/);
  assert.match(dd, /export const DECISION_LEANS_OPT_IN = true;/);
  assert.match(dd, /data-testid="boring-decision-pills"/);
  assert.match(dd, /data-testid="boring-decision-preset-active"/);
  assert.match(dd, /data-testid="boring-decision-preset-all"/);
  assert.match(dd, /data-testid="boring-decision-pills-on-hold"/);
  assert.match(dd, /data-testid="boring-decision-empty-show-all"/);
  assert.match(dd, />Asleep<\/span>/);
  assert.match(dd, /aria-label=\{hiddenCount > 0 \? `\$\{p\.squadName\}, \$\{p\.openCount\} open, \$\{hiddenCount\} staged hidden` : `\$\{p\.squadName\}, \$\{p\.openCount\} open`\}/);
  assert.match(dd, /hiddenStagedLabel\.suffix/);
  assert.match(dd, /data-testid=\{`boring-decision-pill-staged-dot-\$\{p\.squadId\}`\}/);

  const f1Start = css.indexOf("/* @desk F1 (PLAN_DESK_DD_FILTER)");
  assert.ok(f1Start > 0, "F1 CSS block present");
  const f1Css = css.slice(f1Start);
  assert.doesNotMatch(f1Css, /@(media|container)\b/, "no @media/@container in F1 CSS");
  for (const line of f1Css.split("\n").filter((l) => /\{/.test(l))) {
    assert.match(line, /^html\[data-vibe="boring"\] \.boring-decision-pill/, `scoped to .boring-decision-pill*: ${line}`);
  }
});

test("S2 idea-1121: summarizeHiddenStaged + formatHiddenStagedLabel name hidden projects, cap inline list, and keep full list in title", () => {
  const pills = [
    { squadId: "alpha", squadName: "Alpha" },
    { squadId: "beta", squadName: "Beta" },
    { squadId: "gamma", squadName: "Gamma" },
    { squadId: "delta", squadName: "Delta" },
  ];
  const items = [
    { id: "i1", squad: "alpha", squadName: "Alpha" },
    { id: "i2", squad: "beta", squadName: "Beta" },
    { id: "i3", squad: "gamma", squadName: "Gamma" },
    { id: "i4", squad: "delta", squadName: "Delta" },
    { id: "i5", squad: "delta", squadName: "Delta" },
  ];
  const staged = {
    i1: { choice: "lean" },
    i2: { choice: "alt:0" },
    i3: { choice: "reply", text: "ok" },
    i4: { choice: "reply", text: "   " }, // blank reply not sendable
    i5: { choice: "dismiss" },
  };

  // All visible -> empty
  const none = F.summarizeHiddenStaged(items, new Set(["alpha", "beta", "gamma", "delta"]), staged, pills);
  assert.equal(none.total, 0);
  assert.deepEqual(F.formatHiddenStagedLabel(none), { suffix: "", title: "" });

  // 1 hidden project (beta)
  const one = F.summarizeHiddenStaged(items, new Set(["alpha", "gamma", "delta"]), staged, pills);
  assert.equal(one.total, 1);
  assert.deepEqual(one.bySquad, { beta: 1 });
  assert.deepEqual(F.formatHiddenStagedLabel(one), {
    suffix: " · +1 hidden (Beta)",
    title: "1 staged answer hidden in: Beta",
  });

  // 2 hidden projects (beta, gamma)
  const two = F.summarizeHiddenStaged(items, new Set(["alpha", "delta"]), staged, pills);
  assert.equal(two.total, 2);
  assert.deepEqual(two.bySquad, { beta: 1, gamma: 1 });
  assert.deepEqual(F.formatHiddenStagedLabel(two), {
    suffix: " · +2 hidden (Beta, Gamma)",
    title: "2 staged answers hidden in: Beta, Gamma",
  });

  // 3 hidden projects (beta, gamma, delta): inline caps at 2 + "+1 more", title keeps full list
  const three = F.summarizeHiddenStaged(items, new Set(["alpha"]), staged, pills);
  assert.equal(three.total, 3);
  assert.deepEqual(three.bySquad, { beta: 1, gamma: 1, delta: 1 });
  assert.deepEqual(F.formatHiddenStagedLabel(three), {
    suffix: " · +3 hidden (Beta, Gamma, +1 more)",
    title: "3 staged answers hidden in: Beta, Gamma, Delta",
  });
});
