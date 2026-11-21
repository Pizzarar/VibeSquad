// Android launcher icon parity unit: the APK must ship the Windows VS mark (src-tauri/icons/icon.png),
// not Tauri's default icon. `src-tauri/gen/` is gitignored, so build-android.mjs syncs the committed
// mipmaps into the generated project on every build; these tests pin that sync and the adaptive safe zone.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { ANDROID_ICON_SOURCE_DIR, ensureAndroidIcons, ensureAndroidRoundIcon } from "../server/build-android.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const srcIcons = ANDROID_ICON_SOURCE_DIR;

/** Minimal 8-bit RGBA PNG reader (no deps) so the safe-zone assertions can inspect real pixels. */
function readPngRgba(buf) {
  assert.equal(buf.readUInt32BE(0), 0x89504e47, "png signature");
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  assert.equal(bitDepth, 8, "8-bit png");
  assert.equal(colorType, 6, "RGBA png");
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = width * 4, out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = line[x]; break;
        case 1: v = line[x] + a; break;
        case 2: v = line[x] + b; break;
        case 3: v = line[x] + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unsupported png filter ${filter}`);
      }
      cur[x] = v & 255;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, data: out };
}

function opaqueBbox(file) {
  const { width, height, data } = readPngRgba(readFileSync(file));
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { width, height, minX, minY, maxX, maxY };
}

function tmpRes() {
  const dir = mkdtempSync(join(tmpdir(), "vs-android-icons-"));
  mkdirSync(join(dir, "res"), { recursive: true });
  return { dir, res: join(dir, "res") };
}

test("ensureAndroidIcons copies every committed launcher icon byte-for-byte, then is a no-op", () => {
  const { dir, res } = tmpRes();
  try {
    assert.equal(ensureAndroidIcons(res), true);
    const files = [
      "mipmap-mdpi/ic_launcher.png",
      "mipmap-mdpi/ic_launcher_foreground.png",
      "mipmap-hdpi/ic_launcher_round.png",
      "mipmap-xhdpi/ic_launcher.png",
      "mipmap-xxhdpi/ic_launcher_foreground.png",
      "mipmap-xxxhdpi/ic_launcher.png",
      "mipmap-xxxhdpi/ic_launcher_foreground.png",
      "mipmap-xxxhdpi/ic_launcher_round.png",
      "mipmap-anydpi-v26/ic_launcher.xml",
      "mipmap-anydpi-v26/ic_launcher_round.xml",
      "values/ic_launcher_background.xml",
    ];
    for (const rel of files) {
      assert.ok(existsSync(join(res, rel)), `${rel} copied`);
      assert.deepEqual(readFileSync(join(res, rel)), readFileSync(join(srcIcons, rel)), `${rel} byte-identical`);
    }
    assert.equal(ensureAndroidIcons(res), false, "second sync writes nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureAndroidIcons replaces Tauri's default icon in an already-initialized gen project", () => {
  const { dir, res } = tmpRes();
  try {
    const stale = join(res, "mipmap-xxxhdpi", "ic_launcher.png");
    mkdirSync(join(res, "mipmap-xxxhdpi"), { recursive: true });
    writeFileSync(stale, "tauri-default-icon");
    assert.equal(ensureAndroidIcons(res), true);
    assert.deepEqual(readFileSync(stale), readFileSync(join(srcIcons, "mipmap-xxxhdpi", "ic_launcher.png")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureAndroidRoundIcon declares the round mipmap once and leaves other manifests alone", () => {
  const { dir } = tmpRes();
  try {
    const manifest = join(dir, "AndroidManifest.xml");
    writeFileSync(manifest, '<manifest>\n    <application\n        android:icon="@mipmap/ic_launcher"\n        android:label="@string/app_name">\n        <activity />\n    </application>\n</manifest>\n');
    assert.equal(ensureAndroidRoundIcon(manifest), true);
    const once = readFileSync(manifest, "utf8");
    assert.match(once, /android:roundIcon="@mipmap\/ic_launcher_round"/);
    assert.equal(once.match(/android:roundIcon/g).length, 1);
    assert.equal(ensureAndroidRoundIcon(manifest), false, "idempotent");
    assert.equal(ensureAndroidRoundIcon(join(dir, "missing.xml")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureAndroidIcons is a no-op when the generated res/ tree is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-android-icons-missing-"));
  try {
    assert.equal(ensureAndroidIcons(join(dir, "res")), false);
    assert.equal(existsSync(join(dir, "res")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adaptive foreground is safe-zone padded (plate inside the 72dp safe square)", () => {
  const expected = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
  for (const [density, size] of Object.entries(expected)) {
    const file = join(srcIcons, `mipmap-${density}`, "ic_launcher_foreground.png");
    const bbox = opaqueBbox(file);
    assert.equal(bbox.width, size);
    assert.equal(bbox.height, size);
    // Android adaptive icons: 108dp canvas, 72dp safe square => 18dp (16.67%) inset each side.
    const safeInset = Math.floor(size * (18 / 108));
    assert.ok(bbox.minX >= safeInset, `${density} left inset ${bbox.minX} >= ${safeInset}`);
    assert.ok(bbox.minY >= safeInset, `${density} top inset ${bbox.minY} >= ${safeInset}`);
    assert.ok(bbox.maxX <= size - 1 - safeInset, `${density} right inset`);
    assert.ok(bbox.maxY <= size - 1 - safeInset, `${density} bottom inset`);
    // Centred square plate, not full-bleed (odd sizes can differ by one pixel).
    assert.ok(Math.abs(bbox.minX - (size - 1 - bbox.maxX)) <= 1, `${density} horizontally centred`);
    assert.ok(Math.abs(bbox.minY - (size - 1 - bbox.maxY)) <= 1, `${density} vertically centred`);
  }
});

test("legacy and round mipmaps match the Windows mark framing", () => {
  for (const [density, size] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
    const legacy = opaqueBbox(join(srcIcons, `mipmap-${density}`, "ic_launcher.png"));
    const margin = Math.floor(size * (16 / 192));
    assert.equal(legacy.width, size);
    assert.equal(legacy.minX, margin, `${density} legacy margin`);
    assert.equal(legacy.maxX, size - 1 - margin, `${density} legacy right margin`);
    const round = opaqueBbox(join(srcIcons, `mipmap-${density}`, "ic_launcher_round.png"));
    const roundMargin = Math.floor(size * (8 / 192));
    assert.ok(round.minX <= roundMargin + 1 && round.minY <= roundMargin + 1, `${density} round circle`);
  }
});

test("adaptive background is the logo's dark plate, never Tauri's white", () => {
  const xml = readFileSync(join(srcIcons, "values", "ic_launcher_background.xml"), "utf8");
  const m = xml.match(/<color name="ic_launcher_background">#([0-9A-Fa-f]{6})<\/color>/);
  assert.ok(m, "hex colour present");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  assert.ok(luminance < 30, `background ${m[0]} is a dark plate (luminance ${luminance})`);
  assert.notEqual(m[1].toUpperCase(), "FFFFFF");
  for (const name of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
    const adaptive = readFileSync(join(srcIcons, "mipmap-anydpi-v26", name), "utf8");
    assert.match(adaptive, /@mipmap\/ic_launcher_foreground/);
    assert.match(adaptive, /@color\/ic_launcher_background/);
  }
});

test("PWA icons use the same dark plate composition at 192 and 512", () => {
  for (const size of [192, 512]) {
    const file = join(root, "public", `vibesquad-${size}.png`);
    const bbox = opaqueBbox(file);
    assert.equal(bbox.width, size);
    assert.equal(bbox.height, size);
    assert.deepEqual([bbox.minX, bbox.minY, bbox.maxX, bbox.maxY], [0, 0, size - 1, size - 1], "opaque plate");
  }
});
