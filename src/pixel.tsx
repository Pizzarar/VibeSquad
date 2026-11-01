// Neon-noir cast: one 28x28 pixel portrait per agent type, painted in code, plus provider
// badges (original glyphs + neon palette), synthwave team emblems and raw-token meters.
//
// Portraits use handheld-farm-sim caricature proportions: a big round head and hair fill
// about two thirds of the frame, a 1px neck, and compact shoulders. Props sit on the body
// or the head (caps, goggles, a mug held in both hands), never on a raised arm.
// The agent's job picks the character; the provider only sets the right-hand rim light and
// the badge. A per-agent seed picks skin, hair, jacket and accent so two agents of the same
// type and provider still differ. Each sprite is painted once to a tiny canvas, cached as a
// data URL and scaled up with image-rendering: pixelated (whole multiples of 28 stay crisp).

import type { CSSProperties } from "react";
import type { AgentType } from "./teams";

const S = 28;
const cache = new Map<string, string>();

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- providers: colour + original glyph (never a real logo) -----------------------

export type ProviderSpec = {
  key: string;
  name: string;
  color: string;
  dim: string;
  symbol: string;
};

const PROVIDERS: [RegExp, ProviderSpec][] = [
  [/claude|anthropic/i, { key: "claude", name: "Claude Code", color: "#ff6e59", dim: "#7a2620", symbol: "✶" }],
  [/codex|openai/i, { key: "codex", name: "Codex", color: "#e2e8f0", dim: "#475569", symbol: "●" }],
  [/antigravity|gemini|agy/i, { key: "gemini", name: "Gemini", color: "#00f0ff", dim: "#005f73", symbol: "◆" }],
  [/opencode/i, { key: "opencode", name: "OpenCode", color: "#b86bff", dim: "#4c1d95", symbol: "▲" }],
  [/cursor/i, { key: "cursor", name: "Cursor", color: "#39ff88", dim: "#14532d", symbol: "▸" }],
  [/copilot/i, { key: "copilot", name: "Copilot", color: "#ffd166", dim: "#78350f", symbol: "❖" }],
  [/codewhale|deepseek-harness/i, { key: "codewhale", name: "CodeWhale", color: "#38bdf8", dim: "#1e3a8a", symbol: "≈" }],
  [/^(pi|omp)$/i, { key: "pi", name: "Pi", color: "#ff2a85", dim: "#831843", symbol: "π" }],
];

// Providers without a dedicated row get a stable hue from this list (none collide with the rows above).
export const GENERIC_HUES = ["#a3e635", "#2dd4bf", "#fb923c", "#e879f9", "#60a5fa", "#f43f5e", "#facc15", "#c084fc"];

export type ProviderOverride = { color?: string; symbol?: string; name?: string; dim?: string };
let overrides: Record<string, ProviderOverride> = {};

export function setProviderOverrides(next: Record<string, ProviderOverride> | null | undefined) {
  overrides = next && typeof next === "object" ? next : {};
  cache.clear();
}

export function getProviderOverrides(): Record<string, ProviderOverride> {
  return overrides;
}

/** Keyed by source/tool, not model: "opencode/deepseek/x" is OpenCode. */
export function providerSpec(provider: string, label?: string): ProviderSpec {
  const raw = String(provider ?? "").trim();
  const source = (raw.split("/")[0] || raw).trim();
  const key = source.toLowerCase();
  let spec = PROVIDERS.find(([re]) => re.test(source))?.[1];
  if (!spec) {
    const color = GENERIC_HUES[hash(key || "other") % GENERIC_HUES.length];
    const initial = (label?.trim() || source).match(/[A-Za-z0-9]/)?.[0]?.toUpperCase() || "◈";
    spec = {
      key: key || "other",
      name: label?.trim() || (source ? source.charAt(0).toUpperCase() + source.slice(1) : "Synth"),
      color,
      dim: shade(color, 0.38),
      symbol: initial,
    };
  }
  const o = overrides[key];
  if (o) {
    const color = o.color ?? spec.color;
    spec = {
      ...spec,
      color,
      dim: o.dim ?? (o.color ? shade(o.color, 0.38) : spec.dim),
      symbol: o.symbol ?? spec.symbol,
      name: o.name ?? spec.name,
    };
  }
  return spec;
}

export function providerColor(provider: string): string {
  return providerSpec(provider).color;
}

// ---- colour helpers -------------------------------------------------------------

type RGB = [number, number, number];
const rgb = (c: string): RGB => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as RGB;
const toHex = (v: RGB) => "#" + v.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("");
const mix = (a: string, b: string, t: number) => {
  const x = rgb(a);
  const y = rgb(b);
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as RGB);
};
const shade = (c: string, f: number) => toHex(rgb(c).map((v) => v * f) as RGB);
const grey = (c: string, amount: number) => {
  const [r, g, b] = rgb(c);
  const l = 0.3 * r + 0.59 * g + 0.11 * b;
  return mix(c, toHex([l, l, l]), amount);
};

// ---- the painter -----------------------------------------------------------------

const INK = "#0b0618"; // outline, shared by the whole cast
const AMBIENT = "#c04bff"; // magenta fill light from the left, shared by the whole cast
const DARK = "#160e26";
const WHITE = "#f4f0ff";
const BLUSH = "#ff7a8a";

const SKINS = ["#f2c7a5", "#dca47c", "#bb7c56", "#8e5b3c", "#6b4630", "#f6d6c0"];
const HAIRS = ["#1b1424", "#3a2418", "#5c2f1d", "#7a3b2a", "#26304f", "#6a4ac8", "#2f9c96", "#b8476e"];
const JACKETS = ["#2a1f4f", "#1d2b52", "#3a1d48", "#173b4a", "#2b2b3d", "#41204a"];
const PASTELS = ["#9ff3ff", "#c9a8ff", "#ffb8ec", "#ffe7a3", "#a8ffd9"];

class Sprite {
  px: (string | null)[] = Array(S * S).fill(null);
  fx: boolean[] = Array(S * S).fill(false); // emissive: no rim, no outline, no greying
  in = (x: number, y: number) => x >= 0 && y >= 0 && x < S && y < S;
  get = (x: number, y: number) => (this.in(x, y) ? this.px[y * S + x] : null);
  set = (x: number, y: number, c: string | null) => {
    if (!this.in(x, y)) return;
    this.px[y * S + x] = c;
    this.fx[y * S + x] = false;
  };
  glow = (x: number, y: number, c: string) => {
    if (!this.in(x, y)) return;
    this.px[y * S + x] = c;
    this.fx[y * S + x] = true;
  };
  rect = (x0: number, y0: number, x1: number, y1: number, c: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, c);
  };
  glowRect = (x0: number, y0: number, x1: number, y1: number, c: string) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.glow(x, y, c);
  };
  // A horizontally centred row (centre between x=13 and x=14) of half-width hw.
  row = (y: number, hw: number, c: string) => this.rect(14 - hw, y, 13 + hw, y, c);
  dots = (pts: number[][], c: string) => pts.forEach(([x, y]) => this.set(x, y, c));
  glowDots = (pts: number[][], c: string) => pts.forEach(([x, y]) => this.glow(x, y, c));
  // Stamp a character map. "." is transparent; other characters look up `pal`.
  stamp = (x0: number, y0: number, map: string[], pal: Record<string, string>, emissive = false) =>
    map.forEach((line, y) =>
      [...line].forEach((ch, x) => {
        const c = pal[ch];
        if (c) (emissive ? this.glow : this.set)(x0 + x, y0 + y, c);
      }),
    );
  recolor = (f: (c: string, i: number) => string) => {
    this.px = this.px.map((c, i) => (c && !this.fx[i] ? f(c, i) : c));
  };
}

type Look = {
  r: () => number;
  pick: <T>(xs: T[]) => T;
  skin: string;
  hair: string;
  jacket: string;
  pastel: string;
  neon: string;
  lead?: LeadLook;
};

// Caricature head: wide round cheeks (18px across), y=4..19, then a 1px neck at y=20.
const HEAD: [number, number][] = [
  [4, 5], [5, 7], [6, 8], [7, 9], [8, 9], [9, 9], [10, 9], [11, 9], [12, 9], [13, 9], [14, 9], [15, 9],
  [16, 8], [17, 7], [18, 6], [19, 4],
];
const headHalf = (y: number) => HEAD.find(([yy]) => yy === y)?.[1] ?? 0;

function head(s: Sprite, k: Look, ears = true) {
  for (const [y, hw] of HEAD) s.row(y, hw, y >= 17 ? shade(k.skin, 0.93) : k.skin);
  s.rect(11, 20, 16, 20, shade(k.skin, 0.7)); // short neck in shadow
  if (ears) {
    s.rect(4, 12, 4, 13, shade(k.skin, 0.86));
    s.rect(23, 12, 23, 13, shade(k.skin, 0.86));
  }
  // Nose: a lit bridge and a two-pixel shadow underneath.
  s.set(13, 13, mix(k.skin, "#ffffff", 0.18));
  s.rect(13, 15, 14, 15, shade(k.skin, 0.8));
  s.set(14, 14, shade(k.skin, 0.88));
  // Warm cheeks.
  s.dots([[7, 15], [8, 15], [19, 15], [20, 15]], mix(k.skin, BLUSH, 0.32));
}

type EyeStyle = "open" | "tired" | "narrow" | "glance";
function eyes(s: Sprite, k: Look, style: EyeStyle = "open") {
  const lx = style === "glance" ? 10 : 9;
  const rx = style === "glance" ? 18 : 17;
  if (style === "tired") {
    s.rect(8, 11, 10, 11, shade(k.skin, 0.68)); // heavy lids
    s.rect(17, 11, 19, 11, shade(k.skin, 0.68));
    s.rect(lx, 12, lx + 1, 13, DARK);
    s.rect(rx, 12, rx + 1, 13, DARK);
    s.set(lx + 1, 12, WHITE);
    s.set(rx + 1, 12, WHITE);
    s.rect(9, 14, 10, 14, shade(k.skin, 0.88));
    s.rect(17, 14, 18, 14, shade(k.skin, 0.88));
    return;
  }
  const top = style === "narrow" ? 12 : 11;
  s.rect(lx, top, lx + 1, 13, DARK);
  s.rect(rx, top, rx + 1, 13, DARK);
  s.set(lx + 1, top, WHITE);
  s.set(rx + 1, top, WHITE);
}

type BrowStyle = "flat" | "arched" | "furrow" | "cocked";
function brows(s: Sprite, k: Look, style: BrowStyle = "flat") {
  const c = mix(k.hair, DARK, 0.45);
  if (style === "arched") {
    s.dots([[8, 10], [9, 9], [10, 9], [17, 9], [18, 9], [19, 10]], c);
  } else if (style === "furrow") {
    s.dots([[8, 9], [9, 10], [10, 10], [17, 10], [18, 10], [19, 9]], c);
  } else if (style === "cocked") {
    s.dots([[8, 10], [9, 10], [10, 10], [17, 9], [18, 8], [19, 9]], c);
  } else {
    s.dots([[8, 10], [9, 10], [10, 10], [17, 10], [18, 10], [19, 10]], c);
  }
}

type MouthStyle = "smile" | "grin" | "smirk" | "line" | "content" | "excited";
function mouth(s: Sprite, k: Look, style: MouthStyle) {
  const lip = shade(k.skin, 0.52);
  const crease = shade(k.skin, 0.78);
  switch (style) {
    case "smile":
      s.dots([[10, 16], [17, 16]], lip);
      s.rect(11, 17, 16, 17, lip);
      break;
    case "content":
      s.dots([[11, 16], [16, 16]], lip);
      s.rect(12, 17, 15, 17, lip);
      s.dots([[9, 15], [18, 15]], crease);
      break;
    case "grin":
      // Big toothy grin, wider than the eyes.
      s.dots([[9, 15], [18, 15]], crease);
      s.dots([[9, 16], [18, 16]], lip);
      s.rect(10, 16, 17, 16, WHITE);
      s.rect(10, 17, 17, 17, lip);
      s.dots([[12, 16], [15, 16]], mix(WHITE, k.skin, 0.35)); // tooth gaps
      break;
    case "excited":
      s.dots([[10, 16], [17, 16]], lip);
      s.rect(11, 16, 16, 16, WHITE);
      s.rect(11, 17, 16, 17, DARK);
      s.rect(13, 17, 14, 17, "#e05a7a"); // tongue
      s.rect(12, 18, 15, 18, lip);
      break;
    case "smirk":
      s.rect(11, 17, 15, 17, lip);
      s.dots([[16, 16], [17, 16]], lip);
      s.set(18, 15, crease);
      break;
    case "line":
      s.rect(11, 17, 16, 17, lip);
      break;
  }
  s.dots([[13, 19], [14, 19]], shade(k.skin, 0.85)); // chin
}

type HairStyle = "crop" | "pomp" | "curls" | "part" | "tousled" | "mullet" | "spikes" | "sweep";
function hair(s: Sprite, k: Look, style: HairStyle) {
  const h = k.hair;
  const hi = mix(h, "#ffffff", 0.28);
  const lo = shade(h, 0.78);
  if (style === "pomp") {
    // 80s pompadour swept up and back, forehead showing.
    s.rect(11, 1, 18, 1, h);
    s.rect(8, 2, 20, 2, h);
    s.rect(6, 3, 21, 3, h);
    s.rect(4, 4, 23, 7, h);
    s.rect(4, 8, 7, 8, h);
    s.rect(18, 8, 23, 8, h);
    s.rect(4, 9, 5, 11, lo); // sideburns
    s.rect(22, 9, 23, 11, lo);
    s.dots([[12, 1], [13, 1], [10, 2], [11, 2], [9, 3], [10, 3], [16, 3], [17, 3], [15, 4], [16, 4]], hi);
    s.dots([[8, 7], [9, 7], [10, 7], [17, 7], [18, 7]], lo);
  } else if (style === "curls") {
    s.stamp(3, 1, [
      "...##..##..##..##...",
      "..################..",
      ".##################.",
      "####################",
      "####################",
      "####################",
      "####################",
      "####.##..##..##.####",
      "###............###.",
      "###.............###",
      "##...............##",
      "##...............##",
    ], { "#": h });
    s.dots([[6, 2], [10, 2], [14, 2], [18, 2], [5, 4], [9, 4], [13, 4], [17, 4], [21, 4], [7, 6], [11, 6], [15, 6], [19, 6]], hi);
    s.dots([[4, 7], [8, 7], [12, 7], [16, 7], [20, 7]], lo);
  } else if (style === "part") {
    // Neat side part with a swoop falling to the right.
    s.rect(8, 2, 19, 2, h);
    s.rect(6, 3, 21, 3, h);
    s.rect(4, 4, 23, 7, h);
    s.rect(4, 8, 6, 8, h);
    s.rect(11, 8, 23, 8, h);
    s.rect(15, 9, 22, 9, h);
    s.rect(4, 9, 4, 11, lo);
    s.rect(23, 10, 23, 11, lo);
    s.dots([[9, 3], [9, 4], [9, 5]], shade(k.skin, 0.9)); // the part
    s.dots([[12, 4], [13, 4], [14, 5], [15, 5], [16, 6], [17, 6], [18, 7], [19, 8]], hi);
  } else if (style === "tousled") {
    s.dots([[8, 1], [13, 1], [18, 1]], h);
    s.rect(7, 2, 9, 2, h);
    s.rect(12, 2, 14, 2, h);
    s.rect(17, 2, 20, 2, h);
    s.rect(5, 3, 22, 3, h);
    s.rect(4, 4, 23, 7, h);
    s.dots([[4, 8], [5, 8], [6, 8], [9, 8], [10, 8], [14, 8], [15, 8], [19, 8], [21, 8], [22, 8], [23, 8]], h);
    s.rect(4, 9, 5, 10, lo);
    s.rect(22, 9, 23, 10, lo);
    s.dots([[8, 2], [13, 2], [18, 2], [7, 4], [11, 4], [16, 4], [20, 5]], hi);
  } else if (style === "mullet") {
    // Short choppy top, long at the back: falls past the ears onto the collar.
    s.rect(8, 2, 19, 2, h);
    s.rect(6, 3, 21, 3, h);
    s.rect(4, 4, 23, 7, h);
    s.dots([[5, 8], [6, 8], [9, 8], [10, 8], [13, 8], [14, 8], [17, 8], [18, 8], [21, 8], [22, 8]], h);
    s.rect(2, 7, 4, 19, h);
    s.rect(23, 7, 25, 19, h);
    s.rect(3, 20, 6, 21, lo);
    s.rect(21, 20, 24, 21, lo);
    s.rect(2, 12, 2, 19, lo);
    s.rect(25, 12, 25, 19, lo);
    s.dots([[9, 3], [10, 3], [11, 4], [16, 3], [17, 4], [3, 9], [3, 11], [24, 9], [24, 11]], hi);
  } else if (style === "spikes") {
    // Gelled spikes standing straight up.
    s.stamp(4, 0, [
      ".#....#....#....#...",
      ".##..###..###..##...",
      "###.#####.#####.###.",
      "####################",
    ], { "#": h });
    s.rect(4, 4, 23, 7, h);
    s.dots([[4, 8], [5, 8], [8, 8], [9, 8], [13, 8], [14, 8], [18, 8], [19, 8], [22, 8], [23, 8]], h);
    s.rect(4, 9, 5, 10, lo);
    s.rect(22, 9, 23, 10, lo);
    s.dots([[5, 0], [10, 0], [15, 0], [20, 0], [9, 1], [14, 1], [19, 1], [6, 4], [11, 4], [16, 4]], hi);
  } else if (style === "sweep") {
    // Long side-sweep: a heavy fringe slanting across the brow, long down the right side.
    s.rect(9, 1, 20, 1, h);
    s.rect(6, 2, 23, 2, h);
    s.rect(4, 3, 24, 7, h);
    s.rect(4, 8, 6, 8, h);
    s.rect(10, 8, 24, 8, h);
    s.rect(14, 9, 25, 9, h);
    s.rect(19, 10, 25, 10, h);
    s.rect(22, 11, 25, 18, h);
    s.rect(4, 9, 4, 11, lo);
    s.rect(25, 11, 25, 18, lo);
    s.dots([[7, 3], [8, 3], [10, 4], [12, 5], [14, 6], [16, 7], [18, 8], [20, 9], [23, 12], [23, 14]], hi);
  } else {
    // Short crop with a choppy fringe.
    s.rect(8, 2, 19, 2, h);
    s.rect(6, 3, 21, 3, h);
    s.rect(4, 4, 23, 7, h);
    s.dots([[4, 8], [5, 8], [6, 8], [8, 8], [9, 8], [12, 8], [13, 8], [14, 8], [17, 8], [18, 8], [21, 8], [22, 8], [23, 8]], h);
    s.rect(4, 9, 5, 11, lo);
    s.rect(22, 9, 23, 11, lo);
    s.dots([[9, 3], [10, 3], [11, 4], [12, 4], [16, 3], [17, 4]], hi);
  }
}

type Torso = { color: string; shirt?: string; pads?: boolean; vneck?: boolean };
function torso(s: Sprite, k: Look, t: Torso) {
  const c = t.color;
  s.rect(t.pads ? 5 : 6, 21, t.pads ? 22 : 21, 21, c);
  s.rect(t.pads ? 2 : 3, 22, t.pads ? 25 : 24, 22, c);
  s.rect(2, 23, 25, 27, c);
  // Arm creases so the jacket isn't a flat slab (no raised arms anywhere).
  for (let y = 24; y < S; y++) {
    s.set(6, y, shade(c, 0.82));
    s.set(21, y, shade(c, 0.82));
  }
  if (t.vneck !== false) {
    const shirt = t.shirt ?? WHITE;
    s.rect(11, 21, 16, 21, shirt);
    s.rect(12, 22, 15, 22, shirt);
    s.rect(13, 23, 14, 23, shirt);
    const lap = mix(c, "#ffffff", 0.2);
    s.dots([[10, 21], [11, 22], [12, 23], [13, 24]], lap);
    s.dots([[17, 21], [16, 22], [15, 23], [14, 24]], lap);
  }
}

// ---- the cast ------------------------------------------------------------------

// Lead looks: five buckets per trait. A lane's ordinal picks bucket i for each trait at a
// different stride, so the five lanes never share a skin, cut, hair colour, lens or blazer.
// Leads with no lane fall back to independent hash bits.
const LEAD_SKINS = ["#f6d6c0", "#dca47c", "#8e5b3c", "#4a2e20", "#c9a26b"]; // peach, tan, brown, ebony, olive
const LEAD_CUTS: HairStyle[] = ["pomp", "mullet", "curls", "spikes", "sweep"];
const LEAD_HAIRS = ["#f1f5f9", "#00f0ff", "#ff4fd8", "#f97316", "#231724", "#a855f7", "#fde047", "#1e3a8a"];
const LEAD_LENSES = ["#ffb020", "#00e5ff", "#ff3fb4", "#4dffb0", "#9b5cff"]; // amber, cyan, pink, mint, violet
const LEAD_BLAZERS = ["#e9e4f2", "#4a1d6e", "#0f3b3f", "#6e1424", "#2a2f8a"]; // white, purple, teal-black, crimson, indigo

export type LeadLook = { skin: string; cut: HairStyle; hair: string; lens: string; blazer: string };
export function leadLook(id: string, variant?: number): LeadLook {
  if (variant !== undefined && variant >= 0) {
    const i = variant;
    return {
      skin: LEAD_SKINS[i % 5],
      cut: LEAD_CUTS[(i * 2 + Math.floor(i / 5)) % 5],
      hair: LEAD_HAIRS[(i * 3 + 2) % 8],
      lens: LEAD_LENSES[(i * 3) % 5],
      blazer: LEAD_BLAZERS[(i * 4) % 5],
    };
  }
  const h = hash(id);
  return {
    skin: LEAD_SKINS[(h >>> 3) % 5],
    cut: LEAD_CUTS[(h >>> 7) % 5],
    hair: LEAD_HAIRS[(h >>> 11) % 8],
    lens: LEAD_LENSES[(h >>> 15) % 5],
    blazer: LEAD_BLAZERS[(h >>> 19) % 5],
  };
}

function lead(s: Sprite, k: Look) {
  const L = k.lead ?? leadLook("");
  k = { ...k, skin: L.skin, hair: L.hair };
  const blazer = L.blazer;
  torso(s, k, { color: blazer, shirt: k.pastel, pads: true });
  head(s, k);
  // Popped collar standing up beside the jaw.
  const collar = mix(blazer, "#ffffff", 0.22);
  s.dots([[8, 19], [9, 19], [18, 19], [19, 19]], collar);
  s.rect(7, 20, 10, 20, collar);
  s.rect(17, 20, 20, 20, collar);
  s.set(9, 20, shade(collar, 0.8));
  s.set(18, 20, shade(collar, 0.8));
  // Glowing lapel pin.
  s.glow(19, 24, k.neon);
  s.glow(19, 23, mix(k.neon, "#ffffff", 0.6));
  hair(s, k, L.cut);
  brows(s, k, "cocked");
  // Big wraparound shades; the lens tint is the lead's own colour, sunset-graded.
  const frame = L.blazer === LEAD_BLAZERS[0] ? DARK : mix(DARK, L.lens, 0.18);
  s.rect(5, 11, 22, 11, frame);
  s.rect(6, 12, 12, 13, frame);
  s.rect(15, 12, 21, 13, frame);
  s.rect(13, 12, 14, 12, frame);
  s.glowRect(7, 12, 11, 12, mix(DARK, L.lens, 0.85));
  s.glowRect(16, 12, 20, 12, mix(DARK, L.lens, 0.85));
  s.glowRect(7, 13, 11, 13, mix(DARK, L.lens, 0.5));
  s.glowRect(16, 13, 20, 13, mix(DARK, L.lens, 0.5));
  s.rect(8, 14, 10, 14, frame);
  s.rect(17, 14, 19, 14, frame);
  s.glowDots([[7, 12], [8, 12], [16, 12], [17, 12]], "#ffffff");
  mouth(s, k, "grin");
}

function retiredLead(s: Sprite, k: Look) {
  const blazer = k.pick(["#e9e4f2", "#2a2440", "#1f2d4a", "#3b2350"]);
  torso(s, k, { color: blazer, shirt: k.pastel, pads: true });
  head(s, k);
  hair(s, { ...k, hair: "#a8a4b8" }, "crop");
  // Shades pushed up into the grey hair.
  s.rect(5, 5, 22, 5, DARK);
  s.rect(6, 6, 12, 6, mix(DARK, k.neon, 0.4));
  s.rect(15, 6, 21, 6, mix(DARK, k.neon, 0.4));
  s.set(7, 6, "#ffffff");
  s.set(16, 6, "#ffffff");
  brows(s, { ...k, hair: "#a8a4b8" }, "flat");
  eyes(s, k, "tired");
  mouth(s, k, "content");
  // Greyed out: everything painted so far loses most of its colour.
  s.recolor((c) => grey(c, 0.62));
  // Warm coffee mug cradled at the centre of the chest in both hands.
  const mug = "#d9573b";
  const rim = "#fff3e6";
  s.rect(10, 21, 17, 21, rim);
  s.rect(10, 22, 10, 22, rim);
  s.rect(17, 22, 17, 22, rim);
  s.rect(11, 22, 16, 22, "#4a2a1c"); // coffee
  s.rect(12, 22, 13, 22, "#7a4a30");
  s.rect(10, 23, 17, 27, mug);
  s.rect(11, 23, 11, 27, mix(mug, "#ffffff", 0.35)); // highlight
  s.rect(16, 23, 17, 27, shade(mug, 0.72));
  s.glowRect(11, 25, 16, 25, k.neon); // neon band
  const hand = grey(k.skin, 0.25);
  const knuckle = shade(hand, 0.72);
  // Hands cup the sides; fingers run horizontally across the mug, thumbs on the rim.
  s.rect(8, 23, 10, 26, hand);
  s.rect(8, 24, 10, 24, knuckle);
  s.rect(8, 26, 10, 26, knuckle);
  s.set(9, 22, hand);
  s.rect(17, 23, 19, 26, hand);
  s.rect(17, 24, 19, 24, knuckle);
  s.rect(17, 26, 19, 26, knuckle);
  s.set(18, 22, hand);
  // Soft neon-tinted steam curling up past the chin.
  const steam = mix("#f4f0ff", k.neon, 0.3);
  s.glowDots([[12, 20], [15, 20]], mix(shade(grey(k.skin, 0.62), 0.7), steam, 0.6));
  s.glowDots([[9, 20], [8, 19], [7, 18], [7, 17], [18, 20], [19, 19], [20, 18], [20, 17]], steam);
  s.glowDots([[8, 16], [21, 16]], mix(steam, "#ffffff", 0.5));
}

function brainstorm(s: Sprite, k: Look) {
  torso(s, k, { color: k.jacket, vneck: false });
  // Tracksuit: high zip collar and a pastel colour-block across the chest.
  s.rect(9, 20, 18, 21, k.pastel);
  s.rect(10, 20, 17, 20, mix(k.pastel, "#ffffff", 0.3));
  s.rect(2, 24, 25, 25, k.pastel);
  s.rect(13, 20, 14, 27, "#cfcbe0");
  s.dots([[13, 21], [14, 23], [13, 25], [14, 27]], "#8a86a0");
  head(s, k, false);
  hair(s, k, k.pick<HairStyle>(["curls", "tousled", "curls"]));
  brows(s, k, "arched");
  eyes(s, k, "open");
  mouth(s, k, "excited");
  // Oversized studio headphones hugging the ears.
  const band = "#2a2440";
  s.rect(7, 0, 20, 0, band);
  s.dots([[5, 1], [6, 1], [21, 1], [22, 1]], band);
  s.rect(4, 2, 4, 8, band);
  s.rect(23, 2, 23, 8, band);
  s.rect(8, 0, 19, 0, mix(band, "#ffffff", 0.18));
  s.rect(2, 9, 5, 15, "#1c1830");
  s.rect(22, 9, 25, 15, "#1c1830");
  s.rect(3, 10, 4, 14, "#2c2645");
  s.rect(23, 10, 24, 14, "#2c2645");
  for (let y = 9; y <= 15; y++) {
    s.glow(1, y, k.neon);
    s.glow(26, y, k.neon);
  }
  s.glowDots([[2, 8], [3, 8], [24, 8], [25, 8], [2, 16], [3, 16], [24, 16], [25, 16]], shade(k.neon, 0.7));
  // A little glowing lightbulb of an idea, upper right.
  s.stamp(23, 2, [".oo.", "o##o", "o#w#", "o##o", ".oo.", ".bb."], { o: "#ffe66b", "#": "#fff7c2", w: "#ffffff", b: "#9aa0b8" }, true);
  s.glowDots([[22, 1], [27, 1], [27, 5]], k.neon);
}

function implement(s: Sprite, k: Look) {
  // Satin bomber: sheen streaks and a ribbed neon collar.
  torso(s, k, { color: k.jacket, shirt: WHITE });
  const sheen = mix(k.jacket, "#ffffff", 0.35);
  s.dots([[4, 23], [5, 24], [4, 25], [5, 26]], sheen);
  for (let x = 6; x <= 21; x++) if (x < 11 || x > 16) s.glow(x, 21, x % 2 ? k.neon : shade(k.neon, 0.6));
  s.glowRect(8, 25, 9, 26, k.pastel); // chest patch
  // Steel wrench resting diagonally over the right shoulder: handle tucked behind the
  // collar, open jaw angled up and out beside the jaw line.
  const steel = "#b8c0d8";
  const steelHi = "#eef2ff";
  const steelLo = "#7d86a3";
  s.stamp(23, 13, [
    ".##..",
    "##...",
    "##..#",
    "#####",
    ".###.",
  ], { "#": steel });
  s.dots([[24, 13], [23, 14], [23, 15]], steelHi);
  s.dots([[25, 17], [26, 16]], steelLo);
  const handle: [number, number][] = [[17, 22], [18, 21], [19, 21], [20, 20], [21, 19], [22, 19], [23, 18]];
  handle.forEach(([x, y]) => {
    s.set(x, y, steelHi);
    s.set(x, y + 1, steelLo);
  });
  s.rect(15, 22, 16, 23, steelLo); // end tucked under the collar
  head(s, k);
  hair(s, k, "crop");
  // Mechanic cap with a glowing front patch.
  const cap = shade(k.jacket, 1.45);
  s.rect(9, 1, 18, 1, cap);
  s.rect(7, 2, 20, 2, cap);
  s.rect(6, 3, 21, 4, cap);
  s.rect(5, 5, 22, 7, cap);
  s.glowRect(12, 2, 15, 3, k.neon);
  s.glowDots([[13, 2]], mix(k.neon, "#ffffff", 0.55));
  s.dots([[8, 2], [9, 2], [7, 3]], mix(cap, "#ffffff", 0.25));
  // Tech goggles resting on the brim, strap around the cap.
  s.rect(4, 6, 23, 6, "#2a2440");
  s.rect(6, 5, 10, 7, "#3a3450");
  s.rect(17, 5, 21, 7, "#3a3450");
  s.glowRect(7, 6, 9, 6, mix(k.neon, "#1d3c5a", 0.35));
  s.glowRect(18, 6, 20, 6, mix(k.neon, "#1d3c5a", 0.35));
  s.glowDots([[7, 6], [18, 6]], "#ffffff");
  // Brim and the shadow it throws on the brow.
  s.rect(4, 8, 23, 8, shade(cap, 0.62));
  s.rect(6, 9, 21, 9, shade(k.skin, 0.76));
  brows(s, k, "flat");
  eyes(s, k, "open");
  mouth(s, k, "grin");
}

function mechanical(s: Sprite, k: Look) {
  // Dark work shirt with a hi-vis vest and glowing reflective straps.
  torso(s, k, { color: "#2b2f3d", shirt: "#3a4052" });
  const vest = "#fb8c1e";
  s.rect(3, 22, 9, 27, vest);
  s.rect(18, 22, 24, 27, vest);
  s.rect(2, 23, 2, 27, vest);
  s.rect(25, 23, 25, 27, vest);
  s.rect(7, 21, 9, 21, vest);
  s.rect(18, 21, 20, 21, vest);
  const strip = "#eef7ff";
  for (let y = 21; y < S; y++) {
    s.glow(8, y, strip);
    s.glow(19, y, strip);
  }
  for (let x = 2; x <= 25; x++) if (x < 10 || x > 17) s.glow(x, 26, mix(strip, k.neon, 0.25));
  head(s, k);
  hair(s, k, "crop");
  brows(s, k, "furrow");
  eyes(s, k, "open");
  mouth(s, k, "smile");
  // High-vis construction hard hat: angled sides, raised centre ridge, forward peak.
  const hat = "#facc15";
  const mid = "#eab308";
  const low = "#ca8a04";
  const ridge = "#fef08a";
  s.rect(10, 0, 17, 0, hat);
  s.rect(8, 1, 19, 1, hat);
  s.rect(6, 2, 21, 2, hat);
  s.rect(5, 3, 22, 3, hat);
  s.rect(4, 4, 23, 6, hat);
  s.rect(3, 7, 24, 7, mid); // band where the shell flares out
  s.rect(2, 8, 25, 8, low); // safety peak
  s.dots([[8, 1], [6, 2], [5, 3], [4, 4], [4, 5], [4, 6]], mid);
  s.dots([[19, 1], [21, 2], [22, 3], [23, 4], [23, 5], [23, 6], [22, 4], [22, 5], [22, 6]], mid);
  s.dots([[23, 5], [23, 6]], low);
  s.rect(13, 0, 14, 6, ridge);
  s.dots([[12, 1], [12, 2], [15, 1], [15, 2]], mix(hat, ridge, 0.5));
  s.dots([[8, 3], [9, 2], [10, 1]], "#fff7c2");
  // Headlamp on the front plate.
  s.rect(11, 4, 16, 6, "#3a3450");
  s.glowRect(12, 5, 15, 5, mix(k.neon, "#ffffff", 0.35));
  s.glowRect(13, 4, 14, 4, "#ffffff");
  // Peak shadow across the brow.
  s.rect(5, 9, 22, 9, shade(k.skin, 0.68));
}

function review(s: Sprite, k: Look) {
  // Pastel trench with a popped collar and a tie.
  const coat = k.pick(["#b9a3e3", "#8fd8e8", "#e3a3cf", "#a3b8e3"]);
  torso(s, k, { color: coat, shirt: "#2a2440" });
  s.rect(13, 22, 14, 27, shade(coat, 0.45)); // tie
  s.rect(13, 21, 14, 21, shade(coat, 0.6));
  const collar = mix(coat, "#ffffff", 0.32);
  s.dots([[7, 18], [7, 19], [8, 19], [8, 20], [9, 20], [9, 21]], collar);
  s.dots([[20, 18], [20, 19], [19, 19], [19, 20], [18, 20], [18, 21]], collar);
  s.rect(2, 26, 25, 26, shade(coat, 0.82)); // belt line
  head(s, k);
  hair(s, k, "crop");
  // Fedora tilted low over the left eye, glowing hatband.
  const hat = "#2a2340";
  s.rect(8, 0, 19, 0, hat);
  s.rect(7, 1, 20, 4, hat);
  s.rect(12, 0, 15, 0, shade(hat, 0.65)); // crown pinch
  s.dots([[9, 1], [9, 2], [10, 1]], mix(hat, "#ffffff", 0.22));
  for (let x = 7; x <= 20; x++) s.glow(x, 5, k.neon);
  s.rect(3, 6, 25, 6, hat);
  s.rect(2, 7, 22, 7, hat);
  s.rect(2, 8, 9, 8, shade(hat, 0.85)); // brim dips on the left
  s.dots([[24, 5], [25, 5]], hat);
  // Noir shadow across the brow.
  s.rect(5, 8, 22, 9, shade(k.skin, 0.55));
  s.rect(10, 8, 22, 8, shade(k.skin, 0.62));
  s.rect(5, 10, 8, 10, shade(k.skin, 0.7));
  // One brow raised, a sharp sideways glance.
  brows(s, k, "cocked");
  eyes(s, k, "glance");
  s.rect(10, 11, 11, 11, shade(k.skin, 0.66)); // left eye narrowed under the brim
  mouth(s, k, "smirk");
  // Glowing loupe over the right eye, chain to the lapel.
  const ring = mix(k.neon, "#ffffff", 0.25);
  s.glowDots([[17, 10], [18, 10], [19, 10], [16, 11], [20, 11], [16, 12], [20, 12], [16, 13], [20, 13], [17, 14], [18, 14], [19, 14]], ring);
  s.dots([[17, 11], [17, 12], [17, 13], [19, 12], [19, 13]], mix(k.skin, "#9fd8ff", 0.4));
  s.glowDots([[19, 11]], "#ffffff");
  s.glowDots([[20, 15], [21, 16], [21, 17], [20, 18], [19, 19]], shade(ring, 0.7));
}

function audit(s: Sprite, k: Look) {
  const hood = shade(k.jacket, 1.3);
  const rim = shade(k.jacket, 0.72);
  // Hood up behind the head.
  s.rect(9, 1, 18, 1, hood);
  s.rect(6, 2, 21, 2, hood);
  s.rect(4, 3, 23, 3, hood);
  s.rect(3, 4, 24, 19, hood);
  s.rect(4, 20, 23, 20, hood);
  // Colour-block windbreaker.
  torso(s, k, { color: k.jacket, vneck: false });
  s.rect(2, 24, 25, 25, k.pastel);
  s.rect(2, 25, 25, 25, shade(k.pastel, 0.82));
  s.rect(13, 21, 14, 27, "#cfcbe0");
  head(s, k, false);
  // The hood rim frames the face: anything outside the opening goes back to hood.
  for (let y = 4; y <= 19; y++)
    for (let x = 3; x <= 24; x++) {
      const face = y >= 7 && x >= 6 && x <= 21 && x >= 14 - headHalf(y) && x <= 13 + headHalf(y);
      if (!face) s.set(x, y, hood);
    }
  for (let y = 6; y <= 19; y++) {
    const hw = Math.min(8, headHalf(y));
    if (hw) {
      s.set(13 - hw, y, rim);
      s.set(14 + hw, y, rim);
    }
  }
  s.rect(6, 6, 21, 6, rim);
  s.dots([[6, 2], [7, 2], [4, 4], [4, 5], [3, 6]], mix(hood, "#ffffff", 0.2));
  // Drawstrings with neon tips.
  s.rect(10, 20, 10, 22, "#cfcbe0");
  s.rect(17, 20, 17, 22, "#cfcbe0");
  s.glowDots([[10, 23], [17, 23]], k.neon);
  brows(s, k, "furrow");
  // Recon visor: twin lenses, cyan left and magenta right.
  s.rect(3, 12, 24, 12, "#14121f"); // strap
  s.rect(6, 10, 12, 14, "#1b1a2a");
  s.rect(15, 10, 21, 14, "#1b1a2a");
  s.rect(13, 11, 14, 12, "#1b1a2a");
  s.glowRect(7, 11, 11, 13, "#3ee6ff");
  s.glowRect(16, 11, 20, 13, "#ff4fd8");
  s.glowRect(8, 12, 10, 12, "#a8f7ff");
  s.glowRect(17, 12, 19, 12, "#ffb0ee");
  s.glowDots([[7, 11], [16, 11]], "#ffffff");
  s.glowDots([[12, 10], [21, 10]], k.neon);
  mouth(s, k, "line");
}

function spec(s: Sprite, k: Look) {
  // Synth-knit sweater over a collared shirt and a skinny neon tie.
  torso(s, k, { color: k.jacket, shirt: "#e8ecff" });
  for (let y = 23; y < S; y += 2) for (let x = 3; x <= 24; x += 3) if (x < 11 || x > 16) s.set(x, y, shade(k.jacket, 1.3));
  s.dots([[10, 21], [11, 22], [17, 21], [16, 22]], "#ffffff");
  s.glowRect(13, 21, 14, 21, k.neon);
  s.glowRect(13, 22, 14, 27, shade(k.neon, 0.75));
  // Blueprint roll tucked diagonally across the lower chest.
  const paper = "#1d4f9a";
  const steps: [number, number][] = [[3, 27], [4, 26], [5, 26], [6, 25], [7, 25], [8, 24], [9, 23], [10, 23], [11, 22], [12, 22]];
  steps.forEach(([x, y]) => {
    s.set(x, y - 1, mix(paper, "#ffffff", 0.2));
    s.set(x, y, paper);
    s.set(x, y + 1, shade(paper, 0.75));
  });
  steps.forEach(([x, y], i) => i % 2 === 0 && s.glow(x, y, "#67e8f9"));
  s.glowDots([[13, 20], [13, 21], [2, 27], [2, 28]], "#cfe9ff");
  s.glowDots([[12, 20], [12, 21], [13, 22]], "#9ff3ff");
  head(s, k);
  hair(s, k, "part");
  brows(s, k, "arched");
  // Big geometric 80s frames with tinted lenses.
  const frame = "#2a2440";
  s.rect(6, 10, 12, 10, frame);
  s.rect(15, 10, 21, 10, frame);
  s.rect(6, 14, 12, 14, frame);
  s.rect(15, 14, 21, 14, frame);
  s.rect(6, 11, 6, 13, frame);
  s.rect(12, 11, 12, 13, frame);
  s.rect(15, 11, 15, 13, frame);
  s.rect(21, 11, 21, 13, frame);
  s.rect(13, 11, 14, 11, frame);
  s.dots([[5, 11], [22, 11]], frame);
  const lens = mix(k.skin, "#5fe6ff", 0.42);
  s.rect(7, 11, 11, 13, lens);
  s.rect(16, 11, 20, 13, lens);
  s.rect(9, 11, 10, 13, DARK);
  s.rect(17, 11, 18, 13, DARK);
  s.dots([[10, 11], [18, 11]], WHITE);
  s.glowDots([[7, 12], [8, 11], [16, 12]], "#ffffff");
  s.glowDots([[11, 13], [20, 13]], mix(k.neon, "#ffffff", 0.3));
  mouth(s, k, "smile");
}

function art(s: Sprite, k: Look) {
  // Paintbrush tucked behind the right ear, angled up and out.
  s.dots([[22, 11], [23, 10], [24, 9], [25, 8]], "#c08457");
  s.dots([[22, 12], [23, 11], [24, 10]], "#8c5a36");
  s.dots([[26, 7], [26, 6]], "#cbd5e1");
  s.glowDots([[27, 5], [27, 4], [26, 5]], "#ff3df0");
  // Paint-splattered denim jacket with a lighter collar.
  torso(s, k, { color: "#2c3f73", shirt: k.pastel });
  const denim = "#4a63a6";
  s.dots([[7, 19], [8, 19], [6, 20], [7, 20], [8, 20], [9, 20]], denim);
  s.dots([[19, 19], [20, 19], [18, 20], [19, 20], [20, 20], [21, 20]], denim);
  const paint = [k.neon, "#ff8bd9", "#9ff3ff", "#ffe66b", AMBIENT];
  for (let i = 0; i < 8; i++) {
    const x = 3 + Math.floor(k.r() * 22);
    const y = 23 + Math.floor(k.r() * 5);
    if (x < 11 || x > 16) s.glow(x, y, paint[i % paint.length]);
  }
  head(s, k);
  hair(s, k, k.pick<HairStyle>(["crop", "curls", "tousled"]));
  // A bright 80s streak through the fringe.
  const streak = k.pick(["#ff4fd8", "#3ee6ff", "#ffe66b", "#a8ffd9"]);
  s.dots([[15, 6], [16, 6], [16, 7], [17, 7], [17, 8], [18, 8]], streak);
  brows(s, k, "arched");
  eyes(s, k, "open");
  mouth(s, k, "grin");
  s.glowDots([[6, 16], [7, 16], [7, 17]], "#ff3df0"); // paint smudge on the cheek
  // Jaunty beret slouched to the right, with a neon pin.
  const beret = k.pick(["#5a2a8a", "#b0244f", "#14111f", "#2a5a6a"]);
  s.dots([[11, 0], [12, 0]], shade(beret, 0.8));
  s.rect(8, 1, 18, 1, beret);
  s.rect(5, 2, 22, 2, beret);
  s.rect(4, 3, 24, 4, beret);
  s.rect(5, 5, 24, 5, shade(beret, 0.75));
  s.dots([[24, 6], [23, 6]], shade(beret, 0.6));
  s.dots([[8, 2], [9, 2], [10, 1]], mix(beret, "#ffffff", 0.3));
  s.glowDots([[7, 3]], k.neon);
  s.glowDots([[7, 4]], mix(k.neon, "#ffffff", 0.5));
}

function unknown(s: Sprite, k: Look) {
  // High-collared synth hoodie with neon piping.
  torso(s, k, { color: k.jacket, vneck: false });
  const hood = shade(k.jacket, 1.3);
  s.dots([[7, 19], [8, 19], [19, 19], [20, 19]], hood);
  s.rect(6, 20, 21, 20, hood);
  s.rect(5, 21, 22, 21, hood);
  s.glowRect(9, 20, 18, 20, k.neon);
  s.glowDots([[8, 19], [19, 19]], shade(k.neon, 0.7));
  s.rect(10, 22, 10, 24, "#cfcbe0");
  s.rect(17, 22, 17, 24, "#cfcbe0");
  s.glowDots([[10, 25], [17, 25]], k.neon);
  for (let x = 2; x <= 25; x++) if (x < 9 || x > 18) s.glow(x, 23, shade(k.neon, 0.55));
  head(s, k);
  hair(s, k, "tousled");
  // Neon sweatband across the forehead.
  s.glowRect(4, 8, 23, 8, k.neon);
  s.glowRect(4, 9, 23, 9, shade(k.neon, 0.65));
  s.glowDots([[6, 8], [7, 8]], "#ffffff");
  brows(s, k, "furrow");
  eyes(s, k, "open");
  mouth(s, k, "line");
}

const CAST: Record<AgentType, (s: Sprite, k: Look) => void> = {
  lead,
  "retired-lead": retiredLead,
  brainstorm,
  implement,
  mechanical,
  review,
  audit,
  spec,
  art,
  unknown,
};

// Rim light (provider neon on the right, shared magenta on the left), then a dark outline.
function finish(s: Sprite, neon: string, agentType: AgentType) {
  const rimR = agentType === "retired-lead" ? grey(neon, 0.6) : neon;
  const solid = (x: number, y: number) => s.get(x, y) !== null;
  const next = s.px.slice();
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const c = s.px[i];
      if (!c || s.fx[i]) continue;
      if (!solid(x + 1, y)) next[i] = mix(c, rimR, 0.6);
      else if (!solid(x + 2, y) && x + 2 < S) next[i] = mix(c, rimR, 0.2);
      else if (!solid(x - 1, y)) next[i] = mix(c, AMBIENT, 0.38);
      else if (!solid(x, y - 1)) next[i] = mix(c, "#ffffff", 0.12);
    }
  s.px = next;
  const edge = s.px.map((c, i) => c !== null && !s.fx[i]);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      if (s.px[y * S + x]) continue;
      const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
        const xx = x + dx;
        const yy = y + dy;
        return s.in(xx, yy) && edge[yy * S + xx];
      });
      if (near) s.px[y * S + x] = INK;
    }
}

export function spriteUrl(id: string, agentType: AgentType, neon: string, variant?: number): string {
  const key = `${id}|${agentType}|${neon}|${variant ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const r = rng(hash(id));
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const look: Look = { r, pick, skin: pick(SKINS), hair: pick(HAIRS), jacket: pick(JACKETS), pastel: pick(PASTELS), neon };
  if (agentType === "lead") look.lead = leadLook(id, variant);
  const s = new Sprite();
  (CAST[agentType] ?? CAST.unknown)(s, look);
  finish(s, neon, agentType);
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const ctx = cv.getContext("2d")!;
  s.px.forEach((c, i) => {
    if (!c) return;
    ctx.fillStyle = c;
    ctx.fillRect(i % S, Math.floor(i / S), 1, 1);
  });
  const url = cv.toDataURL();
  cache.set(key, url);
  return url;
}

// ---- components ------------------------------------------------------------------

/** A cast member. The portrait is drawn at the largest whole multiple of 28 that fits `size`. */
export function Avatar({
  id,
  provider,
  providerLabel,
  agentType = "unknown",
  size = 32,
  variant,
}: {
  id: string;
  provider: string;
  providerLabel?: string;
  agentType?: AgentType;
  size?: number;
  /** Lead look bucket (the lane ordinal); leads with none fall back to the id hash. */
  variant?: number;
}) {
  const p = providerSpec(provider, providerLabel);
  const tag = String((hash(id) % 90) + 10);
  const retired = agentType === "retired-lead";
  const img = size >= S ? Math.floor(size / S) * S : size;
  const roleLabel = agentType === "brainstorm" ? "Buddy (brainstorm)" : agentType;

  return (
    <span
      className={`avatar type-${agentType} prov-${p.key} ${retired ? "is-retired" : ""}`}
      style={{ width: size, height: size, "--prov": p.color, "--prov-dim": p.dim } as CSSProperties}
      title={`${roleLabel} · ${p.name} (#${tag})`}
    >
      <img src={spriteUrl(id, agentType, p.color, variant)} width={img} height={img} alt="" />
      <span className="prov-badge" style={{ color: p.color }}>
        {p.symbol}
      </span>
      {size >= 44 && <span className="unit-tag">#{tag}</span>}
    </span>
  );
}

// Synthwave horizon / neon grid emblem for teams and worktrees.
export function NeonEmblem({ color, seed = color, size = 20 }: { color: string; seed?: string; size?: number }) {
  const h = hash(seed);
  const variant = h % 3;
  return (
    <svg
      className="neon-emblem"
      width={size}
      height={size}
      viewBox="0 0 12 12"
      shapeRendering="crispEdges"
      style={{ "--emblem-color": color } as CSSProperties}
    >
      <rect x={0} y={0} width={12} height={12} fill="#080814" />
      {/* Synthwave sun */}
      <rect x={3} y={2} width={6} height={4} fill={color} />
      <rect x={2} y={3} width={8} height={2} fill={color} />
      {/* Scanline cuts through sun */}
      <rect x={2} y={4} width={8} height={1} fill="#080814" />
      {/* Horizon line */}
      <rect x={0} y={7} width={12} height={1} fill="#00f0ff" />
      {/* Perspective grid lines */}
      <rect x={1 + variant} y={8} width={2} height={1} fill={color} opacity={0.75} />
      <rect x={5} y={8} width={2} height={4} fill={color} opacity={0.85} />
      <rect x={8 - variant} y={9} width={2} height={1} fill={color} opacity={0.75} />
      <rect x={0} y={10} width={12} height={1} fill="#b86bff" opacity={0.55} />
    </svg>
  );
}

export function fmtTokens(n: number): string {
  return `${Math.round(n / 1000)}k`;
}

// Context usage meter showing raw tokens against budget (e.g. "114k / 150k").
// Cool cyan/violet for normal levels; amber at warnAt (150k); hot pink (#ff2a85) at alertAt (250k) / capAt (300k).
export function TokenMeter({
  used,
  budget,
  ladder,
}: {
  used?: number | null;
  budget: number;
  ladder?: { warnAt: number; alertAt: number; capAt: number };
}) {
  const val = used ?? 0;
  if (ladder) {
    const cap = Math.max(1, ladder.capAt);
    const pct = Math.min(1, val / cap);
    const warnPct = Math.min(100, Math.max(0, (ladder.warnAt / cap) * 100));
    const alertPct = Math.min(100, Math.max(0, (ladder.alertAt / cap) * 100));
    const tone = val >= ladder.alertAt ? "alert" : val >= ladder.warnAt ? "warn" : "cool";
    const text = `${fmtTokens(val)} / ${fmtTokens(ladder.warnAt)} · ${fmtTokens(ladder.alertAt)} auto · ${fmtTokens(ladder.capAt)} cap`;
    return (
      <div
        className={`meter ${tone} meter-ladder`}
        data-testid="lead-token-meter"
        title={`Lead context: ${val.toLocaleString()} tokens (soft flag at ${ladder.warnAt.toLocaleString()}, auto-handoff at ${ladder.alertAt.toLocaleString()}, hard cap ${ladder.capAt.toLocaleString()})`}
      >
        <div className="meter-track" style={{ position: "relative" }}>
          <div className="meter-fill" style={{ width: `${pct * 100}%` }} />
          <span
            className="brainstorm-ctx-marker"
            style={{ left: `${warnPct}%` }}
            title={`Soft flag (${fmtTokens(ladder.warnAt)})`}
          />
          <span
            className="brainstorm-ctx-marker"
            style={{ left: `${alertPct}%` }}
            title={`Auto-handoff (${fmtTokens(ladder.alertAt)})`}
          />
        </div>
        <span className="meter-readout">{text}</span>
      </div>
    );
  }
  const pct = Math.min(1, val / budget);
  const tone = pct >= 0.9 ? "alert" : pct >= 0.72 ? "warn" : "cool";
  const text = `${fmtTokens(val)} / ${fmtTokens(budget)}`;
  return (
    <div className={`meter ${tone}`} title={`${val.toLocaleString()} / ${budget.toLocaleString()} tokens`}>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="meter-readout">{text}</span>
    </div>
  );
}
