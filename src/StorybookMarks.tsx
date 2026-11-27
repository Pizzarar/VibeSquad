// Storybook V6 owner marks UI: the useMarks hook (GET/POST /api/storybook/:p/marks), the OK / Redo / Edit trio a Review row
// or arc line carries, the batch bar on a group/arc header, and the session bar ("End session" = one EFI commit).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EntityIndex, SbEntity } from "./storybookLogic";
import { allLines, batchMarks, draftRewrite, entityTarget, markState, marksByKey, progress, type Mark, type MarkState, type MarksState, type ServerMark } from "./storybookMarks";

export type MarksApi = {
  state: MarksState;
  busy: boolean;
  error: string | null;
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
  const [error, setError] = useState<string | null>(null);
  const [lastCommit, setLastCommit] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(url).then((r) => r.json()).then((b) => { if (live && b && Array.isArray(b.marks)) setState(b); }).catch(() => { /* marks are optional: no session yet */ });
    return () => { live = false; };
  }, [url]);
  const lines = useMemo(() => allLines(idx), [idx]);
  const byKey = useMemo(() => marksByKey(state.marks), [state.marks]);
  const stateOf = useCallback((e: SbEntity | null | undefined) => markState(e, lines, byKey, state.exists), [lines, byKey, state.exists]);
  const mark = useCallback(async (marks: Mark[]) => {
    if (!marks.length) return true;
    setBusy(true); setError(null);
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marks }) });
      const b = await r.json().catch(() => null);
      if (!r.ok) { setError(b?.error ?? `mark failed (${r.status})`); return false; }
      setState((s) => ({ ...s, exists: true, branch: b.branch, pending: b.pending, marks: b.marks }));
      const bad = (b.results as { ok: boolean; error?: string }[]).filter((x) => !x.ok);
      if (bad.length) setError(`${bad.length} of ${marks.length} not saved: ${bad[0].error}${bad[0].error?.startsWith("stale") ? " (Refresh to see the current text)" : ""}`);
      return bad.length === 0;
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return false; } finally { setBusy(false); }
  }, [url]);
  const commit = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`${url}/commit`, { method: "POST" });
      const b = await r.json().catch(() => null);
      if (!r.ok) { setError(b?.error ?? `commit failed (${r.status})`); return; }
      setState((s) => ({ ...s, pending: 0 }));
      setLastCommit(b.committed ? `${b.subject} (${String(b.committed).slice(0, 8)})${b.lost ? ` · ${b.lost} mark(s) lost in review_pack --write` : ""}` : "Nothing to commit");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }, [url]);
  return { state, busy, error, lines, byKey, stateOf, mark, commit, lastCommit };
}

const KIND_LABEL: Record<MarkState["kind"], string> = { ok: "OK", redo: "Redo", edit: "Edited", none: "" };

/** OK / Redo / Edit on one entity (a csv line or a contract). data-mark-key 1/2/3 lets the row's keyboard handler press them. */
export function MarkButtons({ e, m }: { e: SbEntity | null | undefined; m: MarksApi }) {
  const [open, setOpen] = useState<"redo" | "edit" | null>(null);
  const [draft, setDraft] = useState("");
  const hit = entityTarget(e, m.lines);
  if (!e || !hit) return null;
  const st = m.stateOf(e);
  const drafted = draftRewrite(hit.template ?? e);
  const send = async (mk: Omit<Mark, "target">) => { if (await m.mark([{ target: hit.target, ...(hit.contract ? { contract: hit.contract } : {}), ...mk }])) setOpen(null); };
  const start = (k: "redo" | "edit") => { setDraft(k === "redo" ? (st.contractNote || st.note) : (st.rewrite || drafted || hit.target.seen.replace(/^'(?=[+\-=@])/, ""))); setOpen(open === k ? null : k); };
  return (
    <span className="sb-mark" data-testid="sb-mark" data-mark={st.kind}>
      {st.kind !== "none" && (
        <span className={`sb-mark-state sb-mark-${st.kind}`} data-testid="sb-mark-state" title={st.contractNote || st.note || st.rewrite || KIND_LABEL[st.kind]}>
          {KIND_LABEL[st.kind]}{(st.contractNote || st.note) ? `: ${st.contractNote || st.note}` : ""}
        </span>
      )}
      {st.kind === "none" && drafted && <span className="sb-mark-draft" title="Drafted rewrite: OK approves it">Draft: {drafted}</span>}
      {st.kind === "edit" && <span className="sb-mark-draft" title="Your rewrite">→ {st.rewrite}</span>}
      <span className="sb-mark-btns">
        <button type="button" className="sb-mbtn sb-mbtn-ok" data-mark-key="1" aria-pressed={st.kind === "ok"} disabled={m.busy} title={hit.contract ? "OK the shared contract title template (key 1)" : drafted && st.kind === "none" ? "OK: approves the drafted rewrite (key 1)" : "OK (key 1)"} onClick={() => void send({ action: "ok" })}>OK</button>
        <button type="button" className="sb-mbtn sb-mbtn-redo" data-mark-key="2" aria-pressed={st.kind === "redo"} aria-expanded={open === "redo"} disabled={m.busy} title="Redo with a note (key 2)" onClick={() => start("redo")}>Redo</button>
        <button type="button" className="sb-mbtn sb-mbtn-edit" data-mark-key="3" aria-pressed={st.kind === "edit"} aria-expanded={open === "edit"} disabled={m.busy} title={hit.contract ? "Edit the shared template (every contract of this type) (key 3)" : "Edit the text (key 3)"} onClick={() => start("edit")}>Edit</button>
        {st.kind !== "none" && !hit.contract && <button type="button" className="sb-mbtn sb-mbtn-clear" disabled={m.busy} title="Undo your mark" aria-label="Undo mark" onClick={() => void send({ action: "clear" })}>↺</button>}
      </span>
      {open && (
        <form className="sb-mark-form" data-testid="sb-mark-form" onSubmit={(ev) => { ev.preventDefault(); void send(open === "redo" ? { action: "redo", note: draft } : { action: "edit", text: draft }); }}>
          {open === "edit" && hit.contract && <span className="sb-mark-hint">Shared template: changes every {String(e.data?.type ?? "")} contract title.</span>}
          <textarea className="sb-mark-input" aria-label={open === "redo" ? "What should change" : "New text"} placeholder={open === "redo" ? "What should change?" : ""} rows={open === "edit" ? 3 : 2} value={draft} autoFocus
            onChange={(ev) => setDraft(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Escape") setOpen(null); if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) (ev.currentTarget.form as HTMLFormElement | null)?.requestSubmit(); ev.stopPropagation(); }} />
          <span className="sb-mark-formbtns">
            <button type="submit" className="sb-mbtn sb-mbtn-save" disabled={m.busy || !draft.trim()}>{open === "redo" ? "Save note" : "Save edit"}</button>
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
  return (
    <span className="sb-batch" data-testid="sb-batch">
      <span className="sb-progress" data-testid="sb-progress">{label ? `${label} ` : ""}{p.done}/{p.total} reviewed</span>
      {okAll.length > 0 && <button type="button" className="sb-mbtn sb-mbtn-ok" disabled={m.busy} data-testid="sb-ok-all" title="Mark every row without a mark OK (your Redo/Edit marks stay)" onClick={() => void m.mark(okAll)}>OK all ({okAll.length})</button>}
      {okAll.length > 0 && <button type="button" className="sb-mbtn sb-mbtn-redo" disabled={m.busy} aria-expanded={redo} onClick={() => setRedo((v) => !v)}>Redo all…</button>}
      {redo && (
        <form className="sb-mark-form" onSubmit={(ev) => { ev.preventDefault(); void m.mark(batchMarks(markable, m.lines, m.byKey, m.state.exists, "redo", note)).then((ok) => { if (ok) { setRedo(false); setNote(""); } }); }}>
          <input className="sb-mark-input" aria-label="One note for every unmarked row" placeholder={`One note for ${okAll.length} rows`} value={note} autoFocus onChange={(ev) => setNote(ev.target.value)} onKeyDown={(ev) => ev.stopPropagation()} />
          <button type="submit" className="sb-mbtn sb-mbtn-save" disabled={m.busy || !note.trim()}>Redo {okAll.length}</button>
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
        {m.state.exists ? <>Review session <span className="sb-mono">{m.state.branch}</span> · {n} marked · {m.state.pending ? `${m.state.pending} unsaved row${m.state.pending === 1 ? "" : "s"}` : "all committed"}</> : "No review session yet: your first OK / Redo / Edit starts one (an EFI branch, never main)."}
      </span>
      {m.state.exists && <button type="button" className="sb-btn sb-mbtn-commit" data-testid="sb-end-session" disabled={m.busy || !m.state.pending} title="One commit on the EFI review branch (not pushed)" onClick={() => void m.commit()}>End session (commit)</button>}
      {m.lastCommit && <span className="sb-marksbar-ok" data-testid="sb-last-commit">{m.lastCommit}</span>}
      {m.error && <span className="sb-marksbar-err" role="alert" data-testid="sb-marks-error">{m.error}</span>}
    </div>
  );
}
