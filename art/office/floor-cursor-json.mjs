// FS-b: writes public/office/floor-cursor.json for the 2-frame selector sheet built by floor-cursor.lua.
// anchor = the arrow tip pixel inside the cell on frame 0 (frame 1 tip is 2px lower).
// Placement (FF, cast cell 48): tip sits 3px above the 48px cast cell, centred: cell left = anchor.x + bubble.offset.x + 21,
// cell top = anchor.y + bubble.offset.y (cast.json bubble offset {-27,-60}). (32px cell: +14, offset {-18,-40}.)
// Run: node art/office/floor-cursor-json.mjs   (from the repo root)
import fs from "node:fs";

const json = {
  version: 1,
  cell: { w: 13, h: 12 },
  frames: 2,
  fps: 3,
  anchor: { x: 6, y: 9 },
};
fs.writeFileSync("public/office/floor-cursor.json", JSON.stringify(json, null, 2) + "\n", "utf8");
console.log("wrote public/office/floor-cursor.json");
