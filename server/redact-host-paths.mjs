// Host-path redaction for text/objects handed to a non-owner caller or forwarded between agents (idea-249, idea-352).
// A leaf module (node builtins only): vibesquad-api.mjs re-exports it, and server/hooks/agent-duties.ts imports it statically.
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
/** Fields that hold a host path (or text built around one): dropped for a non-owner when the value names one. */
const HOST_PATH_KEYS = new Set(["path", "cwd", "packetPath", "fullPath", "snapshot", "prompt", "initialPrompt"]);
/** Fields that hold error text: cut before the host path for a non-owner, so the reason's head survives. */
const ERROR_TEXT_KEYS = new Set(["error", "errors", "reason", "note"]);
const DRIVE_OR_UNC = /(^|[^A-Za-z0-9])([A-Za-z]:[\\/]|\\\\[^\\\s])/;
const slashLower = (p) => String(p ?? "").replaceAll("\\", "/").toLowerCase();
const hostRoots = (rootDir) =>
  [...new Set([homedir(), tmpdir(), rootDir, REPO_ROOT, process.env.VIBESQUAD_HOME].filter(Boolean).map((r) => slashLower(r).replace(/\/+$/, "")))].filter((r) => r.length > 3);
/** Index of the first host path in `text` (a drive/UNC path, or one under home, tmp, the repo root or VIBESQUAD_HOME), else -1. */
function hostPathIndex(text, roots) {
  const t = String(text ?? "");
  const m = DRIVE_OR_UNC.exec(t);
  const low = slashLower(t);
  const hits = [m ? m.index + m[1].length : -1, ...roots.map((r) => low.indexOf(r))].filter((i) => i >= 0);
  return hits.length ? Math.min(...hits) : -1;
}
function redactErrorText(text, roots) {
  const t = String(text);
  const at = hostPathIndex(t, roots);
  if (at < 0) return t;
  const head = t.slice(0, at);
  const cut = head.lastIndexOf(": ");
  return `${cut > 0 ? head.slice(0, cut) : "request failed"} (detail names a host path; see the server log)`;
}
const isPlainObject = (v) => v !== null && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v));
/**
 * A copy of `value` fit for a non-owner caller: at any depth, a HOST_PATH_KEYS string that is absolute or names a host path
 * is dropped, and ERROR_TEXT_KEYS text is cut before its host path. Other fields (brief content, ids, repo-relative paths)
 * are kept as they are; the input is not mutated.
 */
export function redactHostPaths(value, rootDir = REPO_ROOT, roots = hostRoots(rootDir)) {
  if (Array.isArray(value)) return value.map((v) => redactHostPaths(v, rootDir, roots));
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && HOST_PATH_KEYS.has(k) && (isAbsolute(v) || hostPathIndex(v, roots) >= 0)) continue;
    if (ERROR_TEXT_KEYS.has(k) && typeof v === "string") out[k] = redactErrorText(v, roots);
    else if (ERROR_TEXT_KEYS.has(k) && Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? redactErrorText(x, roots) : redactHostPaths(x, rootDir, roots)));
    else out[k] = redactHostPaths(v, rootDir, roots);
  }
  return out;
}

// ---- idea-419: token-level redaction for free text (worker reports, watch pings) ----
// redactErrorText cuts a whole error string at its first host path; that is right for an API error, wrong for a report,
// where it replaced every line holding a path (a file:// markdown link, a worktree path in backticks) with "request failed".
// Here only the path token is swapped: for a repo-relative path when it is under a repo root or a worktree, else <host-path>.

/** What ends a path token in prose/markdown: whitespace, quotes, backticks, brackets, markdown emphasis, table pipes. */
const TOKEN_TAIL = String.raw`[^\s"'\`<>()\[\]{}|*]*`;
/**
 * A path with spaces under an unknown root (C:\Users\<first  last>\…, C:/Program Files/My App/…): after one or more spaces, a
 * word that starts with a letter and goes on with a path separator stays in the token. A token that ends in sentence
 * punctuation ("…/Proj: 41/41 pass") or a word that starts with a digit ("3/4 tests") ends it.
 */
const SPACED_TAIL = String.raw`(?:(?<![.,;:!?]) +[A-Za-z_~$&+=@#-][^\s"'\`<>()\[\]{}|*\\/:]*[\\/]${TOKEN_TAIL})*`;
/** A path separator, raw or percent-encoded (file:///C%3A%5CUsers%5C…). */
const SEP = String.raw`(?:[\\/]|%5C|%2F)`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Regex source for root `r` (lowercased, forward slashes) in any slash style or case, raw or percent-encoded, as a drive path, a Git-Bash /c/ or WSL /mnt/c/ path. */
function rootPattern(r) {
  const drive = /^([a-z]):\//.exec(r);
  const segs = (drive ? r.slice(3) : r).split("/").filter(Boolean).map((s) => escapeRe(s).replace(/ /g, "(?: |%20)"));
  const head = drive ? String.raw`(?:${drive[1]}(?::|%3A)${SEP}+|/(?:mnt/)?${drive[1]}/)` : `${SEP}+`;
  return head + segs.join(`${SEP}+`);
}
/**
 * Host paths not under a known root: any file: URL (file:///C%3A/…, file://host/share/…), a drive path (raw or %3A/%5C/%2F),
 * a UNC path (raw or %5C%5C), a Git-Bash/WSL drive path, a POSIX home (raw or %2F), a Windows env-var path.
 */
const GENERIC_PATH = [
  String.raw`(?<![A-Za-z0-9])file:${SEP}`,
  String.raw`(?<![A-Za-z0-9])[A-Za-z](?::|%3A)${SEP}`,
  String.raw`\\\\[^\\\s]`,
  String.raw`%5C%5C(?!%5C)`,
  String.raw`(?<![\w.~-])/(?:mnt/)?[a-z]/(?=[^/\s])`,
  String.raw`(?<![\w.~-])/(?:home|Users|root)/(?=[^/\s])`,
  String.raw`%2F(?:home|Users|root)%2F`,
  String.raw`%(?:LOCALAPPDATA|APPDATA|USERPROFILE|HOMEPATH|HOMEDRIVE|TEMP|TMP|PROGRAMDATA|VIBESQUAD_HOME)%`,
];
const LEFTOVER = new RegExp(GENERIC_PATH.join("|"), "i");
/** %XX-decoded text (UTF-8 aware; a malformed sequence falls back to byte-wise). */
function percentDecode(s) {
  try {
    return decodeURIComponent(s.replace(/%(?![0-9a-f]{2})/gi, "%25"));
  } catch {
    return s.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
}
const tokenRes = new Map();
function tokenRe(roots) {
  const key = roots.join("\n");
  let re = tokenRes.get(key);
  if (!re) {
    const known = [...roots].sort((a, b) => b.length - a.length).map(rootPattern);
    re = new RegExp(String.raw`(?:file:/{2,3})?(?:${[...known, ...GENERIC_PATH].join("|")})${TOKEN_TAIL}${SPACED_TAIL}`, "gi");
    if (tokenRes.size > 32) tokenRes.clear();
    tokenRes.set(key, re);
  }
  re.lastIndex = 0;
  return re;
}
/** The stand-in for one path token: the path inside a worktree or under a repo root, else <host-path>. Trailing sentence punctuation is kept. */
function replaceToken(token, repoRoots) {
  const [, core, punct] = /^([\s\S]*?)([.,;:!?]*)$/.exec(token);
  let p = percentDecode(core).replace(/^file:/i, "").replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  p = p.replace(/^\/([a-z]:\/)/i, "$1").replace(/^\/(?:mnt\/)?([a-z])\//i, "$1:/");
  const wt = /\/worktrees\/[^/]+\/([^/]+)(?:\/(.*))?$/i.exec(p);
  if (wt) return (wt[2] ? wt[2] : `<worktree:${wt[1]}>`) + punct;
  const low = p.toLowerCase();
  for (const r of repoRoots) {
    if (low === r || low === `${r}/`) return "<repo-root>" + punct;
    if (low.startsWith(`${r}/`)) return p.slice(r.length + 1) + punct;
  }
  return "<host-path>" + punct;
}
/** Index of a host path the token pass left behind (the error-text test plus every generic form above), else -1. */
function leftoverIndex(text, roots) {
  const a = hostPathIndex(text, roots);
  const m = LEFTOVER.exec(text);
  const b = m ? m.index : -1;
  return a < 0 ? b : b < 0 ? a : Math.min(a, b);
}

/**
 * `text` with each host-path token replaced and the rest of every line kept (idea-419). A path under a worktree
 * (…/worktrees/<project>/<unit>/rest) or under one of `repoRoots`/rootDir/the server's repo becomes `rest`; any other host
 * path (drive, UNC, any file: URL incl. file://host/ and %3A/%5C/%2F-encoded, Git-Bash /c/, WSL /mnt/c/, /home|/Users/<name>,
 * %LOCALAPPDATA%…, home/tmp/VIBESQUAD_HOME, spaced or multi-spaced segments) becomes <host-path>. A final check swaps anything
 * the token pass missed, so no host path survives.
 */
export function redactHostPathTokens(text, { rootDir = REPO_ROOT, repoRoots = [] } = {}) {
  const t = String(text ?? "");
  const home = slashLower(homedir()).replace(/\/+$/, "");
  // A repo root at or above home (an agent whose cwd is ~) would turn ~/AppData/… into a relative path: such roots are not repos.
  const repo = [...new Set([rootDir, REPO_ROOT, ...repoRoots].filter(Boolean).map((r) => slashLower(r).replace(/\/+$/, "")))].filter((r) => r.length > 3 && !`${home}/`.startsWith(`${r}/`));
  const roots = [...new Set([...hostRoots(rootDir), ...repo])];
  let out = t.replace(tokenRe(roots), (tok) => replaceToken(tok, repo));
  for (let i = 0, at = leftoverIndex(out, roots); at >= 0; i++, at = leftoverIndex(out, roots)) {
    if (i >= 64) return redactErrorText(out, roots);
    const tail = new RegExp(String.raw`^${TOKEN_TAIL}${SPACED_TAIL}`).exec(out.slice(at))[0];
    out = `${out.slice(0, at)}<host-path>${out.slice(at + Math.max(tail.length, 1))}`;
  }
  return out;
}
