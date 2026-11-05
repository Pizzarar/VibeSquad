// Cast sprite toolkit. Sprites are 32x32, authored as palette-indexed char grids (one char per pixel,
// "." = transparent). A sprite is a stack of layers; a layer with `ol` gets a 1px near-black outline
// (4-neighbour) drawn under it, so hats, props and heads separate from whatever is behind them.
// A layer with `clip` only paints over pixels that are already filled (and not outline).
export const S = 32;

// Mirror a left half into a full row: sym(["ab"]) -> ["abba"]; odd=true shares the middle column.
export function sym(rows, odd = false) {
  return rows.map((r) => r + [...r].reverse().slice(odd ? 1 : 0).join(""));
}

// Shared keys, merged under each variant palette.
export const BASE = {
  k: "#14101e", // outline
  w: "#f6f3ff", // eye white / teeth
  e: "#14101e", // pupil
  o: "#7a1d3a", // mouth
  r: "#ff8a9a", // blush
};

export const SKIN = {
  light: { s: "#f6c9a0", S: "#d39472", n: "#e8a383" },
  tan: { s: "#dc9a68", S: "#b06d45", n: "#c98256" },
  brown: { s: "#a96a42", S: "#7e4a2c", n: "#94593a" },
  deep: { s: "#7a4a2e", S: "#56311d", n: "#6a3f27" },
};

// layers: [{ g: rows, x, y, ol?: boolean }]; returns 32 strings of 32 chars.
export function compose(layers, name = "?") {
  const c = Array.from({ length: S }, () => Array(S).fill("."));
  for (const { g, x = 0, y = 0, ol = false, clip = false } of layers) {
    const w = g[0].length;
    g.forEach((r, j) => {
      if (r.length !== w) throw new Error(`${name}: layer row ${j} is ${r.length} wide, expected ${w}: "${r}"`);
    });
    const on = (i, j) => j >= 0 && j < g.length && i >= 0 && i < w && g[j][i] !== ".";
    if (ol)
      for (let j = -1; j <= g.length; j++)
        for (let i = -1; i <= w; i++) {
          if (on(i, j)) continue;
          if (!(on(i - 1, j) || on(i + 1, j) || on(i, j - 1) || on(i, j + 1))) continue;
          const X = x + i, Y = y + j;
          if (X >= 0 && X < S && Y >= 0 && Y < S) c[Y][X] = "k";
        }
    g.forEach((r, j) =>
      [...r].forEach((ch, i) => {
        const X = x + i, Y = y + j;
        if (ch === "." || X < 0 || X >= S || Y < 0 || Y >= S) return;
        if (clip && (c[Y][X] === "." || c[Y][X] === "k")) return;
        c[Y][X] = ch;
      }),
    );
  }
  return c.map((r) => r.join(""));
}

// Single pixels / small marks without outline: dots(["e", [11,13],[12,13]]).
export function dots(...groups) {
  const c = Array.from({ length: S }, () => Array(S).fill("."));
  for (const [ch, ...pts] of groups) for (const [x, y] of pts) c[y][x] = ch;
  return { g: c.map((r) => r.join("")), x: 0, y: 0 };
}

export function hex(h) {
  return [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
}

// -> Uint8 RGBA 32x32
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

// Horizontal run of points for dots(): run(10, 13, 12) -> [[10,12]..[13,12]].
export const run = (x0, x1, y) => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y]);

// Left-right mirror of a whole layer grid.
export const flip = (rows) => rows.map((r) => [...r].reverse().join(""));

// Full-frame ellipse layer (centre/radii in pixels): ellipse(15.5, 15, 9, 8, "s").
export function ellipse(cx, cy, rx, ry, ch) {
  const g = Array.from({ length: S }, (_, y) =>
    Array.from({ length: S }, (_, x) => (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1 ? ch : ".")).join(""),
  );
  return { g, x: 0, y: 0 };
}

// Repaint a layer's own pixels: fn(X, Y, ch) -> new char or falsy to keep. Returns a no-outline layer.
export function paint({ g, x = 0, y = 0 }, fn) {
  const c = Array.from({ length: S }, () => Array(S).fill("."));
  g.forEach((r, j) =>
    [...r].forEach((ch, i) => {
      const X = x + i, Y = y + j;
      if (ch === "." || X < 0 || X >= S || Y < 0 || Y >= S) return;
      const out = fn(X, Y, ch);
      if (out) c[Y][X] = out;
    }),
  );
  return { g: c.map((r) => r.join("")), x: 0, y: 0 };
}
