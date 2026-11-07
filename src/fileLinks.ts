// Detects repo-path tokens in chat text so they can open in the Files dock.
// Every chat path goes through parseFileToken; nothing links without passing it.

export type FileTarget = { path: string; line: number | null; isDir: boolean };

/** `backticked`: the token came from inline code, so folders and root files (`README.md:10`) may link. */
export type ParseOpts = { backticked?: boolean };

const PATH_CHARS = /^[\w.\-\/\x5c]+$/;
const EXT = /\.[A-Za-z][A-Za-z0-9]{0,5}$/;
const LINE_SUFFIX = /(?::|#L)(\d+)(?:-L?\d+)?$/;
// A folder link needs a recognisable top-level dir; `and/or/` and `2026/11/` are prose.
const KNOWN_TOP_DIRS = new Set([
  "src", "docs", "doc", "test", "tests", "scratch", "server", "scripts", "public", "cli", "plugin", "plugins",
  "lib", "dist", "build", "assets", "app", "packages", "tools", "examples", "src-tauri", "node_modules",
]);

/**
 * Normalise a repo-relative path (backslashes, leading `./`) and confine it to the repo:
 * absolute paths, drive letters, `~` and any `..` segment are rejected. Returns null if unsafe.
 */
export function normalizeRepoPath(raw: string): string | null {
  const p = raw.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
  if (!p || p.startsWith("/") || p.startsWith("~") || /^[A-Za-z]:/.test(p)) return null;
  if (p.split("/").some((seg) => seg === "..")) return null;
  return p;
}

/** Parse a token as a repo path (`dir/file.ext[:12|:12-20|#L12]`, or `dir/` when backticked), or null. */
export function parseFileToken(raw: string, opts: ParseOpts = {}): FileTarget | null {
  let s = raw.trim();
  if (!s || /\s/.test(s) || s.includes("://") || s.startsWith("@")) return null;
  let line: number | null = null;
  const lm = LINE_SUFFIX.exec(s);
  if (lm) {
    line = parseInt(lm[1], 10);
    s = s.slice(0, lm.index);
  }
  if (!PATH_CHARS.test(s)) return null;
  const path = normalizeRepoPath(s);
  if (!path) return null;
  if (path.endsWith("/")) {
    if (!opts.backticked || line !== null) return null;
    const segs = path.split("/").filter(Boolean);
    if (!segs.length || !segs.every((g) => /[A-Za-z]/.test(g))) return null;
    if (!KNOWN_TOP_DIRS.has(segs[0]) && !segs[0].startsWith(".")) return null;
    return { path: segs.join("/"), line: null, isDir: true };
  }
  if (!path.includes("/") && !opts.backticked) return null;
  const last = path.slice(path.lastIndexOf("/") + 1);
  if (!EXT.test(last)) return null;
  return { path, line, isDir: false };
}

/** Bare (unquoted) path matcher used by renderInline; every hit is still validated by parseFileToken. */
export const BARE_PATH_RE = /(?<![\w@.\/\x5c:#~-])((?:[\w.\-]+[\/\x5c])+(?:[\w.\-]*[\w\/])?)/g;

/** Targets that renderInline would linkify as bare paths in `text` (path:line forms use the older patterns). */
export function bareFileTargets(text: string): FileTarget[] {
  const out: FileTarget[] = [];
  for (const m of text.matchAll(new RegExp(BARE_PATH_RE.source, "g"))) {
    const t = parseFileToken(m[1]);
    if (t) out.push(t);
  }
  return out;
}

// ── pending open request (clicks made while the dock is closed) ──────────────────

export const PENDING_TTL_MS = 2000;
export type PendingOpen = { tab: string; filePath: string; line?: number; nonce: number; at: number };

/** Only a Files target with a file/folder is worth keeping; anything else is dropped. */
export function makePending(
  tab: string, opts: { filePath?: string; line?: number } | undefined, nonce: number, now = Date.now(),
): PendingOpen | null {
  if (tab !== "Files" || !opts?.filePath) return null;
  return { tab, filePath: opts.filePath, line: opts.line, nonce, at: now };
}

/** Returns the pending request if it is still fresh, else null. */
export function claimPending(p: PendingOpen | null, now = Date.now()): PendingOpen | null {
  return p && now - p.at <= PENDING_TTL_MS ? p : null;
}

// ── bare filenames (no folder) ───────────────────────────────────────────────────
// `pingrid-menu-500.png` only becomes a link if the repo has exactly one file with that name;
// the VS server answers (GET /__vibesquad/fs/resolve) and results are cached per agent.

const BARE_NAME_EXT = /\.(png|jpe?g|gif|webp|svg|md|mdx|txt|json|ts|tsx|js|jsx|mjs|cjs|css|html|rs|toml|ya?ml|py|sh|ps1|pdf|csv|cfg|ini|gd|tscn|mp4|mp3|wav)$/i;
/** Bare filename candidate regex (renderInline); each hit is still checked by isBareNameCandidate + the server. */
export const BARE_NAME_RE = /(?<![\w@.\/\x5c:#~-])(\w[\w.\-]*\.[A-Za-z][A-Za-z0-9]{0,5})(?![\w\/\x5c])/g;

export function isBareNameCandidate(name: string): boolean {
  return !name.includes("/") && !name.includes("\\") && BARE_NAME_EXT.test(name);
}

type Resolved = string | null | undefined; // undefined = not asked yet / in flight
const resolved = new Map<string, string | null>();
const inflight = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
export const subscribeBareNames = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };
export const bareNamesVersion = () => version;

/** Cached repo path for a bare name (null = zero or several matches); kicks off the lookup on first sight. */
export function lookupBareName(agentId: string | undefined, name: string, fetcher: typeof fetch = fetch): Resolved {
  if (!agentId || !isBareNameCandidate(name)) return null;
  const key = `${agentId}\0${name}`;
  if (resolved.has(key)) return resolved.get(key);
  if (!inflight.has(key)) {
    inflight.add(key);
    fetcher(`/__vibesquad/fs/resolve?agentId=${encodeURIComponent(agentId)}&name=${encodeURIComponent(name)}`)
      .then((r) => r.json())
      .then((j) => resolved.set(key, j?.ok && typeof j.path === "string" ? j.path : null))
      .catch(() => resolved.set(key, null))
      .finally(() => { inflight.delete(key); version++; listeners.forEach((l) => l()); });
  }
  return undefined;
}
export const _resetBareNames = () => { resolved.clear(); inflight.clear(); };
