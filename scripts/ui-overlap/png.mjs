// Minimal PNG decoder (8-bit, non-interlaced, colour types 2/6) so the guard can sample pixels
// from Playwright screenshots without a dependency.
import zlib from "node:zlib";

export function decodePng(buf) {
  let p = 8, width = 0, height = 0, colorType = 6;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("ascii", p + 4, p + 8);
    if (type === "IHDR") {
      width = buf.readUInt32BE(p + 8);
      height = buf.readUInt32BE(p + 12);
      colorType = buf[p + 17];
      if (buf[p + 16] !== 8 || buf[p + 20] !== 0) throw new Error("unsupported PNG (bit depth/interlace)");
    } else if (type === "IDAT") idat.push(buf.subarray(p + 8, p + 8 + len));
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`unsupported PNG colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[dst + x] = v & 255;
    }
  }
  return { width, height, bpp, data: out };
}

export const lum = (r, g, b) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
export const contrast = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

/** Parses rgb()/rgba()/color(srgb ...) into {r,g,b,a} (0-255, a 0-1) or null. */
export function parseColor(s) {
  if (!s) return null;
  let m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s.trim());
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : +m[4] };
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(s.trim());
  if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] === undefined ? 1 : +m[4] };
  return null;
}

/** Samples a CSS-px box of a decoded screenshot: median colour + largest row-to-row luminance step. */
export function sampleBox(img, box, dpr) {
  const x0 = Math.max(0, Math.floor(box.x * dpr)), x1 = Math.min(img.width, Math.ceil((box.x + box.w) * dpr));
  const y0 = Math.max(0, Math.floor(box.y * dpr)), y1 = Math.min(img.height, Math.ceil((box.y + box.h) * dpr));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const { data, width, bpp } = img;
  const xs = Math.max(1, Math.floor((x1 - x0) / 120));
  const rs = [], gs = [], bs = [];
  const rowMeans = [];
  const ry0 = y0 + Math.floor((y1 - y0) * 0.15), ry1 = y1 - Math.floor((y1 - y0) * 0.15);
  for (let y = y0; y < y1; y++) {
    let sum = 0, n = 0;
    for (let x = x0; x < x1; x += xs) {
      const i = (y * width + x) * bpp;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      sum += 0.299 * r + 0.587 * g + 0.114 * b; n++;
      if ((y - y0) % 2 === 0) { rs.push(r); gs.push(g); bs.push(b); }
    }
    if (y >= ry0 && y < ry1) rowMeans.push(sum / n);
  }
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  let step = 0, stepAt = -1;
  for (let i = 1; i < rowMeans.length; i++) {
    const d = Math.abs(rowMeans[i] - rowMeans[i - 1]);
    if (d > step) { step = d; stepAt = i; }
  }
  return { r: med(rs), g: med(gs), b: med(bs), step, stepRow: stepAt >= 0 ? (ry0 - y0 + stepAt) / dpr : -1 };
}
