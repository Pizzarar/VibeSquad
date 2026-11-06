// Cast sprite toolkit (64px masters). A sprite is a stack of layers; each layer is a shape (a predicate
// over pixel coords) filled with one palette char (or a char function). A layer with `ol: n` gets an
// n-px near-black outline drawn under it, so hats, props and heads separate from whatever is behind.
// A layer with `clip` only paints over pixels that are already filled (and not outline).
// Shown at 32 CSS px: DPR 2 sees every pixel, DPR 1 sees every other one, so key features are >= 2px.
export const S = 64;

// ---- shapes: (x, y) -> bool, tested at the pixel centre. Polygon/line coords are in pixel-edge space.
export const E = (cx, cy, rx, ry = rx) => (x, y) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
export const R = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
export const P = (...pts) => (x, y) => {
  const px = x + 0.5, py = y + 0.5;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
// Thick segment (capsule) of width w.
export const Ln = (x0, y0, x1, y1, w = 2) => (x, y) => {
  const px = x + 0.5, py = y + 0.5, dx = x1 - x0, dy = y1 - y0;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy)) <= w / 2;
};
export const U = (...f) => (x, y) => f.some((g) => g(x, y));
// Polyline of thick segments.
export const PL = (w, ...p) => U(...p.slice(1).map((q, i) => Ln(...p[i], ...q, w)));
export const D = (a, ...b) => (x, y) => a(x, y) && !b.some((g) => g(x, y));
export const I = (...f) => (x, y) => f.every((g) => g(x, y));
// Mirror across the sprite's centre line (between cols 31 and 32).
export const M = (f) => (x, y) => f(x, y) || f(S - 1 - x, y);
export const T = (f, dx, dy) => (x, y) => f(x - dx, y - dy);
export const FX = (f) => (x, y) => f(S - 1 - x, y);
export const pts = (...list) => (x, y) => list.some(([a, b]) => a === x && b === y);

// L(shape, ch, { ol, clip, sh: [[ch, dx, dy]...] }): `sh` repaints layer pixels whose (x+dx, y+dy)
// neighbour falls outside the layer (edge shading; later entries win).
export const L = (s, c, o = {}) => ({ s, c, ...o });

const OFFS = {};
function offsets(n) {
  if (OFFS[n]) return OFFS[n];
  const out = [];
  for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) if ((dx || dy) && dx * dx + dy * dy <= n * n + 0.5) out.push([dx, dy]);
  return (OFFS[n] = out);
}

// -> 64 strings of 64 chars.
export function compose(layers) {
  const c = Array.from({ length: S }, () => Array(S).fill("."));
  for (const layer of layers.flat(3)) {
    if (!layer) continue;
    const { s, c: fill, ol = 0, clip = false, sh = [] } = layer;
    const m = new Uint8Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (s(x, y)) m[y * S + x] = 1;
    const on = (x, y) => x >= 0 && y >= 0 && x < S && y < S && m[y * S + x] === 1;
    if (ol)
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          if (on(x, y)) continue;
          if (clip && (c[y][x] === "." || c[y][x] === "k")) continue;
          if (offsets(ol).some(([dx, dy]) => on(x + dx, y + dy))) c[y][x] = "k";
        }
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        if (!on(x, y)) continue;
        if (clip && (c[y][x] === "." || c[y][x] === "k")) continue;
        let ch = typeof fill === "function" ? fill(x, y, c[y][x]) : fill;
        for (const [sc, dx, dy] of sh) if (!on(x + dx, y + dy)) ch = sc;
        if (ch) c[y][x] = ch;
      }
  }
  return c.map((r) => r.join(""));
}

// Shared keys, merged under each variant palette.
export const BASE = {
  k: "#14101e", // outline
  w: "#f6f3ff", // eye white / teeth
  e: "#14101e", // pupil
  o: "#5a1430", // mouth
  O: "#e0506e", // tongue
  r: "#ff8a9a", // blush
  g: "#b9b2d6", // tooth / white shade
};

export const SKIN = {
  light: { s: "#f6c9a0", S: "#d39472", n: "#e0997a" },
  tan: { s: "#dc9a68", S: "#b06d45", n: "#c47f52" },
  brown: { s: "#a96a42", S: "#7e4a2c", n: "#8e5434" },
  deep: { s: "#7a4a2e", S: "#56311d", n: "#64391f" },
};

export function hex(h) {
  return [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
}

// -> Uint8 RGBA 64x64
export function rasterize(grid, palette, name = "?") {
  const pal = { ...BASE, ...palette };
  const px = new Uint8Array(S * S * 4);
  grid.forEach((r, y) =>
    [...r].forEach((ch, x) => {
      if (ch === ".") return;
      const h = pal[ch];
      if (!h) throw new Error(`${name}: no palette entry for "${ch}" at ${x},${y}`);
      px.set([...hex(h), 255], (y * S + x) * 4);
    }),
  );
  return px;
}
