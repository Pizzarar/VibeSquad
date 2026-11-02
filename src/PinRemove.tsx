// Remove team (docs/PLAN_BUGS_BATCH1.md block 1): the Team ⋯ menu's confirm dialog.
// Lists the agents that will be archived and the worktrees/branches; "Also delete worktrees + branches"
// is off by default and disabled when another live team shares the folders.
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Pin } from "./pins";
import { removePin } from "./pinActions";
import { removeTeamPlan, type WorktreeResult } from "./pinRemoveLogic";
import { loadArchived, usePaseo } from "./paseo";
import { getTeams, resolve } from "./teams";
import { Modal } from "./TeamActions";

type Phase = { kind: "confirm" } | { kind: "busy" } | { kind: "error"; message: string } | { kind: "kept"; kept: WorktreeResult[] };

export function RemoveTeamDialog({ pin, onClose }: { pin: Pin; onClose: () => void }) {
  const { agents, workspaces, archivedAgents, archivedStatus } = usePaseo();
  const [deleteWorktrees, setDeleteWorktrees] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  // Archived agents can point at worktrees the live ones have left.
  useEffect(() => void (archivedStatus === "idle" && loadArchived()), [archivedStatus]);

  const plan = useMemo(
    () =>
      removeTeamPlan({
        squadId: pin.squad.id,
        laneId: pin.lane.id,
        teams: getTeams(),
        members: resolve(agents),
        archived: [...archivedAgents.values()],
        workspaces: [...workspaces.values()],
      }),
    [pin.squad.id, pin.lane.id, agents, archivedAgents, workspaces],
  );
  const canDelete = !plan.sharedWith && plan.worktrees.length > 0;

  const confirm = async () => {
    setPhase({ kind: "busy" });
    try {
      const r = await removePin(pin, plan, { deleteWorktrees: deleteWorktrees && canDelete });
      const kept = r.worktrees.filter((w) => w.worktree === "kept" || w.branchResult === "kept");
      if (kept.length) setPhase({ kind: "kept", kept });
      else onClose();
    } catch (e) {
      setPhase({ kind: "error", message: String((e as Error)?.message ?? e) });
    }
  };

  const busy = phase.kind === "busy";
  const footer =
    phase.kind === "kept" ? (
      <button className="btn ok small" onClick={onClose}>
        Close
      </button>
    ) : (
      <>
        {phase.kind === "error" && <span className="stat-alert small">{phase.message}</span>}
        <button className="btn ghost small" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn bad small" onClick={() => void confirm()} disabled={busy} data-testid={`pin-remove-confirm-${pin.lane.id}`}>
          {busy ? "Removing…" : "Remove team"}
        </button>
      </>
    );

  return createPortal(
    <Modal title={`Remove ${pin.lane.name}?`} onClose={busy ? () => {} : onClose} footer={footer}>
      <div className="pin-remove" data-testid={`pin-remove-${pin.lane.id}`}>
        {phase.kind === "kept" ? (
          <>
            <p>{pin.lane.name} is removed. Some worktrees or branches were kept:</p>
            <ul className="pin-remove-list">
              {phase.kept.map((w) => (
                <li key={w.path}>
                  <code>{w.path}</code>
                  {w.branch && <span className="muted small"> · {w.branch}</span>}
                  <span className="muted small"> · {w.reason ?? "kept"}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p className="muted small">The team is hidden from pins, the sidebar, the Done shelf and counts. Its brief and teams.json entry stay.</p>
            <div className="pin-remove-section">
              {plan.agents.length ? `Archives ${plan.agents.length} agent${plan.agents.length === 1 ? "" : "s"}:` : "No agents to archive."}
            </div>
            {plan.agents.length > 0 && (
              <ul className="pin-remove-list">
                {plan.agents.map((a) => (
                  <li key={a.id}>
                    {a.title || a.id.slice(0, 8)} <span className="muted small">· {a.status}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="pin-remove-section">{plan.worktrees.length ? "Worktrees + branches:" : "No worktrees."}</div>
            {plan.worktrees.length > 0 && (
              <ul className="pin-remove-list">
                {plan.worktrees.map((w) => (
                  <li key={w.path}>
                    <code>{w.path}</code>
                    {w.branch && <span className="muted small"> · {w.branch}</span>}
                  </li>
                ))}
              </ul>
            )}
            <label className={`pin-remove-check ${canDelete ? "" : "disabled"}`}>
              <input
                type="checkbox"
                checked={deleteWorktrees && canDelete}
                disabled={!canDelete || busy}
                onChange={(e) => setDeleteWorktrees(e.target.checked)}
                data-testid={`pin-remove-delete-${pin.lane.id}`}
              />
              Also delete worktrees + branches
              {plan.sharedWith && <span className="muted small"> · shared with {plan.sharedWith}</span>}
            </label>
            {deleteWorktrees && canDelete && (
              <p className="muted small">Dirty worktrees and unmerged branches are kept; nothing is forced.</p>
            )}
          </>
        )}
      </div>
    </Modal>,
    document.body,
  );
}
