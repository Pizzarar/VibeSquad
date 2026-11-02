// review: fedora investigator. Wide low brim shades the eyes, collar up, trench coat; magnifier / notepad / monocle.
import { compose, dots, flip, run, sym, SKIN } from "./lib.mjs";
import { EARS, FACE_SHADE, HEAD } from "./parts.mjs";

// Pinched crown, wide brim that dips at the front over the brows.
const FEDORA = {
  x: 4,
  y: 1,
  ol: true,
  g: sym([
    ".......hhhh.",
    "......hhhhhh",
    ".....hhhhhhh",
    "....hhhhhhhh",
    "....hhhhhhhh",
    "....hhhhhhhh",
    "....bbbbbbbb",
    "hhhhhhhhhhhh",
    ".HHHHHHHHHHH",
    "....HHHHHHHH",
  ]),
};

// Trench coat: c coat, C lapel, w shirt, t tie.
const COAT = {
  x: 2,
  y: 21,
  ol: true,
  g: sym([
    "..........wwwt",
    ".......cCCwwwt",
    "....ccccCCwwwt",
    "..ccccccCCCwwt",
    ".cccccccCCCCwt",
    "ccccccccccCCwt",
    "cccccccccccCCt",
    "cccccccccccCCt",
    "ccccccccccccCC",
    "ccccccccccccCC",
    "cccccccccccccC",
  ]),
};
// Popped collar flaring up past the jaw.
const COLLAR_L = ["C....", "CC...", "CCC..", "CCCC.", "CCCCC"];
const COLLAR = [
  { x: 4, y: 17, ol: true, g: COLLAR_L },
  { x: 23, y: 17, ol: true, g: flip(COLLAR_L) },
];

const BRIM_SHADE = dots(["S", ...run(7, 24, 11), ...run(8, 23, 12)]);
// Narrow, level stare.
const stare = (glint) => [
  ["e", ...run(10, 13, 13), ...run(18, 21, 13), [11, 14], [12, 14], [19, 14], [20, 14]],
  [glint, [12, 14], [19, 14]],
];
const NOSE = ["S", [16, 15], [16, 16], [15, 17]];

const MAGNIFIER = { x: 22, y: 14, ol: true, g: [
  ".gggg.",
  "gLLllg",
  "gLlllg",
  "gllllg",
  "gllllg",
  ".gggg.",
  "...jj.",
  "..sss.",
  ".sSsss",
  ".ssss.",
] };
// Spiral flip-pad with ruled lines, held up in the right hand.
const NOTEPAD = { x: 21, y: 15, ol: true, g: [
  "qwqwqwq",
  "wwwwwww",
  "wkkkkkw",
  "wwwwwww",
  "wkkkkww",
  "wwwwwww",
  "wkkkkkw",
  "sssswww",
  "sSsssww",
  "sssss..",
] };

const base = (extra, collar = true) => [COAT, ...EARS, HEAD, dots(FACE_SHADE), BRIM_SHADE, ...extra, FEDORA, ...(collar ? COLLAR : [])];

export const variants = [
  {
    // Stubbled jaw, hard stare, cyan glint; magnifying glass.
    name: "magnifier",
    pal: { ...SKIN.light, h: "#2b3a6b", H: "#18213f", b: "#38f6ff", c: "#c9a26b", C: "#8e6b3c", t: "#ff4fd8",
      g: "#ffc857", l: "#38f6ff", L: "#e6feff", j: "#6b3b1e", x: "#b08a78" },
    grid: () => compose(base([
      dots(...stare("l"), NOSE, ["k", ...run(14, 17, 19)], ["x", [11, 19], [13, 20], [17, 20], [19, 19], [15, 21], [10, 18], [21, 18]]),
      MAGNIFIER,
    ]), "review/magnifier"),
  },
  {
    // Ginger mustache, raised brow, open lapels (no popped collar); flip-pad.
    name: "notepad",
    pal: { ...SKIN.tan, h: "#8a5a34", H: "#5a3820", b: "#ffc857", c: "#6b7394", C: "#454b66", t: "#38f6ff",
      m: "#ff8a3d", M: "#c25a1e", q: "#8f8aa8" },
    grid: () => compose(base([
      dots(["e", ...run(10, 13, 14), [11, 15], [12, 15], ...run(18, 21, 13), [19, 14], [20, 14]], ["w", [12, 15], [19, 14]], NOSE,
        ["m", ...run(12, 19, 18), [11, 19], [12, 19], [19, 19], [20, 19]], ["M", ...run(13, 18, 19)]),
      NOTEPAD,
    ], false), "review/notepad"),
  },
  {
    // Glowing monocle, scar, flat mouth; collar up.
    name: "monocle",
    pal: { ...SKIN.deep, h: "#5a2a72", H: "#36184a", b: "#ff4fd8", c: "#2a2440", C: "#4a3f6e", t: "#ff4fd8",
      g: "#ff4fd8", l: "#ff9ef0", x: "#c9889a" },
    grid: () => compose(base([
      dots(...stare("w"), NOSE, ["k", ...run(13, 17, 19), [18, 18]], ["x", [10, 16], [11, 17], [12, 18]],
        // monocle over the right eye, chain to the collar
        ["g", ...run(18, 21, 12), [17, 13], [22, 13], [17, 14], [22, 14], ...run(18, 21, 15), [22, 16], [23, 17]],
        ["l", [19, 13], [20, 13], [21, 13], [20, 14], [21, 14]], ["e", [19, 14]]),
    ]), "review/monocle"),
  },
  {
    // Scarf over the lower face, glowing green eyes; gold badge.
    name: "masked",
    pal: { ...SKIN.light, h: "#3a3f4f", H: "#22252f", b: "#4df7a6", c: "#1f4f5a", C: "#2f7480", t: "#4df7a6",
      m: "#3c4a6e", M: "#283250", l: "#4df7a6", g: "#ffc857" },
    grid: () => compose([
      ...base([dots(...stare("l"), ["l", [11, 14], [20, 14]])]),
      { x: 7, y: 16, ol: true, g: sym(["mmmmmmmmm", "mmmmmmmmm", ".Mmmmmmmm", ".MMmmmMmm", "..MMmmmmm", "....MMMMM"]) },
      { x: 22, y: 19, ol: true, g: ["gggggg", "gwwwwg", "gggggg", "ssssg.", "sSsss.", "ssss.."] },
    ], "review/masked"),
  },
];

export const ring = "#38f6ff";
