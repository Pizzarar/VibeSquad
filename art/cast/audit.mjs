// audit: stealth operative. Big glowing green goggles on every variant (bright lens + pale glint + green glow spill),
// dark tactical gear with a chest strap; hood + mask, balaclava + visor, headset + slick hair, hood + scarf.
import { compose, dots, ellipse, run, sym, SKIN } from "./lib.mjs";
import { BODY, EARS, FACE_SHADE, HEAD } from "./parts.mjs";

const HOOD = { ...ellipse(16, 13.5, 12.5, 11.5, "h"), ol: true };
// Hood rim i catching light on the viewer's left.
const HOOD_RIM = ["i", [6, 6], [5, 7], [4, 8], [4, 9], [3, 10], [3, 11], [3, 12], [3, 13], [3, 14], [8, 4], [7, 5], [10, 3], [11, 3]];
// Hood front edge framing the face (drawn over the head).
const HOOD_FRONT = { x: 7, y: 7, ol: true, g: sym(["hhhhhhhhh", "hhhhhhhhh", "Hhhhhhhhh", "HH.......", "H........", "H........"]) };

// Twin round goggles: frame g, lens l, glint L; strap j to the edges.
const GOGGLES = { x: 8, y: 11, ol: true, g: sym([".gggggg.", "gLLllllg", "gLlllllg", "gllllllg", ".gggggg."]) };
const STRAP = dots(["j", [5, 13], [6, 13], [7, 13], [24, 13], [25, 13], [26, 13], [5, 14], [6, 14], [7, 14], [24, 14], [25, 14], [26, 14]]);
// One-piece visor bar.
const VISOR = { x: 7, y: 11, ol: true, g: sym(["ggggggggg", "gLLLLllll", "gllllllll", "ggggggggg"]) };

// Mask over the nose and mouth.
const MASK = { x: 7, y: 16, ol: true, g: sym(["mmmmmmmmm", "mmmmmmmmm", ".mmmmmmmm", ".Mmmmmmmm", "..MMmmmmm", "....MMMMM"]) };
const MASK_FOLD = ["M", ...run(12, 19, 18)];

const SLICK = { x: 7, y: 5, ol: true, g: sym(["...aaaaaa", ".aaaaaaaa", "aaaaaaaaa", "aaaaaaaaa", "aAaaaaaaa", "A..AAAAAA"]) };
const HEADSET = { x: 24, y: 11, ol: true, g: ["ppp", "pPp", "pPp", "ppp", "p..", "p..", ".p.", "..p"] };
const BOOM = dots(["p", [25, 19], [24, 20], [23, 20], [22, 20], [21, 20]], ["P", [20, 20]]);

// Tactical suit: chest strap j with buckle y running shoulder to hip.
const STRAP_BODY = ["j", [21, 23], [20, 24], [19, 25], [18, 26], [17, 27], [16, 28], [15, 29], [14, 30], [13, 31], [22, 23], [21, 24], [20, 25], [19, 26], [18, 27], [17, 28], [16, 29], [15, 30], [14, 31]];
const BUCKLE = ["y", [17, 26], [18, 26], [17, 27], [18, 28]];

const base = (inside, front, extra = []) => [
  BODY, dots(STRAP_BODY, BUCKLE), HOOD, dots(HOOD_RIM), ...EARS, HEAD, dots(FACE_SHADE), ...inside, HOOD_FRONT, ...front, ...extra,
];

export const variants = [
  {
    // Indigo hood, charcoal mask, twin round green goggles.
    name: "hood",
    pal: { ...SKIN.light, h: "#2f3a6a", H: "#1d2448", i: "#4f63a8", g: "#3a3e52", l: "#4df7a6", L: "#e0fff0", G: "#2a8a5e", j: "#5b6078",
      m: "#2a2838", M: "#1a1824", c: "#26304f", C: "#3a4870", y: "#ffc857" },
    grid: () => compose(base([MASK, dots(MASK_FOLD)], [STRAP, GOGGLES]), "audit/hood"),
  },
  {
    // Full black balaclava, single wraparound green visor.
    name: "visor",
    pal: { s: "#36344c", S: "#24223a", n: "#24223a", h: "#36344c", H: "#1a1824", i: "#4a4766", g: "#3a3e52", l: "#4df7a6", L: "#e0fff0",
      G: "#2a8a5e", j: "#5b6078", c: "#2a2440", C: "#4a3f6e", y: "#4df7a6" },
    grid: () => compose([BODY, dots(STRAP_BODY, BUCKLE), ...EARS, HEAD, dots(FACE_SHADE), VISOR, dots(["G", [9, 15], [10, 15], [13, 15], [18, 15], [21, 15], [22, 15]]),
      dots(["S", ...run(13, 18, 19)], ["i", [9, 9], [10, 8], [11, 8]])], "audit/visor"),
  },
  {
    // Slick dark hair, bare face with a smirk, goggles + headset mic.
    name: "headset",
    pal: { ...SKIN.tan, a: "#1d1830", A: "#0d0a18", g: "#3a3e52", l: "#4df7a6", L: "#e0fff0", G: "#7ad6a0", j: "#3a3e52", p: "#38f6ff", P: "#ff4fd8",
      c: "#1f3a4a", C: "#2f5a6e", y: "#4df7a6" },
    grid: () => compose([BODY, dots(STRAP_BODY, BUCKLE), ...EARS, HEAD, dots(FACE_SHADE),
      dots(["n", [15, 16], [16, 16]], ["k", ...run(14, 17, 19), [18, 18]]), SLICK, STRAP, GOGGLES, HEADSET, BOOM], "audit/headset"),
  },
  {
    // Violet hood, hot-pink scarf mask, goggles.
    name: "scarf",
    pal: { ...SKIN.brown, h: "#4a2a72", H: "#2e184a", i: "#7a4ab8", g: "#3a3e52", l: "#4df7a6", L: "#e0fff0", G: "#2a8a5e", j: "#5b6078",
      m: "#ff4fd8", M: "#b52a95", c: "#2a2440", C: "#4a3f6e", y: "#4df7a6" },
    grid: () => compose(base([MASK, dots(["M", [11, 17], [14, 17], [17, 17], [20, 17], [12, 19], [15, 19], [18, 19]])], [STRAP, GOGGLES]), "audit/scarf"),
  },
];

export const ring = "#4df7a6";
