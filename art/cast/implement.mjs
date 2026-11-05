// implement: the brawler who gets it built. Bandana on every variant (headband with knot tails, or a full do-rag),
// tank top over big shoulders; taped fist, mohawk + grin, hammer on the shoulder, boxing guard.
import { compose, dots, paint, run, sym, SKIN } from "./lib.mjs";
import { BODY, EARS, FACE_SHADE, HEAD } from "./parts.mjs";

// Tank top t over bare shoulders: scoop neck, straps, arm creases.
const inTank = (x, y) => (y === 24 ? [10, 11, 20, 21].includes(x) : y === 25 ? x <= 12 || x >= 19 : y >= 26) && x >= 10 && x <= 21;
const TANK = [BODY, paint(BODY, (x, y, ch) => (inTank(x, y) ? "t" : (x === 6 || x === 25) && y >= 27 ? "S" : ch === "c" || ch === "C" ? "s" : null))];

// Headband across the forehead (b, d = print dots) and the knot + tails flaring off the viewer's right.
const BAND = { x: 7, y: 9, ol: true, g: [
  "..bbbbbbbbbbbbbb..",
  ".bbbbbbbbbbbbbbbb.",
  "bbbbbbbbbbbbbbbbbb",
] };
const TAILS = { x: 24, y: 6, ol: true, g: [
  ".....bb",
  "...bbbb",
  "..bbbB.",
  "bbbBB..",
  "bBbb...",
  ".bbbbb.",
  "...bbbb",
  ".....bb",
] };
const BAND_DOTS = ["d", [10, 10], [14, 11], [17, 10], [21, 11], [12, 9], [19, 9], [26, 9], [28, 12]];
// Full do-rag over the scalp, same knot + tails.
const DORAG = { x: 7, y: 3, ol: true, g: sym([
  "....bbbbb",
  "..bbbbbbb",
  ".bbbbbbbb",
  "bbbbbbbbb",
  "bbbbbbbbb",
  "bbbbbbbbb",
  "bbbbbbbbb",
  "bbbbbbbbb",
  "BBBBBBBBB",
]) };
const DORAG_DOTS = ["d", [11, 5], [16, 4], [20, 6], [9, 8], [14, 8], [19, 9], [23, 8], [26, 9], [28, 12]];

const HAIR = {
  spiky: { x: 8, y: 2, ol: true, g: [
    "..a....a....a...",
    "..aa..aa...aa.a.",
    ".aaa.aaaa.aaaaa.",
    "aaaaaaaaaaaaaaaa",
    "aaaaaaaaaaaaaaaa",
    "aaaaaaaaaaaaaaaa",
    "aaaaaaaaaaaaaaaa",
    "aaaaaaaaaaaaaaaa",
  ] },
  mohawk: { x: 13, y: 0, ol: true, g: ["..aa..", ".aaaa.", ".aaaa.", "aaaaaa", "aaaaaa", "aaaaaa", "aaaaaa", "AAaaAA", "AAAAAA", "AAAAAA"] },
  buzz: { x: 7, y: 6, ol: true, g: sym(["...aaaaaa", ".aaaaaaaa", "aaaaaaaaa"]) },
};

// Heavy flat brows low over the eyes.
const BROWS = ["e", ...run(10, 13, 12), ...run(18, 21, 12)];
const EYES = ["e", [11, 13], [12, 13], [11, 14], [12, 14], [19, 13], [20, 13], [19, 14], [20, 14]];
const NOSE = ["S", [16, 15], [16, 16], [15, 17], [16, 17]];
const STUBBLE = ["x", [10, 18], [21, 18], [11, 19], [20, 19], [12, 20], [19, 20], [13, 21], [15, 21], [17, 21], [18, 21]];
const SMIRK = ["k", ...run(13, 18, 19), [19, 18]];
const GRIN = [
  ["k", ...run(12, 19, 18), [11, 19], [20, 19], [12, 20], [19, 20], ...run(13, 18, 21)],
  ["w", ...run(12, 19, 19), ...run(13, 18, 20)],
  ["k", [15, 19]],
];
const GRIT = [
  ["k", ...run(12, 19, 18), [11, 19], [11, 20], [20, 19], [20, 20], ...run(12, 19, 21)],
  ["w", ...run(12, 19, 19), ...run(12, 19, 20)],
  ["k", [14, 19], [14, 20], [17, 19], [17, 20]],
];

// Fists: knuckles, finger creases, tape wrap w.
const FIST = { x: 22, y: 19, ol: true, g: [
  ".ssssss",
  "sSsSsSs",
  "sssssss",
  "wwwwwws",
  "wwwwwww",
  ".kkkkk.",
  ".sssss.",
] };
const FIST_L = { ...FIST, x: 3, g: FIST.g.map((r) => [...r].reverse().join("")) };
// Sledgehammer resting on the viewer's left shoulder (tails fly off the right).
const HAMMER = { x: 0, y: 7, ol: true, g: [
  "mmmmmmmm..",
  "mWWmmmmm..",
  "mWmmmmmm..",
  "mmmmmmmm..",
  "MMMMMMMM..",
  "...jJ.....",
  "...jJ.....",
  "....jJ....",
  "....jJ....",
  ".....jJ...",
  ".....jJ...",
  "...sssss..",
  "..ssssSs..",
  "....ssss..",
] };
const BEARD = { x: 9, y: 17, ol: true, g: sym(["a......", "aa.....", "aaa....", ".aaaaaa", "..aaaaa", "...aaaa", ".....aa"], true) };

const base = (hair, head, face, extra = []) => [...TANK, ...EARS, HEAD, dots(FACE_SHADE), ...face, ...(hair ? [hair] : []), ...head, ...extra];
const band = [BAND, TAILS, dots(BAND_DOTS)];

export const variants = [
  {
    // Spiky black hair, red polka-dot headband, stubble smirk; taped fist up.
    name: "fist",
    pal: { ...SKIN.tan, a: "#2a2440", A: "#14101e", b: "#ff3d6e", B: "#b8203f", d: "#f6f3ff", t: "#f6f3ff", x: "#b07a52" },
    grid: () => compose(base(HAIR.spiky, band, [dots(BROWS, EYES, ["w", [11, 13], [19, 13]], NOSE, STUBBLE, SMIRK)], [FIST]), "implement/fist"),
  },
  {
    // Hot-pink mohawk, cyan headband, brow scar, gap-tooth grin, violet tank; taped fist.
    name: "mohawk",
    pal: { ...SKIN.light, a: "#ff4fd8", A: "#b52a95", b: "#38f6ff", B: "#1fa3c8", d: "#14101e", t: "#8f5cff", x: "#c99a80" },
    grid: () => compose(base(HAIR.mohawk, band,
      [dots(BROWS, EYES, ["w", [11, 13], [19, 13]], NOSE, ...GRIN, ["x", [20, 11], [20, 12], [21, 13]], ["r", [9, 16], [22, 16]])], [FIST]), "implement/mohawk"),
  },
  {
    // Violet do-rag with gold dots, full black beard, cyan tank; sledgehammer on the shoulder.
    name: "hammer",
    pal: { ...SKIN.deep, a: "#1d1830", b: "#8f5cff", B: "#5a34b8", d: "#ffc857", t: "#38c8ff", m: "#e6e9f2", M: "#9aa0b8", W: "#ffffff", j: "#f0b870", J: "#c0803c" },
    grid: () => compose(base(null, [DORAG, TAILS, dots(DORAG_DOTS)],
      [dots(BROWS, EYES, ["w", [11, 13], [19, 13]], NOSE)], [BEARD, dots(["w", ...run(13, 18, 19)], ["k", ...run(13, 18, 20)]), HAMMER]), "implement/hammer"),
  },
  {
    // Buzz cut, yellow headband, nose plaster + gritted teeth, orange tank; both fists up.
    name: "guard",
    pal: { ...SKIN.brown, a: "#1d1830", b: "#ffe14d", B: "#c9a020", d: "#ff3d6e", t: "#ff8a3d", x: "#7e4a2c", p: "#f6f3ff" },
    grid: () => compose(base(HAIR.buzz, band,
      [dots(BROWS, EYES, ["w", [11, 13], [19, 13]], NOSE, ...GRIT, ["p", [14, 16], [15, 16], [16, 16], [17, 16], [15, 15], [15, 17]])], [FIST, FIST_L]), "implement/guard"),
  },
];

export const ring = "#ff3d6e";
