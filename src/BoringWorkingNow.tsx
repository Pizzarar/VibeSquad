// B13d (Normal mode only): the "Working now" strip (mockup 2-living `.now`). B15 (idea-918): a full-width strip under the agent
// header spanning chat + context panel (mounted by AgentDrawer above .drawer-shell). One line when a single agent is working or idle;
// when 2+ agents work, the focal bust grows and the others show as a row of clickable small busts (+N overflow past 6).
// Busy: the first running agent in this chat's scope (lane Lead/workers when this is a Buddy, running children, then this agent)
// gets the big bust with a warm ring, "WORKING NOW", "<name> is <activity>", and a started time; other running agents follow as chips.
// Idle: the card stays, greyed, and says what this agent is waiting on. Data comes from the same selector as the C3 chip.
import { openAgent } from "./panes";
import type { PaseoAgent } from "./agentTypes";
import type { Attention, Member } from "./teams";
import { isHubLaneId } from "./teams";
import { agentDisplayName } from "./identity";
import { bustRoleForAgent, bustUrl } from "./boringBusts";
import { useTheme } from "./useBotFace";

const MAX_CHIPS = 6;

/** What a running agent is doing right now, from the runner's open-tool fields. */
export function workingActivity(a: Pick<PaseoAgent, "openToolName" | "queued">): string {
  if (a.queued) return `queued (${a.queued.ahead} ahead)`;
  const tool = String(a.openToolName ?? "").trim();
  return tool ? `running ${tool}` : "thinking";
}

/** Idle headline tail for the open agent, from its attention state. */
export function idleActivity(a: Pick<PaseoAgent, "status" | "attentionReason" | "pendingPermissions">): string {
  if (a.pendingPermissions?.length || a.attentionReason === "permission") return "needs your OK";
  if (a.status === "error" || a.attentionReason === "error") return "hit an error";
  if (a.attentionReason === "finished") return "finished · waiting on you";
  return "is idle";
}

const hhmm = (iso: string | null | undefined): string => {
  const t = iso ? new Date(iso) : null;
  return t && !Number.isNaN(t.getTime()) ? t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
};

const nameOf = (a: PaseoAgent): string => agentDisplayName(a, { isHubLaneId }) || a.title || a.id.slice(0, 8);

export function BoringWorkingNow({ agent, members, subs, attention }: { agent: PaseoAgent; members: Member[]; subs: number; attention?: Attention }) {
  const theme = useTheme();
  const rows: PaseoAgent[] = members.map((m) => m.agent);
  if (agent.status === "running" && !rows.some((r) => r.id === agent.id)) rows.push(agent);
  // n8 (UX R17): when a permission card renders directly below, the amber "needs your OK" strip repeats what the
  // card already says. The strip still renders (data-state stays "needs-you" for the L5 invariant) but boring.css
  // collapses it via the data-has-perm hook. Non-permission needs-you states (error / finished / a needs-you tone
  // with no card) keep the strip.
  const hasPerm = Boolean(agent.pendingPermissions?.length);
  // M1 (B13 regression): a pending permission / needs-you beats "working" (running or sub-agents) — the strip must
  // never claim the agent is working while it is blocked on the owner. Check the attention tone AND the raw agent fields
  // (pendingPermissions / attentionReason) so the blocked state holds even before attention is computed (L5).
  const needsYou = attention?.tone === "permission" || attention?.tone === "needs-you" || hasPerm || agent.attentionReason === "permission";
  const busy = !needsYou && (rows.length > 0 || subs > 0);
  const state = needsYou ? "needs-you" : busy ? "busy" : "idle";
  const focal = needsYou ? agent : rows[0] ?? agent;
  const others = needsYou ? [] : rows.slice(1);
  const chips = others.slice(0, MAX_CHIPS);
  const started = busy ? hhmm(focal.activeTurn?.startedAt) : "";
  const sub = needsYou ? [] : [
    started ? `started ${started}` : "",
    subs > 0 ? `${subs} sub-agent call${subs === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  const canOpen = focal.id !== agent.id;
  const headline = needsYou
    ? `${nameOf(agent)} needs your OK`
    : `${nameOf(focal)} ${busy ? (rows.length ? `is ${workingActivity(focal)}` : "is running sub-agents") : idleActivity(agent)}`;
  return (
    <div className="boring-now" data-multi={chips.length > 0 ? "true" : undefined} data-testid="boring-working-now" data-state={state} data-has-perm={hasPerm ? "true" : undefined} role="status" aria-live="polite">
      <button
        type="button"
        className="boring-now-big"
        disabled={!canOpen}
        title={canOpen ? `Open ${nameOf(focal)}` : undefined}
        onClick={() => canOpen && openAgent(focal.id)}
      >
        <img className="boring-bust-img" src={bustUrl(bustRoleForAgent(focal), theme)} alt="" width={48} height={48} />
      </button>
      <div className="boring-now-text">
        <div className="boring-now-t">{needsYou ? "Needs you" : busy ? "Working now" : "Idle"}</div>
        <div className="boring-now-h">{headline}</div>
        {sub.length > 0 && <div className="boring-now-s2">{sub.join(" · ")}</div>}
      </div>
      {chips.length > 0 && (
        <div className="boring-now-chips" role="group" aria-label="Other agents working">
          {chips.map((a) => (
            <button key={a.id} type="button" className="boring-now-chip" data-testid={`boring-working-now-${a.id}`} title={`Open ${nameOf(a)} · ${workingActivity(a)}`} aria-label={`Open ${nameOf(a)}, ${workingActivity(a)}`} onClick={() => openAgent(a.id)}>
              <img className="boring-bust-img" src={bustUrl(bustRoleForAgent(a), theme)} alt="" width={30} height={30} />
            </button>
          ))}
          {others.length > chips.length && (
            <span className="boring-now-more" data-testid="boring-working-now-more" title={`${others.length - chips.length} more working`}>+{others.length - chips.length}</span>
          )}
        </div>
      )}
    </div>
  );
}

const ROLE_LABEL: Record<string, string> = { brainstorm: "Brainstorm", lead: "Lead", worker: "Worker" };

/** CSS custom properties the Normal chat reads for message avatars + the name line (`.boring-drawer .tl-assistant`). */
export function boringChatVars(agent: PaseoAgent): Record<string, string> {
  const role = ROLE_LABEL[String(agent.labels?.role ?? "").trim().toLowerCase()] ?? "Agent";
  return {
    "--boring-bust": `url("${bustUrl(bustRoleForAgent(agent))}")`,
    "--boring-bust-light": `url("${bustUrl(bustRoleForAgent(agent), "light")}")`,
    "--boring-who": JSON.stringify(nameOf(agent)),
    "--boring-role": JSON.stringify(role),
  };
}
