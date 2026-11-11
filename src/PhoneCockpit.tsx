import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AgentDrawer, triggerBrainstormRestart } from "./AgentDrawer";
import type { RunnerConn } from "./daemonOverlay";
import { oppositeProviderTarget } from "./DrawerHeader";
import { updateAgent } from "./paseo";
import { getLastBrainstormProfile, setLastBrainstormProfile } from "./pinActions";
import { providerSpec } from "./pixel";
import { setPref, usePref } from "./prefs";
import { isAndroidUserAgent } from "./remoteSession";
import {
  defaultSurface,
  effectiveSurface,
  getBuddyRequest,
  hostHealthLine,
  isPhoneShell,
  openBuddy,
  phoneLaneRows,
  subscribeBuddyRequest,
  type PhoneSurface,
} from "./phoneCockpitLogic";
import type { Pin } from "./pins";
import { skyZonesFor } from "./skyZonesLogic";
import { brainstormUsedTokens, type Member, type TeamView } from "./teams";
import { cleanTitle } from "./ui";

// E1 (docs/PLAN_ANDROID_END_STATE.md): the whole phone UI. Three surfaces, one chat each, no desktop chrome and no way back to it.
// Chats are the existing AgentDrawer in chatOnly mode, so Timeline, composer and needs-you handling are reused, not forked.

type Props = {
  /** Squads the phone can pick between (Unassigned already filtered out). */
  views: TeamView[];
  view: TeamView | undefined;
  onSquad: (id: string) => void;
  runnerConn: RunnerConn;
  /** Top-right 🐞 Log Bug pill. E3 passes PhoneBugSheet's trigger here. */
  bugSlot?: ReactNode;
  /** `⋯` drawer slot for "Pair Another Device / Paired Devices". E4b fills it. */
  pairSlot?: ReactNode;
  onSuccessor: (id: string) => void;
  onSpinUp: (pin: Pin, profile?: string) => void;
  onSpinUpOverlord: (view: TeamView, profileName?: string) => void;
  overlordBusy?: boolean;
  onSettings?: () => void;
};

const SURFACE_LABEL: Record<PhoneSurface, string> = { overlord: "Overlord", riffbot: "RiffBot", buddy: "Buddy" };

const buddyOf = (view: TeamView | undefined, laneId: string | null): Member | null => {
  if (!view || !laneId) return null;
  const l = view.lanes.find((x) => x.lane.id.toLowerCase() === laneId.toLowerCase());
  return l?.brainstorm ?? l?.lead ?? null;
};

type RestartState = { phase: "idle" | "confirm" | "busy" | "done"; msg?: string };

/** Restart the runner through the existing owner-only route (also used by Settings). */
// TODO(PLAN_V03_STABILIZE R1): the server half of "Restart Server & Runner" waits on R1's graceful restart; until then this restarts the runner only. Do not add a server route here.
function RestartHost() {
  const [s, setS] = useState<RestartState>({ phase: "idle" });
  const run = async () => {
    setS({ phase: "busy" });
    try {
      const r = await fetch("/__vibesquad/restart-runner", { method: "POST" });
      const j = (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as { ok: boolean; error?: string; cancelled?: string[] };
      setS({ phase: "done", msg: j.ok ? `Runner restarted${j.cancelled?.length ? ` · cancelled ${j.cancelled.length} turn(s)` : ""}` : `Failed: ${j.error ?? "unknown"}` });
    } catch (e) {
      setS({ phase: "done", msg: `Failed: ${String((e as Error)?.message ?? e)}` });
    }
  };
  return (
    <div className="phone-restart" data-testid="phone-restart">
      {s.phase === "confirm" ? (
        <>
          <p className="muted small">Running turns are cancelled; agents resume on the next message.</p>
          <button type="button" className="btn small" data-testid="phone-restart-confirm" onClick={() => void run()}>Restart now</button>{" "}
          <button type="button" className="btn ghost small" onClick={() => setS({ phase: "idle" })}>Cancel</button>
        </>
      ) : (
        <button type="button" className="btn ghost" data-testid="phone-restart-btn" disabled={s.phase === "busy"} onClick={() => setS({ phase: "confirm" })}>
          {s.phase === "busy" ? "Restarting…" : "Restart Runner"}
        </button>
      )}
      {s.msg && <div className="muted small" role="status" data-testid="phone-restart-result">{s.msg}</div>}
    </div>
  );
}

function Empty({ what, action, busy, onAction }: { what: string; action: string; busy?: boolean; onAction?: () => void }) {
  return (
    <div className="phone-empty" data-testid="phone-empty">
      <p>{what}</p>
      {onAction && (
        <button type="button" className="btn" disabled={busy} onClick={onAction}>
          {busy ? "Starting…" : action}
        </button>
      )}
    </div>
  );
}

export function PhoneCockpit({ views, view, onSquad, runnerConn, bugSlot, pairSlot, onSuccessor, onSpinUp, onSpinUpOverlord, overlordBusy = false, onSettings }: Props) {
  const needsYou = view?.needsYou ?? 0;
  const [vibe] = usePref("app.vibe");
  const [surface, setSurface] = useState<PhoneSurface>(() => defaultSurface(needsYou));
  const [buddyLane, setBuddyLane] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [squadMenu, setSquadMenu] = useState(false);
  const [defaultProv, setDefaultProv] = useState<"claude" | "gemini">(() =>
    /gemini/i.test(getLastBrainstormProfile()) ? "gemini" : "claude",
  );
  const [switching, setSwitching] = useState(false);

  const chooseDefaultProv = (next: "claude" | "gemini") => {
    setDefaultProv(next);
    setLastBrainstormProfile(next === "gemini" ? "Brainstorm - Gemini" : "Brainstorm - Claude");
  };
  const brainstormProfile = defaultProv === "gemini" ? "Brainstorm - Gemini" : "Brainstorm - Claude";
  const overlordProfile = defaultProv === "gemini" ? "Lead - Gemini" : "Lead - Claude";

  // E2's contract: openBuddy(laneId) (phoneCockpitLogic.ts) lands here.
  const req = useSyncExternalStore(subscribeBuddyRequest, getBuddyRequest);
  useEffect(() => {
    if (!req) return;
    setBuddyLane(req.laneId);
    setSurface("buddy");
    setMenu(false);
  }, [req]);

  const shown = effectiveSurface(surface, buddyLane);
  const zones = skyZonesFor(view);
  const health = hostHealthLine(runnerConn);
  const buddy = buddyOf(view, buddyLane);
  const laneRows = phoneLaneRows(view);
  const activeMember = shown === "overlord" ? zones.overlord.member : shown === "riffbot" ? zones.riffbot.member : buddy;
  const activeProv = activeMember ? providerSpec(activeMember.agent.provider) : null;
  const switchTarget = activeMember
    ? oppositeProviderTarget(activeMember.agent.provider, (activeMember.agent.labels as Record<string, string> | undefined)?.profile)
    : null;

  const onSwitchActiveProvider = async () => {
    if (!activeMember || !switchTarget || switching) return;
    const nextDefault = switchTarget.provider === "antigravity-cli" ? "gemini" : "claude";
    chooseDefaultProv(nextDefault);
    if (activeMember.kind === "brainstorm") {
      const nextProfile = switchTarget.profile ?? (switchTarget.provider === "antigravity-cli" ? "Brainstorm - Gemini" : "Brainstorm - Claude");
      setLastBrainstormProfile(nextProfile);
      setSwitching(true);
      try {
        await triggerBrainstormRestart({
          agent: activeMember.agent,
          teamId: view?.team.id ?? ((activeMember.agent.labels as any)?.team ?? ""),
          laneId: activeMember.laneId || ((activeMember.agent.labels as any)?.lane ?? ""),
          reason: "provider-switch",
          usedTokens: brainstormUsedTokens(activeMember.agent),
          profileName: nextProfile,
        });
      } finally {
        setSwitching(false);
      }
      return;
    }
    const nextLeadProfile = switchTarget.profile ?? (switchTarget.provider === "antigravity-cli" ? "Lead - Gemini" : "Lead - Claude");
    void updateAgent(activeMember.agent.id, {
      labels: { ...(activeMember.agent.labels as Record<string, string>), ...(nextLeadProfile ? { profile: nextLeadProfile } : {}) },
    }).catch(() => {});
    onSuccessor(activeMember.agent.id);
  };

  const pick = (s: PhoneSurface) => {
    setSurface(s);
    setMenu(false);
    setSquadMenu(false);
  };

  let body: ReactNode;
  if (shown === "overlord") {
    const m = zones.overlord.member;
    body = m ? (
      <AgentDrawer key={m.agent.id} agent={m.agent} chatOnly pinDecisions onClose={() => {}} onSuccessor={() => onSuccessor(m.agent.id)} />
    ) : (
      <Empty what="No Overlord is on duty for this Squad." action="Start Overlord" busy={overlordBusy} onAction={view ? () => onSpinUpOverlord(view, overlordProfile) : undefined} />
    );
  } else if (shown === "riffbot") {
    const m = zones.riffbot.member;
    body = m ? (
      <AgentDrawer key={m.agent.id} agent={m.agent} chatOnly onClose={() => {}} onSuccessor={() => onSuccessor(m.agent.id)} />
    ) : (
      <Empty what="RiffBot isn't running yet." action="Start RiffBot" onAction={zones.hub ? () => onSpinUp(zones.hub!, brainstormProfile) : undefined} />
    );
  } else {
    body = buddy ? (
      <AgentDrawer key={buddy.agent.id} agent={buddy.agent} chatOnly onClose={() => {}} onSuccessor={() => onSuccessor(buddy.agent.id)} />
    ) : (
      <Empty what={`@${buddyLane} Buddy isn't running.`} action="" />
    );
  }

  const tab = (s: PhoneSurface, label: string, badge?: number) => (
    <button
      key={s}
      type="button"
      role="tab"
      aria-selected={shown === s}
      className={`phone-tab ${shown === s ? "on" : ""}`}
      data-testid={`phone-tab-${s}`}
      onClick={() => pick(s)}
    >
      {label}
      {!!badge && <span className="phone-badge" data-testid="phone-needs-you">{badge}</span>}
    </button>
  );

  return (
    <div className="phone-cockpit" data-testid="phone-cockpit" data-surface={shown} data-vibe={vibe} data-android={isAndroidUserAgent() ? "true" : undefined}>
      <header className="phone-bar">
        <button
          type="button"
          className="phone-squad-pill"
          data-testid="phone-squad-pill"
          aria-haspopup="listbox"
          aria-expanded={squadMenu}
          disabled={views.length < 2}
          onClick={() => setSquadMenu((v) => !v)}
        >
          {view?.team.name ?? "No Squad"}{views.length > 1 ? " ▾" : ""}
        </button>
        <span className={`phone-health ${health.tone}`} data-testid="phone-health-dot" title={health.text} />
        <span className="phone-bar-spacer" />
        {bugSlot && <span className="phone-bug-slot" data-testid="phone-bug-slot">{bugSlot}</span>}
        <button type="button" className="phone-more" data-testid="phone-more" aria-label="More" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
          ⋯
        </button>
      </header>
      {squadMenu && (
        <div className="phone-squad-menu" role="listbox" data-testid="phone-squad-menu">
          {views.map((v) => (
            <button
              key={v.team.id}
              type="button"
              role="option"
              aria-selected={v.team.id === view?.team.id}
              className={`phone-squad-opt ${v.team.id === view?.team.id ? "on" : ""}`}
              onClick={() => {
                onSquad(v.team.id);
                setSquadMenu(false);
              }}
            >
              {v.team.name}
              {v.needsYou > 0 && <span className="phone-badge">{v.needsYou}</span>}
            </button>
          ))}
        </div>
      )}
      {menu && (
        <aside className="phone-drawer" data-testid="phone-drawer" aria-label="Host">
          <div className={`phone-health-line ${health.tone}`} data-testid="phone-health-line">
            <span className={`phone-health ${health.tone}`} /> {health.text}
          </div>
          <div className="phone-seg-group" data-testid="phone-vibe-toggle" role="group" aria-label="Layout vibe">
            <span className="phone-lanes-head">VIBE</span>
            <div className="phone-seg-row">
              <button
                type="button"
                className={`phone-seg-btn ${vibe === "fun" ? "on" : ""}`}
                data-testid="phone-vibe-fun"
                aria-pressed={vibe === "fun"}
                onClick={() => setPref("app.vibe", "fun")}
              >
                Psycho
              </button>
              <button
                type="button"
                className={`phone-seg-btn ${vibe === "boring" ? "on" : ""}`}
                data-testid="phone-vibe-boring"
                aria-pressed={vibe === "boring"}
                onClick={() => setPref("app.vibe", "boring")}
              >
                Corpo
              </button>
            </div>
          </div>
          <div className="phone-seg-group" data-testid="phone-provider-toggle" role="group" aria-label="Default provider">
            <span className="phone-lanes-head">PROVIDER</span>
            <div className="phone-seg-row">
              <button
                type="button"
                className={`phone-seg-btn ${defaultProv === "claude" ? "on" : ""}`}
                data-testid="phone-provider-claude"
                aria-pressed={defaultProv === "claude"}
                onClick={() => chooseDefaultProv("claude")}
              >
                ✶ Claude
              </button>
              <button
                type="button"
                className={`phone-seg-btn ${defaultProv === "gemini" ? "on" : ""}`}
                data-testid="phone-provider-gemini"
                aria-pressed={defaultProv === "gemini"}
                onClick={() => chooseDefaultProv("gemini")}
              >
                ◆ Gemini
              </button>
            </div>
          </div>
          <div className="phone-lanes" data-testid="phone-lanes">
            <div className="phone-lanes-head">TEAMS</div>
            {laneRows.length === 0 && <p className="muted small">No teams pinned yet.</p>}
            {laneRows.map((r) => (
              <button
                key={r.laneId}
                type="button"
                className={`phone-lane-row ${r.state}`}
                data-testid={`phone-lane-${r.laneId}`}
                data-state={r.state}
                onClick={() => {
                  if (r.state === "none") onSpinUp(r.pin, brainstormProfile);
                  openBuddy(r.laneId);
                  setMenu(false);
                }}
              >
                <span className="phone-lane-name">{r.name}</span>
                <span className="phone-lane-state">{r.state === "live" ? "live" : r.state === "idle" ? "idle" : "tap to start"}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn ghost phone-settings-btn"
            data-testid="phone-settings-btn"
            onClick={() => {
              setMenu(false);
              onSettings?.();
            }}
          >
            ⚙ Settings
          </button>
          <RestartHost />
          <div className="phone-pair-slot" data-testid="phone-pair-slot">{pairSlot}</div>
        </aside>
      )}
      <div className="phone-body">
        {shown === "buddy" && (
          <div className="phone-buddy-head">
            <button type="button" className="phone-back-pill" data-testid="phone-back-overlord" onClick={() => pick("overlord")}>
              ← Back to Overlord
            </button>
            <span className="phone-buddy-name">@{buddyLane}{buddy ? ` · ${cleanTitle(buddy.agent.title)}` : ""}</span>
          </div>
        )}
        {activeMember && activeProv && (
          <div className="phone-provider-bar" data-testid="phone-provider-bar">
            <span className="phone-active-provider" data-testid="phone-active-provider">
              {activeProv.symbol} {activeProv.name}{activeMember.agent.model ? ` · ${activeMember.agent.model}` : ""}
            </span>
            {switchTarget && (
              <button
                type="button"
                className="btn ghost small phone-switch-provider-btn"
                data-testid="phone-switch-provider-btn"
                disabled={switching}
                onClick={() => void onSwitchActiveProvider()}
              >
                {switching ? "Switching…" : switchTarget.label}
              </button>
            )}
          </div>
        )}
        <div className="phone-chat">{body}</div>
      </div>
      <nav className="phone-tabs" role="tablist" aria-label="Cockpit surfaces">
        {tab("overlord", SURFACE_LABEL.overlord, needsYou)}
        {tab("riffbot", SURFACE_LABEL.riffbot)}
        {buddyLane && tab("buddy", `@${buddyLane}`)}
      </nav>
    </div>
  );
}

/** True on the Android APK or a phone-width viewport; App mounts only <PhoneCockpit /> then. */
export function usePhoneShell(): boolean {
  return useSyncExternalStore(
    (l) => {
      window.addEventListener("resize", l);
      return () => window.removeEventListener("resize", l);
    },
    () => isPhoneShell(isAndroidUserAgent(), window.innerWidth),
  );
}
