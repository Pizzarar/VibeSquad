// audit: the night-shift scout. Green night-vision is the role read; each variant wears it differently so
// the four keep their own silhouette: hood + visor down, beanie + goggles up, backwards cap + monocular,
// helmet + quad tubes.
import { D, E, I, L, Ln, M, P, PL, R, U, compose, SKIN } from "./lib.mjs";
import { BROWS, CAP_S, EYES, HEAD_S, NOSE, TORSO_S, bust } from "./parts.mjs";

// Tactical vest: dark panel over the body with straps and a pouch.
const VEST = [
  L(I(TORSO_S(), R(17, 50, 46, 63)), "d", { clip: true }),
  L(I(TORSO_S(), U(R(19, 50, 22, 63), R(41, 50, 44, 63))), "D", { clip: true }),
  L(R(25, 56, 31, 61), "D", { ol: 1 }),
  L(R(27, 57, 29, 57), "v"),
];
const MOUTH = L(R(28, 39, 35, 40), "o");

// v0: deep hood up with a long visor down over the eyes.
const HOOD = [
  L(D(U(E(32, 28, 19, 21), P([14, 34], [50, 34], [54, 52], [10, 52])), E(32, 31, 12, 13)), "h", { ol: 2, sh: [["H", 3, 0], ["z", 0, -2], ["z", -2, 0]] }),
  L(D(E(32, 28, 15.5, 17), E(32, 31, 12, 13)), "H"),
];
const VISOR = [L(R(17, 27, 46, 34), "k"), L(R(19, 28, 44, 33), "v"), L(R(19, 28, 44, 29), "V"), L(R(21, 31, 42, 31), "x")];

// v1: knit beanie with round goggles pushed up on it; eyes visible with a green glow under them.
const BEANIE = [
  L(U(CAP_S(22, 2.5), E(32, 8, 3.5)), "h", { ol: 2, sh: [["H", 3, 0]] }),
  L(I(CAP_S(22, 2.5), R(0, 19, 63, 22)), "H"),
  L(I(CAP_S(22, 2.5), (x, y) => y < 19 && x % 4 === 1), "H"),
];
const GOGGLES_UP = [L(R(16, 14, 47, 16), "k"), L(U(E(26, 14.5, 5, 4.5), E(38, 14.5, 5, 4.5)), "x", { ol: 2 }), L(U(E(26, 14.5, 3.5, 3), E(38, 14.5, 3.5, 3)), "v"), L(U(R(24, 12, 25, 13), R(36, 12, 37, 13)), "V")];

// v2: cap on backwards + single NV tube flipped down over the right eye, mic boom.
const BACKCAP = [L(CAP_S(22, 1.5), "h", { ol: 2, sh: [["H", 3, 0]] }), L(I(CAP_S(22, 1.5), R(0, 19, 63, 22)), "H"), L(D(E(14, 21, 6, 3), R(14, 0, 63, 63)), "h", { ol: 2 }), L(E(32, 12, 1.5), "H")];
const MONOCULAR = [
  L(PL(3, [41, 18], [41, 24]), "x", { ol: 1 }),
  L(R(33, 25, 44, 35), "x", { ol: 2, sh: [["k", 1, 1]] }),
  L(E(38.5, 30, 4.5, 4.5), "v", { ol: 1 }),
  L(R(36, 28, 37, 29), "V"),
];
const MIC = [L(PL(2, [19, 36], [21, 42], [27, 43]), "x", { ol: 1 }), L(E(28, 43, 2), "v", { ol: 1 })];

// v3: helmet with four NV tubes flipped down.
const HELMET = [
  L(U(I(E(32, 24, 18, 15), R(0, 0, 63, 25)), R(13, 22, 50, 26)), "h", { ol: 2, sh: [["H", 3, 0], ["H", 0, 1]] }),
  L(R(28, 12, 35, 18), "x", { ol: 1 }),
  L(R(27, 18, 36, 21), "x", { ol: 0 }),
];
const QUAD = [
  L(R(16, 24, 47, 34), "x", { ol: 2 }),
  ...[19, 26, 34, 41].map((x, i) => L(E(x + 2, 30, i === 0 || i === 3 ? 3 : 3.5, 3.5), "v", { ol: 1 })),
  ...[19, 26, 34, 41].map((x) => L(R(x + 1, 28, x + 1, 29), "V")),
];

const BEARD = L(I(D(E(32, 32, 14, 13), E(32, 30, 11, 8.5)), R(0, 34, 63, 63)), "m", { sh: [["M", 0, 1]] });

// Light rim along the top of the shoulders so dark gear separates from the background.
const RIM = L(TORSO_S(), null, { sh: [["z", 0, -2], ["z", -2, 0]] });
const make = (layers) => () => compose([bust([]), RIM, VEST, ...layers]);

export const variants = [
  { name: "hood", pal: { ...SKIN.light, h: "#2a2448", H: "#1a1630", c: "#2a2448", C: "#1a1630", d: "#1f2242", D: "#14162c", v: "#4df7a6", V: "#d4ffe9", x: "#22a86b", z: "#5a50a0" },
    grid: make([NOSE, MOUTH, HOOD, VISOR]) },
  { name: "beanie", pal: { ...SKIN.tan, h: "#b52a45", H: "#7a1a2e", c: "#3a4660", C: "#252e40", d: "#2e3a50", D: "#1c2433", v: "#4df7a6", V: "#d4ffe9", x: "#3a3c4a", z: "#6a7aa0",
    m: "#2a1a10", M: "#14101e" },
    grid: make([EYES.round(), L(M(R(23, 34, 28, 34)), "v"), BROWS("m"), NOSE, MOUTH, BEARD, BEANIE, GOGGLES_UP]) },
  { name: "backcap", pal: { ...SKIN.brown, h: "#ffc857", H: "#c98a2a", c: "#1f5c5a", C: "#123a38", d: "#18403f", D: "#0f2a29", v: "#4df7a6", V: "#d4ffe9", x: "#2a2c3a", z: "#3fa09a" },
    grid: make([EYES.dot(), BROWS("e"), NOSE, L(PL(2, [28, 40], [34, 40], [36, 38]), "o"), BACKCAP, MONOCULAR, MIC]) },
  { name: "helmet", pal: { ...SKIN.deep, h: "#5a6a3a", H: "#3a4626", c: "#4a5530", C: "#30381f", d: "#3a4426", D: "#262d18", v: "#4df7a6", V: "#d4ffe9", x: "#24252f", z: "#8a9a5a" },
    grid: make([NOSE, L(PL(2, [28, 39], [35, 39]), "o"), L(M(Ln(19, 30, 22, 44, 2)), "k"), HELMET, QUAD]) },
];
