import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// idea-468: a lane with only workers (no live Lead/Brainstorm) must still mount the context panel,
// or the sidebar "▸ N running · M idle" fold opens nothing.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => fs.readFileSync(path.join(root, "src", f), "utf8");
const ade = src("BoringAde.tsx");
const panel = src("BoringContextPanel.tsx");

test("no-agent lane page mounts BoringContextPanel next to the empty card", () => {
  assert.match(ade, /import \{ BoringContextPanel \} from "\.\/BoringContextPanel"/);
  assert.match(ade, /data-testid="boring-lane-no-agent"[\s\S]{0,300}emptyCard\(\)[\s\S]{0,200}<BoringContextPanel entries=\{\[\]\} teamId=\{activeTeamId\} laneId=\{selectedLaneId\} \/>/);
  assert.match(ade, /: currentPin && selectedLaneId \? \(/);
});

test("BoringContextPanel works without an agent; agent-bound tabs degrade", () => {
  assert.match(panel, /BoringContextPanel\(\{ agent, entries, teamId, laneId \}: \{ agent\?: PaseoAgent/);
  assert.match(panel, /function WorkersTab\(\{ agent, laneId \}: \{ agent\?: PaseoAgent/);
  assert.match(panel, /agent && tab === "Changes"/);
  assert.match(panel, /agent && tab === "Files"/);
  assert.match(panel, /agent && tab === "Terminal"/);
  assert.match(panel, /data-testid="boring-ctx-no-agent"/);
  assert.doesNotMatch(panel, /(?<![.\w])agent\.id\b/); // every id read is optional-chained
});

test("fold row still opens the Workers tab via the shared helper", () => {
  assert.match(ade, /boring-worker-fold/);
  assert.match(ade, /openWorkersTab\(\);/);
});
