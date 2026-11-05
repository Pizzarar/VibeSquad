// lead: our own candy-headed ringleader. Round glossy hard-candy head (a different candy per variant), tall top hat,
// huge grin, lanky pinstripe suit with bow tie and white gloves; cane / mic / lollipop sceptre / golden ticket.
import { compose, dots, ellipse, paint, run, sym } from "./lib.mjs";

// Round candy head, cols 7-24, rows 8-23.
const HEAD = { ...ellipse(16, 15.5, 9, 8, "s"), ol: true };
// Glossy shading: shadow crescent lower right, shine spot upper left.
const SHADE = paint(HEAD, (x, y) => ((x + 0.5 - 16) / 9 + (y + 0.5 - 15.5) / 8 > 0.95 ? "S" : null));
const SHINE = dots(["i", [10, 11], [11, 11], [10, 12], [9, 13]]);

// Wrapper twists either side of the head (bonbon).
const WRAP_L = ["ff...", "fff..", "ffff.", "FFff.", "FFFff", "FFff.", "ffff.", "fff..", "ff..."];
// Right twist trimmed to 2px so the sceptre stick clears it.
const WRAP = [
  { x: 2, y: 11, ol: true, g: WRAP_L },
  { x: 25, y: 12, ol: true, g: ["ff", "ff", "fF", "fF", "fF", "ff", "ff"] },
];

// Tall top hat, flared crown, band, wide brim resting on the head.
// Brim sits low (rows 9-10) so the crown stands tall; v = rim highlight along the crown's top and left edge.
const HAT = { x: 6, y: 0, ol: true, g: sym([
  "...hhhhhhh",
  "....hhhhhh",
  "....hhhhhh",
  "....hhhhhh",
  "....hhhhhh",
  "....hhhhhh",
  "....bbbbbb",
  "....bbbbbb",
  "....hhhhhh",
  "hhhhhhhhhh",
  ".HHHHHHHHH",
]) };
const HAT_SHINE = dots(["v", ...run(9, 14, 0), [10, 1], [10, 2], [10, 3], [10, 4], [10, 5], [10, 8], [6, 9], [7, 9], [8, 9]]);

// Lanky suit: narrow sloped shoulders, satin lapels L, shirt w.
const SUIT = { x: 4, y: 23, ol: true, g: sym([
  "........wwww",
  "......ccLwww",
  "....ccccLLww",
  "..ccccccLLww",
  ".cccccccLLLw",
  "ccccccccLLLw",
  "cccccccccLLw",
  "cccccccccLLw",
  "ccccccccccLw",
]) };
const PINSTRIPE = paint(SUIT, (x, y, ch) => (ch === "c" && x % 3 === 1 ? "p" : null));
const BOW = { x: 13, y: 23, g: ["tt..tt", "ttTTtt", "tt..tt"] };

// Faces: brows, tall oval eyes with glint, crescent grin with teeth + tongue.
const EYES = (glint = "w") => [
  ["e", [11, 12], [12, 12], [11, 13], [12, 13], [11, 14], [12, 14], [19, 12], [20, 12], [19, 13], [20, 13], [19, 14], [20, 14]],
  [glint, [11, 12], [19, 12]],
];
// The brim's outline doubles as the brow line; inner brow tips only.
const BROWS = ["e", [13, 11], [18, 11]];
const WINK = [
  ["e", [11, 12], [12, 12], [11, 13], [12, 13], [11, 14], [12, 14], [18, 13], [19, 13], [20, 13], [21, 13], [19, 14], [20, 14]],
  ["w", [11, 12]],
];
const GRIN = { x: 9, y: 16, g: [
  "kkkkkkkkkkkkkk",
  "kwwwwwwwwwwwwk",
  ".kwwwwwwwwwwk.",
  "..kkoooooukk..",
  "....kkkkkk....",
] };
const CHEEKS = ["r", [8, 16], [23, 16]];

// White-gloved right hand, at the bottom right.
const GLOVE = { x: 22, y: 25, ol: true, g: ["gggggg", "gGgggg", "gggggg", "ggggg."] };

const CANE = { x: 23, y: 9, ol: true, g: [
  ".qqqq",
  "qQ..q",
  "qq..q",
  "....q",
  "....Q",
  "....q",
  "....Q",
  "....q",
  "....Q",
  "....q",
  "....Q",
  "....q",
  "....Q",
  "....q",
  "....Q",
  "....q",
] };
const MIC = { x: 23, y: 15, ol: true, g: [
  ".mmmm.",
  "mMmMmm",
  "mmMmMm",
  ".mmmm.",
  "..jj..",
  "..jj..",
  "..jj..",
  "..jj..",
  "..jj..",
  "..jj..",
] };
const POP = { x: 24, y: 4, ol: true, g: [
  "..qqqq..",
  ".qQQqqq.",
  "qQqqQQqq",
  "qQqQqQqq",
  "qqQqqQqq",
  ".qqQQqq.",
  "..qqqq..",
  "...jj...",
  "...jj...",
  "...jj...",
  "...jj...",
  "...jj...",
  "...jj...",
  "...jj...",
  "...jj...",
  "...jj...",
  "...jj...",
] };
const TICKET = { x: 22, y: 18, ol: true, g: [
  "qqqqqqqq",
  "qQQQQQQq",
  "qQqqqqQq",
  "qQQQQQQq",
  "qqqqqqqq",
] };

const base = (head, face, prop, opts = {}) => [
  SUIT, PINSTRIPE, BOW,
  ...(opts.wrap ? WRAP : []),
  HEAD, ...head, SHADE, SHINE,
  dots(...face, CHEEKS), GRIN,
  HAT, HAT_SHINE,
  ...(opts.behind ? [prop, GLOVE] : [GLOVE, prop]),
];

export const variants = [
  {
    // Candy-cane striped head, plum hat with hot-pink band; red-and-white cane.
    name: "cane",
    pal: { s: "#f6f3ff", S: "#c9c2e0", i: "#ffffff", d: "#ff3d6e",
      h: "#4a2a5e", H: "#2a1638", v: "#9a6ab8", b: "#ff4fd8", c: "#5a2a9a", p: "#8a5ad0", L: "#ff4fd8", t: "#ffc857", T: "#c98a2a",
      g: "#f6f3ff", G: "#c9c2e0", q: "#ff3d6e", Q: "#f6f3ff", u: "#ff4fd8", e: "#14101e" },
    grid: () => compose(base([paint(HEAD, (x, y) => ((x + y) % 6 < 2 && !(y >= 11 && y <= 15 && ((x >= 10 && x <= 13) || (x >= 18 && x <= 21))) ? "d" : null))], [BROWS, ...EYES()], CANE, { behind: true }), "lead/cane"),
  },
  {
    // Lime gumdrop, sugar sparkles, violet hat with yellow band; stage mic.
    name: "mic",
    pal: { s: "#7dff6a", S: "#2fb84e", i: "#efffe0", d: "#d8ffd0",
      h: "#5a2a9a", H: "#36185e", v: "#a07ae0", b: "#ffe14d", c: "#1f5fa0", p: "#4a90d8", L: "#38f6ff", t: "#ff4fd8", T: "#b52a95",
      g: "#f6f3ff", G: "#c9c2e0", m: "#c9ccd8", M: "#6b7090", j: "#3a3e52", u: "#ff4fd8", e: "#14101e" },
    grid: () => compose(base([dots(["d", [14, 9], [19, 10], [9, 16], [22, 13], [16, 22], [21, 19], [13, 21], [17, 10]])], [BROWS, ...EYES()], MIC), "lead/mic"),
  },
  {
    // Wrapped orange bonbon with cyan wrapper twists, teal hat; swirl-pop sceptre.
    name: "sceptre",
    pal: { s: "#ffa733", S: "#d9661e", i: "#fff3c8", f: "#38f6ff", F: "#1fa3c8",
      h: "#1f6f80", H: "#134a56", v: "#5ab8c8", b: "#ffc857", c: "#a0285a", p: "#d85a8a", L: "#ffc857", t: "#38f6ff", T: "#1fa3c8",
      g: "#f6f3ff", G: "#c9c2e0", q: "#ff4fd8", Q: "#ffe14d", j: "#f6f3ff", u: "#ff4fd8", e: "#14101e" },
    grid: () => compose(base([], [BROWS, ...WINK], POP, { wrap: true, behind: true }), "lead/sceptre"),
  },
  {
    // Layered jawbreaker (violet, pink + cyan bands below the grin), slate hat with gold band; golden ticket.
    name: "ticket",
    pal: { s: "#c28cff", S: "#7a4ad0", i: "#f4ecff", d: "#ff4fd8", D: "#38f6ff",
      h: "#3a4a6a", H: "#222c44", v: "#7a8ab0", b: "#ffc857", c: "#1f7a6a", p: "#4ab89e", L: "#ffc857", t: "#ff4fd8", T: "#b52a95",
      g: "#f6f3ff", G: "#c9c2e0", q: "#ffc857", Q: "#c98a2a", u: "#ff4fd8", e: "#14101e" },
    grid: () => compose(base([paint(HEAD, (x, y) => (y === 21 ? "d" : y >= 22 ? "D" : null))],
      [BROWS, ...EYES("w")], TICKET), "lead/ticket"),
  },
];

export const ring = "#ff4fd8";
