// art: the painter. Two beret artists (brush / palette in hand) and two people completely drenched in
// paint: a human silhouette (beret, head, ears, shoulders) under a glossy coat, only the eyes peeking out.
import { D, E, I, L, Ln, M, P, PL, R, T, U, compose, SKIN } from "./lib.mjs";
import { BLUSH, EARS, EYES, HAND, HOLD, HEAD_S, NECK, NOSE, SMILE, TORSO_S, bust } from "./parts.mjs";

// Tilted beret with a little stalk.
const BERET_S = U(E(30, 17, 17, 6.5), E(36, 10, 1.5, 2));
const BERET = L(BERET_S, "b", { ol: 2, sh: [["B", 3, 1]] });

// Painter's smock with paint dots.
const SPOTS = [[13, 56], [20, 61], [44, 58], [52, 61], [27, 62]];
const SMOCK = [
  L(TORSO_S(), (x, y) => (SPOTS.some(([a, b]) => Math.abs(x - a) + Math.abs(y - b) <= 1) ? (x % 2 ? "y" : "z") : null), { clip: true }),
  L(D(E(32, 48, 6, 3), R(0, 0, 63, 47)), "s", { ol: 1 }),
];
const STRIPES = [L(TORSO_S(), (x, y) => (y % 4 < 2 ? "k" : "c"), { clip: true }), L(D(E(32, 48, 6, 3), R(0, 0, 63, 47)), "s", { ol: 1 })];
const SMUDGE = L(U(E(22, 36, 2, 1.5), E(25, 38, 1.5, 1)), "z");

const BRUSH = [L(Ln(47, 62, 57, 30, 3), "u", { ol: 1 }), L(R(55, 32, 58, 35), "g", { ol: 1 }), L(E(57.5, 28.5, 2.5, 3.5), "y", { ol: 1 })];
const PAL_HOLD = HOLD(46, 57, [[44, 50]], "C", "g");
const PALETTE = [
  L(D(E(49, 47, 10, 7), E(45, 50, 2, 1.5)), "p", { ol: 2, sh: [["P", 1, 1]] }),
  L(E(45, 44, 1.7), "y"), L(E(50, 42.5, 1.7), "z"), L(E(55, 45, 1.7), "b"), L(E(54, 50, 1.7), "q"),
];

// Drenched: the beret-artist silhouette (beret, head, ears, neck, shoulders) under one coat of paint. The
// coat has no inner contour lines, only the outer outline, a shadow under the chin and the brim shade; it
// runs down off the neck onto a differently coloured shirt. Normal eyes peek out.
const DRIP = (x, y0, len, w = 2.5) => U(R(x - w / 2 + 0.5, y0, x + w / 2 - 0.5, y0 + len), E(x, y0 + len, w / 2 + 0.5, 1.4));
const COAT = U(BERET_S, HEAD_S, M(E(18.5, 31, 3, 4)), R(26, 40, 37, 50));
const SPILL = U(I(E(32, 49, 15, 5), R(0, 46, 63, 63)), DRIP(20, 49, 6, 3), DRIP(26, 50, 9, 3), DRIP(33, 51, 5, 3), DRIP(40, 50, 10, 3), DRIP(45, 49, 4, 3));
const drenched = (pour) => [
  L(TORSO_S(), "c", { ol: 2, sh: [["C", 4, 0]] }),
  L(I(TORSO_S(), SPILL), "p", { sh: [["P", 0, 1], ["P", 3, 0]] }),
  L(COAT, "p", { ol: 2, sh: [["P", 3, 0]] }),
  L(I(D(T(HEAD_S, 0, 2), HEAD_S), R(25, 38, 38, 47)), "k"),
  L(I(D(E(30, 17, 17, 6.5), E(30, 15.5, 17, 6.5)), HEAD_S), "P"),
  pour && [
    L(I(COAT, U(R(0, 0, 63, 20), DRIP(24, 20, 5, 3), DRIP(33, 20, 3, 3), DRIP(40, 20, 7, 3))), "q", { sh: [["Q", 0, 1], ["Q", 3, 0]] }),
  ],
  L(U(E(23, 12.5, 4, 1.3), R(22, 23, 23, 24)), "i"),
  EYES.round(),
];

export const variants = [
  { name: "beret-brush", pal: { ...SKIN.light, b: "#ff4fd8", B: "#b52a95", c: "#2fb8e8", C: "#1a6f9a", y: "#ffe14d", z: "#4df7a6", u: "#a86a3a", a: "#6b3b1e" },
    grid: () => compose([bust(), SMOCK, EYES.round(), NOSE, SMILE(5, 3), BLUSH, SMUDGE, L(M(R(19, 22, 21, 30)), "a", { ol: 1 }), BERET, BRUSH, HAND(50, 52)]) },
  { name: "beret-palette", pal: { ...SKIN.brown, b: "#38c8ff", B: "#1f7fb0", c: "#f6f3ff", C: "#b9b2d6", y: "#ffe14d", z: "#ff4fd8", q: "#4df7a6", p: "#e8c88a", P: "#b8955a", u: "#a86a3a", a: "#2a1a10" },
    grid: () => compose([bust(), STRIPES, EYES.happy(), NOSE, SMILE(6, 4), L(U(E(39, 37, 2, 1.5), E(42, 35, 1.5, 1)), "z"), BERET, L(M(PL(2, [28, 38.5], [31, 37], [33, 37], [36, 38.5])), "a"), PAL_HOLD.back, PALETTE, PAL_HOLD.tips]) },
  { name: "drenched-pink", pal: { c: "#8f5cff", C: "#5a34b8", p: "#ff5fdc", P: "#b52a95", i: "#ffd0f6" },
    grid: () => compose([drenched(false)]) },
  { name: "drenched-pour", pal: { c: "#f6f3ff", C: "#b9b2d6", p: "#38c0f0", P: "#1a6f9a", i: "#c4f4ff", q: "#ffc857", Q: "#d9902e" },
    grid: () => compose([drenched(true)]) },
];
