// FS-b: writes public/office/floor-cursor.json for the 2-frame selector sheet built by floor-cursor.lua.
// anchor = the arrow tip pixel inside the cell on frame 0 (frame 1 tip is 1px lower).
// Placement: tip sits 2px above the 32px cast cell, centred: cell left = anchor.x + bubble.offset.x + 14,
// cell top = anchor.y + bubble.offset.y (cast.json bubble offset {-18,-40}).
// Run: node art/office/floor-cursor-json.mjs   (from the repo root)
import fs from "node:fs";

const json = {
  version: 1,
  cell: { w: 9, h: 8 },
  frames: 2,
  fps: 3,
  anchor: { x: 4, y: 6 },
};
fs.writeFileSync("public/office/floor-cursor.json", JSON.stringify(json, null, 2) + "\n", "utf8");
console.log("wrote public/office/floor-cursor.json");
