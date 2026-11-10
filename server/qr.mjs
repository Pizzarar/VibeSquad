import QRCode from "qrcode";

let libPromise;
function loadLib() {
  libPromise ??= Promise.resolve(QRCode).catch(() => null);
  return libPromise;
}

function toSvg(matrix, margin = 2) {
  const n = matrix.length;
  const size = n + margin * 2;
  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (matrix[y][x]) d += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
  );
}

/**
 * Returns the QR as terminal text (two modules per row with half blocks; `vs pair` over SSH). Dark modules print as
 * block characters on the default background, so it scans best on a dark terminal; a light one still scans.
 */
export async function qrTerminal(text) {
  const lib = await loadLib();
  if (lib?.toString) {
    try {
      return await lib.toString(text, { type: "terminal", small: true, errorCorrectionLevel: "M" });
    } catch {}
  }
  const m = encodeQr(text);
  const n = m.length;
  const at = (y, x) => (y >= 0 && y < n && x >= 0 && x < n ? Boolean(m[y][x]) : false);
  const lines = [];
  for (let y = -2; y < n + 2; y += 2) {
    let line = "";
    for (let x = -2; x < n + 2; x++) {
      const top = at(y, x);
      const bottom = at(y + 1, x);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}

/** Returns an SVG string (white background, black modules) encoding `text`. */
export async function qrSvg(text) {
  const lib = await loadLib();
  if (lib?.toString) {
    try {
      return await lib.toString(text, { type: "svg", margin: 2, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
    } catch {}
  }
  return toSvg(encodeQr(text));
}

// ---- Pure-JS QR encoder: byte mode, EC level M, versions 1-10 ----

// Per version: [ecPerBlock, [[blockCount, dataCodewords], ...]]
const BLOCKS = [
  null,
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsEncode(data, ecLen) {
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gmul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const rem = new Array(ecLen).fill(0);
  for (const b of data) {
    const f = b ^ rem.shift();
    rem.push(0);
    if (f) for (let j = 0; j < ecLen; j++) rem[j] ^= gmul(gen[j + 1], f);
  }
  return rem;
}

function bch(value, poly, bits) {
  const top = (n) => 31 - Math.clz32(n);
  let v = value << bits;
  for (let i = top(v); i >= top(poly); i--) if (v & (1 << i)) v ^= poly << (i - top(poly));
  return (value << bits) | v;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(m) {
  const n = m.length;
  let p = 0;
  let dark = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) dark++;
  for (let pass = 0; pass < 2; pass++) {
    const at = (a, b) => (pass ? m[b][a] : m[a][b]);
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        if (at(a, b) === at(a, b - 1)) run++;
        else {
          if (run >= 5) p += 3 + run - 5;
          run = 1;
        }
      }
      if (run >= 5) p += 3 + run - 5;
      for (let b = 0; b + 10 < n; b++) {
        const s = Array.from({ length: 11 }, (_, i) => (at(a, b + i) ? 1 : 0)).join("");
        if (s === "10111010000" || s === "00001011101") p += 40;
      }
    }
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
  p += Math.abs(Math.ceil((dark * 100) / (n * n) / 5) - 10) * 10;
  return p;
}

/** Encodes `text` (UTF-8) to a boolean matrix. `forceMask` pins the mask pattern (used by tests). */
export function encodeQr(text, forceMask) {
  const bytes = [...Buffer.from(text, "utf8")];
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const [, groups] = BLOCKS[v];
    const cap = groups.reduce((s, [n, d]) => s + n * d, 0);
    const need = Math.ceil((4 + (v < 10 ? 8 : 16) + bytes.length * 8) / 8);
    if (need <= cap) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error("text too long for the built-in QR encoder");
  const [ecLen, groups] = BLOCKS[version];
  const capBytes = groups.reduce((s, [n, d]) => s + n * d, 0);

  const bits = [];
  const push = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach((b) => push(b, 8));
  push(0, Math.min(4, capBytes * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; data.length < capBytes; pad ^= 0xec ^ 0x11) data.push(pad);

  const dataBlocks = [];
  let off = 0;
  for (const [n, d] of groups) {
    for (let i = 0; i < n; i++) {
      dataBlocks.push(data.slice(off, off + d));
      off += d;
    }
  }
  const ecBlocks = dataBlocks.map((b) => rsEncode(b, ecLen));
  const stream = [];
  for (let i = 0; i < Math.max(...dataBlocks.map((b) => b.length)); i++) for (const b of dataBlocks) if (i < b.length) stream.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) stream.push(b[i]);

  const n = version * 4 + 17;
  const m = Array.from({ length: n }, () => new Array(n).fill(false));
  const fn = Array.from({ length: n }, () => new Array(n).fill(false)); // function-pattern / reserved modules
  const set = (r, c, v) => {
    if (r < 0 || c < 0 || r >= n || c >= n) return;
    m[r][c] = v;
    fn[r][c] = true;
  };
  const finder = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++)
      for (let dc = -1; dc <= 7; dc++) {
        const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        set(r0 + dr, c0 + dc, dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && ring !== 2);
      }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const al = ALIGN[version];
  for (const r of al)
    for (const c of al) {
      if ((r === 6 && c === 6) || (r === 6 && c === al[al.length - 1]) || (c === 6 && r === al[al.length - 1])) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  const drawFormat = (mask) => {
    const f = bch((0b00 << 3) | mask, 0x537, 10) ^ 0x5412; // EC level M = 00
    const bit = (i) => ((f >> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(i, 8, bit(i));
    set(7, 8, bit(6));
    set(8, 8, bit(7));
    set(8, 7, bit(8));
    for (let i = 9; i < 15; i++) set(8, 14 - i, bit(i));
    for (let i = 0; i < 8; i++) set(8, n - 1 - i, bit(i));
    for (let i = 8; i < 15; i++) set(n - 15 + i, 8, bit(i));
    set(n - 8, 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    const v = bch(version, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const b = ((v >> i) & 1) === 1;
      const a = n - 11 + (i % 3);
      const c = Math.floor(i / 3);
      set(a, c, b);
      set(c, a, b);
    }
  }

  const bitAt = (i) => (stream[i >> 3] >> (7 - (i & 7))) & 1;
  const place = (mask) => {
    const out = m.map((row) => row.slice());
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < n; v++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const r = ((right + 1) & 2) === 0 ? n - 1 - v : v;
          if (fn[r][c]) continue;
          const bit = i < stream.length * 8 ? bitAt(i) === 1 : false;
          i++;
          out[r][c] = bit !== MASKS[mask](r, c);
        }
      }
    }
    return out;
  };

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask != null && mask !== forceMask) continue;
    const out = place(mask);
    drawFormat(mask);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (fn[r][c]) out[r][c] = m[r][c];
    const s = penalty(out);
    if (s < bestScore) {
      bestScore = s;
      best = out;
    }
  }
  return best;
}
