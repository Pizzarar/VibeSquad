import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { PaseoAgent } from "./agentTypes";
import { ChangesPanel } from "./ChangesPanel";
import { FilesPanel } from "./FilesPanel";
import { TerminalPanel } from "./TerminalPanel";
import { boringStateGlyph, boringWorkerIsLive } from "./BoringAde";
import { demoLog, type FeedEntry } from "./demo";
import { DEMO } from "./demoFlag";
import { openAgent } from "./panes";
import { usePaseo } from "./paseo";
import { resolve, type Member } from "./teams";
import { findPinnedTodo, type Entry } from "./Timeline";
import { Ago } from "./ui";
import { condenseReason } from "./condenseReason";
import { isLive } from "./pins";
import type { OpenRightDockDetail } from "./RightDock";

/** Normal-mode single right panel (UX_REVIEW 2.8, PLAN refinement 3): replaces AgentDrawer's inner RightDock. */
export type ContextTab = "Workers" | "Changes" | "Plan" | "Feed" | "Files" | "Terminal";
export const CONTEXT_TABS: ContextTab[] = ["Workers", "Changes", "Plan", "Feed", "Files", "Terminal"];
export const CONTEXT_PANEL_WIDTH = 460;
export const CONTEXT_PANEL_MIN_VIEWPORT = 1600;
export const CONTEXT_OPEN_KEY = "vs.context-panel.open"; // "1" | "0"; absent = follow the viewport
export const CONTEXT_TAB_KEY = "vs.context-panel.tab";

/** Explicit user choice wins when it opens/closes; otherwise open only on wide viewports. */
export function contextPanelOpen(pref: string | null | undefined, viewportWidth: number): boolean {
  const wide = viewportWidth >= CONTEXT_PANEL_MIN_VIEWPORT;
  if (pref === "0") return false;
  if (pref === "1") return true;
  return wide;
}

const listeners = new Set<() => void>();
const readPref = () => {
  try { return localStorage.getItem(CONTEXT_OPEN_KEY); } catch { return null; }
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  window.addEventListener("resize", cb);
  return () => { listeners.delete(cb); window.removeEventListener("resize", cb); };
};
const snapshot = () => contextPanelOpen(readPref(), window.innerWidth);

export function setContextPanelOpen(open: boolean) {
  try { localStorage.setItem(CONTEXT_OPEN_KEY, open ? "1" : "0"); } catch {}
  listeners.forEach((l) => l());
}

export function useContextPanel(): [boolean, () => void] {
  const open = useSyncExternalStore(subscribe, snapshot, () => false);
  return [open, () => setContextPanelOpen(!open)];
}

const TAB_FOR_DOCK: Partial<Record<string, ContextTab>> = { Changes: "Changes", Files: "Files", Terminal: "Terminal" };

function WorkersTab({ agent, laneId }: { agent?: PaseoAgent; laneId: string }) {
  const { agents } = usePaseo();
  const laneWorkers = useMemo(
    () => resolve(agents).filter((m) => m.kind === "worker" && isLive(m) && (m.laneId ?? "").toLowerCase() === laneId.toLowerCase()),
    [agents, laneId],
  );
  const openIsLiveWorker = laneWorkers.some((m) => m.agent.id === agent?.id && boringWorkerIsLive(m));
  const members = laneWorkers.filter((m) => m.agent.id !== agent?.id); // the open agent is the center header, not a sibling
  const [showIdle, setShowIdle] = useState(false);
  const live = members.filter(boringWorkerIsLive);
  const idleMembers = members.filter((m) => !boringWorkerIsLive(m));
  const idle = idleMembers.length;
  const idleToggle = idle > 0 && (
    <button type="button" className="boring-ctx-idle-toggle" data-testid="boring-ctx-idle-toggle" aria-expanded={showIdle} onClick={() => setShowIdle((v) => !v)}>
      {showIdle ? "▾" : "▸"} {idle} idle worker{idle === 1 ? "" : "s"}
    </button>
  );
  const idleList = showIdle && idleMembers.map((m) => renderWorker(m, agent, true));
  if (live.length === 0)
    return (
      <div className="boring-ctx-list" data-testid="boring-ctx-workers">
        <div className="boring-ctx-empty" data-testid="boring-ctx-workers-empty">{openIsLiveWorker ? "No other live workers in this lane." : "No live workers in this lane."}</div>
        {idleToggle}
        {idleList}
      </div>
    );
  return (
    <div className="boring-ctx-list" data-testid="boring-ctx-workers">
      {live.map((m) => renderWorker(m, agent, false))}
      {idleToggle}
      {idleList}
    </div>
  );
}

function renderWorker(m: Member, agent: PaseoAgent | undefined, idle: boolean) {
  {
    {
        const glyph = boringStateGlyph(m.agent.status, m.attention?.tone);
        return (
          <button type="button" key={m.agent.id} className={`boring-ctx-worker${idle ? " idle" : ""}`} data-testid={`boring-ctx-worker-${m.agent.id}`} onClick={() => openAgent(m.agent.id)}>
            <span className={`boring-dot st-${glyph}`} aria-hidden />
            <span className="boring-ctx-worker-name">{m.agent.title ?? m.agent.id.slice(0, 8)}</span>
            <span className="boring-ctx-worker-age muted"><Ago iso={m.agent.updatedAt} /></span>
            {(m.attention?.reason || m.agent.status === "error") && (
              <span className="boring-ctx-worker-meta" title={m.attention?.reason ?? m.agent.status}>{condenseReason(m.attention?.reason ?? m.agent.status)}</span>
            )}
          </button>
        );
    }
  }
}

function PlanTab({ entries }: { entries: Entry[] }) {
  const todo = findPinnedTodo(entries);
  const items: any[] = todo && Array.isArray(todo.item.items) ? todo.item.items : [];
  if (items.length === 0) return <div className="boring-ctx-empty" data-testid="boring-ctx-plan-empty">No plan yet. A task list appears here once the agent writes one.</div>;
  const done = items.filter((t) => t.completed || t.status === "completed").length;
  return (
    <div className="boring-ctx-list" data-testid="boring-ctx-plan">
      <div className="boring-ctx-foot muted">{done}/{items.length} done</div>
      {items.map((t, i) => {
        const state = t.completed || t.status === "completed" ? "done" : t.status === "in_progress" ? "doing" : "todo";
        return (
          <div key={i} className={`boring-ctx-plan-row ${state}`}>
            <span className="boring-ctx-plan-mark" aria-hidden>{state === "done" ? "✓" : state === "doing" ? "◐" : "○"}</span>
            <span>{t.text}</span>
          </div>
        );
      })}
    </div>
  );
}

function FeedTab({ teamId, laneId }: { teamId: string; laneId: string }) {
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let dead = false;
    const load = () => {
      const p = DEMO ? Promise.resolve(demoLog()) : fetch(`/__vibesquad/log?team=${encodeURIComponent(teamId)}`).then((r) => (r.ok ? (r.json() as Promise<FeedEntry[]>) : Promise.reject(new Error(`log fetch failed (${r.status})`))));
      p.then((e) => { if (!dead) { setEntries(e); setError(""); } }).catch((e) => !dead && setError(String(e)));
    };
    load();
    if (DEMO) return () => { dead = true; };
    const t = setInterval(() => document.hidden || load(), 10_000);
    return () => { dead = true; clearInterval(t); };
  }, [teamId]);
  const rows = entries.filter((e) => !e.lane || e.lane.toLowerCase() === laneId.toLowerCase()).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 40);
  if (error) return <div className="boring-ctx-empty" role="alert">{error}</div>;
  if (rows.length === 0) return <div className="boring-ctx-empty" data-testid="boring-ctx-feed-empty">No log events for this lane yet.</div>;
  return (
    <div className="boring-ctx-list" data-testid="boring-ctx-feed">
      {rows.map((e, i) => (
        <div key={`${e.ts}-${i}`} className={`boring-ctx-feed-row t-${e.type}`}>
          <div className="boring-ctx-feed-head"><span className="boring-ctx-feed-type">{e.type}</span><span className="muted">{e.agent} · <Ago iso={e.ts} /></span></div>
          <div className="boring-ctx-feed-text">{e.text}</div>
        </div>
      ))}
    </div>
  );
}

/** `agent` is absent on a lane with no live Lead/Brainstorm (idea-468): Workers, Plan and Feed still work; agent-bound tabs say so. */
export type NoAgentAction = { prompt: string; label: string; disabled?: boolean; run: () => void };
export function BoringContextPanel({ agent, entries, teamId, laneId, noAgentAction }: { agent?: PaseoAgent; entries: Entry[]; teamId: string; laneId: string; noAgentAction?: NoAgentAction }) {
  const [open, toggle] = useContextPanel();
  const [tab, setTab] = useState<ContextTab>(() => {
    const t = (() => { try { return localStorage.getItem(CONTEXT_TAB_KEY); } catch { return null; } })();
    return (CONTEXT_TABS as string[]).includes(t ?? "") ? (t as ContextTab) : "Workers";
  });
  const [target, setTarget] = useState<{ file: string | null; line: number | null; nonce: number }>({ file: null, line: null, nonce: 0 });
  useEffect(() => { try { localStorage.setItem(CONTEXT_TAB_KEY, tab); } catch {} }, [tab]);
  // openRightDockTab() (file links, Open in Changes, quick open) lands here in Normal mode.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<OpenRightDockDetail>).detail;
      if (!d) return;
      const next = TAB_FOR_DOCK[d.tab];
      if (!next) return;
      setContextPanelOpen(true);
      setTab(next);
      if (d.filePath !== undefined) setTarget({ file: d.filePath, line: d.line ?? null, nonce: d.nonce ?? 0 });
    };
    // R3.1: the sidebar's "▸ N running · M idle" fold opens the Workers tab.
    const onTab = (e: Event) => {
      const t = (e as CustomEvent<{ tab?: string }>).detail?.tab;
      if (!(CONTEXT_TABS as string[]).includes(t ?? "")) return;
      setContextPanelOpen(true);
      setTab(t as ContextTab);
    };
    window.addEventListener("vs:open-right-dock", onOpen);
    window.addEventListener("vs:open-context-tab", onTab);
    return () => { window.removeEventListener("vs:open-right-dock", onOpen); window.removeEventListener("vs:open-context-tab", onTab); };
  }, []);

  const { agents } = usePaseo();
  const badge = useMemo(() => {
    if (open) return null; // badge only renders on the collapsed rail
    let err = 0, attn = 0;
    for (const m of resolve(agents)) {
      if (m.kind !== "worker" || !isLive(m) || m.agent.id === agent?.id || (m.laneId ?? "").toLowerCase() !== laneId.toLowerCase()) continue;
      const g = boringStateGlyph(m.agent.status, m.attention?.tone);
      if (g === "err") err++;
      else if (g === "attn") attn++;
    }
    const n = err + attn;
    return n > 0 ? { tone: err > 0 ? "err" : "attn", n } : null;
  }, [agents, laneId, open, agent?.id]);

  if (!open)
    return (
      <aside className="boring-context-panel collapsed" data-testid="boring-context-panel" data-open="false">
        <button type="button" className="boring-ctx-rail-btn" data-testid="boring-context-toggle" aria-expanded={false} title="Open context panel" onClick={toggle}>
          {badge && <span className={`boring-ctx-rail-badge st-${badge.tone}`} data-testid="boring-ctx-rail-badge" aria-label={`${badge.n} need attention`}>{badge.n}</span>}
          ◀ Context
        </button>
      </aside>
    );
  return (
    <aside className="boring-context-panel" data-testid="boring-context-panel" data-open="true" data-tab={tab} style={{ width: CONTEXT_PANEL_WIDTH }}>
      <div className="boring-ctx-tabs" role="tablist">
        {CONTEXT_TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`boring-ctx-tab${tab === t ? " on" : ""}`} data-testid={`boring-context-tab-${t.toLowerCase()}`} onClick={() => setTab(t)}>{t}</button>
        ))}
        <button type="button" className="boring-ctx-collapse" data-testid="boring-context-toggle" aria-expanded title="Collapse context panel" onClick={toggle}>▶</button>
      </div>
      <div className="boring-ctx-body" data-testid="boring-context-body">
        {tab === "Workers" && <WorkersTab agent={agent} laneId={laneId} />}
        {!agent && (tab === "Changes" || tab === "Files" || tab === "Terminal") && (
          <div className="boring-ctx-empty" data-testid="boring-ctx-no-agent">
            {noAgentAction ? `${noAgentAction.prompt} ${tab}.` : `Start a Lead or Brainstorm to see ${tab}.`}
            {noAgentAction && <> <button type="button" className="boring-ctx-idle-toggle" data-testid="boring-ctx-no-agent-action" disabled={noAgentAction.disabled} onClick={noAgentAction.run}>{noAgentAction.label}</button></>}
          </div>
        )}
        {agent && tab === "Changes" && <ChangesPanel agent={agent} />}
        {tab === "Plan" && <PlanTab entries={entries} />}
        {tab === "Feed" && <FeedTab teamId={teamId} laneId={laneId} />}
        {agent && tab === "Files" && <FilesPanel agent={agent} targetFile={target.file} targetLine={target.line} targetNonce={target.nonce} />}
        {agent && tab === "Terminal" && <TerminalPanel agent={agent} />}
      </div>
    </aside>
  );
}
