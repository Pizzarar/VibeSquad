#!/usr/bin/env node
// Forge cutover C2a (docs/PLAN_FORGE_CUTOVER.md C2a/C3): move the dev pp VibeSquad home to the forge.
// Owner 11-22: "transfer over only whats needed and nuke the rest". This script never deletes anything, in any mode;
// the "nuke" is a separate owner step after the reports below are read.
//
//   node scripts/forge-migrate.mjs --from <win home copy> --to <dest> [--dry-run] [--force] [--json]
//        [--win-user <u> | --win-home <C:\Users\u>] [--win-localappdata <dir>]
//        [--forge-home <dir>] [--projects-root <dir>] [--vs-home-root <dir>] [--worktrees-root <dir>]
//   node scripts/forge-migrate.mjs --from <home> --backup <dir> [--dry-run]     (zip/tar of the FULL source home)
//   node scripts/forge-migrate.mjs --unpushed-report [--sanctuary <dir>] [--json] (read-only git report)
//
// Migrate (allowlist): copies only ALLOWLIST below; every other top-level entry is printed as "left behind" with its
// size, so nothing drops silently. The forge keeps its own identity (tls/, devices.json, host-id, local-token,
// daemon-password, vapid.json, host-keypair.json are never copied). JSON / JSONL / .md / .txt files get their Windows
// paths rewritten through the path map (case-insensitive, `\`, `/` and JSON-escaped `\\` separators):
//   <win-home>\projects\<P>...                -> <projects-root>/<P>...      (default <forge-home>/projects)
//   <win-localappdata>\VibeSquad\worktrees... -> <worktrees-root>/...        (default <vs-home-root>/worktrees)
//   <win-localappdata>\VibeSquad\runtime...   -> <vs-home-root>/runtime/...  (server/runtime-dir.mjs POSIX default)
//   <win-home>\.vibesquad...                  -> <vs-home-root>/...          (default <forge-home>/.vibesquad)
// JSON is validated with JSON.parse and only the string tokens that change are re-encoded (numbers, key order and
// whitespace stay byte-identical). JSONL is done line by line; a line that does not parse is kept verbatim. A JSON
// file that does not parse is copied verbatim and reported. Every write goes to a temp file renamed into place.
// The source is only ever read (it is the C3 rollback). Refuses: non-empty --to without --force, --to equal to / inside
// / containing --from. With --force, allowlisted files are overwritten and nothing else in --to is touched.
// --dry-run writes nothing: per-file rewrite counts, left-behind sizes and UNMAPPED drive-letter paths (capped).
//
// --backup <dir>: <dir>/vibesquad-home-<timestamp>.zip (win32: %SystemRoot%\System32\tar.exe, which writes zip) or
// .tar.gz (POSIX tar). Regular files only; lock files, sockets, links/junctions and files that cannot be opened are
// skipped and reported. Refuses a <dir> inside the source.
//
// --unpushed-report: walks the worktree sanctuary (server/team-worktrees.mjs resolveManagedWorktreeRoot, two levels:
// <root>/<repo>/<unit>) and lists worktrees whose HEAD has commits on no remote (`git rev-list HEAD --not --remotes`)
// or a dirty tree (`git --no-optional-locks status --porcelain`). No fetch, no prune, no index refresh.
import { spawnSync } from "node:child_process";
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync,
  utimesSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveManagedWorktreeRoot } from "../server/team-worktrees.mjs";

export const ALLOWLIST = [
  "teams.json", "teams", "inbox.json", "lessons.jsonl", "profiles.json", "settings.json", "stakes-ladder.json",
  "schedules.json", "capped-providers.json", "brief-history", "reports",
];
/** Never copied even if someone adds them to ALLOWLIST: the forge's own identity, CA and pairing. */
export const FORGE_OWNED = ["runtime", "worktrees", "tls", "devices.json", "host-id", "local-token", "daemon-password", "vapid.json", "host-keypair.json", "push-subs.json"];
const UNMAPPED_CAP = 50;
const FORGE_HOME_PLACEHOLDER = "/home/<forge-user>";

// ---------------------------------------------------------------- args
const VALUE_FLAGS = ["from", "to", "backup", "sanctuary", "win-user", "win-home", "win-localappdata", "forge-home", "projects-root", "vs-home-root", "worktrees-root"];
const BOOL_FLAGS = { "dry-run": "dryRun", force: "force", json: "json", "unpushed-report": "unpushedReport", help: "help" };

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function parseArgs(argv) {
  const out = { dryRun: false, force: false, json: false, unpushedReport: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") { out.help = true; continue; }
    if (!a.startsWith("--")) throw new Error(`unknown argument: ${a}`);
    let [name, inline] = a.slice(2).split(/=(.*)/s, 2);
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
const TAIL = "(?:[\\\\/]+[^\\s\"'`<>|*?,;:()\\[\\]{}\\\\/]*)*";
const LEAD = "(?<![A-Za-z0-9_])";
const AFTER_ROOT = "(?=[\\\\/\\s\"'`<>|*?,;:()\\[\\]{}]|$)";

/**
 * Builds the ordered path map. `opts` are parsed args. Returns { rules, roots } where each rule has a regex source
 * (prefix group + tail group) and a forge-side replacement root (posix).
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
  return { rules, source, placeholder, roots: { winHome, winLocal, forgeHome, vsHomeRoot, projectsRoot, worktreesRoot, runtimeRoot } };
}

/** Rewrites every mapped path in `text`. Returns { text, count }. */
export function rewriteText(text, map) {
  const re = new RegExp(map.source, "gi");
  let count = 0;
  const out = text.replace(re, (...m) => {
    const groups = m.slice(1, map.rules.length + 2);
    const idx = groups.slice(0, map.rules.length).findIndex((g) => g !== undefined);
    const tail = groups[map.rules.length] || "";
    count++;
    return map.rules[idx].to + tail.replace(/[\\/]+/g, "/");
  });
  return { text: out, count };
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

const STRING_TOKEN = /"(?:[^"\\]|\\.)*"/g;
const MAYBE_PATH = /[A-Za-z]:(?:\\\\|\/)/;
/**
 * JSON text in, JSON text out: validates with JSON.parse, then rewrites only the string tokens (keys and values) that
 * hold a mapped path. Untouched tokens, numbers and whitespace stay byte-identical. Throws if `text` is not JSON.
 */
export function rewriteJsonText(text, map) {
  JSON.parse(text);
  let count = 0;
  const out = text.replace(STRING_TOKEN, (tok) => {
    if (!MAYBE_PATH.test(tok)) return tok;
    const r = rewriteText(JSON.parse(tok), map);
    if (!r.count) return tok;
    count += r.count;
    return JSON.stringify(r.text);
  });
  if (count) JSON.parse(out); // never emit something that no longer parses
  return { text: out, count };
}

/** JSONL: each line that parses is rewritten as JSON; others are kept verbatim and counted. Line endings preserved. */
export function rewriteJsonlText(text, map) {
  let count = 0;
  let badLines = 0;
  const lines = text.split("\n").map((raw) => {
    const cr = raw.endsWith("\r") ? "\r" : "";
    const line = cr ? raw.slice(0, -1) : raw;
    if (!line.trim()) return raw;
    try {
      const r = rewriteJsonText(line, map);
      count += r.count;
      return r.text + cr;
    } catch {
      badLines++;
      return raw;
    }
  });
  return { text: lines.join("\n"), count, badLines };
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
function real(p) {
  try { return realpathSync.native(p); } catch { return resolve(p); }
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

function atomicWrite(dest, data, mtime) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.forge-migrate-${process.pid}.tmp`;
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

// ---------------------------------------------------------------- migrate
function checkFromTo(from, to, force) {
  if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(`--from is not a directory: ${from}`);
  const rf = real(from);
  const rt = real(to);
  if (samePath(rf, rt)) throw new Error(`refusing: --from and --to are the same path (${rf})`);
  if (isInside(rt, rf)) throw new Error(`refusing: --to is inside --from (${rt})`);
  if (isInside(rf, rt)) throw new Error(`refusing: --from is inside --to (${rf})`);
  if (existsSync(to)) {
    if (!statSync(to).isDirectory()) throw new Error(`refusing: --to exists and is not a directory: ${to}`);
    if (readdirSync(to).length && !force) throw new Error(`refusing: --to is not empty (${to}); pass --force to overwrite the allowlisted files there (nothing else in it is touched)`);
  }
}

/**
 * Copies the allowlist from `from` to `to` with path rewriting. dryRun: reads only, writes nothing.
 * Returns the summary object (see printMigrate).
 */
export function migrate(opts, deps = {}) {
  const from = resolve(opts.from);
  const to = resolve(opts.to);
  checkFromTo(from, to, opts.force);
  const map = buildPathMap(opts, deps);
  const summary = {
    mode: opts.dryRun ? "dry-run" : "migrate", from, to, roots: map.roots, placeholderForgeHome: map.placeholder,
    copied: 0, rewritten: 0, rewrites: 0, verbatim: 0, unparseable: [], badJsonlLines: [], skippedLinks: [],
    files: [], leftBehind: [], missing: [], unmapped: [], unmappedTotal: 0, unmappedDistinct: 0, errors: [],
  };
  const unmapped = new Map();
  const top = readdirSync(from).sort();
  for (const name of top) {
    if (ALLOWLIST.includes(name) && !FORGE_OWNED.includes(name)) continue;
    let size = { bytes: 0, files: 0 };
    try { size = duSync(join(from, name)); } catch (e) { summary.errors.push(`${name}: size: ${e.message}`); }
    summary.leftBehind.push({ name, bytes: size.bytes, files: size.files, forgeOwned: FORGE_OWNED.includes(name) });
  }
  for (const name of ALLOWLIST) {
    if (FORGE_OWNED.includes(name)) continue;
    const abs = join(from, name);
    if (!existsSync(abs)) { summary.missing.push(name); continue; }
    const st = lstatSync(abs);
    const entries = st.isDirectory() ? [...walk(abs)].map((e) => ({ ...e, rel: `${name}/${e.rel.split(sep).join("/")}` })) : [{ rel: name, abs, st }];
    for (const e of entries) {
      if (!e.st.isFile()) { summary.skippedLinks.push(e.rel); continue; }
      try {
        migrateFile(e, to, map, summary, unmapped, opts.dryRun);
      } catch (err) {
        summary.errors.push(`${e.rel}: ${err.message}`);
      }
    }
  }
  const sorted = [...unmapped.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  summary.unmappedDistinct = sorted.length;
  summary.unmappedTotal = sorted.reduce((n, [, c]) => n + c, 0);
  summary.unmapped = sorted.slice(0, UNMAPPED_CAP).map(([path, count]) => ({ path, count }));
  return summary;
}

function migrateFile(e, to, map, summary, unmapped, dryRun) {
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
  if (kind !== "binary" && text !== null) {
    const bom = text.startsWith(BOM) ? BOM : "";
    if (bom) text = text.slice(1);
    let r;
    try {
      if (kind === "json") r = rewriteJsonText(text, map);
      else if (kind === "jsonl") r = rewriteJsonlText(text, map);
      else r = rewriteText(text, map);
    } catch (err) {
      summary.unparseable.push({ file: e.rel, error: String(err.message).slice(0, 120) });
      r = null;
    }
    if (r) {
      count = r.count;
      if (r.badLines) summary.badJsonlLines.push({ file: e.rel, lines: r.badLines });
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
  if (!dryRun) atomicWrite(join(to, e.rel), out, e.st.mtime);
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
    if (/[\r\n]/.test(rel)) { skipped.push({ file: rel, reason: "newline-in-name" }); continue; }
    try { closeSync(openSync(e.abs, "r")); } catch (err) { skipped.push({ file: rel, reason: err.code || "unreadable" }); continue; }
    files.push(rel);
    bytes += e.st.size;
  }
  return { files, skipped, bytes };
}

function tarBin(platform = process.platform, env = process.env) {
  if (platform === "win32") return join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "tar.exe");
  return "tar";
}

export function backup(opts, { now = new Date(), platform = process.platform, env = process.env } = {}) {
  const from = resolve(opts.from);
  if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(`--from is not a directory: ${from}`);
  const dir = resolve(opts.backup);
  const rf = real(from);
  const rd = real(dir);
  if (samePath(rf, rd) || isInside(rd, rf)) throw new Error(`refusing: --backup is inside --from (${rd})`);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const ext = platform === "win32" ? "zip" : "tar.gz";
  const archive = join(dir, `vibesquad-home-${stamp}.${ext}`);
  const plan = planBackup(from);
  const summary = { mode: opts.dryRun ? "backup-dry-run" : "backup", from, archive, files: plan.files.length, bytes: plan.bytes, skipped: plan.skipped, archived: null, errors: [] };
  if (opts.dryRun) return summary;
  if (existsSync(archive)) throw new Error(`refusing: ${archive} already exists`);
  mkdirSync(dir, { recursive: true });
  const bin = tarBin(platform, env);
  const args = platform === "win32" ? ["-c", "-a", "-f", archive, "-C", from, "-T", "-"] : ["-c", "-z", "-f", archive, "-C", from, "-T", "-"];
  const r = spawnSync(bin, args, { input: plan.files.join("\n") + "\n", encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${bin}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${bin} exited ${r.status}: ${String(r.stderr).trim().slice(0, 500)}`);
  const list = spawnSync(bin, ["-t", "-f", archive], { encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (list.status === 0) summary.archived = list.stdout.split("\n").filter((l) => l && !l.endsWith("/")).length;
  if (summary.archived !== plan.files.length) summary.errors.push(`archive lists ${summary.archived} files, expected ${plan.files.length}`);
  return summary;
}

// ---------------------------------------------------------------- unpushed report (read-only)
function git(cwd, args) {
  const r = spawnSync("git", ["--no-optional-locks", "-C", cwd, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(String(r.stderr || "").trim().split("\n")[0] || `git ${args[0]} exited ${r.status}`);
  return r.stdout;
}

const isWorktree = (dir) => existsSync(join(dir, ".git"));

/** Finds worktrees at <root>/<x> and <root>/<repo>/<unit> without descending further. */
export function findWorktrees(root) {
  const out = [];
  const dirs = (p) => { try { return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; } };
  for (const a of dirs(root)) {
    const pa = join(root, a);
    if (isWorktree(pa)) { out.push(pa); continue; }
    for (const b of dirs(pa)) if (isWorktree(join(pa, b))) out.push(join(pa, b));
  }
  return out;
}

export function unpushedReport(opts = {}) {
  const root = resolve(opts.sanctuary || resolveManagedWorktreeRoot());
  const summary = { mode: "unpushed-report", root, worktrees: 0, unpushed: 0, dirty: 0, clean: 0, errors: 0, items: [] };
  if (!existsSync(root)) throw new Error(`sanctuary not found: ${root}`);
  for (const wt of findWorktrees(root)) {
    const item = { path: relative(root, wt).split(sep).join("/"), branch: null, ahead: 0, dirty: 0, remotes: 0, error: null };
    try {
      item.branch = git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      if (item.branch === "HEAD") item.branch = "(detached)";
      item.remotes = git(wt, ["remote"]).split("\n").filter(Boolean).length;
      item.ahead = Number(git(wt, ["rev-list", "--count", "HEAD", "--not", "--remotes"]).trim()) || 0;
      item.dirty = git(wt, ["status", "--porcelain", "--untracked-files=normal"]).split("\n").filter(Boolean).length;
    } catch (err) {
      item.error = String(err.message || err).slice(0, 200);
    }
    summary.worktrees++;
    if (item.error) summary.errors++;
    else if (item.ahead || item.dirty) {
      if (item.ahead) summary.unpushed++;
      if (item.dirty) summary.dirty++;
    } else summary.clean++;
    summary.items.push(item);
  }
  summary.safeToDelete = summary.unpushed === 0 && summary.dirty === 0 && summary.errors === 0;
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
  log(`  UNMAPPED drive paths: ${s.unmappedDistinct} distinct, ${s.unmappedTotal} occurrences${s.unmappedDistinct > s.unmapped.length ? ` (showing ${s.unmapped.length})` : ""}`);
  for (const u of s.unmapped) log(`    ${String(u.count).padStart(6)}  ${u.path}`);
  for (const e of s.errors) log(`  ERROR ${e}`);
  log(`summary: copied=${s.copied} rewritten=${s.rewritten} (rewrites=${s.rewrites}) verbatim=${s.verbatim} unparseable=${s.unparseable.length} left-behind=${s.leftBehind.length} unmapped=${s.unmappedDistinct} errors=${s.errors.length}${s.mode === "dry-run" ? " (dry run: nothing written)" : ""}`);
}

function printBackup(s, log) {
  log(`forge-migrate ${s.mode}: ${s.from} -> ${s.archive}`);
  for (const k of s.skipped) log(`  skipped (${k.reason}): ${k.file}`);
  for (const e of s.errors) log(`  ERROR ${e}`);
  log(`backup: files=${s.files} bytes=${fmtBytes(s.bytes)} skipped=${s.skipped.length}${s.archived === null ? "" : ` archived=${s.archived}`}${s.mode === "backup-dry-run" ? " (dry run: nothing written)" : ""}`);
}

function printUnpushed(s, log) {
  log(`unpushed report (read-only): ${s.root}`);
  const rows = s.items.filter((i) => i.ahead || i.dirty || i.error);
  if (rows.length) {
    log(`  ${"ahead".padStart(5)}  ${"dirty".padStart(5)}  branch / worktree`);
    for (const i of rows) log(`  ${String(i.ahead).padStart(5)}  ${String(i.dirty).padStart(5)}  ${i.branch ?? "?"}  ${i.path}${i.remotes ? "" : "  [no remote]"}${i.error ? `  ERROR ${i.error}` : ""}`);
  }
  log(JSON.stringify({ root: s.root, worktrees: s.worktrees, unpushed: s.unpushed, dirty: s.dirty, clean: s.clean, errors: s.errors, safeToDelete: s.safeToDelete }));
}

const USAGE = `usage:
  node scripts/forge-migrate.mjs --from <home> --to <dest> [--dry-run] [--force] [--json]
       [--win-user <u> | --win-home <dir>] [--win-localappdata <dir>]
       [--forge-home <dir>] [--projects-root <dir>] [--vs-home-root <dir>] [--worktrees-root <dir>]
  node scripts/forge-migrate.mjs --from <home> --backup <dir> [--dry-run]
  node scripts/forge-migrate.mjs --unpushed-report [--sanctuary <dir>] [--json]
Never deletes anything. See the header of this file and docs/lanes/forge-host/RUNBOOK.md (C2 migrate).`;

export function main(argv = process.argv.slice(2), log = console.log, err = console.error) {
  let args;
  try { args = parseArgs(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  if (args.help) { log(USAGE); return 0; }
  try {
    if (args.unpushedReport) {
      const s = unpushedReport(args);
      if (args.json) log(JSON.stringify(s, null, 2)); else printUnpushed(s, log);
      return 0;
    }
    if (!args.from) { err(`--from is required\n${USAGE}`); return 2; }
    if (!args.to && !args.backup) { err(`--to or --backup is required\n${USAGE}`); return 2; }
    const results = [];
    let failed = false;
    if (args.backup) {
      const s = backup(args);
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
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
