import { useState, useEffect, useCallback, useRef } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { daemonClient, DEMO, spawnTeamAgent } from "./paseo";
import { openAgent } from "./panes";
import { findProfile } from "./profiles";
import { usePref } from "./prefs";
import { undoHunk, undoDelta, hunkKey, ideUrl, firstChangedLine, clientOnDaemonHost, diffAsText } from "./hunkUndo";
import { CHANGES_SLOW_MS, changesErrorText, withTimeout } from "./changesLoad";
import * as git from "./paseoGit";
import type { CommitInfo, CheckDetails, TimelineItem } from "./paseoGit";
import { parsePrUrl, branchNameError, relTime, commitFileBadge, commitFileBadgeClass, clip } from "./gitHistoryLogic";

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

const DEMO_COMMITS: CommitInfo[] = [
  { sha: "a1b2c3d4e5f6", shortSha: "a1b2c3d", subject: "Changes panel: commit history browser", authorName: "Demo Dev", authorDate: new Date(Date.now() - 3600e3).toISOString(), isOnRemote: false, files: [
    { path: "src/ChangesPanel.tsx", additions: 120, deletions: 8, status: "modified" },
    { path: "src/paseoGit.ts", additions: 52, deletions: 0, status: "added" },
  ] },
  { sha: "b2c3d4e5f6a1", shortSha: "b2c3d4e", subject: "Vibe mode: per-Squad flag", authorName: "Demo Dev", authorDate: new Date(Date.now() - 86400e3 * 2).toISOString(), isOnRemote: true, files: [
    { path: "src/teams.ts", additions: 14, deletions: 2, status: "modified" },
  ] },
];

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

/** Keep/Undo/Open handlers for the working-tree diff; commit diffs in History render without them. */
type HunkActions = {
  hidden: (h: DiffHunk) => boolean;
  busy: boolean;
  onKeep: (h: DiffHunk) => void;
  onUndo: (h: DiffHunk) => void;
  ideHref: (h: DiffHunk) => string | null;
};

/** Renders one parsed diff file, including the binary and too_large states. */
function FileDiffView({ file, actions }: { file: DiffFile; actions?: HunkActions }) {
  if (file.status === "binary") return <div className="muted small">Binary file</div>;
  if (file.status === "too_large") return <div className="muted small">Diff too large to display</div>;
  if (!file.hunks?.length) return <div className="muted small">No textual changes.</div>;
  const shown = actions ? file.hunks.filter((h) => !actions.hidden(h)) : file.hunks;
  if (!shown.length) return <div className="muted small">All hunks kept or undone.</div>;
  return (
    <>
      {shown.map((hunk, hi) =>
        hunk.lines.map((line, li) => {
          if (!actions || line.type !== "header") {
            return (
              <div key={`${hi}-${li}`} className={`diff-line ${LINE_CLS[line.type] ?? ""}`}>
                <code>{line.content}</code>
              </div>
            );
          }
          const href = actions.ideHref(hunk);
          return (
            <div key={`${hi}-${li}`} className="diff-line diff-header changes-hunk-head" data-testid="changes-hunk">
              <code>{line.content}</code>
              <span className="spacer" />
              {href && <a className="btn ghost small" data-testid="changes-open-ide" href={href} title="Open in your IDE at this line">IDE ↗</a>}
              <button className="btn ghost small" data-testid="changes-hunk-keep" disabled={actions.busy} onClick={() => actions.onKeep(hunk)} title="Hide this hunk for this session">Keep</button>
              <button className="btn ghost small" data-testid="changes-hunk-undo" disabled={actions.busy} onClick={() => actions.onUndo(hunk)} title="Write the reverse of this hunk to the file">Undo</button>
            </div>
          );
        })
      )}
    </>
  );
}

// Kept hunks stay hidden for the session (across tab switches), keyed by cwd + hunk text and position.
const keptHunks = new Set<string>();
const MAX_UNDO_BYTES = 2 * 1024 * 1024;
const REVIEW_PROFILE = "Review - Sonnet";

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

  const [histOpen, setHistOpen] = useState(false);
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [openSha, setOpenSha] = useState<string | null>(null);
  const [openCommitFile, setOpenCommitFile] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState<DiffFile | "loading" | "none" | null>(null);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renameInput, setRenameInput] = useState("");
  const [renameArmed, setRenameArmed] = useState(false);
  const [renameNote, setRenameNote] = useState<string | null>(null);

  const [autoMergeArmed, setAutoMergeArmed] = useState(false);
  const [checkOpen, setCheckOpen] = useState<string | null>(null);
  const [checkInfo, setCheckInfo] = useState<CheckDetails | "loading" | { error: string } | null>(null);
  const [timeline, setTimeline] = useState<{ items: TimelineItem[]; truncated: boolean } | "loading" | { error: string } | null>(null);

  // Monotonic request ids: a slow response must not overwrite a newer selection (or another checkout's data).
  const seq = useRef({ hist: 0, diff: 0, check: 0, timeline: 0 });

  const [reviewSpawned, setReviewSpawned] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [ide] = usePref("app.openInIde");
  const [, setHunkVer] = useState(0);
  const [undoBusy, setUndoBusy] = useState(false);
  // Hunks undone since the last diff snapshot: hidden until the snapshot catches up, and their
  // line deltas shift the later hunks of the same file that are still on screen.
  const undone = useRef(new Map<string, { newStart: number; delta: number; key: string }[]>());
  const [statusMsg, setStatusMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const flash = useCallback((text: string, ok = true) => {
    setStatusMsg({ text, ok });
    setTimeout(() => setStatusMsg(null), 4000);
  }, []);

  // ─── Load data ──────────────────────────────────────────────────────────────

  useEffect(() => {
    let alive = true;
    const q = seq.current;
    q.hist++; q.diff++; q.check++; q.timeline++;
    setCommits(null); setOpenSha(null); setOpenCommitFile(null); setCommitDiff(null);
    setRenameOpen(false); setRenameInput(""); setRenameArmed(false); setRenameNote(null);
    setAutoMergeArmed(false); setPrMergeArmed(false); setDiscardState(null);
    setCheckOpen(null); setCheckInfo(null); setTimeline(null);
    setExpandedFile(null);
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

  useEffect(() => { undone.current.clear(); }, [diff]);

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

  const ideOn = ide !== "none" && (DEMO || clientOnDaemonHost(location.hostname));

  // ─── Actions ─────────────────────────────────────────────────────────────────

  const isKept = (path: string, h: DiffHunk) => keptHunks.has(`${cwd}|${hunkKey(path, h)}`);
  const hunkHidden = (path: string, h: DiffHunk) => {
    const k = hunkKey(path, h);
    return keptHunks.has(`${cwd}|${k}`) || (undone.current.get(path) ?? []).some((u) => u.key === k);
  };

  function keepHunks(path: string, hunks: DiffHunk[]) {
    for (const h of hunks) keptHunks.add(`${cwd}|${hunkKey(path, h)}`);
    setHunkVer((n) => n + 1);
  }

  function unkeepFile(path: string) {
    for (const k of [...keptHunks]) if (k.startsWith(`${cwd}|${path}@`)) keptHunks.delete(k);
    setHunkVer((n) => n + 1);
  }

  /** Undo hunks of one file: read it, reverse each hunk bottom-up, and write it back only if all apply. */
  async function undoFileHunks(f: DiffFile, hunks: DiffHunk[]) {
    if (!hunks.length) return;
    const n = `${hunks.length} hunk${hunks.length === 1 ? "" : "s"}`;
    const record = () => {
      const list = undone.current.get(f.path) ?? [];
      for (const h of hunks) list.push({ newStart: h.newStart, delta: undoDelta(h), key: hunkKey(f.path, h) });
      undone.current.set(f.path, list);
      setHunkVer((v) => v + 1);
    };
    if (DEMO) { record(); flash(`Undid ${n} (demo)`); return; }
    if (f.isDeleted) { flash("The file was deleted: use Discard to restore it", false); return; }
    setUndoBusy(true);
    try {
      const read = await daemonClient.readFile(cwd, f.path, undefined, MAX_UNDO_BYTES + 1);
      if (read.bytes.length > MAX_UNDO_BYTES) { flash("File too large to undo hunks here", false); return; }
      let content: string;
      try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes); }
      catch { flash("Not UTF-8 text: can't undo hunks in this file", false); return; }
      const prior = undone.current.get(f.path) ?? [];
      let next = content;
      for (const h of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
        const offset = prior.filter((u) => u.newStart < h.newStart).reduce((sum, u) => sum + u.delta, 0);
        const r = undoHunk(next, h, offset);
        if (!r.ok) { flash(r.error, false); return; }
        next = r.content;
      }
      if (next === "" && f.isNew) {
        const del = await daemonClient.deleteFileEntry({ cwd, path: f.path });
        if (!del.success) { flash(`Not undone: ${del.error ?? "delete failed"}`, false); return; }
      } else {
        const res = await daemonClient.writeFile({ cwd, path: f.path, content: next, expectedModifiedAt: read.modifiedAt });
        // writeFile resolves (doesn't throw) on a stale or failed write, so check the status.
        const w = res as { status?: string; error?: string };
        if (w?.status === "conflict") { flash("Not undone: the file changed on disk while undoing. Try again.", false); return; }
        if (w?.status === "error") { flash(`Not undone: ${w.error ?? "write failed"}`, false); return; }
      }
      record();
      flash(`Undid ${n} in ${f.path}`);
    } catch (e: unknown) {
      flash(e instanceof Error ? e.message : "Undo failed", false);
    } finally {
      setUndoBusy(false);
    }
  }

  const ideHref = (path: string) => (h: DiffHunk) => (ideOn ? ideUrl(ide, cwd, path, firstChangedLine(h)) : null);

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
    if (r.ok) { flash("Committed"); setCommitMsg(""); if (histOpen) void loadHistory(); }
    else flash(r.error ?? "Commit failed", false);
  }

  async function handlePush() {
    if (DEMO) { flash("Pushed (demo)"); return; }
    const r = await gitActionWrapper(() => daemonClient.checkoutPush(cwd));
    r.ok ? (flash("Pushed"), histOpen && void loadHistory()) : flash(r.error ?? "Push failed", false);
  }

  async function handlePull() {
    if (DEMO) { flash("Pulled (demo)"); return; }
    const r = await gitActionWrapper(() => daemonClient.checkoutPull(cwd));
    r.ok ? (flash("Pulled"), histOpen && void loadHistory()) : flash(r.error ?? "Pull failed", false);
  }

  async function handleMergeBase() {
    if (DEMO) { flash("Merged from base (demo)"); return; }
    const r = await gitActionWrapper(() => daemonClient.checkoutMergeFromBase(cwd, {}));
    r.ok ? (flash("Merged from base"), histOpen && void loadHistory()) : flash(r.error ?? "Merge failed", false);
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
    setAutoMergeArmed(false);
    const enable = !autoMergeOn;
    if (DEMO) { flash(`Auto-merge ${enable ? "enabled" : "disabled"} (demo)`); return; }
    const r = await gitActionWrapper(() => git.setAutoMerge(cwd, enable));
    if (r.ok) {
      flash(`Auto-merge ${enable ? "enabled" : "disabled"}`);
      daemonClient.checkoutPrStatus(cwd).then((p: any) => setPrData(p)).catch(() => {});
    } else flash(r.error ?? "Auto-merge failed", false);
  }

  async function loadHistory() {
    if (DEMO) { setCommits(DEMO_COMMITS); return; }
    setCommits(null);
    const id = ++seq.current.hist;
    const r = await gitActionWrapper(() => git.listCommits(cwd));
    if (id !== seq.current.hist) return;
    if (r.ok) setCommits(r.result!.commits); else { setCommits([]); flash(r.error ?? "History failed", false); }
  }

  function toggleCommit(sha: string) {
    seq.current.diff++;
    setOpenSha(openSha === sha ? null : sha);
    setOpenCommitFile(null);
    setCommitDiff(null);
  }

  function toggleHistory() {
    const next = !histOpen;
    setHistOpen(next);
    if (next && commits === null) void loadHistory();
  }

  async function openCommitFileDiff(sha: string, path: string) {
    if (openCommitFile === path) { seq.current.diff++; setOpenCommitFile(null); return; }
    setOpenCommitFile(path);
    setCommitDiff("loading");
    if (DEMO) { setCommitDiff(DEMO_DIFF.files[0]); return; }
    setCommitDiff("loading");
    const id = ++seq.current.diff;
    const r = await gitActionWrapper(() => git.commitFileDiff(cwd, sha, path));
    if (id !== seq.current.diff) return;
    setCommitDiff(r.ok && r.result ? (r.result as unknown as DiffFile) : "none");
  }

  async function handleRename() {
    const name = renameInput.trim();
    setRenameArmed(false);
    if (DEMO) { flash(`Renamed to ${name} (demo)`); setRenameOpen(false); return; }
    const r = await gitActionWrapper(() => git.renameCurrentBranch(cwd, name));
    if (r.ok) {
      flash(`Renamed to ${r.result}`);
      setRenameOpen(false); setRenameInput("");
      daemonClient.getCheckoutStatus(cwd).then((st: any) => setStatus(st)).catch(() => {});
    } else flash(r.error ?? "Rename failed", false);
  }

  useEffect(() => { setRenameArmed(false); setRenameNote(null); }, [currentBranch]);
  useEffect(() => { setAutoMergeArmed(false); }, [pr?.number, autoMergeOn]);

  async function armRename() {
    const local = branchNameError(renameInput, currentBranch);
    if (local) { setRenameNote(local); return; }
    if (!DEMO) {
      const v = await gitActionWrapper(() => git.validateBranchName(cwd, renameInput.trim()));
      if (!v.ok) { setRenameNote(v.error ?? "Could not validate the branch name"); return; }
      if (v.result?.error) { setRenameNote(v.result.error); return; }
      if (v.result?.exists) { setRenameNote("A branch with that name already exists"); return; }
    }
    setRenameNote(null);
    setRenameArmed(true);
  }

  async function toggleCheck(c: PrCheck) {
    const key = c.name;
    if (checkOpen === key) { setCheckOpen(null); return; }
    setCheckOpen(key);
    if (DEMO) { setCheckInfo({ name: c.name, status: c.status, output: { title: "Demo output", summary: "All assertions passed." } }); return; }
    setCheckInfo("loading");
    const id = ++seq.current.check;
    const ref = parsePrUrl(pr?.url);
    const r = await gitActionWrapper(() => git.checkDetails(cwd, {
      checkRunId: c.checkRunId, workflowRunId: c.workflowRunId,
      repoOwner: ref?.repoOwner, repoName: ref?.repoName, changeRequestNumber: pr?.number ?? ref?.number,
    }));
    if (id !== seq.current.check) return;
    setCheckInfo(r.ok ? (r.result ?? { error: "No details available" }) : { error: r.error ?? "Failed" });
  }

  async function loadTimeline() {
    const ref = parsePrUrl(pr?.url);
    if (DEMO) { setTimeline({ truncated: false, items: [{ id: "1", kind: "review", author: "reviewer", body: "Looks good.", createdAt: Date.now() - 3600e3, url: "", reviewState: "approved" }] }); return; }
    if (!ref) { setTimeline({ error: "Cannot read repo from PR url" }); return; }
    setTimeline("loading");
    const id = ++seq.current.timeline;
    const r = await gitActionWrapper(() => git.prTimeline(cwd, pr?.number ?? ref.number, ref.repoOwner, ref.repoName));
    if (id !== seq.current.timeline) return;
    setTimeline(r.ok ? r.result! : { error: r.error ?? "Failed" });
  }

  async function handleReviewDiff() {
    const summary = files.map((f) => `${f.isNew ? "A" : f.isDeleted ? "D" : "M"} ${f.path} (+${f.additions}/-${f.deletions})`).join("\n");
    const labels = (agent.labels ?? {}) as Record<string, string>;
    const { text, truncated } = diffAsText(files);
    const p = findProfile(REVIEW_PROFILE);
    const prompt = [
      `Code review (/code-review style) of the uncommitted changes in ${cwd}${currentBranch ? ` on branch ${currentBranch}` : ""}.`,
      "",
      "Changed files:",
      summary,
      "",
      `Run \`git status\` and \`git diff\` in that folder for the full, current diff${truncated ? " (the copy below is truncated)" : ""}, and read the surrounding code where you need it.`,
      "Report findings by severity: correctness bugs, security, data loss, then reuse and simplification. For each, give file:line, why it is wrong and the fix. End with PASS if nothing should block a commit, else FAIL.",
      "Read-only: don't edit, stage, commit or push anything.",
      "",
      "```diff",
      text.trimEnd(),
      "```",
    ].join("\n");

    setReviewBusy(true);
    try {
      // The profile's exact provider/model/mode; the fallback mirrors the built-in Review - Sonnet.
      const r = await spawnTeamAgent({
        provider: p?.provider ?? "claude",
        model: p?.model ?? "claude-sonnet-5-5",
        modeId: p?.modeId ?? "auto",
        thinkingOptionId: p?.thinkingOptionId,
        featureValues: p?.featureValues,
        notes: p?.notes,
        title: `${REVIEW_PROFILE} · ${currentBranch || "diff"}`.slice(0, 60),
        labels: {
          ...(labels.team ? { team: labels.team } : {}),
          ...(labels.lane ? { lane: labels.lane } : {}),
          role: "worker",
          profile: REVIEW_PROFILE,
          job: "diff-review",
          "paseo.parent-agent-id": agent.id,
        },
        prompt,
        cwd,
      });
      setReviewSpawned(r.id);
      openAgent(r.id, "background");
      flash(DEMO ? "Review agent opened in a new tab (demo)" : "Review agent opened in a new tab");
    } catch (e: unknown) {
      flash(e instanceof Error ? e.message : "Spawn failed", false);
    } finally {
      setReviewBusy(false);
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
      {diff?.diffTooLarge && (
        <div className="warning-banner" data-testid="changes-diff-too-large">⚠ Diff too large — some files are not shown</div>
      )}
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
                {f.status !== "binary" && f.status !== "too_large" && (f.hunks?.length ?? 0) > 0 && (() => {
                  const live = f.hunks.filter((h) => !hunkHidden(f.path, h));
                  const kept = f.hunks.filter((h) => isKept(f.path, h)).length;
                  return (
                    <>
                      {kept > 0 && (
                        <button className="btn ghost small" data-testid="changes-file-unkeep" title="Show the kept hunks again" onClick={(e) => { e.stopPropagation(); unkeepFile(f.path); }}>
                          {kept} kept
                        </button>
                      )}
                      {live.length > 0 && (
                        <>
                          <button className="btn ghost small" data-testid="changes-file-keep-all" onClick={(e) => { e.stopPropagation(); keepHunks(f.path, live); }}>Keep all</button>
                          <button className="btn ghost small" data-testid="changes-file-undo-all" disabled={undoBusy} onClick={(e) => { e.stopPropagation(); void undoFileHunks(f, live); }}>Undo all</button>
                        </>
                      )}
                    </>
                  );
                })()}

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
                  <FileDiffView
                    file={f}
                    actions={{
                      hidden: (h) => hunkHidden(f.path, h),
                      busy: undoBusy,
                      onKeep: (h) => keepHunks(f.path, [h]),
                      onUndo: (h) => void undoFileHunks(f, [h]),
                      ideHref: ideHref(f.path),
                    }}
                  />
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

      {/* ── Rename branch ── */}
      {isGit && currentBranch && (
        <div className="changes-branch-switch" data-testid="changes-rename">
          <button className="btn ghost small" onClick={() => { setRenameOpen(!renameOpen); setRenameArmed(false); setRenameNote(null); }}>
            Rename branch…
          </button>
          {renameOpen && (
            <div className="changes-branch-dropdown">
              <input
                type="text"
                data-testid="changes-rename-input"
                placeholder={`New name for ${currentBranch}`}
                value={renameInput}
                onChange={(e) => { setRenameInput(e.target.value); setRenameArmed(false); setRenameNote(null); }}
                onKeyDown={(e) => e.key === "Enter" && armRename()}
                autoFocus
              />
              {renameArmed ? (
                <span className="discard-confirm-group">
                  <button className="btn bad small" data-testid="changes-rename-confirm" onClick={handleRename}>
                    Confirm rename?
                  </button>
                  <button className="btn ghost small" onClick={() => setRenameArmed(false)}>Cancel</button>
                </span>
              ) : (
                <button className="btn ok small" onClick={armRename} disabled={!renameInput.trim()}>Rename</button>
              )}
              {renameNote && <div className="changes-history-note err">{renameNote}</div>}
            </div>
          )}
        </div>
      )}

      {/* ── Commit history ── */}
      <div className="changes-history" data-testid="changes-history">
        <button className="btn ghost small" data-testid="changes-history-toggle" onClick={toggleHistory}>
          History {histOpen ? "▲" : "▼"}
        </button>
        {histOpen && (
          <div className="changes-history-list">
            {commits === null && <div className="muted small">Loading history…</div>}
            {commits?.length === 0 && <div className="muted small">No commits.</div>}
            {commits?.map((c) => (
              <div key={c.sha} className="changes-file">
                <div
                  className="changes-file-header"
                  data-testid="changes-commit-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleCommit(c.sha)}
                  onKeyDown={(e) => e.key === "Enter" && toggleCommit(c.sha)}
                >
                  <code className="changes-sha">{c.shortSha}</code>
                  <span className="changes-file-path">{c.subject}</span>
                  {!c.isOnRemote && <span className="chip">local</span>}
                  <span className="muted small">{relTime(c.authorDate)}</span>
                </div>
                {openSha === c.sha && (
                  <div className="changes-commit-files">
                    <div className="muted small">{c.authorName} · {c.files.length} file{c.files.length === 1 ? "" : "s"}</div>
                    {c.files.map((f) => (
                      <div key={f.path} className="changes-file">
                        <div
                          className="changes-file-header"
                          data-testid="changes-commit-file"
                          role="button"
                          tabIndex={0}
                          onClick={() => openCommitFileDiff(c.sha, f.path)}
                          onKeyDown={(e) => e.key === "Enter" && openCommitFileDiff(c.sha, f.path)}
                        >
                          <span className={`changes-file-badge ${commitFileBadgeClass(f.status)}`}>{commitFileBadge(f.status)}</span>
                          <span className="changes-file-path">{f.path}</span>
                          <span className="muted small">+{f.additions} -{f.deletions}</span>
                        </div>
                        {openCommitFile === f.path && (
                          <div className="changes-file-diff" data-testid="changes-commit-diff">
                            {commitDiff === "loading" && <div className="muted small">Loading diff…</div>}
                            {commitDiff === "none" && <div className="muted small">No diff available.</div>}
                            {commitDiff && typeof commitDiff === "object" && <FileDiffView file={commitDiff} />}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
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
          disabled={files.length === 0 || reviewBusy}
          title={`Spawns a ${REVIEW_PROFILE} agent on this diff; it reports in its own tab`}
        >
          {reviewBusy ? "Spawning review…" : "🔍 Review this diff"}
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
                      <div key={i}>
                        <div
                          className={`check-run clickable ${c.status.toLowerCase()}`}
                          data-testid="changes-check-row"
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleCheck(c)}
                          onKeyDown={(e) => e.key === "Enter" && toggleCheck(c)}
                        >
                          <span className="check-name">{c.name}</span>
                          <span className="muted small">{c.status}</span>
                        </div>
                        {checkOpen === c.name && (
                          <div className="changes-check-details" data-testid="changes-check-details">
                            {checkInfo === "loading" && <span className="muted small">Loading…</span>}
                            {checkInfo && typeof checkInfo === "object" && "error" in checkInfo && <span className="changes-history-note err">{checkInfo.error}</span>}
                            {checkInfo && typeof checkInfo === "object" && "name" in checkInfo && (
                              <>
                                {checkInfo.conclusion && <div className="small">Conclusion: {checkInfo.conclusion}</div>}
                                {checkInfo.output?.title && <div className="small">{checkInfo.output.title}</div>}
                                {checkInfo.output?.summary && <pre className="changes-check-text">{clip(checkInfo.output.summary)}</pre>}
                                {(checkInfo.failedJobs ?? []).map((j, ji) => <div key={ji} className="small changes-history-note err">Failed job: {j.name}</div>)}
                                {checkInfo.url && <a href={checkInfo.url} target="_blank" rel="noreferrer" className="small">Open on forge</a>}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {timeline && (
                  <div className="changes-pr-timeline" data-testid="changes-pr-timeline">
                    {timeline === "loading" && <span className="muted small">Loading timeline…</span>}
                    {typeof timeline === "object" && "error" in timeline && <span className="changes-history-note err">{timeline.error}</span>}
                    {typeof timeline === "object" && "items" in timeline && (
                      <>
                        {timeline.items.length === 0 && <span className="muted small">No activity.</span>}
                        {timeline.items.map((it, i) => (
                          <div key={it.id || i} className="changes-timeline-item">
                            <div className="small"><b>{it.author}</b> {it.kind === "review" ? (it.reviewState ?? "reviewed").replace("_", " ") : "commented"} <span className="muted">{it.createdAt ? relTime(new Date(it.createdAt).toISOString()) : ""}</span></div>
                            {it.body && <div className="small muted">{clip(it.body, 240)}</div>}
                          </div>
                        ))}
                        {timeline.truncated && <span className="muted small">…truncated</span>}
                      </>
                    )}
                  </div>
                )}

                <div className="changes-pr-actions">
                  {autoMergeArmed ? (
                    <span className="discard-confirm-group">
                      <button className="btn bad small" data-testid="changes-automerge-confirm" onClick={handleAutoMerge}>
                        Confirm {autoMergeOn ? "disable" : "enable"} auto-merge?
                      </button>
                      <button className="btn ghost small" onClick={() => setAutoMergeArmed(false)}>Cancel</button>
                    </span>
                  ) : (
                    <button className="btn ghost small" data-testid="changes-automerge-btn" onClick={() => setAutoMergeArmed(true)}>
                      {autoMergeOn ? "Disable auto-merge" : "Enable auto-merge"}
                    </button>
                  )}
                  <button className="btn ghost small" data-testid="changes-timeline-btn" onClick={loadTimeline}>Timeline</button>

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
