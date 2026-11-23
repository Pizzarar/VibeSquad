#!/usr/bin/env node
// Forge cutover C2a (docs/PLAN_FORGE_CUTOVER.md C2a/C3): move the dev pp VibeSquad home to the forge.
// Owner 11-22: "transfer over only whats needed and nuke the rest". This script never deletes owner data, in any mode;
// the "nuke" is a separate owner step after the reports below are read. The only removals it performs are of things it
// created itself moments earlier in the same run: its scratch dir (removeOwnScratch) and the private temp refs under
// refs/vs-migrate-wip/ that exist only so `git bundle create` can name a WIP / stash commit.
//
//   node scripts/forge-migrate.mjs --from <win home copy> --to <dest> [--dry-run] [--force] [--json]
//        [--win-user <u> | --win-home <C:\Users\u>] [--win-localappdata <dir>]
//        [--forge-home <dir>] [--projects-root <dir>] [--vs-home-root <dir>] [--worktrees-root <dir>]
//   node scripts/forge-migrate.mjs --from <home> --backup <dir> [--bundle] [--dry-run]  (archive of the FULL home)
//   node scripts/forge-migrate.mjs --unpushed-report [--sanctuary <dir>] [--json]       (read-only git report)
//   node scripts/forge-migrate.mjs --bundle --bundle-dir <dir> [--sanctuary <dir>]      (git bundles of unpushed work)
//
// Migrate (allowlist): copies only ALLOWLIST below; every other top-level entry is printed as "left behind" with its
// size, so nothing drops silently. The forge keeps its own identity (FORGE_OWNED is never copied). JSON / JSONL / .md /
// .txt files get their Windows paths rewritten through the path map (case-insensitive, `\`, `/` and JSON-escaped `\\`):
//   <win-home>\projects\<P>...                -> <projects-root>/<P>...      (default <forge-home>/projects)
//   <win-localappdata>\VibeSquad\worktrees... -> <worktrees-root>/...        (default <vs-home-root>/worktrees)
//   <win-localappdata>\VibeSquad\runtime...   -> <vs-home-root>/runtime/...  (server/runtime-dir.mjs POSIX default)
//   <win-home>\.vibesquad...                  -> <vs-home-root>/...          (default <forge-home>/.vibesquad)
// A JSON string that is one whole path is converted entirely (spaces and parens included). Elsewhere a path ends at
// whitespace or one of ,;:()[]{}; if the same token goes on with a backslash after that (`My Game\x`, `Demo(1)\x`)
// the match is left as it was and shows up as UNMAPPED instead of being half converted. `file:///C:/` and `\\?\C:\`
// forms are left alone (UNMAPPED). JSON is validated with JSON.parse and only the string tokens that change are
// re-encoded (numbers, key order, whitespace stay byte-identical); a key whose rewrite would collide with another key in
// the same object keeps its original text and is reported. JSONL is done line by line (bad lines kept verbatim).
// Unparseable JSON and non-UTF-8 text are copied verbatim and reported. Writes go to a temp file renamed into place.
// The source is only ever read (it is the C3 rollback): before every mkdir / write / rename the nearest existing
// ancestor of the target is realpath'd (junctions and symlinks resolved) and the write is refused if it lands in the
// source; a link or junction anywhere on the paths --to would write (--to itself, the allowlisted entries under it) is
// refused. Also refused: non-empty --to without --force, --to equal to / inside / containing --from. With --force,
// allowlisted files are overwritten and nothing else in --to is touched. --dry-run writes nothing.
//
// --backup <dir>: <dir>/vibesquad-home-<timestamp>.zip (win32: %SystemRoot%\System32\tar.exe, which writes zip) or
// .tar.gz (POSIX tar), names passed NUL-separated (--null). Regular files only; lock files, sockets, links/junctions
// and files that cannot be opened are skipped and reported. With --bundle the bundles go into the archive too.
//
// --unpushed-report: walks the worktree sanctuary (server/team-worktrees.mjs resolveManagedWorktreeRoot, two levels:
// <root>/<repo>/<unit>). Per distinct git common dir: local branches with commits on no remote
// (`rev-list --branches --not --remotes`, then per branch) and stash entries; per worktree: dirty files and a detached
// HEAD with commits on no branch or remote. Folders that are not git worktrees are listed. "Pushed" means "on a
// remote-tracking ref as of the last fetch": this script never fetches. No prune, no gc, no index refresh.
//
// --bundle: for the same branch set, one thin bundle per worktree (`<repo>__<worktree>.bundle`: branches checked out in
// or named after it, a detached HEAD, and a WIP commit of its dirty tree that exists only in the bundle), one per repo
// (`<repo>__repo.bundle`: unpushed branches no worktree owns, and every stash entry), `git bundle verify` on each,
// and manifest.json. Bundle dir: --bundle-dir, else <backup>/vibesquad-bundles-<ts>; never inside the source home or
// the sanctuary.
import { spawnSync } from "node:child_process";
import {
  closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, statSync, utimesSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveManagedWorktreeRoot } from "../server/team-worktrees.mjs";
import { main as docsSyncMain } from "./forge-docs-sync.mjs"; // C2 --sync-docs / --verify-briefs live there

export const ALLOWLIST = [
  "teams.json", "teams", "inbox.json", "lessons.jsonl", "profiles.json", "settings.json", "stakes-ladder.json",
  "schedules.json", "capped-providers.json", "brief-history", "reports",
];
/** Never copied even if someone adds them to ALLOWLIST: the forge's own identity, CA and pairing. */
export const FORGE_OWNED = ["runtime", "worktrees", "tls", "devices.json", "host-id", "local-token", "daemon-password", "vapid.json", "host-keypair.json", "push-subs.json"];
const UNMAPPED_CAP = 50;
const FORGE_HOME_PLACEHOLDER = "/home/<forge-user>";

// ---------------------------------------------------------------- args
const VALUE_FLAGS = ["from", "to", "backup", "sanctuary", "bundle-dir", "win-user", "win-home", "win-localappdata", "forge-home", "projects-root", "vs-home-root", "worktrees-root"];
const BOOL_FLAGS = { "dry-run": "dryRun", force: "force", json: "json", "unpushed-report": "unpushedReport", bundle: "bundle", help: "help" };

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function parseArgs(argv) {
  const out = { dryRun: false, force: false, json: false, unpushedReport: false, bundle: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") { out.help = true; continue; }
    if (!a.startsWith("--")) throw new Error(`unknown argument: ${a}`);
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (name in BOOL_FLAGS) {
      if (inline !== undefined) throw new Error(`--${name} takes no value`);
      out[BOOL_FLAGS[name]] = true;
    } else if (VALUE_FLAGS.includes(name)) {
      const v = inline !== undefined ? inline : argv[++i];
      if (!v || (inline === undefined && v.startsWith("--"))) throw new Error(`--${name} needs a value`);
      out[camel(name)] = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

// ---------------------------------------------------------------- path map
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Regex source for a Windows path prefix: case-insensitive via the flag, any run of `\` or `/` between segments. */
function winPrefixSource(winPath) {
  const segs = String(winPath).split(/[\\/]+/).filter(Boolean);
  return segs.map(escapeRe).join("[\\\\/]+");
}
const STOP = "\\s\"'`<>|*?,;:()\\[\\]{}";
const TAIL = `(?:[\\\\/]+[^${STOP}\\\\/]*)*`;
// Not after a word char, nor after `/`, `\` or `?`: leaves `file:///C:/...` and `\\?\C:\...` alone.
const LEAD = "(?<![A-Za-z0-9_/\\\\?])";
const AFTER_ROOT = `(?=[\\\\/${STOP}]|$)`;
// After a match: the same token goes on with a backslash (`My Game\x`, `Demo(1)\x`) -> a half conversion, refuse it.
const HALF = /^(?:[(),;:[\]{}]|[ \t](?![A-Za-z]:))[^\s"'`<>|]*\\/;

/**
 * Builds the ordered path map. `opts` are parsed args. Returns { rules, source, whole, roots }: `source` matches a
 * mapped prefix (one group per rule) plus its tail; `whole` matches a string that is one mapped path from end to end.
 */
export function buildPathMap(opts, { platform = process.platform, env = process.env, home = homedir() } = {}) {
  const winUser = opts.winUser || (platform === "win32" ? (env.USERNAME || "") : "");
  const winHome = opts.winHome || (winUser ? `C:\\Users\\${winUser}` : "");
  if (!winHome) throw new Error("--win-user (or --win-home) is required when not running on the Windows source machine");
  const winLocal = opts.winLocalappdata || `${winHome}\\AppData\\Local`;
  let forgeHome = opts.forgeHome || (platform === "win32" ? "" : home);
  const placeholder = !forgeHome;
  if (placeholder) {
    if (!opts.dryRun && !(opts.projectsRoot && opts.vsHomeRoot)) {
      throw new Error("--forge-home is required on win32 (the forge-side home, e.g. /home/<forge-user>); --dry-run may omit it");
    }
    forgeHome = FORGE_HOME_PLACEHOLDER;
  }
  const toPosix = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const vsHomeRoot = toPosix(opts.vsHomeRoot || posix.join(toPosix(forgeHome), ".vibesquad"));
  const projectsRoot = toPosix(opts.projectsRoot || posix.join(toPosix(forgeHome), "projects"));
  const worktreesRoot = toPosix(opts.worktreesRoot || posix.join(vsHomeRoot, "worktrees"));
  const runtimeRoot = posix.join(vsHomeRoot, "runtime");
  const rules = [
    { name: "worktrees", win: `${winLocal}\\VibeSquad\\worktrees`, to: worktreesRoot },
    { name: "runtime", win: `${winLocal}\\VibeSquad\\runtime`, to: runtimeRoot },
    { name: "vs-home", win: `${winHome}\\.vibesquad`, to: vsHomeRoot },
    { name: "projects", win: `${winHome}\\projects`, to: projectsRoot },
  ];
  const alternation = rules.map((r) => `(${winPrefixSource(r.win)})`).join("|");
  const source = `${LEAD}(?:${alternation})${AFTER_ROOT}(${TAIL})`;
  const whole = `^(?:${alternation})((?:[\\\\/][^"<>|*?:\\r\\n]*)?)$`;
  return { rules, source, whole, placeholder, roots: { winHome, winLocal, forgeHome, vsHomeRoot, projectsRoot, worktreesRoot, runtimeRoot } };
}

const ruleIndex = (groups, n) => groups.slice(0, n).findIndex((g) => g !== undefined);

/** Rewrites every mapped path in `text`. Returns { text, count, half } (half = matches left alone, see HALF). */
export function rewriteText(text, map) {
  const re = new RegExp(map.source, "gi");
  const n = map.rules.length;
  let count = 0;
  let half = 0;
  const out = text.replace(re, (...m) => {
    const match = m[0];
    const offset = m[n + 2];
    if (HALF.test(text.slice(offset + match.length, offset + match.length + 260))) { half++; return match; }
    const groups = m.slice(1, n + 2);
    count++;
    return map.rules[ruleIndex(groups, n)].to + (groups[n] || "").replace(/[\\/]+/g, "/");
  });
  return { text: out, count, half };
}

/** A JSON string value/key: one whole mapped path is converted entirely, anything else goes through rewriteText. */
export function rewriteString(s, map) {
  const m = new RegExp(map.whole, "i").exec(s);
  if (m) {
    const n = map.rules.length;
    return { text: map.rules[ruleIndex(m.slice(1), n)].to + (m[n + 1] || "").replace(/[\\/]+/g, "/"), count: 1, half: 0 };
  }
  return rewriteText(s, map);
}

const DRIVE_RE = /(?<![A-Za-z0-9_])[A-Za-z]:(?:\\\\|\\|\/)[^\s"'`<>|*?,;:()[\]{}]*/g;
/** Drive-letter paths still present (after rewrite), keyed by drive + their first 5 segments. Adds into `acc` (Map key -> count). */
export function scanUnmapped(text, acc) {
  for (const m of text.matchAll(DRIVE_RE)) {
    const segs = m[0].split(/[\\/]+/).filter(Boolean);
    const key = segs.slice(0, 6).join("\\") + (segs.length === 1 ? "\\" : "");
    acc.set(key, (acc.get(key) || 0) + 1);
  }
  return acc;
}

/** Original keys whose rewrite would collide with another key of the same object (L1): those keep their text. */
function keyConflicts(value, map, out = new Set()) {
  if (Array.isArray(value)) { for (const v of value) keyConflicts(v, map, out); return out; }
  if (!value || typeof value !== "object") return out;
  const keys = Object.keys(value);
  const target = new Map(); // new key -> original keys
  for (const k of keys) {
    const nk = MAYBE_PATH.test(k) ? rewriteString(k, map).text : k;
    if (!target.has(nk)) target.set(nk, []);
    target.get(nk).push(k);
  }
  for (const [nk, origs] of target) if (origs.length > 1) for (const k of origs) if (k !== nk) out.add(k);
  for (const k of keys) keyConflicts(value[k], map, out);
  return out;
}

const STRING_TOKEN = /"(?:[^"\\]|\\.)*"(\s*:)?/g;
const MAYBE_PATH = /[A-Za-z]:(?:\\|\/)/;
const MAYBE_PATH_RAW = /[A-Za-z]:(?:\\\\|\/)/;
/**
 * JSON text in, JSON text out: validates with JSON.parse, then rewrites only the string tokens (keys and values) that
 * hold a mapped path. Untouched tokens, numbers and whitespace stay byte-identical. Throws if `text` is not JSON.
 * Returns { text, count, half, conflicts } (conflicts: original keys kept because their rewrite collides).
 */
export function rewriteJsonText(text, map) {
  const parsed = JSON.parse(text);
  const conflicts = MAYBE_PATH_RAW.test(text) ? keyConflicts(parsed, map) : new Set();
  let count = 0;
  let half = 0;
  const out = text.replace(STRING_TOKEN, (tok, colon) => {
    if (!MAYBE_PATH_RAW.test(tok)) return tok;
    const str = colon ? tok.slice(0, tok.length - colon.length) : tok;
    const value = JSON.parse(str);
    if (colon && conflicts.has(value)) return tok;
    const r = rewriteString(value, map);
    half += r.half;
    if (!r.count) return tok;
    count += r.count;
    return JSON.stringify(r.text) + (colon || "");
  });
  if (count) JSON.parse(out); // never emit something that no longer parses
  return { text: out, count, half, conflicts: [...conflicts] };
}

/** JSONL: each line that parses is rewritten as JSON; others are kept verbatim and counted. Line endings preserved. */
export function rewriteJsonlText(text, map) {
  let count = 0;
  let half = 0;
  let badLines = 0;
  const conflicts = new Set();
  const lines = text.split("\n").map((raw) => {
    const cr = raw.endsWith("\r") ? "\r" : "";
    const line = cr ? raw.slice(0, -1) : raw;
    if (!line.trim()) return raw;
    try {
      const r = rewriteJsonText(line, map);
      count += r.count;
      half += r.half;
      for (const k of r.conflicts) conflicts.add(k);
      return r.text + cr;
    } catch {
      badLines++;
      return raw;
    }
  });
  return { text: lines.join("\n"), count, half, badLines, conflicts: [...conflicts] };
}

// ---------------------------------------------------------------- fs helpers (read-only on the source)
const BOM = "\uFEFF";
function kindOf(file) {
  const ext = extname(file).toLowerCase();
  if (ext === ".json") return "json";
  if (ext === ".jsonl") return "jsonl";
  if (ext === ".md" || ext === ".txt") return "text";
  return "binary";
}

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function isInside(child, parent) {
  const rel = relative(parent, child);
  // relative() across drives returns an absolute path; "..x" is a legal child name, ".." / "../" is not inside.
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
const insideOrSame = (p, root) => samePath(p, root) || isInside(p, root);

/**
 * Real path of `p` even when it does not exist yet: the nearest existing ancestor is realpath'd (junctions and symlinks
 * resolved) and the missing tail appended. This is where a write to `p` would really land.
 */
export function realOfNearest(p) {
  let cur = resolve(p);
  const rest = [];
  for (;;) {
    let st = null;
    try { st = lstatSync(cur); } catch {}
    if (st) {
      if (st.isSymbolicLink() && !existsSync(cur)) throw new Error(`refusing: dangling link on the write path: ${cur}`);
      return join(realpathSync.native(cur), ...rest);
    }
    const up = dirname(cur);
    if (up === cur) return join(cur, ...rest);
    rest.unshift(basename(cur));
    cur = up;
  }
}

/** H1: refuse a write (mkdir / file / rename target) whose real location is inside any of `roots` (real paths). */
function assertWritable(target, roots) {
  const r = realOfNearest(target);
  for (const root of roots) if (root && insideOrSame(r, root)) throw new Error(`refusing: a write to ${target} would land in ${root}`);
  return r;
}

/** Recursive size + file count, never following links. */
export function duSync(p) {
  let bytes = 0;
  let files = 0;
  const st = lstatSync(p);
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) {
      const r = duSync(join(p, name));
      bytes += r.bytes;
      files += r.files;
    }
  } else if (st.isFile()) {
    bytes = st.size;
    files = 1;
  }
  return { bytes, files };
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

function guardedMkdir(dir, roots) {
  assertWritable(dir, roots);
  mkdirSync(dir, { recursive: true });
  assertWritable(dir, roots); // re-check now that it exists (a link created in between is caught here)
}

function atomicWrite(dest, data, roots, mtime) {
  guardedMkdir(dirname(dest), roots);
  const tmp = `${dest}.forge-migrate-${process.pid}.tmp`;
  assertWritable(tmp, roots);
  assertWritable(dest, roots);
  writeFileSync(tmp, data, { flag: "wx" });
  if (mtime) { try { utimesSync(tmp, mtime, mtime); } catch {} }
  renameSync(tmp, dest);
}

/** Walks `dir` (relative names), yielding { rel, abs, st }; links are yielded with st.isSymbolicLink() and not followed. */
function* walk(root, rel = "") {
  const abs = rel ? join(root, rel) : root;
  for (const name of readdirSync(abs).sort()) {
    const r = rel ? join(rel, name) : name;
    const st = lstatSync(join(root, r));
    if (st.isDirectory()) yield* walk(root, r);
    else yield { rel: r, abs: join(root, r), st };
  }
}

/** Links / junctions on the paths a migrate would write in --to: --to itself and every allowlisted entry under it. */
function linksOnWritePaths(to) {
  const found = [];
  let st = null;
  try { st = lstatSync(to); } catch { return found; }
  if (st.isSymbolicLink()) return [to];
  for (const name of ALLOWLIST) {
    const p = join(to, name);
    let s = null;
    try { s = lstatSync(p); } catch { continue; }
    if (s.isSymbolicLink()) found.push(p);
    else if (s.isDirectory()) for (const e of walk(p)) if (e.st.isSymbolicLink()) found.push(e.abs);
  }
  return found;
}

// ---------------------------------------------------------------- migrate
function checkFromTo(from, to, force) {
  if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(`--from is not a directory: ${from}`);
  const rf = realOfNearest(from);
  const rt = realOfNearest(to);
  if (samePath(rf, rt)) throw new Error(`refusing: --from and --to are the same path (${rf})`);
  if (isInside(rt, rf)) throw new Error(`refusing: --to is inside --from (${rt})`);
  if (isInside(rf, rt)) throw new Error(`refusing: --from is inside --to (${rf})`);
  const links = linksOnWritePaths(to);
  if (links.length) throw new Error(`refusing: link or junction on the --to write path: ${links.slice(0, 5).join(", ")}`);
  if (existsSync(to)) {
    if (!statSync(to).isDirectory()) throw new Error(`refusing: --to exists and is not a directory: ${to}`);
    if (readdirSync(to).length && !force) throw new Error(`refusing: --to is not empty (${to}); pass --force to overwrite the allowlisted files there (nothing else in it is touched)`);
  }
  return rf;
}

/**
 * Copies the allowlist from `from` to `to` with path rewriting. dryRun: reads only, writes nothing.
 * Returns the summary object (see printMigrate).
 */
export function migrate(opts, deps = {}) {
  const from = resolve(opts.from);
  const to = resolve(opts.to);
  const realFrom = checkFromTo(from, to, opts.force);
  const map = buildPathMap(opts, deps);
  const summary = {
    mode: opts.dryRun ? "dry-run" : "migrate", from, to, roots: map.roots, placeholderForgeHome: map.placeholder,
    copied: 0, rewritten: 0, rewrites: 0, verbatim: 0, halfLeft: 0, unparseable: [], badJsonlLines: [], keyConflicts: [],
    skippedLinks: [], files: [], leftBehind: [], missing: [], unmapped: [], unmappedTotal: 0, unmappedDistinct: 0, errors: [],
  };
  const ctx = { to, map, summary, unmapped: new Map(), dryRun: opts.dryRun, roots: [realFrom] };
  for (const name of readdirSync(from).sort()) {
    if (ALLOWLIST.includes(name) && !FORGE_OWNED.includes(name)) continue;
    let size = { bytes: 0, files: 0 };
    try { size = duSync(join(from, name)); } catch (e) { summary.errors.push(`${name}: size: ${e.message}`); }
    summary.leftBehind.push({ name, bytes: size.bytes, files: size.files, forgeOwned: FORGE_OWNED.includes(name) });
  }
  for (const name of ALLOWLIST) {
    if (FORGE_OWNED.includes(name)) continue;
    const abs = join(from, name);
    let st = null;
    try { st = lstatSync(abs); } catch { summary.missing.push(name); continue; }
    const entries = st.isDirectory()
      ? [...walk(abs)].map((e) => ({ ...e, rel: `${name}/${e.rel.split(sep).join("/")}` }))
      : [{ rel: name, abs, st }];
    for (const e of entries) {
      if (!e.st.isFile()) { summary.skippedLinks.push(e.rel); continue; }
      try {
        migrateFile(e, ctx);
      } catch (err) {
        summary.errors.push(`${e.rel}: ${err.message}`);
      }
    }
  }
  const sorted = [...ctx.unmapped.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  summary.unmappedDistinct = sorted.length;
  summary.unmappedTotal = sorted.reduce((n, [, c]) => n + c, 0);
  summary.unmapped = sorted.slice(0, UNMAPPED_CAP).map(([path, count]) => ({ path, count }));
  return summary;
}

function migrateFile(e, { to, map, summary, unmapped, dryRun, roots }) {
  const buf = readFileSync(e.abs);
  const kind = kindOf(e.rel);
  let out = buf;
  let count = 0;
  let text = null;
  if (kind !== "binary") {
    text = buf.toString("utf8");
    // Not valid UTF-8 (would not round-trip): copy verbatim rather than risk replacing bytes with U+FFFD.
    if (!Buffer.from(text, "utf8").equals(buf)) {
      summary.unparseable.push({ file: e.rel, error: "not valid UTF-8" });
      text = null;
    }
  }
  if (text !== null) {
    const bom = text.startsWith(BOM) ? BOM : "";
    if (bom) text = text.slice(1);
    let r = null;
    try {
      if (kind === "json") r = rewriteJsonText(text, map);
      else if (kind === "jsonl") r = rewriteJsonlText(text, map);
      else r = rewriteText(text, map);
    } catch (err) {
      summary.unparseable.push({ file: e.rel, error: String(err.message).slice(0, 120) });
    }
    if (r) {
      count = r.count;
      summary.halfLeft += r.half || 0;
      if (r.badLines) summary.badJsonlLines.push({ file: e.rel, lines: r.badLines });
      for (const key of r.conflicts || []) summary.keyConflicts.push({ file: e.rel, key });
      scanUnmapped(r.text, unmapped);
      if (count) out = Buffer.from(bom + r.text, "utf8");
    } else {
      scanUnmapped(text, unmapped);
    }
  }
  summary.copied++;
  if (count) {
    summary.rewritten++;
    summary.rewrites += count;
    summary.files.push({ file: e.rel, rewrites: count });
  } else summary.verbatim++;
  if (!dryRun) atomicWrite(join(to, e.rel), out, roots, e.st.mtime);
}

// ---------------------------------------------------------------- backup
const LOCK_NAME = /(\.lock|\.lck|\.pid|\.sock)$|(^|[\\/])LOCK$/i;

/** Plans the archive: regular readable files, with skips reported. Read-only. */
export function planBackup(from) {
  const files = [];
  const skipped = [];
  let bytes = 0;
  for (const e of walk(from)) {
    const rel = e.rel.split(sep).join("/");
    if (e.st.isSymbolicLink()) { skipped.push({ file: rel, reason: "link" }); continue; }
    if (!e.st.isFile()) { skipped.push({ file: rel, reason: e.st.isSocket() ? "socket" : "special" }); continue; }
    if (LOCK_NAME.test(rel)) { skipped.push({ file: rel, reason: "lock" }); continue; }
    try { closeSync(openSync(e.abs, "r")); } catch (err) { skipped.push({ file: rel, reason: err.code || "unreadable" }); continue; }
    files.push(rel);
    bytes += e.st.size;
  }
  return { files, skipped, bytes };
}

function tarInfo(platform = process.platform, env = process.env) {
  if (platform === "win32") return { bin: join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "tar.exe"), bsd: true };
  const v = spawnSync("tar", ["--version"], { encoding: "utf8" });
  return { bin: "tar", bsd: !/GNU tar/.test(String(v.stdout)) };
}

const stampOf = (now) => now.toISOString().replace(/[:.]/g, "-");

/**
 * Archives the full source home (and, if given, the bundle dir as `<bundle dir name>/...`). Names are passed
 * NUL-separated on stdin (`--null -T -`). bsdtar takes the bundles through an intermediate tar in the scratch dir
 * (`@archive`); GNU tar through a second positional -C.
 */
export function backup(opts, { now = new Date(), platform = process.platform, env = process.env, bundleDir = null, scratch = null } = {}) {
  const from = resolve(opts.from);
  if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(`--from is not a directory: ${from}`);
  const dir = resolve(opts.backup);
  const rf = realOfNearest(from);
  const roots = [rf];
  if (insideOrSame(realOfNearest(dir), rf)) throw new Error(`refusing: --backup is inside --from (${dir})`);
  const ext = platform === "win32" ? "zip" : "tar.gz";
  const archive = join(dir, `vibesquad-home-${stampOf(now)}.${ext}`);
  const plan = planBackup(from);
  const extra = bundleDir && existsSync(bundleDir) ? readdirSync(bundleDir).sort().map((f) => `${basename(bundleDir)}/${f}`) : [];
  const summary = { mode: opts.dryRun ? "backup-dry-run" : "backup", from, archive, files: plan.files.length, bundles: extra.length, bytes: plan.bytes, skipped: plan.skipped, archived: null, errors: [] };
  if (opts.dryRun) return summary;
  if (existsSync(archive)) throw new Error(`refusing: ${archive} already exists`);
  guardedMkdir(dir, roots);
  assertWritable(archive, roots);
  const { bin, bsd } = tarInfo(platform, env);
  const compress = platform === "win32" ? "-a" : "-z";
  const args = ["--null", "-c", compress, "-f", archive];
  if (!bsd) args.push("--verbatim-files-from");
  args.push("-C", from, "-T", "-");
  if (extra.length) {
    if (bsd) {
      if (!scratch) throw new Error("internal: bundle archive needs a scratch dir");
      const inner = join(scratch, "bundles.tar");
      const r0 = spawnSync(bin, ["-c", "-f", inner, "-C", dirname(bundleDir), basename(bundleDir)], { encoding: "utf8", windowsHide: true });
      if (r0.status !== 0) throw new Error(`${bin} (bundles) exited ${r0.status}: ${String(r0.stderr).trim().slice(0, 300)}`);
      args.push(`@${inner}`);
    } else args.push("-C", dirname(bundleDir), ...extra);
  }
  const r = spawnSync(bin, args, { input: plan.files.map((f) => `${f}\0`).join(""), encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${bin}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${bin} exited ${r.status}: ${String(r.stderr).trim().slice(0, 500)}`);
  const list = spawnSync(bin, ["-t", "-f", archive], { encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (list.status === 0) summary.archived = list.stdout.split(/\r?\n/).filter((l) => l && !l.endsWith("/")).length;
  const want = plan.files.length + extra.length;
  if (summary.archived !== want) summary.errors.push(`archive lists ${summary.archived} files, expected ${want}`);
  return summary;
}

// ---------------------------------------------------------------- git (read-only except the bundle WIP steps)
// Every git call: --no-optional-locks (no opportunistic index refresh), gc.auto=0 (never an auto gc), no prompts.
// This script never runs fetch, prune, gc, checkout, stash push, reset or clean.
function git(cwd, args, { env = {}, input } = {}) {
  const r = spawnSync("git", ["--no-optional-locks", "-c", "gc.auto=0", "-C", cwd, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 600_000, maxBuffer: 256 * 1024 * 1024, input,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...env },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(String(r.stderr || "").trim().split("\n")[0] || `git ${args[0]} exited ${r.status}`);
  return r.stdout;
}
const revCount = (cwd, args) => Number(git(cwd, ["rev-list", "--count", ...args]).trim()) || 0;

const isWorktree = (dir) => existsSync(join(dir, ".git"));

/** Worktrees at <root>/<x> and <root>/<repo>/<unit> (no deeper), plus the folders there that are not git worktrees. */
export function findWorktrees(root) {
  const worktrees = [];
  const notGit = [];
  const dirs = (p) => { try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; } };
  for (const a of dirs(root)) {
    const pa = join(root, a);
    if (isWorktree(pa)) { worktrees.push(pa); continue; }
    const kids = dirs(pa);
    if (!kids.length) { notGit.push(a); continue; }
    for (const b of kids) {
      if (isWorktree(join(pa, b))) worktrees.push(join(pa, b));
      else notGit.push(`${a}/${b}`);
    }
  }
  return { worktrees, notGit };
}

const normPath = (p) => { const r = realOfNearest(p).replace(/\\/g, "/").replace(/\/+$/, ""); return process.platform === "win32" ? r.toLowerCase() : r; };
const slug = (b) => String(b).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");

/** Per worktree: HEAD, detached-HEAD commits on no branch/remote, dirty count, common dir. Read-only. */
function inspectWorktree(wt, root) {
  const item = { path: relative(root, wt).split(sep).join("/"), branch: null, sha: null, detachedAhead: 0, dirty: 0, commonDir: null, error: null };
  try {
    item.commonDir = resolve(wt, git(wt, ["rev-parse", "--git-common-dir"]).trim());
    item.sha = git(wt, ["rev-parse", "HEAD"]).trim();
    item.branch = git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (item.branch === "HEAD") {
      item.branch = "(detached)";
      item.detachedAhead = revCount(wt, ["HEAD", "--not", "--branches", "--remotes"]);
    }
    item.dirty = git(wt, ["status", "--porcelain", "--untracked-files=normal"]).split("\n").filter(Boolean).length;
  } catch (err) {
    item.error = String(err.message || err).slice(0, 200);
  }
  return item;
}

/**
 * Per git common dir: `rev-list --branches --not --remotes` total, the branches that carry it (each with its owner:
 * the sanctuary worktree it is checked out in, else the one named after it, else null), and the stash entries.
 */
function inspectRepo(commonDir, items) {
  const any = items[0].abs;
  const repo = { commonDir, name: slug(basename(commonDir).toLowerCase() === ".git" ? basename(dirname(commonDir)) : basename(commonDir).replace(/\.git$/i, "")), remotes: 0, unpushedCommits: 0, branches: [], stashes: [], error: null };
  try {
    repo.remotes = git(any, ["remote"]).split("\n").filter(Boolean).length;
    repo.unpushedCommits = revCount(any, ["--branches", "--not", "--remotes"]);
    if (repo.unpushedCommits) {
      const byPath = new Map(items.map((i) => [normPath(i.abs), i]));
      const byName = new Map(items.map((i) => [slug(basename(i.abs)), i]));
      for (const line of git(any, ["for-each-ref", "--format=%(refname)%00%(worktreepath)", "refs/heads"]).split("\n")) {
        if (!line) continue;
        const [ref, wtp] = line.split("\0");
        const ahead = revCount(any, [ref, "--not", "--remotes"]);
        if (!ahead) continue;
        const owner = wtp ? byPath.get(normPath(wtp)) : byName.get(slug(ref.slice("refs/heads/".length)));
        repo.branches.push({ name: ref.slice("refs/heads/".length), ahead, owner: owner ? owner.path : null });
      }
    }
    if (git(any, ["for-each-ref", "--format=%(refname)", "refs/stash"]).trim()) {
      repo.stashes = git(any, ["log", "--walk-reflogs", "--format=%H", "refs/stash"]).split("\n").filter(Boolean);
    }
  } catch (err) {
    repo.error = String(err.message || err).slice(0, 200);
  }
  return repo;
}

export function unpushedReport(opts = {}) {
  const root = resolve(opts.sanctuary || resolveManagedWorktreeRoot());
  if (!existsSync(root)) throw new Error(`sanctuary not found: ${root}`);
  const { worktrees, notGit } = findWorktrees(root);
  const summary = { mode: "unpushed-report", root, worktrees: 0, repos: 0, unpushedCommits: 0, unpushedBranches: 0, stashes: 0, dirty: 0, detached: 0, notGit, errors: 0, items: [], repoReports: [] };
  const groups = new Map();
  for (const wt of worktrees) {
    const item = inspectWorktree(wt, root);
    Object.defineProperty(item, "abs", { value: wt, enumerable: false });
    summary.worktrees++;
    if (item.error) summary.errors++;
    if (item.dirty) summary.dirty++;
    if (item.detachedAhead) summary.detached++;
    summary.items.push(item);
    if (item.commonDir) {
      const key = normPath(item.commonDir);
      if (!groups.has(key)) groups.set(key, { commonDir: item.commonDir, items: [] });
      groups.get(key).items.push(item);
    }
  }
  for (const g of groups.values()) {
    const repo = inspectRepo(g.commonDir, g.items);
    Object.defineProperty(repo, "items", { value: g.items, enumerable: false });
    summary.repos++;
    summary.unpushedCommits += repo.unpushedCommits;
    summary.unpushedBranches += repo.branches.length;
    summary.stashes += repo.stashes.length;
    if (repo.error) summary.errors++;
    summary.repoReports.push(repo);
  }
  summary.safeToDelete = !summary.unpushedCommits && !summary.stashes && !summary.dirty && !summary.detached && !summary.notGit.length && !summary.errors;
  return summary;
}

// ---------------------------------------------------------------- bundles (C3 safety net before the sanctuary goes)
export const LARGE_UNTRACKED_BYTES = 50 * 1024 * 1024;
export const WIP_NS = "refs/vs-migrate-wip";
const WIP_IDENT = { GIT_AUTHOR_NAME: "vs forge-migrate", GIT_AUTHOR_EMAIL: "forge-migrate@localhost", GIT_COMMITTER_NAME: "vs forge-migrate", GIT_COMMITTER_EMAIL: "forge-migrate@localhost" };
const SCRATCH_PREFIX = "vs-forge-migrate-scratch-";

/**
 * Allowed exception to never-delete (1 of 2): the scratch dir mkdtemp'd by this run (temp index files, the inner
 * bundle tar). It never held owner data.
 */
function removeOwnScratch(dir) {
  if (!dir || !basename(dir).startsWith(SCRATCH_PREFIX) || !samePath(dirname(resolve(dir)), resolve(tmpdir()))) throw new Error(`not our scratch dir: ${dir}`);
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Captures a dirty worktree as a commit that exists only in the object store (and briefly under a private temp ref):
 * a copy of the worktree index (else HEAD's tree) as GIT_INDEX_FILE, `git add -A` (respects .gitignore; untracked files
 * over LARGE_UNTRACKED_BYTES excluded and reported), write-tree, commit-tree -p HEAD. The worktree's files, index, HEAD
 * and branch refs are never written. Returns { commit, skippedLarge }.
 */
function snapshotWip(wt, label, scratch, stamp) {
  const skippedLarge = [];
  for (const rel of git(wt, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) {
    let st;
    try { st = lstatSync(join(wt, rel)); } catch { continue; }
    if (st.isFile() && st.size > LARGE_UNTRACKED_BYTES) skippedLarge.push({ path: rel, bytes: st.size });
  }
  const index = join(scratch, `${slug(label)}.index`);
  const realIndex = resolve(wt, git(wt, ["rev-parse", "--git-path", "index"]).trim());
  const env = { GIT_INDEX_FILE: index, ...WIP_IDENT };
  if (existsSync(realIndex)) writeFileSync(index, readFileSync(realIndex), { flag: "wx" }); // a copy: the real index is only read
  else git(wt, ["read-tree", "HEAD"], { env });
  const specs = [".", ...skippedLarge.map((f) => `:(exclude,literal)${f.path}`)];
  git(wt, ["-c", "core.splitIndex=false", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: specs.map((s) => `${s}\0`).join("") });
  const tree = git(wt, ["write-tree"], { env }).trim();
  const commit = git(wt, ["commit-tree", tree, "-p", "HEAD", "-m", `WIP snapshot ${label} ${stamp}`], { env }).trim();
  return { commit, skippedLarge };
}

/**
 * Writes one bundle: `refs` are real refs to include; `temp` are [ref, sha] pairs created here under WIP_NS (create
 * only) and removed again right after the bundle is written. Then `git bundle verify`.
 */
function writeBundle(cwd, file, refs, temp, entry, roots) {
  const made = [];
  try {
    for (const [ref, sha] of temp) {
      git(cwd, ["update-ref", ref, sha, ""]); // "" = create only: never moves an existing ref
      made.push([ref, sha]);
    }
    assertWritable(file, roots);
    git(cwd, ["bundle", "create", file, ...refs, ...temp.map(([ref]) => ref), "--not", "--remotes"]);
    try { git(cwd, ["bundle", "verify", file]); entry.verified = true; } catch (err) { entry.error = `verify: ${err.message}`; }
  } finally {
    // Allowed exception to never-delete (2 of 2): the private refs this run created a moment ago under WIP_NS, only so
    // `git bundle create` can name the WIP / stash commits. `update-ref -d <ref> <sha>` removes one only while it still
    // points at the commit we put there.
    for (const [ref, sha] of made) {
      try { git(cwd, ["update-ref", "-d", ref, sha]); } catch (err) { entry.error = `${entry.error ? `${entry.error}; ` : ""}temp ref left: ${ref}: ${err.message}`; }
    }
  }
}

/**
 * Bundles everything the report flags: per worktree (owned unpushed branches, detached HEAD, WIP of a dirty tree) and
 * per repo (unpushed branches no worktree owns, stash entries). Writes manifest.json. dryRun: plan only.
 */
export function bundleFlagged(report, opts, { now = new Date(), scratch = null } = {}) {
  if (scratch || opts.dryRun) return bundleWithScratch(report, opts, now, scratch);
  const own = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  try { return bundleWithScratch(report, opts, now, own); } finally { removeOwnScratch(own); }
}

function bundleWithScratch(report, opts, now, scratch) {
  const dir = resolve(opts.bundleDir);
  const roots = [realOfNearest(report.root), opts.from ? realOfNearest(opts.from) : null].filter(Boolean);
  assertWritable(dir, roots);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`refusing: the bundle dir is not empty (${dir})`);
  const stamp = stampOf(now);
  const plan = [];
  for (const repo of report.repoReports) {
    for (const i of repo.items) {
      const branches = repo.branches.filter((b) => b.owner === i.path);
      if (i.error || !(branches.length || i.detachedAhead || i.dirty)) continue;
      plan.push({ kind: "worktree", repo, item: i, branches, file: `${i.path.split("/").map(slug).join("__")}.bundle` });
    }
    const loose = repo.branches.filter((b) => b.owner === null);
    if (loose.length || repo.stashes.length) plan.push({ kind: "repo", repo, item: null, branches: loose, file: `${repo.name}__repo.bundle` });
  }
  const summary = { mode: opts.dryRun ? "bundle-dry-run" : "bundle", dir, bundles: 0, verified: 0, failed: 0, skippedLarge: 0, entries: [] };
  for (const p of plan) {
    const entry = {
      kind: p.kind, repo: p.repo.name, worktree: p.item ? p.item.path : null, branch: p.item ? p.item.branch : null, sha: p.item ? p.item.sha : null,
      unpushedCount: p.branches.reduce((n, b) => n + b.ahead, 0) + (p.item ? p.item.detachedAhead : 0), dirtyCount: p.item ? p.item.dirty : 0,
      branches: p.branches.map((b) => ({ name: b.name, ahead: b.ahead })), stashes: p.kind === "repo" ? p.repo.stashes.length : 0,
      wipCommit: null, refs: [], skippedLarge: [], bundle: p.file, verified: false, error: null,
    };
    summary.entries.push(entry);
    if (opts.dryRun) continue;
    if (!summary.bundles && !existsSync(dir)) guardedMkdir(dir, roots);
    const cwd = p.item ? p.item.abs : p.repo.items[0].abs;
    try {
      const refs = p.branches.map((b) => `refs/heads/${b.name}`);
      if (p.item && p.item.detachedAhead) refs.push("HEAD");
      const temp = [];
      const ns = `${WIP_NS}/${p.repo.name}/${p.item ? slug(basename(p.item.abs)) : "_repo"}/${stamp}`;
      if (p.item && p.item.dirty) {
        const wip = snapshotWip(cwd, p.item.path, scratch, stamp);
        entry.wipCommit = wip.commit;
        entry.skippedLarge = wip.skippedLarge;
        summary.skippedLarge += wip.skippedLarge.length;
        temp.push([`${ns}/wip`, wip.commit]);
      }
      if (p.kind === "repo") p.repo.stashes.forEach((sha, n) => temp.push([`${ns}/stash-${n}`, sha]));
      entry.refs = [...refs, ...temp.map(([ref]) => ref)];
      writeBundle(cwd, join(dir, p.file), refs, temp, entry, roots);
      summary.bundles++;
    } catch (err) {
      entry.error = String(err.message || err).slice(0, 300);
    }
    if (entry.verified) summary.verified++; else summary.failed++;
  }
  if (!opts.dryRun && plan.length) {
    atomicWrite(join(dir, "manifest.json"), JSON.stringify({ createdAt: now.toISOString(), sanctuary: report.root, bundles: summary.entries }, null, 2) + "\n", roots);
  }
  return summary;
}

// ---------------------------------------------------------------- output
function printMigrate(s, log) {
  log(`forge-migrate ${s.mode}: ${s.from} -> ${s.to}`);
  log(`  map: projects -> ${s.roots.projectsRoot}, worktrees -> ${s.roots.worktreesRoot}, runtime -> ${s.roots.runtimeRoot}, vs-home -> ${s.roots.vsHomeRoot}${s.placeholderForgeHome ? "  (placeholder forge home: pass --forge-home)" : ""}`);
  log(`  rewrites per file (${s.files.length}):`);
  for (const f of s.files) log(`    ${String(f.rewrites).padStart(6)}  ${f.file}`);
  log(`  left behind (not copied, ${s.leftBehind.length}):`);
  for (const l of s.leftBehind) log(`    ${fmtBytes(l.bytes).padStart(9)}  ${l.name}${l.files > 1 ? ` (${l.files} files)` : ""}${l.forgeOwned ? "  [forge-owned]" : ""}`);
  if (s.missing.length) log(`  allowlisted but missing: ${s.missing.join(", ")}`);
  if (s.skippedLinks.length) log(`  skipped links/special: ${s.skippedLinks.join(", ")}`);
  for (const u of s.unparseable) log(`  UNPARSEABLE (copied verbatim): ${u.file}: ${u.error}`);
  for (const b of s.badJsonlLines) log(`  JSONL lines kept verbatim (unparseable): ${b.file}: ${b.lines}`);
  for (const k of s.keyConflicts) log(`  KEY CONFLICT (original key kept): ${k.file}: ${k.key}`);
  if (s.halfLeft) log(`  paths left unconverted (would be half converted; listed below as UNMAPPED): ${s.halfLeft}`);
  log(`  UNMAPPED drive paths: ${s.unmappedDistinct} distinct, ${s.unmappedTotal} occurrences${s.unmappedDistinct > s.unmapped.length ? ` (showing ${s.unmapped.length})` : ""}`);
  for (const u of s.unmapped) log(`    ${String(u.count).padStart(6)}  ${u.path}`);
  for (const e of s.errors) log(`  ERROR ${e}`);
  log(`summary: copied=${s.copied} rewritten=${s.rewritten} (rewrites=${s.rewrites}) verbatim=${s.verbatim} unparseable=${s.unparseable.length} key-conflicts=${s.keyConflicts.length} left-behind=${s.leftBehind.length} unmapped=${s.unmappedDistinct} errors=${s.errors.length}${s.mode === "dry-run" ? " (dry run: nothing written)" : ""}`);
}

function printBackup(s, log) {
  log(`forge-migrate ${s.mode}: ${s.from} -> ${s.archive}`);
  for (const k of s.skipped) log(`  skipped (${k.reason}): ${k.file}`);
  for (const e of s.errors) log(`  ERROR ${e}`);
  log(`backup: files=${s.files} bundles=${s.bundles} bytes=${fmtBytes(s.bytes)} skipped=${s.skipped.length}${s.archived === null ? "" : ` archived=${s.archived}`}${s.mode === "backup-dry-run" ? " (dry run: nothing written)" : ""}`);
}

export function reportTotals(s) {
  return { root: s.root, worktrees: s.worktrees, repos: s.repos, unpushedCommits: s.unpushedCommits, unpushedBranches: s.unpushedBranches, stashes: s.stashes, dirty: s.dirty, detached: s.detached, notGit: s.notGit.length, errors: s.errors, safeToDelete: s.safeToDelete };
}

function printUnpushed(s, log) {
  log(`unpushed report (read-only; "pushed" = on a remote-tracking ref as of the last fetch): ${s.root}`);
  for (const r of s.repoReports) {
    if (!r.unpushedCommits && !r.stashes.length && !r.error) continue;
    log(`  repo ${r.name}: ${r.unpushedCommits} commit(s) on no remote, ${r.stashes.length} stash(es)${r.remotes ? "" : "  [no remote]"}${r.error ? `  ERROR ${r.error}` : ""}`);
    for (const b of r.branches) log(`    ${String(b.ahead).padStart(5)}  ${b.name}${b.owner ? `  (${b.owner})` : ""}`);
  }
  const rows = s.items.filter((i) => i.dirty || i.detachedAhead || i.error);
  if (rows.length) {
    log(`  ${"dirty".padStart(5)}  ${"detch".padStart(5)}  worktree / branch`);
    for (const i of rows) log(`  ${String(i.dirty).padStart(5)}  ${String(i.detachedAhead).padStart(5)}  ${i.path}  ${i.branch ?? "?"}${i.error ? `  ERROR ${i.error}` : ""}`);
  }
  for (const n of s.notGit) log(`  NOT A GIT WORKTREE: ${n}`);
  log(JSON.stringify(reportTotals(s)));
}

function printBundles(s, log) {
  log(`bundles ${s.mode}: ${s.dir}`);
  for (const e of s.entries) {
    log(`  ${e.verified ? "OK  " : s.mode === "bundle" ? "FAIL" : "plan"}  ${e.bundle}  unpushed=${e.unpushedCount} dirty=${e.dirtyCount}${e.stashes ? ` stashes=${e.stashes}` : ""}${e.error ? `  ERROR ${e.error}` : ""}`);
    for (const f of e.skippedLarge) log(`        skipped untracked > 50 MB: ${f.path} (${fmtBytes(f.bytes)})`);
  }
  log(`bundles: planned=${s.entries.length} written=${s.bundles} verified=${s.verified} failed=${s.mode === "bundle" ? s.failed : 0} skipped-large=${s.skippedLarge}${s.mode === "bundle-dry-run" ? " (dry run: nothing written)" : ""}`);
}

const USAGE = `usage:
  node scripts/forge-migrate.mjs --from <home> --to <dest> [--dry-run] [--force] [--json]
       [--win-user <u> | --win-home <dir>] [--win-localappdata <dir>]
       [--forge-home <dir>] [--projects-root <dir>] [--vs-home-root <dir>] [--worktrees-root <dir>]
  node scripts/forge-migrate.mjs --from <home> --backup <dir> [--bundle [--bundle-dir <dir>]] [--dry-run]
  node scripts/forge-migrate.mjs --unpushed-report [--sanctuary <dir>] [--json]
  node scripts/forge-migrate.mjs --bundle --bundle-dir <dir> [--sanctuary <dir>] [--dry-run]
Never deletes owner data. See the header of this file and docs/lanes/forge-host/RUNBOOK.md (C2 migrate).`;

export function main(argv = process.argv.slice(2), log = console.log, err = console.error, { now = new Date() } = {}) {
  if (argv.includes("--sync-docs") || argv.includes("--verify-briefs")) return docsSyncMain(argv, log, err);
  let args;
  try { args = parseArgs(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  if (args.help) { log(USAGE); return 0; }
  if (args.unpushedReport && !args.bundle) {
    try {
      const s = unpushedReport(args);
      if (args.json) log(JSON.stringify(s, null, 2)); else printUnpushed(s, log);
      return 0;
    } catch (e) { err(`forge-migrate: ${e.message}`); return 1; }
  }
  if (args.bundle && !args.bundleDir && !args.backup) { err(`--bundle needs --bundle-dir or --backup\n${USAGE}`); return 2; }
  if (!args.bundle && !args.from) { err(`--from is required\n${USAGE}`); return 2; }
  if (!args.to && !args.backup && !args.bundle) { err(`--to, --backup or --bundle is required\n${USAGE}`); return 2; }
  if ((args.backup || args.to) && !args.from) { err(`--from is required\n${USAGE}`); return 2; }
  const results = [];
  let failed = false;
  let scratch = null;
  try {
    let bundleDir = null;
    if (args.bundle) {
      bundleDir = resolve(args.bundleDir || join(args.backup, `vibesquad-bundles-${stampOf(now)}`));
      if (!args.dryRun) scratch = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
      const report = unpushedReport(args);
      if (!args.json) printUnpushed(report, log);
      const s = bundleFlagged(report, { ...args, bundleDir }, { now, scratch });
      results.push(reportTotals(report), s);
      if (!args.json) printBundles(s, log);
      if (s.failed && !args.dryRun) failed = true;
    }
    if (args.backup && !failed) {
      const s = backup(args, { now, bundleDir, scratch });
      results.push(s);
      if (!args.json) printBackup(s, log);
      if (s.errors.length) failed = true;
    }
    if (args.to && !failed) {
      const s = migrate(args);
      results.push(s);
      if (!args.json) printMigrate(s, log);
      if (s.errors.length) failed = true;
    }
    if (args.json) log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    return failed ? 1 : 0;
  } catch (e) {
    err(`forge-migrate: ${e.message}`);
    return 1;
  } finally {
    if (scratch) removeOwnScratch(scratch);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
