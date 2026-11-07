import { memo, useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { getPaseoState, subscribePaseo } from "./paseo";
import { AgentDrawer } from "./AgentDrawer";
import { useDraft } from "./drafts";
import { classifyAgent, leadVariant } from "./teams";
import { exitSquadsHome } from "./pinFocus";
import { setFullView } from "./PinGrid";
import { StatusDot, cleanTitle } from "./ui";
import { Avatar } from "./pixel";
import {
  activateTab,
  closeTab,
  isShown,
  moveTab,
  reopenClosedTab,
  setActivePane,
  setSheet,
  setFocus,
  toggleFocus,
  toggleSplit,
  useClosedTabCount,
  usePanes,
  type Pane,
} from "./panes";

// The chat column: one tab strip per pane, and every mounted drawer in one flat keyed list.
// A drawer's position in that list never changes (panes.ts keeps first-mount order) and moving a
// tab between panes only changes its CSS class, so nothing here ever remounts a drawer.

/** One agent, re-rendering only when that agent's object changes. */
const useAgent = (id: string): PaseoAgent | undefined =>
  useSyncExternalStore(subscribePaseo, () => {
    const s = getPaseoState();
    return s.agents.get(id) ?? s.archivedAgents.get(id);
  });

const shortTitle = (a: PaseoAgent | undefined, id: string) => {
  const t = a ? cleanTitle(a.title) : id.slice(0, 8);
  return t.length > 22 ? t.slice(0, 21) + "…" : t;
};

const Tab = memo(function Tab({ id, pane, on, split }: { id: string; pane: Pane; on: boolean; split: boolean }) {
  const a = useAgent(id);
  const [draft] = useDraft(`${id}:draft`);
  return (
    <div
      className={`pane-tab ${on ? "on" : ""} pane-${pane}`}
      role="tab"
      aria-selected={on}
      title={a?.title ?? id}
      onClick={() => activateTab(pane, id)}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(id);
        }
      }}
    >
      {a ? (
        <Avatar id={id} provider={a.provider} agentType={classifyAgent(a)} variant={leadVariant(a)} size={32} />
      ) : (
        <span className="tab-ghost" />
      )}
      <span className="tab-title">{shortTitle(a, id)}</span>{a && <StatusDot agent={a} />}
      {draft.trim() && (
        <span className="tab-draft" title="Unsent draft">
          ✎
        </span>
      )}
      <button
        className="tab-btn tab-move"
        title={pane === "left" ? (split ? "Move to right pane" : "Open in split (right pane)") : "Move to left pane"}
        onClick={(e) => {
          e.stopPropagation();
          moveTab(id);
        }}
      >
        {pane === "left" ? "⇥" : "⇤"}
      </button>
      <button
        className="tab-btn tab-x"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          closeTab(id);
        }}
      >
        ×
      </button>
    </div>
  );
});

function TabStrip(props: { pane: Pane; tabs: string[]; activeId: string | null; split: boolean; focus: boolean; tools: boolean }) {
  const { pane, tabs, activeId, split, focus, tools } = props;
  const closedCount = useClosedTabCount();
  return (
    <div className={`pane-tabs pane-${pane}`} role="tablist" onPointerDownCapture={() => setActivePane(pane)}>
      <button className="tab-btn pane-menu" title="Agents and teams" onClick={() => setSheet(true)}>
        ☰
      </button>
      <div className="pane-tab-list">
        {tabs.map((id) => (
          <Tab key={id} id={id} pane={pane} on={id === activeId} split={split} />
        ))}
      </div>
      {tools && (
        <div className="pane-tools">
          {closedCount > 0 && (
            <button className="btn small" data-testid="reopen-closed-tab-btn" title="Reopen closed tab (Ctrl+Shift+T)" onClick={reopenClosedTab}>
              ↺ Reopen tab
            </button>
          )}
          <button className={`btn small ${split ? "on" : ""}`} title="Two panes side by side (Shift+click an agent)" onClick={toggleSplit}>
            ◫ SPLIT
          </button>
          <button className={`btn small ${focus ? "on" : ""}`} title="Focus chat (Ctrl+.)" onClick={toggleFocus}>
            ▣ FOCUS
          </button>
          <button
            className="btn small"
            data-testid="pane-teams-home-btn"
            title="Back to the Teams / Brainstorm grid"
            onClick={() => {
              setFocus(false);
              setFullView(false);
              exitSquadsHome();
            }}
          >
            ⊞ TEAMS
          </button>
          <span className="kbd">Ctrl+.</span>
        </div>
      )}
    </div>
  );
}

export const DrawerSlot = memo(function DrawerSlot(props: {
  id: string;
  pane: Pane;
  shown: boolean;
  onSuccessor: (id: string) => void;
}) {
  const { id, pane, shown, onSuccessor } = props;
  const [everShown, setEverShown] = useState(shown);
  useEffect(() => {
    if (shown) setEverShown(true);
  }, [shown]);
  const agent = useAgent(id);
  const close = useCallback(() => closeTab(id), [id]);
  const successor = useCallback(() => onSuccessor(id), [onSuccessor, id]);
  if (!everShown) {
    return <div className={`pane-slot pane-${pane}`} data-agent={id} style={{ display: "none" }} />;
  }
  return (
    <div
      className={`pane-slot pane-${pane}`}
      data-agent={id}
      style={{ display: shown ? "flex" : "none" }}
      onPointerDownCapture={() => setActivePane(pane)}
    >
      {agent ? (
        <AgentDrawer agent={agent} onClose={close} onSuccessor={successor} active={shown} />
      ) : (
        <div className="pane-empty">Loading {id.slice(0, 8)}… (or no longer on the daemon)</div>
      )}
    </div>
  );
});

function EmptyPane({ pane, focus }: { pane: Pane; focus: boolean }) {
  return (
    <div className={`pane-slot pane-empty pane-${pane}`} onPointerDownCapture={() => setActivePane(pane)}>
      {pane === "right" ? (
        <span>Shift+click an agent, or use ⇥ on a tab.</span>
      ) : focus ? (
        <span>No lead on this team. Pick an agent from the rail.</span>
      ) : (
        <span>Click an agent to open it here.</span>
      )}
    </div>
  );
}

/** `header` (pinned focus view) replaces the tab strips in row 1; the drawer list is unchanged. */
/**
 * `excludeIds` (sky-gods hub): agents that another surface already mounts (the sky zones). They are NOT mounted here at all,
 * so their drawer portals, key handlers and timeline subscriptions exist exactly once.
 */
export const AgentPanes = memo(function AgentPanes({ onSuccessor, header, excludeIds }: { onSuccessor: (id: string) => void; header?: ReactNode; excludeIds?: readonly string[] }) {
  const s = usePanes();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        reopenClosedTab();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const mountedIds = excludeIds?.length ? s.mounted.filter((id) => !excludeIds.includes(id)) : s.mounted;
  const paneOf = (id: string): Pane => (s.rightTabs.includes(id) ? "right" : "left");
  return (
    <section className={`agent-panes ${s.split ? "split" : ""} active-${s.activePane}`}>
      {header ?? <TabStrip pane="left" tabs={s.leftTabs} activeId={s.leftActiveId} split={s.split} focus={s.focus} tools={!s.split} />}
      {!header && s.split && <TabStrip pane="right" tabs={s.rightTabs} activeId={s.rightActiveId} split focus={s.focus} tools />}
      {mountedIds.map((id) => (
        <DrawerSlot key={id} id={id} pane={paneOf(id)} shown={isShown(s, id)} onSuccessor={onSuccessor} />
      ))}
      {!s.leftActiveId && !excludeIds && <EmptyPane pane="left" focus={s.focus} />}
      {s.split && !s.rightActiveId && <EmptyPane pane="right" focus={s.focus} />}
    </section>
  );
});
