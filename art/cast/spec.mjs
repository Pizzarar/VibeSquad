// spec: CRT-monitor head in a suit, face on the screen, brick phone (one carries a floppy instead).
import { compose, dots, run } from "./lib.mjs";
import { BODY } from "./parts.mjs";

// Case h/H/i, bezel b, screen l, side panel vents k, power led y. Screen = cols 8-20, rows 7-16.
const CRT = { x: 5, y: 4, ol: true, g: [
  "hhhhhhhhhhhhhhhhhhhhhH",
  "hiiiiiiiiiiiiiiiiiiihH",
  "hhbbbbbbbbbbbbbbbhhhhH",
  "hhblllllllllllllbhhhhH",
  "hhblllllllllllllbhkkhH",
  "hhblllllllllllllbhhhhH",
  "hhblllllllllllllbhkkhH",
  "hhblllllllllllllbhhhhH",
  "hhblllllllllllllbhkkhH",
  "hhblllllllllllllbhhhhH",
  "hhblllllllllllllbhhhhH",
  "hhblllllllllllllbhhhhH",
  "hhblllllllllllllbhhhhH",
  "hhbbbbbbbbbbbbbbbhhhhH",
  "hhhhhhhhhhhhhhhhhhyhhH",
  "HHHHHHHHHHHHHHHHHHHHHH",
] };
const STAND = { x: 11, y: 20, ol: true, g: ["HHHHHHHHH", "HHHHHHHHH"] };
const TIE = dots(["t", [15, 23], [16, 23], [15, 24], [16, 24], [15, 25], [16, 25], [15, 26], [16, 26], [15, 27], [16, 27]]);
const RABBIT_EARS = { x: 9, y: 0, ol: true, g: [
  "g...........g",
  ".g.........g.",
  "..g.......g..",
  "...ggggggg...",
] };

const PHONE = { x: 24, y: 15, ol: true, g: [
  ".a..",
  ".a..",
  "aaaa",
  "azza",
  "aaaa",
  "aqqa",
  "aqqa",
  "ssss",
  "sssn",
  "sss.",
] };
const FLOPPY = { x: 23, y: 19, ol: true, g: [
  "ffffff",
  "fggggf",
  "fggggf",
  "ffffff",
  "fwwwwf",
  "ssssff",
  "snsss.",
  "ssss..",
] };

// Screen faces, drawn in screen-glyph colour L on screen colour l.
const SMILE = ["L", [11, 9], [12, 9], [11, 10], [12, 10], [16, 9], [17, 9], [16, 10], [17, 10], [10, 12], [18, 12], ...run(11, 17, 13)];
const HAPPY = ["L", [11, 10], [12, 9], [13, 10], [15, 10], [16, 9], [17, 10], [11, 12], ...run(11, 17, 13), [17, 12], ...run(12, 16, 14)];
const PROMPT = ["L", [10, 9], [11, 10], [12, 11], [11, 12], [10, 13], ...run(14, 18, 13), [8, 7]];
const WINK = ["L", [11, 9], [12, 9], [11, 10], [12, 10], ...run(15, 18, 10), [11, 13], [12, 14], [13, 14], [14, 14], [15, 14], [16, 13]];
const SCANLINES = ["m", ...run(8, 20, 8), ...run(8, 20, 11), ...run(8, 20, 14)];

const base = (face, prop, extra = []) => [BODY, TIE, STAND, ...extra, CRT, dots(SCANLINES), dots(face), prop].filter(Boolean);

export const variants = [
  {
    name: "smiley",
    pal: { h: "#e3dcc8", H: "#a59c86", i: "#fffaf0", b: "#3b3a4a", l: "#38c8ff", m: "#2fb4e8", L: "#14101e", y: "#4df7a6",
      c: "#3a4270", C: "#262c52", S: "#f6f3ff", t: "#ff4fd8", a: "#c9ccd8", z: "#4df7a6", q: "#5b6078", s: "#f6c9a0", n: "#d39472" },
    grid: () => compose(base(SMILE, PHONE), "spec/smiley"),
  },
  {
    name: "happy",
    pal: { h: "#c9ccd8", H: "#8a8ea4", i: "#f4f6ff", b: "#2a2838", l: "#ffc857", m: "#f0b444", L: "#5a2a14", y: "#ff4fd8",
      c: "#8f5cff", C: "#5a34b8", S: "#f6f3ff", t: "#ffc857", a: "#ff4fd8", z: "#e6feff", q: "#ffd0f4", s: "#a96a42", n: "#7e4a2c" },
    grid: () => compose(base(HAPPY, PHONE), "spec/happy"),
  },
  {
    name: "terminal",
    pal: { h: "#5b6078", H: "#3a3e52", i: "#8a90ac", b: "#14101e", l: "#0c2a1c", m: "#103522", L: "#4df7a6", y: "#4df7a6",
      c: "#d8d2c0", C: "#a69e86", S: "#2a2838", t: "#4df7a6", f: "#ff4fd8", g: "#c9ccd8", w: "#f6f3ff", s: "#dc9a68", n: "#b06d45" },
    grid: () => compose(base(PROMPT, FLOPPY), "spec/terminal"),
  },
  {
    name: "wink",
    pal: { h: "#ff8fd8", H: "#c2509e", i: "#ffd6f2", b: "#2a2838", l: "#2a1840", m: "#341e50", L: "#ff4fd8", y: "#38f6ff",
      g: "#c9ccd8", c: "#1f6f80", C: "#134a56", S: "#f6f3ff", t: "#38f6ff", a: "#ffc857", z: "#ff4fd8", q: "#a9803e", s: "#f6c9a0", n: "#d39472" },
    grid: () => compose(base(WINK, PHONE, [RABBIT_EARS]), "spec/wink"),
  },
];

export const ring = "#4df7a6";
