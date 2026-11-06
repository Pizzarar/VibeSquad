import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { daemonClient } from "./paseo";
import { DEMO } from "./demoFlag";
import { getPanes, openAgent, subscribePanes } from "./panes";
import { AGENT_TYPE_LABEL, type Member, type TeamView } from "./teams";
import { Ago, cleanTitle } from "./ui";
import { settingsPaletteItems, useKeyBindings } from "./prefs";
import { FIXED_SHORTCUTS, KEY_COMMANDS, bindingLabel, comboFromEvent, firesWhileTyping, resolveCommand, type Bindings, type KeyScope } from "./keymap";
import { QuickOpen, type NavAgent } from "./QuickOpen";
import { FindInFiles } from "./FindInFiles";
import { bulkStopTargets, deleteGuard, getOpRequest, hardDeleteAgent, reloadAgent, requestAgentOp, runningCwds, stopAgents, subscribeOpRequest } from "./paseoAgentOps";

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
export function serializeUrlState(state: UrlState & { squadsHome?: boolean }, search = ""): string {
  const p = new URLSearchParams(search);
  p.delete("team");
  p.delete("agent");
  p.delete("view");
  if (state.squadsHome) p.set("view", "squads"); // Squads Home survives a reload/reconnect
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

export function agentCtxItems(m: { id: string; cwd?: string | null; title?: string | null; status?: string | null; archivedAt?: string | null; labels?: Record<string, string> | null }, a: { open: () => void; split: () => void; archive: () => void }): CtxItem[] {
  return [
    { label: "Open Agent", run: a.open },
    { label: "Open in Split Pane", run: a.split },
    { label: "Copy Agent ID", run: () => void navigator.clipboard?.writeText(m.id) },
    { label: "Copy Working Folder (cwd)", run: () => void navigator.clipboard?.writeText(m.cwd ?? "") },
    ...(m.archivedAt ? [] : [{ label: "Reload Agent", run: () => void reloadAgent(m.id).catch((e) => alert(`Could not reload: ${e}`)) }]),
    { label: "Archive Agent", run: a.archive },
    { label: "Delete Agent…", run: () => requestAgentOp({ kind: "delete", agent: m }) },
  ];
}

// Current highlight when it is non-empty and touches `root` (the message element), else "".
// Returns the whole highlight (same as native Ctrl+C), even if it extends into other messages.
export function selectionWithin(root: Element | null): string {
  const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
  if (!root || !sel || sel.isCollapsed || !sel.rangeCount) return "";
  for (let i = 0; i < sel.rangeCount; i++) if (sel.getRangeAt(i).intersectsNode(root)) return sel.toString();
  return "";
}

// Whole-message copy lives only on the hover "Copy" button; the menu copies just the highlight.
export function messageCtxItems(text: string, agentId: string, park?: (t: string) => void, selected = ""): CtxItem[] {
  const items: CtxItem[] = [];
  if (selected.trim()) items.push({ label: "Copy", run: () => void navigator.clipboard?.writeText(selected) });
  const parked = selected.trim() ? selected : text;
  if (park && parked.trim()) items.push({ label: "Park in Inbox", run: () => park(parked) });
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

// ---- delete / bulk-stop confirm -----------------------------------------------------------

function AgentOpConfirmHost() {
  const req = useSyncExternalStore(subscribeOpRequest, getOpRequest);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    setBusy(false);
    setErr("");
  }, [req]);
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && requestAgentOp(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req]);
  if (!req) return null;
  const close = () => requestAgentOp(null);
  const isDelete = req.kind === "delete";
  const warning = req.kind === "delete" ? deleteGuard(req.agent).warning : null;
  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      if (req.kind === "delete") await hardDeleteAgent(req.agent.id);
      else {
        const failed = await stopAgents(req.agents.map((a) => a.id));
        if (failed.length) {
          setErr(`Could not stop ${failed.length} of ${req.agents.length}.`);
          setBusy(false);
          return;
        }
      }
      close();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setBusy(false);
    }
  };
  return (
    <div className="modal-back" onMouseDown={close}>
      <div className="shortcut-modal" data-testid={isDelete ? "agent-delete-confirm" : "bulk-stop-confirm"} role="alertdialog" aria-label={isDelete ? "Delete agent" : "Stop agents"} onMouseDown={(e) => e.stopPropagation()}>
        {req.kind === "delete" ? (
          <>
            <h3>Delete agent permanently?</h3>
            <p>
              <b>{cleanTitle(req.agent.title) || req.agent.id.slice(0, 8)}</b> and its history will be removed from the daemon. This cannot be undone. Archive keeps it recoverable.
            </p>
            {warning && (
              <p className="dup-warning" role="alert" data-testid="agent-delete-warning">
                {warning}
              </p>
            )}
          </>
        ) : (
          <>
            <h3>{req.title}</h3>
            <p>
              Stops the current run of {req.agents.length} agent{req.agents.length === 1 ? "" : "s"}. They stay available and can be prompted again.
            </p>
            <ul data-testid="bulk-stop-list" style={{ maxHeight: 220, overflow: "auto", paddingLeft: 18, margin: "6px 0" }}>
              {req.agents.map((a) => (
                <li key={a.id}>
                  {cleanTitle(a.title) || a.id.slice(0, 8)}
                  {a.labels?.role === "lead" || a.labels?.role === "brainstorm" ? <span className="muted small"> · {a.labels.role === "lead" ? "Lead" : "Brainstorm"}</span> : null}
                </li>
              ))}
            </ul>
          </>
        )}
        {err && (
          <p className="dup-warning" role="alert">
            {err}
          </p>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button className="btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button className="btn bad" data-testid="agent-op-confirm" onClick={() => void run()} disabled={busy}>
            {busy ? "Working…" : req.kind === "delete" ? "Delete permanently" : `Stop ${req.agents.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Team ⋯ menu entries (stop all running agents in the team, with a confirm). */
export function teamCtxItems(view: TeamView): CtxItem[] {
  const targets = bulkStopTargets(
    view.members.map((m) => ({ agent: m.agent, teamId: view.team.id })),
    { teamId: view.team.id },
  );
  return [
    {
      label: targets.length ? `Stop All Running (${targets.length})…` : "Stop All Running (none running)",
      run: () => {
        if (targets.length) requestAgentOp({ kind: "stop", title: `Stop all running agents in ${view.team.name}?`, agents: targets });
      },
    },
  ];
}

// ---- shortcut cheat sheet -----------------------------------------------------------------

/** Effective (rebindable) bindings first, then the fixed ones, as [row key, keys, label]. Unbound commands are left out. */
export function shortcutRows(b: Bindings): [string, string, string][] {
  const bound = KEY_COMMANDS.flatMap<[string, string, string]>((c) => (bindingLabel(b, c.id) ? [[c.id, bindingLabel(b, c.id), c.label]] : []));
  return [...bound, ...FIXED_SHORTCUTS.map<[string, string, string]>(([k, d]) => [`fixed:${k}`, k, d])];
}

function ShortcutSheet({ onClose, bindings, onEdit }: { onClose: () => void; bindings: Bindings; onEdit: () => void }) {
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="shortcut-modal" data-testid="shortcut-cheat-sheet" role="dialog" aria-label="Keyboard shortcuts" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Keyboard shortcuts</h3>
        <table>
          <tbody>
            {shortcutRows(bindings).map(([id, k, d]) => (
              <tr key={id}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn ghost small" data-testid="shortcut-sheet-edit" onClick={onEdit}>
          Edit keybindings…
        </button>
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
  /** With a target: open Settings at that setting (a SettingHit id from src/prefs.ts). */
  settings: (target?: string) => void;
  workspaces: () => void;
  toggleFocus: () => void;
  /** Ctrl+J: open the top NEEDS YOU agent. */
  needsYou?: () => void;
};

type Overlay = "search" | "shortcuts" | "quickOpen" | "findInFiles";
export const openOverlay = (which: Overlay) => window.dispatchEvent(new CustomEvent("vs:open-overlay", { detail: which }));

/** Keymap commands this host doesn't run (focus-scoped ones such as block 4's inline edit) go out as this event. */
export const KEY_COMMAND_EVENT = "vs:key-command";

/** The agent shown in the active pane: quick open / find in files work in its cwd. */
function activeNavAgent(all: Member[]): NavAgent | null {
  const s = getPanes();
  const id = s.split && s.activePane === "right" ? s.rightActiveId : s.leftActiveId;
  const m = id ? all.find((x) => x.agent.id === id) : undefined;
  if (!m?.agent.cwd) return null;
  return { id: m.agent.id, cwd: m.agent.cwd, title: cleanTitle(m.agent.title) || m.agent.id.slice(0, 8) };
}

export function CommandPaletteHost(props: {
  members: Member[];
  archived: Member[];
  views: TeamView[];
  onAgent: (m: Member) => void;
  onTeam: (id: string) => void;
  actions: PaletteActions;
}) {
  const [mode, setMode] = useState<"palette" | Overlay | null>(null);
  const [navAgent, setNavAgent] = useState<NavAgent | null>(null);
  const { bindings } = useKeyBindings();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const closed = useRef<string[]>([]);
  const opener = useRef<HTMLElement | null>(null);
  // Capture during render: autoFocus children focus at commit, before any effect would run.
  if (mode && !opener.current) opener.current = document.activeElement as HTMLElement | null;
  useEffect(() => {
    if (!mode && !restoreOnClose.current) opener.current = null;
  }, [mode]);
  const restoreOnClose = useRef(false);
  const modeRef = useRef(mode);
  const dismissRef = useRef<() => void>(() => {});
  const dismiss = () => {
    restoreOnClose.current = true;
    setMode(null);
    setTimeout(() => {
      const el = opener.current;
      opener.current = null;
      restoreOnClose.current = false;
      const cur = document.activeElement;
      if (el && el.isConnected && el !== document.body && (!cur || cur === document.body)) el.focus();
    }, 0);
  };

  const openMode = (m: Overlay) => {
    if (m === "quickOpen" || m === "findInFiles") setNavAgent(activeNavAgent(allRef.current));
    setMode(m);
  };
  const openModeRef = useRef(openMode);
  openModeRef.current = openMode;

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

  // One keymap dispatcher (src/keymap.ts): defaults + Settings › Keybindings overrides. A focus-scoped
  // binding (data-keyscope on an ancestor of the focused element) wins over a global one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return dismissRef.current();
      if (e.isComposing) return;
      const combo = comboFromEvent(e);
      if (!combo) return;
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (typing && !firesWhileTyping(combo)) return;
      const scope = el?.closest?.("[data-keyscope]")?.getAttribute("data-keyscope") as KeyScope | null | undefined;
      const id = resolveCommand(combo, bindingsRef.current, scope ? [scope] : []);
      if (!id) return;
      e.preventDefault();
      runCommandRef.current(id, el);
    };
    const onOpen = (e: Event) => openModeRef.current((e as CustomEvent<string>).detail as Overlay);
    window.addEventListener("keydown", onKey);
    window.addEventListener("vs:open-overlay", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("vs:open-overlay", onOpen);
    };
  }, []);

  dismissRef.current = dismiss;
  modeRef.current = mode;
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  const all = useMemo(() => [...props.members, ...props.archived], [props.members, props.archived]);
  const allRef = useRef(all);
  allRef.current = all;

  const items = useMemo<PaletteItem[]>(() => {
    const act = (id: string, label: string): PaletteItem => {
      const keys = bindingLabel(bindings, id);
      return { id: `action:${id}`, kind: "action", label: keys ? `${label} (${keys})` : label, hint: "" };
    };
    const agents = all.map<PaletteItem>((m) => ({
      id: `agent:${m.agent.id}`,
      kind: "agent",
      label: cleanTitle(m.agent.title) || m.agent.id.slice(0, 8),
      hint: `${m.team.name} ${AGENT_TYPE_LABEL[m.agentType]} ${m.agent.status}${m.agent.archivedAt ? " archived" : ""}`,
      ts: m.agent.updatedAt,
    }));
    const teams = props.views.map<PaletteItem>((v) => ({ id: `team:${v.team.id}`, kind: "team", label: v.team.name, hint: "squad team" }));
    const ops = all.flatMap<PaletteItem>((m) => {
      const t = cleanTitle(m.agent.title) || m.agent.id.slice(0, 8);
      const del: PaletteItem = { id: `action:delete:${m.agent.id}`, kind: "action", label: `Delete Agent: ${t}`, hint: "permanent" };
      const rel: PaletteItem = { id: `action:reload:${m.agent.id}`, kind: "action", label: `Reload Agent: ${t}`, hint: "" };
      return m.agent.archivedAt ? [del] : [del, rel];
    });
    const stops = runningCwds(props.members.map((m) => m.agent)).map<PaletteItem>((c) => ({
      id: `action:stopcwd:${c.cwd}`,
      kind: "action",
      label: `Stop Running Agents in ${c.cwd} (${c.count})`,
      hint: "bulk stop workspace",
    }));
    return [
      act("new", "New Agent"),
      act("quickOpen", "Quick Open File…"),
      act("findInFiles", "Find in Files…"),
      act("search", "Search All Transcripts…"),
      act("shortcuts", "Keyboard Shortcuts"),
      act("settings", "Settings"),
      act("workspaces", "Workspaces"),
      act("focus", "Toggle Focus Mode"),
      act("reopen", "Reopen Closed Tab"),
      ...stops,
      ...teams,
      ...agents,
      ...ops,
      // Last so an empty query still lists agents first; typing "settings" or a setting name finds them.
      ...settingsPaletteItems().map<PaletteItem>((s) => ({ id: `action:${s.id}`, kind: "action", label: s.label, hint: "settings" })),
    ];
  }, [all, props.members, props.views, bindings]);

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
    else if (id.startsWith("delete:") || id.startsWith("reload:")) {
      const target = all.find((x) => x.agent.id === id.slice(id.indexOf(":") + 1));
      if (!target) return;
      if (id.startsWith("delete:")) requestAgentOp({ kind: "delete", agent: target.agent });
      else void reloadAgent(target.agent.id).catch((e) => alert(`Could not reload: ${e}`));
    } else if (id.startsWith("stopcwd:")) {
      const cwd = id.slice("stopcwd:".length);
      const agents = bulkStopTargets(props.members.map((m) => ({ agent: m.agent, teamId: m.team.id })), { cwd });
      if (agents.length) requestAgentOp({ kind: "stop", title: `Stop all running agents in ${cwd}?`, agents });
    } else runAction(id);
  };

  /** Palette actions by id; the keymap runs the same ones. */
  const runAction = (id: string) => {
    setMode(null);
    if (id === "new") props.actions.newAgent();
    else if (id === "search") setMode("search");
    else if (id === "shortcuts") setMode("shortcuts");
    else if (id === "settings") props.actions.settings();
    else if (id.startsWith("setting:")) props.actions.settings(id.slice("setting:".length));
    else if (id === "workspaces") props.actions.workspaces();
    else if (id === "focus") props.actions.toggleFocus();
    else if (id === "reopen") {
      const last = closed.current.pop();
      if (last) openAgent(last);
    } else if (id === "quickOpen" || id === "findInFiles") openMode(id);
  };

  const runCommandRef = useRef<(id: string, target: HTMLElement | null) => void>(() => {});
  runCommandRef.current = (id, target) => {
    if (id === "palette") {
      setQ("");
      setSel(0);
      if (modeRef.current === "palette") dismissRef.current();
      else setMode("palette");
    } else if (id === "quickOpen" || id === "findInFiles") {
      if (modeRef.current === id) dismissRef.current();
      else openMode(id);
    } else if (id === "needsYou") props.actions.needsYou?.();
    else if (KEY_COMMANDS.some((c) => c.id === id && (c.scope ?? "global") === "global")) runAction(id);
    else window.dispatchEvent(new CustomEvent(KEY_COMMAND_EVENT, { detail: { id, target } }));
  };

  return (
    <>
      <ContextMenuHost />
      <AgentOpConfirmHost />
      {mode === "shortcuts" && <ShortcutSheet onClose={dismiss} bindings={bindings} onEdit={() => runAction("setting:keybindings")} />}
      {mode === "quickOpen" && <QuickOpen agent={navAgent} onClose={dismiss} />}
      {mode === "findInFiles" && <FindInFiles agent={navAgent} onClose={dismiss} />}
      {mode === "search" && (
        <TranscriptSearch
          members={all}
          onPick={(m) => {
            setMode(null);
            props.onAgent(m);
            focusComposer(m.agent.id);
          }}
          onClose={dismiss}
        />
      )}
      {mode === "palette" && (
        <div className="modal-back" onMouseDown={dismiss}>
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
