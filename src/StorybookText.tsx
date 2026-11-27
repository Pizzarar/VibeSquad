// Storybook Review tab body (PLAN_STORYBOOK_V2 V3): the whole text inventory as one reading queue. Story first, then flavor, then
// toasts/system/UI; grouped by speaker or screen; full line text (never truncated); one search box over lines and entities.
// Row hook for V6: every row carries data-sb-row=<row.id> and an action slot (`renderActions`) for OK / Redo / Edit; nothing writes here.
import { useEffect, useMemo, useRef, useState } from "react";
import { wordDiff, groupRows, filterRows, type ReviewGroup, searchEntities, speakerEntityKey, rowSubtitle, classCounts, ROW_CLASSES, ROW_CLASS_LABEL, ROW_CLASS_HELP, type ReviewRow, type RowClass } from "./storybookReview";
import { lineSpeakerKey, type EntityIndex, type SbEntity, type TextChanges } from "./storybookLogic";
import { PROGRESS_AREA_LABEL, PROGRESS_BUCKET_LABEL, statusBucket, type ProgressAreaId, type ProgressTextBucket, type SbProgress } from "./storybookProgress";

const GROUP_PAGE = 60; // rows shown per group before "show more" (a screen has hundreds)

export type TextFocus = { id: string; n: number } | null;
export type { TextChanges };
export type TextPreset = {
  only?: "changed" | "contracts" | "unreviewed" | null;
  area?: ProgressAreaId | null;
  entityKey?: string | null;
  entityLabel?: string | null;
  status?: ProgressTextBucket | null;
  n: number;
} | null;

function matchesEntityKey(r: ReviewRow, idx: EntityIndex, ek: string, progress?: SbProgress | null): boolean {
  if (r.kind !== "line") return false;
  const sheets = progress?.lineSheets?.[r.entityId]; // same attribution the sheet bars were counted with
  if (sheets) return sheets.includes(ek);
  const e = idx.get("line", r.entityId);
  if (!e) return false;
  const i = ek.indexOf(":");
  if (i < 0) return false;
  const kind = ek.slice(0, i);
  const id = ek.slice(i + 1);
  if (kind === "location" || kind === "item") return e.links.some((l) => l.kind === kind && l.id === id);
  if (kind === "enemy") return e.links.some((l) => l.kind === "enemy" && l.id.toLowerCase() === id.toLowerCase());
  return lineSpeakerKey(e) === ek;
}

export function StorybookText({ rows, idx, renderChip, focus, onFocusConsumed, renderActions, renderGroupExtra, mineTest, header, changes = null, preset = null, onPresetConsumed, progress = null, rowStatusBucket }: {
  changes?: TextChanges; preset?: TextPreset; onPresetConsumed?: () => void;
  rows: ReviewRow[]; idx: EntityIndex; renderChip: (e: SbEntity, label?: string) => React.ReactNode; focus: TextFocus; onFocusConsumed?: () => void; renderActions?: (row: ReviewRow) => React.ReactNode;
  /** V6: progress + batch marks on a group header. */ renderGroupExtra?: (g: ReviewGroup) => React.ReactNode;
  /** V6 "My marks" filter: rows the owner has marked. */ mineTest?: (row: ReviewRow) => boolean;
  /** V6 session bar above the search. */ header?: React.ReactNode;
  /** V12 progress rollup (for area filtering). */ progress?: SbProgress | null;
  /** V12 live status bucket per row (reflects V6 marks immediately). */ rowStatusBucket?: (row: ReviewRow) => ProgressTextBucket | null;
}) {
  const [query, setQuery] = useState("");
  const [speakerFilter, setSpeakerFilter] = useState<{ key: string; label: string; entity: SbEntity } | null>(null);
  const [areaFilter, setAreaFilter] = useState<ProgressAreaId | null>(null);
  const [entityFilter, setEntityFilter] = useState<{ key: string; label: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState<ProgressTextBucket | null>(null);
  const [classes, setClasses] = useState<ReadonlySet<RowClass>>(new Set());
  const [tooLong, setTooLong] = useState(false);
  const [unreviewed, setUnreviewed] = useState(false);
  const [mine, setMine] = useState(false);
  const [toggled, setToggled] = useState<Record<string, boolean>>({}); // explicit user open/collapse overrides (always win over defaults/search)
  const [more, setMore] = useState<Record<string, number>>({});
  const [only, setOnly] = useState<"changed" | "contracts" | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const isChanged = (r: ReviewRow) => changes != null && (changes.changedIds.has(r.id) || Object.hasOwn(changes.changed, r.id) || changes.added.has(r.id));
  const nChanged = useMemo(() => (changes ? rows.filter(isChanged).length : 0), [rows, changes]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = useMemo(() => {
    let list = only === "changed" ? rows.filter(isChanged) : only === "contracts" ? rows.filter((r) => r.kind === "contract") : rows;
    if (areaFilter && progress) list = list.filter((r) => r.kind === "line" && progress.lineAreas[r.entityId] === areaFilter);
    if (entityFilter) list = list.filter((r) => matchesEntityKey(r, idx, entityFilter.key, progress));
    if (statusFilter) list = list.filter((r) => r.kind === "line" && (rowStatusBucket ? rowStatusBucket(r) : statusBucket(r.status)) === statusFilter);
    return list;
  }, [rows, only, changes, areaFilter, progress, entityFilter, idx, statusFilter, rowStatusBucket]); // eslint-disable-line react-hooks/exhaustive-deps
  // A bar/area/status filter counts text lines only (contracts have no bar), so its denominator is the line total, not all rows.
  const lineFiltered = areaFilter != null || entityFilter != null || statusFilter != null;
  const nLines = useMemo(() => rows.filter((r) => r.kind === "line").length, [rows]);
  const denom = lineFiltered ? nLines : rows.length;
  const denomLabel = lineFiltered ? "lines" : "rows";
  const speakerKey = speakerFilter?.key ?? null;
  const searched = useMemo(() => filterRows(base, { query, speakerKey, classes: new Set(), tooLong: false, unreviewed: false }), [base, query, speakerKey]);
  const filter = useMemo(() => ({ query: "", classes, tooLong, unreviewed }), [classes, tooLong, unreviewed]);
  const filtered = useMemo(() => { const f = filterRows(searched, filter); return mine && mineTest ? f.filter(mineTest) : f; }, [searched, filter, mine, mineTest]);
  const nContracts = useMemo(() => {
    let list = only === "changed" ? rows.filter(isChanged) : rows;
    if (areaFilter && progress) list = list.filter((r) => r.kind === "line" && progress.lineAreas[r.entityId] === areaFilter);
    if (entityFilter) list = list.filter((r) => matchesEntityKey(r, idx, entityFilter.key, progress));
    if (statusFilter) list = list.filter((r) => r.kind === "line" && (rowStatusBucket ? rowStatusBucket(r) : statusBucket(r.status)) === statusFilter);
    const f = filterRows(list, { query, speakerKey, classes: new Set(), tooLong, unreviewed });
    return (mine && mineTest ? f.filter(mineTest) : f).filter((r) => r.kind === "contract").length;
  }, [rows, only, changes, areaFilter, progress, entityFilter, idx, statusFilter, rowStatusBucket, query, speakerKey, tooLong, unreviewed, mine, mineTest]); // eslint-disable-line react-hooks/exhaustive-deps
  const nMine = useMemo(() => (mineTest ? rows.filter(mineTest).length : 0), [rows, mineTest]);
  useEffect(() => {
    if (!preset) return;
    onPresetConsumed?.();
    setOnly(preset.only && preset.only !== "unreviewed" ? preset.only : null);
    setAreaFilter(preset.area ?? null);
    setEntityFilter(preset.entityKey ? { key: preset.entityKey, label: preset.entityLabel ?? preset.entityKey } : null);
    setStatusFilter(preset.status ?? null);
    setQuery("");
    setSpeakerFilter(null);
    setClasses(new Set());
    setTooLong(false);
    setUnreviewed(preset.only === "unreviewed");
    setMine(false);
  }, [preset, onPresetConsumed]);
  const blocks = useMemo(() => groupRows(filtered, query), [filtered, query]);
  const counts = useMemo(() => classCounts(filterRows(searched, { query: "", classes: new Set(), tooLong, unreviewed })), [searched, tooLong, unreviewed]);
  const nTooLong = useMemo(() => filterRows(searched, { query: "", classes, tooLong: false, unreviewed }).filter((r) => r.tooLong).length, [searched, classes, unreviewed]);
  const nUnrev = useMemo(() => filterRows(searched, { query: "", classes, tooLong, unreviewed: false }).filter((r) => r.unreviewed).length, [searched, classes, tooLong]);
  const ents = useMemo(() => searchEntities(idx, query), [idx, query]);
  const searching = query.trim() !== "" || speakerFilter != null || areaFilter != null || entityFilter != null || statusFilter != null || tooLong || unreviewed || mine || only != null;
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
    setQuery(""); setSpeakerFilter(null); setAreaFilter(null); setEntityFilter(null); setStatusFilter(null); setClasses(new Set()); setTooLong(false); setUnreviewed(false); setMine(false); setOnly(null);
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
  const nSecFilters = (only ? 1 : 0) + classes.size + (unreviewed ? 1 : 0) + (tooLong ? 1 : 0);
  const active = query !== "" || speakerFilter != null || areaFilter != null || entityFilter != null || statusFilter != null || classes.size > 0 || tooLong || unreviewed || mine || only != null;
  // V6 keys: j/k or arrows move between rows, 1/2/3 press the focused row's OK / Redo / Edit.
  const onKey = (ev: React.KeyboardEvent) => {
    const t = ev.target as HTMLElement;
    if (ev.altKey || ev.ctrlKey || ev.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
    const all = [...(root.current?.querySelectorAll<HTMLElement>("[data-sb-row]") ?? [])];
    const cur = t.closest<HTMLElement>("[data-sb-row]");
    const k = ev.key;
    if (k === "j" || k === "k" || k === "ArrowDown" || k === "ArrowUp") {
      if (!all.length) return;
      const at = cur ? all.indexOf(cur) : -1;
      const next = all[Math.max(0, Math.min(all.length - 1, k === "j" || k === "ArrowDown" ? at + 1 : at < 0 ? 0 : at - 1))];
      ev.preventDefault();
      next.focus();
      next.scrollIntoView({ block: "nearest" });
    } else if ((k === "1" || k === "2" || k === "3") && cur) {
      const b = cur.querySelector<HTMLButtonElement>(`[data-mark-key="${k}"]`);
      if (b && !b.disabled) { ev.preventDefault(); b.click(); }
    }
  };
  const pickSpeaker = (e: SbEntity, key: string) => {
    setSpeakerFilter((cur) => (cur?.key === key ? null : { key, label: e.display, entity: e }));
    setQuery("");
  };

  return (
    <div ref={root} className="sb-text" data-testid="sb-text" onKeyDown={onKey}>
      {header}
      <div className="sb-search">
        <input type="search" className="sb-search-input" data-testid="sb-text-search" placeholder="Search lines and entities: text, speaker, key, file" aria-label="Search text" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="sb-search-n" data-testid="sb-text-n" role="status">{filtered.length === denom ? `${denom} ${denomLabel}` : `${filtered.length} of ${denom} ${denomLabel}`}</span>
      </div>
      <div className="sb-filter" role="group" aria-label="Filter text" data-testid="sb-text-filter">
        <button type="button" className="sb-fbtn sb-filter-toggle" aria-expanded={filtersOpen} data-testid="sb-text-filters-toggle" onClick={() => setFiltersOpen((v) => !v)}>
          Filters{nSecFilters > 0 && <span className="sb-count">{nSecFilters}</span>} <span aria-hidden="true">{filtersOpen ? "▾" : "▸"}</span>
        </button>
        {mineTest && <button type="button" className="sb-fbtn" aria-pressed={mine} data-testid="sb-text-mine" title="Rows you marked OK / Redo / Edit" onClick={() => setMine((v) => !v)}>My marks <span className="sb-count">{nMine}</span></button>}
        {areaFilter && (
          <button type="button" className="sb-fbtn" aria-pressed={true} data-testid="sb-text-area-filter" title="Filter to this area (click to clear)" onClick={() => setAreaFilter(null)}>
            Area: {PROGRESS_AREA_LABEL[areaFilter]} ×
          </button>
        )}
        {entityFilter && (
          <button type="button" className="sb-fbtn" aria-pressed={true} data-testid="sb-text-entity-filter" title="Filter to this sheet (click to clear)" onClick={() => setEntityFilter(null)}>
            Sheet: {entityFilter.label} ×
          </button>
        )}
        {statusFilter && (
          <button type="button" className="sb-fbtn" aria-pressed={true} data-testid="sb-text-status-filter" title="Filter to this text status (click to clear)" onClick={() => setStatusFilter(null)}>
            Status: {PROGRESS_BUCKET_LABEL[statusFilter]} ×
          </button>
        )}
        {speakerFilter && (
          <button type="button" className="sb-fbtn" aria-pressed={true} data-testid="sb-text-speaker-filter" title="Filter to this speaker only (click to clear)" onClick={() => setSpeakerFilter(null)}>
            Speaker: {speakerFilter.label} ×
          </button>
        )}
        <span className={`sb-filter-more${filtersOpen ? " sb-filter-more-open" : ""}`} data-testid="sb-text-filter-more">
          {nChanged > 0 && <button type="button" className="sb-fbtn" aria-pressed={only === "changed"} data-testid="sb-text-changed" title="New or edited since your last session" onClick={() => setOnly((v) => (v === "changed" ? null : "changed"))}>Changed <span className="sb-count">{nChanged}</span></button>}
          {(nContracts > 0 || only === "contracts") && <button type="button" className="sb-fbtn" aria-pressed={only === "contracts"} data-testid="sb-text-contracts" title="Contract titles and details as the player sees them" onClick={() => setOnly((v) => (v === "contracts" ? null : "contracts"))}>Contracts <span className="sb-count">{nContracts}</span></button>}
          {ROW_CLASSES.filter((c) => c !== "contracts" && (counts[c] > 0 || classes.has(c))).map((c) => (
            <button key={c} type="button" className="sb-fbtn" aria-pressed={classes.has(c)} data-testid={`sb-text-class-${c}`} title={ROW_CLASS_HELP[c]} onClick={() => toggleClass(c)}>{ROW_CLASS_LABEL[c]} <span className="sb-count">{counts[c]}</span></button>
          ))}
          {(nUnrev > 0 || unreviewed) && <button type="button" className="sb-fbtn" aria-pressed={unreviewed} data-testid="sb-text-unreviewed" title="Not yet marked OWNER-OK in text_review.csv" onClick={() => setUnreviewed((v) => !v)}>Unreviewed <span className="sb-count">{nUnrev}</span></button>}
          {(nTooLong > 0 || tooLong) && <button type="button" className="sb-fbtn" aria-pressed={tooLong} data-testid="sb-text-toolong" title="Longer than its screen budget (check #18)" onClick={() => setTooLong((v) => !v)}>Too long <span className="sb-count">{nTooLong}</span></button>}
        </span>
        {active && <button type="button" className="sb-fbtn sb-fclear" onClick={() => { setQuery(""); setSpeakerFilter(null); setAreaFilter(null); setEntityFilter(null); setStatusFilter(null); setClasses(new Set()); setTooLong(false); setUnreviewed(false); setMine(false); setOnly(null); }}>Clear</button>}
      </div>
      {ents.length > 0 && (
        <div className="sb-ents" data-testid="sb-text-ents">
          <span className="sb-ents-lbl">Entities</span>
          {ents.map((e) => {
            const sk = speakerEntityKey(e);
            return (
              <span key={`${e.kind}\u0000${e.id}`} className="sb-ent">
                {sk ? (
                  <button type="button" className={`sb-chip sb-k-${e.kind} sb-ent-filter`} aria-pressed={speakerFilter?.key === sk} data-testid={`sb-ent-filter-${e.kind}-${e.id}`} title={`Filter Review to ${e.display} only`} onClick={() => pickSpeaker(e, sk)}>
                    {e.display}
                  </button>
                ) : renderChip(e)}
                <span className="sb-kind">{e.kind.replace(/_/g, " ")}</span>
              </span>
            );
          })}
        </div>
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
                {renderGroupExtra && <div className="sb-tgroup-extra">{renderGroupExtra(g)}</div>}
                {o && (
                  <ul className="sb-rows">
                    {shown.map((r) => <Row key={r.id} r={r} groupLabel={g.label} idx={idx} renderChip={renderChip} renderActions={renderActions} oldText={changes && Object.hasOwn(changes.changed, r.id) ? changes.changed[r.id] : null} isChangedRow={changes?.changedIds.has(r.id) ?? false} isNew={changes?.added.has(r.id) ?? false} />)}
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

function Row({ r, groupLabel, idx, renderChip, renderActions, oldText = null, isChangedRow = false, isNew = false }: { oldText?: string | null; isChangedRow?: boolean; isNew?: boolean; r: ReviewRow; groupLabel: string; idx: EntityIndex; renderChip: (e: SbEntity, label?: string) => React.ReactNode; renderActions?: (row: ReviewRow) => React.ReactNode }) {
  const inOwnGroup = Boolean(r.speaker && (groupLabel === r.speaker || groupLabel === `Contracts · ${r.speaker}`));
  const sp = !inOwnGroup && r.speakerRef ? idx.get(r.speakerRef.kind, r.speakerRef.id) : null;
  const showSpeaker = !inOwnGroup && Boolean(sp || (r.speaker && r.kind === "line"));
  const st = r.status ? r.status.toLowerCase().replace(/[^a-z]+/g, "-") : "";
  return (
    <li className="sb-row" data-sb-row={r.id} data-testid="sb-row" tabIndex={-1}>
      {(showSpeaker || r.title) && (
        <div className="sb-row-head">
          {showSpeaker && (sp ? renderChip(sp, r.speaker) : <span className="sb-row-speaker">{r.speaker}</span>)}
          {r.title && <span className="sb-row-title">{r.title}</span>}
        </div>
      )}
      {oldText != null ? (
        <p className="sb-row-text sb-diff" data-testid="sb-row-diff" aria-label="Changed since your last session">
          <span className="sb-tag sb-tag-changed">changed</span>{" "}
          {wordDiff(oldText, r.text).map((g, i) => g.k === "same" ? <span key={i}>{g.t}</span> : g.k === "del" ? <del key={i} className="sb-del">{g.t}</del> : <ins key={i} className="sb-ins">{g.t}</ins>)}
        </p>
      ) : r.text && <p className="sb-row-text">{isChangedRow ? <><span className="sb-tag sb-tag-changed">changed</span>{" "}</> : isNew && <span className="sb-tag sb-tag-new" data-testid="sb-row-new">new </span>}{r.text}</p>}
      <div className="sb-row-foot">
        <span className="sb-row-meta">
          <span className="sb-row-sub sb-mono">{rowSubtitle(r)}</span>
          {r.status && <span className={`sb-status sb-st-${st}`}>{r.status}</span>}
          {r.tooLong && <span className="sb-tag sb-cat-toolong" data-testid="sb-row-toolong" title="Check #18">Too long · {r.tooLong}</span>}
        </span>
        <span className="sb-row-actions" data-slot="row-actions">{renderActions?.(r)}</span>
      </div>
    </li>
  );
}
