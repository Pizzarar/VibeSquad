// Usage: <NoWorkspaceBanner cwd={agent.cwd} onReady={(workspaceId) => setWsOverride(workspaceId)} />
// Show it when an agent's folder has no workspace (workspaceIdForAgent returned null). Clicking
// [Add as workspace] calls ensureWorkspace(cwd); onReady fires with the id so the host panel can reload with it
// (the daemon's workspace push may land a moment later, so keep the id in local state until the store catches up).
import { useState } from "react";
import { ensureWorkspace } from "./paseoWorkspaces";
import { unsafeWorkspaceCwdReason } from "./ensureWorkspaceLogic";

export { ensureWorkspace };

export function NoWorkspaceBanner({ cwd, onReady }: { cwd: string; onReady: (workspaceId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const unsafe = unsafeWorkspaceCwdReason(cwd);
  const add = async () => {
    setBusy(true);
    setErr("");
    try {
      const { workspaceId } = await ensureWorkspace(cwd);
      onReady(workspaceId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="no-workspace-banner" data-testid="no-workspace-banner">
      <div>This folder isn't a workspace yet.</div>
      <div className="muted small no-workspace-cwd" title={cwd}>{cwd}</div>
      <div className="no-workspace-actions">
        <button className="btn ok" data-testid="no-workspace-add" disabled={busy || !!unsafe} onClick={() => void add()}>
          {busy ? "Adding…" : err ? "Retry" : "Add as workspace"}
        </button>
      </div>
      {unsafe && <div className="muted small" data-testid="no-workspace-unsafe">{unsafe}</div>}
      {err && <div className="stat-alert small" data-testid="no-workspace-error">{err}</div>}
    </div>
  );
}
