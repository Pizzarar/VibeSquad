import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";

// Quick open (GET /__vibesquad/files) and find in files (GET /__vibesquad/search) for the Files dock.
// The Paseo daemon has no content-search RPC, so both run here: `git ls-files` / `git grep` (git is always
// installed), or `rg --json` when ripgrep is on PATH. Args are arrays, never a shell string.

// These GETs expose file names / contents: owner-gated reads. Wire into isGatedRead (security S3) in one line.
export const ADE_GATED_READ_PATHS = ["/__vibesquad/files", "/__vibesquad/search"];

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
export function listFiles(cwd, { refresh = false, now = Date.now() } = {}) {
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
function confineReq(cwd, roots) {
  if (typeof roots !== "function") return confineCwd(cwd, roots);
  const c = confineCwd(cwd, roots(false));
  return c.status === 403 ? confineCwd(cwd, roots(true)) : c;
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
