// Pure helpers for the side terminal (TerminalPanel): shell-ended notices, paste/copy key tests, and an ordered input sender.

/** What the pane prints when its shell ends. A server restart kills every terminal it owns (idea-698), so say that. */
export function exitNotice(code: number | null, reason?: string): string {
  if (reason === "server-restart") {
    return "\r\n[terminal ended: the VibeSquad server restarted and closed this shell. Open a new terminal. Whatever it was running was stopped: check for leftovers (e.g. a held apt/dpkg lock).]\r\n";
  }
  return `\r\n[process exited${code == null ? "" : ` with code ${code}`}]\r\n`;
}
export const LOST_NOTICE =
  "\r\n[connection to the terminal was lost: the VibeSquad server probably restarted, which ends its shells. Open a new terminal.]\r\n";

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">;

/** Ctrl+V, Ctrl+Shift+V, Cmd+V, Shift+Insert: the browser's native paste event should handle these, not a ^V byte. */
export function isPasteKey(e: KeyLike): boolean {
  const k = e.key.toLowerCase();
  if (k === "insert") return e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
  return k === "v" && (e.ctrlKey || e.metaKey) && !e.altKey;
}
/** Ctrl+C / Ctrl+Shift+C / Cmd+C copy only when something is selected; otherwise Ctrl+C stays SIGINT. */
export function isCopyKey(e: KeyLike, hasSelection: boolean): boolean {
  if (e.key.toLowerCase() !== "c" || e.altKey) return false;
  if (e.metaKey) return hasSelection;
  return e.ctrlKey && hasSelection;
}

/** Async clipboard read; rejects when the page is not a secure context (plain http LAN) or permission is denied. */
export async function readClipboardText(): Promise<string> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.readText) throw new Error("clipboard API unavailable");
  return navigator.clipboard.readText();
}

/** Server input() keeps only the first 64 KiB per call, so a big paste is cut into chunks. */
export const INPUT_CHUNK = 16_384;
export const chunkInput = (data: string, size = INPUT_CHUNK): string[] => {
  const out: string[] = [];
  for (let i = 0; i < data.length; i += size) out.push(data.slice(i, i + size));
  return out;
};

/** Per-terminal FIFO: keystrokes and chunks of a paste are POSTed one after another, never racing out of order. */
export function makeInputSender(post: (id: string, data: string) => Promise<unknown>) {
  const tails = new Map<string, Promise<unknown>>();
  return (id: string, data: string) => {
    let p = tails.get(id) ?? Promise.resolve();
    for (const chunk of chunkInput(data)) p = p.then(() => post(id, chunk)).catch(() => {});
    tails.set(id, p);
    return p;
  };
}
