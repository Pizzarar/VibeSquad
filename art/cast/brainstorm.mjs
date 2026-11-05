// brainstorm: the ideas person. Big chunky over-ear headphones on every variant (band over the hair, cups over the ears).
// Dreamer with starry eyes, lightbulb kid, bubblegum bob, eyes-closed vibing with music notes.
import { compose, dots, ellipse, run, sym, SKIN } from "./lib.mjs";
import { BODY, EARS, FACE_SHADE, HEAD } from "./parts.mjs";

// Band arc (p) from cup to cup over the top of the head, cups p shell / P trim / q pad / Q glint. Cups cols 3-7 + 24-28.
const PHONES = { x: 3, y: 2, ol: true, g: sym([
  ".......pppppp",
  ".....pppp....",
  "....pp.......",
  "...pp........",
  "...pp........",
  "..pp.........",
  "..pp.........",
  ".ppp.........",
  "PPPPP........",
  "PqqqP........",
  "PqQqP........",
  "PqqqP........",
  "PqqqP........",
  "PqqqP........",
  "PPPPP........",
]) };

const HAIR = {
  // Big fluffy cloud of hair behind the head + jagged fringe.
  cloudBack: { ol: true, g: [[16, 10, 10, 8], [8, 7, 4.5, 4.5], [14, 4.5, 5, 4], [20, 5, 5, 4], [25, 8, 4.5, 4.5], [5, 12, 3.5, 4], [27, 12, 3.5, 4]]
    .map(([cx, cy, rx, ry]) => ellipse(cx, cy, rx, ry, "a").g)
    .reduce((a, b) => a.map((r, y) => [...r].map((ch, x) => (ch === "." ? b[y][x] : ch)).join(""))) },
  cloudFringe: { x: 7, y: 7, ol: true, g: sym(["..aaaaaaa", ".aaaaaaaa", "aaaaaaaaa", "aAaaAaaAa", "A..A..A.."]) },
  spiky: { x: 7, y: 3, ol: true, g: sym([
    "...a....a",
    "..aa...aa",
    "..aaa.aaa",
    ".aaaaaaaa",
    "aaaaaaaaa",
    "aaaaaaaaa",
    "aaaaaaaaa",
    "aAaaAaaaa",
    "A..A..AAa",
  ]) },
  bobBack: { x: 5, y: 5, ol: true, g: sym([
    "....aaaaaaa",
    "..aaaaaaaaa",
    ".aaaaaaaaaa",
    "aaaaaaaaaaa",
    "aaaaaaaaaaa",
    "aaaaaaaaaaa",
    "aaaaaaaaaaa",
    "aaaaaaaaaaa",
    "aaaaaaaaaaa",
    "aaaaaaaaaaa",
    "aaaaaaaaaaa",
    "aaaaaaaaaaa",
    "AAAAAaaaaaa",
    ".AAAA......",
  ]) },
  bobFringe: { x: 7, y: 6, ol: true, g: sym(["...aaaaaa", ".aaaaaaaa", "aaaaaaaaa", "aaaaaaaaa", "aaaaaaaaa", "AAAAAAAAA"]) },
  beanie: { x: 7, y: 3, ol: true, g: sym([
    "....aaaaa",
    "..aaaaaaa",
    ".aaaaaaaa",
    "aaaaaaaaa",
    "aaaaaaaaa",
    "AAAAAAAAA",
    "AaAaAaAaA",
    "AAAAAAAAA",
  ]) },
};

const NOSE = ["n", [15, 16], [16, 16]];
const SMILE = ["k", [12, 18], [19, 18], ...run(13, 18, 19)];
const OPEN = (y = 18) => [
  ["k", ...run(12, 19, y), [12, y + 1], [19, y + 1], ...run(13, 18, y + 2)],
  ["w", ...run(13, 18, y + 1)],
];
const BIG_EYES = (glint) => [
  ["e", ...[12, 13, 14].flatMap((y) => [[11, y], [12, y], [19, y], [20, y]])],
  [glint, [11, 12], [19, 12], [12, 14], [20, 14]],
];
const HAPPY_SHUT = ["e", [10, 14], [11, 13], [12, 13], [13, 14], [18, 14], [19, 13], [20, 13], [21, 14]];
const BULB = { x: 22, y: 13, ol: true, g: [
  ".yyyy.",
  "yYYyyy",
  "yYyyyy",
  "yyyyyy",
  ".yyyy.",
  "..gg..",
  "..GG..",
  "..gg..",
  "sssss.",
  "sSssss",
  "ssss..",
] };
const BUBBLE = { ...ellipse(16, 20.5, 4.5, 4, "u"), ol: true };
// Note glyphs: head + stem + flag.
const note = (x, y) => [[x, y + 3], [x + 1, y + 3], [x, y + 4], [x + 1, y + 4], [x + 1, y], [x + 1, y + 1], [x + 1, y + 2], [x + 2, y]];

const base = (back, front, face, extra = []) => [
  BODY, ...(back ? [back] : []), ...EARS, HEAD, dots(FACE_SHADE), ...face, ...(front ? [front] : []), PHONES, ...extra,
];

export const variants = [
  {
    // Fluffy violet cloud hair, starry eyes, open smile; hot-pink cans; sparkles.
    name: "dreamer",
    pal: { ...SKIN.tan, a: "#8f5cff", A: "#5a34b8", p: "#ff4fd8", P: "#b52a95", q: "#38f6ff", Q: "#e6feff",
      c: "#ffc857", C: "#c98a2a", y: "#ffe14d" },
    grid: () => compose(base(HAIR.cloudBack, HAIR.cloudFringe,
      [dots(["n", [15, 16], [16, 16]], ...BIG_EYES("y"), ...OPEN(18), ["r", [9, 16], [10, 16], [21, 16], [22, 16]])],
      [dots(["y", [1, 3], [0, 4], [1, 4], [2, 4], [1, 5], [29, 20], [30, 21], [29, 22], [28, 21], [29, 21]])]), "brainstorm/dreamer"),
  },
  {
    // Spiky black hair, wide eyes, lightbulb idea in hand; yellow cans, cyan hoodie.
    name: "lightbulb",
    pal: { ...SKIN.light, a: "#2a2440", A: "#14101e", p: "#ffc857", P: "#c98a2a", q: "#ff4fd8", Q: "#ffd0f4",
      c: "#38c8ff", C: "#1f7fb0", y: "#fff3a0", Y: "#ffffff", g: "#c9ccd8", G: "#8a8ea4" },
    grid: () => compose(base(null, HAIR.spiky,
      [dots(NOSE, ...BIG_EYES("w"), ["e", ...run(10, 13, 11), ...run(18, 21, 10)], ...OPEN(18))],
      [BULB, dots(["y", [29, 9], [30, 8], [26, 9], [31, 12]], ["k", [15, 25], [16, 25], [15, 26], [16, 26], [15, 27]])]), "brainstorm/lightbulb"),
  },
  {
    // Dark teal bob with bangs, side glance, pink bubblegum bubble; lime cans.
    name: "bubblegum",
    pal: { ...SKIN.brown, a: "#1f4f5a", A: "#123038", p: "#4df7a6", P: "#22a86b", q: "#8f5cff", Q: "#e0d0ff",
      c: "#ff8a3d", C: "#b8551a", u: "#ff8fd8", U: "#ffe0f6" },
    grid: () => compose(base(HAIR.bobBack, HAIR.bobFringe,
      [dots(NOSE, ["e", [12, 13], [13, 13], [12, 14], [13, 14], [20, 13], [21, 13], [20, 14], [21, 14]], ["w", [12, 13], [20, 13]])],
      [BUBBLE, dots(["U", [13, 18], [14, 18], [13, 19]])]), "brainstorm/bubblegum"),
  },
  {
    // Orange beanie, eyes shut and grinning, music notes floating; violet cans.
    name: "vibing",
    pal: { ...SKIN.deep, a: "#ff8a3d", A: "#c25a1e", p: "#8f5cff", P: "#5a34b8", q: "#4df7a6", Q: "#d4ffe9",
      c: "#2fd3c0", C: "#16877b", y: "#38f6ff" },
    grid: () => compose(base(null, HAIR.beanie,
      [dots(NOSE, HAPPY_SHUT, ...OPEN(18), ["r", [9, 16], [22, 16]])],
      [dots(["y", ...note(0, 1), ...note(28, 19)])]), "brainstorm/vibing"),
  },
];

export const ring = "#8f5cff";
