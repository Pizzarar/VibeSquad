import { memo, useState } from "react";
import type { ProviderQuotaView } from "./antigravity";
import { ALERT_LABEL, budgetFor, fmtTok, leadVariant, usedTokens, type Member, type TeamView } from "./teams";
import {
  StatusDot,
  alertOrder,
  cleanTitle,
  clickable,
  derived,
  getTreeState,
  sameList,
  sameMember,
  selectAgent,
  subscribeTree,
  toggleTreeOpen,
  useSelect,
} from "./ui";
import { setSheet, toggleFocus, useAgentPane } from "./panes";
import { Avatar, NeonEmblem, providerSpec } from "./pixel";

// Focus rail (docs/design/FOCUS_CHAT.md): an interrupt queue and a switchboard, not a roster.
// NEEDS YOU across all teams, the current team's lanes one level deep, one line per other team.
// Also the <600px tab/team switcher sheet. Nothing here spawns an agent.

const NEEDS_MAX = 5;
const PARENT = "paseo.parent-agent-id";

let ac: { members: Member[] | null; list: Member[]; ids: Set<string> } = { members: null, list: [], ids: new Set() };

/** Every team's alerts in alert order (permission › needs-aub › error › finished). Cached per store change. */
export function railAlerts() {
  const { members } = derived();
  if (ac.members !== members) {
    const list = members.filter((m) => m.attention && m.kind !== "old-lead" && !m.agent.archivedAt).sort(alertOrder);
    ac = { members, list, ids: new Set(list.map((m) => m.agent.id)) };
  }
  return ac;
}

const isLive = (m: Member) => m.agent.status !== "idle" && m.agent.status !== "closed" && !m.agent.archivedAt;
const name = (m: Member) => cleanTitle(m.agent.title) || m.agent.id.slice(0, 8);

const RailRow = memo(
  function RailRow({ m, alert, teamSuffix }: { m: Member; alert?: boolean; teamSuffix?: string }) {
    const a = m.agent;
    const pane = useAgentPane(a.id);
    const used = usedTokens(m);
    const pct = Math.min(1, used / budgetFor(m));
    const tone = pct >= 0.9 ? "hot" : pct >= 0.72 ? "warn" : "";
    return (
      <div
        className={`rrow ${alert ? "q" : ""} ${pane ? `open pane-${pane}` : ""} ${a.status}`}
        title={`${a.title ?? a.id}${m.attention ? ` · ${m.attention.reason}` : ""}`}
        {...clickable(() => selectAgent(a.id))}
      >
        <Avatar id={a.id} provider={a.provider} agentType={m.agentType} variant={leadVariant(m)} size={28} />
        <span className="rcol">
          <span className="rname">
            {m.kind === "lead" ? "★ " : ""}
            {name(m)}
            {!alert && m.kind === "brainstorm" && <b className="talk-here rail-role-tag"> · TALK HERE</b>}
            {!alert && m.kind === "lead" && <span className="runs-the-work rail-role-tag"> · RUNS THE WORK</span>}
            {teamSuffix && <span className="muted"> · {teamSuffix}</span>}
          </span>
          {alert && m.attention ? (
            <span className="rwhy">
              {ALERT_LABEL[m.attention.tone]} · {m.attention.reason}
            </span>
          ) : (
            <span className={`rmini ${tone}`}>
              <i style={{ width: `${pct * 100}%` }} />
            </span>
          )}
        </span>
        {!alert && pct >= 0.72 && <span className="rtok">{fmtTok(used)}</span>}
        {!alert && <StatusDot agent={a} />}
      </div>
    );
  },
  (p, n) => sameMember(p.m, n.m) && p.alert === n.alert && p.teamSuffix === n.teamSuffix,
);

function NeedsYou({ teamId }: { teamId: string }) {
  const list = useSelect(subscribeTree, () => railAlerts().list, sameList);
  const [all, setAll] = useState(false);
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, NEEDS_MAX);
  return (
    <div className="rsec-block">
      <div className="rsec hot">
        ● NEEDS YOU · {list.length}
        <span className="muted rsec-r">ALL TEAMS · Ctrl+J</span>
      </div>
      {shown.map((m) => (
        <RailRow key={m.agent.id} m={m} alert teamSuffix={m.team.id !== teamId ? m.team.name : undefined} />
      ))}
      {list.length > NEEDS_MAX && (
        <button className="rmore" onClick={() => setAll(!all)}>
          {all ? "▴ fewer" : `+${list.length - NEEDS_MAX} more`}
        </button>
      )}
    </div>
  );
}

/** Live rows, each with its "▸ N under X" line, then one "▸ X idle · Y closed" line for the rest. */
function RailList({ list, depth }: { list: Member[]; depth: number }) {
  const [showRest, setShowRest] = useState(false);
  const live = list.filter(isLive);
  const rest = list.filter((m) => !isLive(m));
  const idle = rest.filter((m) => m.agent.status === "idle" && !m.agent.archivedAt).length;
  const closed = rest.length - idle;
  const rows = showRest ? [...live, ...rest] : live;
  return (
    <>
      {rows.map((m) => (
        <div key={m.agent.id} className="rnode">
          <RailRow m={m} />
          <Deeper parent={m} depth={depth} />
        </div>
      ))}
      {rest.length > 0 && (
        <button className="rmore" onClick={() => setShowRest(!showRest)}>
          {showRest ? "▾ hide" : "▸"} {[idle && `${idle} idle`, closed && `${closed} closed`].filter(Boolean).join(" · ")}
        </button>
      )}
    </>
  );
}

/** Children of `parentId`, minus agents already listed in NEEDS YOU. */
function RailBranch({ parentId, depth }: { parentId: string; depth: number }) {
  const kids = useSelect(
    subscribeTree,
    () => {
      const { ids } = railAlerts();
      return derived()
        .tree.childrenOf(parentId, true)
        .filter((m) => !ids.has(m.agent.id) && m.kind !== "old-lead");
    },
    sameList,
  );
  if (!kids.length) return null;
  return (
    <div className="rtree">
      <RailList list={kids} depth={depth} />
    </div>
  );
}

/** Levels past the first stay folded behind "▸ N under X" (the tree's shared open state). */
function Deeper({ parent, depth }: { parent: Member; depth: number }) {
  const key = useSelect(
    subscribeTree,
    () => {
      const { tree } = derived();
      const n = tree.totalDescendants(parent.agent.id, true);
      return n ? `${n}|${getTreeState().open.has(parent.agent.id) ? 1 : 0}` : "";
    },
    (a, b) => a === b,
  );
  if (!key) return null;
  const [n, open] = key.split("|").map(Number);
  return (
    <>
      <button className="rmore" onClick={() => toggleTreeOpen(parent.agent.id)}>
        {open ? "▾" : "▸"} {n} under {name(parent)}
      </button>
      {open === 1 && <RailBranch parentId={parent.agent.id} depth={depth + 1} />}
    </>
  );
}

function LaneBlock({
  lane,
  teamIds,
  collapsed,
  onToggle,
}: {
  lane: TeamView["lanes"][number];
  teamIds: Set<string>;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const alerted = useSelect(subscribeTree, () => railAlerts().ids, (a, b) => a === b);
  // DESIGN T1-4: Brainstorm ("TALK HERE") first, Lead ("RUNS THE WORK") second.
  const roots = [lane.brainstorm, lane.lead].filter((m): m is Member => !!m);
  // Workers whose parent isn't on this team would otherwise be invisible in a tree view.
  const orphans = lane.members.filter((m) => {
    if (m.kind !== "worker" || alerted.has(m.agent.id)) return false;
    const p = ((m.agent.labels ?? {}) as Record<string, string>)[PARENT];
    return !p || !teamIds.has(p);
  });
  if (!roots.length && !orphans.length) return null;
  return (
    <div className="rsec-block">
      <button
        type="button"
        className="rsec rsec-toggle"
        aria-expanded={!collapsed}
        onClick={onToggle}
        data-testid={`focus-rail-lane-toggle-${lane.lane.id}`}
      >
        <span>{collapsed ? "▸" : "▾"}</span>
        <span>{lane.lane.name} LANE</span>
      </button>
      {!collapsed && (
        <>
          {roots.map((r) => (
            <div key={r.agent.id} className="rnode root">
              {!alerted.has(r.agent.id) && <RailRow m={r} />}
              <RailBranch parentId={r.agent.id} depth={1} />
            </div>
          ))}
          {orphans.length > 0 && <RailList list={orphans} depth={1} />}
        </>
      )}
    </div>
  );
}

const OtherTeam = memo(function OtherTeam({ v, onTeam }: { v: TeamView; onTeam: (id: string) => void }) {
  return (
    <button className="oteam" onClick={() => onTeam(v.team.id)} title={`Show ${v.team.name} in the rail (tabs stay open)`}>
      <NeonEmblem color={v.team.color} seed={v.team.id} size={14} />
      <span className="oteam-name">{v.team.name}</span>
      {v.needsYou > 0 && <span className="badge alert">{v.needsYou}</span>}
      <span className="muted">{v.running ? `${v.running}▶` : "idle"}</span>
    </button>
  );
});

export const FocusRail = memo(function FocusRail(props: {
  views: TeamView[];
  view: TeamView | undefined;
  onTeam: (id: string) => void;
  usage: ProviderQuotaView[];
  sidebarCollapsed?: boolean;
  onToggleSidebarCollapse?: () => void;
  onStartResize?: (e: React.MouseEvent) => void;
}) {
  const { views, view, onTeam } = props;
  const [teamCollapsed, setTeamCollapsed] = useState(false);
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(() => new Set());
  const teamIds = new Set(view?.members.map((m) => m.agent.id) ?? []);
  const hot = props.usage.filter((u) => (u.usedPct ?? 0) >= 85);
  const laneIds = (view?.lanes ?? []).map((l) => l.lane.id);
  const allLanesCollapsed = teamCollapsed || (laneIds.length > 0 && laneIds.every((id) => collapsedLanes.has(id)));

  const toggleLane = (laneId: string) => {
    setCollapsedLanes((prev) => {
      const next = new Set(prev);
      if (next.has(laneId)) next.delete(laneId);
      else next.add(laneId);
      return next;
    });
  };

  const toggleAllLanes = () => {
    if (allLanesCollapsed) {
      setTeamCollapsed(false);
      setCollapsedLanes(new Set());
    } else {
      setCollapsedLanes(new Set(laneIds));
    }
  };

  return (
    <nav className={`focus-rail ${props.sidebarCollapsed ? "collapsed" : ""}`}>
      <div className="rhead">
        {view && <NeonEmblem color={view.team.color} seed={view.team.id} size={18} />}
        <button
          type="button"
          className="rhead-name rhead-toggle"
          aria-expanded={!teamCollapsed}
          onClick={() => setTeamCollapsed((c) => !c)}
          title={teamCollapsed ? `Expand ${view?.team.name ?? "team"}` : `Collapse ${view?.team.name ?? "team"}`}
          data-testid="focus-rail-team-toggle"
        >
          <span className="team-chevron">{teamCollapsed ? "▸" : "▾"}</span> {view?.team.name ?? "…"}
        </button>
        <button
          type="button"
          className="btn ghost small"
          onClick={toggleAllLanes}
          title={allLanesCollapsed ? "Expand all lanes" : "Collapse all lanes"}
          data-testid="focus-rail-collapse-all"
        >
          {allLanesCollapsed ? "Expand all" : "Collapse all"}
        </button>
        <button className="btn small" title="Back to the team page (Ctrl+.)" onClick={toggleFocus}>
          ◂ TEAM
        </button>
        {props.onToggleSidebarCollapse && (
          <button
            type="button"
            className="btn ghost small sidebar-collapse-btn"
            onClick={props.onToggleSidebarCollapse}
            title={props.sidebarCollapsed ? "Expand sidebar rail" : "Collapse sidebar rail to 56px"}
            data-testid="sidebar-collapse-toggle"
          >
            {props.sidebarCollapsed ? "»" : "«"}
          </button>
        )}
        <button className="btn small rsheet-x" title="Close" onClick={() => setSheet(false)}>
          ✕
        </button>
      </div>
      <div className="rbody">
        <NeedsYou teamId={view?.team.id ?? ""} />
        {!teamCollapsed &&
          view?.lanes.map((l) => (
            <LaneBlock
              key={l.lane.id}
              lane={l}
              teamIds={teamIds}
              collapsed={collapsedLanes.has(l.lane.id)}
              onToggle={() => toggleLane(l.lane.id)}
            />
          ))}
        {views.length > 1 && (
          <div className="rsec-block">
            <div className="rsec">OTHER TEAMS</div>
            {views
              .filter((v) => v.team.id !== view?.team.id)
              .map((v) => (
                <OtherTeam key={v.team.id} v={v} onTeam={onTeam} />
              ))}
          </div>
        )}
      </div>
      {hot.length > 0 && (
        <div className="rfoot">
          {hot.map((u) => {
            const prov = providerSpec(u.provider);
            return (
              <span key={`${u.provider}-${u.account ?? ""}`} className="rquota" title={u.account}>
                <span style={{ color: prov.color }}>
                  {prov.symbol} {prov.name}
                </span>
                <span className="pill diag hot">{Math.round(u.usedPct ?? 0)}% USED</span>
              </span>
            );
          })}
        </div>
      )}
      <div
        className="sidebar-resizer"
        data-testid="sidebar-resizer"
        onMouseDown={props.onStartResize}
        title="Drag to resize sidebar width"
      />
    </nav>
  );
});
