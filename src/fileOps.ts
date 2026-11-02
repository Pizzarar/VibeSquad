// Dependency-free helpers for file-tree ops (create / rename / delete) and terminal capture.

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Returns an error message, or null when `name` is a legal single path segment. */
export function validateEntryName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Name is required";
  if (n === "." || n === "..") return "Name can't be . or ..";
  if (/[\\/]/.test(n)) return "Name can't contain / or \\";
  if (/[<>:"|?*\x00-\x1f]/.test(n)) return "Name has characters that aren't allowed";
  if (/[. ]$/.test(n)) return "Name can't end with a dot or space";
  if (WIN_RESERVED.test(n)) return "That name is reserved on Windows";
  if (n.length > 255) return "Name is too long";
  return null;
}

/** Parent directory of a repo-relative path ("" = repo root). */
export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(parent: string, name: string): string {
  return parent ? `${parent.replace(/\/+$/, "")}/${name}` : name;
}

/** True when `name` collides (case-insensitively) with a sibling other than `except`. */
export function nameTaken(siblings: string[], name: string, except?: string): boolean {
  const lc = name.trim().toLowerCase();
  return siblings.some((s) => s !== except && s.toLowerCase() === lc);
}

/** Terminal capture lines -> text with a single trailing newline, trailing blank lines trimmed. */
export function captureText(lines: string[]): string {
  const out = lines.slice();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.length ? out.join("\n") + "\n" : "";
}

/** Safe file name for a saved capture, e.g. "terminal-build-20261102-1405.txt". */
export function captureFileName(title: string, now: Date): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "capture";
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  return `terminal-${slug}-${stamp}.txt`;
}

/** Remap `p` after `oldPath` was renamed to `newPath` (covers `p` inside a renamed folder). */
export function remapPath(p: string, oldPath: string, newPath: string): string {
  if (p === oldPath) return newPath;
  return p.startsWith(`${oldPath}/`) ? newPath + p.slice(oldPath.length) : p;
}

/** True when `p` is `base` or lives under it. */
export function isUnder(p: string, base: string): boolean {
  return p === base || p.startsWith(`${base}/`);
}
