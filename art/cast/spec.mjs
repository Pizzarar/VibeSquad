// spec: the planner. A chunky CRT monitor for a head (the screen is the face), suit + tie, brick phone in hand.
import { D, E, I, L, Ln, M, P, PL, R, U, compose } from "./lib.mjs";
import { HOLD, TORSO_S } from "./parts.mjs";

const SUIT = [
  L(TORSO_S(), "c", { ol: 2, sh: [["C", 4, 0]] }),
  L(P([25, 47], [39, 47], [32, 58]), "w"),
  L(P([30, 48], [34, 48], [35, 57], [32, 60], [29, 57]), "t", { ol: 1 }),
  L(U(PL(2, [24, 47], [31, 59]), PL(2, [40, 47], [33, 59])), "C"),
];
const STAND = L(U(R(26, 42, 37, 48), R(22, 46, 41, 48)), "x", { ol: 2 });

const CRT = [
  L(R(12, 8, 51, 43), "h", { ol: 2, sh: [["H", 4, 0], ["H", 0, 3]] }),
  L(R(13, 9, 49, 9), "i"),
  L(R(15, 11, 43, 38), "k"),
  L(R(17, 13, 41, 36), "v"),
  L(R(18, 14, 21, 15), "V"),
  L(U(...[14, 18, 22, 26].map((y) => R(45, y, 48, y + 1))), "H"),
  L(R(45, 33, 48, 36), "l", { ol: 1 }),
];

const SCREENS = {
  smiley: [L(M(R(23, 19, 25, 24)), "f"), L(U(R(23, 29, 24, 30), R(39 - 4, 29, 40 - 4, 30), R(25, 31, 34, 32)), "f")],
  happy: [L(M(PL(2, [21, 23], [24, 20], [27, 23])), "f"), L(D(E(29.5, 28, 6, 5), R(0, 0, 63, 27)), "f"), L(D(E(29.5, 28, 3.5, 2.5), R(0, 0, 63, 28)), "O")],
  terminal: [L(PL(2, [20, 17], [24, 20], [20, 23]), "f"), L(R(26, 22, 31, 23), "f"), L(U(R(20, 27, 35, 27), R(20, 30, 31, 30), R(20, 33, 26, 33)), "F")],
  wink: [L(R(22, 19, 24, 24), "f"), L(R(33, 22, 37, 23), "f"), L(PL(2, [23, 29], [26, 32], [33, 32], [36, 29]), "f"), L(R(25, 33, 27, 34), "O")],
};
const EARS = [L(U(Ln(27, 8, 21, 0, 2), Ln(37, 8, 43, 0, 2)), "x"), L(U(E(21, 1, 2), E(43, 1, 2)), "l", { ol: 1 })];

// Brick phone held up in the right hand.
const PHONE = [
  L(Ln(53, 37, 53, 28, 3), "g", { ol: 2 }),
  L(R(46, 35, 55, 53), "g", { ol: 2, sh: [["G", 2, 0]] }),
  L(R(48, 37, 53, 41), "p", { ol: 1 }),
  L(U(...[44, 47].flatMap((y) => [R(48, y, 49, y + 1), R(52, y, 53, y + 1)])), "G"),
];
const PHONE_HOLD = HOLD(50, 57, [[45, 49], [55, 49]]);
// Sticky note on the bezel, keyboard-key buttons, side dial: monitor details for the phone-less variants.
const NOTE = [L(P([40, 30], [49, 29], [50, 38], [41, 39]), "n", { ol: 1 }), L(U(R(42, 32, 47, 32), R(42, 35, 46, 35)), "N")];
const DIAL = [L(E(47, 40, 2.5), "l", { ol: 1 })];

const make = (screen, extra = [], phone = true, top = []) => () => compose([SUIT, STAND, extra, CRT, screen, top, phone && [PHONE_HOLD.back, PHONE, PHONE_HOLD.tips]]);

export const variants = [
  { name: "smiley", pal: { h: "#e8e2d0", H: "#b3ab92", i: "#ffffff", v: "#2fb8e8", V: "#a8eeff", f: "#f6f3ff", l: "#4df7a6", x: "#3a3c4a", p: "#4df7a6", g: "#c9c4e0", G: "#7a7494",
    c: "#3a3466", C: "#1a1630", t: "#ff4fd8", s: "#f6c9a0", S: "#d39472" }, grid: make(SCREENS.smiley) },
  { name: "happy", pal: { h: "#c9c4e0", H: "#8f8aa8", i: "#f6f3ff", v: "#ffc857", V: "#fff1c4", f: "#5a1430", O: "#ff4f6e", l: "#ff4fd8", x: "#2a2c3a", p: "#ffc857", n: "#ffe14d", N: "#c98a2a",
    c: "#8f5cff", C: "#5a34b8", t: "#ffc857", s: "#dc9a68", S: "#b06d45" }, grid: make(SCREENS.happy, [], false, NOTE) },
  { name: "terminal", pal: { h: "#4a4c5c", H: "#2e303c", i: "#7a7c90", v: "#0c1a14", V: "#1f3a2e", f: "#4df7a6", F: "#22a86b", l: "#ff4f6e", x: "#1c1d26", p: "#4df7a6", g: "#ff8573", G: "#b04a3a",
    c: "#d9d2b8", C: "#a49c80", t: "#22a86b", s: "#a96a42", S: "#7e4a2c" }, grid: make(SCREENS.terminal) },
  { name: "wink", pal: { h: "#ff7fe0", H: "#c93fae", i: "#ffd6f5", v: "#2a1a3a", V: "#4a2e5e", f: "#ff7fe0", O: "#38f6ff", l: "#38f6ff", x: "#2a2c3a", p: "#38f6ff",
    c: "#1f5c5a", C: "#123a38", t: "#38f6ff", s: "#7a4a2e", S: "#56311d" }, grid: make(SCREENS.wink, EARS, false, DIAL) },
];
