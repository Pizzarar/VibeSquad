// Composer @git / @terminal / @chat context sources: pure logic (formatting, caps, ANSI strip, rules discovery
// filter) plus a tiny per-agent store of the picked pills. Node-importable, tested in test/ade-context-sources.test.mjs.

import { useCallback, useSyncExternalStore } from "react";
import { fenceFile } from "./attachments.ts";

export type CtxKind = "git" | "git-base" | "terminal" | "chat";
export type CtxSource = { id: string; kind: CtxKind; label: string; text: string };

export const MAX_DIFF_BYTES = 40 * 1024;
export const TERMINAL_LINES = 200;
export const MAX_TERMINAL_BYTES = 24 * 1024;
export const CHAT_TURNS = 8;
export const MAX_CHAT_BYTES = 16 * 1024;
export const CTX_TIMEOUT_MS = 6000;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "").replace(/\r(?!\n)/g, "");
}

/** Cut `s` to at most `max` characters, with a note saying how much went. Cuts at a line boundary when it can. */
export function truncateWithNote(s: string, max: number, keep: "head" | "tail" = "head"): string {
  if (s.length <= max) return s;
  let cut = keep === "head" ? s.slice(0, max) : s.slice(s.length - max);
  const nl = keep === "head" ? cut.lastIndexOf("\n") : cut.indexOf("\n");
  if (nl > max / 2) cut = keep === "head" ? cut.slice(0, nl) : cut.slice(nl + 1);
  const dropped = s.length - cut.length;
  const note = `[truncated: ${dropped} of ${s.length} characters ${keep === "head" ? "after this point" : "before this point"} omitted]`;
  return keep === "head" ? `${cut}\n${note}` : `${note}\n${cut}`;
}

/** Last `n` lines of terminal output, ANSI stripped, trailing blank lines dropped, byte-capped (keeping the tail). */
export function terminalTail(lines: string[], n = TERMINAL_LINES): string {
  const clean = lines.map((l) => stripAnsi(l).replace(/\s+$/, ""));
  while (clean.length && !clean[clean.length - 1]) clean.pop();
  return truncateWithNote(clean.slice(-n).join("\n"), MAX_TERMINAL_BYTES, "tail");
}

type DiffLine = { type?: string; content?: string };
type DiffFileLike = { path: string; oldPath?: string; isNew?: boolean; isDeleted?: boolean; hunks?: Array<{ lines?: DiffLine[] }> };

/** Daemon diff files → unified-diff-style text, capped at MAX_DIFF_BYTES. Empty string = no changes. */
export function diffToText(files: DiffFileLike[], max = MAX_DIFF_BYTES): string {
  const out: string[] = [];
  for (const f of files) {
    out.push(`--- ${f.isNew ? "/dev/null" : `a/${f.oldPath ?? f.path}`}`);
    out.push(`+++ ${f.isDeleted ? "/dev/null" : `b/${f.path}`}`);
    for (const h of f.hunks ?? []) for (const l of h.lines ?? []) out.push(l.content ?? "");
  }
  return truncateWithNote(out.join("\n"), max, "head");
}

type TimelineItemLike = { type?: string; text?: string };

/** Last `turns` user/assistant messages from timeline entries ({ item } wrappers or bare items), oldest first, capped. */
export function chatExcerpt(entries: Array<{ item?: TimelineItemLike } | TimelineItemLike>, turns = CHAT_TURNS): string {
  const msgs = entries
    .map((e) => ((e as { item?: TimelineItemLike }).item ?? e) as TimelineItemLike)
    .filter((it) => it && (it.type === "user_message" || it.type === "assistant_message") && typeof it.text === "string" && it.text.trim());
  const text = msgs
    .slice(-turns)
    .map((it) => `${it.type === "user_message" ? "User" : "Assistant"}: ${it.text!.trim()}`)
    .join("\n\n");
  return truncateWithNote(text, MAX_CHAT_BYTES, "tail");
}

/** One picked source → the fenced block appended to the prompt. Same `[file: …]` shape as attached files, so the timeline shows it as a chip. */
export function contextBlock(s: Pick<CtxSource, "label" | "text">): string {
  return fenceFile(s.label.replace(/\[/g, "(").replace(/\]/g, ")").replace(/\n/g, " "), s.text || "(empty)");
}

/** Append every picked source to the outgoing text, for every provider. */
export function appendContext(text: string, sources: Array<Pick<CtxSource, "label" | "text">>): string {
  return sources.reduce((out, s) => out + contextBlock(s), text);
}

export const gitLabel = (kind: "git" | "git-base") => (kind === "git" ? "git diff (uncommitted)" : "git diff (vs base branch)");
export const terminalLabel = (name: string, n = TERMINAL_LINES) => `terminal: ${name}, last ${n} lines`;
export const chatLabel = (title: string) => `chat: ${title}`;

// ── @ menu ──────────────────────────────────────────────────────────────────

export type CtxMenuItem = { ctx: true; kind: CtxKind; label: string; hint: string; arg?: string };

/** Which source groups an @ query asks for: "g" → git, "term" → terminal, "ch" → chat. Empty query offers none (files first). */
export function ctxGroupsFor(query: string): Array<"git" | "terminal" | "chat"> {
  const q = query.toLowerCase();
  if (!q || q.includes("/")) return [];
  return (["git", "terminal", "chat"] as const).filter((g) => g.startsWith(q) || q.startsWith(g));
}

export function gitMenuItems(): CtxMenuItem[] {
  return [
    { ctx: true, kind: "git", label: "@git", hint: "working-tree diff (uncommitted)" },
    { ctx: true, kind: "git-base", label: "@git base", hint: "all changes vs the base branch" },
  ];
}

export const isCtxItem = (x: unknown): x is CtxMenuItem => !!x && typeof x === "object" && (x as CtxMenuItem).ctx === true;

// ── Project tab: rules discovery ────────────────────────────────────────────

export const RULES_MAX_DEPTH = 4;
export const RULES_MAX_FILES = 40;
export const RULES_SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".worktrees", "build", "target", ".next", ".venv", "__pycache__"]);

export type RuleGroup = "claude-rules" | "cursor-rules" | "nested";
export const RULE_GROUP_LABEL: Record<RuleGroup, string> = {
  "claude-rules": ".claude/rules",
  "cursor-rules": ".cursor/rules",
  nested: "Nested CLAUDE.md / AGENTS.md",
};
export type RuleFile = { path: string; group: RuleGroup };

/** Which group (if any) a repo-relative path belongs to. Root CLAUDE.md/AGENTS.md are the fixed table's, not nested. */
export function ruleGroupOf(path: string): RuleGroup | null {
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (/^\.claude\/rules\/[^/]+\.(md|mdc|txt)$/i.test(p)) return "claude-rules";
  if (/^\.cursor\/rules\/(?:.+\/)?[^/]+\.(mdc|md)$/i.test(p)) return "cursor-rules";
  if (p.includes("/") && /(^|\/)(CLAUDE|AGENTS)\.md$/.test(p)) return "nested";
  return null;
}

/** Whether the walker should descend into a directory (name relative to its parent, `depth` of the dir below cwd). */
export function shouldDescend(name: string, depth: number): boolean {
  if (depth > RULES_MAX_DEPTH) return false;
  if (RULES_SKIP_DIRS.has(name)) return false;
  return name === ".claude" || name === ".cursor" || !name.startsWith(".");
}

/** Group, de-dupe, sort and cap discovered paths. */
export function collectRuleFiles(paths: string[], max = RULES_MAX_FILES): { files: RuleFile[]; capped: boolean } {
  const seen = new Set<string>();
  const files: RuleFile[] = [];
  for (const raw of paths) {
    const path = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    const group = ruleGroupOf(path);
    if (!group || seen.has(path)) continue;
    seen.add(path);
    files.push({ path, group });
  }
  const order: RuleGroup[] = ["claude-rules", "cursor-rules", "nested"];
  files.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.path.localeCompare(b.path));
  return { files: files.slice(0, max), capped: files.length > max };
}

export const CLAUDE_TEMPLATE = `# CLAUDE.md

Guidance for Claude Code when working in this repo.

## Project
- What this is:
- How to run it:
- How to test it:

## Rules
-
`;

// ── per-agent store of picked pills (Composer adds, AgentDrawer reads on send) ──
const mem = new Map<string, CtxSource[]>();
const subs = new Map<string, Set<() => void>>();
const EMPTY: CtxSource[] = [];
const emit = (k: string) => subs.get(k)?.forEach((f) => f());
let seq = 0;

export const getCtxSources = (key: string): CtxSource[] => mem.get(key) ?? EMPTY;
export function addCtxSource(key: string, s: Omit<CtxSource, "id">) {
  mem.set(key, [...(mem.get(key) ?? []), { ...s, id: `ctx-${Date.now()}-${seq++}` }]);
  emit(key);
}
export function removeCtxSource(key: string, id: string) {
  mem.set(key, (mem.get(key) ?? []).filter((a) => a.id !== id));
  emit(key);
}
export function clearCtxSources(key: string) {
  mem.delete(key);
  emit(key);
}

export function useCtxSources(key: string) {
  const items = useSyncExternalStore(
    useCallback((cb) => {
      const s = subs.get(key) ?? new Set();
      s.add(cb);
      subs.set(key, s);
      return () => void s.delete(cb);
    }, [key]),
    () => mem.get(key) ?? EMPTY,
  );
  return {
    items,
    add: useCallback((s: Omit<CtxSource, "id">) => addCtxSource(key, s), [key]),
    remove: useCallback((id: string) => removeCtxSource(key, id), [key]),
    clear: useCallback(() => clearCtxSources(key), [key]),
  };
}
