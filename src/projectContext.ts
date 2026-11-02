// Project context + @folder: pure logic shared by ProjectPanel, Composer and AgentDrawer.
// Node-importable (no React, no daemon), tested in test/ade-project-context.test.mjs.

export type ProviderFamily = "claude" | "gemini" | "codex" | "opencode" | "other";

/** Map a Paseo provider id (claude, antigravity-cli, gemini, codex, ...) to the family whose CLI reads context files. */
export function providerFamily(provider: string | null | undefined): ProviderFamily {
  const p = String(provider ?? "").toLowerCase();
  if (p.startsWith("claude")) return "claude";
  if (p.includes("gemini") || p.startsWith("antigravity")) return "gemini";
  if (p.startsWith("codex")) return "codex";
  if (p.startsWith("opencode")) return "opencode";
  return "other";
}

export const FAMILY_LABEL: Record<ProviderFamily, string> = {
  claude: "Claude",
  gemini: "Gemini",
  codex: "Codex",
  opencode: "OpenCode",
  other: "Other",
};

export type ContextFile = { path: string; loadedBy: ProviderFamily[]; note?: string };

/** The one provider→file table. VS never injects these; each provider's CLI loads its own. */
export const CONTEXT_FILES: ContextFile[] = [
  { path: "AGENTS.md", loadedBy: ["gemini", "codex", "opencode"] },
  { path: "CLAUDE.md", loadedBy: ["claude"] },
  { path: "GEMINI.md", loadedBy: ["gemini"] },
  { path: ".claude/CLAUDE.md", loadedBy: ["claude"] },
];

/** Context files for a lane: the fixed table plus the lane's brainstorm doc (read by VS agents on request, no provider autoloads it). */
export function contextFilesFor(lane?: string | null): ContextFile[] {
  const l = String(lane ?? "").trim().toLowerCase();
  if (!l || !/^[a-z0-9._-]+$/.test(l)) return CONTEXT_FILES;
  return [...CONTEXT_FILES, { path: `docs/brainstorm/${l}.md`, loadedBy: [], note: "lane brainstorm doc" }];
}

export function isLoadedBy(file: ContextFile, provider: string | null | undefined): boolean {
  return file.loadedBy.includes(providerFamily(provider));
}

export const AGENTS_TEMPLATE = `# AGENTS.md

Instructions for coding agents working in this repo.

## Project
- What this is:
- How to run it:
- How to test it:

## Rules
-
`;

// ── @folder ─────────────────────────────────────────────────────────────────

export type MentionEntry = { path: string; kind: "file" | "directory" };

/** Text inserted when picking an @ menu entry: folders get a trailing slash. */
export function mentionInsertText(e: MentionEntry): string {
  const p = e.path.replace(/\/+$/, "");
  return e.kind === "directory" ? `@${p}/ ` : `@${p} `;
}

/** Label shown in the @ menu. */
export function mentionLabel(e: MentionEntry): string {
  return e.kind === "directory" ? `📁 @${e.path.replace(/\/+$/, "")}/` : `@${e.path}`;
}

/** Entries matching the @ query, folders first so `@docs` offers `docs/` before files inside it. */
export function filterMentionEntries(entries: MentionEntry[], query: string): MentionEntry[] {
  const q = query.toLowerCase().replace(/\/+$/, "");
  const hit = entries.filter((e) => e.path.toLowerCase().includes(q));
  return [...hit.filter((e) => e.kind === "directory"), ...hit.filter((e) => e.kind !== "directory")].slice(0, 8);
}

/** `@https://…` is a URL mention: inserted as-is, never fetched by VS. */
export function isUrlMention(query: string): boolean {
  return /^https?:\/\/\S+/i.test(query);
}

export function urlMentions(text: string): string[] {
  return [...text.matchAll(/(^|\s)@(https?:\/\/\S+)/gi)].map((m) => m[2]);
}

/** Folder to list for an @ query when fuzzy suggestions are slow: "doc" → "", "docs/ar" → "docs", "docs/" → "docs". */
export function parentDirOf(query: string): string {
  const q = query.replace(/\\/g, "/");
  const i = q.lastIndexOf("/");
  return i < 0 ? "" : q.slice(0, i).replace(/\/+$/, "");
}

/** Filter one folder's listing by the last segment of the @ query (prefix matches first). */
export function filterListing(entries: MentionEntry[], query: string): MentionEntry[] {
  const leaf = query.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  const name = (e: MentionEntry) => (e.path.split("/").pop() ?? "").toLowerCase();
  const hits = entries.filter((e) => name(e).includes(leaf) && name(e) !== ".git");
  const pre = hits.filter((e) => name(e).startsWith(leaf));
  return filterMentionEntries([...pre, ...hits.filter((e) => !pre.includes(e))], "");
}

export const LIST_TIMEOUT_MS = 4000;

/** Resolve `p` or, after `ms`, the fallback. A slow or hung daemon call never blocks the caller. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<{ value: T; timedOut: boolean }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ value: fallback, timedOut: true }), ms);
    p.then(
      (value) => {
        clearTimeout(t);
        resolve({ value, timedOut: false });
      },
      () => {
        clearTimeout(t);
        resolve({ value: fallback, timedOut: true });
      },
    );
  });
}

/** `@path/` tokens in a message (at start or after whitespace). Absolute and `..` paths are skipped. */
export function folderMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(^|\s)@([^\s@]+)\/(?=\s|$)/g)) {
    const p = m[2];
    if (/^(https?:|[a-z]:|\/)/i.test(p) || p.split("/").includes("..")) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Whether a provider resolves `@dir/` itself. Probed 2026-11-02 with throwaway agents sent
 * "@docs/ list the files in that folder". false = VS expands on send.
 * - claude: Claude Code attaches an ls-style listing itself; the agent answered with no tool call.
 * - gemini (antigravity-cli): the token arrives as plain text; the agent had to run Get-ChildItem.
 * - codex/opencode/other: not probed, so expand (a redundant line is harmless; a missing one isn't).
 */
export const FOLDER_NATIVE: Record<ProviderFamily, boolean> = {
  claude: true,
  gemini: false,
  codex: false,
  opencode: false,
  other: false,
};

export function shouldExpandFolders(provider: string | null | undefined): boolean {
  return !FOLDER_NATIVE[providerFamily(provider)];
}

export const MAX_LISTED = 40;

/** One short line per folder: "Folder: path/ (N files): a, b/, c". `entries` null = couldn't list. */
export function folderLine(path: string, entries: MentionEntry[] | null): string {
  if (!entries) return `Folder: ${path}/ (couldn't list)`;
  const names = entries.map((e) => {
    const n = e.path.replace(/\/+$/, "").split("/").pop() ?? e.path;
    return e.kind === "directory" ? `${n}/` : n;
  });
  const files = entries.filter((e) => e.kind === "file").length;
  const shown = names.slice(0, MAX_LISTED).join(", ");
  const more = names.length > MAX_LISTED ? `, … +${names.length - MAX_LISTED} more` : "";
  return `Folder: ${path}/ (${files} file${files === 1 ? "" : "s"}${names.length > files ? `, ${names.length - files} folder${names.length - files === 1 ? "" : "s"}` : ""}): ${shown}${more}`;
}

/**
 * Expand-on-send: for providers that ignore `@dir/`, keep the user's text and append one
 * "Folder: …" line per folder token. Each listing is time-boxed so sending never hangs.
 */
export async function expandFolderMentions(
  text: string,
  provider: string | null | undefined,
  list: (path: string) => Promise<MentionEntry[]>,
  ms = LIST_TIMEOUT_MS,
): Promise<string> {
  if (!shouldExpandFolders(provider)) return text;
  const dirs = folderMentions(text);
  if (!dirs.length) return text;
  const lines = await Promise.all(
    dirs.map(async (d) => {
      const r = await withTimeout(list(d), ms, null as MentionEntry[] | null);
      return folderLine(d, r.value);
    }),
  );
  return `${text}\n\n${lines.join("\n")}`;
}
