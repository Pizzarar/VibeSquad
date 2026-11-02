import { useState, useEffect, useCallback } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { daemonClient, client, DEMO } from "./paseo";
import { CHANGES_SLOW_MS, changesErrorText, withTimeout } from "./changesLoad";

// ─── Pure utilities (exported for unit tests) ────────────────────────────────

const WORKFLOW_PREFIXES = [".github/workflows/", "src-tauri/tauri.conf.json"];
const WORKFLOW_BASENAME = [/^release/i];

/** Returns true when any changed path touches workflow or release config. */
export function touchesWorkflowOrRelease(paths: string[]): boolean {
  return paths.some((p) => {
    const norm = p.replace(/\\/g, "/");
    if (WORKFLOW_PREFIXES.some((pfx) => norm === pfx || norm.startsWith(pfx) || norm.includes("/" + pfx))) return true;
    const base = norm.split("/").pop() ?? norm;
    return WORKFLOW_BASENAME.some((rx) => rx.test(base));
  });
}

/** Classify a raw unified diff text line into a diff line type. */
export function classifyDiffLine(raw: string): "header" | "add" | "remove" | "context" {
  if (raw.startsWith("@@")) return "header";
  if (raw.startsWith("+")) return "add";
  if (raw.startsWith("-")) return "remove";
  return "context";
}

// ─── Types ───────────────────────────────────────────────────────────────────

type DiffLine = { type: string; content: string };
type DiffHunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: DiffLine[] };
type DiffFile = { path: string; oldPath?: string; isNew: boolean; isDeleted: boolean; additions: number; deletions: number; hunks: DiffHunk[]; status?: string };
type DiffPayload = { files: DiffFile[]; diffTooLarge?: boolean };

type StashEntry = { index: number; message: string; branch: string | null; isPaseo: boolean };

type PrCheck = { name: string; status: string; url: string | null; checkRunId?: number; workflowRunId?: number };
type PrStatusInfo = {
  number?: number;
  url: string;
  title: string;
  state: string;
  isMerged: boolean;
  isDraft: boolean;
  checks?: PrCheck[];
  checksStatus?: string;
  github?: {
    autoMergeRequest?: { mergeMethod?: string } | null;
    viewerCanEnableAutoMerge?: boolean;
    viewerCanDisableAutoMerge?: boolean;
    autoMergeAllowed?: boolean;
  };
};

type CheckoutStatusInfo = {
  isGit: boolean;
  currentBranch: string | null;
  isDirty: boolean | null;
  aheadBehind: { ahead: number; behind: number } | null;
  baseRef: string | null;
  error: { code: string; message: string } | null;
};

// ─── DEMO data ────────────────────────────────────────────────────────────────

const DEMO_CWD = "/path/to/vibesquad";

const DEMO_STATUS: CheckoutStatusInfo = {
  isGit: true,
  currentBranch: "feature/changes-panel",
  isDirty: true,
  aheadBehind: { ahead: 2, behind: 0 },
  baseRef: "main",
  error: null,
};

export const DEMO_DIFF: DiffPayload = {
  files: [
    {
      path: "src/ChangesPanel.tsx",
      isNew: false, isDeleted: false, additions: 120, deletions: 8,
      hunks: [{
        oldStart: 1, oldCount: 8, newStart: 1, newCount: 120,
        lines: [
          { type: "header", content: "@@ -1,8 +1,120 @@" },
          { type: "context", content: " import type { PaseoAgent } from '@getpaseo/client';" },
          { type: "remove", content: "-// placeholder stub" },
          { type: "add", content: "+import { useState, useEffect } from 'react';" },
          { type: "add", content: "+import { daemonClient, client, DEMO } from './paseo';" },
        ],
      }],
    },
    {
      path: "src/WorkspacesView.tsx",
      isNew: false, isDeleted: false, additions: 12, deletions: 8,
      hunks: [{
        oldStart: 139, oldCount: 8, newStart: 139, newCount: 12,
        lines: [
          { type: "header", content: "@@ -139,8 +139,12 @@" },
          { type: "context", content: "           <div className=\"ws-chips\">" },
          { type: "remove", content: "-            {git?.currentBranch && <span className=\"chip\">⎇ {git.currentBranch}</span>}" },
          { type: "add", content: "+            {git?.currentBranch && <span role=\"button\" className=\"chip clickable\">⎇ {git.currentBranch}</span>}" },
        ],
      }],
    },
    {
      path: "test/ade-batch-d.test.mjs",
      isNew: true, isDeleted: false, additions: 80, deletions: 0,
      hunks: [{
        oldStart: 0, oldCount: 0, newStart: 1, newCount: 5,
        lines: [
          { type: "header", content: "@@ -0,0 +1,5 @@" },
          { type: "add", content: "+import assert from 'node:assert/strict';" },
          { type: "add", content: "+import test from 'node:test';" },
          { type: "add", content: "+" },
          { type: "add", content: "+// Tests for ChangesPanel utilities" },
        ],
      }],
    },
  ],
};

export const DEMO_PR_STATUS = { status: null as PrStatusInfo | null, githubFeaturesEnabled: true, error: null as null | { message: string }, forge: "github" };

// ─── Git action wrapper ───────────────────────────────────────────────────────

export async function gitActionWrapper<T>(fn: () => Promise<T>): Promise<{ ok: boolean; error?: string; result?: T }> {
  try {
    const result = await fn();
    return { ok: true, result };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Discard confirmation state machine ───────────────────────────────────────
// State: null = idle, string[] = armed (waiting for confirm)
export type DiscardState = string[] | null;

export function discardArm(paths: string[]): DiscardState { return paths; }
export function discardCancel(): DiscardState { return null; }
export function discardIsArmed(s: DiscardState): s is string[] { return s !== null; }

// ─── Line style ──────────────────────────────────────────────────────────────

const LINE_CLS: Record<string, string> = {
  add: "diff-add",
  remove: "diff-remove",
  header: "diff-header",
  context: "",
};

// ─── Component ───────────────────────────────────────────────────────────────

export function ChangesPanel({ agent }: { agent: PaseoAgent }) {
  const cwd = agent.cwd ?? DEMO_CWD;

  const [status, setStatus] = useState<CheckoutStatusInfo | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [prData, setPrData] = useState<typeof DEMO_PR_STATUS | null>(null);
  const [stash, setStash] = useState<StashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [discardState, setDiscardState] = useState<DiscardState>(null);

  const [commitMsg, setCommitMsg] = useState("");
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchInput, setBranchInput] = useState("");

  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prBase, setPrBase] = useState("");
  const [prMergeArmed, setPrMergeArmed] = useState(false);

  const [reviewSpawned, setReviewSpawned] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const flash = useCallback((text: string, ok = true) => {
    setStatusMsg({ text, ok });
    setTimeout(() => setStatusMsg(null), 4000);
  }, []);

  // ─── Load data ──────────────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    setSlow(false);
    const slowTimer = setTimeout(() => { if (alive) setSlow(true); }, CHANGES_SLOW_MS);
    const fail = (e: unknown) => { if (alive) { setLoadError(changesErrorText(e)); setLoading(false); } };

    if (DEMO) {
      setStatus(DEMO_STATUS);
      setDiff(DEMO_DIFF);
      setPrData(DEMO_PR_STATUS);
      setStash([]);
      setLoading(false);
      clearTimeout(slowTimer);
      return;
    }

    // Subscribe to live diff updates via observeCheckoutDiff
    let subRelease: (() => Promise<void>) | null = null;
    let unsub: (() => void) | null = null;

    try {
      const sub = daemonClient.observeCheckoutDiff(cwd, { mode: "uncommitted" });
      subRelease = () => sub.release();
      withTimeout(sub.ready as Promise<any>).then((snap: any) => {
        if (!alive) return;
        setDiff({ files: snap.files ?? [], diffTooLarge: snap.diffTooLarge });
        setLoading(false);
      }).catch(fail);
      unsub = sub.subscribe({
        snapshot: (snap: any) => {
          if (!alive) return;
          setDiff({ files: snap.files ?? [], diffTooLarge: snap.diffTooLarge });
        },
        update: () => {},
      });
    } catch {
      // Daemon version does not support observeCheckoutDiff — fall back to a one-shot fetch
      withTimeout(daemonClient.getCheckoutDiff(cwd, { mode: "uncommitted" })).then((d: any) => {
        if (!alive) return;
        setDiff({ files: d.files ?? [], diffTooLarge: d.diffTooLarge });
        setLoading(false);
      }).catch(fail);
    }

    Promise.all([
      daemonClient.getCheckoutStatus(cwd).then((s: any) => { if (alive) setStatus(s); }).catch(() => {}),
      daemonClient.checkoutPrStatus(cwd).then((p: any) => { if (alive) setPrData(p); }).catch(() => {}),
      daemonClient.stashList(cwd).then((sl: any) => { if (alive) setStash(sl.entries ?? []); }).catch(() => {}),
    ]);

    return () => {
      alive = false;
      clearTimeout(slowTimer);
      unsub?.();
      subRelease?.();
    };
  }, [cwd, attempt]);

  // ─── Derived ─────────────────────────────────────────────────────────────────

  const files = diff?.files ?? [];
  const changedPaths = files.map((f) => f.path);
  const hasWorkflowFiles = touchesWorkflowOrRelease(changedPaths);
  const currentBranch = status?.currentBranch ?? "";
  const ahead = status?.aheadBehind?.ahead ?? 0;
  const behind = status?.aheadBehind?.behind ?? 0;
  const isGit = status?.isGit ?? false;
  const pr = prData?.status ?? null;
  const autoMergeOn = !!(pr?.github?.autoMergeRequest);

  // ─── Actions ─────────────────────────────────────────────────────────────────

  async function handleDiscard(paths: string[]) {
    setDiscardState(null);
    if (DEMO) { flash("Discarded (demo)"); return; }
    const r = await gitActionWrapper(() => daemonClient.checkoutDiscardChanges(cwd, { paths }));
    r.ok ? flash("Changes discarded") : flash(r.error ?? "Discard failed", false);
  }

  async function handleCommit() {
    if (!commitMsg.trim()) { flash("Enter a commit message", false); return; }
    if (DEMO) { flash("Committed (demo)"); setCommitMsg(""); return; }
    const r = await gitActionWrapper(() => daemonClient.checkoutCommit(cwd, { message: commitMsg, addAll: true }));
    if (r.ok) { flash("Committed"); setCommitMsg(""); }
    else flash(r.error ?? "Commit failed", false);
  }

  async function handlePush() {
    if (DEMO) { flash("Pushed (demo)"); return; }
    const r = await gitActionWrapper(() => daemonClient.checkoutPush(cwd));
    r.ok ? flash("Pushed") : flash(r.error ?? "Push failed", false);
  }

  async function handlePull() {
    if (DEMO) { flash("Pulled (demo)"); return; }
    const r = await gitActionWrapper(() => daemonClient.checkoutPull(cwd));
    r.ok ? flash("Pulled") : flash(r.error ?? "Pull failed", false);
  }

  async function handleMergeBase() {
    if (DEMO) { flash("Merged from base (demo)"); return; }
    const r = await gitActionWrapper(() => daemonClient.checkoutMergeFromBase(cwd, {}));
    r.ok ? flash("Merged from base") : flash(r.error ?? "Merge failed", false);
  }

  async function handleSwitchBranch() {
    const branch = branchInput.trim();
    if (!branch) return;
    if (DEMO) { flash(`Switched to ${branch} (demo)`); setBranchOpen(false); return; }
    const r = await gitActionWrapper(() => daemonClient.checkoutSwitchBranch(cwd, branch));
    if (r.ok) { flash(`Switched to ${branch}`); setBranchOpen(false); setBranchInput(""); }
    else flash(r.error ?? "Switch failed", false);
  }

  async function handleStash() {
    if (DEMO) { flash("Stashed (demo)"); return; }
    const r = await gitActionWrapper(() => daemonClient.stashSave(cwd));
    if (r.ok) {
      flash("Stashed");
      daemonClient.stashList(cwd).then((sl: any) => setStash(sl.entries ?? [])).catch(() => {});
    } else flash(r.error ?? "Stash failed", false);
  }

  async function handleStashPop() {
    if (DEMO) { flash("Stash popped (demo)"); return; }
    const r = await gitActionWrapper(() => daemonClient.stashPop(cwd, 0));
    if (r.ok) {
      flash("Stash popped");
      daemonClient.stashList(cwd).then((sl: any) => setStash(sl.entries ?? [])).catch(() => {});
    } else flash(r.error ?? "Stash pop failed", false);
  }

  async function handlePrCreate() {
    if (DEMO) { flash("PR created (demo)"); return; }
    const r = await gitActionWrapper(() =>
      daemonClient.checkoutPrCreate(cwd, { title: prTitle, body: prBody || undefined, baseRef: prBase || undefined })
    );
    if (r.ok) {
      flash("PR created");
      daemonClient.checkoutPrStatus(cwd).then((p: any) => setPrData(p)).catch(() => {});
    } else flash(r.error ?? "PR create failed", false);
  }

  async function handlePrMerge() {
    setPrMergeArmed(false);
    if (DEMO) { flash("PR merged (demo)"); return; }
    const r = await gitActionWrapper(() => daemonClient.checkoutPrMerge(cwd, { method: "merge" as any }));
    r.ok ? flash("PR merged") : flash(r.error ?? "Merge failed", false);
  }

  async function handleAutoMerge() {
    const enable = !autoMergeOn;
    if (DEMO) { flash(`Auto-merge ${enable ? "enabled" : "disabled"} (demo)`); return; }
    const r = await gitActionWrapper(() =>
      enable
        ? daemonClient.checkoutGithubSetAutoMerge(cwd, { enabled: true, method: "merge" as any })
        : daemonClient.checkoutGithubSetAutoMerge(cwd, { enabled: false })
    );
    if (r.ok) {
      flash(`Auto-merge ${enable ? "enabled" : "disabled"}`);
      daemonClient.checkoutPrStatus(cwd).then((p: any) => setPrData(p)).catch(() => {});
    } else flash(r.error ?? "Auto-merge failed", false);
  }

  async function handleReviewDiff() {
    const summary = files.map((f) => `${f.isNew ? "A" : f.isDeleted ? "D" : "M"} ${f.path} (+${f.additions}/-${f.deletions})`).join("\n");
    const labels = (agent.labels ?? {}) as Record<string, string>;

    if (DEMO) {
      const id = "demo-review-" + Date.now().toString(36);
      setReviewSpawned(id);
      flash("Review agent spawned (demo)");
      return;
    }

    try {
      const handle = await (client as any).agents.create({
        config: { provider: "claude/claude-opus-5-5" },
        cwd,
        title: "Review diff",
        labels: {
          team: labels.team ?? "vibesquad",
          lane: labels.lane ?? "review",
          role: "worker",
          profile: "Review - Opus",
          job: "diff-review",
        },
        prompt: `Review the uncommitted changes in ${cwd}.\n\nChanged files:\n${summary}\n\nPlease review the uncommitted changes and provide feedback on code quality, correctness, and potential issues.`,
      });
      const id = (handle as any).id as string;
      setReviewSpawned(id);
      flash("Review agent spawned");
    } catch (e: unknown) {
      flash(e instanceof Error ? e.message : "Spawn failed", false);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  if (loadError && !DEMO) {
    return (
      <div className="right-dock-placeholder" data-testid="changes-panel">
        <span className="stat-alert" data-testid="changes-error">Could not load changes: {loadError}</span>
        <button className="btn ghost" data-testid="changes-retry" onClick={() => setAttempt((n) => n + 1)}>Retry</button>
      </div>
    );
  }

  if (loading && !DEMO) {
    return (
      <div className="right-dock-placeholder" data-testid="changes-panel">
        <span className="muted">{slow ? "Still loading… the daemon is slow right now." : "Loading changes…"}</span>
      </div>
    );
  }

  return (
    <div className="changes-panel" data-testid="changes-panel">

      {/* ── Status bar ── */}
      <div className="changes-status-bar">
        {isGit && currentBranch && (
          <span className="chip changes-branch" data-testid="changes-branch">⎇ {currentBranch}</span>
        )}
        {(ahead > 0 || behind > 0) && (
          <span className="chip">↑{ahead} ↓{behind}</span>
        )}
        <span className="spacer" />
        {statusMsg && (
          <span className={`changes-status-msg ${statusMsg.ok ? "ok" : "err"}`} data-testid="changes-status-msg">
            {statusMsg.text}
          </span>
        )}
      </div>

      {/* ── File list ── */}
      <div className="changes-file-list" data-testid="changes-file-list">
        {files.length === 0 && <div className="muted small">No uncommitted changes.</div>}

        {files.map((f) => {
          const isArmed = discardIsArmed(discardState) && discardState.includes(f.path) && discardState.length === 1;
          return (
            <div key={f.path} className="changes-file">
              <div
                className="changes-file-header"
                onClick={() => setExpandedFile(expandedFile === f.path ? null : f.path)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && setExpandedFile(expandedFile === f.path ? null : f.path)}
              >
                <span className={`changes-file-badge ${f.isNew ? "new" : f.isDeleted ? "del" : "mod"}`}>
                  {f.isNew ? "A" : f.isDeleted ? "D" : "M"}
                </span>
                <span className="changes-file-path">{f.path}</span>
                <span className="muted small">+{f.additions} -{f.deletions}</span>
                <span className="spacer" />

                {isArmed ? (
                  <span className="discard-confirm-group">
                    <button
                      className="btn bad small"
                      data-testid="changes-confirm-discard"
                      onClick={(e) => { e.stopPropagation(); handleDiscard([f.path]); }}
                    >
                      Confirm discard?
                    </button>
                    <button
                      className="btn ghost small"
                      onClick={(e) => { e.stopPropagation(); setDiscardState(discardCancel()); }}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className="btn ghost small"
                    onClick={(e) => { e.stopPropagation(); setDiscardState(discardArm([f.path])); }}
                  >
                    Discard
                  </button>
                )}
              </div>

              {expandedFile === f.path && (
                <div className="changes-file-diff" data-testid="changes-file-diff">
                  {f.status === "binary" ? (
                    <div className="muted small">Binary file</div>
                  ) : (
                    f.hunks.map((hunk, hi) =>
                      hunk.lines.map((line, li) => (
                        <div key={`${hi}-${li}`} className={`diff-line ${LINE_CLS[line.type] ?? ""}`}>
                          <code>{line.content}</code>
                        </div>
                      ))
                    )
                  )}
                </div>
              )}
            </div>
          );
        })}

        {files.length > 0 && (
          <div className="changes-discard-all-row">
            {discardIsArmed(discardState) && discardState.length > 1 ? (
              <span className="discard-confirm-group">
                <button
                  className="btn bad small"
                  data-testid="changes-confirm-discard"
                  onClick={() => handleDiscard(discardState)}
                >
                  Confirm discard all?
                </button>
                <button className="btn ghost small" onClick={() => setDiscardState(discardCancel())}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                className="btn ghost small"
                onClick={() => setDiscardState(discardArm(files.map((f) => f.path)))}
              >
                Discard all
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Commit box ── */}
      <div className="changes-commit-box">
        <textarea
          className="changes-commit-msg"
          data-testid="changes-commit-msg"
          placeholder="Commit message…"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          rows={2}
        />
        <button
          className="btn ok"
          data-testid="changes-commit-btn"
          onClick={handleCommit}
          disabled={!commitMsg.trim()}
        >
          Commit
        </button>
      </div>

      {/* ── Push / Pull / Merge from base ── */}
      <div className="changes-git-actions">
        <button className="btn ghost" data-testid="changes-push-btn" onClick={handlePush}>Push</button>
        <button className="btn ghost" data-testid="changes-pull-btn" onClick={handlePull}>Pull</button>
        <button className="btn ghost" data-testid="changes-merge-base-btn" onClick={handleMergeBase}>Merge from base</button>
      </div>

      {/* ── Branch switch ── */}
      <div className="changes-branch-switch">
        <button className="btn ghost small" onClick={() => setBranchOpen(!branchOpen)}>
          Switch branch…
        </button>
        {branchOpen && (
          <div className="changes-branch-dropdown">
            <input
              type="text"
              data-testid="changes-branch-select"
              placeholder="Branch name (create new or existing)…"
              value={branchInput}
              onChange={(e) => setBranchInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSwitchBranch()}
              autoFocus
            />
            <button className="btn ok small" onClick={handleSwitchBranch} disabled={!branchInput.trim()}>
              Switch
            </button>
            <button className="btn ghost small" onClick={() => { setBranchOpen(false); setBranchInput(""); }}>
              Cancel
            </button>
          </div>
        )}
      </div>

      {/* ── Stash ── */}
      <div className="changes-stash">
        <button className="btn ghost" data-testid="changes-stash-btn" onClick={handleStash}>
          Stash
        </button>
        <button
          className="btn ghost"
          data-testid="changes-stash-pop-btn"
          onClick={handleStashPop}
          disabled={stash.length === 0}
        >
          Pop stash{stash.length > 0 ? ` (${stash.length})` : ""}
        </button>
      </div>

      {/* ── Review diff ── */}
      <div className="changes-review">
        <button
          className="btn ghost"
          data-testid="changes-review-diff-btn"
          onClick={handleReviewDiff}
          disabled={files.length === 0}
        >
          🔍 Review this diff
        </button>
        {reviewSpawned && (
          <span className="muted small"> Agent {reviewSpawned.slice(0, 8)}…</span>
        )}
      </div>

      {/* ── PR section ── */}
      <div className="changes-pr-section" data-testid="changes-pr-section">
        <button className="changes-pr-toggle btn ghost small" onClick={() => setPrOpen(!prOpen)}>
          {pr ? `PR #${pr.number ?? "?"} · ${pr.state}` : "Pull Request"} {prOpen ? "▲" : "▼"}
        </button>

        {prOpen && (
          <div className="changes-pr-body">
            {hasWorkflowFiles && (
              <div className="warning-banner" data-testid="changes-pr-workflow-warning">
                ⚠ Touches workflow / release config
              </div>
            )}

            {pr ? (
              <div className="changes-pr-existing">
                <div className="changes-pr-meta">
                  <a href={pr.url} target="_blank" rel="noreferrer">{pr.title}</a>
                  <span className="chip">{pr.state}</span>
                  {pr.isDraft && <span className="chip muted">draft</span>}
                  {pr.checksStatus && <span className="chip">{pr.checksStatus}</span>}
                </div>

                {pr.checks && pr.checks.length > 0 && (
                  <div className="changes-pr-checks">
                    {pr.checks.map((c, i) => (
                      <div key={i} className={`check-run ${c.status.toLowerCase()}`}>
                        <span className="check-name">{c.name}</span>
                        <span className="muted small">{c.status}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="changes-pr-actions">
                  <button className="btn ghost small" onClick={handleAutoMerge}>
                    {autoMergeOn ? "Disable auto-merge" : "Enable auto-merge"}
                  </button>

                  {prMergeArmed ? (
                    <span className="discard-confirm-group">
                      {hasWorkflowFiles && (
                        <span className="muted small">⚠ Workflow / release files — confirm?</span>
                      )}
                      <button
                        className="btn bad small"
                        data-testid="changes-pr-merge-btn"
                        onClick={handlePrMerge}
                      >
                        Confirm merge
                      </button>
                      <button className="btn ghost small" onClick={() => setPrMergeArmed(false)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      className="btn ok small"
                      data-testid="changes-pr-merge-btn"
                      onClick={() => setPrMergeArmed(true)}
                    >
                      Merge PR
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="changes-pr-create">
                <input
                  type="text"
                  placeholder="PR title…"
                  value={prTitle}
                  onChange={(e) => setPrTitle(e.target.value)}
                />
                <textarea
                  placeholder="PR body (optional)…"
                  value={prBody}
                  onChange={(e) => setPrBody(e.target.value)}
                  rows={3}
                />
                <input
                  type="text"
                  placeholder={`Base branch (default: ${status?.baseRef ?? "main"})`}
                  value={prBase}
                  onChange={(e) => setPrBase(e.target.value)}
                />
                <button
                  className="btn ok small"
                  data-testid="changes-pr-create-btn"
                  onClick={handlePrCreate}
                  disabled={!prTitle.trim()}
                >
                  Create PR
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
