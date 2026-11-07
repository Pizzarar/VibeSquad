// Build the S4 VS mark: runs art/brand/build.lua in Aseprite (batch), then packs the 16/32/48
// PNG exports into public/vibesquad.ico (PNG-compressed ICO entries).
// Usage: node scripts/build-brand.mjs [--aseprite <exe>] [--shots <dir>]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const exe = opt("--aseprite", process.env.ASEPRITE || "C:/Program Files/Aseprite/Aseprite.exe");
const shots = resolve(opt("--shots", join(root, "scratch", "shots")));
mkdirSync(shots, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "vs-brand-"));

const fwd = (p) => p.replace(/\\/g, "/");
const out = execFileSync(exe, [
  "-b",
  "--script-param", `root=${fwd(root)}`,
  "--script-param", `tmp=${fwd(tmp)}`,
  "--script-param", `shots=${fwd(shots)}`,
  "--script", join(root, "art", "brand", "build.lua"),
]).toString();
process.stdout.write(out);
if (!out.includes("brand: ok")) throw new Error("build.lua did not finish");

// ICO: 6-byte header, 16-byte directory entry per image, then the PNG payloads.
const sizes = [16, 32, 48];
const pngs = sizes.map((s) => readFileSync(join(tmp, `ico-${s}.png`)));
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(s, e);
  head.writeUInt8(s, e + 1);
  head.writeUInt8(0, e + 2); // no colour table
  head.writeUInt8(0, e + 3);
  head.writeUInt16LE(1, e + 4); // planes
  head.writeUInt16LE(32, e + 6); // bpp
  head.writeUInt32LE(pngs[i].length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
writeFileSync(join(root, "public", "vibesquad.ico"), Buffer.concat([head, ...pngs]));
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote public/vibesquad.ico (${sizes.join("/")}), shots in ${shots}`);
