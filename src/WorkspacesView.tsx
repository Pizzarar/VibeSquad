import { useCallback, useEffect, useMemo, useState } from "react";
import type { PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import { archiveWorkspace, usePaseo } from "./paseo";
import { ConfirmButton, ago } from "./ui";
import { openRightDockTab } from "./RightDock";
import { agentsWithoutWorkspaceId, bulkLabels, buildFolders, clearLabels, isLiveAgent, normDir, type Folder, type Verdict } from "./workspaceGroups";
import { listProjects, setWorkspacePinned, setWorkspaceTitle } from "./paseoWorkspaces";
import { dropFromOverlay, mergeOverlay, pinnedFirst, pruneOverlay, type OverlayEntry } from "./workspaceLogic";
import { CreateWorkspacePanel, NameEditor, ProjectsPanel, RecoverPanel, SetupChip, type ProjectRow } from "./WorkspaceTools";
import { WorktreesPanel } from "./WorktreesPanel";

type Filter = "all" | "safe" | "check" | "in-use";
type Sort = "activity" | "cleanup" | "name";

const VERDICT_LABEL: Record<Verdict, string> = { "in-use": "IN USE", check: "CHECK FIRST", safe: "SAFE TO CLEAN" };
const VERDICT_RANK: Record<Verdict, number> = { safe: 0, check: 1, "in-use": 2 };

/** Opens the Changes tab and optionally navigates to the first live agent for the workspace. */
function openChangesForWorkspace(w: PaseoWorkspace, agents: Map<string, PaseoAgent>) {
  const dir = normDir(w.workspaceDirectory);
  const liveAgents = [...agents.values()].filter((a) => {
    const c = normDir(a.cwd);
    return isLiveAgent(a) && (a.workspaceId === w.id || (!a.workspaceId && (c === dir || c.startsWith(dir + "/"))));
  });
  if (liveAgents.length > 0) {
    window.dispatchEvent(new CustomEvent("vs:select-agent", { detail: { agentId: liveAgents[0].id } }));
  }
  openRightDockTab("Changes");
}

/** Archives every record of a folder (primary last, so a failure leaves the folder row visible). */
async function archiveFolder(f: Folder, evict: (ids: string[]) => void) {
  for (const r of [...f.records].reverse()) await archiveWorkspace(r.id);
  evict(f.records.map((r) => r.id));
}

export function WorkspacesView() {
  const { workspaces: stored, agents, archivedAgents } = usePaseo();
  // The store only holds the first page of workspaces and may lag: keep just-created workspaces and pending
  // rename/pin patches here, and evict each entry as soon as the store catches up (or the workspace is archived/removed).
  const [overlay, setOverlay] = useState<Map<string, OverlayEntry<PaseoWorkspace>>>(new Map());
  const workspaces = useMemo(() => mergeOverlay(stored, overlay), [stored, overlay]);
  useEffect(() => setOverlay((o) => pruneOverlay(stored, o)), [stored]);
  const patchOverlay = (id: string, patch: Partial<PaseoWorkspace>) =>
    setOverlay((o) => new Map(o).set(id, { ...o.get(id), patch: { ...o.get(id)?.patch, ...patch } }));
  const evict = (ids: string[]) => setOverlay((o) => dropFromOverlay(o, ids));
  const handleChipClick = (w: PaseoWorkspace) => openChangesForWorkspace(w, agents);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("activity");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<"" | "create" | "projects" | "worktrees" | "recover">("");
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState("");
  const reloadProjects = useCallback(() => void listProjects().then(setProjects).catch(() => {}), []);
  useEffect(reloadProjects, [reloadProjects, workspaces]);
  const wsCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of workspaces.values()) m.set(w.projectId, (m.get(w.projectId) ?? 0) + 1);
    return m;
  }, [workspaces]);

  const rows = useMemo(() => {
    const live = [...agents.values()];
    const arch = [...archivedAgents.values()];
    return buildFolders([...workspaces.values()], live, arch);
  }, [workspaces, agents, archivedAgents]);
  const noId = useMemo(() => agentsWithoutWorkspaceId([...agents.values()]), [agents]);
  const recordCount = workspaces.size;

  const shown = useMemo(() => {
    const f = rows.filter((r) => filter === "all" || r.verdict === filter);
    return pinnedFirst(f.sort((a, b) => {
      if (sort === "name") return a.w.name.localeCompare(b.w.name);
      if (sort === "cleanup") return VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || b.idleDays - a.idleDays;
      return a.idleDays - b.idleDays;
    }), (r) => r.w.pinnedAt);
  }, [rows, filter, sort]);

  const safe = rows.filter((r) => r.verdict === "safe");
  const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  const tabs: [Filter, string][] = [
    ["all", `All (${rows.length})`],
    ["safe", `Safe to clean (${count("safe")})`],
    ["check", `Check first (${count("check")})`],
    ["in-use", `In use (${count("in-use")})`],
  ];

  return (
    <div className="team-body ws-view">
      <header className="team-header">
        <h1>
          <span>Workspaces &amp; Cleanup</span>
          <span className="h1-stats">
            {rows.length} FOLDERS · {recordCount} RECORDS · <span className="stat-cyan">{safe.length} SAFE TO CLEAN</span>
          </span>
        </h1>
      </header>

      <div className="ws-controls">
        <div className="seg">
          {tabs.map(([id, label]) => (
            <button key={id} className={filter === id ? "on" : ""} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <label className="muted small">
          SORT{" "}
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="activity">Activity</option>
            <option value="cleanup">Cleanup</option>
            <option value="name">Name</option>
          </select>
        </label>
        <span className="spacer" />
        {noId > 0 && <span className="muted small">{noId} agent{noId > 1 ? "s" : ""} without a workspace id (matched by folder)</span>}
        <button className={`btn small ${panel === "create" ? "ok" : "ghost"}`} onClick={() => setPanel(panel === "create" ? "" : "create")}>+ New workspace</button>
        <button className={`btn small ${panel === "projects" ? "ok" : "ghost"}`} onClick={() => setPanel(panel === "projects" ? "" : "projects")}>Projects ({projects.length})</button>
        <button className={`btn small ${panel === "worktrees" ? "ok" : "ghost"}`} onClick={() => setPanel(panel === "worktrees" ? "" : "worktrees")}>Worktrees</button>
        <button className={`btn small ${panel === "recover" ? "ok" : "ghost"}`} onClick={() => setPanel(panel === "recover" ? "" : "recover")}>Recover</button>
        {safe.length > 0 && (
          <ConfirmButton
            label={bulkLabels(safe).label}
            armedLabel={bulkLabels(safe).armed}
            busyLabel="Archiving…"
            tone="danger"
            onConfirm={async () => {
              for (const r of safe) await archiveFolder(r, evict);
            }}
          />
        )}
      </div>

      {panel === "create" && <CreateWorkspacePanel projects={projects} onDone={() => setPanel("")} onCreated={(w) => setOverlay((o) => new Map(o).set(w.id, { created: w, patch: {} }))} />}
      {panel === "recover" && <RecoverPanel />}
      {panel === "projects" && <ProjectsPanel projects={projects} reload={reloadProjects} workspaceCounts={wsCounts} onRemoved={evict} />}
      {panel === "worktrees" && <WorktreesPanel projects={projects} workspaces={[...workspaces.values()]} agents={[...agents.values()]} />}
      {rowErr && <div className="ws-reasons">{rowErr}</div>}
      {shown.length === 0 && <div className="muted">No folders match.</div>}
      {shown.map((r) => {
        const git = r.w.gitRuntime;
        const ab = git?.aheadBehind;
        const isOpen = open.has(r.key);
        const toggle = () => setOpen((o) => { const n = new Set(o); n.has(r.key) ? n.delete(r.key) : n.add(r.key); return n; });
        const lbl = clearLabels(r.deletesFolder);
        return (
          <div key={r.key} className={`ws-row v-${r.verdict}`}>
            <span className={`verdict ${r.verdict}`}>{VERDICT_LABEL[r.verdict]}</span>
            <div className="ws-main">
              <div className="ws-name">
                {renaming === r.w.id ? (
                  <NameEditor
                    initial={r.w.title ?? ""}
                    placeholder={`empty = reset to "${r.w.title ? "default" : r.w.name}"`}
                    onCancel={() => setRenaming(null)}
                    onSave={async (v) => {
                      const res = await setWorkspaceTitle(r.w.id, v);
                      patchOverlay(r.w.id, { title: res.title, name: res.title ?? (r.w.worktreeSlug || r.w.projectDisplayName || r.w.name) });
                      setRenaming(null);
                    }}
                  />
                ) : (
                  <>
                    {r.w.pinnedAt && <span title="Pinned">📌 </span>}
                    {r.w.name} <span className="muted small">{r.w.workspaceKind}</span>
                    <button className="btn ghost small" onClick={() => setRenaming(r.w.id)}>Rename</button>
                    <button
                      className="btn ghost small"
                                            onClick={() => void setWorkspacePinned(r.w.id, !r.w.pinnedAt).then((res) => patchOverlay(r.w.id, { pinnedAt: res.pinnedAt })).catch((e) => setRowErr(String(e?.message ?? e)))}
                    >
                      {r.w.pinnedAt ? "Unpin" : "Pin"}
                    </button>
                  </>
                )}
              </div>
              <div className="muted small ws-path" title={r.w.workspaceDirectory}>
                {r.w.workspaceDirectory}
              </div>
              {r.reasons.length > 0 && <div className="ws-reasons">{r.reasons.join(" · ")}</div>}
              {r.records.length > 1 && (
                <div className="muted small">
                  <span role="button" tabIndex={0} className="clickable" onClick={toggle} onKeyDown={(e) => e.key === "Enter" && toggle()}>
                    {isOpen ? "▾" : "▸"} {r.records.length} records
                  </span>
                  {r.oldSessions.length > 0 && (
                    <>
                      {" · "}
                      {r.oldSessions.length} old session{r.oldSessions.length > 1 ? "s" : ""}{" "}
                      <ConfirmButton
                        label="Clear"
                        armedLabel="Clear records?"
                        busyLabel="Clearing…"
                        tone="warn"
                        title="Drops Paseo's records only. No files are touched."
                        onConfirm={async () => {
                          for (const o of r.oldSessions) await archiveWorkspace(o.id);
                        }}
                      />
                    </>
                  )}
                </div>
              )}
              {isOpen && (
                <ul className="muted small">
                  {r.records.map((o) => (
                    <li key={o.id}>
                      {o.name} · {o.workspaceKind} · {o.activityAt ? `${ago(o.activityAt)} ago` : "no activity"}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="ws-chips" style={{ minWidth: 0, flexWrap: "wrap" }}>
              {git?.currentBranch && (
                <span className="chip clickable" role="button" tabIndex={0} onClick={() => handleChipClick(r.w)} onKeyDown={(e) => e.key === "Enter" && handleChipClick(r.w)}>
                  ⎇ {git.currentBranch}
                </span>
              )}
              <span
                className={`chip clickable ${git?.isDirty ? "dirty" : "clean"}`}
                role="button"
                tabIndex={0}
                onClick={() => handleChipClick(r.w)}
                onKeyDown={(e) => e.key === "Enter" && handleChipClick(r.w)}
              >
                {git?.isDirty ? "dirty" : "clean"}
              </span>
              {ab && (ab.ahead > 0 || ab.behind > 0) && (
                <span className="chip clickable" role="button" tabIndex={0} onClick={() => handleChipClick(r.w)} onKeyDown={(e) => e.key === "Enter" && handleChipClick(r.w)}>
                  ↑{ab.ahead} ↓{ab.behind}
                </span>
              )}
              {r.w.githubRuntime?.pullRequest && (
                <span className="chip clickable" role="button" tabIndex={0} onClick={() => handleChipClick(r.w)} onKeyDown={(e) => e.key === "Enter" && handleChipClick(r.w)}>
                  PR {r.w.githubRuntime.pullRequest.state.toLowerCase()}
                </span>
              )}
              <span className="chip">
                {r.live} live{r.archived ? ` · ${r.archived} archived` : ""}
              </span>
              <SetupChip id={r.w.id} status={r.w.setupStatus} />
              <span className="chip">{Number.isFinite(r.idleDays) ? `${ago(r.w.activityAt)} ago` : "no activity"}</span>
            </div>
            {r.verdict !== "in-use" && (
              <ConfirmButton
                label={lbl.label}
                armedLabel={lbl.armed}
                busyLabel="Archiving…"
                tone={r.deletesFolder ? "danger" : "warn"}
                onConfirm={() => archiveFolder(r, evict)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
