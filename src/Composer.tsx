import { useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { daemonClient, DEMO } from "./paseo";
import type { DraftImageView } from "./imageDrafts";
import { isImeComposing, shouldComposerSubmit } from "./IdeaInbox";

// ── Pure helpers (mirrored in test/ade-batch-f.test.mjs) ──────────────────────

export const FALLBACK_COMMANDS = ["/compact", "/clear", "/help", "/model", "/mode", "/rewind"];
export const DEMO_MENTION_FILES = ["src/App.tsx", "src/Composer.tsx", "package.json", "README.md"];
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_INLINE_BYTES = 100 * 1024;
export const FILE_ACCEPT =
  "image/*,.md,.txt,.log,.json,.ts,.tsx,.js,.mjs,.py,.rs,.css,.html,.yml,.yaml,.toml,.csv";

/** Slash token: `/word` at start of text or after whitespace, ending at the caret. */
export function slashToken(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)\/(\w*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

export function filterSlash(cmds: string[], query: string): string[] {
  const q = query.toLowerCase();
  return cmds.filter((c) => c.replace(/^\//, "").toLowerCase().startsWith(q)).slice(0, 8);
}

/** Mention token: `@partial/path` at start or after whitespace, ending at the caret. */
export function mentionToken(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

export function replaceToken(text: string, start: number, caret: number, replacement: string) {
  const next = text.slice(0, start) + replacement + text.slice(caret);
  return { text: next, caret: start + replacement.length };
}

export function relativizePath(p: string, cwd: string): string {
  const norm = p.split("\\").join("/");
  const base = cwd.split("\\").join("/").replace(/\/$/, "");
  return base && norm.startsWith(base + "/") ? norm.slice(base.length + 1) : norm;
}

export function filterMentionFiles(files: string[], query: string): string[] {
  const q = query.toLowerCase();
  return files.filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
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
    else if (f.size > MAX_FILE_BYTES) tooLarge.push(f);
    else text.push(f);
  }
  return { images, text, tooLarge };
}

export function fenceFile(name: string, content: string): string {
  const fence = content.includes("```") ? "~~~~" : "```";
  return `\n[file: ${name}]\n${fence}\n${content}\n${fence}\n`;
}

/** Step through history. idx -1 = original draft. Returns next idx (clamped). */
export function historyStep(len: number, idx: number, dir: "up" | "down"): number {
  if (dir === "up") return Math.min(idx + 1, len - 1);
  return Math.max(idx - 1, -1);
}

export function searchHistory(history: string[], query: string): string[] {
  const q = query.toLowerCase();
  return history.filter((h) => h.toLowerCase().includes(q)).slice(0, 8);
}

export function pushHistory(history: string[], prompt: string, max = 50): string[] {
  const t = prompt.trim();
  if (!t) return history;
  return [t, ...history.filter((h) => h !== t)].slice(0, max);
}

const HIST_KEY = (id: string) => `vs.composerHistory.${id}`;
const DEMO_HISTORY = ["Summarize the open pull requests", "Run the tests and report failures"];
function loadHistory(id: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HIST_KEY(id)) ?? "[]");
    const arr = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    return DEMO && !arr.length ? DEMO_HISTORY : arr;
  } catch {
    return DEMO ? DEMO_HISTORY : [];
  }
}
function saveHistory(id: string, h: string[]) {
  try {
    localStorage.setItem(HIST_KEY(id), JSON.stringify(h));
  } catch {
    /* ignore */
  }
}

const commandCache = new Map<string, string[]>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dc = daemonClient as any;

const MENU_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  maxHeight: 180,
  overflowY: "auto",
  border: "1px solid var(--border, #444)",
  borderRadius: 6,
  padding: 4,
  fontSize: 13,
};

type StagedFile = { id: string; name: string; block: string };

type ImgDraft = {
  images: DraftImageView[];
  add: (files: Array<File | Blob>) => void;
  remove: (id: string) => void;
  clear: () => void;
};

type ComposerProps = {
  agent: PaseoAgent;
  draft: string;
  setDraft: (v: string) => void;
  busy: boolean;
  isBs: boolean;
  inboxParking: boolean;
  lastSteered: string | null;
  imgs: ImgDraft;
  onSend: () => void;
  onInterrupt: () => void;
  onParkToInbox: (text: string, fromComposer: boolean) => void;
  onToggleInboxPopover: () => void;
};

export function Composer({
  agent,
  draft,
  setDraft,
  busy,
  isBs,
  inboxParking,
  lastSteered,
  imgs,
  onSend,
  onInterrupt,
  onParkToInbox,
  onToggleInboxPopover,
}: ComposerProps) {
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [cmds, setCmds] = useState<string[]>(FALLBACK_COMMANDS);
  const [files, setFiles] = useState<string[]>(DEMO ? DEMO_MENTION_FILES : []);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(() => loadHistory(agent.id));
  const [histIdx, setHistIdx] = useState(-1);
  const origDraft = useRef("");
  const [searching, setSearching] = useState(false);
  const [hq, setHq] = useState("");

  const slash = dismissed ? null : slashToken(draft, caret);
  const mention = dismissed || slash ? null : mentionToken(draft, caret);
  const slashItems = slash ? filterSlash(cmds, slash.query) : [];
  const mentionItems = mention ? filterMentionFiles(files, mention.query) : [];
  const histItems = searching ? searchHistory(history, hq) : [];

  useEffect(() => {
    setHistory(loadHistory(agent.id));
    setHistIdx(-1);
    setStaged([]);
    let cancelled = false;
    const cached = commandCache.get(agent.id);
    if (cached) {
      setCmds(cached);
      return;
    }
    setCmds(FALLBACK_COMMANDS);
    if (DEMO) return;
    (async () => {
      try {
        const res = await dc.listCommands?.(agent.id);
        const raw: unknown[] = Array.isArray(res) ? res : (res?.commands ?? []);
        const names = raw
          .map((c) => (typeof c === "string" ? c : ((c as { name?: string })?.name ?? "")))
          .filter(Boolean)
          .map((n) => (n.startsWith("/") ? n : `/${n}`));
        const list = names.length ? names : FALLBACK_COMMANDS;
        commandCache.set(agent.id, list);
        if (!cancelled) setCmds(list);
      } catch {
        if (!cancelled) setCmds(FALLBACK_COMMANDS);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agent.id]);

  const mq = mention?.query;
  useEffect(() => {
    if (mq === undefined) return;
    if (DEMO) {
      setFiles(DEMO_MENTION_FILES);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await dc.getDirectorySuggestions?.({ cwd: agent.cwd, query: mq, includeFiles: true, includeDirectories: true, limit: 8 });
        let paths: string[] = (res?.entries ?? res?.suggestions ?? [])
          .map((e: { path?: string } | string) => (typeof e === "string" ? e : (e.path ?? "")))
          .filter(Boolean);
        if (!paths.length) {
          const dir = await dc.listDirectory?.(agent.cwd, "");
          paths = (dir?.entries ?? []).map((e: { path: string }) => e.path);
        }
        if (!cancelled) setFiles(paths.map((x) => relativizePath(x, agent.cwd ?? "")));
      } catch {
        if (!cancelled) setFiles([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mq, agent.cwd]);

  const insertAt = (start: number, replacement: string) => {
    const r = replaceToken(draft, start, caret, replacement);
    setDraft(r.text);
    setCaret(r.caret);
    setSel(0);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(r.caret, r.caret);
    });
  };
  const pickSlash = (c: string) => slash && insertAt(slash.start, `${c} `);
  const pickMention = (f: string) => mention && insertAt(mention.start, `@${f} `);

  const addFiles = async (all: File[]) => {
    const { images, text, tooLarge } = partitionFiles(all);
    if (images.length) imgs.add(images);
    setNotice(tooLarge.length ? `Too large (max 2MB): ${tooLarge.map((f) => f.name).join(", ")}` : null);
    const next: StagedFile[] = [];
    for (const f of text) {
      let block: string;
      if (f.size <= MAX_INLINE_BYTES) {
        block = fenceFile(f.name, await f.text());
      } else {
        try {
          const up = await dc.uploadFile?.({ cwd: agent.cwd, name: f.name, file: f });
          if (!up?.path) throw new Error("no upload");
          block = `\n[attached file: ${up.path}]\n`;
        } catch {
          setNotice(`${f.name} is over 100KB and upload is unavailable`);
          continue;
        }
      }
      next.push({ id: `${f.name}-${Date.now()}-${next.length}`, name: f.name, block });
    }
    if (next.length) {
      setStaged((p) => [...p, ...next]);
      setDraft(draft + next.map((n) => n.block).join(""));
    }
  };
  const removeStaged = (f: StagedFile) => {
    setStaged((p) => p.filter((x) => x.id !== f.id));
    setDraft(draft.includes(f.block) ? draft.replace(f.block, "") : draft);
  };

  const send = () => {
    if (draft.trim()) {
      const h = pushHistory(history, draft);
      setHistory(h);
      saveHistory(agent.id, h);
    }
    setHistIdx(-1);
    setStaged([]);
    onSend();
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const fl = Array.from(e.clipboardData?.items ?? [])
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    if (fl.length) {
      e.preventDefault();
      void addFiles(fl);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const menu = slash ? slashItems : mention ? mentionItems : [];
    if (menu.length && !isImeComposing(e)) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSel((i) => (e.key === "ArrowDown" ? (i + 1) % menu.length : (i - 1 + menu.length) % menu.length));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const item = menu[Math.min(sel, menu.length - 1)];
        if (slash) pickSlash(item);
        else pickMention(item);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.ctrlKey && e.key.toLowerCase() === "r" && !e.metaKey) {
      e.preventDefault();
      setSearching(true);
      setHq("");
      return;
    }
    const t = e.currentTarget;
    if (e.key === "ArrowUp" && history.length && (draft === "" || (histIdx >= 0 && t.selectionStart === 0))) {
      e.preventDefault();
      if (histIdx < 0) origDraft.current = draft;
      const n = historyStep(history.length, histIdx, "up");
      setHistIdx(n);
      setDraft(history[n]);
      return;
    }
    if (e.key === "ArrowDown" && histIdx >= 0) {
      e.preventDefault();
      const n = historyStep(history.length, histIdx, "down");
      setHistIdx(n);
      setDraft(n < 0 ? origDraft.current : history[n]);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !isImeComposing(e)) {
      e.preventDefault();
      onInterrupt();
      return;
    }
    if (shouldComposerSubmit(e)) {
      e.preventDefault();
      if (e.repeat || busy) return;
      send();
    }
  };

  return (
    <footer
      className={`composer ${dragOver ? "drag-over composer-drop-active" : ""}`}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        void addFiles(Array.from(e.dataTransfer?.files ?? []));
      }}
    >
      {imgs.images.length > 0 && (
        <div className="composer-images composer-thumbs">
          {imgs.images.map((im) => (
            <div key={im.id} className="composer-thumb" title={im.name}>
              <img src={im.url} alt={im.name} />
              <span className="thumb-name">{im.name}</span>
              <button
                className="thumb-x composer-thumb-remove"
                aria-label={`Remove ${im.name}`}
                onClick={() => imgs.remove(im.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {lastSteered && (
        <div className="chip steered-chip" data-testid="steered-chip">
          steered
        </div>
      )}
      {notice && (
        <div className="chip warn" data-testid="composer-file-notice">
          {notice}
        </div>
      )}
      {staged.length > 0 && (
        <div className="composer-files">
          {staged.map((f) => (
            <span key={f.id} className="chip" data-testid="composer-file-chip" title={f.name}>
              📄 {f.name}{" "}
              <button className="thumb-x" aria-label={`Remove ${f.name}`} onClick={() => removeStaged(f)}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      {slashItems.length > 0 && (
        <div className="composer-menu" style={MENU_STYLE} data-testid="composer-slash-menu" role="listbox">
          {slashItems.map((c, i) => (
            <div
              key={c}
              role="option"
              aria-selected={i === sel}
              className={`composer-menu-item ${i === sel ? "active" : ""}`}
              style={i === sel ? { background: "rgba(127,127,127,.25)", cursor: "pointer" } : { cursor: "pointer" }}
              data-testid="composer-slash-item"
              onMouseDown={(e) => {
                e.preventDefault();
                pickSlash(c);
              }}
            >
              {c}
            </div>
          ))}
        </div>
      )}
      {mentionItems.length > 0 && (
        <div className="composer-menu" style={MENU_STYLE} data-testid="composer-mention-menu" role="listbox">
          {mentionItems.map((f, i) => (
            <div
              key={f}
              role="option"
              aria-selected={i === sel}
              className={`composer-menu-item ${i === sel ? "active" : ""}`}
              style={i === sel ? { background: "rgba(127,127,127,.25)", cursor: "pointer" } : { cursor: "pointer" }}
              data-testid="composer-mention-item"
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(f);
              }}
            >
              @{f}
            </div>
          ))}
        </div>
      )}
      {searching && (
        <div className="composer-menu composer-history-search" style={MENU_STYLE} data-testid="composer-history-search">
          <input
            autoFocus
            value={hq}
            placeholder="reverse-i-search…"
            onChange={(e) => setHq(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearching(false);
                taRef.current?.focus();
              } else if (e.key === "Enter" && histItems[0]) {
                e.preventDefault();
                setDraft(histItems[0]);
                setSearching(false);
                taRef.current?.focus();
              }
            }}
          />
          {histItems.map((h) => (
            <div
              key={h}
              className="composer-menu-item"
              style={{ cursor: "pointer" }}
              onMouseDown={(e) => {
                e.preventDefault();
                setDraft(h);
                setSearching(false);
                taRef.current?.focus();
              }}
            >
              {h}
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        <textarea
          ref={taRef}
          value={draft}
          placeholder={`Message ${agent.title ?? "agent"}… (Enter to send, Ctrl+Enter to interrupt)`}
          onChange={(e) => {
            setDismissed(false);
            setSel(0);
            setHistIdx(-1);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDraft(e.target.value);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onPaste={onPaste}
          onKeyDown={onKey}
        />
        <input
          ref={fileInput}
          type="file"
          accept={FILE_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            void addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <button
          className="btn ghost attach-img composer-attach composer-attach-btn"
          title="Attach file or image"
          onClick={() => fileInput.current?.click()}
        >
          📎
        </button>
        {isBs && (
          <button
            className="btn ghost composer-park-inbox-btn"
            disabled={inboxParking}
            title="Park composer draft (1 or multiple newline-separated ideas) straight into Idea Inbox (0 tokens)"
            onClick={() => (draft.trim() ? onParkToInbox(draft, true) : onToggleInboxPopover())}
            data-testid="composer-park-inbox-btn"
          >
            📥 Park in Inbox
          </button>
        )}
        <button className="btn" disabled={busy || (!draft.trim() && !imgs.images.length)} onClick={send}>
          Send
        </button>
        {agent.status === "running" && (
          <button
            className="btn warn composer-interrupt-btn"
            disabled={busy || (!draft.trim() && !imgs.images.length)}
            title="Interrupt current turn and send (Ctrl+Enter)"
            data-testid="composer-interrupt-btn"
            onClick={onInterrupt}
          >
            ⚡ Interrupt &amp; send
          </button>
        )}
      </div>
    </footer>
  );
}
