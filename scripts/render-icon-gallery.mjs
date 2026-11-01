// Dev-only: render every portrait at 4x to one PNG for the Painter -> Director loop.
// Usage: node scripts/render-icon-gallery.mjs [out.png]
// Rows: lead, retired-lead, brainstorm, implement, mechanical, review, audit, spec, art, unknown.
// Left block: the 5 curated palettes (Claude rim). Right block: palette 0 under all 9 providers.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { transformSync } from "rolldown/utils";

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(root, "scratch", "shots", "icons-gallery.png"));
const src = readFileSync(join(root, "src", "pixel.tsx"), "utf8");
const code = transformSync("pixel.tsx", src, { lang: "tsx", jsx: { runtime: "classic" } }).code;
const tmp = join(mkdtempSync(join(tmpdir(), "vs-gallery-")), "pixel.mjs");
writeFileSync(tmp, code);
const { paintPixels, providerSpec, S } = await import(pathToFileURL(tmp).href);

const TYPES = ["lead", "retired-lead", "brainstorm", "implement", "mechanical", "review", "audit", "spec", "art", "unknown"];
const PROVIDERS = ["claude", "codex", "gemini", "opencode", "cursor", "copilot", "codewhale", "pi", "aider"];
const SEEDS = 5;
const SCALE = 4;
const CELL = S * SCALE;
const GAP = 8;
const SPLIT = 32;
const BG = [16, 14, 28];

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
const W = GAP + cols * (CELL + GAP) + SPLIT;
const H = GAP + TYPES.length * (CELL + GAP);
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

TYPES.forEach((type, row) => {
  const oy = GAP + row * (CELL + GAP);
  const claude = providerSpec("claude").color;
  for (let i = 0; i < SEEDS; i++) blit(paintPixels(idForPalette(type, i), type, claude, i), GAP + i * (CELL + GAP), oy);
  const id0 = idForPalette(type, 0);
  PROVIDERS.forEach((p, j) => blit(paintPixels(id0, type, providerSpec(p).color, 0), GAP + SPLIT + (SEEDS + j) * (CELL + GAP), oy));
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
