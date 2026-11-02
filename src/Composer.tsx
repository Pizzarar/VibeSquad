import { useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { daemonClient, DEMO, usePaseo } from "./paseo";
import { workspaceIdForAgent } from "./workspaceLogic";
import { ctxGroupsFor, gitMenuItems, isCtxItem, useCtxSources, type CtxMenuItem } from "./contextSources";
import { fetchChatContext, fetchGitContext, fetchTerminalContext, listTerminalNames } from "./contextFetch";
import type { DraftImageView } from "./imageDrafts";
import { formatSize, MAX_INLINE_BYTES, fenceFile, type useAttachments } from "./attachments";
import { isImeComposing, shouldComposerSubmit } from "./IdeaInbox";
import { composerKeyAction, usePref } from "./prefs";
import {
  filterListing,
  filterMentionEntries,
  isUrlMention,
  LIST_TIMEOUT_MS,
  mentionInsertText,
  mentionLabel,
  parentDirOf,
  urlMentions,
  resolveMentionEntries,
  type MentionEntry,
} from "./projectContext";

// ── Pure helpers (mirrored in test/ade-batch-f.test.mjs) ──────────────────────

export const FALLBACK_COMMANDS = ["/compact", "/clear", "/help", "/model", "/mode", "/rewind"];
export const DEMO_MENTION_FILES = ["src/App.tsx", "src/Composer.tsx", "package.json", "README.md"];
const DEMO_ENTRIES: MentionEntry[] = [
  { path: "src", kind: "directory" },
  ...DEMO_MENTION_FILES.map((path) => ({ path, kind: "file" as const })),
];
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export { MAX_INLINE_BYTES, fenceFile };
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

/** Route dropped/pasted/picked files: images to thumbnails, the rest to chips. Never touches the draft. */
export function stageFiles(
  all: File[],
  imgs: { add: (f: File[]) => void },
  atts: { add: (f: File[]) => void },
): string | null {
  const { images, text, tooLarge } = partitionFiles(all);
  if (images.length) imgs.add(images);
  if (text.length) atts.add(text);
  return tooLarge.length ? `Too large (max 2MB): ${tooLarge.map((f) => f.name).join(", ")}` : null;
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
const listingCache = new Map<string, Promise<MentionEntry[]>>();
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
  atts: ReturnType<typeof useAttachments>;
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
  atts,
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
  const [files, setFiles] = useState<MentionEntry[]>(DEMO ? DEMO_ENTRIES : []);
  const [listFailed, setListFailed] = useState(false);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(() => loadHistory(agent.id));
  const [histIdx, setHistIdx] = useState(-1);
  const origDraft = useRef("");
  const { agents, workspaces } = usePaseo();
  const ctx = useCtxSources(agent.id);
  const [terms, setTerms] = useState<Array<{ id: string; name: string }>>([]);
  const [ctxStatus, setCtxStatus] = useState<{ tone: "busy" | "fail"; text: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [hq, setHq] = useState("");

  const slash = dismissed ? null : slashToken(draft, caret);
  const mention = dismissed || slash ? null : mentionToken(draft, caret);
  const slashItems = slash ? filterSlash(cmds, slash.query) : [];
  const urlItem: MentionEntry | null = mention && isUrlMention(mention.query) ? { path: mention.query, kind: "file" } : null;
  const mentionItems: MentionEntry[] = urlItem ? [urlItem] : mention ? filterMentionEntries(files, mention.query) : [];
  const urlChips = urlMentions(draft);
  const ctxGroups = mention && !urlItem ? ctxGroupsFor(mention.query) : [];
  const lane = ((agent.labels ?? {}) as Record<string, string>).lane;
  const ctxItems: CtxMenuItem[] = [
    ...(ctxGroups.includes("git") ? gitMenuItems() : []),
    ...(ctxGroups.includes("terminal")
      ? terms.map((t): CtxMenuItem => ({ ctx: true, kind: "terminal", label: `@terminal ${t.name}`, hint: "last 200 lines", arg: t.id }))
      : []),
    ...(ctxGroups.includes("chat") && lane
      ? [...agents.values()]
          .filter((a) => a.id !== agent.id && !a.archivedAt && ((a.labels ?? {}) as Record<string, string>).lane === lane)
          .slice(0, 8)
          .map((a): CtxMenuItem => ({ ctx: true, kind: "chat", label: `@chat ${a.title || a.id.slice(0, 8)}`, hint: "last turns", arg: a.id }))
      : []),
  ];
  const menuItems: Array<MentionEntry | CtxMenuItem> = [...ctxItems, ...mentionItems];
  const histItems = searching ? searchHistory(history, hq) : [];

  useEffect(() => {
    setHistory(loadHistory(agent.id));
    setHistIdx(-1);
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

  const mq = mention && !isUrlMention(mention.query) ? mention.query : undefined;
  useEffect(() => {
    if (mq === undefined) return;
    if (DEMO) {
      setFiles(DEMO_ENTRIES);
      return;
    }
    let cancelled = false;
    const toEntry = (e: { path?: string; kind?: string } | string): MentionEntry =>
      typeof e === "string"
        ? { path: e.replace(/\/+$/, ""), kind: e.endsWith("/") ? "directory" : "file" }
        : { path: e.path ?? "", kind: e.kind === "directory" ? "directory" : "file" };
    const cwd = agent.cwd ?? "";
    // Fuzzy suggestions can take 15s+ on a big repo with a busy daemon, so list the query's parent
    // folder in parallel (cached per folder) and use it when suggestions miss the deadline.
    const dir = parentDirOf(mq);
    const key = `${cwd}\n${dir}`;
    let listing = listingCache.get(key);
    if (!listing) {
      listing = Promise.resolve(dc.listDirectory?.(cwd, dir)).then((r: { entries?: Array<{ path: string; kind: string }> } | undefined) =>
        (r?.entries ?? []).map(toEntry),
      );
      listingCache.set(key, listing);
      listing.catch(() => listingCache.delete(key));
      setTimeout(() => listingCache.delete(key), 30_000);
    }
    const suggest = (async () => {
      const res = await dc.getDirectorySuggestions?.({ cwd: agent.cwd, query: mq, includeFiles: true, includeDirectories: true, limit: 8 });
      let list: MentionEntry[] = (res?.entries ?? []).map(toEntry);
      if (!list.length) list = ((res?.directories ?? []) as string[]).map((d) => ({ path: d, kind: "directory" as const }));
      return list.filter((e) => e.path);
    })();
    (async () => {
      // Time-boxed: a slow or hung listing shows "couldn't list" instead of freezing the menu.
      const r = await resolveMentionEntries(suggest, listing!, LIST_TIMEOUT_MS, () => listingCache.delete(key));
      if (cancelled) return;
      const value = r.fromListing ? filterListing(r.value, mq) : r.value;
      const failed = r.failed;
      setListFailed(failed);
      setFiles(value.map((e) => ({ ...e, path: relativizePath(e.path, cwd) })));
    })();
    return () => {
      cancelled = true;
    };
  }, [mq, agent.cwd]);

  const termsWanted = ctxGroups.includes("terminal");
  const workspaceId = workspaceIdForAgent(agent, workspaces);
  useEffect(() => {
    if (!termsWanted) return;
    let cancelled = false;
    listTerminalNames(agent.cwd ?? "", workspaceId).then(
      (t) => !cancelled && (setTerms(t), setCtxStatus(t.length ? null : { tone: "fail", text: "No terminals open for this workspace" })),
      (e) => !cancelled && setCtxStatus({ tone: "fail", text: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [termsWanted, agent.cwd, workspaceId]);

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
  const pickMention = (e: MentionEntry) => mention && insertAt(mention.start, mentionInsertText(e));
  const pickCtx = async (it: CtxMenuItem) => {
    if (!mention) return;
    insertAt(mention.start, "");
    setCtxStatus({ tone: "busy", text: `Fetching ${it.label.replace(/^@/, "")}…` });
    try {
      const src =
        it.kind === "terminal"
          ? await fetchTerminalContext({ id: it.arg!, name: it.label.replace(/^@terminal /, "") })
          : it.kind === "chat"
            ? await fetchChatContext(it.arg!, it.label.replace(/^@chat /, ""))
            : await fetchGitContext(agent.cwd ?? "", it.kind as "git" | "git-base");
      ctx.add(src);
      setCtxStatus(null);
    } catch (e) {
      setCtxStatus({ tone: "fail", text: `Couldn't add ${it.label}: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const addFiles = (all: File[]) => {
    if (all.length) setNotice(stageFiles(all, imgs, atts));
  };

  const send = () => {
    if (draft.trim()) {
      const h = pushHistory(history, draft);
      setHistory(h);
      saveHistory(agent.id, h);
    }
    setHistIdx(-1);
    onSend();
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const fl = Array.from(e.clipboardData?.items ?? [])
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    if (fl.length) {
      e.preventDefault();
      addFiles(fl);
    }
  };

  const [sendKey] = usePref("chat.sendKey");
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const menu: Array<string | MentionEntry | CtxMenuItem> = slash ? slashItems : mention ? menuItems : [];
    if (menu.length && !isImeComposing(e)) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSel((i) => (e.key === "ArrowDown" ? (i + 1) % menu.length : (i - 1 + menu.length) % menu.length));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const item = menu[Math.min(sel, menu.length - 1)];
        if (slash) pickSlash(item as string);
        else if (isCtxItem(item)) void pickCtx(item);
        else pickMention(item as MentionEntry);
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
    if (sendKey === "ctrl-enter" && e.key === "Enter" && !isImeComposing(e)) {
      // Settings › Chat › Send key = Ctrl+Enter: plain Enter is a new line, Ctrl+Shift+Enter interrupts.
      const action = composerKeyAction(e, sendKey);
      if (action === "newline") return;
      e.preventDefault();
      if (action === "interrupt") onInterrupt();
      else if (!e.repeat && !busy) send();
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
        addFiles(Array.from(e.dataTransfer?.files ?? []));
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
      {atts.items.length > 0 && (
        <div className="composer-files">
          {atts.items.map((f) => (
            <span key={f.id} className="chip file-chip" data-testid="composer-file-chip" title={f.name}>
              📄 <span className="file-chip-name">{f.name}</span> <span className="file-chip-size">{formatSize(f.size)}</span>{" "}
              <button className="thumb-x" aria-label={`Remove ${f.name}`} onClick={() => atts.remove(f.id)}>
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
      {urlChips.length > 0 && (
        <div className="composer-files">
          {urlChips.map((u) => (
            <span key={u} className="chip file-chip link-chip" data-testid="composer-url-chip" title="Sent as-is; VibeSquad doesn't fetch it">
              🔗 <span className="file-chip-name">{u}</span>
            </span>
          ))}
        </div>
      )}
      {ctx.items.length > 0 && (
        <div className="composer-files">
          {ctx.items.map((c) => (
            <span key={c.id} className="chip file-chip link-chip" data-testid="composer-ctx-chip" title={`${c.label}, ${c.text.length} characters, appended on send`}>
              {c.kind === "terminal" ? "⌨" : c.kind === "chat" ? "💬" : "±"} <span className="file-chip-name">{c.label}</span>{" "}
              <button className="thumb-x" aria-label={`Remove ${c.label}`} onClick={() => ctx.remove(c.id)}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      {ctxStatus && (
        <div className={`chip ${ctxStatus.tone === "fail" ? "warn" : ""}`} data-testid="composer-ctx-status">
          {ctxStatus.text}
        </div>
      )}
      {mention && !mentionItems.length && !ctxItems.length && listFailed && (
        <div className="composer-menu muted small" style={MENU_STYLE} data-testid="composer-mention-failed">
          Couldn't list files here. Type the path and it is sent as written.
        </div>
      )}
      {menuItems.length > 0 && (
        <div className="composer-menu" style={MENU_STYLE} data-testid="composer-mention-menu" role="listbox">
          {menuItems.map((f, i) =>
            isCtxItem(f) ? (
              <div
                key={`ctx:${f.label}`}
                role="option"
                aria-selected={i === sel}
                className={`composer-menu-item ${i === sel ? "active" : ""}`}
                style={i === sel ? { background: "rgba(127,127,127,.25)", cursor: "pointer" } : { cursor: "pointer" }}
                data-testid="composer-ctx-item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  void pickCtx(f);
                }}
              >
                {f.label} <span className="muted small">{f.hint}</span>
              </div>
            ) : (
            <div
              key={`${f.kind}:${f.path}`}
              role="option"
              aria-selected={i === sel}
              className={`composer-menu-item ${i === sel ? "active" : ""}`}
              style={i === sel ? { background: "rgba(127,127,127,.25)", cursor: "pointer" } : { cursor: "pointer" }}
              data-testid={f.kind === "directory" ? "composer-mention-folder" : "composer-mention-item"}
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(f);
              }}
            >
              {f === urlItem ? `🔗 ${f.path}` : mentionLabel(f)}
            </div>
            ),
          )}
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
          placeholder={`Message ${agent.title ?? "agent"}… (${sendKey === "ctrl-enter" ? "Ctrl+Enter to send, Ctrl+Shift+Enter to interrupt" : "Enter to send, Ctrl+Enter to interrupt"})`}
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
            addFiles(Array.from(e.target.files ?? []));
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
        <button className="btn" disabled={busy || (!draft.trim() && !imgs.images.length && !atts.items.length)} onClick={send}>
          Send
        </button>
        {agent.status === "running" && (
          <button
            className="btn warn composer-interrupt-btn"
            disabled={busy || (!draft.trim() && !imgs.images.length && !atts.items.length)}
            title={`Interrupt current turn and send (${sendKey === "ctrl-enter" ? "Ctrl+Shift+Enter" : "Ctrl+Enter"})`}
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
