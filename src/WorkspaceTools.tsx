import { useEffect, useState } from "react";
import type { PaseoWorkspace } from "@getpaseo/client";
import { ConfirmButton } from "./ui";
import {
  createStandaloneWorkspace,
  fetchWorkspaceSetupStatus,
  inspectWorkspaceRecovery,
  listProjects,
  openProject,
  removeProject,
  renameProject,
  restoreWorkspace,
  runWorkspaceSetup,
} from "./paseoWorkspaces";
import { buildCreateSource, normalizeTitle, projectDeleteWarning, setupLabel, type CreateMode } from "./workspaceLogic";

export type ProjectRow = Awaited<ReturnType<typeof listProjects>>[number];
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function NameEditor({ initial, placeholder, onSave, onCancel }: { initial: string; placeholder?: string; onSave: (v: string | null) => Promise<void>; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      await onSave(normalizeTitle(v));
    } catch (e) {
      setErr(errMsg(e));
      setBusy(false);
    }
  };
  return (
    <span className="ws-rename">
      <input
        autoFocus
        value={v}
        placeholder={placeholder ?? "empty = reset to default name"}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") onCancel();
        }}
        style={{ minWidth: 0, maxWidth: "100%" }}
      />
      <button className="btn ok small" disabled={busy} onClick={() => void save()}>Save</button>
      <button className="btn ghost small" disabled={busy} onClick={onCancel}>Cancel</button>
      {err && <span className="ws-reasons">{err}</span>}
    </span>
  );
}

const MODES: [CreateMode, string][] = [
  ["local", "Local folder"],
  ["branch-off", "New worktree (branch off)"],
  ["checkout", "Worktree of existing branch"],
];

export function CreateWorkspacePanel({ projects, onDone, onCreated }: { projects: ProjectRow[]; onDone: () => void; onCreated: (w: PaseoWorkspace) => void }) {
  const [mode, setMode] = useState<CreateMode>("local");
  const [path, setPath] = useState("");
  const [cwd, setCwd] = useState(projects[0]?.projectRootPath ?? "");
  useEffect(() => setCwd((c) => c || (projects[0]?.projectRootPath ?? "")), [projects]);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const go = async () => {
    const built = buildCreateSource(mode, { path, cwd, branch, base });
    if ("error" in built) return setErr(built.error);
    setBusy(true);
    setErr("");
    try {
      const res = await createStandaloneWorkspace(built.source, title.trim() || undefined);
      if (res.workspace) onCreated(res.workspace);
      else setNote(`Created ${res.workspaceId ?? "workspace"}. It shows up in the list after Paseo pushes it (reload if it doesn't).`);
      if (res.workspace) onDone();
    } catch (e) {
      setErr(errMsg(e));
    }
    setBusy(false);
  };
  return (
    <div className="ws-row" data-testid="ws-create" style={{ display: "block" }}>
      <div className="seg" style={{ marginBottom: 8 }}>
        {MODES.map(([id, l]) => (
          <button key={id} className={mode === id ? "on" : ""} onClick={() => setMode(id)}>{l}</button>
        ))}
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {mode === "local" ? (
          <input value={path} placeholder="folder path" onChange={(e) => setPath(e.target.value)} />
        ) : (
          <>
            <select value={cwd} onChange={(e) => setCwd(e.target.value)}>
              {projects.length === 0 && <option value="">(no projects)</option>}
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectRootPath}>{p.projectDisplayName}</option>
              ))}
            </select>
            <input value={branch} placeholder={mode === "checkout" ? "existing branch to check out" : "new branch name, e.g. feat/thing"} onChange={(e) => setBranch(e.target.value)} />
            {mode === "branch-off" && <input value={base} placeholder="base branch (optional)" onChange={(e) => setBase(e.target.value)} />}
          </>
        )}
        <input value={title} placeholder="title (optional)" onChange={(e) => setTitle(e.target.value)} />
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn ok small" disabled={busy} onClick={() => void go()}>{busy ? "Creating…" : "Create workspace"}</button>
          <button className="btn ghost small" onClick={onDone}>Close</button>
          {err && <span className="ws-reasons">{err}</span>}
          {note && <span className="small" style={{ color: "var(--cyan)" }}>{note}</span>}
        </div>
      </div>
    </div>
  );
}

export function RecoverPanel() {
  const [id, setId] = useState("");
  const [state, setState] = useState<Awaited<ReturnType<typeof inspectWorkspaceRecovery>> | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="ws-row" data-testid="ws-recover" style={{ display: "block" }}>
      <div className="muted small" style={{ marginBottom: 6 }}>Recover an archived workspace by id: inspect first, then restore.</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <input value={id} placeholder="workspace id" onChange={(e) => { setId(e.target.value); setState(null); setMsg(""); }} style={{ minWidth: 0, flex: 1 }} />
        <button
          className="btn small"
          disabled={busy || !id.trim()}
          onClick={async () => {
            setBusy(true);
            setMsg("");
            try {
              setState(await inspectWorkspaceRecovery(id.trim()));
            } catch (e) {
              setMsg(errMsg(e));
            }
            setBusy(false);
          }}
        >Inspect</button>
      </div>
      {state?.kind === "unavailable" && <div className="ws-reasons">Not recoverable: {state.message}</div>}
      {state?.kind === "recoverable" && (
        <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className="small">{state.workspaceName} · {state.action}{state.branch ? ` · ⎇ ${state.branch}` : ""}</span>
          <ConfirmButton
            label="Restore"
            armedLabel="Recreate it?"
            busyLabel="Restoring…"
            tone="warn"
            onConfirm={async () => {
              await restoreWorkspace(state.workspaceId);
              setMsg("Restored.");
              setState(null);
            }}
          />
        </div>
      )}
      {msg && <div className="ws-reasons">{msg}</div>}
    </div>
  );
}

export function ProjectsPanel({ projects, reload, workspaceCounts, onRemoved }: { projects: ProjectRow[]; reload: () => void; workspaceCounts: Map<string, number>; onRemoved: (workspaceIds: string[]) => void }) {
  const [path, setPath] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  return (
    <div data-testid="ws-projects">
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        <input value={path} placeholder="open a project folder…" onChange={(e) => setPath(e.target.value)} style={{ minWidth: 0, flex: 1 }} />
        <button
          className="btn small"
          disabled={!path.trim()}
          onClick={async () => {
            try {
              await openProject(path.trim());
              setPath("");
              setMsg("");
              reload();
            } catch (e) {
              setMsg(errMsg(e));
            }
          }}
        >Open</button>
      </div>
      <div className="muted small" style={{ marginBottom: 8 }}>Remove drops the project and its workspaces from Paseo's list. VibeSquad deletes no folders itself; whether Paseo cleans up worktree folders on disk isn't specified by its API. Hover Remove for the per-project text.</div>
      {msg && <div className="ws-reasons" style={{ marginBottom: 8 }}>{msg}</div>}
      {projects.length === 0 && <div className="muted">No projects.</div>}
      {projects.map((p) => {
        const n = workspaceCounts.get(p.projectId) ?? 0;
        return (
          <div key={p.projectId} className="ws-row v-in-use" style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
            <div className="ws-main">
              {renaming === p.projectId ? (
                <NameEditor
                  initial={p.projectCustomName ?? ""}
                  placeholder={`empty = reset to "${p.projectDisplayName}"`}
                  onCancel={() => setRenaming(null)}
                  onSave={async (v) => {
                    await renameProject(p.projectId, v);
                    setRenaming(null);
                    reload();
                  }}
                />
              ) : (
                <div className="ws-name">{p.projectDisplayName} <span className="muted small">{p.projectKind} · {n} workspace{n === 1 ? "" : "s"}</span></div>
              )}
              <div className="muted small ws-path" title={p.projectRootPath}>{p.projectRootPath}</div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button className="btn ghost small" onClick={() => setRenaming(p.projectId)}>Rename</button>
              <ConfirmButton
                label="Remove"
                armedLabel={`Drop from Paseo (${n} ws)?`}
                busyLabel="Removing…"
                tone="danger"
                title={projectDeleteWarning(p.projectDisplayName, n)}
                onConfirm={async () => {
                  const res = await removeProject(p.projectId);
                  onRemoved(res.removedWorkspaceIds);
                  reload();
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function SetupChip({ id, status }: { id: string; status: string | null | undefined }) {
  const [s, setS] = useState(status);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => setS(status), [status]);
  return (
    <>
      <span className={`chip ${s === "failed" ? "dirty" : ""}`} title={err || undefined}>{setupLabel(s)}</span>
      <button
        className="btn ghost small"
        disabled={busy || s === "running"}
        title="Run the project's setup script in this workspace"
        onClick={async () => {
          setBusy(true);
          setErr("");
          try {
            await runWorkspaceSetup(id);
            const snap = (await fetchWorkspaceSetupStatus(id)).snapshot;
            setS(snap?.status ?? "running");
            if (snap?.error) setErr(snap.error);
          } catch (e) {
            setErr(errMsg(e));
            setS("failed");
          }
          setBusy(false);
        }}
      >Run setup</button>
      {err && <span className="ws-reasons">{err}</span>}
    </>
  );
}
