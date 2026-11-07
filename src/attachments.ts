import { useCallback, useSyncExternalStore } from "react";
import { normalizeRepoPath } from "./fileLinks.ts";

// Non-image files staged in the composer. They are chips only: the draft text is never touched.
// On send, composeMessage() inlines them as fenced blocks (small text). Large/binary files are
// rejected at drop time (no upload route).

export const MAX_INLINE_BYTES = 100 * 1024;

export type Attachment = { id: string; name: string; size: number; file: File };
export type SentChip = { name: string; path?: string };

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function isBinaryBytes(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export function isImageFile(f: { type: string }): boolean {
  return f.type.startsWith("image/");
}

export function partitionFiles<T extends { type: string; size: number }>(files: T[]) {
  const images: T[] = [];
  const text: T[] = [];
  const tooLarge: T[] = [];
  for (const f of files) {
    if (isImageFile(f)) images.push(f);
    else if (f.size > MAX_INLINE_BYTES) tooLarge.push(f);
    else text.push(f);
  }
  return { images, text, tooLarge };
}

/** Route dropped/pasted/picked files: images to thumbnails, small text to chips; large/binary are rejected (no upload route). */
export async function stageFiles(
  all: File[],
  imgs: { add: (f: File[]) => void },
  atts: { add: (f: File[]) => void },
): Promise<string | null> {
  const { images, text, tooLarge } = partitionFiles(all);
  const rejected = tooLarge.map((f) => f.name);
  const ok: File[] = [];
  for (const f of text) {
    const head = new Uint8Array(await f.slice(0, 8192).arrayBuffer());
    if (isBinaryBytes(head)) rejected.push(f.name);
    else ok.push(f);
  }
  if (images.length) imgs.add(images);
  if (ok.length) atts.add(ok);
  return rejected.length ? `Too large / binary — attach a path instead: ${rejected.join(", ")}` : null;
}

export const longestBacktickRun = (content: string): number => Math.max(0, ...(content.match(/`+/g) ?? []).map((r) => r.length));

/** A code fence longer than any backtick run inside `content`, so the parser can find the matching opener. */
export const fenceFor = (content: string): string => "`".repeat(Math.max(3, longestBacktickRun(content) + 1));

export function fenceFile(name: string, content: string): string {
  const fence = fenceFor(content);
  return `\n[file: ${name}]\n${fence}\n${content}\n${fence}\n`;
}

/** Inline small text files into the outgoing text. Large/binary files are rejected at drop time, so they never reach here. */
export async function composeMessage(
  text: string,
  items: Array<{ name: string; size: number; file: Pick<File, "text" | "arrayBuffer"> }>,
): Promise<string> {
  let out = text;
  for (const it of items) {
    out += fenceFile(it.name, await it.file.text());
  }
  return out;
}

const REF_TAIL_RE = /\n\[attached file: ([^\]\n]+)\]\n$/;
const FENCE_TAIL_RE = /\n(`{3,})\n$/;
const HEAD_RE = /\n\[file: ([^\]\n]+)\]$/;

/**
 * Split a sent message back into its text and attachment chips (for the timeline).
 * Only the trailing suffix composeMessage emits is parsed, so the same markers in ordinary text are left alone.
 */
export function parseSentAttachments(text: string): { body: string; chips: SentChip[] } {
  const chips: SentChip[] = [];
  let rest = text;
  for (;;) {
    const ref = REF_TAIL_RE.exec(rest);
    if (ref) {
      chips.push({ name: ref[1].split(/[\\/]/).pop() || ref[1], path: ref[1] });
      rest = rest.slice(0, ref.index);
      continue;
    }
    const close = FENCE_TAIL_RE.exec(rest);
    if (!close) break;
    const fence = close[1];
    const open = rest.lastIndexOf("\n" + fence + "\n", close.index - 1);
    if (open < 0) break;
    const head = HEAD_RE.exec(rest.slice(0, open));
    if (!head) break;
    chips.push({ name: head[1] });
    rest = rest.slice(0, head.index);
  }
  return { body: chips.length ? rest.replace(/\s+$/, "") : text, chips: chips.reverse() };
}

// ── tiny per-agent store so Composer and AgentDrawer share the staged list + a rejection notice ──
type AttachmentStore = { items: Attachment[]; notice: string | null };
const mem = new Map<string, AttachmentStore>();
const subs = new Map<string, Set<() => void>>();
const EMPTY_STORE: AttachmentStore = { items: [], notice: null };
const emit = (k: string) => subs.get(k)?.forEach((f) => f());
let seq = 0;

export const getAttachments = (key: string): Attachment[] => (mem.get(key) ?? EMPTY_STORE).items;

export const getAttachmentNotice = (key: string): string | null => (mem.get(key) ?? EMPTY_STORE).notice;

export function addAttachments(key: string, files: File[]) {
  const add = files.map((f) => ({ id: `${f.name}-${Date.now()}-${seq++}`, name: f.name, size: f.size, file: f }));
  const cur = mem.get(key) ?? EMPTY_STORE;
  mem.set(key, { items: [...cur.items, ...add], notice: null }); // a valid attach clears the rejection notice
  emit(key);
}
export function removeAttachment(key: string, id: string) {
  const cur = mem.get(key) ?? EMPTY_STORE;
  mem.set(key, { ...cur, items: cur.items.filter((a) => a.id !== id) });
  emit(key);
}
export function clearAttachments(key: string) {
  mem.delete(key);
  emit(key);
}

export function setAttachmentNotice(key: string, notice: string | null) {
  const cur = mem.get(key) ?? EMPTY_STORE;
  mem.set(key, { ...cur, notice });
  emit(key);
}

export function useAttachments(key: string) {
  const store = useSyncExternalStore(
    useCallback((cb) => {
      const s = subs.get(key) ?? new Set();
      s.add(cb);
      subs.set(key, s);
      return () => void s.delete(cb);
    }, [key]),
    () => mem.get(key) ?? EMPTY_STORE,
  );
  return {
    items: store.items,
    notice: store.notice,
    add: useCallback((f: File[]) => addAttachments(key, f), [key]),
    remove: useCallback((id: string) => removeAttachment(key, id), [key]),
    clear: useCallback(() => clearAttachments(key), [key]),
    setNotice: useCallback((n: string | null) => setAttachmentNotice(key, n), [key]),
  };
}

// The timeline only knows the agent id; the drawer registers its cwd so chips can open in the Files dock.
const cwds = new Map<string, string>();
export function setAgentCwd(id: string, cwd: string | undefined) {
  if (cwd) cwds.set(id, cwd);
}
export function getAgentCwd(id: string): string | undefined {
  return cwds.get(id);
}
export function repoPathFor(agentId: string, p: string): string | null {
  const norm = p.split("\\").join("/");
  const base = (cwds.get(agentId) ?? "").split("\\").join("/").replace(/\/$/, "");
  // Windows drive letters / paths are case-insensitive.
  const ci = /^[A-Za-z]:/.test(base) || /^[A-Za-z]:/.test(norm);
  const inside = base && (ci ? norm.toLowerCase().startsWith(base.toLowerCase() + "/") : norm.startsWith(base + "/"));
  return normalizeRepoPath(inside ? norm.slice(base.length + 1) : norm);
}
