import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DEMO, daemonClient } from "./paseo";
import { getPanes, openAgent, subscribePanes } from "./panes";
import { AGENT_TYPE_LABEL, type Member, type TeamView } from "./teams";
import { Ago, cleanTitle } from "./ui";

// ---- pure helpers (mirrored in test/ade-batch-g.test.mjs) ---------------------------------

export type DateBucket = "today" | "yesterday" | "older";

export function dateBucket(iso: string | null | undefined, now = Date.now()): DateBucket {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "older";
  const d = new Date(now);
  const startToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (t >= startToday) return "today";
  if (t >= startToday - 86_400_000) return "yesterday";
  return "older";
}

export type UrlState = { team: string | null; agent: string | null };

export function parseUrlState(search: string): UrlState {
  const p = new URLSearchParams(search);
  return { team: p.get("team") || null, agent: p.get("agent") || null };
}

/** Merges team/agent into an existing query string, keeping unrelated params (demo, dock, ...). */
export function serializeUrlState(state: UrlState, search = ""): string {
  const p = new URLSearchParams(search);
  p.delete("team");
  p.delete("agent");
  if (state.team) p.set("team", state.team);
  if (state.agent) p.set("agent", state.agent);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export type PaletteItem = {
  id: string;
  kind: "agent" | "team" | "action";
  label: string;
  hint: string;
  ts?: string | null;
};

export function filterPalette(items: PaletteItem[], q: string): PaletteItem[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items;
  const terms = needle.split(/\s+/);
  return items.filter((it) => {
    const hay = `${it.label} ${it.hint}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export type SearchHit = { agentId: string; title: string; team: string; snippet: string };

export function snippetAround(text: string, q: string, radius = 50): string | null {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return null;
  const s = Math.max(0, i - radius);
  const e = Math.min(text.length, i + q.length + radius);
  return `${s > 0 ? "…" : ""}${text.slice(s, e).replace(/\s+/g, " ")}${e < text.length ? "…" : ""}`;
}

export type CtxItem = { label: string; run: () => void };
export type CtxMenuState = { x: number; y: number; items: CtxItem[] } | null;

export function agentCtxItems(m: { id: string; cwd?: string | null }, a: { open: () => void; split: () => void; archive: () => void }): CtxItem[] {
  return [
    { label: "Open Agent", run: a.open },
    { label: "Open in Split Pane", run: a.split },
    { label: "Copy Agent ID", run: () => void navigator.clipboard?.writeText(m.id) },
    { label: "Copy Working Folder (cwd)", run: () => void navigator.clipboard?.writeText(m.cwd ?? "") },
    { label: "Archive Agent", run: a.archive },
  ];
}

export function messageCtxItems(text: string, agentId: string, park?: (t: string) => void): CtxItem[] {
  const items: CtxItem[] = [{ label: "Copy Message Text", run: () => void navigator.clipboard?.writeText(text) }];
  if (park && text.trim()) items.push({ label: "Park in Inbox", run: () => park(text) });
  items.push({ label: "Copy Agent ID", run: () => void navigator.clipboard?.writeText(agentId) });
  return items;
}

// ---- context menu store -------------------------------------------------------------------

let ctxState: CtxMenuState = null;
const ctxListeners = new Set<() => void>();
const setCtx = (s: CtxMenuState) => {
  ctxState = s;
  ctxListeners.forEach((l) => l());
};

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, items: CtxItem[]) {
  e.preventDefault();
  e.stopPropagation();
  setCtx({ x: e.clientX, y: e.clientY, items });
}

function ContextMenuHost() {
  const s = useSyncExternalStore(
    (l) => (ctxListeners.add(l), () => void ctxListeners.delete(l)),
    () => ctxState,
  );
  useEffect(() => {
    if (!s) return;
    const close = () => setCtx(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [s]);
  if (!s) return null;
  const x = Math.min(s.x, window.innerWidth - 230);
  const y = Math.min(s.y, window.innerHeight - 40 * s.items.length - 12);
  return (
    <div className="ctx-menu" data-testid="custom-context-menu" role="menu" style={{ left: Math.max(4, x), top: Math.max(4, y) }} onContextMenu={(e) => e.preventDefault()}>
      {s.items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          onClick={() => {
            setCtx(null);
            it.run();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ---- shortcut cheat sheet -----------------------------------------------------------------

const SHORTCUTS: [string, string][] = [
  ["Ctrl+K / Ctrl+Shift+P", "Command palette"],
  ["Ctrl+.", "Toggle Focus mode"],
  ["Ctrl+J", "Open the top NEEDS YOU agent"],
  ["Ctrl+1 … 9", "Switch tab in the active pane"],
  ["Shift+Tab", "Cycle permission mode (composer)"],
  ["Ctrl+R", "Reload the page"],
  ["?", "This cheat sheet"],
  ["Ctrl+= / Ctrl+- / Ctrl+0", "UI scale up / down / reset"],
  ["Esc", "Close dialogs and menus"],
];

function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="shortcut-modal" data-testid="shortcut-cheat-sheet" role="dialog" aria-label="Keyboard shortcuts" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Keyboard shortcuts</h3>
        <table>
          <tbody>
            {SHORTCUTS.map(([k, d]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- transcript search --------------------------------------------------------------------

async function textsFor(agentId: string): Promise<string[]> {
  if (DEMO) return [];
  try {
    const p = Promise.race([
      daemonClient.fetchAgentTimeline(agentId, { direction: "tail" as any, limit: 60, projection: "projected" as any }),
      new Promise<any>((r) => setTimeout(() => r({ entries: [] }), 600)),
    ]);
    const t = await p;
    return ((t.entries ?? []) as any[])
      .map((e) => e?.item)
      .filter((it) => it && (it.type === "user_message" || it.type === "assistant_message") && typeof it.text === "string")
      .map((it) => it.text as string);
  } catch {
    return [];
  }
}

export async function searchTranscripts(members: Member[], q: string): Promise<SearchHit[]> {
  const query = q.trim();
  if (!query) return [];
  const candidates = members.slice(0, 12);
  const per = await Promise.all(
    candidates.map(async (m) => {
      const title = cleanTitle(m.agent.title) || m.agent.id.slice(0, 8);
      const own = snippetAround(title, query);
      if (own) return { agentId: m.agent.id, title, team: m.team.name, snippet: own };
      for (const text of await textsFor(m.agent.id)) {
        const snippet = snippetAround(text, query);
        if (snippet) return { agentId: m.agent.id, title, team: m.team.name, snippet };
      }
      return null;
    }),
  );
  return per.filter((h): h is SearchHit => !!h);
}

function TranscriptSearch({ members, onPick, onClose }: { members: Member[]; onPick: (m: Member) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!q.trim()) {
      setHits(null);
      return;
    }
    let live = true;
    setBusy(true);
    const h = setTimeout(() => {
      void searchTranscripts(members, q).then((r) => {
        if (live) {
          setHits(r);
          setBusy(false);
        }
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(h);
    };
  }, [q, members]);
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="cmd-palette" data-testid="transcript-search" onMouseDown={(e) => e.stopPropagation()}>
        <input autoFocus data-testid="transcript-search-input" value={q} placeholder="Search all transcripts…" onChange={(e) => setQ(e.target.value)} />
        <div className="cmd-list">
          {busy && <div className="cmd-empty muted">Searching…</div>}
          {!busy && hits && hits.length === 0 && (
            <div className="cmd-empty" data-testid="transcript-search-empty">
              No results found
            </div>
          )}
          {!busy &&
            hits?.map((h) => (
              <button
                key={h.agentId}
                className="cmd-item"
                data-testid="transcript-search-result"
                onClick={() => {
                  const m = members.find((x) => x.agent.id === h.agentId);
                  if (m) onPick(m);
                }}
              >
                <b>{h.title}</b> <span className="muted small">{h.team}</span>
                <div className="small muted">{h.snippet}</div>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

// ---- host ---------------------------------------------------------------------------------

export type PaletteActions = {
  newAgent: () => void;
  settings: () => void;
  workspaces: () => void;
  toggleFocus: () => void;
};

export const openOverlay = (which: "search" | "shortcuts") => window.dispatchEvent(new CustomEvent("vs:open-overlay", { detail: which }));

export function CommandPaletteHost(props: {
  members: Member[];
  archived: Member[];
  views: TeamView[];
  onAgent: (m: Member) => void;
  onTeam: (id: string) => void;
  actions: PaletteActions;
}) {
  const [mode, setMode] = useState<"palette" | "search" | "shortcuts" | null>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const closed = useRef<string[]>([]);

  // Remember closed tabs so "Reopen Closed Tab" has something to reopen.
  useEffect(() => {
    let prev = new Set(getPanes().leftTabs.concat(getPanes().rightTabs ?? []));
    return subscribePanes(() => {
      const p = getPanes();
      const now = new Set(p.leftTabs.concat(p.rightTabs ?? []));
      prev.forEach((id) => !now.has(id) && closed.current.push(id));
      prev = now;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (mod && !e.altKey && (e.key === "k" || e.key === "K" || (e.shiftKey && (e.key === "p" || e.key === "P")))) {
        e.preventDefault();
        setQ("");
        setSel(0);
        setMode((m) => (m === "palette" ? null : "palette"));
      } else if (e.key === "?" && !mod && !typing) {
        e.preventDefault();
        setMode("shortcuts");
      } else if (e.key === "Escape") setMode(null);
    };
    const onOpen = (e: Event) => setMode((e as CustomEvent<string>).detail as "search" | "shortcuts");
    window.addEventListener("keydown", onKey);
    window.addEventListener("vs:open-overlay", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("vs:open-overlay", onOpen);
    };
  }, []);

  const all = useMemo(() => [...props.members, ...props.archived], [props.members, props.archived]);

  const items = useMemo<PaletteItem[]>(() => {
    const act = (id: string, label: string): PaletteItem => ({ id: `action:${id}`, kind: "action", label, hint: "" });
    const agents = all.map<PaletteItem>((m) => ({
      id: `agent:${m.agent.id}`,
      kind: "agent",
      label: cleanTitle(m.agent.title) || m.agent.id.slice(0, 8),
      hint: `${m.team.name} ${AGENT_TYPE_LABEL[m.agentType]} ${m.agent.status}${m.agent.archivedAt ? " archived" : ""}`,
      ts: m.agent.updatedAt,
    }));
    const teams = props.views.map<PaletteItem>((v) => ({ id: `team:${v.team.id}`, kind: "team", label: v.team.name, hint: "squad team" }));
    return [
      act("new", "New Agent"),
      act("search", "Search All Transcripts…"),
      act("shortcuts", "Keyboard Shortcuts (?)"),
      act("settings", "Settings"),
      act("workspaces", "Workspaces"),
      act("focus", "Toggle Focus Mode (Ctrl+.)"),
      act("reopen", "Reopen Closed Tab"),
      ...teams,
      ...agents,
    ];
  }, [all, props.views]);

  const shown = useMemo(() => filterPalette(items, q).slice(0, 60), [items, q]);

  /** The jumped-to drawer mounts after the palette closes; retry until its visible composer exists. Inactive panes stay mounted (display:none), so scope by agent and visibility. */
  const focusComposer = (agentId: string, tries = 20) => {
    const cur = document.activeElement as HTMLElement | null;
    if (cur && cur !== document.body && !cur.closest(".cmd-palette, .modal-back") && (/^(INPUT|TEXTAREA|SELECT)$/.test(cur.tagName) || cur.isContentEditable)) return;
    const ta = document.querySelector<HTMLTextAreaElement>(`.pane-slot[data-agent="${CSS.escape(agentId)}"] .composer-row textarea`);
    if (ta && ta.offsetParent !== null) ta.focus({ preventScroll: true });
    else if (tries > 0) setTimeout(() => focusComposer(agentId, tries - 1), 50);
  };

  const run = (it: PaletteItem) => {
    setMode(null);
    const id = it.id.slice(it.id.indexOf(":") + 1);
    if (it.kind === "agent") {
      const m = all.find((x) => x.agent.id === id);
      if (m) {
        props.onAgent(m);
        focusComposer(m.agent.id);
      }
    } else if (it.kind === "team") props.onTeam(id);
    else if (id === "new") props.actions.newAgent();
    else if (id === "search") setMode("search");
    else if (id === "shortcuts") setMode("shortcuts");
    else if (id === "settings") props.actions.settings();
    else if (id === "workspaces") props.actions.workspaces();
    else if (id === "focus") props.actions.toggleFocus();
    else if (id === "reopen") {
      const last = closed.current.pop();
      if (last) openAgent(last);
    }
  };

  return (
    <>
      <ContextMenuHost />
      {mode === "shortcuts" && <ShortcutSheet onClose={() => setMode(null)} />}
      {mode === "search" && (
        <TranscriptSearch
          members={all}
          onPick={(m) => {
            setMode(null);
            props.onAgent(m);
            focusComposer(m.agent.id);
          }}
          onClose={() => setMode(null)}
        />
      )}
      {mode === "palette" && (
        <div className="modal-back" onMouseDown={() => setMode(null)}>
          <div className="cmd-palette" data-testid="command-palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
            <input
              autoFocus
              data-testid="command-palette-input"
              value={q}
              placeholder="Jump to an agent, squad or action…"
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((s) => Math.min(shown.length - 1, s + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((s) => Math.max(0, s - 1));
                } else if (e.key === "Enter" && shown[sel]) run(shown[sel]);
              }}
            />
            <div className="cmd-list">
              {shown.length === 0 && <div className="cmd-empty muted">No matches</div>}
              {shown.map((it, i) => (
                <button key={it.id} className={`cmd-item ${i === sel ? "on" : ""}`} data-testid="command-palette-item" onMouseEnter={() => setSel(i)} onClick={() => run(it)}>
                  <span className="cmd-kind">{it.kind}</span> <b>{it.label}</b>
                  {it.kind === "agent" && (
                    <span className="muted small">
                      {" "}
                      · {it.hint} · <Ago iso={it.ts} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
