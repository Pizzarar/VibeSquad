// Detects repo-path tokens in chat text so they can open in the Files dock.

export type FileTarget = { path: string; line: number | null; isDir: boolean };

const PATH_CHARS = /^[\w.\-\/\\]+$/;
const EXT = /\.[A-Za-z][A-Za-z0-9]{0,5}$/;

/** Parse a token as a repo path (`dir/file.ext`, `dir/file.ext:12`, `dir/file.ext#L12`, `dir/`), or null. */
export function parseFileToken(raw: string): FileTarget | null {
  let s = raw.trim();
  if (!s || /\s/.test(s) || s.includes("://") || s.startsWith("@")) return null;
  let line: number | null = null;
  const lm = /(?::|#L)(\d+)$/.exec(s);
  if (lm) {
    line = parseInt(lm[1], 10);
    s = s.slice(0, lm.index);
  }
  if (!PATH_CHARS.test(s)) return null;
  const path = s.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
  if (!path || path.startsWith("/")) return null;
  if (path.endsWith("/")) {
    if (line !== null || !/[\w]/.test(path)) return null;
    return { path: path.replace(/\/+$/, ""), line: null, isDir: true };
  }
  if (!path.includes("/")) return null;
  const last = path.slice(path.lastIndexOf("/") + 1);
  if (!EXT.test(last)) return null;
  return { path, line, isDir: false };
}

/** Bare (unquoted) path matcher used by renderInline; every hit is still validated by parseFileToken. */
export const BARE_PATH_RE = /(?<![\w@.\/\x5c:#-])((?:[\w.\-]+[\/\x5c])+(?:[\w.\-]*[\w\/])?)/g;

/** Targets that renderInline would linkify as bare paths in `text` (path:line forms are handled by the older patterns). */
export function bareFileTargets(text: string): FileTarget[] {
  const out: FileTarget[] = [];
  for (const m of text.matchAll(new RegExp(BARE_PATH_RE.source, "g"))) {
    const t = parseFileToken(m[1]);
    if (t) out.push(t);
  }
  return out;
}
