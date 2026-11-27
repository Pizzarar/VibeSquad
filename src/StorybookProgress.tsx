// Storybook V12 progress bar UI: renders server-computed progress rollups (with live V6 mark deltas)
// on Home (per-area bars) and on every entity sheet (MapSheet, CharacterSheet, EnemySheet, ItemSheet).
// Honest bars: exact segment counts visible as text; clicking a bar or segment opens Review filtered to that area/entity + status.
import {
  formatArtSummary,
  formatProgressSummary,
  PROGRESS_BUCKET_LABEL,
  segmentPct,
  type ProgressEntry,
  type ProgressTextBucket,
} from "./storybookProgressLogic";

const BUCKET_ORDER: ProgressTextBucket[] = ["ok", "draft", "rewrite", "todo"];

export type ProgressOpenHandler = (status?: ProgressTextBucket | null) => void;

/** One honest progress bar row: label button, proportional segmented bar, clickable status segment counts, and art production status. */
export function ProgressBarRow({
  entry,
  onOpen,
  compact = false,
  testId,
}: {
  entry: ProgressEntry;
  onOpen?: ProgressOpenHandler;
  compact?: boolean;
  testId?: string;
}) {
  const { text, art } = entry;
  const artLabel = formatArtSummary(art);
  const summary = formatProgressSummary(entry);
  const canOpen = Boolean(onOpen && text.total > 0);

  return (
    <div className={`sb-prog-row${compact ? " sb-prog-compact" : ""}`} data-testid={testId ?? `sb-prog-${entry.id}`}>
      <div className="sb-prog-top">
        {canOpen ? (
          <button
            type="button"
            className="sb-prog-label-btn"
            data-testid={`sb-prog-open-${entry.id}`}
            title={`Open Review filtered to ${entry.label}`}
            onClick={() => onOpen?.(null)}
          >
            {entry.label}
          </button>
        ) : (
          <span className="sb-prog-label">{entry.label}</span>
        )}
        <div className="sb-prog-counts" data-testid={`sb-prog-counts-${entry.id}`}>
          {text.total === 0 ? (
            <span className="sb-prog-zero">0 lines</span>
          ) : (
            BUCKET_ORDER.filter((b) => text[b] > 0).map((b) =>
              canOpen ? (
                <button
                  key={b}
                  type="button"
                  className={`sb-prog-segbtn sb-prog-seg-${b}`}
                  data-testid={`sb-prog-seg-${entry.id}-${b}`}
                  title={`Open Review: ${entry.label} · ${PROGRESS_BUCKET_LABEL[b]}`}
                  onClick={() => onOpen?.(b)}
                >
                  {text[b]} {PROGRESS_BUCKET_LABEL[b]}
                </button>
              ) : (
                <span key={b} className={`sb-prog-segbtn sb-prog-seg-${b}`}>
                  {text[b]} {PROGRESS_BUCKET_LABEL[b]}
                </span>
              ),
            )
          )}
          {artLabel && (
            <span className="sb-prog-art" data-testid={`sb-prog-art-${entry.id}`} title="Art counts one unit per entity (a missing slot counts as 1); entity sheets count each slot.">
              {artLabel}
            </span>
          )}
        </div>
      </div>
      <div className="sb-prog-track" role="img" aria-label={summary}>
        {text.total > 0 &&
          BUCKET_ORDER.map((b) => {
            const pct = segmentPct(text[b], text.total);
            if (pct <= 0) return null;
            return <span key={b} className={`sb-prog-fill sb-prog-fill-${b}`} style={{ width: `${pct}%` }} />;
          })}
      </div>
    </div>
  );
}
