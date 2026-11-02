// Per-hunk undo for the Changes panel: reverse one diff hunk against the file's current text.
// The daemon's parsed diff strips the +/-/space prefix and drops "\ No newline" markers, so
// line endings and the end-of-file newline are taken from the current file, never the diff.

export type HunkLine = { type: string; content: string };
export type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: HunkLine[] };
export type UndoResult = { ok: true; content: string; at: number } | { ok: false; error: string };

const STALE = "The file changed since this diff was taken, so the hunk no longer applies cleanly. Refresh Changes and try again.";

const strip = (s: string) => (s.endsWith("\r") ? s.slice(0, -1) : s);

/** The lines a hunk expects on its new (current) side and the ones it replaced. */
export function hunkSides(h: Hunk): { now: string[]; was: string[] } {
  const now: string[] = [];
  const was: string[] = [];
  for (const l of h.lines) {
    if (l.type === "header") continue;
    const text = strip(l.content);
    if (l.type !== "remove") now.push(text);
    if (l.type !== "add") was.push(text);
  }
  return { now, was };
}

/** Splits into line texts plus each line's own ending ("" on a final line with no newline). */
function splitLines(content: string): { text: string[]; eol: string[] } {
  const text: string[] = [];
  const eol: string[] = [];
  const rx = /\r?\n/g;
  let last = 0;
  for (let m = rx.exec(content); m; m = rx.exec(content)) {
    text.push(content.slice(last, m.index));
    eol.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < content.length) { text.push(content.slice(last)); eol.push(""); }
  return { text, eol };
}

/** CRLF when most of the file's line endings are CRLF, else LF. */
export function dominantEol(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

const matchesAt = (text: string[], at: number, want: string[]) =>
  at >= 0 && at + want.length <= text.length && want.every((w, i) => text[at + i] === w);

/**
 * Reverses `hunk` in `content`. `lineOffset` is how far earlier undos in the same file moved its
 * lines. The hunk's current side must match exactly where it should be; if it doesn't, a single
 * exact match elsewhere is accepted (the file shifted). Anything else is refused, never guessed.
 */
export function undoHunk(content: string, hunk: Hunk, lineOffset = 0): UndoResult {
  const { now, was } = hunkSides(hunk);
  const { text, eol } = splitLines(content);
  const expected = (hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1) + lineOffset;

  let at = -1;
  if (now.length === 0) {
    // Pure deletion with no context: only the position can be checked.
    if (hunk.newStart === 0 && text.length > 0 && lineOffset === 0) return { ok: false, error: STALE };
    if (expected >= 0 && expected <= text.length) at = expected;
  } else if (matchesAt(text, expected, now)) {
    at = expected;
  } else {
    const hits: number[] = [];
    for (let i = 0; i + now.length <= text.length && hits.length < 2; i++) if (matchesAt(text, i, now)) hits.push(i);
    if (hits.length === 1) at = hits[0];
  }
  if (at < 0) return { ok: false, error: STALE };

  const nl = content ? dominantEol(content) : "\n";
  const end = at + now.length;
  // The replaced run keeps the ending of its own last line, so a file with no final newline keeps none.
  const tailEol = now.length ? eol[end - 1] : at < text.length ? nl : at > 0 ? eol[at - 1] : nl;
  const outText = [...text.slice(0, at), ...was, ...text.slice(end)];
  const outEol = [...eol.slice(0, at), ...was.map((_, i) => (i === was.length - 1 ? tailEol : nl)), ...eol.slice(end)];
  // Appending after a last line that had no newline: that line now needs one.
  if (now.length === 0 && was.length && at === text.length && at > 0 && eol[at - 1] === "") {
    outEol[at - 1] = nl;
    outEol[at + was.length - 1] = "";
  }
  return { ok: true, content: outText.map((t, i) => t + outEol[i]).join(""), at };
}

/** Undo several hunks of one file at once, bottom-up so earlier positions stay valid. */
export function undoHunks(content: string, hunks: Hunk[]): UndoResult {
  let cur = content;
  let at = 0;
  for (const h of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
    const r = undoHunk(cur, h);
    if (!r.ok) return r;
    cur = r.content;
    at = r.at;
  }
  return { ok: true, content: cur, at };
}

/** How many lines undoing `hunk` adds (+) or removes (-) from the file. */
export const undoDelta = (h: Hunk): number => {
  const { now, was } = hunkSides(h);
  return was.length - now.length;
};

/** Stable id for a hunk in one file: same text at the same place = same hunk across diff refreshes. */
export function hunkKey(path: string, h: Hunk): string {
  const body = h.lines.filter((l) => l.type !== "header").map((l) => (l.type === "add" ? "+" : l.type === "remove" ? "-" : " ") + l.content).join("\n");
  let hash = 5381;
  for (let i = 0; i < body.length; i++) hash = ((hash << 5) + hash + body.charCodeAt(i)) | 0;
  return `${path}@${h.oldStart},${h.newStart}#${(hash >>> 0).toString(36)}`;
}

// ---- open in IDE --------------------------------------------------------------------------------

export type IdeChoice = "none" | "vscode" | "jetbrains";

const fwd = (p: string) => p.replace(/\\/g, "/");

/** Joins a workspace cwd and a repo-relative path, keeping the cwd's style. */
export function absPath(cwd: string, rel: string): string {
  if (/^([a-zA-Z]:[\\/]|\/)/.test(rel)) return rel;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return cwd.replace(/[\\/]+$/, "") + sep + rel.replace(/^[\\/]+/, "").replace(/[\\/]/g, sep);
}

/**
 * vscode://file/<abs>:<line> (forward slashes, drive letter kept), or a JetBrains Toolbox link
 * jetbrains://idea/navigate/reference?project=<cwd folder name>&path=<rel>:<line>.
 */
export function ideUrl(ide: IdeChoice, cwd: string, rel: string, line?: number): string | null {
  const ln = line && line > 0 ? `:${line}` : "";
  if (ide === "vscode") {
    const abs = fwd(absPath(cwd, rel));
    return `vscode://file/${encodeURI(abs.replace(/^\//, ""))}${ln}`;
  }
  if (ide === "jetbrains") {
    const project = fwd(cwd).replace(/\/+$/, "").split("/").pop() ?? "";
    const relFwd = fwd(rel).replace(/^\/+/, "");
    return `jetbrains://idea/navigate/reference?project=${encodeURIComponent(project)}&path=${encodeURIComponent(relFwd).replace(/%2F/g, "/")}${ln}`;
  }
  return null;
}

/** New-side line number of the hunk's first added or removed line (where an IDE should land). */
export function firstChangedLine(h: Hunk): number {
  let n = h.newStart;
  for (const l of h.lines) {
    if (l.type === "header") continue;
    if (l.type !== "context") return Math.max(1, n);
    n++;
  }
  return Math.max(1, h.newStart);
}

/** IDE links open on this machine, so they only make sense when the UI is served from the daemon host. */
export const clientOnDaemonHost = (hostname: string): boolean =>
  ["localhost", "127.0.0.1", "[::1]", "::1", "tauri.localhost"].includes(hostname.toLowerCase());

/** Rebuilds unified-diff text from parsed files, capped at `max` chars (for an agent prompt). */
export function diffAsText(files: { path: string; hunks: Hunk[] }[], max = 40_000): { text: string; truncated: boolean } {
  let out = "";
  for (const f of files) {
    const part = [`--- a/${f.path}`, `+++ b/${f.path}`, ...f.hunks.flatMap((h) => h.lines.map((l) => (l.type === "header" ? l.content : (l.type === "add" ? "+" : l.type === "remove" ? "-" : " ") + l.content)))].join("\n") + "\n";
    if (out.length + part.length > max) return { text: out, truncated: true };
    out += part;
  }
  return { text: out, truncated: false };
}
