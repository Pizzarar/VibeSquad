// Shared bust parts so every human role sits on the same skeleton (same head size, eye line, shoulders).
// Head: cols 19-44, rows 13-43, chin at row 43. Eye line rows 28-33 (left eye cols 24-27, right 36-39).
// Mouth rows 37-41. Neck rows 40-49. Shoulders rows 47-63. Light comes from the upper left.
import { D, E, I, L, Ln, M, P, PL, R, U } from "./lib.mjs";

export const HEAD_S = U(E(32, 27, 13.5, 14), P([19, 27], [45, 27], [44, 35], [40, 41], [35, 44], [29, 44], [24, 41], [20, 35]));
export const HEAD = L(HEAD_S, "s", { ol: 2, sh: [["S", 3, 0], ["S", 1, 2]] });
export const EARS = [
  L(M(E(18.5, 31, 3, 4)), "s", { ol: 2, sh: [["S", 1, 1]] }),
  L(M(R(18, 30, 18, 32)), "S"),
];
export const NECK = L(R(26, 40, 37, 50), "S", { ol: 2 });

// c = shirt, C = shirt shade. Shoulders curve down from row 47.
export const TORSO_S = (top = 47) => (x, y) => y >= top && E(32, top + 19, 29, 19)(x, y);
export const BODY = (top = 47) => L(TORSO_S(top), "c", { ol: 2, sh: [["C", 4, 0]] });

// Human bust base: body, neck, ears, head. `extra` layers go between body and head (collars etc.).
export const bust = (extra = []) => [BODY(), NECK, ...extra, ...EARS, HEAD];

// ---- face parts
const EYE_W = E(26, 30.5, 2.6, 3.2);
export const EYES = {
  // white eyeballs with pupils looking at the viewer
  round: (look = 0) => [
    L(M(EYE_W), "w", { ol: 1 }),
    L(M(R(25 + look, 30, 26 + look, 32)), "e"),
  ],
  // solid dark eyes with a glint
  dot: () => [L(M(R(25, 29, 27, 32)), "e"), L(M(R(25, 29, 25, 29)), "w")],
  // closed happy arcs
  happy: () => [L(M(PL(2, [23, 32], [26, 29.5], [29, 32])), "e")],
  // flat lids, half closed
  sleepy: () => [L(M(R(23, 30, 28, 31)), "e"), L(M(R(24, 32, 27, 32)), "e")],
};
export const BROWS = (ch = "e", tilt = 0) => L(M(Ln(23, 26 + tilt, 29, 26 - tilt, 2)), ch);
export const NOSE = L(R(31, 34, 32, 35), "n");

// Open smile: dark mouth with a row of teeth along the top.
export const SMILE = (w = 6, h = 4, y = 37) => [
  L(D(E(32, y, w, h), R(0, 0, 63, y - 1)), "o", { ol: 1 }),
  L(R(32 - w + 2, y, 31 + w - 2, y + 1), "w"),
];
// A hand gripping a prop: angled forearm up from the bottom edge (in `sleeve`), fist centred on (cx, cy) with
// finger creases, thumb wrapped over the front. Draw the prop first so it shows above/below the fist.
export const HAND = (cx = 50, cy = 52, sleeve = "c", shade = "C") => [
  L(P([cx - 4, cy + 3], [cx + 5, cy + 3], [cx + 8, 64], [cx - 2, 64]), sleeve, { ol: 2, sh: [[shade, 3, 0]] }),
  L(U(E(cx - 2, cy, 4.5, 5), E(cx + 2, cy, 4.5, 5)), "s", { ol: 2, sh: [["S", 2, 1]] }),
  L(U(R(cx, cy - 1, cx + 5, cy - 1), R(cx, cy + 2, cx + 5, cy + 2)), "S"),
  L(E(cx - 4, cy - 3, 3.2, 2.4), "s", { ol: 1 }),
];

// Hair cap over the top of the head, down to row `cut`.
export const CAP_S = (cut = 22, grow = 2) => I(E(32, 25.5, 14 + grow, 15 + grow), R(0, 0, 63, cut));

// Hand holding a prop from below: forearm + fist behind the prop (draw `back` before the prop), and two
// small fingertips wrapping its side edges at (x0, y) and (x1, y) (draw `tips` after the prop).
export const HOLD = (cx, cy, tips, sleeve = "c", shade = "C") => ({
  back: [
    L(P([cx - 4, cy + 2], [cx + 5, cy + 2], [cx + 8, 64], [cx - 2, 64]), sleeve, { ol: 2, sh: [[shade, 3, 0]] }),
    L(E(cx, cy, 6.5, 5), "s", { ol: 2, sh: [["S", 2, 1]] }),
  ],
  tips: tips.map(([x, y]) => L(E(x + 0.5, y + 0.5, 2, 1.8), "s", { ol: 1, sh: [["S", 0, 1]] })),
});

export const GRIN_LINE = L(PL(2, [27, 38], [29, 40], [35, 40], [37, 38]), "o");
export const BLUSH = L(M(R(21, 35, 23, 36)), "r");
