import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { transformSync } from "rolldown/utils";
import { efiAdapter, renderTemplates } from "../server/storybook/adapters/efi.mjs";

const L = await import("../src/storybookLogic.ts");
const R = await import("../src/storybookReview.ts");
const snap = JSON.parse(readFileSync(new URL("./fixtures/storybook/efi-mini.json", import.meta.url), "utf8"));
const idx = L.indexEntities(snap.entities);

test("#18 maps to toolong; #8 code comments are Dev TODOs, not Problems", () => {
  assert.equal(L.findingCategory("#18"), "toolong");
  const mk = (check, entityRef) => ({ check, severity: "info", entityRef, msg: "m", source: null });
  const items = L.buildListItems({ entities: [], findings: [mk("#8", null), mk("#8", { kind: "line", id: "x" }), mk("#18", { kind: "line", id: "y" }), mk("#1", null)] });
  const c = L.scopeCounts(items);
  assert.equal(c.dev, 1); assert.equal(c.toolong, 1);
  // V6 badge fix: an entity #8 STORY-TODO (and #15 no-story) is Coverage, not a Problem
  assert.equal(c.coverage, 1); assert.equal(c.problems, 1);
  assert.equal(L.problemCount(items), 1);
  assert.deepEqual(L.scopeItems(items, "coverage").map((i) => i.check), ["#8"]);
  const i15 = L.buildListItems({ entities: [], findings: [mk("#15", { kind: "item", id: "z" }), mk("#4", null)] });
  assert.deepEqual([L.scopeCounts(i15).coverage, L.problemCount(i15), L.scopeCounts(i15).story], [1, 1, 1]);
  // W4: Problems = broken + story ONLY. #11 (lexical title-vs-task), #7 info, #3 doc drift / #14 orphan / #6 #9 #10 go to Other checks, never the badge.
  const mixed = L.buildListItems({ entities: [], findings: [mk("#1", null), mk("#13", null), mk("#4", null), mk("#11", null), mk("#3", null), mk("#14", { kind: "item", id: "o" }), mk("#6", null), mk("#9", null), mk("#10", null), mk("#8", null), mk("#18", null), mk("#15", { kind: "item", id: "q" })] });
  const mc = L.scopeCounts(mixed);
  assert.deepEqual([mc.problems, mc.story, mc.other, mc.coverage, mc.dev, mc.toolong], [3, 1, 6, 1, 1, 1]);
  assert.equal(L.problemCount(mixed), 3);
  assert.deepEqual(L.scopeItems(mixed, "problems").map((i) => i.check), ["#1", "#13", "#4"]);
  assert.deepEqual(L.scopeItems(mixed, "other").map((i) => i.check), ["#11", "#3", "#14", "#6", "#9", "#10"]);
});

test("rows: story first, full text (never truncated), contracts rendered with real names", () => {
  const rows = R.buildReviewRows(snap.entities, idx, []);
  assert.ok(rows.length > 0);
  const blocks = R.groupRows(rows);
  assert.equal(blocks[0].cls, "story");
  const c = rows.find((r) => r.kind === "contract");
  assert.ok(c && c.title && !/undefined|null/.test(c.title), c?.title);
  assert.equal(c.keyPath, c.entityId);
  const longText = "A".repeat(500);
  const longLine = { id: "long_1", kind: "line", display: "short", aliases: [], source: { path: "data/questlines.json", line: 9 }, links: [], production: null, data: { text: longText, rowClass: "story", speakerKind: "narrator", speakerId: "narrator" } };
  const built = R.buildReviewRows([longLine], L.indexEntities([longLine]), []);
  assert.equal(built.length, 1);
  assert.equal(built[0].text, longText);
  assert.equal(built[0].text.length, 500);
});

test("tooLongReason handles chars, sentences, owner_rewrite and never emits 'too long'", () => {
  assert.equal(R.tooLongReason('too long: text is 98 chars (default toast cap 90): "abc…"'), "98 chars, default toast cap 90");
  assert.equal(R.tooLongReason('too long: text is 4 sentences (pinned budget 3): "One. Two. Three. Four."'), "4 sentences, pinned budget 3");
  assert.equal(R.tooLongReason('too long: owner_rewrite is 5 sentences (pinned budget 3): "One…"'), "rewrite 5 sentences, pinned budget 3");
  assert.equal(R.tooLongReason('too long: owner_rewrite is 110 chars (default button cap 40): "Click…"'), "rewrite 110 chars, default button cap 40");
  assert.notEqual(R.tooLongReason("too long").toLowerCase(), "too long");
  assert.notEqual(R.tooLongReason("").toLowerCase(), "too long");
  const line = snap.entities.find((e) => e.kind === "line");
  const items = L.buildListItems({ entities: [line], findings: [{ check: "#18", severity: "warn", entityRef: { kind: "line", id: line.id }, msg: 'too long: owner_rewrite is 4 sentences (pinned budget 2): "a. b. c. d."', source: null }] });
  const rows = R.buildReviewRows([line], L.indexEntities([line]), items);
  assert.equal(rows[0].tooLong, "rewrite 4 sentences, pinned budget 2");
});

test("search covers text, speaker, key and file; entities found by name", () => {
  const rows = R.buildReviewRows(snap.entities, idx, []);
  const f = (q) => R.filterRows(rows, { ...R.NO_FILTER, query: q });
  const r0 = rows[0];
  assert.ok(f(r0.speaker || r0.keyPath).includes(r0));
  assert.ok(f(r0.file).length > 0);
  assert.equal(f("zzqqxx-nomatch").length, 0);
  assert.ok(R.searchEntities(idx, "doc").some((e) => e.id === "doc"));
});

test("renderTemplates fills every contract type and uses mastery.families display names", async () => {
  const families = { smg: "SMG", assault: "Assault Rifle", marksman: "Marksman Rifle", heavy: "Heavy Rifle", lmg: "LMG", pistol: "Pistol" };
  const ents = [
    { kind: "trader", id: "popper", display: "Popper" }, { kind: "item", id: "scrap", display: "Scrap Metal" }, { kind: "enemy", id: "scav", display: "Scav" }, { kind: "location", id: "harbor", display: "Harbor" },
    ...[["deliver", { item: "scrap", qty_min: 2, qty_max: 5 }], ["kill", { enemy: "scav", qty_min: 3, qty_max: 3 }], ["pack", { enemy: "scav", qty_min: 1, qty_max: 2 }], ["mastery", { family: "smg", qty_min: 1, qty_max: 2 }], ["extract", { location: "harbor", qty_min: 2, qty_max: 4 }]]
      .map(([type, x]) => ({ kind: "contract", id: `c_${type}`, display: `c_${type}`, data: { type, trader: "popper", ...x } })),
    ...["assault", "marksman", "heavy", "lmg", "beam_rifle"].map((family) => ({ kind: "contract", id: `m_${family}`, display: `m_${family}`, data: { type: "mastery", trader: "popper", family } })),
  ];
  const m = renderTemplates(ents, families);
  assert.equal(m.get("c_deliver").title, "Deliver 2–5 × Scrap Metal for Popper");
  assert.equal(m.get("c_kill").title, "Eliminate 3 × Scav for Popper");
  assert.equal(m.get("c_pack").title, "Wipe 1–2 × Scav packs for Popper");
  assert.equal(m.get("c_mastery").title, "SMG practice for Popper");
  assert.equal(m.get("m_assault").title, "Assault Rifle practice for Popper");
  assert.equal(m.get("m_marksman").title, "Marksman Rifle practice for Popper");
  assert.equal(m.get("m_heavy").title, "Heavy Rifle practice for Popper");
  assert.equal(m.get("m_lmg").title, "LMG practice for Popper");
  assert.equal(m.get("m_beam_rifle").title, "Beam rifle practice for Popper");
  assert.equal(m.get("c_extract").title, "Extract from Harbor 2–4 times for Popper");
  // fallback when families map is omitted
  assert.equal(renderTemplates(ents).get("c_mastery").title, "Smg practice for Popper");

  // end-to-end: efiAdapter.load passes data/skills.json mastery.families into rendered contracts
  const files = new Map([
    ["data/traders.json", JSON.stringify({ traders: { popper: { display_name: "Popper" } } })],
    ["data/skills.json", JSON.stringify({ skills: {}, mastery: { families } })],
    ["data/contracts.json", JSON.stringify({ templates: [{ id: "m_smg", trader: "popper", type: "mastery", family: "smg", reward_per_1000_xp: 25 }] })],
  ]);
  const loaded = await efiAdapter.load({ sha: "abcdef12", exists: async () => false, listTree: async () => [], readFile: async (p) => files.get(p) ?? null }, "abcdef12");
  const mc = loaded.entities.find((e) => e.kind === "contract" && e.id === "m_smg");
  assert.equal(mc?.data?.rendered?.title, "SMG practice for Popper");
});

describe("StorybookText behavior: focus consumption & group collapse during search", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-sb-text-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const runtime = { inst: null };
  globalThis.__sbTextReact = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c != null && c !== false && c !== true) };
    },
    useState(init) {
      const inst = runtime.inst;
      const i = inst.cursor++;
      if (i >= inst.states.length) inst.states.push(typeof init === "function" ? init() : init);
      const set = (v) => { inst.states[i] = typeof v === "function" ? v(inst.states[i]) : v; };
      return [inst.states[i], set];
    },
    useMemo(fn) { return fn(); },
    useRef(v) {
      const inst = runtime.inst;
      const i = inst.cursor++;
      if (i >= inst.states.length) inst.states.push({ current: v });
      return inst.states[i];
    },
    useEffect(fn, deps) {
      const inst = runtime.inst;
      const i = inst.cursor++;
      const prev = inst.effects[i];
      const same = prev && deps && prev.deps?.length === deps.length && prev.deps.every((d, k) => Object.is(d, deps[k]));
      if (!same) inst.pending.push({ i, fn, deps });
    },
  };

  writeFileSync(
    join(dir, "react.mjs"),
    `export default { createElement: (...a) => globalThis.__sbTextReact.createElement(...a) };
export const useState = (...a) => globalThis.__sbTextReact.useState(...a);
export const useMemo = (...a) => globalThis.__sbTextReact.useMemo(...a);
export const useRef = (...a) => globalThis.__sbTextReact.useRef(...a);
export const useEffect = (...a) => globalThis.__sbTextReact.useEffect(...a);`,
  );
  const reviewUrl = pathToFileURL(join(process.cwd(), "src/storybookReview.ts")).href;
  const logicUrl = pathToFileURL(join(process.cwd(), "src/storybookLogic.ts")).href;
  const progressUrl = pathToFileURL(join(process.cwd(), "src/storybookProgress.ts")).href;
  const code = transformSync("StorybookText.tsx", readFileSync(new URL("../src/StorybookText.tsx", import.meta.url), "utf8"), { lang: "tsx", jsx: { runtime: "classic" } })
    .code.replace(/^/, `import React from "./react.mjs";\n`)
    .replace(/from "react"/g, `from "./react.mjs"`)
    .replace(/from "\.\/storybookReview"/g, `from "${reviewUrl}"`)
    .replace(/from "\.\/storybookLogic"/g, `from "${logicUrl}"`)
    .replace(/from "\.\/storybookProgress"/g, `from "${progressUrl}"`);
  writeFileSync(join(dir, "StorybookText.mjs"), code);

  let mod;
  const loadMod = async () => { if (!mod) mod = await import(pathToFileURL(join(dir, "StorybookText.mjs")).href); return mod; };
  const findAll = (node, pred, out = []) => {
    if (!node || typeof node !== "object") return out;
    if (pred(node)) out.push(node);
    for (const c of node.children ?? []) findAll(c, pred, out);
    return out;
  };
  const mount = (Comp) => {
    const inst = { states: [], effects: [], pending: [], cursor: 0 };
    const render = (props) => {
      inst.cursor = 0;
      inst.pending = [];
      runtime.inst = inst;
      let tree;
      try { tree = Comp(props); } finally { runtime.inst = null; }
      for (const eff of inst.pending) {
        if (typeof inst.effects[eff.i]?.cleanup === "function") inst.effects[eff.i].cleanup();
        inst.effects[eff.i] = { deps: eff.deps, cleanup: eff.fn() };
      }
      return tree;
    };
    return { render };
  };

  test("focus calls onFocusConsumed once; subsequent Refresh (new rows ref) with focus=null preserves search", async () => {
    const { StorybookText } = await loadMod();
    const rows = R.buildReviewRows(snap.entities, idx, []);
    const target = rows[0];
    let consumed = 0;
    let focus = { id: target.id, n: 1 };
    const onFocusConsumed = () => { consumed++; focus = null; };
    const m = mount(StorybookText);
    const props = (rs) => ({ rows: rs, idx, focus, onFocusConsumed, renderChip: (e, label) => label ?? e.display });

    m.render(props(rows));
    assert.equal(consumed, 1, "onFocusConsumed called once when focus consumed");
    assert.equal(focus, null, "parent cleared textFocus");

    // User types a search query; then Refresh supplies a new rows array while focus is null.
    const tree1 = m.render(props(rows));
    const search = findAll(tree1, (n) => n.props?.["data-testid"] === "sb-text-search")[0];
    search.props.onChange({ target: { value: "casings" } });
    const tree2 = m.render(props([...rows]));
    const searchAfterRefresh = findAll(tree2, (n) => n.props?.["data-testid"] === "sb-text-search")[0];
    assert.equal(searchAfterRefresh.props.value, "casings", "Refresh with cleared focus must not wipe search");
    assert.equal(consumed, 1, "onFocusConsumed not called again");

    // StorybookView wires onFocusConsumed to clear textFocus.
    const viewSrc = readFileSync(new URL("../src/StorybookView.tsx", import.meta.url), "utf8");
    assert.match(viewSrc, /clearTextFocus\s*=\s*useCallback\(\(\)\s*=>\s*setTextFocus\(null\),\s*\[\]\)/);
    assert.match(viewSrc, /<StorybookText[^>]*focus=\{textFocus\}[^>]*onFocusConsumed=\{clearTextFocus\}/);
  });

  test("V5 Quests 'Review row →' and V4 sheets '→ Review' open the V3 Review row via openReviewRow (setTextFocus + tab review)", () => {
    const viewSrc = readFileSync(new URL("../src/StorybookView.tsx", import.meta.url), "utf8");
    assert.match(viewSrc, /const openReviewRow = useCallback\(\(e: SbEntity\) => \{[\s\S]*?setTextFocus\(\{ id: entityKey\(e\.kind, e\.id\), n: Date\.now\(\) \}\);[\s\S]*?setTab\("review"\);/);
    assert.match(viewSrc, /<QuestsTab[^>]*onGo=\{goTo\}[^>]*openLine=\{openReviewRow\}/);
    assert.match(viewSrc, /<Locations[^>]*onReview=\{openReviewRow\}/);
    assert.match(viewSrc, /<Characters[^>]*onReview=\{openReviewRow\}/);
    assert.match(viewSrc, /<StorybookItems[^>]*onReview=\{openReviewRow\}/);
    // goTo for a line entity also focuses the V3 Review row
    assert.match(viewSrc, /if \(nav\.tab === "review"\) \{[\s\S]*?setTextFocus\(\{ id: entityKey\(e\.kind, e\.id\), n: Date\.now\(\) \}\);[\s\S]*?setTab\("review"\);/);
  });

  test("V1.1 polish: system:<screen> speakers display title-cased in entityCard, characterViews, and Review group headers", () => {
    const armoryLine = {
      id: "sys_armory_1", kind: "line", display: "Armory toast", aliases: [], source: { path: "scenes/armory/armory.gd", line: 10 },
      links: [], production: null, data: { text: "Weapon equipped.", rowClass: "ui", speakerKind: "system", speakerId: "armory", speaker: "armory", group: "armory" },
    };
    const hudLine = {
      id: "sys_hud_1", kind: "line", display: "HUD toast", aliases: [], source: { path: "scenes/raid_hud/hud.gd", line: 20 },
      links: [], production: null, data: { text: "Low ammo.", rowClass: "ui", speakerKind: "system", speakerId: "raid_hud" },
    };
    const localIdx = L.indexEntities([armoryLine, hudLine]);
    assert.equal(L.entityCard(armoryLine, localIdx).speaker, "Armory");
    assert.equal(L.entityCard(hudLine, localIdx).speaker, "Raid Hud");
    const chars = L.characterViews(localIdx);
    assert.equal(chars.find((c) => c.id === "system:armory")?.speaker, "Armory");
    assert.equal(chars.find((c) => c.id === "system:raid_hud")?.speaker, "Raid Hud");
    const built = R.buildReviewRows([armoryLine, hudLine], localIdx, []);
    assert.equal(built[0].speaker, "Armory");
    assert.equal(built[0].group, "Armory");
    assert.equal(built[1].speaker, "Raid Hud");
    assert.equal(built[1].group, "Raid Hud");
    const blocks = R.groupRows(built);
    assert.deepEqual(blocks[0].groups.map((g) => g.label), ["Armory", "Raid Hud"]);
  });

  test("group headers can be collapsed and re-expanded while searching or filtering (user toggle wins)", async () => {
    const { StorybookText } = await loadMod();
    const rows = R.buildReviewRows(snap.entities, idx, []);
    const m = mount(StorybookText);
    const props = { rows, idx, focus: null, renderChip: (e, label) => label ?? e.display };

    // Activate search so searching === true (groups default open).
    let tree = m.render(props);
    const search = findAll(tree, (n) => n.props?.["data-testid"] === "sb-text-search")[0];
    search.props.onChange({ target: { value: "popper" } });
    tree = m.render(props);

    const heads = findAll(tree, (n) => n.type === "button" && n.props?.className === "sb-tgroup-head");
    assert.ok(heads.length > 0, "matching groups rendered");
    assert.equal(heads[0].props["aria-expanded"], true, "group defaults open while searching");

    // Click the first group header to collapse it while searching is still active.
    heads[0].props.onClick();
    tree = m.render(props);
    const headsAfterCollapse = findAll(tree, (n) => n.type === "button" && n.props?.className === "sb-tgroup-head");
    assert.equal(headsAfterCollapse[0].props["aria-expanded"], false, "explicit collapse wins during search");

    // Click again to re-expand.
    headsAfterCollapse[0].props.onClick();
    tree = m.render(props);
    const headsAfterReopen = findAll(tree, (n) => n.type === "button" && n.props?.className === "sb-tgroup-head");
    assert.equal(headsAfterReopen[0].props["aria-expanded"], true, "explicit re-expand works during search");
  });

  test("W3 rider 4: search-aware chip counts, exact entity ranking, speaker filter, title-before-story, compact row", async () => {
    const { StorybookText } = await loadMod();
    // Exact entity ranking: Doc (display "Doc") ranks ahead of Saint (id "doc") and Documents
    const ents = [
      { id: "documents", kind: "item", display: "Documents", aliases: [], source: { path: "i.json", line: 1 }, links: [], production: null, data: {} },
      { id: "doc", kind: "squad", display: "Saint", aliases: ["doc"], source: { path: "s.json", line: 1 }, links: [], production: null, data: {} },
      { id: "doc", kind: "trader", display: "Doc", aliases: [], source: { path: "t.json", line: 1 }, links: [], production: null, data: {} },
      { id: "boss_dockmaster", kind: "enemy", display: "The Dockmaster", aliases: [], source: { path: "e.json", line: 1 }, links: [], production: null, data: {} },
    ];
    const localIdx = L.indexEntities(ents);
    const ranked = R.searchEntities(localIdx, "Doc");
    assert.deepEqual(ranked.map((e) => `${e.kind}:${e.id}`), ["trader:doc", "squad:doc", "item:documents", "enemy:boss_dockmaster"]);

    // Build rows with Doc story + title (story first in input), Saint line, and a UI line mentioning Doc
    const rawLines = [
      { id: "l_story", kind: "line", display: "s", aliases: [], source: { path: "data/questlines.json", line: 10 }, links: [{ rel: "spoken_by", kind: "trader", id: "doc" }], production: null, data: { text: "Doc story text.", rowClass: "story", speakerKind: "trader", speakerId: "doc", origin: "csv", data_path: '["questlines", "doc", "steps", 0, "story"]', status: "DRAFT" } },
      { id: "l_title", kind: "line", display: "t", aliases: [], source: { path: "data/questlines.json", line: 10 }, links: [{ rel: "spoken_by", kind: "trader", id: "doc" }], production: null, data: { text: "Boiled Rags", rowClass: "story", speakerKind: "trader", speakerId: "doc", origin: "csv", data_path: '["questlines", "doc", "steps", 0, "title"]', status: "DRAFT" } },
      { id: "l_saint", kind: "line", display: "st", aliases: [], source: { path: "data/squad.json", line: 5 }, links: [{ rel: "spoken_by", kind: "squad", id: "doc" }], production: null, data: { text: "Saint checks the doc.", rowClass: "story", speakerKind: "squad", speakerId: "doc", status: "DRAFT" } },
      { id: "l_ui", kind: "line", display: "u", aliases: [], source: { path: "scenes/ui.gd", line: 1 }, links: [], production: null, data: { text: "Open Documents", rowClass: "ui", speakerKind: "system", speakerId: "hud", group: "hud" } },
    ];
    const rows = R.buildReviewRows([...ents, ...rawLines], localIdx, []);

    // orderStepTitlesFirst puts title before story, and groupRows ranks exact speaker "Doc" first on query "Doc"
    const docBlocks = R.groupRows(R.filterRows(rows, { ...R.NO_FILTER, query: "Doc" }), "Doc");
    assert.equal(docBlocks[0].groups[0].label, "Doc");
    assert.deepEqual(docBlocks[0].groups[0].rows.map((r) => r.entityId), ["l_title", "l_story"]);

    // Component: chip counts reflect search; clicking Doc entity chip filters strictly to trader:doc; speaker chip not repeated inside Doc group
    const m = mount(StorybookText);
    const props = { rows, idx: localIdx, focus: null, renderChip: (e, label) => ({ type: "chip", props: { id: `${e.kind}:${e.id}` }, children: [label ?? e.display] }) };
    let tree = m.render(props);
    const search = findAll(tree, (n) => n.props?.["data-testid"] === "sb-text-search")[0];
    search.props.onChange({ target: { value: "Saint" } });
    tree = m.render(props);
    const storyChip = findAll(tree, (n) => n.props?.["data-testid"] === "sb-text-class-story")[0];
    const storyCount = findAll(storyChip, (n) => n.props?.className === "sb-count")[0];
    assert.equal(storyCount.children[0], 1, "Story chip count reflects search (1, not 3)");

    // Search "Doc" -> click Doc entity filter chip -> only Doc's 2 rows remain (no Saint, no Documents)
    search.props.onChange({ target: { value: "Doc" } });
    tree = m.render(props);
    const docBtn = findAll(tree, (n) => n.props?.["data-testid"] === "sb-ent-filter-trader-doc")[0];
    assert.ok(docBtn, "Doc entity chip is a speaker filter button");
    docBtn.props.onClick();
    tree = m.render(props);
    const renderedRows = findAll(tree, (n) => typeof n.type === "function").map((n) => n.type(n.props));
    assert.equal(renderedRows.length, 2, "only Doc rows shown after clicking Doc chip");
    assert.deepEqual(renderedRows.map((r) => r.props["data-sb-row"]), ["line\u0000l_title", "line\u0000l_story"]);
    // Speaker chip is omitted inside its own speaker group
    const chipsInRows = renderedRows.flatMap((r) => findAll(r, (n) => n.type === "chip"));
    assert.equal(chipsInRows.length, 0, "speaker chip not repeated inside Doc group");
  });

  test("V7 friction 2 & 6: Contracts chip count follows active search/filter and contracts render under Contracts heading", async () => {
    const { StorybookText } = await loadMod();
    const ents = [
      { id: "doc", kind: "trader", display: "Doc", aliases: [], source: { path: "t.json", line: 1 }, links: [], production: null, data: {} },
      { id: "popper", kind: "trader", display: "Popper", aliases: [], source: { path: "t.json", line: 2 }, links: [], production: null, data: {} },
      { id: "c_doc_1", kind: "contract", display: "c_doc_1", aliases: [], source: { path: "data/contracts.json", line: 1 }, links: [], production: null, data: { trader: "doc", type: "kill", rendered: { title: "Eliminate 5 Scavs for Doc", detail: "Kill 5." } } },
      { id: "c_pop_1", kind: "contract", display: "c_pop_1", aliases: [], source: { path: "data/contracts.json", line: 2 }, links: [], production: null, data: { trader: "popper", type: "deliver", rendered: { title: "Deliver 10 Scrap for Popper", detail: "Bring 10." } } },
      { id: "c_pop_2", kind: "contract", display: "c_pop_2", aliases: [], source: { path: "data/contracts.json", line: 3 }, links: [], production: null, data: { trader: "popper", type: "extract", rendered: { title: "Extract from Harbor for Popper", detail: "Extract." } } },
    ];
    const localIdx = L.indexEntities(ents);
    const rows = R.buildReviewRows(ents, localIdx, []);
    const blocks = R.groupRows(rows);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].cls, "contracts");
    assert.equal(blocks[0].label, "Contracts");
    assert.equal(blocks[0].n, 3);

    const m = mount(StorybookText);
    const props = { rows, idx: localIdx, focus: null, renderChip: (e, label) => label ?? e.display };
    let tree = m.render(props);
    assert.equal(findAll(tree, (n) => n.props?.["data-testid"] === "sb-text-class-contracts").length, 0, "no duplicate class chip for contracts");
    const chipCount = (t) => {
      const btn = findAll(t, (n) => n.props?.["data-testid"] === "sb-text-contracts")[0];
      return btn ? findAll(btn, (n) => n.props?.className === "sb-count")[0]?.children[0] : null;
    };
    assert.equal(chipCount(tree), 3, "unfiltered shows all 3 contracts");

    const search = findAll(tree, (n) => n.props?.["data-testid"] === "sb-text-search")[0];
    search.props.onChange({ target: { value: "Doc" } });
    tree = m.render(props);
    assert.equal(chipCount(tree), 1, "Contracts chip count follows active search (1, not 3)");
    const contractBlock = findAll(tree, (n) => n.props?.["data-testid"] === "sb-text-block-contracts")[0];
    assert.ok(contractBlock, "contracts rendered in sb-text-block-contracts");
  });
});

test("real EFI (if /tmp snapshot present): counts", { skip: !existsSync("/tmp/sbv3_snap.json") }, () => {
  const s = JSON.parse(readFileSync("/tmp/sbv3_snap.json", "utf8"));
  const i = L.indexEntities(s.entities);
  const items = L.buildListItems(s);
  const rows = R.buildReviewRows(s.entities, i, items);
  console.log("EFI rows", rows.length, R.classCounts(rows), "contracts", rows.filter((r) => r.kind === "contract").length, "tooLong", rows.filter((r) => r.tooLong).length, "scopes", L.scopeCounts(items));
  assert.equal(rows.filter((r) => r.kind === "contract").length, 92);
});
