import { useCallback, useSyncExternalStore } from "react";

// Non-image files staged in the composer. They are chips only: the draft text is never touched.
// On send, composeMessage() turns them into fenced blocks (small text) or uploaded path references.

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

export function fenceFile(name: string, content: string): string {
  const fence = content.includes("```") ? "~~~~" : "```";
  return `\n[file: ${name}]\n${fence}\n${content}\n${fence}\n`;
}

export function attachedRef(path: string): string {
  return `\n[attached file: ${path}]\n`;
}

/** Build the outgoing text. `upload` is only called for files that are big or binary. */
export async function composeMessage(
  text: string,
  items: Array<{ name: string; size: number; file: Pick<File, "text" | "arrayBuffer"> }>,
  upload: (item: { name: string; file: never }) => Promise<string>,
): Promise<string> {
  let out = text;
  for (const it of items) {
    const head = new Uint8Array(await it.file.arrayBuffer());
    if (it.size <= MAX_INLINE_BYTES && !isBinaryBytes(head)) {
      out += fenceFile(it.name, await it.file.text());
    } else {
      out += attachedRef(await upload({ name: it.name, file: it.file as never }));
    }
  }
  return out;
}

const BLOCK_RE = /\n?\[file: ([^\]\n]+)\]\n(```|~~~~)\n[\s\S]*?\n\2\n?/g;
const REF_RE = /\n?\[attached file: ([^\]\n]+)\]\n?/g;

/** Split a sent message back into its text and attachment chips (for the timeline). */
export function parseSentAttachments(text: string): { body: string; chips: SentChip[] } {
  const chips: SentChip[] = [];
  let body = text.replace(BLOCK_RE, (_m, name: string) => {
    chips.push({ name });
    return "";
  });
  body = body.replace(REF_RE, (_m, path: string) => {
    chips.push({ name: path.split(/[\/]/).pop() || path, path });
    return "";
  });
  return { body: chips.length ? body.replace(/\s+$/, "") : text, chips };
}

// ── tiny per-agent store so Composer and AgentDrawer share the staged list ──
const mem = new Map<string, Attachment[]>();
const subs = new Map<string, Set<() => void>>();
const EMPTY: Attachment[] = [];
const emit = (k: string) => subs.get(k)?.forEach((f) => f());
let seq = 0;

export const getAttachments = (key: string): Attachment[] => mem.get(key) ?? EMPTY;

export function addAttachments(key: string, files: File[]) {
  const add = files.map((f) => ({ id: `${f.name}-${Date.now()}-${seq++}`, name: f.name, size: f.size, file: f }));
  mem.set(key, [...(mem.get(key) ?? []), ...add]);
  emit(key);
}
export function removeAttachment(key: string, id: string) {
  mem.set(key, (mem.get(key) ?? []).filter((a) => a.id !== id));
  emit(key);
}
export function clearAttachments(key: string) {
  mem.delete(key);
  emit(key);
}

export function useAttachments(key: string) {
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
    add: useCallback((f: File[]) => addAttachments(key, f), [key]),
    remove: useCallback((id: string) => removeAttachment(key, id), [key]),
    clear: useCallback(() => clearAttachments(key), [key]),
  };
}

// The timeline only knows the agent id; the drawer registers its cwd so chips can open in the Files dock.
const cwds = new Map<string, string>();
export function setAgentCwd(id: string, cwd: string | undefined) {
  if (cwd) cwds.set(id, cwd);
}
export function repoPathFor(agentId: string, p: string): string | null {
  const norm = p.split("\\").join("/");
  const base = (cwds.get(agentId) ?? "").split("\\").join("/").replace(/\/$/, "");
  const rel = base && norm.startsWith(base + "/") ? norm.slice(base.length + 1) : norm;
  return rel.startsWith("/") || /^[A-Za-z]:/.test(rel) ? null : rel;
}
