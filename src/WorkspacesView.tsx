import { useMemo, useState } from "react";
import type { PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import { archiveWorkspace, usePaseo } from "./paseo";
import { ConfirmButton, ago } from "./ui";
import { openRightDockTab } from "./RightDock";

type Verdict = "in-use" | "check" | "safe";
type Filter = "all" | "safe" | "check" | "in-use";
type Sort = "activity" | "cleanup" | "name";

const STALE_DAYS = 3;
const DAY = 86_400_000;

const norm = (p?: string) => (p ?? "").replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();

type Row = {
  w: PaseoWorkspace;
  verdict: Verdict;
  reasons: string[];
  live: number;
  archived: number;
  idleDays: number;
  owned: boolean;
};

function assess(w: PaseoWorkspace, agents: PaseoAgent[], archived: PaseoAgent[]): Row {
  const dir = norm(w.workspaceDirectory);
  const inDir = (a: PaseoAgent) => {
    const c = norm(a.cwd);
    return c === dir || c.startsWith(dir + "/");
  };
  const mine = agents.filter(inDir);
  const live = mine.filter((a) => a.status !== "closed").length;
  const arch = archived.filter(inDir).length;
  const git = w.gitRuntime;
  const owned = w.workspaceKind === "worktree" && !!git?.isPaseoOwnedWorktree;
  const ahead = Math.max(git?.aheadBehind?.ahead ?? 0, git?.aheadOfOrigin ?? 0);
  const pr = w.githubRuntime?.pullRequest;
  const idleDays = w.activityAt ? (Date.now() - Date.parse(w.activityAt)) / DAY : Infinity;

  const reasons: string[] = [];
  if (live > 0) return { w, verdict: "in-use", reasons: [`${live} live agent${live > 1 ? "s" : ""}`], live, archived: arch, idleDays, owned };
  if (!owned) reasons.push("not a Paseo worktree");
  if (git?.isDirty) reasons.push("uncommitted changes");
  if (ahead > 0) reasons.push(`${ahead} unpushed commit${ahead > 1 ? "s" : ""}`);
  if (pr && !pr.isMerged && String(pr.state).toLowerCase() === "open") reasons.push(`open PR${pr.number ? ` #${pr.number}` : ""}`);
  if (!reasons.length && !(idleDays >= STALE_DAYS || (arch > 0 && mine.length === 0))) reasons.push(`active < ${STALE_DAYS}d ago`);
  return { w, verdict: reasons.length ? "check" : "safe", reasons, live, archived: arch, idleDays, owned };
}

const VERDICT_LABEL: Record<Verdict, string> = { "in-use": "IN USE", check: "CHECK FIRST", safe: "SAFE TO CLEAN" };
const VERDICT_RANK: Record<Verdict, number> = { safe: 0, check: 1, "in-use": 2 };

/** Opens the Changes tab and optionally navigates to the first live agent for the workspace. */
function openChangesForWorkspace(w: PaseoWorkspace, agents: Map<string, PaseoAgent>) {
  const dir = norm(w.workspaceDirectory);
  const liveAgents = [...agents.values()].filter((a) => {
    const c = norm(a.cwd);
    return a.status !== "closed" && (c === dir || c.startsWith(dir + "/"));
  });
  if (liveAgents.length > 0) {
    window.dispatchEvent(new CustomEvent("vs:select-agent", { detail: { agentId: liveAgents[0].id } }));
  }
  openRightDockTab("Changes");
}

export function WorkspacesView() {
  const { workspaces, agents, archivedAgents } = usePaseo();
  const handleChipClick = (w: PaseoWorkspace) => openChangesForWorkspace(w, agents);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("activity");

  const rows = useMemo(() => {
    const live = [...agents.values()];
    const arch = [...archivedAgents.values()];
    return [...workspaces.values()].map((w) => assess(w, live, arch));
  }, [workspaces, agents, archivedAgents]);

  const shown = useMemo(() => {
    const f = rows.filter((r) => filter === "all" || r.verdict === filter);
    return f.sort((a, b) => {
      if (sort === "name") return a.w.name.localeCompare(b.w.name);
      if (sort === "cleanup") return VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || b.idleDays - a.idleDays;
      return a.idleDays - b.idleDays;
    });
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
            {rows.length} WORKSPACES · <span className="stat-cyan">{safe.length} SAFE TO CLEAN</span>
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
        {safe.length > 0 && (
          <ConfirmButton
            label={`Archive ${safe.length} safe`}
            armedLabel={`Delete ${safe.length} folders?`}
            busyLabel="Archiving…"
            tone="danger"
            onConfirm={async () => {
              for (const r of safe) await archiveWorkspace(r.w.id);
            }}
          />
        )}
      </div>

      {shown.length === 0 && <div className="muted">No workspaces match.</div>}
      {shown.map((r) => {
        const git = r.w.gitRuntime;
        const ab = git?.aheadBehind;
        return (
          <div key={r.w.id} className={`ws-row v-${r.verdict}`}>
            <span className={`verdict ${r.verdict}`}>{VERDICT_LABEL[r.verdict]}</span>
            <div className="ws-main">
              <div className="ws-name">
                {r.w.name} <span className="muted small">{r.w.workspaceKind}</span>
              </div>
              <div className="muted small ws-path" title={r.w.workspaceDirectory}>
                {r.w.workspaceDirectory}
              </div>
              {r.reasons.length > 0 && <div className="ws-reasons">{r.reasons.join(" · ")}</div>}
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
              <span className="chip">{Number.isFinite(r.idleDays) ? `${ago(r.w.activityAt)} ago` : "no activity"}</span>
            </div>
            {r.verdict !== "in-use" && (
              <ConfirmButton
                label="Archive"
                armedLabel={r.owned ? "Delete folder?" : "Tap to archive"}
                busyLabel="Archiving…"
                tone={r.owned ? "danger" : "warn"}
                onConfirm={async () => void (await archiveWorkspace(r.w.id))}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
