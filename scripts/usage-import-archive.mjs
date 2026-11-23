#!/usr/bin/env node
// usa-42: restore pre-cutover agent logs for the usage dashboard.
//
//   node scripts/usage-import-archive.mjs <home-backup.zip> [--home <dir>] [--dry-run] [--json]
//
// Extracts only the `runner/agents/<id>.jsonl` entries of a VS home-backup zip (scripts/forge-migrate.mjs --backup; an
// optional single top-level folder prefix is accepted) into `<home>/runner/agents-archive/<id>.jsonl`. server/
// providers-catalog.mjs folds that folder read-only next to `runner/agents` (live wins on an id clash).
//
// Invariants:
// - `<home>/runner/agents/` is never written, moved or deleted. Ids already present there or in agents-archive/ are skipped
//   (counted as skipped-dup), so re-running is idempotent. The target dir is refused if it resolves to or into runner/agents.
// - The zip is streamed: one read of the tail (EOCD) and the central directory, then each entry is piped through
//   zlib.inflateRaw into `.<id>.jsonl.part` and renamed into place after its size and CRC-32 check out. Nothing holds the
//   whole archive in memory. No `unzip` / `bsdtar` needed (neither is guaranteed on a forge host).
// - --dry-run writes nothing (it still lists counts and bytes).
// Home default: $VIBESQUAD_HOME, else ~/.vibesquad.
import { closeSync, createReadStream, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { createInflateRaw, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENTRY_RE = /^((?:[^/]+\/)?)runner\/agents\/([^/]+)\.jsonl$/;

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let n = 0;
  while (n < len) {
    const r = readSync(fd, buf, n, len - n, pos + n);
    if (r <= 0) break;
    n += r;
  }
  if (n !== len) throw new Error(`short read at ${pos} (${n}/${len})`);
  return buf;
}

/** Central directory entries of a zip (name, method, flags, sizes, crc, local header offset, mtime). Streams nothing. */
export function listZipEntries(fd) {
  const size = fstatSync(fd).size;
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = readAt(fd, size - tailLen, tailLen);
  let e = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD_SIG) { e = i; break; }
  if (e < 0) throw new Error("not a zip file (no end-of-central-directory record)");
  let count = tail.readUInt16LE(e + 10);
  let cdSize = tail.readUInt32LE(e + 12);
  let cdOffset = tail.readUInt32LE(e + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locPos = size - tailLen + e - 20;
    const loc = locPos >= 0 ? readAt(fd, locPos, 20) : null;
    if (!loc || loc.readUInt32LE(0) !== ZIP64_LOCATOR_SIG) throw new Error("zip64 locator missing");
    const z = readAt(fd, Number(loc.readBigUInt64LE(8)), 56);
    if (z.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new Error("zip64 end-of-central-directory record missing");
    count = Number(z.readBigUInt64LE(32));
    cdSize = Number(z.readBigUInt64LE(40));
    cdOffset = Number(z.readBigUInt64LE(48));
  }
  const cd = readAt(fd, cdOffset, cdSize);
  const out = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CDH_SIG) throw new Error(`bad central directory entry #${n}`);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const dosTime = cd.readUInt16LE(p + 12);
    const dosDate = cd.readUInt16LE(p + 14);
    const crc = cd.readUInt32LE(p + 16);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let local = cd.readUInt32LE(p + 42);
    const name = cd.toString("utf8", p + 46, p + 46 + nameLen).replace(/\\/g, "/");
    let mtimeMs = null;
    for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end;) {
      const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
      let q = x + 4;
      if (id === 0x0001) { // zip64 extended info: only the fields whose 32-bit slot is saturated, in this order
        if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (local === 0xffffffff) { local = Number(cd.readBigUInt64LE(q)); }
      } else if (id === 0x5455 && len >= 5 && (cd[q] & 1)) mtimeMs = cd.readUInt32LE(q + 1) * 1000; // extended timestamp (UTC)
      x += 4 + len;
    }
    if (mtimeMs === null && dosDate) {
      mtimeMs = new Date(1980 + (dosDate >> 9), ((dosDate >> 5) & 15) - 1, dosDate & 31, dosTime >> 11, (dosTime >> 5) & 63, (dosTime & 31) * 2).getTime();
    }
    out.push({ name, flags, method, crc, csize, usize, local, mtimeMs });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The runner/agents/<id>.jsonl entries; accepts no prefix or one common top-level folder (prefers no prefix). */
export function selectAgentEntries(entries) {
  const byPrefix = new Map();
  for (const en of entries) {
    const m = ENTRY_RE.exec(en.name);
    if (!m || !AGENT_ID_RE.test(m[2])) continue;
    if (!byPrefix.has(m[1])) byPrefix.set(m[1], []);
    byPrefix.get(m[1]).push({ ...en, id: m[2] });
  }
  if (!byPrefix.size) return { prefix: null, entries: [] };
  if (byPrefix.has("")) return { prefix: "", entries: byPrefix.get("") };
  if (byPrefix.size === 1) { const [prefix, list] = [...byPrefix][0]; return { prefix, entries: list }; }
  throw new Error(`ambiguous zip layout: runner/agents under several top-level folders (${[...byPrefix.keys()].join(", ")})`);
}

const insideOrSame = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
function realOrSelf(p) { try { return realpathSync(p); } catch { return resolve(p); } }

function crcCheck() {
  let crc = 0;
  let bytes = 0;
  const t = new Transform({ transform(chunk, _enc, cb) { crc = crc32(chunk, crc); bytes += chunk.length; cb(null, chunk); } });
  return { t, result: () => ({ crc: crc >>> 0, bytes }) };
}

async function extractEntry(zipPath, fd, en, dest) {
  const lfh = readAt(fd, en.local, 30);
  if (lfh.readUInt32LE(0) !== LFH_SIG) throw new Error("bad local header");
  const start = en.local + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28);
  const part = join(dest, `.${en.id}.jsonl.part`);
  const final = join(dest, `${en.id}.jsonl`);
  const check = crcCheck();
  const stages = en.csize > 0 ? [createReadStream(zipPath, { start, end: start + en.csize - 1 })] : [Readable.from([])];
  if (en.method === 8 && en.csize > 0) stages.push(createInflateRaw());
  stages.push(check.t, createWriteStream(part, { flags: "wx" }));
  try {
    await pipeline(stages);
    const { crc, bytes } = check.result();
    if (bytes !== en.usize) throw new Error(`size ${bytes} != ${en.usize}`);
    if (crc !== en.crc >>> 0) throw new Error("crc mismatch");
    if (en.mtimeMs) utimesSync(part, new Date(en.mtimeMs), new Date(en.mtimeMs));
    if (existsSync(final)) throw new Error("appeared during import"); // never overwrite
    renameSync(part, final);
    return bytes;
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
}

/** Import (or with dryRun, count) the agent logs of `zipPath` into `<home>/runner/agents-archive/`. */
export async function importArchive(zipPath, { home, dryRun = false, log = () => {} } = {}) {
  const homeDir = resolve(home || process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad"));
  const liveDir = join(homeDir, "runner", "agents");
  const archiveDir = join(homeDir, "runner", "agents-archive");
  const zip = resolve(zipPath);
  const summary = { zip, home: homeDir, archiveDir, dryRun, prefix: null, found: 0, imported: 0, skippedDup: 0, skippedLive: 0, skippedArchive: 0, unsupported: 0, errors: [], bytes: 0 };
  const fd = openSync(zip, "r");
  try {
    const { prefix, entries } = selectAgentEntries(listZipEntries(fd));
    summary.prefix = prefix;
    summary.found = entries.length;
    const realLive = realOrSelf(liveDir);
    if (!dryRun && entries.length) {
      if (existsSync(archiveDir) && insideOrSame(realOrSelf(archiveDir), realLive)) throw new Error(`refusing: ${archiveDir} resolves into ${realLive}`);
      mkdirSync(archiveDir, { recursive: true });
      if (insideOrSame(realOrSelf(archiveDir), realLive)) throw new Error(`refusing: ${archiveDir} resolves into ${realLive}`);
    }
    for (const en of entries) {
      const file = `${en.id}.jsonl`;
      if (existsSync(join(liveDir, file))) { summary.skippedDup += 1; summary.skippedLive += 1; continue; }
      if (existsSync(join(archiveDir, file))) { summary.skippedDup += 1; summary.skippedArchive += 1; continue; }
      if ((en.flags & 1) || (en.method !== 0 && en.method !== 8)) { summary.unsupported += 1; summary.errors.push(`${en.name}: unsupported (method ${en.method}, flags ${en.flags})`); continue; }
      if (dryRun) { summary.imported += 1; summary.bytes += en.usize; continue; }
      try {
        summary.bytes += await extractEntry(zip, fd, en, archiveDir);
        summary.imported += 1;
        if (summary.imported % 500 === 0) log(`  ${summary.imported} imported...`);
      } catch (err) {
        summary.errors.push(`${en.name}: ${err.message}`);
      }
    }
  } finally {
    closeSync(fd);
  }
  return summary;
}

function parseArgs(argv) {
  const opts = { zip: null, home: null, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home") opts.home = argv[++i];
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (!a.startsWith("--") && !opts.zip) opts.zip = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.help || !opts.zip) {
    console.error("usage: node scripts/usage-import-archive.mjs <home-backup.zip> [--home <dir>] [--dry-run] [--json]");
    process.exit(opts.help ? 0 : 2);
  }
  const t0 = Date.now();
  const s = await importArchive(opts.zip, { home: opts.home, dryRun: opts.dryRun, log: (m) => { if (!opts.json) console.error(m); } });
  if (opts.json) console.log(JSON.stringify({ ...s, ms: Date.now() - t0 }, null, 2));
  else {
    console.log(`${s.dryRun ? "[dry-run] " : ""}${s.zip} -> ${s.archiveDir}`);
    console.log(`found ${s.found}  ${s.dryRun ? "would import" : "imported"} ${s.imported}  skipped-dup ${s.skippedDup} (live ${s.skippedLive}, archive ${s.skippedArchive})  unsupported ${s.unsupported}  errors ${s.errors.length}  bytes ${s.bytes}  ${Date.now() - t0} ms`);
    for (const e of s.errors.slice(0, 20)) console.log(`  error: ${e}`);
  }
  process.exit(s.errors.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
