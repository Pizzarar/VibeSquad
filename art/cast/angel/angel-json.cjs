// A1: writes the Perfection angel keys into public/office/faces.json (riffbot/overlord entries unchanged; the overlord line
// only gains the separating comma), the "angel" line is replaced or appended) and public/office/sky-clouds.json for the side-cloud tile.
// Frame order = art/cast/angel/angel.lua FRAMES. Run: node art/cast/angel/angel-json.cjs   (repo root)
const fs = require("fs");
const path = "public/office/faces.json";
const at = (...xs) => xs.map((x) => ({ x: x * 80, y: 0 }));
const angel = {
  bg: { dark: "#2a1b6b", light: "#95d3f2" },
  idle: at(0, 1, 2),
  blink: at(3),
  hover: at(4, 5),
};
const lines = fs.readFileSync(path, "utf8").replace(/\r?\n$/, "").split("\n").filter((l) => !l.startsWith(' "angel"'));
let last = lines.pop();
if (last.endsWith("]},")) last = last.slice(0, -1) + "}"; // re-run: the angel line was dropped above
if (!last.endsWith("}}")) throw new Error("faces.json: unexpected last line");
lines.push(last.slice(0, -1) + ",", ` "angel":${JSON.stringify(angel)}}`);
fs.writeFileSync(path, lines.join("\n") + "\n");
JSON.parse(fs.readFileSync(path, "utf8"));

// 96x48 tile, repeats on x, drawn at the face's integer scale and bottom-aligned with the face cell; `top` fills above it
fs.writeFileSync(
  "public/office/sky-clouds.json",
  JSON.stringify({ w: 96, h: 48, repeat: "x", anchor: "bottom", scale: "face", top: { dark: "#2a1b6b", light: "#95d3f2" } }) + "\n",
);
console.log("wrote faces.json angel + sky-clouds.json");
