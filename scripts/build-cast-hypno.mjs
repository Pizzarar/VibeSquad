// Assemble public/cast.png (256x640, 64x64 cells, row = role in CAST_ROWS order, col = variant 0-3) from the H0 Hypnospace
// busts, exported with the Aseprite CLI. Column 0 = art/cast/hypno/<role>-bust.aseprite (the base drawing); columns 1-3 =
// <role>-bust-v{1,2,3}.aseprite from art/cast/hypno/build_variants.lua (contract v2: the same spec as the floor cast, so
// bust column v is the same person as floor variant v in public/office/cast.json).
// Usage: node scripts/build-cast-hypno.mjs [--aseprite <exe>]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const exe = args.includes("--aseprite") ? args[args.indexOf("--aseprite") + 1] : process.env.ASEPRITE ?? "C:/Program Files/Aseprite/Aseprite.exe";

const CELL = 64, VARIANTS = 4;
const ROLES = ["lead", "retired-lead", "brainstorm", "implement", "mechanical", "review", "audit", "spec", "art", "unknown"]; // = CAST_ROWS
// Aseprite file name per role (the brainstorm Buddy is drawn as "buddy"). Every role now has its own bust, so no fallbacks.
const FILE = { brainstorm: "buddy" };
const FALLBACK = {};

function decode(buf) {
  let p = 8, W = 0, H = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("ascii", p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { W = d.readUInt32BE(0); H = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12]) throw new Error("need 8-bit non-interlaced PNG"); }
    if (type === "IDAT") idat.push(d);
    p += 12 + len;
  }
  if (ct !== 6) throw new Error(`expected RGBA PNG, got colour type ${ct}`);
  const raw = inflateSync(Buffer.concat(idat)), bpp = 4, stride = W * bpp, out = new Uint8Array(W * H * bpp);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      const pr = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : (() => { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })();
      out[y * stride + x] = (line[x] + pr) & 255;
    }
  }
  return { W, H, px: out };
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function encode(W, H, img) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let c = 0xffffffff;
    for (const b of body) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    const len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y++) Buffer.from(img.buffer, img.byteOffset + y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const dir = join(root, "art", "cast", "hypno");
const tmp = mkdtempSync(join(tmpdir(), "vs-cast-hypno-"));
const drawn = {};
for (const role of ROLES) {
  const cols = [];
  for (let v = 0; v < VARIANTS; v++) {
    const src = join(dir, `${FILE[role] ?? role}-bust${v ? `-v${v}` : ""}.aseprite`);
    if (!existsSync(src)) break;
    const out = join(tmp, `${role}-${v}.png`);
    execFileSync(exe, ["-b", src, "--color-mode", "rgb", "--frame-range", "0,0", "--save-as", out], { stdio: "pipe" });
    const { W, H, px } = decode(readFileSync(out));
    if (W !== CELL || H !== CELL) throw new Error(`${src}: ${W}x${H}, expected ${CELL}x${CELL}`);
    cols.push(px);
  }
  if (cols.length === 0) continue;
  if (cols.length !== VARIANTS) throw new Error(`${role}: ${cols.length} of ${VARIANTS} variant busts (run art/cast/hypno/build_variants.lua)`);
  drawn[role] = cols;
}
rmSync(tmp, { recursive: true, force: true });

const W = CELL * VARIANTS, H = CELL * ROLES.length;
const img = new Uint8Array(W * H * 4);
ROLES.forEach((role, row) => {
  let src = role;
  while (src && !drawn[src]) src = FALLBACK[src];
  if (!src) throw new Error(`no bust for ${role} and no fallback chain reaches a drawn role`);
  const note = src === role ? `drawn x${VARIANTS}` : `fallback ${src}`;
  for (let col = 0; col < VARIANTS; col++)
    for (let y = 0; y < CELL; y++) img.set(drawn[src][col].subarray(y * CELL * 4, (y + 1) * CELL * 4), ((row * CELL + y) * W + col * CELL) * 4);
  console.log(`${String(row).padStart(2)} ${role.padEnd(13)} ${note}`);
});
const file = join(root, "public", "cast.png");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, encode(W, H, img));
console.log(`${file} (${W}x${H})`);
