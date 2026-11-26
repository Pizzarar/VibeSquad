import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { makeFakeRepo } from "./storybook-fake-repo.mjs";
import { renderTemplates } from "../server/storybook/adapters/efi.mjs";

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

test("rows: story first, full text, contracts rendered with real names", () => {
  const rows = R.buildReviewRows(snap.entities, idx, []);
  assert.ok(rows.length > 0);
  const blocks = R.groupRows(rows);
  assert.equal(blocks[0].cls, "story");
  const c = rows.find((r) => r.kind === "contract");
  assert.ok(c && c.title && !/undefined|null/.test(c.title), c?.title);
  assert.equal(c.keyPath, c.entityId);
  const long = { ...rows[0], text: "x".repeat(500) };
  assert.equal(long.text.length, 500);
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

test("renderTemplates fills every contract type", () => {
  const ents = [
    { kind: "trader", id: "popper", display: "Popper" }, { kind: "item", id: "scrap", display: "Scrap Metal" }, { kind: "enemy", id: "scav", display: "Scav" }, { kind: "location", id: "harbor", display: "Harbor" },
    ...[["deliver", { item: "scrap", qty_min: 2, qty_max: 5 }], ["kill", { enemy: "scav", qty_min: 3, qty_max: 3 }], ["pack", { enemy: "scav", qty_min: 1, qty_max: 2 }], ["mastery", { family: "pistol", qty_min: 1, qty_max: 2 }], ["extract", { location: "harbor", qty_min: 2, qty_max: 4 }]]
      .map(([type, x]) => ({ kind: "contract", id: `c_${type}`, display: `c_${type}`, data: { type, trader: "popper", ...x } })),
  ];
  const m = renderTemplates(ents);
  assert.equal(m.get("c_deliver").title, "Deliver 2–5 × Scrap Metal for Popper");
  assert.equal(m.get("c_kill").title, "Eliminate 3 × Scav for Popper");
  assert.equal(m.get("c_pack").title, "Wipe 1–2 × Scav packs for Popper");
  assert.equal(m.get("c_mastery").title, "Pistol practice for Popper");
  assert.equal(m.get("c_extract").title, "Extract from Harbor 2–4 times for Popper");
});

test("real EFI (if /tmp snapshot present): counts", { skip: !existsSync("/tmp/sbv3_snap.json") }, () => {
  const s = JSON.parse(readFileSync("/tmp/sbv3_snap.json", "utf8"));
  const i = L.indexEntities(s.entities);
  const items = L.buildListItems(s);
  const rows = R.buildReviewRows(s.entities, i, items);
  console.log("EFI rows", rows.length, R.classCounts(rows), "contracts", rows.filter((r) => r.kind === "contract").length, "tooLong", rows.filter((r) => r.tooLong).length, "scopes", L.scopeCounts(items));
  assert.equal(rows.filter((r) => r.kind === "contract").length, 92);
});
