// implement: the builder/brawler. Bandana, tank top over bare shoulders, taped fists.
import { D, E, I, L, Ln, M, P, PL, R, U, compose, SKIN } from "./lib.mjs";
import { BROWS, CAP_S, EARS, EYES, HEAD, NECK, NOSE, SMILE, TORSO_S } from "./parts.mjs";

// Bare shoulders (skin) with a tank top over the chest.
const BODY = [
  L(TORSO_S(), "s", { ol: 2, sh: [["S", 4, 0]] }),
  L(I(TORSO_S(), D(R(19, 47, 44, 63), E(32, 46, 7, 6))), "c", { ol: 1, sh: [["C", 3, 0]] }),
  L(M(PL(1, [14, 56], [15, 63])), "S"),
];

const BANDANA = (knot = true) => [
  L(I(CAP_S(25, 1), R(0, 19, 63, 25)), "b", { ol: 2, sh: [["B", 0, 1]] }),
  L(I(CAP_S(25, 1), R(0, 19, 63, 25), (x, y) => (x + y) % 6 === 0), "d"),
  knot && L(U(P([44, 20], [54, 16], [52, 22]), P([44, 23], [55, 26], [50, 28])), "b", { ol: 2, sh: [["B", 1, 1]] }),
];

const HAIR = {
  spikes: L(U(CAP_S(20), P([19, 16], [21, 6], [25, 12], [29, 3], [33, 10], [37, 4], [40, 11], [44, 7], [45, 17])), "a", { ol: 2, sh: [["A", 2, 1]] }),
  mohawk: L(U(CAP_S(20, 0.5), P([29, 15], [29, 3], [32, 0], [35, 3], [35, 15])), "a", { ol: 2, sh: [["A", 2, 0]] }),
  bald: null,
  flat: L(U(CAP_S(20), R(21, 11, 42, 18)), "a", { ol: 2, sh: [["A", 0, 1]] }),
};

// Taped brawler fist, knuckles up: forearm angled down to the bottom edge (lean `dir`), diagonal wrist
// wraps, knuckle bumps + creases, thumb folded across the front.
const FIST = (cx, cy, dir = 1) => {
  const arm = P([cx - 4, cy + 2], [cx + 4, cy + 2], [cx + 5 + dir * 5, 64], [cx - 5 + dir * 5, 64]);
  return [
    L(arm, "s", { ol: 2, sh: [["S", 2, 0]] }),
    L(I(arm, R(0, cy + 5, 63, cy + 10)), (x, y) => ((x + dir * y) % 4 + 4) % 4 < 2 ? "t" : "T"),
    L(U(R(cx - 6, cy - 3, cx + 6, cy + 4), ...[-4, -1.3, 1.3, 4].map((d, i) => E(cx + d + 0.5, cy - (i === 0 || i === 3 ? 3 : 4), 2.2, 2))), "s", { ol: 2, sh: [["S", 2, 1]] }),
    L(U(R(cx - 3, cy - 4, cx - 3, cy - 1), R(cx, cy - 5, cx, cy - 1), R(cx + 3, cy - 4, cx + 3, cy - 1)), "S"),
    L(R(cx - 5, cy + 1, cx + 1, cy + 3), "s", { ol: 1 }),
    L(I(R(cx - 6, cy - 4, cx + 6, cy - 2), U(R(cx - 6, cy - 3, cx + 6, cy + 4), ...[-4, -1.3, 1.3, 4].map((d) => E(cx + d + 0.5, cy - 4, 2.2, 2)))), "t"),
  ];
};
const HAMMER = [L(Ln(45, 62, 55, 31, 4), "u", { ol: 2, sh: [["U", 1, 0]] }), L(P([47, 26], [63, 31], [61, 39], [45, 34]), "g", { ol: 2, sh: [["G", 0, 2]] })];
const BEARD = L(I(D(E(32, 32, 14, 13), E(32, 30, 11, 9)), R(0, 34, 63, 63)), "a", { ol: 0, sh: [["A", 0, 1]] });

const base = (layers) => () => compose([BODY, NECK, ...EARS, HEAD, ...layers]);

export const variants = [
  { name: "fist", pal: { ...SKIN.tan, a: "#2a2440", A: "#14101e", b: "#ff4f6e", B: "#b52a45", d: "#f6f3ff", c: "#f6f3ff", C: "#b9b2d6", t: "#f6f3ff", T: "#b9b2d6" },
    grid: base([EYES.dot(), BROWS("a", -1), NOSE, L(PL(2, [27, 39], [37, 39]), "o"), HAIR.spikes, BANDANA(), FIST(50, 49)]) },
  { name: "mohawk", pal: { ...SKIN.light, a: "#ff4fd8", A: "#b52a95", b: "#38f6ff", B: "#1f9eb0", d: "#14101e", c: "#8f5cff", C: "#5a34b8", t: "#f6f3ff", T: "#b9b2d6" },
    grid: base([EYES.round(), BROWS("A", -1), NOSE, SMILE(6, 4), HAIR.mohawk, BANDANA(false), FIST(51, 36, 1)]) },
  { name: "hammer", pal: { ...SKIN.deep, a: "#1c1a2e", A: "#14101e", b: "#8f5cff", B: "#5a34b8", d: "#ffe14d", c: "#2fb8e8", C: "#1a6f9a", t: "#f6f3ff", T: "#b9b2d6", u: "#d08a4a", U: "#9a5a2a", g: "#e6e2f4", G: "#8a84a6" },
    grid: base([EYES.dot(), BROWS("a", -1), NOSE, BEARD, SMILE(5, 3, 38), BANDANA(false), HAMMER, FIST(47, 55)]) },
  { name: "guard", pal: { ...SKIN.brown, a: "#1c1a2e", A: "#14101e", b: "#ffc857", B: "#c98a2a", d: "#ff4fd8", c: "#ff8a3d", C: "#b8551a", t: "#f6f3ff", T: "#b9b2d6" },
    grid: base([EYES.dot(), BROWS("a", -2), NOSE, L(R(27, 38, 36, 40), "w", { ol: 1 }), L(R(29, 38, 29, 40), "k"), L(R(34, 38, 34, 40), "k"), HAIR.flat, BANDANA(), FIST(17, 39, -1), FIST(47, 39, 1)]) },
];
