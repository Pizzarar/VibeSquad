// Storybook Items tab (PLAN_STORYBOOK_V2 V4): searchable item list with orphan (#14), no-story (#15),
// and unobtainable (#13) filters, paired with the selected ItemSheet. Read-only.
import { useMemo, useState } from "react";
import {
  ITEM_FILTERS, ITEM_FILTER_LABEL, itemSheetData,
  type EntityIndex, type ItemFilter, type SbEntity, type SbFinding,
} from "./storybookLogic";
import { ItemSheet, type ChipRenderer } from "./StorybookSheet";
import type { MarksApi } from "./StorybookMarks";
import type { ProgressTextBucket, SbProgress } from "./storybookProgress";

export function StorybookItems({ idx, findings, sel, setSel, renderChip, onReview, progress, onProgressEntity, marks }: {
  idx: EntityIndex;
  findings: SbFinding[];
  sel: string | null;
  setSel: (id: string) => void;
  renderChip: ChipRenderer;
  onReview: (e: SbEntity) => void;
  marks?: MarksApi;
  progress?: SbProgress | null;
  onProgressEntity?: (entityKey: string, label: string, status?: ProgressTextBucket | null) => void;
}) {
  const [filter, setFilter] = useState<ItemFilter>("all");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    return idx.byKind("item")
      .map((item) => itemSheetData(item, idx, findings))
      .sort((a, b) => a.item.display.localeCompare(b.item.display));
  }, [idx, findings]);

  const counts = useMemo(() => ({
    all: rows.length,
    unobtainable: rows.filter((r) => r.isUnobtainable).length,
    orphan: rows.filter((r) => r.isOrphan).length,
    "no-story": rows.filter((r) => r.isNoStory).length,
  }), [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "unobtainable" && !r.isUnobtainable) return false;
      if (filter === "orphan" && !r.isOrphan) return false;
      if (filter === "no-story" && !r.isNoStory) return false;
      if (q && !r.item.display.toLowerCase().includes(q) && !r.item.id.toLowerCase().includes(q) && !String(r.item.data?.category ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, filter, query]);

  if (rows.length === 0) return <p className="sb-empty">No items in this snapshot.</p>;

  const active = (sel ? rows.find((r) => r.item.id === sel) : null) ?? filtered[0] ?? rows[0];

  return (
    <div className="sb-items" data-testid="sb-items">
      <div className="sb-items-bar">
        <div className="sb-filter" role="group" aria-label="Filter items" data-testid="sb-item-filters">
          {ITEM_FILTERS.map((f) => (
            <button key={f} type="button" className="sb-fbtn" aria-pressed={filter === f} data-testid={`sb-item-filter-${f}`} onClick={() => setFilter(f)}>
              {ITEM_FILTER_LABEL[f]} <span className="sb-count">{counts[f]}</span>
            </button>
          ))}
        </div>
        <input
          type="search"
          className="sb-search"
          data-testid="sb-item-search"
          placeholder="Filter items by name, id, or category…"
          aria-label="Filter items"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="sb-items-layout">
        <div className="sb-items-list" role="listbox" aria-label="Items" data-testid="sb-items-list">
          {filtered.length === 0 ? (
            <p className="sb-empty sb-empty-sm">No items match this filter.</p>
          ) : (
            filtered.map((r) => (
              <button
                key={r.item.id}
                type="button"
                role="option"
                aria-selected={active?.item.id === r.item.id}
                className="sb-item-row"
                data-testid={`sb-item-opt-${r.item.id}`}
                onClick={() => setSel(r.item.id)}
              >
                <span className="sb-item-name">{r.item.display}</span>
                <span className="sb-item-badges">
                  <span className="sb-mono">{r.sources.length}s/{r.uses.length}u</span>
                  {r.isUnobtainable && <span className="sb-tag sb-cat-broken">#13</span>}
                  {r.isOrphan && <span className="sb-tag sb-cat-inconsistent">#14</span>}
                  {r.isNoStory && <span className="sb-tag sb-cat-missing">#15</span>}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="sb-items-detail">
          {active && (
            <ItemSheet
              item={active.item}
              idx={idx}
              findings={findings}
              renderChip={renderChip}
              onReview={onReview}
              marks={marks}
              progress={progress?.entities[`item:${active.item.id}`] ?? null}
              onProgress={onProgressEntity ? (st) => onProgressEntity(`item:${active.item.id}`, active.item.display, st) : undefined}
            />
          )}
        </div>
      </div>
    </div>
  );
}
