// Block P1: Paseo worktree manager, one section per git project (list, create, archive).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import { ConfirmButton, ago } from "./ui";
import { getPaseoState } from "./paseo";
import { validateBranch } from "./paseoWorkspaces";
import { archivePaseoWorktree, createPaseoWorktree, listPaseoWorktrees, WORKTREE_LIST_TIMEOUT_MS } from "./paseoWorktrees";
import { archiveGuard, archiveGuardNow, baseRefError, linkedAgents, linkedWorkspace, worktreeSlugError, type WorktreeEntry } from "./paseoWorktreeLogic";
import { branchHint, type BranchHint } from "./workspaceLogic";
import type { ProjectRow } from "./WorkspaceTools";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function WorktreesPanel({ projects, workspaces, agents }: { projects: ProjectRow[]; workspaces: PaseoWorkspace[]; agents: PaseoAgent[] }) {
  const git = projects.filter((p) => p.projectKind === "git");
  return (
    <div className="ws-row wt-panel" data-testid="ws-worktrees">
      <div className="muted small">Paseo-owned worktrees per git project. Archiving removes its Paseo records and deletes the folder from disk.</div>
      {git.length === 0 && <div className="muted small">No git projects yet. Add one under Projects.</div>}
      {git.map((p) => (
        <ProjectWorktrees key={p.projectId} project={p} workspaces={workspaces} agents={agents} />
      ))}
    </div>
  );
}

function ProjectWorktrees({ project, workspaces, agents }: { project: ProjectRow; workspaces: PaseoWorkspace[]; agents: PaseoAgent[] }) {
  const root = project.projectRootPath;
  const [rows, setRows] = useState<WorktreeEntry[] | null>(null);
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);
  // Mounted only while the Worktrees panel is open; the list is cached per repo root, so reopening is instant.
  // Only the latest load may set state: a Reload mid-list or an unmount bumps the id and drops older answers.
  const reqId = useRef(0);
  const load = useCallback((force: boolean) => {
    const id = ++reqId.current;
    setErr("");
    if (force) setRows(null);
    listPaseoWorktrees(root, force).then(
      (r) => {
        if (reqId.current !== id) return;
        setRows(r);
      },
      (e) => {
        if (reqId.current !== id) return;
        setRows([]);
        setErr(/timed out/.test(errMsg(e)) ? `Paseo didn't list worktrees within ${WORKTREE_LIST_TIMEOUT_MS / 1000}s. Reload to try again.` : errMsg(e));
      },
    );
  }, [root]);
  useEffect(() => {
    load(false);
    return () => void ++reqId.current;
  }, [load]);
  const reload = () => load(true);

  return (
    <div className="wt-project">
      <div className="wt-head">
        <span className="ws-name">{project.projectCustomName || project.projectDisplayName}</span>
        <span className="muted small ws-path" title={root}>{root}</span>
        <span className="spacer" />
        <button className="btn ghost small" disabled={rows === null} onClick={reload}>Reload</button>
        <button className={`btn small ${creating ? "ok" : "ghost"}`} onClick={() => setCreating(!creating)}>+ Worktree</button>
      </div>
      {creating && <CreateWorktreeForm project={project} onDone={() => setCreating(false)} onCreated={reload} />}
      {err && <div className="ws-reasons">{err}</div>}
      {rows === null && <div className="muted small">Loading worktrees… (the daemon can take ~20–30s)</div>}
      {rows?.length === 0 && !err && <div className="muted small">No Paseo worktrees.</div>}
      {rows?.map((w) => <WorktreeRow key={w.worktreePath} wt={w} root={root} workspaces={workspaces} agents={agents} onArchived={reload} />)}
    </div>
  );
}

function WorktreeRow({ wt, root, workspaces, agents, onArchived }: { wt: WorktreeEntry; root: string; workspaces: PaseoWorkspace[]; agents: PaseoAgent[]; onArchived: () => void }) {
  const [err, setErr] = useState("");
  const ws = useMemo(() => linkedWorkspace(wt.worktreePath, workspaces), [wt.worktreePath, workspaces]);
  const linked = useMemo(() => linkedAgents(wt.worktreePath, agents), [wt.worktreePath, agents]);
  const guard = archiveGuard(wt.worktreePath, agents);
  const dirty = ws?.gitRuntime?.isDirty;
  return (
    <div className="wt-row">
      <div className="ws-main">
        <div>⎇ {wt.branchName || (wt.head ? `detached ${wt.head.slice(0, 7)}` : "(no branch)")}</div>
        <div className="muted small ws-path" title={wt.worktreePath}>{wt.worktreePath}</div>
        {guard && <div className="ws-reasons">{guard}</div>}
        {err && <div className="ws-reasons">{err}</div>}
      </div>
      <div className="ws-chips">
        {ws && <span className="chip" title={ws.id}>{ws.title || ws.name}</span>}
        {dirty !== undefined && dirty !== null && <span className={`chip ${dirty ? "dirty" : "clean"}`}>{dirty ? "dirty" : "clean"}</span>}
        <span className="chip" title={linked.map((a) => a.title || a.id).join("\n")}>{linked.length} agent{linked.length === 1 ? "" : "s"}</span>
        {Number.isFinite(Date.parse(wt.createdAt)) && <span className="chip">{ago(wt.createdAt)} old</span>}
      </div>
      {guard ? (
        <button className="btn ghost small" disabled title={guard}>Archive</button>
      ) : (
        <ConfirmButton
          label="Archive"
          armedLabel={dirty ? "Dirty! Delete folder?" : "Delete folder?"}
          busyLabel="Archiving…"
          tone="danger"
          title="Archives its Paseo workspaces and deletes the worktree folder from disk (uncommitted work is lost)."
          onConfirm={async () => {
            setErr("");
            // Re-check against the live store at click time: an agent may have started since render.
            const late = archiveGuardNow(wt.worktreePath, () => [...getPaseoState().agents.values()]);
            if (late) return setErr(late);
            try {
              await archivePaseoWorktree(wt.worktreePath, root);
              onArchived();
            } catch (e) {
              setErr(errMsg(e));
            }
          }}
        />
      )}
    </div>
  );
}

function CreateWorktreeForm({ project, onDone, onCreated }: { project: ProjectRow; onDone: () => void; onCreated: () => void }) {
  const root = project.projectRootPath;
  const [slug, setSlug] = useState("");
  const [base, setBase] = useState("");
  const [slugHint, setSlugHint] = useState<BranchHint | null>(null);
  const [baseHint, setBaseHint] = useState<BranchHint | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  // Slug is the new branch: same daemon check as block C's branch hint (debounced).
  useEffect(() => {
    const local = slug.trim() ? worktreeSlugError(slug) : null;
    if (!slug.trim() || local) return setSlugHint(local ? { tone: "bad", text: local } : null);
    setSlugHint(branchHint(slug, null));
    let live = true;
    const t = setTimeout(() => {
      validateBranch(root, slug.trim()).then(
        (v) => live && setSlugHint(branchHint(slug, v)),
        (e) => live && setSlugHint({ tone: "warn", text: errMsg(e) }),
      );
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [slug, root]);

  // Base ref must exist.
  useEffect(() => {
    const local = baseRefError(base);
    if (!base.trim() || local) return setBaseHint(local ? { tone: "bad", text: local } : null);
    setBaseHint({ tone: "muted", text: "checking…" });
    let live = true;
    const t = setTimeout(() => {
      validateBranch(root, base.trim()).then(
        (v) => live && setBaseHint(v.error ? { tone: "warn", text: v.error } : v.exists ? { tone: "ok", text: `found (${v.resolvedRef ?? base.trim()})` } : { tone: "bad", text: "base ref not found" }),
        (e) => live && setBaseHint({ tone: "warn", text: errMsg(e) }),
      );
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [base, root]);

  const go = async () => {
    const e = worktreeSlugError(slug) ?? baseRefError(base) ?? (baseHint?.tone === "bad" ? baseHint.text : null);
    if (e) return setErr(e);
    setBusy(true);
    setErr("");
    setNote("");
    try {
      const res = await createPaseoWorktree(root, slug, base, project.projectId);
      onCreated();
      if (res.setupSkippedReason) setNote(`Created. Setup skipped: ${res.setupSkippedReason}`);
      else onDone();
    } catch (e) {
      setErr(errMsg(e));
      onCreated(); // a timed-out create may still land: refresh the list
    }
    setBusy(false);
  };

  return (
    <div className="wt-create">
      <input value={slug} placeholder="worktree slug (new branch), e.g. feat-thing" onChange={(e) => setSlug(e.target.value)} />
      {slugHint && <span className={`small wt-hint ${slugHint.tone}`}>{slugHint.text}</span>}
      <input value={base} placeholder="base ref (optional, default branch)" onChange={(e) => setBase(e.target.value)} />
      {baseHint && <span className={`small wt-hint ${baseHint.tone}`}>{baseHint.text}</span>}
      <div className="wt-actions">
        <button className="btn ok small" disabled={busy || !slug.trim()} onClick={() => void go()}>{busy ? "Creating…" : "Create worktree"}</button>
        <button className="btn ghost small" onClick={onDone}>Close</button>
        {err && <span className="ws-reasons">{err}</span>}
        {note && <span className="small wt-hint ok">{note}</span>}
      </div>
    </div>
  );
}
