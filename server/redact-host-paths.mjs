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
