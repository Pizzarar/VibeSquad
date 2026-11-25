import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// MermaidView.tsx: load only the pure parser half (same trick as mermaid-view.test.mjs).
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      const raw = readFileSync(fileURLToPath(url), "utf8");
      const cut = raw.indexOf("// ─── React Component");
      return { format: "module-typescript", shortCircuit: true, source: cut !== -1 ? raw.slice(0, cut) : raw };
    }
    return nextLoad(url, context);
  },
});
const { parseMermaid } = await import("../src/MermaidView.tsx");
const L = await import("../src/storybookLogic.ts");

const snap = JSON.parse(readFileSync(new URL("./fixtures/storybook/efi-mini.json", import.meta.url), "utf8"));
const idx = L.indexEntities(snap.entities);

describe("storybookLogic", () => {
  test("finding→category map", () => {
    for (const c of ["#1", "#2", "#5"]) assert.equal(L.findingCategory(c), "broken");
    for (const c of ["#3", "#4", "#6", "#7", "#9", "#10", "#11"]) assert.equal(L.findingCategory(c), "inconsistent");
    assert.equal(L.findingCategory("#8"), "missing");
    assert.equal(L.findingCategory("#99"), null);
  });

  test("identity is (kind,id): doc trader and doc squad both resolve", () => {
    assert.equal(idx.get("trader", "doc").display, "Doc");
    assert.equal(idx.get("squad", "doc").display, "Saint");
  });

  test("list items: sample finding is Broken, non-OWNER-OK csv rows Unreviewed", () => {
    const items = L.buildListItems(snap);
    const broken = items.filter((i) => i.category === "broken");
    assert.equal(broken.length, 1);
    assert.deepEqual(broken[0].entityRef, { kind: "quest_step", id: "popper_2" });
    const unrev = items.filter((i) => i.category === "unreviewed");
    const csvRows = snap.entities.filter((e) => e.kind === "line" && typeof e.data.status === "string");
    assert.equal(unrev.length, csvRows.filter((e) => e.data.status.trim().toUpperCase() !== "OWNER-OK").length);
    assert.ok(unrev.length > 0);
    assert.ok(!unrev.some((i) => /^OWNER-OK/.test(i.msg)));
  });

  test("OWNER-OK rows are not unreviewed; non-csv lines never are", () => {
    const mk = (status) => ({ kind: "line", id: "x", display: "t", data: { status, text: "t" }, links: [], source: { path: "a", line: 1 } });
    assert.equal(L.isUnreviewedLine(mk("OWNER-OK")), false);
    assert.equal(L.isUnreviewedLine(mk("owner-ok ")), false);
    assert.equal(L.isUnreviewedLine(mk("DRAFT")), true);
    assert.equal(L.isUnreviewedLine({ ...mk(undefined), data: { text: "t" } }), false);
  });

  test("filter: empty = all, toggle adds/removes, counts", () => {
    const items = L.buildListItems(snap);
    assert.equal(L.filterItems(items, new Set()).length, items.length);
    const only = L.filterItems(items, L.toggleCategory(new Set(), "broken"));
    assert.ok(only.length >= 1 && only.every((i) => i.category === "broken"));
    assert.equal(L.toggleCategory(new Set(["broken"]), "broken").size, 0);
    const c = L.countByCategory(items);
    assert.equal(c.broken + c.missing + c.inconsistent + c.unreviewed, items.length);
  });

  test("quest chains: per trader, ordered; mermaid links step→target and parses", () => {
    const chains = L.questChains(idx);
    const popper = chains.find((c) => c.traderId === "popper");
    assert.deepEqual(popper.steps.map((s) => s.id), ["popper_1", "popper_2"]);
    const g = L.chainToMermaid(popper, idx);
    assert.match(g.code, /^flowchart (LR|TD)/);
    assert.match(g.code, /n0 --> n2|n0 --> n1/);
    const names = Object.values(g.nodes).map((e) => `${e.kind}:${e.id}`);
    for (const n of ["quest_step:popper_1", "quest_step:popper_2", "item:scrap_metal", "enemy:scav", "location:harbor_district"]) assert.ok(names.includes(n), n);
    const parsed = parseMermaid(g.code);
    assert.equal(parsed.ok, true);
    assert.ok(!g.code.includes("STORY-TODO"));
  });

  test("mermaid: index/rel sanitized, long chains lay out top-down", () => {
    const evil = { ...idx.get("quest_step", "popper_2"), data: { ...idx.get("quest_step", "popper_2").data, index: '1"]; n88["X' } };
    const chain = { traderId: "popper", trader: null, steps: [evil] };
    const g = L.chainToMermaid(chain, idx);
    assert.doesNotMatch(g.code, /n88\[/);
    assert.equal(g.code.split("\n").filter((l) => /^  n\d+\[/.test(l)).length, 1);
    assert.equal(L.mermaidLabel("a%%b"), "a b");
    const many = Array.from({ length: L.LONG_CHAIN + 1 }, (_, i) => ({ ...evil, id: "s" + i, data: { index: i + 1 }, links: [] }));
    assert.match(L.chainToMermaid({ traderId: "p", trader: null, steps: many }, idx).code, /^flowchart TD/);
  });

  test("mermaid labels are sanitized", () => {
    assert.equal(L.mermaidLabel('a "b" [c] {d} (e) | f'), "a b c d e f");
  });

  test("location view: enemy windows, boss, quests", () => {
    const v = L.locationView(idx.get("location", "harbor_district"), idx);
    assert.deepEqual(v.enemies.map((e) => e.id), ["scav", "armored_scav", "boss_dockmaster"]);
    assert.equal(v.enemies[1].minS, 600);
    assert.equal(v.enemies[2].boss, true);
    assert.deepEqual(v.quests.map((q) => q.id), ["popper_2"]);
    assert.ok(v.lore.some((l) => l.id === "map:harbor_district"));
    assert.equal(L.fmtWindow(600, 1800), "10m–30m");
    assert.equal(L.fmtWindow(null, null), "any time");
  });

  test("character view groups csv display-name speakers with id speakers; voice card attached", () => {
    const chars = L.characterViews(idx);
    const popper = chars.find((c) => c.id === "popper");
    assert.ok(popper.card);
    assert.equal(popper.speaker, "Popper");
    assert.ok(popper.lines.length >= 3);
    assert.ok(chars.some((c) => c.id === "narrator"));
  });

  test("entity card: text, speaker, area, status, owner_note, source file:line", () => {
    const csv = snap.entities.find((e) => e.id.startsWith("csv:data/questlines.json:12"));
    const c = L.entityCard(csv, idx);
    assert.equal(c.status, "DRAFT");
    assert.equal(c.ownerNote, "keep it short");
    assert.equal(c.source, "data/questlines.json:12");
    assert.equal(c.speaker, "Popper");
    assert.match(c.text, /thirty casings/);
    const q = L.entityCard(idx.get("quest_step", "popper_2"), idx);
    assert.equal(q.area, "Harbor District");
    assert.match(q.text, /Kill scav ×10/);
  });

  test("load/refresh interpretation: 404 → none, fetched=false → rate-limit notice", () => {
    assert.equal(L.interpretLoad(404, { error: "x" }).kind, "none");
    assert.equal(L.interpretLoad(200, snap).kind, "ok");
    assert.equal(L.interpretLoad(500, { error: "boom" }).message, "boom");
    const r = L.interpretRefresh(200, { fetched: false, skipped: "rate-limited", nextFetchAt: new Date(Date.now() + 3600e3).toISOString(), ...snap });
    assert.match(r.notice, /one fetch per hour; showing the pinned sha\. Next fetch allowed after/);
    assert.match(r.status, /^Checked .* next fetch /);
    assert.ok(r.snap);
    assert.equal(L.interpretRefresh(200, { fetched: true, nextFetchAt: null, ...snap }).notice, null);
    assert.match(L.interpretRefresh(200, { fetched: true, ...snap }).status, /^Up to date · checked /);
    assert.equal(L.interpretLoad(200, { entities: [] }).kind, "error"); // no sha: malformed payload
    assert.equal(L.interpretRefresh(404, {}).error, L.NO_STORYBOOK);
  });
});

// The known-missing probe (StorybookView.tsx) must notify subscribers when a probe resolves, so a consumer that read the
// cache at render (the phone drawer's "Open Storybook" entry) re-renders once the HEAD request lands — otherwise a slow
// host link leaves the entry visible for a project with no Storybook (UX R21 m1).
test("StorybookView probe notify path: subscribe/notify re-renders consumers when a probe resolves", () => {
  const s = readFileSync(new URL("../src/StorybookView.tsx", import.meta.url), "utf8");
  assert.ok(s.includes("const missingSubs = new Set<() => void>();"), "probe subscriber set");
  assert.ok(s.includes("const missingEmit = () => missingSubs.forEach((f) => f());"), "probe notify");
  assert.ok(s.includes("missing.set(projectId, true); missingEmit();"), "404 resolves → notify");
  assert.ok(s.includes("missing.delete(projectId); missingEmit();"), "non-ok / network error → notify (retry)");
  assert.ok(s.includes("export function useStorybookMissing"), "consumer hook");
  assert.ok(s.includes("missingSubs.add(cb)") && s.includes("missingSubs.delete(cb)"), "hook subscribes via useSyncExternalStore");
  assert.ok(s.includes("useSyncExternalStore("), "uses useSyncExternalStore");
});
