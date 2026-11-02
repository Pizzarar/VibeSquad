// Inline edit on a selection (Files editor, Ctrl+K): pure parts. Line-range mapping, the prompt sent
// to the agent, which agents can edit the file, and the snapshot → current diff as block 1 hunks
// (so src/hunkUndo.ts undoHunk can reverse them).

import { fenceFor } from "./attachments.ts";
import { absPath, hunkKey, type Hunk, type HunkLine } from "./hunkUndo.ts";

export type LineRange = { from: number; to: number };

/** Line texts without endings; a trailing newline doesn't start another line. */
export function textLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * 1-based lines covered by a [start, end) character selection. A selection that ends right after a
 * newline (a triple-click or a shift-down run) doesn't include the next line. Empty = the caret's line.
 */
export function lineRangeFromOffsets(content: string, start: number, end: number): LineRange {
  const a = Math.max(0, Math.min(start, end, content.length));
  let b = Math.max(0, Math.min(Math.max(start, end), content.length));
  if (b > a && content[b - 1] === "\n") b--;
  const lineAt = (i: number) => (content.slice(0, i).match(/\n/g) ?? []).length + 1;
  return clampRange({ from: lineAt(a), to: lineAt(b) }, textLines(content).length);
}

/** Orders and clamps two line numbers (from DOM selection endpoints) into the file's range. */
export function clampRange(r: LineRange, lineCount: number): LineRange {
  const max = Math.max(1, lineCount);
  const lo = Math.min(r.from, r.to);
  const hi = Math.max(r.from, r.to);
  return { from: Math.max(1, Math.min(lo, max)), to: Math.max(1, Math.min(hi, max)) };
}

/** The selected lines' text, joined with "\n". */
export const sliceLines = (content: string, r: LineRange): string => textLines(content).slice(r.from - 1, r.to).join("\n");

export const rangeLabel = (r: LineRange): string => (r.from === r.to ? `line ${r.from}` : `lines ${r.from}–${r.to}`);

/** The message sent to the agent. The selection goes in a fence longer than any backtick run inside it. */
export function buildInlineEditPrompt(file: string, r: LineRange, instruction: string, selection: string): string {
  const fence = fenceFor(selection);
  const ask = instruction.trim().replace(/[.\s]+$/, "");
  return `Edit ${file} ${rangeLabel(r)}: ${ask}. Only change those lines unless needed. Here is the current selection:\n${fence}\n${selection}\n${fence}\n`;
}

// ---- which agents can take the edit -------------------------------------------------------------

const norm = (p: string) => {
  const f = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:/.test(f) ? f.toLowerCase() : f; // Windows paths compare case-insensitively
};

/** `abs` relative to `cwd` (forward slashes), or null when it isn't inside it. */
export function relativeTo(cwd: string, abs: string): string | null {
  const c = norm(cwd);
  const a = abs.replace(/\\/g, "/");
  const cmp = /^[a-zA-Z]:/.test(a) ? a.toLowerCase() : a;
  if (!c || !cmp.startsWith(c + "/")) return null;
  return a.slice(c.length + 1);
}

export type EditTarget = { id: string; title: string; rel: string };

type AgentLike = { id: string; cwd?: string | null; title?: string | null; archivedAt?: unknown; status?: string };

/**
 * Live (not archived, not closed) agents whose cwd contains the file (`rel` under `cwd`), each with the path as that agent sees
 * it. `preferId` (the active pane's agent) goes first when it qualifies.
 */
export function editTargets(agents: AgentLike[], cwd: string, rel: string, preferId?: string | null): EditTarget[] {
  const abs = absPath(cwd, rel);
  const out: EditTarget[] = [];
  for (const a of agents) {
    if (a.archivedAt || a.status === "closed" || !a.cwd) continue;
    const r = relativeTo(a.cwd, abs);
    if (r) out.push({ id: a.id, title: a.title || a.id.slice(0, 8), rel: r });
  }
  const i = preferId ? out.findIndex((t) => t.id === preferId) : -1;
  if (i > 0) out.unshift(...out.splice(i, 1));
  return out;
}

// ---- snapshot → current as hunks ----------------------------------------------------------------

type Op = { t: "=" | "-" | "+"; text: string };

// Above this many cells the middle of the diff isn't line-matched, just shown as one replace.
const MAX_LCS_CELLS = 4_000_000;

function editScript(a: string[], b: string[]): Op[] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  const ops: Op[] = a.slice(0, p).map((text) => ({ t: "=", text }));
  const n = am.length;
  const m = bm.length;
  if (n && m && (n + 1) * (m + 1) <= MAX_LCS_CELLS) {
    // L[i][j] = LCS length of am[i:] and bm[j:]; walk forward, removals before additions on ties.
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i * w + j] = am[i] === bm[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push({ t: "=", text: am[i] }); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) ops.push({ t: "-", text: am[i++] });
      else ops.push({ t: "+", text: bm[j++] });
    }
    while (i < n) ops.push({ t: "-", text: am[i++] });
    while (j < m) ops.push({ t: "+", text: bm[j++] });
  } else {
    for (const text of am) ops.push({ t: "-", text });
    for (const text of bm) ops.push({ t: "+", text });
  }
  for (const text of a.slice(a.length - s)) ops.push({ t: "=", text });
  return ops;
}

/** Unified-diff hunks (git numbering, `context` lines around each change) from `before` to `after`. */
export function diffHunks(before: string, after: string, context = 3): Hunk[] {
  const ops = editScript(textLines(before), textLines(after));
  const hunks: Hunk[] = [];
  // Old/new line number before each op.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 0;
  let nn = 0;
  for (const op of ops) {
    oldAt.push(o);
    newAt.push(nn);
    if (op.t !== "+") o++;
    if (op.t !== "-") nn++;
  }
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === "=") { k++; continue; }
    const start = Math.max(0, k - context);
    let end = k; // exclusive; extend while the next change is within 2 * context
    for (;;) {
      while (end < ops.length && ops[end].t !== "=") end++;
      let next = end;
      while (next < ops.length && ops[next].t === "=") next++;
      if (next < ops.length && next - end <= 2 * context) { end = next; continue; }
      end = Math.min(ops.length, end + context);
      break;
    }
    const slice = ops.slice(start, end);
    const oldCount = slice.filter((x) => x.t !== "+").length;
    const newCount = slice.filter((x) => x.t !== "-").length;
    // git: a side with no lines is numbered by the line before it.
    const oldStart = oldCount ? oldAt[start] + 1 : oldAt[start];
    const newStart = newCount ? newAt[start] + 1 : newAt[start];
    const lines: HunkLine[] = [{ type: "header", content: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@` }];
    for (const x of slice) lines.push({ type: x.t === "=" ? "context" : x.t === "-" ? "remove" : "add", content: x.text });
    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
    k = end;
  }
  return hunks;
}

/**
 * Hunk id that survives undoing other hunks: the snapshot side (oldStart) doesn't move when an
 * earlier hunk is reversed, so a kept hunk stays kept while its neighbours change.
 */
export const snapshotHunkKey = (path: string, h: Hunk): string => hunkKey(path, { ...h, newStart: 0 });

/** +added / -removed line counts across hunks. */
export function hunkStats(hunks: Hunk[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of hunks) for (const l of h.lines) l.type === "add" ? add++ : l.type === "remove" && del++;
  return { add, del };
}
