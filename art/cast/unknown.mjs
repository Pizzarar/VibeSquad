// unknown: a shadow silhouette with glowing eyes. Same bust skeleton as everyone else, filled with shadow and lit by a
// cool rim on the upper left so it separates from a dark background. Hood + grin, spiky hair, floating "?", tall collar.
import { compose, dots, ellipse, rim, run, sym } from "./lib.mjs";
import { BODY, EARS, HEAD } from "./parts.mjs";

const SHADOW = { s: "#352b60", S: "#241d44", n: "#241d44", c: "#2a2250", C: "#1a1530", i: "#5a4a9a", I: "#3e3270" };

const HOOD = { ...ellipse(16, 13.5, 12.5, 11.5, "c"), ol: true };
const HAIR = { x: 6, y: 2, ol: true, g: [
  "..s.....s.....s.....",
  "..ss...sss...ss...s.",
  "..sss.sssss.ssss.ss.",
  ".ssssssssssssssssss.",
  ".sssssssssssssssssss",
  "ssssssssssssssssssss",
  "ssssssssssssssssssss",
  "ssssssssssssssssssss",
  "ssssssssssssssssssss",
] };
const COLLAR_L = ["c....", "cc...", "ccc..", "cccc.", "ccccc", "ccccc", "ccccc"];
const COLLAR = [
  { x: 3, y: 15, ol: true, g: COLLAR_L },
  { x: 24, y: 15, ol: true, g: COLLAR_L.map((r) => [...r].reverse().join("")) },
];
// Floating question mark, glowing; kept inside the neon ring.
const QMARK = { x: 21, y: 3, ol: true, g: [".ll.", "l..l", "..l.", ".l..", "....", ".l.."] };

// Glowing eyes: l glow, L hot core.
const EYES = {
  slant: [["l", ...run(10, 13, 13), [11, 14], [12, 14], ...run(18, 21, 13), [19, 14], [20, 14]], ["L", [12, 13], [19, 13]]],
  round: [["l", ...[12, 13, 14].flatMap((y) => [[11, y], [12, y], [19, y], [20, y]])], ["L", [11, 13], [19, 13]]],
  narrow: [["l", ...run(10, 13, 14), ...run(18, 21, 14)], ["L", [11, 14], [12, 14], [19, 14], [20, 14]]],
  dot: [["l", [11, 13], [12, 13], [11, 14], [12, 14], [19, 13], [20, 13], [19, 14], [20, 14]], ["L", [11, 13], [19, 13]]],
};
const GRIN = ["l", ...run(11, 20, 18), [12, 19], [14, 19], [16, 19], [18, 19], [20, 17], [11, 17], [10, 17], [21, 17]];
const SMILE = ["l", [11, 18], [20, 18], ...run(12, 19, 19)];

const body = [BODY, rim(BODY)];
const head = [...EARS, HEAD, rim(HEAD)];

export const variants = [
  {
    // Hooded, slanted cyan eyes and a jagged glowing grin.
    name: "grin",
    pal: { ...SHADOW, l: "#38f6ff", L: "#e6feff" },
    grid: () => compose([...body, HOOD, rim(HOOD), ...head, { x: 7, y: 7, ol: true, g: sym(["ccccccccc", "ccccccccc", "cc.......", "c........"]) },
      dots(...EYES.slant, GRIN)], "unknown/grin"),
  },
  {
    // Spiky silhouette, round hot-pink eyes, no mouth.
    name: "spiky",
    pal: { ...SHADOW, l: "#ff4fd8", L: "#ffe0f6" },
    grid: () => compose([...body, ...head, HAIR, rim(HAIR), dots(...EYES.round)], "unknown/spiky"),
  },
  {
    // Plain head, yellow dot eyes, a glowing ? floating above.
    name: "question",
    pal: { ...SHADOW, l: "#ffe14d", L: "#fffbe0" },
    grid: () => compose([...body, ...head, dots(...EYES.dot), QMARK], "unknown/question"),
  },
  {
    // Tall cape collar, narrow green eyes, faint smile.
    name: "collar",
    pal: { ...SHADOW, l: "#4df7a6", L: "#e0fff0" },
    grid: () => compose([...body, ...head, ...COLLAR, ...COLLAR.map((l) => rim(l)), dots(...EYES.narrow, SMILE)], "unknown/collar"),
  },
];

export const ring = "#c28cff";
