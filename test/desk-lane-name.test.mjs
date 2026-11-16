// Desk R4 (docs/UX_REVIEW_R4.md R4-2/R4-3/R4-5): one lane display name + one lane code; "Desk" is reserved for the hub.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { transformSync } from "rolldown/utils";

const dir = mkdtempSync(join(tmpdir(), "vs-desk-r4-"));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, "teams.mjs"), `export const isHubLane = (team, lane) => lane.hub === true || (!team.lanes.some((l) => l.hub === true) && lane.id === team.id);`);
const read = (f) => readFileSync(resolve(import.meta.dirname, "..", "src", f), "utf8");
writeFileSync(join(dir, "boringLocation.mjs"), transformSync("boringLocation.ts", read("boringLocation.ts"), { lang: "ts" }).code.replace("./teams.ts", "./teams.mjs"));
const { laneDisplayName, laneCode, laneTopicLabel, boringLocationLane } = await import(pathToFileURL(join(dir, "boringLocation.mjs")).href);

const efi = { id: "efi", lanes: [{ id: "ui-lab", name: "Ui Lab", code: "ui" }] };
const vs = { id: "vibesquad", lanes: [{ id: "desk", name: "Desk", code: "des" }, { id: "hub", name: "Core", hub: true }] };

test("laneDisplayName names a lane by its registered name or id, never a Buddy topic", () => {
  assert.equal(laneDisplayName(efi, "ui-lab"), "UI Lab");
  assert.equal(laneDisplayName(efi, "main-game"), "Main Game");
  // a dynamic lane (topic-derived name) is ignored as a name source
  const dyn = [{ id: "main-game", name: "OpenRouter pipeline critique", dynamic: true }];
  assert.equal(laneDisplayName(efi, "main-game", dyn), "Main Game");
  assert.equal(boringLocationLane(efi, "main-game", dyn), "Main Game");
  assert.equal(laneDisplayName(efi, ""), "Desk");
  assert.equal(laneDisplayName(efi, "efi"), "Desk");
  assert.equal(laneDisplayName(vs, "hub"), "Desk");
});

test("R4-5: a registered lane colliding with the reserved hub name reads 'Desk lane'", () => {
  assert.equal(laneDisplayName(vs, "desk"), "Desk lane");
});

test("laneCode: one code source (registered code, else the full lane id)", () => {
  assert.equal(laneCode(efi, "ui-lab"), "@ui");
  assert.equal(laneCode(efi, "main-game"), "@main-game");
  assert.equal(laneCode(efi, "@main-game"), "@main-game");
  assert.equal(laneCode(efi, ""), "");
});

test("laneTopicLabel: topic is a secondary label only", () => {
  assert.equal(laneTopicLabel("Main Game", "OpenRouter pipeline critique"), "Main Game · OpenRouter pipeline critique");
  assert.equal(laneTopicLabel("Main Game", ""), "");
  assert.equal(laneTopicLabel("Main Game", "main game"), "");
});

test("R4-3: Needs-you line 1 puts the lane first so end-ellipsis cuts the project", () => {
  const inbox = read("BoringInbox.tsx");
  assert.match(inbox, /\{r\.lane\} · \{r\.project\}<\/span>/);
  assert.doesNotMatch(inbox, /\{r\.project\} › \{r\.lane\}<\/span>/);
});
