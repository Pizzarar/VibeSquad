// Build the cast sprite sheet + review galleries from the palette-indexed grids in art/cast/.
// Usage: node scripts/build-cast.mjs [--block a2] [--shots <dir>]
//   public/cast.png               128x320 sheet, 32x32 cells, row = role (fixed order), col = variant 0-3
//   <shots>/cast-<block>-4x.png   gallery at 4x, every authored role: plain on the left, neon ring on the right
//   <shots>/cast-<block>-1x.png   same at 1x
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
const BLOCK = opt("--block", "a2");
const SHOTS = resolve(opt("--shots", join(root, "scratch", "shots")));

export const ROLES = ["lead", "retired-lead", "brainstorm", "implement", "mechanical", "review", "audit", "spec", "art", "unknown"];
const VARIANTS = 4;

const cast = {};
for (const role of ROLES) {
  const f = join(root, "art", "cast", `${role}.mjs`);
  if (!existsSync(f)) continue;
  const mod = await import(pathToFileURL(f).href);
  cast[role] = {
    ring: mod.ring,
    sprites: mod.variants.map((v) => ({ name: v.name, px: rasterize(v.grid(), v.pal, `${role}/${v.name}`) })),
  };
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
{
  const W = S * VARIANTS, H = S * ROLES.length;
  const img = new Uint8Array(W * H * 4);
  ROLES.forEach((role, row) =>
    cast[role]?.sprites.forEach(({ px }, col) => {
      for (let y = 0; y < S; y++) img.set(px.subarray(y * S * 4, (y + 1) * S * 4), ((row * S + y) * W + col * S) * 4);
    }),
  );
  save(join(root, "public", "cast.png"), W, H, img);
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
const DISC = hex("#070710");

function gallery(scale, file, only) {
  const roles = only ? [only] : ROLES.filter((r) => cast[r]);
  const CELL = S * scale, GAP = 4 * scale, LABEL_W = 52 * scale, SPLIT = 10 * scale, HEAD = 10 * scale;
  const W = GAP + LABEL_W + 2 * VARIANTS * (CELL + GAP) + SPLIT;
  const H = HEAD + roles.length * (CELL + GAP) + GAP;
  const img = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) img.set([...BG, 255], i * 4);
  const put = (x, y, rgb) => {
    if (x >= 0 && y >= 0 && x < W && y < H) img.set([...rgb, 255], (y * W + x) * 4);
  };
  const text = (str, ox, oy, ink) => {
    let cx = 0;
    for (const ch of str.toUpperCase()) {
      const g = FONT[ch] ?? FONT[" "];
      for (let i = 0; i < 15; i++) if (g[i] === "1") for (let j = 0; j < scale; j++) for (let k = 0; k < scale; k++)
        put(ox + (cx + (i % 3)) * scale + k, oy + Math.floor(i / 3) * scale + j, ink);
      cx += 4;
    }
  };
  const sprite = (px, ox, oy, ring) => {
    if (ring) {
      // Dark disc + 1px neon ring (radius 15.5) behind the sprite, in sprite pixels.
      const rgb = hex(ring);
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const d = Math.hypot(x + 0.5 - 16, y + 0.5 - 16);
          if (d <= 15.5) for (let j = 0; j < scale; j++) for (let i = 0; i < scale; i++) put(ox + x * scale + i, oy + y * scale + j, d > 14.5 ? rgb : DISC);
        }
    }
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const a = px[(y * S + x) * 4 + 3];
        if (!a) continue;
        const rgb = [...px.subarray((y * S + x) * 4, (y * S + x) * 4 + 3)];
        for (let j = 0; j < scale; j++) for (let i = 0; i < scale; i++) put(ox + x * scale + i, oy + y * scale + j, rgb);
      }
  };
  const x0 = GAP + LABEL_W;
  text("PLAIN", x0, 3 * scale, LABEL);
  text("NEON RING", x0 + VARIANTS * (CELL + GAP) + SPLIT, 3 * scale, LABEL);
  roles.forEach((role, r) => {
    const oy = HEAD + r * (CELL + GAP);
    text(role, GAP, oy + CELL / 2 - 2 * scale, LABEL);
    cast[role].sprites.forEach(({ px }, v) => {
      sprite(px, x0 + v * (CELL + GAP), oy, null);
      sprite(px, x0 + VARIANTS * (CELL + GAP) + SPLIT + v * (CELL + GAP), oy, cast[role].ring);
    });
  });
  save(file, W, H, img);
}

gallery(4, join(SHOTS, `cast-${BLOCK}-4x.png`));
gallery(1, join(SHOTS, `cast-${BLOCK}-1x.png`));
// Dev: --zoom <role> writes a 10x single-row gallery for close inspection.
if (opt("--zoom")) gallery(10, join(SHOTS, `cast-zoom-${opt("--zoom")}.png`), opt("--zoom"));
