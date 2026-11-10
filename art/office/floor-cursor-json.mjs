// FS-b: writes public/office/floor-cursor.json for the 2-frame selector sheet built by floor-cursor.lua.
// anchor = the arrow tip pixel inside the cell on frame 0 (frame 1 tip is 2px lower).
// Placement = cursorOffset() in src/squadFloorLogic.ts: cell left = seat anchor x - anchor.x,
// cell top = seat anchor y - cast cell - round(cell.h * 1.5). (FT: cast cell 64, cursor 17x14; FF was 48 / 13x12.)
// Run: node art/office/floor-cursor-json.mjs   (from the repo root)
import fs from "node:fs";

const json = {
  version: 1,
  cell: { w: 17, h: 14 },
  frames: 2,
  fps: 3,
  anchor: { x: 8, y: 11 },
};
fs.writeFileSync("public/office/floor-cursor.json", JSON.stringify(json, null, 2) + "\n", "utf8");
console.log("wrote public/office/floor-cursor.json");
