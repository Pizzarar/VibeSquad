// "⚡ N working": the running Lead / workers under a Buddy, running Paseo child agents, and in-turn sub_agent calls.
// One selector feeds the chip in the compact chat header and the slim bar above the composer.
import { openAgent } from "./panes";
import { derived, sameList, StatusDot, subscribeTree, useSelect } from "./ui";
import { cleanTitle } from "./ui";
import type { Member } from "./teams";

const running = (m: Member | null | undefined): m is Member => !!m && m.agent.status === "running";

/** Running agents under `agentId`: the lane's Lead and workers when it is a Buddy, plus its running child agents. */
export function useWorkingMembers(agentId: string, isBs: boolean, teamId: string, laneId: string): Member[] {
  return useSelect(
    subscribeTree,
    () => {
      const d = derived();
      const out: Member[] = [];
      if (isBs) {
        const lane = d.views.find((v) => v.team.id === teamId)?.lanes.find((l) => l.lane.id === laneId);
        if (lane) for (const m of [lane.lead, ...lane.members.filter((x) => x.kind === "worker")]) if (running(m)) out.push(m);
      }
      for (const m of d.tree.childrenOf(agentId, false)) if (running(m) && !out.some((o) => o.agent.id === m.agent.id)) out.push(m);
      return out;
    },
    sameList,
  );
}

const nameOf = (m: Member) => cleanTitle(m.agent.title) || m.agent.id.slice(0, 8);

/** Compact header chip + compact working member chips in the top bar (C3). */
export function WorkingChip({ members, subs }: { members: Member[]; subs: number }) {
  const n = members.length + subs;
  if (!n) return null;
  const first = members[0];
  return (
    <>
      <button
        type="button"
        className="drawer-working-chip"
        data-testid="drawer-working-chip"
        title={members.length ? `Working: ${members.map(nameOf).join(", ")}${subs ? ` + ${subs} sub-agent call${subs === 1 ? "" : "s"}` : ""}` : `${subs} sub-agent call${subs === 1 ? "" : "s"} running`}
        disabled={!first}
        onClick={() => first && openAgent(first.agent.id)}
      >
        ⚡ {n} working
      </button>
      <WorkingBar members={members} subs={subs} />
    </>
  );
}

/** Compact top-bar chip group next to the "N working" pill (C3). */
export function WorkingBar({ members, subs }: { members: Member[]; subs: number }) {
  if (!members.length && !subs) return null;
  return (
    <div className="drawer-subagents-bar" data-testid="drawer-subagents-bar">
      {members.map((m) => (
        <button key={m.agent.id} type="button" className="drawer-subagent-chip" data-testid={`subagent-chip-${m.agent.id}`} title={`Open ${nameOf(m)}`} onClick={() => openAgent(m.agent.id)}>
          <StatusDot agent={m.agent} />
          <span className="drawer-subagent-chip-name">
            {m.kind === "lead" ? "★ " : ""}
            {nameOf(m)}
          </span>
        </button>
      ))}
      {!members.length && subs > 0 && <span className="muted small">+{subs}</span>}
    </div>
  );
}
