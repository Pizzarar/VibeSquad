import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runRemoveTeam } from "../src/pinRemoveLogic.ts";

test("runRemoveTeam catches individual fx.archive(a.id) rejections and still calls fx.saveTeams to set state: 'removed'", async () => {
  const now = () => new Date(2026, 10, 5, 12);
  let teams = [
    {
      id: "vibesquad",
      name: "VibeSquad",
      lanes: [{ id: "bug-chaser", name: "Bug Chaser", state: "pinned" }],
      paths: [],
    },
  ];
  const archivedAttempts = [];
  const pin = { squad: teams[0], lane: teams[0].lanes[0] };
  const plan = {
    agents: [{ id: "a1" }, { id: "a2-already-archived" }, { id: "a3" }],
    worktrees: [],
    sharedWith: null,
  };

  const res = await runRemoveTeam(
    pin,
    plan,
    { deleteWorktrees: false },
    {
      now,
      archive: async (id) => {
        archivedAttempts.push(id);
        if (id === "a2-already-archived") throw new Error("Agent not found or already archived");
      },
      saveTeams: async (update) => {
        teams = update(teams);
      },
    },
  );

  assert.deepEqual(archivedAttempts, ["a1", "a2-already-archived", "a3"]);
  assert.deepEqual(res.archived, ["a1", "a2-already-archived", "a3"]);
  assert.equal(teams[0].lanes[0].state, "removed");
  assert.equal(teams[0].lanes[0].removedAt, now().toISOString());
});

test("PinMenu stops propagation on onKeyDown and onContextMenu, and is mounted in PinRow (Sidebar) and PinRail (.pin-rail-active-head)", () => {
  const pinMenuSrc = fs.readFileSync(new URL("../src/PinMenu.tsx", import.meta.url), "utf8");
  assert.match(pinMenuSrc, /className="pin-menu"[\s\S]*?onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
  assert.match(pinMenuSrc, /className="pin-menu"[\s\S]*?onKeyDown=\{\(e\) => e\.stopPropagation\(\)\}/);
  assert.match(pinMenuSrc, /className="pin-menu"[\s\S]*?onContextMenu=\{\(e\) => e\.stopPropagation\(\)\}/);

  const pinGridSrc = fs.readFileSync(new URL("../src/PinGrid.tsx", import.meta.url), "utf8");
  const pinRowStart = pinGridSrc.indexOf("const PinRow = memo(");
  const pinRowEnd = pinGridSrc.indexOf("export const SidebarRiffBot", pinRowStart);
  assert.ok(pinRowStart >= 0 && pinRowEnd > pinRowStart, "PinRow component exists in PinGrid.tsx");
  const pinRowBlock = pinGridSrc.slice(pinRowStart, pinRowEnd);
  assert.match(
    pinRowBlock,
    /<\/button>\s*\{!isHubPin\(pin\) && <PinMenu pin=\{pin\} onShowPlumbing=\{\(\) => setFullView\(true\)\} \/>\}\s*<\/div>/,
    "PinRow renders <PinMenu> inside .pin-row-wrap as a sibling after </button>",
  );

  const pinRailSrc = fs.readFileSync(new URL("../src/PinRail.tsx", import.meta.url), "utf8");
  const headStart = pinRailSrc.indexOf('<div className="pin-rail-active-head">');
  const headEnd = pinRailSrc.indexOf("{active && drawerOpen && <SendToBar", headStart);
  assert.ok(headStart >= 0 && headEnd > headStart, ".pin-rail-active-head exists in PinRail.tsx");
  const headBlock = pinRailSrc.slice(headStart, headEnd);
  assert.match(headBlock, /!isHubPin\(active\)[\s\S]*?<PinMenu/, ".pin-rail-active-head mounts <PinMenu> for non-hub active pins");
  assert.match(headBlock, /exitPinFocus\(\);\s*setFullView\(true\);/, "PinRail PinMenu onShowPlumbing exits pin focus and enables full view");
});
