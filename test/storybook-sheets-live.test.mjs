// W4-sheets: sheet line rows use the live V6 mark bucket, clean chrome; contracts show rendered titles; #15 is the engine's only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTodo, contractTitle, formatNeverSays, indexEntities, itemSheetData, lineChipLabel } from "../src/storybookLogic.ts";
import { liveLineBucket, PROGRESS_BUCKET_LABEL } from "../src/storybookProgressLogic.ts";

const src = { path: "data/items.json", line: 1 };
const ent = (o) => ({ source: src, links: [], data: {}, production: "placeholder", ...o });

test("live bucket: an OK/Edit mark beats a STORY-TODO csv status, Redo is needs rewrite, no mark falls back to the csv status", () => {
  assert.equal(liveLineBucket("ok", "STORY-TODO"), "ok");
  assert.equal(liveLineBucket("edit", "STORY-TODO"), "ok");
  assert.equal(liveLineBucket("redo", "OWNER-OK"), "rewrite");
  assert.equal(liveLineBucket("none", "STORY-TODO"), "todo");
  assert.equal(liveLineBucket("none", "OWNER-OK"), "ok");
  assert.equal(PROGRESS_BUCKET_LABEL.todo, "todo");
});

test("sheet chrome: no raw csv origin or STORY-TODO prefix", () => {
  assert.equal(lineChipLabel(ent({ id: "a", kind: "line", display: "x", data: { origin: "csv", group: "Popper" } })), "Popper");
  assert.equal(lineChipLabel(ent({ id: "a", kind: "line", display: "x", data: { origin: "csv" } })), "Text line");
  assert.equal(lineChipLabel(ent({ id: "a", kind: "line", display: "x", data: { origin: "raid_story" } })), "Raid Story");
  assert.equal(cleanTodo("STORY-TODO: Hello there"), "Hello there");
});

test("contract chips use the rendered title, falling back to the id", () => {
  assert.equal(contractTitle(ent({ id: "x_fence_sealed_vault", kind: "contract", display: "x_fence_sealed_vault", data: { rendered: { title: "Crack the Vault" } } })), "Crack the Vault");
  assert.equal(contractTitle(ent({ id: "c2", kind: "contract", display: "c2" })), "c2");
});

test("#15 no-story equals the engine finding only (no client fallback)", () => {
  const silent = ent({ id: "silent", kind: "item", display: "Silent", data: { description: "" } });
  const flagged = ent({ id: "flagged", kind: "item", display: "Flagged", data: { description: "" } });
  const idx = indexEntities([silent, flagged]);
  const findings = [{ check: "#15", severity: "info", msg: "no story", entityRef: { kind: "item", id: "flagged" } }];
  assert.equal(itemSheetData(silent, idx, findings).isNoStory, false);
  assert.equal(itemSheetData(flagged, idx, findings).isNoStory, true);
});

test("V7 friction 4: formatNeverSays strips raw regex entries and shows plain words", () => {
  assert.deepEqual(formatNeverSays(["haggle", "re:\\bhaggl\\w*"]), ["haggle"]);
  assert.deepEqual(formatNeverSays(["please", "re:\\bhaggl\\w*"]), ["please", "haggl…"]);
  assert.deepEqual(formatNeverSays(["panic", "re:\\bhospital[- ]ward\\b"]), ["panic", "hospital ward"]);
  assert.deepEqual(formatNeverSays(["improvise", "re:\\bclinic\\b"]), ["improvise", "clinic"]);
  assert.deepEqual(formatNeverSays(["please", "re:\\b(?:\\w+n't|I'm)\\b", "re:\\b(?:sorry|oops)\\b"]), ["please", "contractions", "sorry", "oops"]);
  assert.deepEqual(formatNeverSays(["re:\\bleave (?:it|that) behind\\b"]), ["leave it/that behind"]);
});
