// Build the cast sprite sheet + review galleries from the layered shape sources in art/cast/.
// Usage: node scripts/build-cast.mjs [--shots <dir>] [--zoom <role>] [--no-dpr]
//   public/cast.png               (only with --legacy-sheet; now built by build-cast-hypno.mjs) 256x640 sheet, 64x64 cells, row = role (fixed order), col = variant 0-3
//   art/cast/piskel/<role>.piskel one 64x64 frame per variant, for hand tweaks in Piskel
//   <shots>/cast64-4x.png         labelled gallery, every sprite at 4x
//   <shots>/cast64-dpr{2,1}.png   every sprite at 32 CSS px (as the app shows it), rendered by Playwright
//                                 at deviceScaleFactor 2 and 1, on the app's --bg (left) and --panel (right)
//   <shots>/cast64-zoom-<role>.png  (--zoom) roles at 3x, for close inspection
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { S, hex, rasterize } from "../art/cast/lib.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
// scratch/ lives in the main checkout, also when building from a linked worktree.
const mainRoot = dirname(execSync("git rev-parse --path-format=absolute --git-common-dir", { cwd: root }).toString().trim());
const SHOTS = resolve(opt("--shots", join(mainRoot, "scratch", "shots")));

export const ROLES = ["lead", "retired-lead", "brainstorm", "implement", "mechanical", "review", "audit", "spec", "art", "unknown"];
const VARIANTS = 4;
const SHOW = 32; // CSS px the app shows a cell at

const cast = {};
for (const role of ROLES) {
  const f = join(root, "art", "cast", `${role}.mjs`);
  if (!existsSync(f)) continue;
  const mod = await import(pathToFileURL(f).href);
  cast[role] = { sprites: mod.variants.map((v) => ({ name: v.name, px: rasterize(v.grid(), v.pal, `${role}/${v.name}`) })) };
  if (cast[role].sprites.length !== VARIANTS) throw new Error(`${role}: ${cast[role].sprites.length} variants, expected ${VARIANTS}`);
}

function png(W, H, img) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) Buffer.from(img.buffer, img.byteOffset + y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function save(file, W, H, img) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png(W, H, img));
  console.log(`${file} (${W}x${H})`);
}

// Sprite sheet: all 10 rows reserved, unauthored roles stay transparent.
const sheetFile = join(root, "public", "cast.png");
{
  const W = S * VARIANTS, H = S * ROLES.length;
  const img = new Uint8Array(W * H * 4);
  ROLES.forEach((role, row) =>
    cast[role]?.sprites.forEach(({ px }, col) => {
      for (let y = 0; y < S; y++) img.set(px.subarray(y * S * 4, (y + 1) * S * 4), ((row * S + y) * W + col * S) * 4);
    }),
  );
  if (args.includes("--legacy-sheet")) save(sheetFile, W, H, img);
  else console.log("public/cast.png untouched: it is built from the Hypnospace busts by scripts/build-cast-hypno.mjs (--legacy-sheet to overwrite)");
}

// Piskel files: one layer, one frame per variant, stored as a single horizontal strip chunk.
for (const role of ROLES.filter((r) => cast[r])) {
  const W = S * VARIANTS;
  const img = new Uint8Array(W * S * 4);
  cast[role].sprites.forEach(({ px }, col) => {
    for (let y = 0; y < S; y++) img.set(px.subarray(y * S * 4, (y + 1) * S * 4), (y * W + col * S) * 4);
  });
  const layer = {
    name: "Layer 1",
    opacity: 1,
    frameCount: VARIANTS,
    chunks: [{ layout: Array.from({ length: VARIANTS }, (_, i) => [i]), base64PNG: `data:image/png;base64,${png(W, S, img).toString("base64")}` }],
  };
  const doc = {
    modelVersion: 2,
    piskel: { name: role, description: cast[role].sprites.map((s) => s.name).join(", "), fps: 2, height: S, width: S, layers: [JSON.stringify(layer)], hiddenFrames: [] },
  };
  const file = join(root, "art", "cast", "piskel", `${role}.piskel`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc));
  console.log(`${file} (${VARIANTS} frames)`);
}

// 3x5 pixel font for labels.
const FONT = {
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110", E: "111100110100111",
  F: "111100110100100", G: "011100101101011", H: "101101111101101", I: "111010010010111", J: "001001001101010",
  K: "101101110101101", L: "100100100100111", M: "101111111101101", N: "110101101101101", O: "010101101101010",
  P: "110101110100100", Q: "010101101110011", R: "110101110101101", S: "011100010001110", T: "111010010010010",
  U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101", Y: "101101010010010",
  Z: "111001010100111", "-": "000000111000000", " ": "000000000000000", 0: "111101101101111", 1: "010110010010111",
  2: "110001010100111", 3: "110001010001110", 4: "101101111001001", 5: "111100110001110", 6: "011100111101111",
  7: "111001010010010", 8: "111101111101111", 9: "111101111001110"
};

const BG = hex("#111326"); // app --panel
const LABEL = hex("#b4aee0");

// Labelled gallery at `scale` (sprite pixels -> image pixels): role on the left, variant names under each cell.
function gallery(scale, file, only) {
  const roles = (only ?? ROLES).filter((r) => cast[r]);
  const T = 2 * Math.max(1, scale / 2); // label pixel size
  const CELL = S * scale, GAP = 8 * T, LABEL_W = 56 * T, SUB = 9 * T;
  const W = GAP + LABEL_W + VARIANTS * (CELL + GAP);
  const H = GAP + roles.length * (CELL + SUB + GAP);
  const img = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) img.set([...BG, 255], i * 4);
  const put = (x, y, rgb) => {
    if (x >= 0 && y >= 0 && x < W && y < H) img.set([...rgb, 255], (y * W + x) * 4);
  };
  const text = (str, ox, oy, ink) => {
    let cx = 0;
    for (const ch of str.toUpperCase()) {
      const g = FONT[ch] ?? FONT[" "];
      for (let i = 0; i < 15; i++) if (g[i] === "1") for (let j = 0; j < T; j++) for (let k = 0; k < T; k++)
        put(ox + (cx + (i % 3)) * T + k, oy + Math.floor(i / 3) * T + j, ink);
      cx += 4;
    }
  };
  const sprite = (px, ox, oy) => {
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        if (!px[(y * S + x) * 4 + 3]) continue;
        const rgb = [...px.subarray((y * S + x) * 4, (y * S + x) * 4 + 3)];
        for (let j = 0; j < scale; j++) for (let i = 0; i < scale; i++) put(ox + x * scale + i, oy + y * scale + j, rgb);
      }
  };
  const x0 = GAP + LABEL_W;
  roles.forEach((role, r) => {
    const oy = GAP + r * (CELL + SUB + GAP);
    text(role, GAP, oy + CELL / 2 - 2 * T, LABEL);
    cast[role].sprites.forEach(({ px, name }, v) => {
      sprite(px, x0 + v * (CELL + GAP), oy);
      text(name, x0 + v * (CELL + GAP), oy + CELL + 3 * T, LABEL);
    });
  });
  save(file, W, H, img);
}

if (opt("--zoom")) gallery(3, join(SHOTS, `cast64-zoom-${opt("--zoom")}.png`), opt("--zoom").split(","));
else gallery(4, join(SHOTS, "cast64-4x.png"));

// DPR galleries: the sheet at half scale in 32 CSS px cells, same CSS as the app's .cast-sprite.
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const groot = execSync("npm root -g").toString().trim();
    // absolute paths skip package "exports" checks (the MCP server bundles its own playwright)
    for (const p of [join(groot, "playwright"), join(groot, "@playwright", "mcp", "node_modules", "playwright")]) {
      try {
        return createRequire(join(groot, "noop.js"))(p);
      } catch {}
    }
  }
  return null;
}
if (!args.includes("--no-dpr") && !opt("--zoom")) {
  const pw = await loadPlaywright();
  if (!pw) console.log("playwright not found: skipped cast64-dpr{1,2}.png");
  else {
    const sheet = `data:image/png;base64,${png(S * VARIANTS, S * ROLES.length, (() => {
      const W = S * VARIANTS, img = new Uint8Array(W * S * ROLES.length * 4);
      ROLES.forEach((role, row) => cast[role]?.sprites.forEach(({ px }, col) => {
        for (let y = 0; y < S; y++) img.set(px.subarray(y * S * 4, (y + 1) * S * 4), ((row * S + y) * W + col * S) * 4);
      }));
      return img;
    })()).toString("base64")}`;
    const cell = (row, col) =>
      `<i style="background-image:url(${sheet});background-size:${SHOW * VARIANTS}px ${SHOW * ROLES.length}px;background-position:-${col * SHOW}px -${row * SHOW}px"></i>`;
    const block = (bg) => `<div class="b" style="background:${bg}">${ROLES.map((role, row) =>
      `<div class="r"><span>${role}</span>${[0, 1, 2, 3].map((c) => cell(row, c)).join("")}</div>`).join("")}</div>`;
    const html = `<!doctype html><html><body><style>
      body{margin:0;background:#070710;font:11px system-ui,sans-serif;color:#b4aee0;display:inline-flex;gap:0}
      .b{padding:10px 12px}.r{display:flex;align-items:center;gap:10px;height:40px}
      span{width:78px}i{display:block;width:${SHOW}px;height:${SHOW}px;background-repeat:no-repeat;image-rendering:pixelated}
    </style>${block("#070710")}${block("#111326")}</body></html>`;
    const browser = await pw.chromium.launch({ channel: "msedge" }).catch(() => pw.chromium.launch());
    for (const dpr of [2, 1]) {
      const page = await browser.newPage({ deviceScaleFactor: dpr, viewport: { width: 800, height: 600 } });
      await page.setContent(html);
      const file = join(SHOTS, `cast64-dpr${dpr}.png`);
      await page.locator("body").screenshot({ path: file });
      console.log(file);
      await page.close();
    }
    await browser.close();
  }
}
