import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Timeline.tsx renders TimelineSkeleton outside .tl-head and shows booting/empty indicators", () => {
  const src = fs.readFileSync(path.join(root, "src/Timeline.tsx"), "utf8");

  // 1. TimelineSkeleton is outside {(barOpen || pinnedTodo) && <div className="tl-head">...</div>}
  const headOpenIdx = src.indexOf('{(barOpen || pinnedTodo) && <div className="tl-head">');
  assert.ok(headOpenIdx !== -1, "Expected .tl-head conditional block in Timeline.tsx");
  const headCloseIdx = src.indexOf("</div>}", headOpenIdx);
  assert.ok(headCloseIdx !== -1, "Expected closing </div>} for .tl-head");
  const skelIdx = src.indexOf("{slowFirstLoad && <TimelineSkeleton />}");
  assert.ok(skelIdx > headCloseIdx, "Expected TimelineSkeleton to be rendered after .tl-head closes");

  // 2. tl-booting-indicator and tl-empty-indicator when loaded && !error && shown.length === 0
  assert.match(src, /loaded && !error && shown\.length === 0/);
  assert.match(src, /agentStatus === "running" \|\| agentStatus === "initializing"/);
  assert.match(src, /data-testid="tl-booting-indicator"/);
  assert.match(src, /is thinking — booting session from brief…/);
  assert.match(src, /data-testid="tl-empty-indicator"/);
  assert.match(src, /No messages in this session yet\. Send a message below to start\./);
});

test("AgentDrawer.tsx passes agentStatus and agentTitle to Timeline", () => {
  const src = fs.readFileSync(path.join(root, "src/AgentDrawer.tsx"), "utf8");
  const tlBlock = src.slice(src.indexOf("<Timeline"), src.indexOf("/>", src.indexOf("<Timeline")) + 2);
  assert.match(tlBlock, /agentStatus=\{agent\.status\}/);
  assert.match(tlBlock, /agentTitle=\{agent\.title\}/);
});

test("PinRail.tsx renders Spinner with Spinning up RiffBot / Spinning up in PinFocusHeader when !focus.gone", () => {
  const src = fs.readFileSync(path.join(root, "src/PinRail.tsx"), "utf8");
  assert.match(src, /import\s*\{\s*Spinner\s*\}\s*from\s*"\.\/QuickWinsUi"/);
  assert.match(src, /data-testid="pin-focus-spinning"/);
  assert.match(src, /Spinning up RiffBot \(\$\{selectedProfile\.replace\(\/\^Brainstorm\\s\*-\\s\*\/i, ""\)\}\) — booting session from brief…/);
  assert.match(src, /Spinning up \$\{pin\?\.lane\.name \?\? "Brainstorm"\} \(\$\{selectedProfile\.replace\(\/\^Brainstorm\\s\*-\\s\*\/i, ""\)\}\) from the brief…/);
});

test("HubBar.tsx subscribes to pin starts, disables .hub-bar-btn, and shows Starting RiffBot… while starting", () => {
  const src = fs.readFileSync(path.join(root, "src/HubBar.tsx"), "utf8");
  assert.match(src, /isPinStarting/);
  assert.match(src, /subscribePinStarts/);
  assert.match(src, /useSyncExternalStore\(subscribePinStarts,\s*\(\)\s*=>\s*\(hub\s*\?\s*isPinStarting\(hub\)\s*:\s*false\)\)/);
  assert.match(src, /starting\s*\?\s*"Starting RiffBot…"\s*:\s*hub\.brainstorm\s*\?\s*"Talk to RiffBot"\s*:\s*"Open RiffBot"/);
  assert.match(src, /disabled=\{starting\}/);
});
