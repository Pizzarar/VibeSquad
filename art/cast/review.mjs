// review: the investigator. Fedora, trench coat with popped collar, shirt + tie, sharp eyes. Face always visible.
import { D, E, I, L, Ln, M, P, PL, R, U, compose, SKIN } from "./lib.mjs";
import { EYES, HOLD, NOSE, bust } from "./parts.mjs";

// Trench: popped collar flaps up the neck, white shirt V and tie.
const COAT = [
  L(P([25, 47], [39, 47], [32, 60]), "w"),
  L(P([30, 48], [34, 48], [35, 59], [32, 62], [29, 59]), "t", { ol: 1 }),
  L(U(P([18, 46], [26, 42], [31, 60], [24, 63]), P([46, 46], [38, 42], [33, 60], [40, 63])), "c", { ol: 2, sh: [["C", 1, 1]] }),
];

const FEDORA = [
  L(U(P([19, 22], [45, 22], [43, 10], [37, 7], [32, 10], [27, 7], [21, 10]), E(32, 22.5, 22, 3.5)), "h", { ol: 2, sh: [["H", 3, 0], ["H", 0, 1]] }),
  L(I(P([19, 22], [45, 22], [43, 10], [37, 7], [32, 10], [27, 7], [21, 10]), R(0, 17, 63, 20)), "b"),
  L(R(31, 10, 32, 16), "H"),
];
const UNDER = L(I(D(E(32, 27, 13.5, 14), R(0, 0, 63, 24)), R(0, 0, 63, 26)), "S");

const MOUTHS = {
  flat: L(R(28, 39, 35, 40), "o"),
  smirk: L(PL(2, [28, 40], [34, 40], [37, 38]), "o"),
  frown: L(PL(2, [28, 40], [30, 39], [34, 39], [36, 40]), "o"),
};

// Hand on the chin, thinking.
// Fist propped under the chin, forearm running down to the bottom edge; outlined so it separates from the jaw.
const CHIN_HAND = [
  L(P([33, 49], [42, 49], [48, 64], [37, 64]), "C", { ol: 2 }),
  L(U(E(34, 47.5, 5, 4), E(39, 47.5, 4, 4)), "s", { ol: 2, sh: [["S", 2, 1]] }),
  L(U(R(33, 46, 41, 46), R(33, 49, 41, 49)), "S"),
];
// Notepad + pencil held in the right hand.
const NOTEPAD = [L(R(43, 34, 56, 54), "w", { ol: 2, sh: [["g", 2, 0]] }), L(U(R(48, 38, 54, 38), R(48, 41, 54, 41), R(50, 44, 54, 44)), "l"), L(R(43, 34, 56, 35), "r")];
const PAD_HOLD = HOLD(49, 57, [[42, 50], [56, 50]]);
const STACHE = L(U(PL(2, [26, 39], [28, 37], [36, 37], [38, 39]), E(32, 44, 3, 2)), "m");

const SQUINT = [L(M(R(23, 30, 28, 32)), "w", { ol: 1 }), L(M(R(25, 30, 26, 32)), "e"), L(M(Ln(22, 27, 29, 28, 2)), "e")];
const ARCHED = [EYES.round(-1), L(Ln(22, 27, 29, 27, 2), "e"), L(Ln(35, 26, 41, 23, 2), "e")];

const make = (layers) => () => compose([bust(COAT), UNDER, ...layers]);

export const variants = [
  { name: "thinker", pal: { ...SKIN.light, h: "#2a4ea0", H: "#1a3070", b: "#38f6ff", c: "#c9a46a", C: "#8f6f3e", t: "#ff4fd8" },
    grid: make([ARCHED, NOSE, MOUTHS.flat, FEDORA, CHIN_HAND]) },
  { name: "notepad", pal: { ...SKIN.tan, h: "#8a5a34", H: "#5e3a1e", b: "#ff8573", c: "#5a6a8a", C: "#3a4660", t: "#38f6ff", l: "#2e325c", r: "#ff4f6e" },
    grid: make([EYES.dot(), L(M(Ln(22, 26, 29, 26, 2)), "e"), NOSE, MOUTHS.smirk, FEDORA, PAD_HOLD.back, NOTEPAD, PAD_HOLD.tips]) },
  { name: "suspicious", pal: { ...SKIN.deep, h: "#8a55d0", H: "#5a3296", b: "#ffc857", c: "#5a4a9a", C: "#3c3070", t: "#ffc857" },
    grid: make([SQUINT, NOSE, MOUTHS.frown, FEDORA]) },
  { name: "veteran", pal: { ...SKIN.brown, h: "#3a3c4a", H: "#24252f", b: "#4df7a6", c: "#1f5c5a", C: "#123a38", t: "#4df7a6", m: "#9a96aa" },
    grid: make([EYES.sleepy(), L(M(Ln(22, 27, 29, 27, 2)), "m"), NOSE, MOUTHS.smirk, STACHE, FEDORA]) },
];
