import { memo, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { getPaseoState, subscribePaseo } from "./paseo";
import { useDraft } from "./drafts";
import { railAlerts } from "./FocusRail";
import { activateTab, closeTab, getPanes, openAgent, setSheet, subscribePanes, usePanes, type Pane } from "./panes";
import { classifyAgent, leadVariant } from "./teams";
import { StatusDot, cleanTitle, sameList, subscribeTree, useSelect } from "./ui";
import { Avatar } from "./pixel";

// Mobile (<600px) view toggle so the user can view the Team roster without closing mounted agent tabs.
let mobileTeamView = false;
const mobileViewListeners = new Set<() => void>();

export function setMobileTeamView(v: boolean) {
  if (mobileTeamView === v) return;
  mobileTeamView = v;
  mobileViewListeners.forEach((l) => l());
}

export function useMobileTeamView(): boolean {
  return useSyncExternalStore(
    (l) => {
      mobileViewListeners.add(l);
      return () => void mobileViewListeners.delete(l);
    },
    () => mobileTeamView,
  );
}

/** Open the slide-out Focus Rail / team switcher sheet on mobile. */
export function openRailSheet() {
  setSheet(true);
}

const useAgent = (id: string): PaseoAgent | undefined =>
  useSyncExternalStore(subscribePaseo, () => {
    const s = getPaseoState();
    return s.agents.get(id) ?? s.archivedAgents.get(id);
  });

const shortTabTitle = (a: PaseoAgent | undefined, id: string) => {
  const t = a ? cleanTitle(a.title) : id.slice(0, 8);
  return t.length > 28 ? t.slice(0, 27) + "…" : t;
};

const MobileTabRow = memo(function MobileTabRow({
  id,
  pane,
  active,
  onSelect,
}: {
  id: string;
  pane: Pane;
  active: boolean;
  onSelect: (pane: Pane, id: string) => void;
}) {
  const a = useAgent(id);
  const [draft] = useDraft(`${id}:draft`);
  return (
    <div
      className={`mobile-tab-row ${active ? "on" : ""} pane-${pane}`}
      role="option"
      aria-selected={active}
      data-testid={`mobile-tab-item-${id}`}
      onClick={() => onSelect(pane, id)}
    >
      {a ? (
        <Avatar id={id} provider={a.provider} agentType={classifyAgent(a)} variant={leadVariant(a)} size={32} />
      ) : (
        <span className="tab-ghost" />
      )}
      <span className="mobile-tab-title">{shortTabTitle(a, id)}</span>
      {a && <StatusDot agent={a} />}
      {draft.trim() && (
        <span className="tab-draft" title="Unsent draft">
          ✎
        </span>
      )}
      <button
        className="btn ghost small mobile-tab-close"
        title="Close tab"
        aria-label={`Close ${shortTabTitle(a, id)}`}
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

export function highlightNeedsYouTarget() {
  requestAnimationFrame(() => {
    const target = document.querySelector(".pane-slot[style*='flex'] .perm, .pane-slot[style*='flex'] .you-bar, .pane-slot[style*='flex'] .banner");
    if (target instanceof HTMLElement) {
      target.classList.add("NeedsYouHighlight");
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

export const MobileBar = memo(function MobileBar() {
  const s = usePanes();
  const inTeamView = useMobileTeamView();
  const [tabsOpen, setTabsOpen] = useState(false);
  const alerts = useSelect(subscribeTree, () => railAlerts().list, sameList);

  const allTabs: { id: string; pane: Pane }[] = [
    ...s.leftTabs.map((id) => ({ id, pane: "left" as const })),
    ...s.rightTabs.map((id) => ({ id, pane: "right" as const })),
  ];
  const activeId = s.activePane === "right" && s.split ? s.rightActiveId : s.leftActiveId;

  // Whenever the active agent tab changes, show the agent pane on mobile.
  useEffect(() => {
    let prevActive = getPanes().activePane === "right" && getPanes().split ? getPanes().rightActiveId : getPanes().leftActiveId;
    let prevCount = getPanes().leftTabs.length + getPanes().rightTabs.length;
    return subscribePanes(() => {
      const cur = getPanes();
      const nextActive = cur.activePane === "right" && cur.split ? cur.rightActiveId : cur.leftActiveId;
      const nextCount = cur.leftTabs.length + cur.rightTabs.length;
      if (nextActive && (nextActive !== prevActive || nextCount > prevCount)) {
        setMobileTeamView(false);
      }
      prevActive = nextActive;
      prevCount = nextCount;
    });
  }, []);

  const onTeamsClick = useCallback(() => {
    setTabsOpen(false);
    setSheet(!getPanes().sheet);
  }, []);

  const onTabsClick = useCallback(() => {
    setSheet(false);
    setTabsOpen((v) => !v);
  }, []);

  const onSelectTab = useCallback((pane: Pane, id: string) => {
    setMobileTeamView(false);
    activateTab(pane, id);
    setTabsOpen(false);
  }, []);

  const onToggleTeamPane = useCallback(() => {
    setTabsOpen(false);
    setSheet(false);
    if (allTabs.length > 0) {
      setMobileTeamView(!mobileTeamView);
    }
  }, [allTabs.length]);

  const onNeedsYouClick = useCallback(() => {
    setTabsOpen(false);
    setSheet(false);
    if (!alerts.length) return;
    setMobileTeamView(false);
    const currentIdx = alerts.findIndex((m) => m.agent.id === activeId);
    const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % alerts.length : 0;
    const target = alerts[nextIdx] ?? alerts[0];
    if (target) {
      openAgent(target.agent.id);
      highlightNeedsYouTarget();
    }
  }, [alerts, activeId]);

  return (
    <>
      {s.sheet && <div className="mobile-sheet-backdrop" onClick={() => setSheet(false)} aria-hidden="true" />}
      {tabsOpen && (
        <>
          <div className="mobile-sheet-backdrop" onClick={() => setTabsOpen(false)} aria-hidden="true" />
          <div className="mobile-tabs-sheet" role="dialog" aria-label="Open agent tabs" data-testid="mobile-tabs-sheet">
            <div className="mobile-tabs-head">
              <span className="mobile-tabs-title">OPEN TABS ({allTabs.length})</span>
              {allTabs.length > 0 && (
                <button
                  className="btn small ghost"
                  onClick={onToggleTeamPane}
                  data-testid="mobile-toggle-team-view"
                >
                  {inTeamView ? "▣ Active Pane" : "◂ Team View"}
                </button>
              )}
              <button className="btn small ghost" onClick={() => setTabsOpen(false)} aria-label="Close tab switcher">
                ✕
              </button>
            </div>
            <div className="mobile-tabs-list" role="listbox">
              {allTabs.length === 0 ? (
                <div className="mobile-tabs-empty muted small">
                  No open tabs. Tap an agent on the team page or in ☰ Teams.
                </div>
              ) : (
                allTabs.map(({ id, pane }) => (
                  <MobileTabRow key={id} id={id} pane={pane} active={id === activeId && !inTeamView} onSelect={onSelectTab} />
                ))
              )}
            </div>
          </div>
        </>
      )}
      <nav className="mobile-bottom-bar" role="navigation" aria-label="Mobile navigation" data-testid="mobile-bottom-bar">
        <button
          type="button"
          className={`mobile-bar-btn mobile-bar-teams ${s.sheet ? "on" : ""}`}
          onClick={onTeamsClick}
          data-testid="mobile-bar-teams"
        >
          <span className="mobile-bar-icon">☰</span>
          <span className="mobile-bar-label">Teams</span>
        </button>
        <button
          type="button"
          className={`mobile-bar-btn mobile-bar-tabs ${tabsOpen ? "on" : ""}`}
          onClick={onTabsClick}
          data-testid="mobile-bar-tabs"
        >
          <span className="mobile-bar-icon">🗂</span>
          <span className="mobile-bar-label">Tabs ({allTabs.length})</span>
        </button>
        <button
          type="button"
          className={`mobile-bar-btn mobile-bar-needs ${alerts.length > 0 ? "has-alerts" : ""}`}
          onClick={onNeedsYouClick}
          data-testid="mobile-bar-needs-you"
          title={alerts.length > 0 ? `Jump to ${alerts[0].agent.title ?? "agent"} (${alerts.length} need you)` : "0 agents need you"}
        >
          <span className="mobile-bar-icon">⚡</span>
          <span className="mobile-bar-label">{alerts.length > 0 ? `Needs you (${alerts.length})` : "0"}</span>
        </button>
      </nav>
    </>
  );
});
