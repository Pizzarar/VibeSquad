// Inline edit on a selection (Files editor, Ctrl+K): the prompt box, the per-file edit session and
// its inline Keep/Undo review. Pure parts are in src/inlineEditLogic.ts.
//
// Result detection: the file is read fresh at send time (the snapshot) and watched with
// daemonClient.subscribeFile. Every new modifiedAt re-reads it and diffs snapshot → current into
// hunks, so the review fills in while the agent works. The agent's status is watched too: when it
// stops running, one last read settles it, and if the file still equals the snapshot the session says
// the agent finished without touching it. The watch stays on until the session is dismissed, so a
// late write still shows up.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { daemonClient, DEMO, getPaseoState, sendMessage, subscribePaseo, usePaseo } from "./paseo";
import { getPanes } from "./panes";
import { cleanTitle } from "./ui";
import { openRightDockTab } from "./RightDock";
import { undoHunk, undoHunks, type Hunk } from "./hunkUndo";
import { buildInlineEditPrompt, diffHunks, editTargets, hunkStats, rangeLabel, sliceLines, snapshotHunkKey, type LineRange } from "./inlineEditLogic";

type Phase = "pending" | "changed" | "untouched" | "error";

export type InlineSession = {
  cwd: string;
  path: string;
  agentId: string;
  agentTitle: string;
  range: LineRange;
  sent: string;
  snapshot: string;
  current: string;
  currentMtime: string;
  phase: Phase;
  agentDone: boolean;
  /** The user undid back to the snapshot (so "untouched" doesn't mean the agent skipped it). */
  undone: boolean;
  error: string;
  busy: boolean;
  kept: Set<string>;
};

const MAX_BYTES = 2 * 1024 * 1024;
const sessions = new Map<string, InlineSession>();
const teardowns = new Map<string, () => void>();
const listeners = new Set<() => void>();
const keyOf = (cwd: string, path: string) => JSON.stringify([cwd, path]);

function patch(key: string, p: Partial<InlineSession>) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.set(key, { ...s, ...p });
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useInlineSession(cwd: string, path: string | null): InlineSession | null {
  return useSyncExternalStore(subscribe, () => (path ? sessions.get(keyOf(cwd, path)) ?? null : null));
}

export function dismissInlineEdit(cwd: string, path: string) {
  const key = keyOf(cwd, path);
  teardowns.get(key)?.();
  teardowns.delete(key);
  sessions.delete(key);
  listeners.forEach((l) => l());
}

async function readText(cwd: string, path: string): Promise<{ text: string; mtime: string }> {
  const r = await daemonClient.readFile(cwd, path, undefined, MAX_BYTES + 1);
  if (r.bytes.length > MAX_BYTES) throw new Error("File too large for inline edit");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(r.bytes); }
  catch { throw new Error("Not UTF-8 text: inline edit can't diff this file"); }
  return { text, mtime: r.modifiedAt };
}

/** Re-reads the file and moves the session to changed / pending / untouched. */
async function refresh(key: string) {
  const s = sessions.get(key);
  if (!s) return;
  try {
    const { text, mtime } = await readText(s.cwd, s.path);
    const cur = sessions.get(key);
    if (!cur) return;
    const changed = text !== cur.snapshot;
    patch(key, { current: text, currentMtime: mtime, phase: changed ? "changed" : cur.agentDone ? "untouched" : "pending" });
  } catch (e) {
    patch(key, { phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Snapshots the file, starts watching it and the agent, then sends the prompt through the composer's
 * send path. `viewText` is what the user selected in; if the disk copy differs the edit is refused.
 */
export async function startInlineEdit(opts: { cwd: string; path: string; agentId: string; agentRel: string; agentTitle: string; range: LineRange; instruction: string; viewText: string }): Promise<string | null> {
  const { cwd, path, range } = opts;
  const key = keyOf(cwd, path);
  dismissInlineEdit(cwd, path);
  let snap = { text: opts.viewText, mtime: "" };
  if (!DEMO) {
    try { snap = await readText(cwd, path); }
    catch (e) { return e instanceof Error ? e.message : String(e); }
    if (snap.text !== opts.viewText) return "The file changed on disk since it was opened here. Reopen it and select again.";
  }
  const sent = buildInlineEditPrompt(opts.agentRel, range, opts.instruction, sliceLines(snap.text, range));
  sessions.set(key, {
    cwd, path, agentId: opts.agentId, agentTitle: opts.agentTitle, range, sent,
    snapshot: snap.text, current: snap.text, currentMtime: snap.mtime,
    phase: "pending", agentDone: false, undone: false, error: "", busy: false, kept: new Set(),
  });
  listeners.forEach((l) => l());
  if (DEMO) return null;

  const offs: (() => void)[] = [];
  teardowns.set(key, () => offs.forEach((f) => f()));
  let released = false;
  offs.push(() => { released = true; });
  daemonClient
    .subscribeFile({ cwd, path }, (v) => {
      if (v.status === "ready" && v.modifiedAt !== sessions.get(key)?.currentMtime) void refresh(key);
      else if (v.status === "missing") patch(key, { phase: "error", error: "The file was deleted." });
    })
    .then((sub) => {
      if (released) void sub.unsubscribe().catch(() => {});
      else offs.push(() => void sub.unsubscribe().catch(() => {}));
    })
    .catch(() => {}); // the idle check below still settles the session

  // The agent stopping is the other signal: settle once it has run and stopped.
  let sawRunning = false;
  const check = () => {
    const a = getPaseoState().agents.get(opts.agentId);
    const s = sessions.get(key);
    if (!s || s.agentDone) return;
    if (a?.status === "running") { sawRunning = true; return; }
    if (sawRunning || !a) {
      patch(key, { agentDone: true });
      void refresh(key);
    }
  };
  offs.push(subscribePaseo(check));
  // An agent that finished before the store ever showed it running still settles.
  const t = setTimeout(() => { sawRunning = true; check(); }, 15_000);
  offs.push(() => clearTimeout(t));

  try {
    await sendMessage(opts.agentId, sent);
  } catch (e) {
    patch(key, { phase: "error", error: `Not sent: ${e instanceof Error ? e.message : String(e)}` });
    return null;
  }
  check();
  return null;
}

async function undoInline(key: string, hunks: Hunk[]) {
  const s = sessions.get(key);
  if (!s || !hunks.length) return;
  if (DEMO) { patch(key, { error: "Undo isn't available in demo mode" }); return; }
  patch(key, { busy: true, error: "" });
  try {
    const { text, mtime } = await readText(s.cwd, s.path);
    const r = hunks.length === 1 ? undoHunk(text, hunks[0]) : undoHunks(text, hunks);
    if (!r.ok) { patch(key, { error: r.error }); return; }
    const res = await daemonClient.writeFile({ cwd: s.cwd, path: s.path, content: r.content, expectedModifiedAt: mtime });
    // writeFile resolves (doesn't throw) on a stale or failed write, so check the status.
    const w = res as { status?: string; error?: string; modifiedAt?: string };
    if (w?.status === "conflict") { patch(key, { error: "Not undone: the file changed on disk while undoing. Try again." }); return; }
    if (w?.status === "error") { patch(key, { error: `Not undone: ${w.error ?? "write failed"}` }); return; }
    const cur = sessions.get(key);
    const back = !!cur && r.content === cur.snapshot;
    if (cur) patch(key, { current: r.content, currentMtime: w?.modifiedAt ?? cur.currentMtime, undone: cur.undone || back, phase: back ? (cur.agentDone ? "untouched" : "pending") : "changed" });
  } catch (e) {
    patch(key, { error: e instanceof Error ? e.message : String(e) });
  } finally {
    patch(key, { busy: false });
  }
}

// ---- prompt box ---------------------------------------------------------------------------------

/** The active pane's agent (the default edit target), as the palette's navigation reads it. */
function activePaneAgentId(): string | null {
  const s = getPanes();
  return (s.split && s.activePane === "right" ? s.rightActiveId : s.leftActiveId) ?? null;
}

export function InlineEditBox({ cwd, path, range, viewText, top, onClose }: { cwd: string; path: string; range: LineRange; viewText: string; top: number; onClose: () => void }) {
  const { agents } = usePaseo();
  const targets = useMemo(
    () => editTargets([...agents.values()].map((a) => ({ id: a.id, cwd: a.cwd, title: cleanTitle(a.title), archivedAt: a.archivedAt, status: a.status })), cwd, path, activePaneAgentId()),
    [agents, cwd, path],
  );
  const [agentId, setAgentId] = useState("");
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const target = targets.find((t) => t.id === agentId) ?? targets[0];

  const submit = async () => {
    if (!text.trim() || !target || busy) return;
    setBusy(true);
    setErr("");
    const e = await startInlineEdit({ cwd, path, agentId: target.id, agentRel: target.rel, agentTitle: target.title, range, instruction: text, viewText });
    setBusy(false);
    if (e) setErr(e);
    else onClose();
  };

  return (
    <div className="inline-edit-box" data-testid="inline-edit-box" style={{ top }} onMouseDown={(e) => e.stopPropagation()}>
      <div className="inline-edit-box-head">
        <span>Edit {rangeLabel(range)}</span>
        {targets.length > 0 && (
          <select data-testid="inline-edit-agent" value={target?.id ?? ""} onChange={(e) => setAgentId(e.target.value)} title="Agent that makes the edit">
            {targets.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        )}
      </div>
      {targets.length === 0 ? (
        <div className="muted small" data-testid="inline-edit-no-agent">No live agent works in a folder that holds this file.</div>
      ) : (
        <textarea
          autoFocus
          data-testid="inline-edit-input"
          className="inline-edit-input"
          rows={2}
          value={text}
          placeholder="What should change? Enter sends, Esc cancels"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
            else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
          }}
        />
      )}
      <div className="inline-edit-box-foot">
        {err && <span className="stat-alert small" data-testid="inline-edit-error">{err}</span>}
        <span className="spacer" />
        <button className="btn ghost small" onClick={onClose}>Cancel</button>
        <button className="btn ok small" data-testid="inline-edit-send" disabled={!text.trim() || !target || busy} onClick={() => void submit()}>{busy ? "Sending…" : "Send"}</button>
      </div>
    </div>
  );
}

// ---- review -------------------------------------------------------------------------------------

const LINE_CLS: Record<string, string> = { add: "diff-add", remove: "diff-remove", header: "diff-header", context: "" };

export function InlineEditReview({ session: s }: { session: InlineSession }) {
  const key = keyOf(s.cwd, s.path);
  const hunks = useMemo(() => diffHunks(s.snapshot, s.current), [s.snapshot, s.current]);
  const live = hunks.filter((h) => !s.kept.has(snapshotHunkKey(s.path, h)));
  const stats = hunkStats(hunks);
  const keep = (hs: Hunk[]) => patch(key, { kept: new Set([...s.kept, ...hs.map((h) => snapshotHunkKey(s.path, h))]) });
  const [showSent, setShowSent] = useState(false);
  const status =
    s.phase === "pending" ? `${s.agentTitle} is working…`
    : s.phase === "untouched" ? (s.undone ? "All changes undone." : `${s.agentTitle} finished without touching this file.`)
    : s.phase === "error" ? s.error
    : live.length ? `${live.length} change${live.length === 1 ? "" : "s"} to review (+${stats.add} −${stats.del})`
    : s.agentDone ? "Nothing left to review." : "Nothing left to review yet; the agent is still working.";

  return (
    <div className={`inline-edit-review phase-${s.phase}`} data-testid="inline-edit-review" data-phase={s.phase}>
      <div className="inline-edit-review-head">
        <span className="inline-edit-tag">✎ {rangeLabel(s.range)}</span>
        <span className="inline-edit-status" data-testid="inline-edit-status">{s.phase === "pending" && <span className="inline-edit-spin" />}{status}</span>
        <span className="spacer" />
        {live.length > 1 && (
          <>
            <button className="btn ghost small" data-testid="inline-edit-keep-all" disabled={s.busy} onClick={() => keep(live)}>Keep all</button>
            <button className="btn ghost small" data-testid="inline-edit-undo-all" disabled={s.busy} onClick={() => void undoInline(key, live)}>Undo all</button>
          </>
        )}
        <button className="btn ghost small" data-testid="inline-edit-open-changes" onClick={() => openRightDockTab("Changes")} title="Review the whole working-tree diff">Open in Changes</button>
        <button className="btn ghost small" data-testid="inline-edit-sent-toggle" onClick={() => setShowSent((v) => !v)} title="The message sent to the agent">{showSent ? "Hide prompt" : "Prompt"}</button>
        <button className="btn ghost small" data-testid="inline-edit-dismiss" onClick={() => dismissInlineEdit(s.cwd, s.path)} title="Close this review (changes stay in the file)">✕</button>
      </div>
      {s.error && s.phase !== "error" && <div className="stat-alert small" data-testid="inline-edit-review-error">{s.error}</div>}
      {showSent && <pre className="inline-edit-sent" data-testid="inline-edit-sent">{s.sent}</pre>}
      {s.phase === "changed" && live.length > 0 && (
        <div className="inline-edit-hunks">
          {live.map((h) => {
            const k = snapshotHunkKey(s.path, h);
            return (
              <div key={k} data-testid="inline-edit-hunk">
                {h.lines.map((l, i) =>
                  l.type === "header" ? (
                    <div key={i} className="diff-line diff-header changes-hunk-head">
                      <code>{l.content}</code>
                      <span className="spacer" />
                      <button className="btn ghost small" data-testid="inline-edit-hunk-keep" disabled={s.busy} onClick={() => keep([h])} title="Keep this change">Keep</button>
                      <button className="btn ghost small" data-testid="inline-edit-hunk-undo" disabled={s.busy} onClick={() => void undoInline(key, [h])} title="Write the reverse of this change to the file">Undo</button>
                    </div>
                  ) : (
                    <div key={i} className={`diff-line ${LINE_CLS[l.type] ?? ""}`}><code>{l.content}</code></div>
                  ),
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Ref helper: the latest value without re-running effects. */
export function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

/** Keeps the Files view in step with the session's latest read of the file. */
export function useSessionContent(s: InlineSession | null, apply: (text: string, mtime: string) => void) {
  const applyRef = useLatest(apply);
  useEffect(() => {
    if (s && s.currentMtime) applyRef.current(s.current, s.currentMtime);
  }, [s?.current, s?.currentMtime]); // eslint-disable-line react-hooks/exhaustive-deps
}
