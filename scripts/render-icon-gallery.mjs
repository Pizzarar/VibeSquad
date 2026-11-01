// Dev-only: render every portrait to one PNG for the Painter -> Director loop.
// Usage: node scripts/render-icon-gallery.mjs [out.png] [--scale 1|4]   (default 4x; 1x = native 28x28)
// Rows: lead, retired-lead, brainstorm, implement, mechanical, review, audit, spec, art, unknown.
// Two sets side by side: left WITH PROPS, right PROPLESS (headwear & gear). In each set: the 5
// curated palettes (Claude rim), then palette 0 under four more providers.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { transformSync } from "rolldown/utils";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const si = args.indexOf("--scale");
const SCALE = si >= 0 ? Math.max(1, parseInt(args.splice(si, 2)[1], 10) || 4) : 4;
const out = resolve(args[0] ?? join(root, "scratch", "shots", "icons-gallery.png"));
const src = readFileSync(join(root, "src", "pixel.tsx"), "utf8");
const code = transformSync("pixel.tsx", src, { lang: "tsx", jsx: { runtime: "classic" } }).code;
const tmp = join(mkdtempSync(join(tmpdir(), "vs-gallery-")), "pixel.mjs");
writeFileSync(tmp, code);
const { paintPixels, providerSpec, S } = await import(pathToFileURL(tmp).href);

const TYPES = ["lead", "retired-lead", "brainstorm", "implement", "mechanical", "review", "audit", "spec", "art", "unknown"];
const PROVIDERS = ["codex", "gemini", "cursor", "copilot"];
const SEEDS = 5;
const CELL = S * SCALE;
const GAP = 2 * SCALE;
const SPLIT = 4 * SCALE;
const SET_GAP = 12 * SCALE;
const HEAD = 11 * SCALE;
const BG = [16, 14, 28];
const SETS = [
  { title: "WITH PROPS", propless: false, ink: [255, 176, 32] },
  { title: "PROPLESS (HEADWEAR & GEAR)", propless: true, ink: [62, 230, 255] },
];

// Same FNV-1a as pixel.tsx, so we can pick ids that land on each curated palette.
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function idForPalette(type, i) {
  for (let n = 0; ; n++) {
    const id = `${type}-${i}-${n}`;
    if ((hash(id) >>> 5) % SEEDS === i) return id;
  }
}

const cols = SEEDS + PROVIDERS.length;
const SET_W = cols * (CELL + GAP) + SPLIT;
const W = GAP + SETS.length * SET_W + (SETS.length - 1) * SET_GAP;
const H = HEAD + GAP + TYPES.length * (CELL + GAP);
const img = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) img.set([...BG, 255], i * 4);

function blit(px, ox, oy) {
  px.forEach((c, i) => {
    if (!c) return;
    const rgb = [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16));
    const x0 = ox + (i % S) * SCALE;
    const y0 = oy + Math.floor(i / S) * SCALE;
    for (let y = y0; y < y0 + SCALE; y++) for (let x = x0; x < x0 + SCALE; x++) img.set([...rgb, 255], (y * W + x) * 4);
  });
}

// Pixel font for the section headers: 3x5 glyphs, W is 5x5.
const FONT = {
  A: "010101111101101", D: "110101101101110", E: "111100110100111", G: "011100101101011", H: "101101111101101",
  I: "111010010010111", L: "100100100100111", O: "010101101101010", P: "110101110100100", R: "110101110101101",
  S: "011100010001110", T: "111010010010010", W: "1000110001101011010101010", "(": "010100100100010", ")": "010001001001010",
  "&": "010101010101011", " ": "000000000000000",
};
function text(str, ox, oy, ink) {
  const u = Math.max(1, SCALE);
  let cx = 0;
  for (const ch of str) {
    const g = FONT[ch] ?? FONT[" "];
    const gw = g.length / 5;
    for (let i = 0; i < g.length; i++) {
      if (g[i] !== "1") continue;
      const x0 = ox + (cx + (i % gw)) * u;
      const y0 = oy + Math.floor(i / gw) * u;
      for (let y = y0; y < y0 + u; y++) for (let x = x0; x < x0 + u; x++) if (x < W) img.set([...ink, 255], (y * W + x) * 4);
    }
    cx += gw + 1;
  }
}

SETS.forEach((set, si) => {
  const sx = GAP + si * (SET_W + SET_GAP);
  text(set.title, sx, 3 * SCALE, set.ink);
  for (let x = sx; x < sx + SET_W - GAP; x++) for (let y = 9 * SCALE; y < 9 * SCALE + Math.max(1, SCALE / 2); y++) img.set([...set.ink, 255], (y * W + x) * 4);
  TYPES.forEach((type, row) => {
    const oy = HEAD + GAP + row * (CELL + GAP);
    const claude = providerSpec("claude").color;
    for (let i = 0; i < SEEDS; i++) blit(paintPixels(idForPalette(type, i), type, claude, i, set.propless), sx + i * (CELL + GAP), oy);
    const id0 = idForPalette(type, 0);
    PROVIDERS.forEach((p, j) =>
      blit(paintPixels(id0, type, providerSpec(p).color, 0, set.propless), sx + SPLIT + (SEEDS + j) * (CELL + GAP), oy),
    );
  });
});

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
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
for (let y = 0; y < H; y++) img.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]),
);
console.log(`${out} (${W}x${H})`);
