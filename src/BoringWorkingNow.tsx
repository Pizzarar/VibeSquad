// B13d (Normal mode only): the "Working now" focal card at the top of the chat (mockup 2-living `.now`).
// Busy: the first running agent in this chat's scope (lane Lead/workers when this is a Buddy, running children, then this agent)
// gets the big bust with a warm ring, "WORKING NOW", "<name> is <activity>", and a started time; other running agents follow as chips.
// Idle: the card stays, greyed, and says what this agent is waiting on. Data comes from the same selector as the C3 chip.
import { openAgent } from "./panes";
import type { PaseoAgent } from "./agentTypes";
import type { Member } from "./teams";
import { isHubLaneId } from "./teams";
import { agentDisplayName } from "./identity";
import { bustRoleForAgent, bustUrl } from "./boringBusts";
import { useTheme } from "./useBotFace";

const MAX_CHIPS = 3;

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

export function BoringWorkingNow({ agent, members, subs }: { agent: PaseoAgent; members: Member[]; subs: number }) {
  const theme = useTheme();
  const rows: PaseoAgent[] = members.map((m) => m.agent);
  if (agent.status === "running" && !rows.some((r) => r.id === agent.id)) rows.push(agent);
  const busy = rows.length > 0 || subs > 0;
  const focal = rows[0] ?? agent;
  const others = rows.slice(1);
  const chips = others.slice(0, MAX_CHIPS);
  const started = busy ? hhmm(focal.activeTurn?.startedAt) : "";
  const sub = [
    started ? `started ${started}` : "",
    others.length > chips.length ? `+${others.length - chips.length} more working` : "",
    subs > 0 ? `${subs} sub-agent call${subs === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  const canOpen = focal.id !== agent.id;
  return (
    <div className="boring-now" data-testid="boring-working-now" data-state={busy ? "busy" : "idle"} role="status" aria-live="polite">
      <button
        type="button"
        className="boring-now-big"
        disabled={!canOpen}
        title={canOpen ? `Open ${nameOf(focal)}` : undefined}
        onClick={() => canOpen && openAgent(focal.id)}
      >
        <img className="boring-bust-img" src={bustUrl(bustRoleForAgent(focal), theme)} alt="" width={68} height={68} />
      </button>
      <div className="boring-now-text">
        <div className="boring-now-t">{busy ? "Working now" : "Idle"}</div>
        <div className="boring-now-h">
          {nameOf(focal)} {busy ? (rows.length ? `is ${workingActivity(focal)}` : "is running sub-agents") : idleActivity(agent)}
        </div>
        {sub.length > 0 && <div className="boring-now-s2">{sub.join(" · ")}</div>}
      </div>
      {chips.length > 0 && (
        <div className="boring-now-chips">
          {chips.map((a) => (
            <button key={a.id} type="button" className="boring-now-chip" data-testid={`boring-working-now-${a.id}`} title={`Open ${nameOf(a)} · ${workingActivity(a)}`} onClick={() => openAgent(a.id)}>
              <img className="boring-bust-img" src={bustUrl(bustRoleForAgent(a), theme)} alt="" width={22} height={22} />
              <span>{nameOf(a)}</span>
            </button>
          ))}
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
