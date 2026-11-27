// Storybook Review tab body (PLAN_STORYBOOK_V2 V3): the whole text inventory as one reading queue. Story first, then flavor, then
// toasts/system/UI; grouped by speaker or screen; full line text (never truncated); one search box over lines and entities.
// Row hook for V6: every row carries data-sb-row=<row.id> and an action slot (`renderActions`) for OK / Redo / Edit; nothing writes here.
import { useEffect, useMemo, useRef, useState } from "react";
import { wordDiff, groupRows, filterRows, searchEntities, rowSubtitle, classCounts, ROW_CLASSES, ROW_CLASS_LABEL, ROW_CLASS_HELP, type ReviewRow, type RowClass } from "./storybookReview";
import type { EntityIndex, SbEntity } from "./storybookLogic";

const GROUP_PAGE = 60; // rows shown per group before "show more" (a screen has hundreds)

export type TextFocus = { id: string; n: number } | null;
/** V8: rows to flag as changed (row id -> old text; "" for new rows) and a request (n) to open the Changed or Contracts view. */
export type TextChanges = { changed: Record<string, string>; added: ReadonlySet<string> } | null;
export type TextPreset = { only: "changed" | "contracts"; n: number } | null;

export function StorybookText({ rows, idx, renderChip, focus, onFocusConsumed, renderActions, changes = null, preset = null }: {
  changes?: TextChanges; preset?: TextPreset;
  rows: ReviewRow[]; idx: EntityIndex; renderChip: (e: SbEntity, label?: string) => React.ReactNode; focus: TextFocus; onFocusConsumed?: () => void; renderActions?: (row: ReviewRow) => React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [classes, setClasses] = useState<ReadonlySet<RowClass>>(new Set());
  const [tooLong, setTooLong] = useState(false);
  const [unreviewed, setUnreviewed] = useState(false);
  const [toggled, setToggled] = useState<Record<string, boolean>>({}); // explicit user open/collapse overrides (always win over defaults/search)
  const [more, setMore] = useState<Record<string, number>>({});
  const [only, setOnly] = useState<"changed" | "contracts" | null>(null);
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const filter = useMemo(() => ({ query, classes, tooLong, unreviewed }), [query, classes, tooLong, unreviewed]);
  const isChanged = (r: ReviewRow) => changes != null && (Object.hasOwn(changes.changed, r.id) || changes.added.has(r.id));
  const nChanged = useMemo(() => (changes ? rows.filter(isChanged).length : 0), [rows, changes]); // eslint-disable-line react-hooks/exhaustive-deps
  const nContracts = useMemo(() => rows.filter((r) => r.kind === "contract").length, [rows]);
  const base = useMemo(() => (only === "changed" ? rows.filter(isChanged) : only === "contracts" ? rows.filter((r) => r.kind === "contract") : rows), [rows, only, changes]); // eslint-disable-line react-hooks/exhaustive-deps
  const filtered = useMemo(() => filterRows(base, filter), [base, filter]);
  useEffect(() => { if (preset) { setOnly(preset.only); setQuery(""); setClasses(new Set()); setTooLong(false); setUnreviewed(false); } }, [preset]);
  const blocks = useMemo(() => groupRows(filtered), [filtered]);
  const counts = useMemo(() => classCounts(rows), [rows]);
  const nTooLong = useMemo(() => rows.filter((r) => r.tooLong).length, [rows]);
  const nUnrev = useMemo(() => rows.filter((r) => r.unreviewed).length, [rows]);
  const ents = useMemo(() => searchEntities(idx, query), [idx, query]);
  const searching = query.trim() !== "" || tooLong || unreviewed || only != null;
  const isOpen = (cls: RowClass, gid: string): boolean => (Object.hasOwn(toggled, gid) ? toggled[gid] : searching || cls === "story");
  const toggle = (cls: RowClass, gid: string) => {
    const was = isOpen(cls, gid);
    setToggled((m) => ({ ...m, [gid]: !was }));
  };

  // "→ line": clear filters, open + page the row's group, then scroll to it and flash it.
  useEffect(() => {
    if (!focus) return;
    onFocusConsumed?.();
    const row = rows.find((r) => r.id === focus.id);
    if (!row) return;
    setQuery(""); setClasses(new Set()); setTooLong(false); setUnreviewed(false); setOnly(null);
    setToggled((m) => ({ ...m, [row.groupId]: true }));
    const pos = (groupRows(rows).find((b) => b.cls === row.cls)?.groups.find((g) => g.id === row.groupId)?.rows.findIndex((r) => r.id === row.id) ?? 0) + 1;
    setMore((m) => ({ ...m, [row.groupId]: Math.max(m[row.groupId] ?? 0, pos) }));
    setFlash({ id: row.id, n: focus.n });
  }, [focus, rows, onFocusConsumed]);
  useEffect(() => {
    if (!flash) return;
    const el = [...(root.current?.querySelectorAll<HTMLElement>("[data-sb-row]") ?? [])].find((n) => n.getAttribute("data-sb-row") === flash.id);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("sb-flash");
    const t = setTimeout(() => el.classList.remove("sb-flash"), 1800);
    return () => clearTimeout(t);
  }, [flash]);

  const toggleClass = (c: RowClass) => setClasses((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; });
  const active = query !== "" || classes.size > 0 || tooLong || unreviewed || only != null;

  return (
    <div ref={root} className="sb-text" data-testid="sb-text">
      <div className="sb-search">
        <input type="search" className="sb-search-input" data-testid="sb-text-search" placeholder="Search lines and entities: text, speaker, key, file" aria-label="Search text" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="sb-search-n" data-testid="sb-text-n" role="status">{filtered.length === rows.length ? `${rows.length} rows` : `${filtered.length} of ${rows.length} rows`}</span>
      </div>
      <div className="sb-filter" role="group" aria-label="Filter text" data-testid="sb-text-filter">
        {nChanged > 0 && <button type="button" className="sb-fbtn" aria-pressed={only === "changed"} data-testid="sb-text-changed" title="New or edited since your last session" onClick={() => setOnly((v) => (v === "changed" ? null : "changed"))}>Changed <span className="sb-count">{nChanged}</span></button>}
        {nContracts > 0 && <button type="button" className="sb-fbtn" aria-pressed={only === "contracts"} data-testid="sb-text-contracts" title="Contract titles and details as the player sees them" onClick={() => setOnly((v) => (v === "contracts" ? null : "contracts"))}>Contracts <span className="sb-count">{nContracts}</span></button>}
        {ROW_CLASSES.filter((c) => counts[c] > 0).map((c) => (
          <button key={c} type="button" className="sb-fbtn" aria-pressed={classes.has(c)} data-testid={`sb-text-class-${c}`} title={ROW_CLASS_HELP[c]} onClick={() => toggleClass(c)}>{ROW_CLASS_LABEL[c]} <span className="sb-count">{counts[c]}</span></button>
        ))}
        {nUnrev > 0 && <button type="button" className="sb-fbtn" aria-pressed={unreviewed} data-testid="sb-text-unreviewed" title="Not yet marked OWNER-OK in text_review.csv" onClick={() => setUnreviewed((v) => !v)}>Unreviewed <span className="sb-count">{nUnrev}</span></button>}
        {nTooLong > 0 && <button type="button" className="sb-fbtn" aria-pressed={tooLong} data-testid="sb-text-toolong" title="Longer than its screen budget (check #18)" onClick={() => setTooLong((v) => !v)}>Too long <span className="sb-count">{nTooLong}</span></button>}
        {active && <button type="button" className="sb-fbtn sb-fclear" onClick={() => { setQuery(""); setClasses(new Set()); setTooLong(false); setUnreviewed(false); setOnly(null); }}>Clear</button>}
      </div>
      {ents.length > 0 && (
        <div className="sb-ents" data-testid="sb-text-ents"><span className="sb-ents-lbl">Entities</span>{ents.map((e) => <span key={`${e.kind}\u0000${e.id}`} className="sb-ent">{renderChip(e)}<span className="sb-kind">{e.kind.replace(/_/g, " ")}</span></span>)}</div>
      )}
      {blocks.length === 0 && <p className="sb-empty" data-testid="sb-text-empty">{rows.length === 0 ? "No text in this snapshot." : "Nothing matches this search."}</p>}
      {blocks.map((b) => (
        <section key={b.cls} className="sb-section sb-class" data-testid={`sb-text-block-${b.cls}`}>
          <h3 className="sb-h">{b.label} <span className="sb-count">{b.n}</span></h3>
          {b.groups.map((g) => {
            const o = isOpen(b.cls, g.id);
            const limit = Math.max(GROUP_PAGE, more[g.id] ?? 0);
            const shown = o ? g.rows.slice(0, limit) : [];
            return (
              <div key={g.id} className="sb-tgroup" data-testid="sb-text-group">
                <button type="button" className="sb-tgroup-head" aria-expanded={o} onClick={() => toggle(b.cls, g.id)}>
                  <span className="sb-tgroup-caret" aria-hidden="true">{o ? "▾" : "▸"}</span> {g.label} <span className="sb-count">{g.rows.length}</span>
                </button>
                {o && (
                  <ul className="sb-rows">
                    {shown.map((r) => <Row key={r.id} r={r} idx={idx} renderChip={renderChip} renderActions={renderActions} oldText={changes && Object.hasOwn(changes.changed, r.id) ? changes.changed[r.id] : null} isNew={changes?.added.has(r.id) ?? false} />)}
                    {g.rows.length > shown.length && <li><button type="button" className="sb-btn sb-more" onClick={() => setMore((m) => ({ ...m, [g.id]: limit + GROUP_PAGE * 3 }))}>Show {Math.min(GROUP_PAGE * 3, g.rows.length - shown.length)} more ({g.rows.length - shown.length} left)</button></li>}
                  </ul>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

function Row({ r, idx, renderChip, renderActions, oldText = null, isNew = false }: { oldText?: string | null; isNew?: boolean; r: ReviewRow; idx: EntityIndex; renderChip: (e: SbEntity, label?: string) => React.ReactNode; renderActions?: (row: ReviewRow) => React.ReactNode }) {
  const sp = r.speakerRef ? idx.get(r.speakerRef.kind, r.speakerRef.id) : null;
  const st = r.status ? r.status.toLowerCase().replace(/[^a-z]+/g, "-") : "";
  return (
    <li className="sb-row" data-sb-row={r.id} data-testid="sb-row">
      <div className="sb-row-head">
        {sp ? renderChip(sp, r.speaker) : r.speaker && r.kind === "line" ? <span className="sb-row-speaker">{r.speaker}</span> : null}
        {r.title && <span className="sb-row-title">{r.title}</span>}
        {r.status && <span className={`sb-status sb-st-${st}`}>{r.status}</span>}
        {r.tooLong && <span className="sb-tag sb-cat-toolong" data-testid="sb-row-toolong" title="Check #18">Too long · {r.tooLong}</span>}
      </div>
      {oldText != null ? (
        <p className="sb-row-text sb-diff" data-testid="sb-row-diff" aria-label="Changed since your last session">
          <span className="sb-tag sb-tag-changed">changed</span>{" "}
          {wordDiff(oldText, r.text).map((g, i) => g.k === "same" ? <span key={i}>{g.t}</span> : g.k === "del" ? <del key={i} className="sb-del">{g.t}</del> : <ins key={i} className="sb-ins">{g.t}</ins>)}
        </p>
      ) : r.text && <p className="sb-row-text">{isNew && <span className="sb-tag sb-tag-new" data-testid="sb-row-new">new </span>}{r.text}</p>}
      <div className="sb-row-foot">
        <span className="sb-row-sub sb-mono">{rowSubtitle(r)}</span>
        <span className="sb-row-actions" data-slot="row-actions">{renderActions?.(r)}</span>
      </div>
    </li>
  );
}
