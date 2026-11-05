// retired-lead: old-timer on permanent vacation. Bucket hat, shades pushed up, hawaiian shirt, drink in hand.
import { D, E, I, L, Ln, M, P, PL, R, U, compose, SKIN } from "./lib.mjs";
import { BLUSH, BROWS, EYES, HOLD, NOSE, TORSO_S, bust } from "./parts.mjs";

const HAT = [
  L(U(I(E(32, 19, 14, 12), R(0, 0, 63, 21)), E(32, 21.5, 20, 4)), "h", { ol: 2, sh: [["H", 3, 0], ["H", 0, 2]] }),
  L(I(E(32, 19, 14, 12), R(0, 17, 63, 19)), "b"),
  // shades pushed up onto the crown
  L(U(E(26.5, 12.5, 4, 3), E(37.5, 12.5, 4, 3)), "l", { ol: 1 }),
  L(R(30, 11, 33, 12), "k"),
  L(U(R(24, 11, 25, 11), R(35, 11, 36, 11)), "L"),
];

// Hawaiian shirt: flowers clipped to the torso.
const FLOWERS = [[12, 54], [22, 59], [9, 62], [40, 57], [52, 54], [31, 62], [56, 61]];
const flower = (x, y) => {
  for (const [fx, fy] of FLOWERS) {
    const d = Math.abs(x - fx) + Math.abs(y - fy);
    if (d === 0) return "F";
    if (d <= 2 && (x === fx || y === fy)) return "f";
  }
  return null;
};
const SHIRT = [L(TORSO_S(), flower, { clip: true }), L(P([26, 47], [38, 47], [32, 55]), "s"), L(U(P([24, 47], [31, 47], [31, 55]), P([40, 47], [33, 47], [33, 55])), "C", { ol: 1 })];

// Drink held in the right hand (lower right), fingers wrapped over the glass.
const DRINKS = {
  cocktail: [
    L(P([42, 38], [56, 38], [51, 52], [47, 52]), "d", { ol: 2 }),
    L(P([43, 40], [55, 40], [51, 50], [47, 50]), "D"),
    L(D(E(53, 37, 7, 4), R(0, 37, 63, 63)), "u", { ol: 2, sh: [["U", 2, 0]] }),
    L(Ln(53, 36, 50, 46, 1), "k"),
  ],
  coconut: [L(E(49, 46, 7, 7), "d", { ol: 2, sh: [["D", 2, 1]] }), L(E(49, 41, 5, 2), "w"), L(Ln(51, 41, 55, 32, 2), "y", { ol: 1 })],
  tea: [L(R(44, 36, 54, 53), "d", { ol: 2 }), L(R(45, 39, 53, 52), "D"), L(E(54, 37, 3.5), "y", { ol: 1 }), L(R(46, 40, 47, 49), "w")],
  mug: [L(D(E(57, 46, 4, 4), E(57, 46, 1.5, 2)), "d", { ol: 2 }), L(R(43, 40, 55, 53), "d", { ol: 2, sh: [["g", 2, 0]] }), L(R(44, 40, 54, 41), "D"), L(R(47, 44, 50, 46), "p")],
};
const HOLDS = {
  cocktail: HOLD(49, 56, [[45, 48], [52, 48]]),
  coconut: HOLD(49, 57, [[41, 48], [56, 48]]),
  tea: HOLD(49, 57, [[43, 49], [54, 49]]),
  mug: HOLD(49, 57, [[42, 49]]),
};

const GRIN = [L(D(E(32, 37, 7, 5), R(0, 0, 63, 36)), "o", { ol: 1 }), L(R(27, 37, 36, 38), "w"), L(R(30, 40, 33, 41), "O")];
const WRINKLES = L(M(PL(1, [20, 30], [21, 32])), "S");

const face = {
  laugh: [EYES.happy(), BROWS("m"), NOSE, GRIN, BLUSH, WRINKLES],
  beard: [
    EYES.dot(), BROWS("m"), L(U(I(E(32, 36, 13.5, 13), R(0, 33, 63, 63)), E(32, 45, 8, 6)), "m", { ol: 2, sh: [["M", 2, 1]] }),
    L(D(E(32, 38, 5, 3.5), R(0, 0, 63, 37)), "o", { ol: 1 }), L(R(29, 38, 34, 38), "w"), NOSE,
  ],
  goatee: [
    EYES.round(1), L(Ln(23, 25, 29, 26, 2), "m"), L(Ln(35, 24, 41, 23, 2), "m"), NOSE, GRIN, L(R(32, 37, 33, 38), "o"),
    L(U(E(32, 44, 4, 3.5), R(28, 42, 35, 42)), "m", { ol: 1 }), WRINKLES,
  ],
  walrus: [
    L(M(R(23, 30, 28, 31)), "e"), L(R(24, 29, 27, 32), "e"), L(R(24, 29, 24, 29), "w"), BROWS("m"),
    L(D(E(32, 39, 6, 3), R(0, 0, 63, 38)), "o", { ol: 1 }),
    L(U(E(28, 37, 6, 3), E(36, 37, 6, 3), Ln(22.5, 37, 21.5, 42, 3), Ln(41.5, 37, 42.5, 42, 3)), "m", { ol: 1, sh: [["M", 0, 1]] }),
    NOSE, BLUSH,
  ],
};

const make = (f, drink) => () => compose([bust(), SHIRT, f, HAT, HOLDS[drink].back, DRINKS[drink], HOLDS[drink].tips]);

export const variants = [
  { name: "cocktail", pal: { ...SKIN.light, h: "#ffc857", H: "#c98a2a", b: "#ff4fd8", l: "#38f6ff", L: "#e6feff",
    c: "#ff4fd8", C: "#b52a95", f: "#ffe14d", F: "#ff8a3d", m: "#f4f1fb", M: "#b9b4cc",
    d: "#d9f6ff", D: "#ff9d3a", u: "#4df7a6", U: "#1f9e66" }, grid: make(face.laugh, "cocktail") },
  { name: "coconut", pal: { ...SKIN.tan, h: "#38c8ff", H: "#1f7fb0", b: "#ffc857", l: "#ff4fd8", L: "#ffd0f4",
    c: "#2fd3c0", C: "#16877b", f: "#ff4fd8", F: "#ffe14d", m: "#f4f1fb", M: "#b9b4cc",
    d: "#8a5a34", D: "#5e3a1e", y: "#ff4fd8" }, grid: make(face.beard, "coconut") },
  { name: "iced-tea", pal: { ...SKIN.brown, h: "#e8c27a", H: "#a9803e", b: "#c28cff", l: "#ff4fd8", L: "#ffd0f4",
    c: "#8f5cff", C: "#5a34b8", f: "#f6f3ff", F: "#ffc857", m: "#d9d6e4", M: "#9a96aa",
    d: "#d9f6ff", D: "#ffa733", y: "#ffe14d" }, grid: make(face.goatee, "tea") },
  { name: "mug", pal: { ...SKIN.light, h: "#4df7a6", H: "#22a86b", b: "#ff8573", l: "#ffc857", L: "#fff3c8",
    c: "#ff8a3d", C: "#b8551a", f: "#38f6ff", F: "#f6f3ff", m: "#d9d6e4", M: "#9a96aa",
    d: "#f6f3ff", D: "#6b3b1e", p: "#ff4fd8" }, grid: make(face.walrus, "mug") },
];
