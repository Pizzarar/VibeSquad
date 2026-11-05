// mechanical: the fixer. Ball cap, big mustache, zip coveralls with a name patch, tool in hand.
import { D, E, I, L, Ln, M, P, PL, R, U, compose, SKIN } from "./lib.mjs";
import { BROWS, EYES, HAND, HOLD, NOSE, TORSO_S, bust } from "./parts.mjs";

const COVERALLS = [
  L(P([26, 47], [38, 47], [32, 54]), "w"),
  L(U(P([22, 47], [31, 47], [31, 55]), P([42, 47], [33, 47], [33, 55])), "c", { ol: 1, sh: [["C", 1, 0]] }),
  L(R(31, 54, 32, 63), "C"),
  L(R(11, 54, 21, 58), "w", { ol: 1 }),
  L(U(R(13, 56, 15, 56), R(17, 56, 19, 56)), "p"),
];

// Front-facing ball cap: crown + curved bill + front panel logo.
const CAP = (logo) => [
  L(I(E(32, 22, 15.5, 13), R(0, 0, 63, 22)), "h", { ol: 2, sh: [["H", 3, 0]] }),
  L(R(31, 10, 32, 22), "H"),
  L(D(E(32, 22, 18, 5), R(0, 0, 63, 21)), "b", { ol: 2, sh: [["B", 0, 1]] }),
  logo,
];
const LOGOS = {
  bolt: L(P([33, 12], [28, 18], [32, 18], [30, 22], [36, 15], [32, 15]), "y", { ol: 1 }),
  star: L(U(R(30, 15, 34, 15), R(32, 13, 32, 17), R(31, 14, 33, 16)), "y", { ol: 1 }),
  gear: L(D(U(E(32, 16, 3.5), R(31, 11, 32, 21), R(27, 15, 36, 16)), E(32, 16, 1.2)), "y", { ol: 1 }),
  heart: L(U(E(30, 15, 2.2), E(34, 15, 2.2), P([27.5, 15.5], [36.5, 15.5], [32, 20])), "y", { ol: 1 }),
};
// Welding goggles strapped over the cap front.
const GOGGLES = [L(R(17, 14, 46, 16), "k"), L(U(E(26.5, 15, 4.5, 3.5), E(37.5, 15, 4.5, 3.5)), "l", { ol: 2, sh: [["L", 0, 1]] }), L(R(25, 13, 26, 13), "w")];

const STACHE = {
  push: L(U(E(27.5, 37, 5, 2.5), E(36.5, 37, 5, 2.5)), "m", { ol: 1, sh: [["M", 0, 1]] }),
  handlebar: L(U(E(28, 37, 5, 2.5), E(36, 37, 5, 2.5), PL(2, [23, 37], [21, 34]), PL(2, [41, 37], [43, 34])), "m", { ol: 1, sh: [["M", 0, 1]] }),
  chevron: L(P([24, 39], [32, 35], [40, 39], [38, 40], [32, 38], [26, 40]), "m", { ol: 1 }),
  full: [L(I(D(E(32, 34, 13.5, 11), E(32, 31, 9.5, 7)), R(0, 35, 63, 63)), "m", { ol: 2, sh: [["M", 0, 2], ["M", 2, 0]] }), L(D(E(32, 41, 4, 2.5), R(0, 0, 63, 40)), "o", { ol: 1 }), L(U(E(28, 37.5, 4.5, 2), E(36, 37.5, 4.5, 2)), "m", { ol: 1, sh: [["M", 0, 1]] })],
};
const MOUTH = L(D(E(32, 40, 4, 2.5), R(0, 0, 63, 39)), "o", { ol: 1 });

const TOOLS = {
  wrench: [L(Ln(48, 60, 52, 34, 3), "g", { ol: 2 }), L(D(E(53, 32, 4.5), P([52, 26], [56, 26], [54, 32])), "g", { ol: 2, sh: [["G", 1, 1]] })],
  screwdriver: [L(Ln(50, 44, 50, 31, 2), "g", { ol: 2 }), L(R(47, 41, 53, 58), "y", { ol: 2, sh: [["Y", 2, 0]] })],
  oilcan: [L(Ln(53, 42, 59, 31, 3), "g", { ol: 2 }), L(E(50, 46, 7, 6), "g", { ol: 2, sh: [["G", 2, 1]] }), L(R(44, 44, 56, 45), "y")],
};

const CAN_HOLD = HOLD(50, 55, [[42, 47], [57, 47]]);
const make = (cap, stache, eyes, tool) => () =>
  compose([bust(COVERALLS), eyes, BROWS("m"), NOSE, MOUTH, stache, cap,
    tool === TOOLS.oilcan ? [CAN_HOLD.back, tool, CAN_HOLD.tips] : tool && [tool, HAND(50, 52)]]);

export const variants = [
  { name: "wrench", pal: { ...SKIN.light, h: "#2fd3c0", H: "#16877b", b: "#1c8f80", B: "#0f5c52", y: "#ffe14d", c: "#ff8a3d", C: "#b8551a", p: "#14101e", m: "#5a3420", M: "#3a2014", g: "#c9c4e0", G: "#7a7494" },
    grid: make(CAP(LOGOS.bolt), STACHE.push, EYES.dot(), TOOLS.wrench) },
  { name: "goggles", pal: { ...SKIN.tan, h: "#ffc857", H: "#c98a2a", b: "#d9902e", B: "#9a6418", l: "#38f6ff", L: "#1f9eb0", y: "#ff4fd8", c: "#8f5cff", C: "#5a34b8", p: "#14101e", m: "#2a1a10", M: "#14101e" },
    grid: make([...CAP(null), ...GOGGLES], STACHE.handlebar, EYES.round(), null) },
  { name: "trucker", pal: { ...SKIN.brown, h: "#ff4fd8", H: "#b52a95", b: "#f6f3ff", B: "#b9b2d6", y: "#f6f3ff", c: "#4df7a6", C: "#22a86b", p: "#14101e", m: "#d9d6e4", M: "#9a96aa", g: "#c9c4e0", G: "#7a7494", Y: "#c98a2a" },
    grid: make(CAP(LOGOS.heart), STACHE.full, EYES.dot(), TOOLS.screwdriver) },
  { name: "oilcan", pal: { ...SKIN.deep, h: "#38c8ff", H: "#1f7fb0", b: "#1f7fb0", B: "#135070", y: "#ffc857", Y: "#c98a2a", c: "#ffc857", C: "#c98a2a", p: "#14101e", m: "#ff8a3d", M: "#b8551a", g: "#c9c4e0", G: "#7a7494", l: "#ff4f6e" },
    grid: make(CAP(LOGOS.gear), STACHE.chevron, EYES.round(-1), TOOLS.oilcan) },
];
