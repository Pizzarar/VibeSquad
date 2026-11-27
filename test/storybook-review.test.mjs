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
  assert.equal(c.dev, 1); assert.equal(c.toolong, 1); assert.equal(c.problems, 2);
  assert.equal(L.problemCount(items), 2);
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
  const code = transformSync("StorybookText.tsx", readFileSync(new URL("../src/StorybookText.tsx", import.meta.url), "utf8"), { lang: "tsx", jsx: { runtime: "classic" } })
    .code.replace(/^/, `import React from "./react.mjs";\n`)
    .replace(/from "react"/g, `from "./react.mjs"`)
    .replace(/from "\.\/storybookReview"/g, `from "${reviewUrl}"`);
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
});

test("real EFI (if /tmp snapshot present): counts", { skip: !existsSync("/tmp/sbv3_snap.json") }, () => {
  const s = JSON.parse(readFileSync("/tmp/sbv3_snap.json", "utf8"));
  const i = L.indexEntities(s.entities);
  const items = L.buildListItems(s);
  const rows = R.buildReviewRows(s.entities, i, items);
  console.log("EFI rows", rows.length, R.classCounts(rows), "contracts", rows.filter((r) => r.kind === "contract").length, "tooLong", rows.filter((r) => r.tooLong).length, "scopes", L.scopeCounts(items));
  assert.equal(rows.filter((r) => r.kind === "contract").length, 92);
});
