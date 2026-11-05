// unknown: an unassigned agent. A shadow silhouette with a violet rim light and glowing eyes.
import { D, E, I, L, Ln, M, P, PL, R, U, compose } from "./lib.mjs";
import { CAP_S, HEAD_S, TORSO_S } from "./parts.mjs";

const RIM = [["i", -2, 0], ["i", 0, -2]];
const FIG = (hair) => U(HEAD_S, M(E(18.5, 31, 3, 4)), R(26, 40, 37, 50), TORSO_S(), hair ?? (() => false));
const shadow = (hair, extra = []) => [
  L(FIG(hair), "h", { ol: 2, sh: [["H", 3, 0], ...RIM] }),
  L(I(TORSO_S(), D(E(32, 66, 29, 19), E(32, 67, 29, 19))), "H"),
  extra,
];
const glow = (s) => [L(s, "v", { ol: 0 }), L(I(s, (x, y) => !s(x, y - 1)), "V")];

const HAIR = {
  hood: D(U(E(32, 27, 18, 19), P([13, 30], [51, 30], [54, 50], [10, 50])), R(0, 64, 63, 64)),
  spiky: U(CAP_S(22), P([17, 22], [16, 9], [22, 13], [24, 3], [29, 10], [33, 1], [36, 10], [41, 4], [42, 13], [48, 9], [47, 22])),
  // a cowlick curling into a question mark
  curl: U(CAP_S(18, 0.5), PL(3, [32, 13], [32, 10], [34, 8], [37, 6], [37, 3], [34, 1], [30, 1.5], [28, 4])),
  collar: U(P([15, 63], [15, 38], [24, 46], [40, 46], [49, 38], [49, 63])),
};

export const variants = [
  { name: "grin", pal: { h: "#2e2754", H: "#211c3e", i: "#8a6ad6", v: "#38f6ff", V: "#d6fdff" },
    grid: () => compose([shadow(HAIR.hood, L(D(E(32, 31, 12, 13), R(0, 0, 63, 17)), "H")), glow(M(E(26, 28, 3, 2))), glow(D(E(32, 34, 9, 6), E(32, 31, 10, 6)))]) },
  { name: "spiky", pal: { h: "#33264f", H: "#231a3a", i: "#a066e0", v: "#ff4fd8", V: "#ffd0f4" },
    grid: () => compose([shadow(HAIR.spiky), glow(M(R(23, 29, 28, 32))), L(M(R(23, 28, 28, 28)), "H")]) },
  { name: "curious", pal: { h: "#2c2850", H: "#1e1b3a", i: "#7f74c8", v: "#ffc857", V: "#fff1c4" },
    grid: () => compose([shadow(HAIR.curl), glow(M(E(26, 30, 2.5, 3))), glow(E(32, 39, 2, 1.5))]) },
  { name: "collar", pal: { h: "#28304e", H: "#1a2038", i: "#6a80c8", v: "#4df7a6", V: "#d4ffe9" },
    grid: () => compose([shadow(null), L(HAIR.collar, "h", { ol: 2, sh: [["H", 3, 0], ...RIM] }), L(R(31, 46, 32, 63), "H"), glow(M(P([22, 30], [29, 31], [28, 33], [23, 32])))]) },
];
