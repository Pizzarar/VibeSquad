// lead: the ringmaster. A huge round head that is mostly grin, goofy mismatched eyes, a small suited body.
// Big-head arcade-mascot energy (Lethal League vibe), nothing copied: no candy head, no top hat, no toppers.
// Variants differ in head shape, grin, eyes and outfit, not just colour.
import { D, E, I, L, M, P, PL, R, T, U, compose } from "./lib.mjs";

// Small body tucked right under the head.
const SHOULDERS = I(E(32, 72, 19, 24), R(0, 46, 63, 63));
const OUTFITS = {
  bowtie: [
    L(SHOULDERS, "c", { ol: 2, sh: [["C", 3, 0]] }),
    L(P([26, 47], [38, 47], [32, 58]), "w"),
    L(U(PL(2, [26, 48], [31, 58]), PL(2, [38, 48], [33, 58])), "C"),
    L(U(P([25, 48], [31, 51], [25, 54]), P([39, 48], [33, 51], [39, 54])), "b", { ol: 1 }),
    L(R(30, 49, 33, 52), "b", { ol: 1 }),
  ],
  tie: [
    L(SHOULDERS, "c", { ol: 2, sh: [["C", 3, 0]] }),
    L(P([25, 47], [39, 47], [32, 60]), "w"),
    L(P([30, 48], [34, 48], [35, 58], [32, 63], [29, 58]), "b", { ol: 1 }),
    L(U(PL(2, [25, 48], [31, 60]), PL(2, [39, 48], [33, 60])), "C"),
  ],
  turtleneck: [
    L(SHOULDERS, "c", { ol: 2, sh: [["C", 3, 0]] }),
    L(R(25, 46, 38, 51), "b", { ol: 1, sh: [["C", 0, 1]] }),
    L(I(SHOULDERS, (x, y) => y > 53 && y % 4 === 0), "C"),
  ],
  collar: [
    L(SHOULDERS, "c", { ol: 2, sh: [["C", 3, 0]] }),
    L(U(P([22, 46], [32, 50], [26, 56]), P([42, 46], [32, 50], [38, 56])), "w", { ol: 1 }),
    L(U(E(28, 50, 3, 2.5), E(36, 50, 3, 2.5), E(32, 50.5, 1.8)), "b", { ol: 1 }),
    L(U(R(31, 56, 32, 57), R(31, 60, 32, 61)), "b"),
  ],
};

// Grin: dark mouth, upper teeth following the top curve, lower teeth band.
const grin = (mouth, gap = false) => [
  L(mouth, (x, y) => {
    if (!mouth(x, y - 5)) return gap && (x === 31 || x === 32) ? "o" : x % 5 === 2 ? "g" : "w";
    if (!mouth(x, y + 3)) return x % 5 === 0 ? "g" : "w";
    return "o";
  }, { ol: 2 }),
];
const MOUTHS = {
  wide: D(E(32, 31, 19, 14), E(32, 22, 22, 10)),
  lopsided: D(E(33, 32, 18, 13), T(E(30, 22, 22, 10), 0, 0), E(46, 25, 7, 6)),
  tall: D(E(32, 33, 15, 13), E(32, 25, 18, 9)),
  flat: D(E(32, 30, 20, 13), E(32, 23, 24, 8)),
};

const eye = (cx, cy, rx, ry, px, py, pw = 3, ph = 3) => [
  L(E(cx, cy, rx, ry), "w", { ol: 2, sh: [["g", 0, 2]] }),
  L(R(px, py, px + pw - 1, py + ph - 1), "e"),
  L(R(px, py, px, py), "w"),
];

const lead = ({ head, mouth, gap, tongue, eyes, outfit }) => () =>
  compose([
    OUTFITS[outfit],
    L(head, "h", { ol: 2, sh: [["H", 4, 1], ["H", 0, 3]] }),
    grin(MOUTHS[mouth], gap),
    tongue && L(I(MOUTHS[mouth], E(32, 42, 7, 3)), "O"),
    tongue === "out" && L(U(E(39, 45, 4, 4.5), R(35, 41, 43, 44)), "O", { ol: 2, sh: [["o", 0, 1]] }),
    L(M(E(11.5, 31, 2.5, 2)), "r"),
    eyes,
  ]);

export const variants = [
  { name: "sunny", pal: { h: "#ffc857", H: "#d9902e", c: "#ff4fd8", C: "#b52a95", b: "#38f6ff" },
    grid: lead({ head: E(32, 27, 24, 22), mouth: "wide", tongue: true, outfit: "bowtie",
      eyes: [...eye(21, 13, 7.5, 8.5, 22, 13, 4, 5), ...eye(42, 16, 4.5, 5, 41, 14, 3, 3)] }) },
  { name: "minty", pal: { h: "#4df7a6", H: "#22a86b", c: "#8f5cff", C: "#5a34b8", b: "#ffc857" },
    grid: lead({ head: E(32, 28, 25.5, 20), mouth: "flat", gap: true, outfit: "tie",
      eyes: [...eye(43, 15, 7, 8, 40, 16, 4, 4), ...eye(21, 17, 5, 5.5, 21, 18, 3, 3)] }) },
  { name: "bubble", pal: { h: "#ff7fe0", H: "#c93fae", c: "#2fb8e8", C: "#1a6f9a", b: "#ffc857" },
    grid: lead({ head: E(32, 26, 22, 23.5), mouth: "tall", tongue: "out", outfit: "turtleneck",
      eyes: [...eye(23, 12, 6.5, 7.5, 21, 13, 4, 4), L(R(16, 9, 30, 11), "h"), L(R(16, 11, 30, 12), "k"), ...eye(41, 13, 5, 6.5, 42, 12, 3, 4)] }) },
  { name: "grape", pal: { h: "#c28cff", H: "#8456c8", c: "#ff8a3d", C: "#b8551a", b: "#4df7a6" },
    grid: lead({ head: E(32, 27, 24, 22), mouth: "lopsided", tongue: true, outfit: "collar",
      eyes: [...eye(22, 14, 6.5, 7.5, 25, 14, 4, 4), ...eye(42, 13, 6, 9, 37, 15, 4, 4)] }) },
];
