// retired-lead: old guy on permanent vacation. Bucket hat, sunglasses pushed up, hawaiian shirt, drink.
import { compose, dots, run, sym, SKIN } from "./lib.mjs";
import { BODY, EARS, EYES, FACE_SHADE, HEAD } from "./parts.mjs";

const BUCKET = {
  x: 4,
  y: 1,
  ol: true,
  g: sym([
    "......hhhhhh",
    ".....hhhhhhh",
    "....hhhhhhhh",
    "....hhhhhhhh",
    "....hhhhhhhh",
    "....hhhhhhhh",
    "....bbbbbbbb",
    ".Hhhhhhhhhhh",
    "HHHHHHHHHHHH",
  ]),
};
const SHADES_UP = { x: 10, y: 4, ol: true, g: ["LllllkkLllll", ".llll..llll."] };

// Flowers on the shirt: plus of petals around a centre.
const flowers = (petal, centre, at) => [
  [petal, ...at.flatMap(([x, y]) => [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]])],
  [centre, ...at],
];
const SHIRT_AT = [[5, 27], [10, 30], [8, 25], [21, 27], [16, 30], [3, 30]];

const DRINKS = {
  cocktail: { x: 23, y: 16, ol: true, g: [
    "..uuu..",
    ".uUuUu.",
    ".ddddd.",
    ".dDDDd.",
    ".dDDDd.",
    ".dDDDd.",
    "sssssd.",
    "sSssss.",
    "sssss..",
  ] },
  coconut: { x: 23, y: 16, ol: true, g: [
    ".....y.",
    "....y..",
    ".DDDDD.",
    "dDDDDDd",
    "ddddddd",
    "ddddddd",
    "sssssd.",
    "sSssss.",
    "sssss..",
  ] },
  tea: { x: 23, y: 16, ol: true, g: [
    "....yy.",
    ".dddyy.",
    ".dDDDd.",
    ".dwDDd.",
    ".dDDDd.",
    ".dDDDd.",
    "sssssd.",
    "sSssss.",
    "sssss..",
  ] },
  mug: { x: 23, y: 18, ol: true, g: [
    "DDDDD..",
    "ddddddd",
    "dpddd.d",
    "ddddddd",
    "sssssd.",
    "sSssss.",
    "sssss..",
  ] },
};

// Full white beard, tapered to a rounded point.
const BEARD = { x: 7, y: 16, ol: true, g: sym([
  "mm.......",
  "mmm......",
  "mmmm.....",
  ".mmmmmmmm",
  ".mmmmmmmm",
  "..Mmmmmmm",
  "...MMmmmm",
  "....MMMmm",
  "......MMM",
]) };

// Big open toothy grin: lip line, teeth, mouth.
const GRIN = (y = 17) => [
  ["k", ...run(12, 19, y), [11, y + 1], [20, y + 1], [12, y + 2], [19, y + 2], ...run(13, 18, y + 3)],
  ["w", ...run(12, 19, y + 1)],
  ["o", ...run(13, 18, y + 2)],
];
const BROWS = (ch) => [ch, ...run(10, 13, 11), ...run(18, 21, 11)];
const NOSE = ["n", [15, 15], [16, 15], [15, 16], [16, 16]];
const UNDER_BRIM = dots(["S", ...run(8, 23, 11)]);

const base = (face, extra = []) => [BODY, ...EARS, HEAD, dots(FACE_SHADE), UNDER_BRIM, ...face, BUCKET, ...extra];

export const variants = [
  {
    // Clean-shaven, laughing squint, huge grin.
    name: "cocktail",
    pal: { ...SKIN.light, h: "#ffc857", H: "#c98a2a", i: "#fff0b0", b: "#ff4fd8", l: "#38f6ff", L: "#e6feff",
      c: "#ff4fd8", C: "#b52a95", f: "#ffe14d", F: "#ff8a3d", m: "#f4f1fb",
      d: "#d9f6ff", D: "#ff9d3a", u: "#4df7a6", U: "#1f9e66" },
    grid: () => compose([
      ...base([
        dots(BROWS("m"), ...EYES.squint(13), NOSE, ...GRIN(17), ["r", [9, 16], [10, 16], [21, 16], [22, 16]], ["S", [9, 14], [22, 14]]),
      ]),
      dots(...flowers("f", "F", SHIRT_AT)),
      SHADES_UP,
      dots(["i", [11, 2], [12, 2], [10, 3]]),
      DRINKS.cocktail,
    ], "retired-lead/cocktail"),
  },
  {
    // Big white beard with a toothy smile peeking out.
    name: "coconut",
    pal: { ...SKIN.tan, h: "#38c8ff", H: "#1f7fb0", i: "#d8f7ff", b: "#ffc857", l: "#ff4fd8", L: "#ffd0f4",
      c: "#2fd3c0", C: "#16877b", f: "#ff4fd8", F: "#ffe14d", m: "#f4f1fb", M: "#b9b4cc",
      d: "#8a5a34", D: "#fff6e0", y: "#ff4fd8" },
    grid: () => compose([
      ...base([dots(BROWS("m"), ...EYES.dot(13), NOSE)]),
      BEARD,
      dots(["k", ...run(13, 18, 18), [12, 19], [19, 19]], ["w", ...run(13, 18, 19)], ["o", ...run(14, 17, 20)], NOSE),
      dots(...flowers("f", "F", SHIRT_AT)),
      SHADES_UP,
      dots(["i", [11, 2], [12, 2], [10, 3], [15, 4], [20, 5], [9, 6], [22, 3]]),
      DRINKS.coconut,
    ], "retired-lead/coconut"),
  },
  {
    // Goatee, raised eyebrow, gap-tooth grin.
    name: "iced-tea",
    pal: { ...SKIN.brown, h: "#e8c27a", H: "#a9803e", i: "#fff0c4", b: "#c28cff", l: "#ff4fd8", L: "#ffd0f4",
      c: "#8f5cff", C: "#5a34b8", f: "#f6f3ff", F: "#ffc857", m: "#d9d6e4", M: "#9a96aa",
      d: "#d9f6ff", D: "#ffa733", y: "#ffe14d" },
    grid: () => compose([
      ...base([
        dots(["m", ...run(10, 13, 12), ...run(18, 21, 11)], ...EYES.dot(13), NOSE, ...GRIN(17),
          ["o", [16, 18]], ["m", ...run(14, 17, 21), ...run(14, 17, 22), [15, 23], [16, 23]], ["S", [9, 15], [22, 15]]),
      ]),
      dots(...flowers("f", "F", SHIRT_AT)),
      SHADES_UP,
      dots(["H", [12, 3], [16, 4], [19, 2], [9, 5], [22, 5], [14, 6]]),
      DRINKS.tea,
    ], "retired-lead/iced-tea"),
  },
  {
    // Walrus mustache over the grin, cheeky wink.
    name: "mug",
    pal: { ...SKIN.light, h: "#4df7a6", H: "#22a86b", i: "#d4ffe9", b: "#ff8573", l: "#ffc857", L: "#fff3c8",
      c: "#ff8a3d", C: "#b8551a", f: "#38f6ff", F: "#f6f3ff", m: "#d9d6e4", M: "#9a96aa",
      d: "#f6f3ff", D: "#6b3b1e", p: "#ff4fd8" },
    grid: () => compose([
      ...base([
        dots(BROWS("m"), ["e", [11, 13], [12, 13], [11, 14], [12, 14], ...run(18, 21, 14)], ["w", [11, 13]], NOSE,
          ["k", [12, 18], [19, 18], ...run(13, 18, 20)], ["w", ...run(13, 18, 18)], ["o", ...run(13, 18, 19)],
          ["r", [9, 16], [22, 16]]),
        // walrus mustache, drooping past the mouth corners
        { x: 10, y: 16, g: ["..mmmmmmmm..", ".mmmmMMmmmm.", "mmM......Mmm", "mM........Mm"] },
      ]),
      dots(...flowers("f", "F", SHIRT_AT)),
      SHADES_UP,
      dots(["i", [11, 2], [12, 2], [10, 3]]),
      DRINKS.mug,
    ], "retired-lead/mug"),
  },
];

export const ring = "#ffc857";
