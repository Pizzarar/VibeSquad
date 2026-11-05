// mechanical: shop mechanic. Ball cap (bill dips over the brows) + big mustache on every variant, zip coveralls with a
// name patch; wrench, goggles on the cap + grease smudge, trucker cap + screwdriver, blowtorch.
import { compose, dots, run, sym, SKIN } from "./lib.mjs";
import { BODY, EARS, FACE_SHADE, HEAD } from "./parts.mjs";

// Crown h with panel seam H, logo patch l on the front; bill b with shaded underside B.
const CAP = { x: 7, y: 2, ol: true, g: sym([
  "....hhhhh",
  "..hhhhhhh",
  ".hhhhhhhh",
  "hhhhhhhhh",
  "hhhhhhhhh",
  "hhhhhhhhh",
  "hhhhhhhhh",
  "hhhhhhhhh",
]) };
const BILL = { x: 5, y: 10, ol: true, g: sym(["bbbbbbbbbbb", ".BBBBBBBBBB"]) };
const SEAMS = ["H", [11, 4], [10, 5], [10, 6], [9, 7], [9, 8], [9, 9], [20, 4], [21, 5], [21, 6], [22, 7], [22, 8], [22, 9], [15, 2], [16, 2]];
// Trucker: front panel in a light colour, mesh dots on the sides.
const TRUCKER = ["l", ...[4, 5, 6, 7, 8, 9].flatMap((y) => run(11, 20, y)), ...run(12, 19, 3)];
const MESH = ["H", [8, 6], [9, 8], [8, 9], [23, 6], [22, 8], [23, 9], [9, 5], [22, 5]];
const LOGO = {
  gear: ["l", [15, 5], [16, 5], [14, 6], [15, 6], [16, 6], [17, 6], [14, 7], [17, 7], [15, 7], [16, 7], [15, 8], [16, 8], [13, 6], [18, 7]],
  bolt: ["l", [16, 5], [17, 5], [15, 6], [16, 6], [15, 7], [16, 7], [17, 7], [16, 8], [15, 9]],
  wrench: ["L", [14, 5], [17, 5], [14, 6], [15, 6], [16, 6], [17, 6], [15, 7], [16, 7], [15, 8], [16, 8]],
  star: ["l", [15, 5], [16, 5], [13, 6], [14, 6], [15, 6], [16, 6], [17, 6], [18, 6], [14, 7], [15, 7], [16, 7], [17, 7], [14, 8], [17, 8]],
};
const UNDER_BILL = dots(["S", ...run(8, 23, 12)]);
const GOGGLES = { x: 9, y: 5, ol: true, g: sym([".gggg..", "gLllgjj", "gllllg.", ".gggg.."].map((r) => r.padEnd(7, "."))) };

// Mustaches (m, M shade) sit on rows 16-18 over a small mouth.
const STACHE = {
  walrus: { x: 10, y: 16, ol: true, g: sym([".mmmmm", "mmmmmm", "mmMmmm", "mM...."]) },
  handlebar: { x: 8, y: 15, ol: true, g: sym(["m...mmmm", "mm.mmmmm", ".mmmmMMm", "........"]) },
  bushy: { x: 9, y: 16, ol: true, g: sym(["..mmmmm", ".mmmmmm", "mmmmmmm", "mM..MMm"]) },
};
const EYES = (y = 13) => [["e", [11, y], [12, y], [11, y + 1], [12, y + 1], [19, y], [20, y], [19, y + 1], [20, y + 1]], ["w", [11, y], [19, y]]];
const BROWS = (ch) => [ch, ...run(10, 13, 12), ...run(18, 21, 12)];
const NOSE = ["n", [15, 15], [16, 15], [15, 16], [16, 16]];

// Coveralls: zipper z down the middle, name patch on the chest.
const ZIP = ["z", ...[24, 25, 26, 27, 28, 29, 30, 31].map((y) => [16, y])];
const PATCH = ["w", ...run(6, 11, 26), ...run(6, 11, 27), ...run(6, 11, 28)];
const PATCH_TEXT = ["t", [7, 27], [8, 27], [10, 27]];

// Steel tools use v / V so they never pick up a variant's mustache colour.
const WRENCH = { x: 23, y: 11, ol: true, g: [
  "v...v.",
  "vv.vv.",
  ".vvv..",
  "..v...",
  "..vV..",
  "..vV..",
  "..vV..",
  "..vV..",
  "sssss.",
  "sSssss",
  "ssss..",
] };
const SCREWDRIVER = { x: 24, y: 13, ol: true, g: [
  "..v...",
  "..v...",
  "..vV..",
  "..vV..",
  ".qqqq.",
  ".qQqq.",
  ".qQqq.",
  ".qqqq.",
  "sssss.",
  "sSssss",
  "ssss..",
] };
// Blowtorch: cyan flame f with white core F, steel nozzle, red tank.
const TORCH = { x: 23, y: 9, ol: true, g: [
  "..f...",
  ".fFf..",
  ".fFf..",
  "..f...",
  "..vv..",
  "..vV..",
  ".qqqq.",
  ".qQqq.",
  ".qQqq.",
  ".qqqq.",
  "sssss.",
  "sSssss",
  "ssss..",
] };

const base = (face, stache, cap, extra = []) => [
  BODY, dots(ZIP, PATCH, PATCH_TEXT), ...EARS, HEAD, dots(FACE_SHADE), UNDER_BILL, dots(...face), stache, CAP, dots(...cap), BILL, ...extra,
];

export const variants = [
  {
    // Teal cap with gear logo, brown walrus mustache, orange coveralls; wrench.
    name: "wrench",
    pal: { v: "#e6e9f2", V: "#9aa0b8", ...SKIN.light, h: "#2fd3c0", H: "#16877b", b: "#2fd3c0", B: "#16877b", l: "#ffe14d", m: "#6b3b1e", M: "#4a2812",
      c: "#ff8a3d", C: "#b8551a", z: "#fff3c8", t: "#ff3d6e" },
    grid: () => compose(base([BROWS("m"), ...EYES(), NOSE, ["k", ...run(14, 17, 20)]], STACHE.walrus, [SEAMS, LOGO.gear], [WRENCH]), "mechanical/wrench"),
  },
  {
    // Yellow cap with goggles up, curly black handlebar, grease smudge, violet coveralls.
    name: "goggles",
    pal: { v: "#e6e9f2", V: "#9aa0b8", ...SKIN.tan, h: "#ffc857", H: "#c98a2a", b: "#ffc857", B: "#c98a2a", g: "#5b6078", l: "#38f6ff", L: "#e6feff", j: "#2a2440",
      m: "#1d1830", M: "#0d0a18", c: "#8f5cff", C: "#5a34b8", z: "#d0c0ff", t: "#ff4fd8", x: "#5a4038" },
    grid: () => compose(base([BROWS("m"), ...EYES(), NOSE, ["k", [14, 19], [15, 20], [16, 20], [17, 19]], ["x", [21, 16], [22, 16], [22, 17], [10, 18]]],
      STACHE.handlebar, [SEAMS], [GOGGLES]), "mechanical/goggles"),
  },
  {
    // Trucker cap (white front, pink bill) with wrench logo, grey walrus, mint coveralls; screwdriver.
    name: "trucker",
    pal: { v: "#e6e9f2", V: "#9aa0b8", ...SKIN.deep, h: "#ff4fd8", H: "#b52a95", b: "#ff4fd8", B: "#b52a95", l: "#f6f3ff", L: "#ff4fd8", m: "#c9c6d4", M: "#8a8798",
      c: "#4df7a6", C: "#22a86b", z: "#f6f3ff", t: "#1f4f5a", q: "#ffc857", Q: "#c98a2a" },
    grid: () => compose(base([BROWS("m"), ...EYES(), NOSE, ["k", ...run(14, 17, 20)]], STACHE.walrus,
      [MESH, TRUCKER, LOGO.wrench], [SCREWDRIVER]), "mechanical/trucker"),
  },
  {
    // Cyan cap with star, bushy ginger mustache, gold coveralls; blowtorch with a cyan flame.
    name: "torch",
    pal: { v: "#e6e9f2", V: "#9aa0b8", ...SKIN.brown, h: "#38c8ff", H: "#1f7fb0", b: "#38c8ff", B: "#1f7fb0", l: "#f6f3ff", m: "#ff8a3d", M: "#c25a1e",
      c: "#ffc857", C: "#c98a2a", z: "#fff3c8", t: "#1f7fb0", q: "#ff3d6e", Q: "#ffb0c0", f: "#38f6ff", F: "#e6feff" },
    grid: () => compose(base([BROWS("m"), ...EYES(), NOSE, ["k", [14, 20], [15, 21], [16, 21], [17, 20]]], STACHE.bushy, [SEAMS, LOGO.star], [TORCH]), "mechanical/torch"),
  },
];

export const ring = "#ff8a3d";
