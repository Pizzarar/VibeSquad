// brainstorm: the idea person. Big chunky headphones, bright eyes, comfy tee.
import { D, E, I, L, Ln, M, P, PL, R, U, compose, SKIN } from "./lib.mjs";
import { BLUSH, BROWS, CAP_S, EYES, HAND, NOSE, SMILE, bust } from "./parts.mjs";

const PHONES = [
  L(I(D(E(32, 27, 19, 19), E(32, 27, 16, 16)), R(0, 0, 63, 27)), "p", { ol: 2, sh: [["P", 0, 1]] }),
  L(M(E(16.5, 32, 4.5, 7)), "p", { ol: 2, sh: [["P", 2, 0]] }),
  L(M(R(15, 28, 16, 36)), "q"),
];

const HAIR = {
  // purple bob with a sweep of bangs
  bob: [L(U(CAP_S(26), P([18, 20], [40, 20], [30, 27], [20, 29])), "a", { ol: 2, sh: [["A", 2, 1]] }), L(M(R(17, 24, 19, 38)), "a", { ol: 2 })],
  // short spikes
  spiky: [L(U(CAP_S(21), P([18, 18], [20, 7], [25, 13], [28, 4], [32, 11], [37, 4], [39, 12], [45, 8], [46, 19])), "a", { ol: 2, sh: [["A", 2, 1]] })],
  // tight buzz
  buzz: [L(CAP_S(19, 0.5), "a", { ol: 0, sh: [["A", 0, 1]] })],
  // round afro
  afro: [L(D(E(32, 20, 21, 16), R(19, 24, 44, 63), R(0, 31, 63, 63)), "a", { ol: 2, sh: [["A", 3, 1]] })],
};

// Star pupils for the dreamer.
const STAR = (cx, cy) => U(R(cx - 2, cy, cx + 2, cy), R(cx, cy - 2, cx, cy + 2), R(cx - 1, cy - 1, cx + 1, cy + 1));
const starEyes = [L(M(E(26, 30.5, 3.2, 3.6)), "w", { ol: 1 }), L(U(STAR(26, 30), STAR(37, 30)), "y")];

// "Aha!" pose: right hand raised, index finger pointing up.
const POINT = [
  L(P([45, 50], [54, 50], [57, 64], [47, 64]), "c", { ol: 2, sh: [["C", 3, 0]] }),
  L(R(47, 32, 50, 44), "s", { ol: 2, sh: [["S", 1, 0]] }),
  L(U(E(48, 46, 4, 5), E(52, 46, 4, 5)), "s", { ol: 2, sh: [["S", 2, 1]] }),
  L(U(R(49, 45, 55, 45), R(49, 48, 55, 48)), "S"),
  L(R(47, 32, 50, 33), "n"),
];
// Pink bubble blown from the mouth.
const BUBBLE = [L(E(32, 40, 8, 7), "b", { ol: 2, sh: [["B", 2, 1]] }), L(R(28, 36, 29, 37), "w")];

const make = (layers) => () => compose([bust(), L(D(E(32, 48, 6, 3), R(0, 0, 63, 47)), "s", { ol: 1 }), ...layers]);

export const variants = [
  { name: "dreamer", pal: { ...SKIN.tan, a: "#9b6bff", A: "#6640c4", p: "#ff4fd8", P: "#b52a95", q: "#38f6ff", c: "#ffc857", C: "#d9902e", y: "#ffe14d" },
    grid: make([starEyes, BROWS("A"), NOSE, SMILE(5, 4), BLUSH, HAIR.bob, PHONES]) },
  { name: "aha", pal: { ...SKIN.light, a: "#2a2440", A: "#14101e", p: "#ffc857", P: "#c98a2a", q: "#ff4fd8", c: "#38c8ff", C: "#1f7fb0", y: "#fff07a", Y: "#ffc857" },
    grid: make([EYES.round(), BROWS("a", 1), NOSE, SMILE(6, 5), HAIR.spiky, PHONES, POINT]) },
  { name: "bubblegum", pal: { ...SKIN.deep, a: "#1c1a2e", A: "#14101e", p: "#4df7a6", P: "#22a86b", q: "#c28cff", c: "#ff8a3d", C: "#b8551a", b: "#ff7fe0", B: "#d43fae" },
    grid: make([EYES.sleepy(), BROWS("a"), NOSE, HAIR.buzz, PHONES, BUBBLE]) },
  { name: "vibing", pal: { ...SKIN.brown, a: "#ff8a3d", A: "#b8551a", p: "#8f5cff", P: "#5a34b8", q: "#4df7a6", c: "#2fd3c0", C: "#16877b" },
    grid: make([HAIR.afro, EYES.happy(), NOSE, SMILE(6, 4), BLUSH, PHONES]) },
];
