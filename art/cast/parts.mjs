// Shared bust parts so every role sits on the same skeleton (same head size, eye line, shoulders).
// Head: cols 7-24 (jaw tapers to chin cols 12-19), rows 8-22. Eye line rows 13-14 (left eye cols 11-12, right 19-20). Shoulders rows 22-31.
import { sym } from "./lib.mjs";

export const HEAD = {
  x: 7,
  y: 8,
  ol: true,
  g: sym([
    "...ssssss",
    "..sssssss",
    ".ssssssss",
    "sssssssss",
    "sssssssss",
    "sssssssss",
    "sssssssss",
    "sssssssss",
    "sssssssss",
    "sssssssss",
    ".Ssssssss",
    ".Ssssssss",
    "..Sssssss",
    "...SSssss",
    ".....SSSS",
  ]),
};

export const EARS = [
  { x: 5, y: 13, ol: true, g: ["ss", "Ss", "ss"] },
  { x: 25, y: 13, ol: true, g: ["ss", "sS", "ss"] },
];

// c = shirt, C = collar/lapel, S = neck.
export const BODY = {
  x: 2,
  y: 22,
  ol: true,
  g: sym([
    "..........SSSS",
    "......ccccCSSS",
    "...ccccccccCSS",
    "..cccccccccCCS",
    ".cccccccccccCC",
    "cccccccccccccc",
    "cccccccccccccc",
    "cccccccccccccc",
    "cccccccccccccc",
    "cccccccccccccc",
  ]),
};

// Plain round eyes with a glint (staring/friendly).
export const eyes = (y = 13) => [
  ["e", [11, y], [12, y], [11, y + 1], [12, y + 1], [19, y], [20, y], [19, y + 1], [20, y + 1]],
  ["w", [11, y], [19, y]],
];

// Side/jaw shading on the head (light from upper left), drawn as dots after HEAD.
export const FACE_SHADE = ["S", [23, 12], [23, 13], [23, 14], [23, 15], [23, 16], [23, 17], [22, 18], [22, 19], [21, 20], [20, 21], [11, 21], [12, 21]];

// Eye styles; left eye cols 10-13, right eye cols 18-21, rows 12-15.
export const EYES = {
  dot: (y = 13) => [
    ["e", [11, y], [12, y], [11, y + 1], [12, y + 1], [19, y], [20, y], [19, y + 1], [20, y + 1]],
    ["w", [11, y], [19, y]],
  ],
  squint: (y = 13) => [["e", [11, y], [12, y], [10, y + 1], [13, y + 1], [19, y], [20, y], [18, y + 1], [21, y + 1]]],
};
