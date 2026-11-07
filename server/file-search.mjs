import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

// Quick open (GET /__vibesquad/files) and find in files (GET /__vibesquad/search) for the Files dock.
// The Paseo daemon has no content-search RPC, so both run here: `git ls-files` / `git grep` (git is always
// installed), or `rg --json` when ripgrep is on PATH. Args are arrays, never a shell string.

// These GETs expose file names / contents: owner-gated reads. Wire into isGatedRead (security S3) in one line.
export const ADE_GATED_READ_PATHS = ["/__vibesquad/files", "/__vibesquad/search", "/__vibesquad/fs/list", "/__vibesquad/fs/read", "/__vibesquad/fs/resolve", "/__vibesquad/fs/watch"];

export const SEARCH_MAX_MATCHES = 500;
export const SEARCH_MAX_LINE = 200;
export const SEARCH_TIMEOUT_MS = 10_000;
export const FILES_MAX = 20_000;
const FILES_TTL_MS = 30_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".worktrees", "dist", "build", "target", ".next", ".venv", "__pycache__"]);

const normPath = (x) => (process.platform === "win32" ? x.toLowerCase() : x);
const insideDir = (child, root) => {
  const c = normPath(child);
  const r = normPath(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
};

/** Real path of cwd if it is an absolute existing directory under one of `roots`, else an error string. */
export function confineCwd(cwd, roots) {
  if (typeof cwd !== "string" || !cwd.trim()) return { error: "cwd is required" };
  // UNC / network paths (\\host\share, //host) would make stat/realpath reach out over SMB: refuse first.
  if (/^[\\/]{2}/.test(cwd)) return { error: "network (UNC) paths are not allowed" };
  if (cwd.split(/[\\/]/).includes("..")) return { error: "cwd must not contain .." };
  if (!isAbsolute(cwd)) return { error: "cwd must be absolute" };
  // Lexical roots check before any stat/realpath, so a path outside every root never touches the disk.
  const lexical = resolve(cwd);
  if (!roots.some((r) => insideDir(lexical, r) || insideDir(lexical, resolve(r)))) {
    return { error: "cwd is not a known agent or team path", status: 403 };
  }
  let real;
  try {
    if (!statSync(cwd).isDirectory()) return { error: "cwd is not a directory" };
    real = realpathSync(cwd);
  } catch {
    return { error: "cwd is not a directory" };
  }
  if (!roots.some((r) => insideDir(real, r))) return { error: "cwd is not a known agent or team path", status: 403 };
  return { cwd: real };
}

/** Normalized query options; null when there is nothing to search for. */
export function searchOptions(params) {
  const q = String(params.get?.("q") ?? params.q ?? "");
  if (!q || q.length > 500) return null;
  const flag = (k) => ["1", "true"].includes(String(params.get?.(k) ?? params[k] ?? ""));
  return { q, regex: flag("regex"), caseSensitive: flag("case") };
}

export function gitGrepArgs({ q, regex, caseSensitive }, { noIndex = false } = {}) {
  const args = ["-c", "core.quotepath=off", "grep", "-n", "-I", "--column", "-z", "--no-color"];
  args.push(noIndex ? "--no-index" : "--untracked");
  if (noIndex) args.push("--exclude-standard");
  if (!caseSensitive) args.push("-i");
  args.push(regex ? "-E" : "-F", "-e", q, "--");
  return args;
}

export function rgArgs({ q, regex, caseSensitive }) {
  const args = ["--json", "--no-config", "--line-number", "--column", caseSensitive ? "--case-sensitive" : "--ignore-case"];
  if (!regex) args.push("--fixed-strings");
  args.push("--max-columns", "2000", "-e", q, "--", ".");
  return args;
}

const clip = (text) => {
  const t = text.replace(/\r$/, "");
  return t.length > SEARCH_MAX_LINE ? `${t.slice(0, SEARCH_MAX_LINE)}…` : t;
};
const slash = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** One `git grep -z --column` line: file\0line\0col\0text. */
export function parseGitGrepLine(line) {
  const a = line.indexOf("\0");
  const b = a < 0 ? -1 : line.indexOf("\0", a + 1);
  const c = b < 0 ? -1 : line.indexOf("\0", b + 1);
  if (c < 0) return null;
  const lineNo = Number(line.slice(a + 1, b));
  const col = Number(line.slice(b + 1, c));
  if (!Number.isInteger(lineNo) || lineNo < 1) return null;
  return { path: slash(line.slice(0, a)), line: lineNo, col: Number.isInteger(col) && col > 0 ? col : 1, text: clip(line.slice(c + 1)) };
}

/** One `rg --json` line; only "match" events count. */
export function parseRgLine(line) {
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  if (j?.type !== "match") return null;
  const d = j.data ?? {};
  const path = d.path?.text;
  const lineNo = d.line_number;
  const text = d.lines?.text;
  if (typeof path !== "string" || !Number.isInteger(lineNo) || typeof text !== "string") return null;
  const start = d.submatches?.[0]?.start;
  return { path: slash(path), line: lineNo, col: Number.isInteger(start) ? start + 1 : 1, text: clip(text.replace(/\n$/, "")) };
}

let rgCache;
/** Absolute rg path when ripgrep is on PATH (not shipped with VibeSquad). */
export function findRg(env = process.env) {
  if (rgCache !== undefined && env === process.env) return rgCache;
  const exts = process.platform === "win32" ? [".exe"] : [""]; // .cmd shims would need a shell
  let found = null;
  for (const dir of String(env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, `rg${ext}`);
      if (existsSync(p)) {
        found = p;
        break;
      }
    }
    if (found) break;
  }
  if (env === process.env) rgCache = found;
  return found;
}

const isGitRepo = (cwd) => spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, windowsHide: true, timeout: 5000 }).stdout?.toString().trim() === "true";

/** Streams matches; resolves { matches, truncated, engine }. `signal` kills the child (client abort). */
export function runSearch(cwd, opts, { signal, timeoutMs = SEARCH_TIMEOUT_MS, max = SEARCH_MAX_MATCHES, rg = findRg() } = {}) {
  const engine = rg ? "rg" : "git";
  const cmd = rg ?? "git";
  const args = rg ? rgArgs(opts) : gitGrepArgs(opts, { noIndex: !isGitRepo(cwd) });
  const parse = rg ? parseRgLine : parseGitGrepLine;
  if (signal?.aborted) return Promise.resolve({ matches: [], truncated: false, timedOut: false, engine });
  return new Promise((done) => {
    const matches = [];
    let truncated = false;
    let timedOut = false;
    let buf = "";
    let settled = false;
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stop = () => {
      try {
        child.kill();
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => stop();
    signal?.addEventListener("abort", onAbort);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      done({ matches, truncated: truncated || timedOut, timedOut, engine, ...(error ? { error } : {}) });
    };
    let stderr = "";
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-500)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const m = parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (!m) continue;
        if (matches.length >= max) {
          truncated = true;
          stop();
          return;
        }
        matches.push(m);
      }
    });
    child.on("error", (e) => finish(String(e?.message ?? e)));
    child.on("close", (code) => {
      if (buf && matches.length < max) {
        const m = parse(buf);
        if (m) matches.push(m);
      }
      // git grep / rg exit 1 = no matches; 2+ is a real error (bad regex) unless we killed it.
      finish(code > 1 && !truncated && !timedOut && !signal?.aborted ? stderr.trim() || `exit ${code}` : undefined);
    });
  });
}

// ---- quick open file list -----------------------------------------------------------------

/** `git ls-files -co --exclude-standard -z` output → relative paths with forward slashes. */
export function parseLsFiles(out, max = FILES_MAX) {
  const files = [];
  const seen = new Set();
  for (const p of out.split("\0")) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    files.push(slash(p));
    if (files.length >= max) return { files, truncated: true };
  }
  return { files, truncated: false };
}

/** Bounded walk for non-git folders: skips SKIP_DIRS and dot-dirs. */
export function walkFiles(root, max = FILES_MAX) {
  const files = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(p);
      } else if (e.isFile()) {
        files.push(p);
        if (files.length >= max) return { files, truncated: true };
      }
    }
  }
  return { files: files.sort(), truncated: false };
}

const fileCache = new Map();
export function listFiles(rawCwd, { refresh = false, now = Date.now() } = {}) {
  const cwd = realOr(rawCwd); // one cache entry per real directory, however it was spelled
  const hit = fileCache.get(cwd);
  if (hit && !refresh && now - hit.at < FILES_TTL_MS) return hit.value;
  let value;
  const r = spawnSync("git", ["-c", "core.quotepath=off", "ls-files", "-co", "--exclude-standard", "-z"], { cwd, windowsHide: true, timeout: SEARCH_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) value = { ...parseLsFiles(r.stdout.toString("utf8")), source: "git" };
  else value = { ...walkFiles(cwd), source: "walk" };
  fileCache.set(cwd, { at: now, value });
  if (fileCache.size > 32) fileCache.delete(fileCache.keys().next().value);
  return value;
}

// ---- HTTP ---------------------------------------------------------------------------------

/** `roots` is a list or a (fresh) => list getter; a cached miss is retried once with a fresh list. */
const RESCAN_COOLDOWN_MS = 5000;
let lastRescanAt = 0;
export const _resetRescan = () => { lastRescanAt = 0; };
export function confineReq(cwd, roots, now = Date.now()) {
  if (typeof roots !== "function") return confineCwd(cwd, roots);
  const c = confineCwd(cwd, roots(false));
  // A 403 may just mean a new agent worktree: rescan once, but never more than every 5s (a probe loop must not hammer the disk).
  if (c.status !== 403 || now - lastRescanAt < RESCAN_COOLDOWN_MS) return c;
  lastRescanAt = now;
  return confineCwd(cwd, roots(true));
}

/** GET ?cwd=&refresh=1 → { ok, files, truncated, source }. `roots` = allowed cwd roots (real paths). */
export function handleFileList(req, res, roots, sendJson) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  const params = new URL(req.url, "http://x").searchParams;
  const c = confineReq(params.get("cwd") ?? "", roots);
  if (c.error) return sendJson(res, c.status ?? 400, { ok: false, error: c.error });
  try {
    return sendJson(res, 200, { ok: true, ...listFiles(c.cwd, { refresh: params.get("refresh") === "1" }) });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
}

/** GET ?cwd=&q=&regex=1&case=1 → { ok, matches[{path,line,col,text}], truncated, engine }. */
export function handleSearch(req, res, roots, sendJson) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  const params = new URL(req.url, "http://x").searchParams;
  const c = confineReq(params.get("cwd") ?? "", roots);
  if (c.error) return sendJson(res, c.status ?? 400, { ok: false, error: c.error });
  const opts = searchOptions(params);
  if (!opts) return sendJson(res, 400, { ok: false, error: "q is required (max 500 chars)" });
  const ac = new AbortController();
  res.on("close", () => !res.writableFinished && ac.abort());
  return runSearch(c.cwd, opts, { signal: ac.signal }).then((r) => {
    if (ac.signal.aborted) return;
    if (r.error) return sendJson(res, 400, { ok: false, error: r.error, engine: r.engine });
    return sendJson(res, 200, { ok: true, ...r });
  });
}

// ---- Files dock tree + read without the Paseo daemon -----------------------------------------
// GET /__vibesquad/fs/list?cwd=&path= → { ok, entries[{name,path,kind,size?}] }
// GET /__vibesquad/fs/read?cwd=&path=&max= → raw bytes (content-type by extension; x-vs-modified header)
// Both are confined to the agent/team cwd: no absolute paths, no `..`, symlinks must resolve inside cwd.

export const FS_READ_MAX = 25 * 1024 * 1024;
const FS_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  ico: "image/x-icon", bmp: "image/bmp", pdf: "application/pdf", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  mp4: "video/mp4", webm: "video/webm", json: "application/json", html: "text/html", md: "text/markdown",
};
export const fsMime = (p) => FS_MIME[(p.split(".").pop() ?? "").toLowerCase()] ?? "application/octet-stream";

/** Repo-relative path → { rel } or { error, status }. Mirrors src/fileLinks.ts normalizeRepoPath. */
export function normalizeRel(raw) {
  const p = String(raw ?? "").replaceAll("\\", "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (p.includes("\0")) return { error: "invalid path", status: 400 };
  if (p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:/.test(p)) return { error: "path must be relative to the workspace", status: 400 };
  if (p.split("/").some((s) => s === "..")) return { error: "path must not contain ..", status: 400 };
  return { rel: p };
}

const realOr = (p) => { try { return realpathSync(p); } catch { return p; } };
const SENSITIVE_HOME_DIRS = [".vibesquad", ".paseo", ".ssh"];

/** Never a browsable workspace root: the home dir itself, or a drive / filesystem root. */
export function isUnsafeRoot(p) {
  if (typeof p !== "string" || !p) return true;
  const r = resolve(p);
  return parse(r).root === r || normPath(realOr(r)) === normPath(realOr(homedir()));
}

/** `real` sits in ~/.vibesquad, ~/.paseo or ~/.ssh (or a .git dir) and the workspace `cwd` is not itself inside that dir. */
export function isSensitivePath(real, cwd) {
  const home = realOr(homedir());
  const hit = SENSITIVE_HOME_DIRS.map((d) => realOr(join(home, d))).some((b) => insideDir(real, b) && !insideDir(cwd, b));
  return hit || real.split(/[\\/]/).some((seg) => seg.toLowerCase() === ".git");
}

/** Real path of cwd/rel, only if it stays inside cwd (symlink-safe) and avoids .git and credential dirs. */
export function resolveInCwd(cwd, rel) {
  const n = normalizeRel(rel);
  if (n.error) return n;
  if (n.rel.split("/").some((s) => s.toLowerCase() === ".git")) return { error: "not found", status: 404 };
  let real;
  try {
    real = realpathSync(join(cwd, n.rel));
  } catch {
    return { error: "not found", status: 404 };
  }
  if (!insideDir(real, cwd)) return { error: "path is outside the workspace", status: 403 };
  if (isSensitivePath(real, cwd)) return { error: "not found", status: 404 };
  return { rel: n.rel, real };
}

export function fsList(cwd, rel) {
  const r = resolveInCwd(cwd, rel);
  if (r.error) return r;
  try {
    if (!statSync(r.real).isDirectory()) return { error: "not a directory", status: 400 };
    const entries = readdirSync(r.real, { withFileTypes: true })
      .filter((d) => d.name.toLowerCase() !== ".git")
      .map((d) => {
        const path = r.rel ? `${r.rel}/${d.name}` : d.name;
        let kind = d.isDirectory() ? "directory" : "file";
        let size;
        try {
          const st = statSync(join(r.real, d.name));
          if (st.isDirectory()) kind = "directory";
          else size = st.size;
        } catch { /* dangling link: list as file */ }
        return { name: d.name, path, kind, ...(size !== undefined ? { size } : {}) };
      })
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
    return { entries };
  } catch (e) {
    return { error: String(e?.message ?? e), status: 500 };
  }
}

export function fsRead(cwd, rel, max = FS_READ_MAX) {
  const r = resolveInCwd(cwd, rel);
  if (r.error) return r;
  try {
    const st = statSync(r.real);
    if (!st.isFile()) return { error: "not a file", status: 400 };
    if (st.size > max) return { error: `file too large (${st.size} bytes)`, status: 413, size: st.size };
    return { bytes: readFileSync(r.real), size: st.size, modifiedAt: st.mtime.toISOString(), mime: fsMime(r.rel) };
  } catch (e) {
    return { error: String(e?.message ?? e), status: 500 };
  }
}

export function handleFsList(req, res, roots, sendJson) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  const params = new URL(req.url, "http://x").searchParams;
  const c = confineReq(params.get("cwd") ?? "", roots);
  if (c.error) return sendJson(res, c.status ?? 400, { ok: false, error: c.error });
  const r = fsList(c.cwd, params.get("path") ?? "");
  if (r.error) return sendJson(res, r.status ?? 400, { ok: false, error: r.error });
  return sendJson(res, 200, { ok: true, entries: r.entries });
}

/**
 * A relative path that is missing under `cwd` may live in a sibling worktree of the same lane (an Art Lead in the main
 * repo linking a file only its worktree has). `candidates` are already-vetted dirs; one direct existence check each,
 * no scans. Returns { found: {cwd, rel} } for a unique hit, { ambiguous: [cwd...] } for several, else {}.
 */
export function findInWorktrees(cwd, rel, candidates) {
  const own = normPath(realOr(cwd));
  const hits = new Map();
  const n = normalizeRel(rel);
  if (n.error) return {};
  const segs = n.rel.split("/");
  for (const cand of candidates ?? []) {
    const dir = realOr(cand);
    if (normPath(dir) === own || isUnsafeRoot(dir)) continue;
    // A link may carry the sanctuary prefix (`worktrees/<repo>/<unit>/`, `<repo>/<unit>/`, `<unit>/`) where <unit> is this
    // candidate's folder; try the link as-is plus each prefix-stripped form. Every form still goes through resolveInCwd.
    const unit = basename(dir).toLowerCase();
    const forms = [n.rel];
    for (const at of [0, 1, 2]) {
      if (segs.length > at + 1 && segs[at].toLowerCase() === unit && (at < 2 || segs[0].toLowerCase() === "worktrees")) {
        forms.push(segs.slice(at + 1).join("/"));
      }
    }
    for (const form of forms) {
      const r = resolveInCwd(dir, form);
      if (r.error) continue;
      try { if (!statSync(r.real).isFile()) continue; } catch { continue; }
      hits.set(normPath(r.real), { cwd: dir, rel: r.rel });
    }
  }
  const all = [...hits.values()];
  if (all.length === 1) return { found: all[0] };
  return all.length ? { ambiguous: all.map((h) => h.cwd) } : {};
}

/** `worktreesFor(cwd)` (optional) lists the lane's other worktrees to try when the file is missing under cwd. */
export function handleFsRead(req, res, roots, sendJson, worktreesFor, labelFor = (d) => basename(d)) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  const params = new URL(req.url, "http://x").searchParams;
  const c = confineReq(params.get("cwd") ?? "", roots);
  if (c.error) return sendJson(res, c.status ?? 400, { ok: false, error: c.error });
  const asked = Number(params.get("max"));
  const max = Number.isFinite(asked) && asked > 0 ? Math.min(asked, FS_READ_MAX) : FS_READ_MAX;
  let r = fsRead(c.cwd, params.get("path") ?? "", max);
  if (r.error && r.status === 404 && worktreesFor) {
    const alt = findInWorktrees(c.cwd, params.get("path") ?? "", worktreesFor(c.cwd));
    if (alt.ambiguous) {
      const rel = normalizeRel(params.get("path") ?? "").rel;
      const matches = alt.ambiguous.map((d) => `${labelFor(d)}/${rel}`); // never raw host paths
      return sendJson(res, 409, { ok: false, error: `ambiguous: ${matches.length} worktrees have this file (${matches.join(", ")})`, matches });
    }
    if (alt.found) r = fsRead(alt.found.cwd, alt.found.rel, max);
  }
  if (r.error) return sendJson(res, r.status ?? 400, { ok: false, error: r.error, size: r.size });
  res.statusCode = 200;
  res.setHeader("content-type", r.mime);
  res.setHeader("x-content-type-options", "nosniff");
  // SVG/HTML served from our origin must not run script if opened directly.
  res.setHeader("content-security-policy", "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-vs-modified", r.modifiedAt);
  res.setHeader("x-vs-size", String(r.size));
  res.end(r.bytes);
}

// ---- Files dock writes + watch without the Paseo daemon (N2) ---------------------------------------
// POST /__vibesquad/fs/{write,create,rename,delete,duplicate} (owner-only: the caller gates every non-GET) and
// GET /__vibesquad/fs/watch?cwd=&path=&since= (long-poll; follows the read gate). Same confinement as read:
// relative paths only, realpath inside the cwd root, no .git / credential dirs, symlinks never followed out.

export const FS_WRITE_MAX = 900 * 1024; // under the 1 MiB request-body cap

const badName = (name) => typeof name !== "string" || !name || name === "." || name === ".." || /[\\/\0]/.test(name) || name.toLowerCase() === ".git" || name.length > 255;

/** New-or-existing target under cwd: the parent must resolve inside cwd; the leaf is never resolved (no symlink follow). */
function resolveNewIn(cwd, parentRel, name) {
  if (badName(name)) return { error: "invalid name", status: 400 };
  const parent = parentRel ? resolveInCwd(cwd, parentRel) : { rel: "", real: realOr(cwd) };
  if (parent.error) return parent;
  try { if (!statSync(parent.real).isDirectory()) return { error: "parent is not a directory", status: 400 }; } catch { return { error: "not found", status: 404 }; }
  const real = join(parent.real, name);
  if (!insideDir(real, realOr(cwd))) return { error: "path is outside the workspace", status: 403 };
  return { rel: parent.rel ? `${parent.rel}/${name}` : name, real, parentReal: parent.real };
}

const lexists = (p) => { try { lstatSync(p); return true; } catch { return false; } };

/** Temp file next to the target, then rename over it: a crash never leaves a half-written file. */
function atomicWrite(real, content, mode) {
  const tmp = join(dirname(real), `.${basename(real)}.vs-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, content, { mode });
    renameSync(tmp, real);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/** Overwrites an existing file. `expectedModifiedAt` (ISO from fs/read) guards a stale editor: mismatch => 409 conflict. */
export function fsWrite(cwd, rel, content, expectedModifiedAt) {
  if (typeof content !== "string") return { error: "content must be a string", status: 400 };
  if (Buffer.byteLength(content) > FS_WRITE_MAX) return { error: `content too large (max ${FS_WRITE_MAX} bytes)`, status: 413 };
  const r = resolveInCwd(cwd, rel);
  if (r.error) return r;
  try {
    const st = statSync(r.real);
    if (!st.isFile()) return { error: "not a file", status: 400 };
    if (expectedModifiedAt && st.mtime.toISOString() !== expectedModifiedAt) return { error: "file changed on disk", status: 409, conflict: true };
    atomicWrite(r.real, content, st.mode & 0o777);
    return { entryPath: r.rel, modifiedAt: statSync(r.real).mtime.toISOString(), size: Buffer.byteLength(content) };
  } catch (e) {
    return { error: String(e?.message ?? e), status: 500 };
  }
}

export function fsCreate(cwd, parentRel, name, kind) {
  if (kind !== "file" && kind !== "directory") return { error: "kind must be file or directory", status: 400 };
  const n = normalizeRel(parentRel ?? "");
  if (n.error) return n;
  const t = resolveNewIn(cwd, n.rel, name);
  if (t.error) return t;
  if (isSensitivePath(t.real, cwd)) return { error: "not found", status: 404 };
  if (lexists(t.real)) return { error: "already exists", status: 409 };
  try {
    if (kind === "directory") mkdirSync(t.real);
    else writeFileSync(t.real, "", { flag: "wx" });
    return { entryPath: t.rel };
  } catch (e) {
    return { error: String(e?.message ?? e), status: 500 };
  }
}

const splitRel = (rel) => { const i = rel.lastIndexOf("/"); return i < 0 ? { dir: "", leaf: rel } : { dir: rel.slice(0, i), leaf: rel.slice(i + 1) }; };

/** An existing entry (file, dir or link) other than the root; a link is the entry itself, never its target. */
function entryIn(cwd, rel) {
  const n = normalizeRel(rel);
  if (n.error) return n;
  if (!n.rel) return { error: "refusing to modify the workspace root", status: 400 };
  if (n.rel.split("/").some((s) => s.toLowerCase() === ".git")) return { error: "not found", status: 404 };
  const { dir, leaf } = splitRel(n.rel);
  const t = resolveNewIn(cwd, dir, leaf);
  if (t.error) return t;
  if (!lexists(t.real)) return { error: "not found", status: 404 };
  if (isSensitivePath(t.real, cwd)) return { error: "not found", status: 404 };
  return { ...t, dir, leaf };
}

export function fsRename(cwd, rel, name) {
  const e = entryIn(cwd, rel);
  if (e.error) return e;
  if (badName(name)) return { error: "invalid name", status: 400 };
  const dest = join(e.parentReal, name);
  if (isSensitivePath(dest, cwd)) return { error: "not found", status: 404 };
  if (lexists(dest)) return { error: "already exists", status: 409 };
  try {
    renameSync(e.real, dest);
    return { entryPath: e.dir ? `${e.dir}/${name}` : name };
  } catch (err) {
    return { error: String(err?.message ?? err), status: 500 };
  }
}

export function fsDelete(cwd, rel) {
  const e = entryIn(cwd, rel);
  if (e.error) return e;
  try {
    if (lstatSync(e.real).isDirectory()) rmSync(e.real, { recursive: true });
    else unlinkSync(e.real); // a symlink: removes the link, not its target
    return { entryPath: e.rel };
  } catch (err) {
    return { error: String(err?.message ?? err), status: 500 };
  }
}

export function fsDuplicate(cwd, rel) {
  const e = entryIn(cwd, rel);
  if (e.error) return e;
  const dot = e.leaf.lastIndexOf(".");
  const ext = dot > 0 ? e.leaf.slice(dot) : "";
  const stem = ext ? e.leaf.slice(0, dot) : e.leaf;
  let name = "";
  for (let i = 1; i < 1000 && !name; i++) {
    const cand = `${stem} copy${i > 1 ? ` ${i}` : ""}${ext}`;
    if (!lexists(join(e.parentReal, cand))) name = cand;
  }
  if (!name) return { error: "no free name for the copy", status: 409 };
  const dest = join(e.parentReal, name);
  try {
    const st = lstatSync(e.real);
    if (st.isDirectory()) cpSync(e.real, dest, { recursive: true, dereference: false, verbatimSymlinks: true });
    else if (st.isFile()) copyFileSync(e.real, dest);
    else return { error: "not a file or directory", status: 400 };
    return { entryPath: e.dir ? `${e.dir}/${name}` : name };
  } catch (err) {
    return { error: String(err?.message ?? err), status: 500 };
  }
}

// ---- watch: one fs.watch per path, shared by every waiting long-poll, closed when the last one leaves ----
// The cursor is the file's own signature (mtime:size, or "gone"), not a counter: it survives a watcher being closed
// between two polls, and a change that lands in the gap between polls still shows up as a different signature.
export const WATCH_HOLD_MS = 25_000; // client re-polls at once; keeps each request well under proxy idle limits
const WATCH_DEBOUNCE_MS = 120;
const watchers = new Map(); // normPath(real) -> { w, waiters:Set<fn>, timer }
export const _watcherCount = () => watchers.size;

const sigOf = (real) => { try { const st = statSync(real); return `${st.mtimeMs}:${st.size}`; } catch { return "gone"; } };

function watcherFor(real) {
  const key = normPath(real);
  let e = watchers.get(key);
  if (e) return e;
  e = { w: null, waiters: new Set(), timer: null };
  const bump = () => {
    clearTimeout(e.timer);
    e.timer = setTimeout(() => { for (const fn of [...e.waiters]) fn(); }, WATCH_DEBOUNCE_MS);
    e.timer.unref?.();
  };
  // Watch the parent dir, not the file: atomic saves (temp + rename) replace the inode a file watch would hold.
  const leaf = basename(real);
  e.w = watch(dirname(real), { persistent: false }, (_ev, f) => { if (!f || String(f) === leaf) bump(); });
  e.w.on("error", bump);
  watchers.set(key, e);
  return e;
}

function releaseWatcher(real, fn) {
  const key = normPath(real);
  const e = watchers.get(key);
  if (!e) return;
  if (fn) e.waiters.delete(fn);
  if (e.waiters.size) return;
  clearTimeout(e.timer);
  try { e.w?.close(); } catch { /* already closed */ }
  watchers.delete(key);
}

/**
 * Resolves { seq, changed }. `since` undefined = baseline: answers at once with the current signature. Otherwise answers
 * at once if the signature already differs, else waits until it does (changed true) or `holdMs` passes (changed false).
 * Aborting `signal` (client gone) releases the watcher.
 */
export function fsWatch(cwd, rel, since, { holdMs = WATCH_HOLD_MS, signal } = {}) {
  const n = normalizeRel(rel);
  if (n.error) return Promise.resolve(n);
  if (!n.rel) return Promise.resolve({ error: "path is required", status: 400 });
  if (n.rel.split("/").some((s) => s.toLowerCase() === ".git")) return Promise.resolve({ error: "not found", status: 404 });
  const { dir, leaf } = splitRel(n.rel);
  const t = resolveNewIn(cwd, dir, leaf);
  if (t.error) return Promise.resolve(t);
  if (isSensitivePath(t.real, cwd)) return Promise.resolve({ error: "not found", status: 404 });
  // The leaf itself may be a symlink pointing outside the workspace: don't report on it.
  if (lexists(t.real) && !insideDir(realOr(t.real), realOr(cwd))) return Promise.resolve({ error: "path is outside the workspace", status: 403 });
  const cur = sigOf(t.real);
  if (typeof since !== "string" || !since) return Promise.resolve({ seq: cur, changed: false });
  if (cur !== since) return Promise.resolve({ seq: cur, changed: true });
  let e;
  try { e = watcherFor(t.real); } catch (err) { return Promise.resolve({ error: String(err?.message ?? err), status: 500 }); }
  return new Promise((done) => {
    const finish = (changed) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      releaseWatcher(t.real, wake);
      done({ seq: sigOf(t.real), changed });
    };
    const wake = () => { if (sigOf(t.real) !== since) finish(true); };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), holdMs);
    e.waiters.add(wake);
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** POST handlers share one shape: JSON body { cwd, path, ... } -> { ok, ...result } or { ok:false, error }. `readBody` must keep `cwd`. */
export async function handleFsMutation(op, req, res, roots, sendJson, readBody) {
  if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method not allowed" });
  let body;
  try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }); }
  const c = confineReq(String(body?.cwd ?? ""), roots);
  if (c.error) return sendJson(res, c.status ?? 400, { ok: false, error: c.error });
  const path = String(body?.path ?? "");
  const r =
    op === "write" ? fsWrite(c.cwd, path, body?.content, typeof body?.expectedModifiedAt === "string" ? body.expectedModifiedAt : undefined)
    : op === "create" ? fsCreate(c.cwd, String(body?.parentPath ?? ""), body?.name, body?.kind)
    : op === "rename" ? fsRename(c.cwd, path, body?.name)
    : op === "delete" ? fsDelete(c.cwd, path)
    : op === "duplicate" ? fsDuplicate(c.cwd, path)
    : { error: "unknown op", status: 404 };
  if (r.error) return sendJson(res, r.status ?? 400, { ok: false, error: r.error, ...(r.conflict ? { conflict: true } : {}) });
  return sendJson(res, 200, { ok: true, ...r });
}

export function handleFsWatch(req, res, roots, sendJson) {
  if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method not allowed" });
  const params = new URL(req.url, "http://x").searchParams;
  const c = confineReq(params.get("cwd") ?? "", roots);
  if (c.error) return sendJson(res, c.status ?? 400, { ok: false, error: c.error });
  const since = params.get("since") || undefined;
  const ac = new AbortController();
  res.on("close", () => !res.writableFinished && ac.abort());
  return fsWatch(c.cwd, params.get("path") ?? "", since, { signal: ac.signal }).then((r) => {
    if (ac.signal.aborted) return;
    if (r.error) return sendJson(res, r.status ?? 400, { ok: false, error: r.error });
    return sendJson(res, 200, { ok: true, seq: r.seq, changed: r.changed });
  });
}

/** Repo paths whose basename equals `name`; only an unambiguous single hit resolves. */
export function resolveBareName(files, name) {
  const want = String(name ?? "");
  if (!want || /[\/]/.test(want)) return { path: null, count: 0 };
  const hits = files.filter((f) => f === want || f.endsWith(`/${want}`));
  return { path: hits.length === 1 ? hits[0] : null, count: hits.length };
}

/** GET ?agentId=&name= → { ok, path|null, count }. `cwdFor(agentId)` is the server-side agent cwd lookup. */
export async function handleFsResolve(req, res, cwdFor, sendJson, roots) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
  const params = new URL(req.url, "http://x").searchParams;
  try {
    const raw = await cwdFor(params.get("agentId") ?? "");
    if (!raw) return sendJson(res, 404, { ok: false, error: "unknown agent" });
    const c = confineReq(raw, roots ?? []); // same realpath + roots check as list/read
    if (c.error) return sendJson(res, c.status ?? 400, { ok: false, error: c.error });
    return sendJson(res, 200, { ok: true, ...resolveBareName(listFiles(c.cwd).files, params.get("name") ?? "") });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
}
