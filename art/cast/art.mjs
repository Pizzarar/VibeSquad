// art: two kinds. Paint-splattered beret artist staring straight at you (0, 1) and a figure made
// entirely of paint with cartoon eyes perched on top (2, 3).
import { compose, dots, flip, run } from "./lib.mjs";
import { SKIN } from "./lib.mjs";
import { BODY, EARS, FACE_SHADE, HEAD } from "./parts.mjs";

// Big floppy beret slouching down over the viewer's right, nub on top.
const BERET = { x: 5, y: 2, ol: true, g: [
  "........hh...........",
  "....hhhhhhhhhh.......",
  "..hhhhhhhhhhhhhhh....",
  ".hhhhhhhhhhhhhhhhhh..",
  "hhhhhhhhhhhhhhhhhhhh.",
  "hhhhhhhhhhhhhhhhhhhhh",
  ".HHHhhhhhhhhhhhhhhhhh",
  "....HHHHHHhhhhhhhhhhH",
  "..........HHHHhhhhhH.",
  "..............HHHH...",
] };
// Wide staring eyes: 4x4 sclera, 2x2 pupil dead centre, dark lid on top.
const STARE = [
  ["w", ...[12, 13, 14, 15].flatMap((y) => [...run(10, 13, y), ...run(18, 21, y)])],
  ["e", [11, 13], [12, 13], [11, 14], [12, 14], [19, 13], [20, 13], [19, 14], [20, 14]],
  ["k", ...run(10, 13, 11), [9, 12], [22, 12]],
];
// Chunky splat: 3-5px blob.
const splat = (ch, x, y, big = false) => [ch, [x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1], ...(big ? [[x + 2, y], [x - 1, y + 1], [x + 1, y + 2]] : [[x + 2, y + 1]])];

// Bold paint streak running from under one eye down the cheek.
const FACE_PAINT_L = (ch) => [ch, [9, 13], [9, 14], [9, 15], [8, 16], [9, 16], [10, 16], [9, 17], [10, 17], [11, 17], [10, 18]];
const FACE_PAINT_R = (ch) => [ch, ...FACE_PAINT_L(ch).slice(1).map(([x, y]) => [31 - x, y])];

const BRUSH = { x: 24, y: 12, ol: true, g: [
  ".pp.",
  "pppp",
  ".pp.",
  ".gg.",
  ".jj.",
  ".jj.",
  ".jj.",
  "ssss",
  "sssn",
  "sss.",
] };
const PALETTE = { x: 19, y: 20, ol: true, g: [
  "..qqqqqqq..",
  ".qppqqyyqq.",
  "qqppqqyyqqq",
  "qqqqqqqqbbq",
  "qvvqq..qbbq",
  ".qvvqqqqqq.",
  "...qqqqq...",
] };

// Paint figure: lumpy rounded dollop, wide puddle base, eyes perched on the crown.
const BLOB = { x: 2, y: 11, ol: true, g: [
  ".......pppppppppp...........",
  ".....pppppppppppppp.........",
  "....ppppppppppppppppppp.....",
  "...pppppppppppppppppppppp...",
  "...pppppppppppppppppppppp...",
  "..pppppppppppppppppppppppp..",
  "..pppppppppppppppppppppppp..",
  "..pppppppppppppppppppppppp..",
  "..pppppppppppppppppppppppp..",
  "..ppppppppppppppppppppppppp.",
  "..ppppppppppppppppppppppppp.",
  "..ppppppppppppppppppppppppp.",
  "..ppppppppppppppppppppppppp.",
  ".pppppppppppppppppppppppppp.",
  ".pppppppppppppppppppppppppp.",
  ".ppppppppppppppppppppppppppp",
  "pppppppppppppppppppppppppppp",
  "pppppppppppppppppppppppppppp",
  ".pppppppppppppppppppppppppp.",
  "..ppppppp..pppppppppp..pppp.",
  "...ppppp....pppppppp....pp..",
] };
const PUDDLE = [
  { x: 0, y: 28, ol: true, g: ["pp", "pp"] },
  { x: 29, y: 29, ol: true, g: ["pp", "pp"] },
];
const BIG_EYE = [".wwww.", "wwwwww", "wwwwww", "wwweew", "wwweew", "wwwwww", ".wwww."];
const SMALL_EYE = [".ww.", "wwww", "weew", "weew", ".ww."];
const blobShade = ["P", ...run(24, 25, 20), ...run(24, 26, 23), ...run(25, 27, 26), ...run(22, 28, 28), ...run(0, 31, 29), ...run(0, 31, 30), ...run(0, 31, 31)];
const blobGloss = ["L", [9, 17], [8, 18], [8, 19], [7, 21], [7, 22], [10, 15], [11, 14]];
// Wide open grin with tongue.
const GRIN = ["o", ...run(10, 19, 19), ...run(11, 18, 20), ...run(13, 16, 21)];
const TONGUE = ["t", ...run(14, 16, 21), [13, 21]];

export const variants = [
  {
    name: "beret-pink",
    pal: { ...SKIN.light, h: "#ff4fd8", H: "#b52a95", y: "#ffe14d", c: "#2fb4e8", C: "#1d7aa6",
      p: "#38f6ff", g: "#c9ccd8", j: "#8f5cff", v: "#8f5cff", P: "#ff4fd8", b: "#38f6ff" },
    grid: () => compose([
      BODY, ...EARS, HEAD, dots(FACE_SHADE),
      // Blond hair sticking out under the beret's high side.
      { x: 7, y: 9, ol: true, g: ["yyy", "yy.", "y.."] },
      dots(...STARE, ["k", ...run(18, 21, 11)], ["o", ...run(14, 17, 19)], ["S", [15, 16], [16, 17]],
        FACE_PAINT_L("b"), splat("P", 20, 17, true),
        splat("P", 4, 26, true), splat("p", 11, 29, true), splat("v", 18, 26, true), splat("P", 21, 30), splat("v", 7, 30)),
      BERET,
      BRUSH,
    ], "art/beret-pink"),
  },
  {
    name: "beret-stripes",
    pal: { ...SKIN.brown, h: "#38c8ff", H: "#1f7fb0", c: "#f6f3ff", C: "#c9c4dc", x: "#3a4270",
      q: "#f0a050", p: "#ff4fd8", y: "#ffe14d", b: "#38f6ff", v: "#8f5cff", D: "#14101e" },
    grid: () => compose([
      BODY,
      dots(["x", ...run(2, 29, 26), ...run(2, 29, 28), ...run(2, 29, 30)]),
      ...EARS, HEAD, dots(FACE_SHADE),
      // Dark curls under the beret's high side.
      { x: 6, y: 9, ol: true, g: ["DDD", "DD.", "DD.", "D.."] },
      dots(...STARE, ["k", ...run(18, 21, 11)], ["o", ...run(13, 18, 19)], ["w", ...run(14, 17, 19)], ["S", [15, 16], [16, 17]],
        FACE_PAINT_R("p"), splat("b", 9, 17, true),
        splat("p", 5, 27, true), splat("y", 12, 29, true), splat("v", 15, 25)),
      BERET,
      PALETTE,
    ], "art/beret-stripes"),
  },
  {
    name: "paint-pink",
    pal: { p: "#ff4fd8", P: "#c22f9e", L: "#ffc2f0", y: "#ffe14d", b: "#38f6ff", t: "#ff8a9a" },
    grid: () => compose([
      BLOB, ...PUDDLE,
      { ...dots(blobShade), clip: true },
      dots(blobGloss, GRIN, TONGUE, ["r", [7, 17], [8, 17], [21, 17], [22, 17]],
        splat("y", 5, 25), splat("y", 19, 27), splat("b", 23, 15)),
      { x: 7, y: 6, ol: true, g: BIG_EYE },
      { x: 17, y: 8, ol: true, g: SMALL_EYE },
      { x: 1, y: 13, ol: true, g: ["yy", "yy"] },
      { x: 27, y: 8, ol: true, g: ["bb", "bb"] },
    ], "art/paint-pink"),
  },
  {
    name: "paint-swirl",
    pal: { p: "#38c8ff", P: "#1f7fb0", L: "#d8f7ff", q: "#8f5cff", Q: "#5a34b8", y: "#ffc857", t: "#ff8a9a", r: "#ff9ef0" },
    grid: () => compose([
      { ...BLOB, g: flip(BLOB.g) }, ...PUDDLE,
      // Violet swirl band wrapping the dollop.
      dots(["q", ...run(4, 9, 23), ...run(9, 15, 24), ...run(15, 22, 25), ...run(22, 28, 26), ...run(3, 8, 24), ...run(8, 14, 25), ...run(14, 21, 26), ...run(21, 28, 27)],
        ["Q", ...run(3, 7, 25), ...run(7, 13, 26), ...run(13, 20, 27), ...run(20, 28, 28)]),
      { ...dots(["P", ...blobShade.slice(1).filter((p) => p[1] < 23 || p[1] > 28).map(([x, y]) => [31 - x, y])]), clip: true },
      dots(["L", [22, 17], [23, 18], [23, 19], [24, 21], [21, 15], [20, 14]],
        ["o", ...run(12, 19, 19), ...run(13, 18, 20), ...run(14, 17, 21)], ["w", [13, 19], [18, 19]], ["r", [9, 17], [23, 17]], splat("y", 7, 28)),
      { x: 10, y: 8, ol: true, g: flip(SMALL_EYE) },
      { x: 18, y: 6, ol: true, g: flip(BIG_EYE) },
      { x: 2, y: 9, ol: true, g: ["yy", "yy"] },
      { x: 28, y: 14, ol: true, g: ["qq", "qq"] },
    ], "art/paint-swirl"),
  },
];

export const ring = "#ff4fd8";
