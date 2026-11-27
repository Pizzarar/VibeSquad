// Storybook V6 owner marks UI: the useMarks hook (GET/POST /api/storybook/:p/marks), the OK / Redo / Edit trio a Review row
// or arc line carries, the batch bar on a group/arc header, and the session bar ("End session" = one EFI commit).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EntityIndex, SbEntity } from "./storybookLogic";
import { allLines, batchMarks, commitSummary, draftRewrite, entityTarget, formMark, hasSessionError, isSessionStatus, markLabel, markState, marksByKey, nextSiblingOks, openContractsHint, progress, siblingOkHint, type Mark, type MarkState, type MarksError, type MarksState, type ServerMark } from "./storybookMarks";

export type MarksApi = {
  state: MarksState;
  busy: boolean;
  /** The session bar's error; `session` errors block marking, transient ones are dismissible (see MarksError). */
  error: MarksError | null;
  /** Clear the error (transient: dismiss; session: retry, re-reading the session from the server). */
  dismissError: () => void;
  lines: SbEntity[];
  byKey: Map<string, ServerMark>;
  stateOf: (e: SbEntity | null | undefined) => MarkState;
  mark: (marks: Mark[]) => Promise<boolean>;
  commit: () => Promise<void>;
  lastCommit: string | null;
};

const EMPTY: MarksState = { exists: false, branch: null, pending: 0, marks: [] };

export function useMarks(projectId: string, idx: EntityIndex): MarksApi {
  const url = `/api/storybook/${encodeURIComponent(projectId)}/marks`;
  const [state, setState] = useState<MarksState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setErrorState] = useState<MarksError | null>(null);
  const setError = useCallback((msg: string | null, session = false) => setErrorState(msg ? { msg, session } : null), []);
  const [lastCommit, setLastCommit] = useState<string | null>(null);
  const [siblingOks, setSiblingOks] = useState<Set<string>>(() => new Set());
  // The project this hook is bound to right now: a response for a project the owner has since switched away from is dropped.
  const cur = useRef(url);
  cur.current = url;
  /** Re-read the session (marks, branch, pending, auto-commit failure) from the server. */
  const reload = useCallback(async (forUrl: string) => {
    try {
      const r = await fetch(forUrl);
      const b = await r.json().catch(() => null);
      if (cur.current !== forUrl) return;
      if (r.ok && b && Array.isArray(b.marks)) setState(b);
      else if (!r.ok && b?.error) setError(b.error, true);
    } catch { /* marks are optional: no session yet */ }
  }, []);
  useEffect(() => {
    // project switch: nothing of the previous project's session may show while this one loads
    setState(EMPTY); setError(null); setLastCommit(null); setBusy(false); setSiblingOks(new Set());
    void reload(url);
  }, [url, reload]);
  const lines = useMemo(() => allLines(idx), [idx]);
  const byKey = useMemo(() => marksByKey(state.marks), [state.marks]);
  const stateOf = useCallback((e: SbEntity | null | undefined) => markState(e, lines, byKey, state.exists, siblingOks), [lines, byKey, state.exists, siblingOks]);
  const mark = useCallback(async (marks: Mark[]) => {
    if (!marks.length) return true;
    setBusy(true); setError(null);
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marks }) });
      const b = await r.json().catch(() => null);
      if (cur.current !== url) return false;
      if (!r.ok) { setError(b?.error ?? `mark failed (${r.status})`, isSessionStatus(r.status)); return false; }
      setState((s) => ({ ...s, exists: true, branch: b.branch, pending: b.pending, marks: b.marks, autoCommitError: undefined }));
      setSiblingOks((prev) => nextSiblingOks(prev, marks, b.results));
      const bad = (b.results as { ok: boolean; error?: string }[]).filter((x) => !x.ok);
      if (bad.length) setError(`${bad.length} of ${marks.length} not saved: ${bad[0].error}${bad[0].error?.startsWith("stale") ? " (Refresh to see the current text)" : ""}`);
      else if (b.baseline && b.baseline.ok === false) setError(`Review session started, but ${b.baseline.reason}`, true);
      return bad.length === 0;
    } catch (e) { if (cur.current === url) setError(e instanceof Error ? e.message : String(e)); return false; } finally { if (cur.current === url) setBusy(false); }
  }, [url]);
  const commit = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${url}/commit`, { method: "POST" });
      const b = await r.json().catch(() => null);
      if (cur.current !== url) return;
      if (!r.ok) { setError(b?.error ?? `commit failed (${r.status})`, true); await reload(url); return; }
      setLastCommit(commitSummary(b));
      if (b?.write === "missing") setError("review_pack --write did not run: run python tools/review_pack.py --write in the review worktree before --check.", true);
      // the server's sheet is the truth after --write (marks it dropped, the branch after a midnight rollover)
      await reload(url);
    } catch (e) { if (cur.current === url) setError(e instanceof Error ? e.message : String(e)); } finally { if (cur.current === url) setBusy(false); }
  }, [url, reload]);
  const dismissError = useCallback(() => {
    const wasSession = error?.session;
    setError(null);
    if (wasSession) void reload(url);
  }, [error, url, reload, setError]);
  return { state, busy, error, dismissError, lines, byKey, stateOf, mark, commit, lastCommit };
}


/**
 * OK / Redo / Edit on one entity (a csv line or a contract). data-mark-key 1/2/3 lets the row's keyboard handler press them.
 * A contract row is a preview of one shared template row, so its third button is "Note" (a contract:<id> note, NEEDS-REWRITE),
 * never an owner_rewrite: template rewrites come only from the template row itself.
 */
export function MarkButtons({ e, m }: { e: SbEntity | null | undefined; m: MarksApi }) {
  const [open, setOpen] = useState<"redo" | "edit" | "note" | null>(null);
  const [draft, setDraft] = useState("");
  const hit = entityTarget(e, m.lines);
  if (!e || !hit) return null;
  const st = m.stateOf(e);
  const drafted = draftRewrite(hit.template ?? e);
  const errBlocked = hasSessionError(m.error, m.state);
  const disabled = m.busy || errBlocked;
  const errTip = "Resolve the review session error in the session bar first";
  const send = async (mk: Omit<Mark, "target">) => { if (await m.mark([{ target: hit.target, ...(hit.contract ? { contract: hit.contract } : {}), ...mk }])) setOpen(null); };
  const start = (k: "redo" | "edit" | "note") => { setDraft(k === "redo" ? (st.contractNote || st.note) : k === "note" ? "" : (st.rewrite || drafted || hit.target.seen.replace(/^'(?=[+\-=@])/, ""))); setOpen(open === k ? null : k); };
  return (
    <span className="sb-mark" data-testid="sb-mark" data-mark={st.kind}>
      {st.kind === "none" && drafted && <span className="sb-mark-draft" title="Drafted rewrite: OK approves it">Draft: {drafted}</span>}
      {st.kind === "edit" && <span className="sb-mark-draft" title="Your rewrite">→ {st.rewrite}</span>}
      {st.kind === "ok" && st.draft && <span className="sb-mark-draft" title="Drafted rewrite you approved">→ {st.rewrite}</span>}
      {st.kind === "redo" && st.openContracts && st.rewrite && st.rewrite !== drafted ? <span className="sb-mark-draft" title="Your rewrite (stored; the row stays Redo while contract notes are open)">→ {st.rewrite}</span> : null}
      {!st.siblingOk && st.openContracts ? <span className="sb-mark-hint" data-testid="sb-open-contracts">{openContractsHint(st)}</span> : null}
      {st.siblingOk && st.openContracts ? (
        <span className="sb-mark-state sb-mark-sibling-ok" data-testid="sb-sibling-ok" title="This contract has no open note; the shared template stays NEEDS-REWRITE until the other contract notes are resolved">
          {siblingOkHint(st)}
        </span>
      ) : null}
      {st.kind !== "none" && (
        <span className={`sb-mark-state sb-mark-${st.kind}`} data-testid="sb-mark-state" title={st.contractNote || st.note || st.rewrite || markLabel(st)}>
          {markLabel(st)}{(st.contractNote || st.note) ? `: ${st.contractNote || st.note}` : ""}
        </span>
      )}
      <span className="sb-mark-btns">
        <button type="button" className="sb-mbtn sb-mbtn-ok" data-mark-key="1" aria-pressed={st.kind === "ok"} disabled={disabled} title={errBlocked ? errTip : hit.contract ? "OK the shared contract title template (key 1)" : drafted && st.kind === "none" ? "OK: approves the drafted rewrite (key 1)" : "OK (key 1)"} onClick={() => void send({ action: "ok" })}>OK</button>
        <button type="button" className="sb-mbtn sb-mbtn-redo" data-mark-key="2" aria-pressed={st.kind === "redo"} aria-expanded={open === "redo"} disabled={disabled} title={errBlocked ? errTip : "Redo with a note (key 2)"} onClick={() => start("redo")}>Redo</button>
        {hit.contract
          ? <button type="button" className="sb-mbtn sb-mbtn-edit" data-mark-key="3" aria-pressed={false} aria-expanded={open === "note"} disabled={disabled} title={errBlocked ? errTip : "Note for this contract only: how it should read (the shared template is not changed) (key 3)"} onClick={() => start("note")}>Note</button>
          : <button type="button" className="sb-mbtn sb-mbtn-edit" data-mark-key="3" aria-pressed={st.kind === "edit"} aria-expanded={open === "edit"} disabled={disabled} title={errBlocked ? errTip : "Edit the text (key 3)"} onClick={() => start("edit")}>Edit</button>}
        {st.kind !== "none" && !hit.contract && <button type="button" className="sb-mbtn sb-mbtn-clear" disabled={disabled} title={errBlocked ? errTip : "Undo your mark"} aria-label="Undo mark" onClick={() => void send({ action: "clear" })}>↺</button>}
      </span>
      {open && (
        <form className="sb-mark-form" data-testid="sb-mark-form" onSubmit={(ev) => { ev.preventDefault(); void send(formMark(open, draft, hit.contract)); }}>
          {open === "note" && <span className="sb-mark-hint">Note for this contract only: the shared {String(e.data?.type ?? "")} title template is not changed.</span>}
          <textarea className="sb-mark-input" aria-label={open === "redo" ? "What should change" : open === "note" ? "Note for this contract" : "New text"} placeholder={open === "redo" ? "What should change?" : open === "note" ? "How should this contract read?" : ""} rows={open === "edit" ? 3 : 2} value={draft} autoFocus
            onChange={(ev) => setDraft(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Escape") setOpen(null); if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) (ev.currentTarget.form as HTMLFormElement | null)?.requestSubmit(); ev.stopPropagation(); }} />
          <span className="sb-mark-formbtns">
            <button type="submit" className="sb-mbtn sb-mbtn-save" disabled={disabled || !draft.trim()}>{open === "edit" ? "Save edit" : "Save note"}</button>
            <button type="button" className="sb-mbtn" onClick={() => setOpen(null)}>Cancel</button>
          </span>
        </form>
      )}
    </span>
  );
}

/** "Popper 4/16 reviewed" + OK all + Redo all with one note, for a Review group or an arc card. */
export function MarkBatch({ entities, label, m }: { entities: SbEntity[]; label?: string; m: MarksApi }) {
  const [redo, setRedo] = useState(false);
  const [note, setNote] = useState("");
  const markable = entities.filter((e) => entityTarget(e, m.lines));
  if (!markable.length) return null;
  const p = progress(markable.map((e) => m.stateOf(e)));
  const okAll = batchMarks(markable, m.lines, m.byKey, m.state.exists, "ok");
  const disabled = m.busy || hasSessionError(m.error, m.state);
  return (
    <span className="sb-batch" data-testid="sb-batch">
      <span className="sb-progress" data-testid="sb-progress">{label ? `${label} ` : ""}{p.done}/{p.total} reviewed</span>
      {okAll.length > 0 && <button type="button" className="sb-mbtn sb-mbtn-ok" disabled={disabled} data-testid="sb-ok-all" title="Mark every row without a mark OK (your Redo/Edit marks stay)" onClick={() => void m.mark(okAll)}>OK all ({okAll.length})</button>}
      {okAll.length > 0 && <button type="button" className="sb-mbtn sb-mbtn-redo" disabled={disabled} aria-expanded={redo} onClick={() => setRedo((v) => !v)}>Redo all…</button>}
      {redo && (
        <form className="sb-mark-form" onSubmit={(ev) => { ev.preventDefault(); void m.mark(batchMarks(markable, m.lines, m.byKey, m.state.exists, "redo", note)).then((ok) => { if (ok) { setRedo(false); setNote(""); } }); }}>
          <input className="sb-mark-input" aria-label="One note for every unmarked row" placeholder={`One note for ${okAll.length} rows`} value={note} autoFocus onChange={(ev) => setNote(ev.target.value)} onKeyDown={(ev) => ev.stopPropagation()} />
          <button type="submit" className="sb-mbtn sb-mbtn-save" disabled={disabled || !note.trim()}>Redo {okAll.length}</button>
        </form>
      )}
    </span>
  );
}

/** Session bar: branch, pending count, End session (commit), last error. */
export function MarksBar({ m }: { m: MarksApi }) {
  const n = m.state.marks.length;
  return (
    <div className="sb-marksbar" data-testid="sb-marksbar" role="status">
      <span className="sb-marksbar-txt">
        {m.state.exists ? (
          <>
            <span className="sb-marksbar-full">Review session <span className="sb-mono">{m.state.branch}</span> · {n} marked · {m.state.pending ? `${m.state.pending} unsaved row${m.state.pending === 1 ? "" : "s"}` : "all committed"}</span>
            <span className="sb-marksbar-short">{n} marked · {m.state.pending ? `${m.state.pending} unsaved` : "committed"}</span>
          </>
        ) : (
          <>
            <span className="sb-marksbar-full">No review session yet: your first OK / Redo / Edit starts one (an EFI branch, never main).</span>
            <span className="sb-marksbar-short">No review session yet · mark a line to start</span>
          </>
        )}
      </span>
      {m.state.exists && <button type="button" className="sb-btn sb-mbtn-commit" data-testid="sb-end-session" disabled={m.busy || !m.state.pending} title="One commit on the EFI review branch (not pushed)" onClick={() => void m.commit()}>End session (commit)</button>}
      {m.lastCommit && <span className="sb-marksbar-ok" data-testid="sb-last-commit">{m.lastCommit}</span>}
      {m.state.autoCommitError && <span className="sb-marksbar-err" role="alert" data-testid="sb-autocommit-error">Auto-commit failed: {m.state.autoCommitError}</span>}
      {m.error && (
        <span className="sb-marksbar-err" role="alert" data-testid="sb-marks-error" data-session={m.error.session ? "1" : "0"}>
          {m.error.msg}
          <button type="button" className="sb-mbtn sb-marksbar-dismiss" data-testid="sb-marks-error-dismiss" disabled={m.busy}
            title={m.error.session ? "Retry: re-read the review session (marking unlocks; a persisting problem shows again on the next mark)" : "Dismiss"}
            aria-label={m.error.session ? "Retry review session" : "Dismiss error"} onClick={m.dismissError}>{m.error.session ? "Retry" : "×"}</button>
        </span>
      )}
    </div>
  );
}
