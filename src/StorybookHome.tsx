// Storybook Home (PLAN_STORYBOOK_V2 V2): the landing tab. Counts per entity kind, the 4 audit signals, and attention buckets
// (Problems, Story issues, Text to review) that each open the matching Findings view. Pure derivation from the snapshot; read-only.
import { useMemo } from "react";
import {
  AUDIT_HELP, AUDIT_LABEL, AUDIT_SIGNALS, FINDING_SCOPE_HELP, FINDING_SCOPE_LABEL, auditCounts, changesSince, changesTotal, firstSessionCopy, goneBreakdown, isUnreviewedLine, kindCounts, kindTab, scopeCounts, shortSha, signalCard,
  type FindingScope, type ListItem, type SbChanges, type SbEntity, type SbSnapshot,
} from "./storybookLogic";
import { ProgressBarRow } from "./StorybookProgress";
import type { ProgressAreaId, ProgressTextBucket, SbProgress } from "./storybookProgress";

const BUCKETS: FindingScope[] = ["problems", "story", "coverage", "text"];
const GONE_PREVIEW_CAP = 60;

type HomeProps = {
  snap: SbSnapshot; items: ListItem[]; onTab: (tab: string) => void; onFindings: (scope: FindingScope) => void; onSignal?: (signal: string) => void;
  changes?: SbChanges | null; onChanges?: () => void; onMarkSeen?: () => void; seenBusy?: boolean; seenError?: string | null; hasReviewSession?: boolean;
  onContracts?: () => void; renderChip?: (e: SbEntity, label?: string) => React.ReactNode;
  progress?: SbProgress | null; onProgressArea?: (area: ProgressAreaId, status?: ProgressTextBucket | null) => void;
  onOpenGuide?: () => void;
};

/** V8: first Needs-attention card. New / changed / gone since the owner's last marked-seen session. */
function ChangesCard({ ch, onOpen, onMarkSeen, busy, error, hasReviewSession }: { ch: SbChanges; onOpen?: () => void; onMarkSeen?: () => void; busy?: boolean; error?: string | null; hasReviewSession?: boolean }) {
  const total = changesTotal(ch);
  const mark = onMarkSeen && (
    <button type="button" className="sb-btn sb-changes-seen" data-testid="sb-changes-seen" disabled={busy} onClick={onMarkSeen}>{busy ? "Saving…" : `Mark seen (up to ${shortSha(ch.to.sha)})`}</button>
  );
  if (ch.first) {
    const copy = firstSessionCopy(Boolean(hasReviewSession), ch.to.total, ch.to.sha);
    return (
      <div className="sb-changes sb-changes-first" data-testid="sb-changes">
        <div className="sb-changes-head"><b>{copy.title}</b><span className="sb-changes-sub">{copy.sub}</span></div>
        <div className="sb-changes-act">{mark}</div>
        {error && <p className="sb-err" role="alert">{error}</p>}
      </div>
    );
  }
  const g = goneBreakdown(ch);
  const shownGone = ch.gone.slice(0, GONE_PREVIEW_CAP);
  return (
    <div className={`sb-changes${total === 0 ? " sb-changes-zero" : ""}`} data-testid="sb-changes">
      <div className="sb-changes-head"><b>New / changed / gone since {changesSince(ch)}</b><span className="sb-changes-sub">{ch.from?.sha === ch.to.sha ? "same commit" : `${shortSha(ch.from?.sha)}..${shortSha(ch.to.sha)}`}</span></div>
      <div className="sb-changes-counts">
        <span data-testid="sb-changes-new"><b>{ch.counts.new}</b> new</span>
        <span data-testid="sb-changes-changed"><b>{ch.counts.changed}</b> changed</span>
        <span data-testid="sb-changes-gone"><b>{ch.counts.gone}</b> gone</span>
      </div>
      {g && <p className="sb-changes-why" data-testid="sb-changes-why">Gone: {g}.</p>}
      {total === 0 && <p className="sb-changes-why">Nothing new since your last session.</p>}
      {shownGone.length > 0 && (
        <details className="sb-changes-gonelist"><summary>Show gone rows{ch.counts.gone > shownGone.length ? ` (first ${shownGone.length} of ${ch.counts.gone})` : ""}</summary>
          <ul>{shownGone.map((r) => <li key={r.key}><span className="sb-tag">{r.reason === "efi" ? "EFI" : "hidden"}</span> {r.text} <span className="sb-mono">{r.file}</span><span className="sb-changes-reason"> · {r.why}</span></li>)}</ul>
        </details>
      )}
      <div className="sb-changes-act">
        {(ch.counts.new + ch.counts.changed > 0) && onOpen && <button type="button" className="sb-btn" data-testid="sb-changes-open" onClick={onOpen}>Review changes →</button>}
        {(total > 0 || ch.from?.sha !== ch.to.sha) && mark}
      </div>
      {error && <p className="sb-err" role="alert">{error}</p>}
    </div>
  );
}

export function StorybookHome({ snap, items, onTab, onFindings, onSignal, changes, onChanges, onMarkSeen, seenBusy, seenError, hasReviewSession, onContracts, renderChip, progress, onProgressArea, onOpenGuide }: HomeProps) {
  const kinds = useMemo(() => kindCounts(snap.entities), [snap]);
  const scopes = useMemo(() => scopeCounts(items), [items]);
  const baseAudit = useMemo(() => auditCounts(snap.audit), [snap]);
  const baseUnreviewed = useMemo(() => snap.entities.filter((e) => isUnreviewedLine(e)).length, [snap]);
  const audit = useMemo(() => {
    if (!baseAudit) return null;
    const delta = baseUnreviewed - scopes.text;
    return delta === 0 ? baseAudit : { ...baseAudit, signoff: Math.max(0, baseAudit.signoff - delta) };
  }, [baseAudit, baseUnreviewed, scopes.text]);
  const progTotal = useMemo(() => (progress ? progress.areas.reduce((acc, a) => ({ ok: acc.ok + a.text.ok, total: acc.total + a.text.total }), { ok: 0, total: 0 }) : null), [progress]);
  return (
    <div className="sb-home" data-testid="sb-overview">
      <section className="sb-section">
        <div className="sb-home-top">
          <h3 className="sb-h">Needs attention</h3>
          {onOpenGuide && <button type="button" className="sb-btn sb-home-guide" data-testid="sb-home-guide" onClick={onOpenGuide}>How to use</button>}
        </div>
        {changes && <ChangesCard ch={changes} onOpen={onChanges} onMarkSeen={onMarkSeen} busy={seenBusy} error={seenError} hasReviewSession={hasReviewSession} />}
        <div className="sb-buckets">
          {BUCKETS.map((b) => (
            <button key={b} type="button" className={`sb-bucket sb-bucket-${b}${scopes[b] === 0 ? " sb-bucket-zero" : ""}`} data-testid={`sb-bucket-${b}`} onClick={() => onFindings(b)}>
              <span className="sb-bucket-n">{scopes[b]}</span>
              <span className="sb-bucket-name">{FINDING_SCOPE_LABEL[b]}</span>
              <span className="sb-bucket-help">{FINDING_SCOPE_HELP[b]}</span>
            </button>
          ))}
        </div>
      </section>
      {progress && progress.areas.length > 0 && (
        <section className="sb-section" data-testid="sb-progress-section">
          <h3 className="sb-h">
            Placeholder → final progress
            {progTotal && <span className="sb-count">{progTotal.ok}/{progTotal.total} OK</span>}
          </h3>
          <div className="sb-prog-list" data-testid="sb-progress-bars">
            {progress.areas.map((area) => (
              <ProgressBarRow
                key={area.id}
                entry={area}
                onOpen={onProgressArea ? (st) => onProgressArea(area.id as ProgressAreaId, st) : undefined}
              />
            ))}
          </div>
        </section>
      )}
      {audit && (
        <section className="sb-section">
          <h3 className="sb-h">Audit signals</h3>
          <div className="sb-signals" data-testid="sb-signals">
            {AUDIT_SIGNALS.map((s) => {
              const c = signalCard(s, items, audit);
              return (
                <button key={s} type="button" className={`sb-signal${c.n ? " sb-signal-on" : ""}`} data-testid={`sb-signal-${s}`} onClick={() => onSignal?.(s)}>
                  <span className="sb-signal-name">{AUDIT_LABEL[s]}</span>
                  <span className="sb-signal-n">{c.n}</span>
                  <span className="sb-signal-help">{AUDIT_HELP[s]}</span>
                  <span className="sb-signal-legend" data-testid={`sb-signal-legend-${s}`}>{c.legend}</span>
                  {c.note && <span className="sb-signal-rest" data-testid={`sb-signal-rest-${s}`}>{c.note}</span>}
                  <span className="sb-signal-act" data-testid={`sb-signal-act-${s}`}>{c.action}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
      <section className="sb-section">
        <h3 className="sb-h">What is in here <span className="sb-count">{snap.entities.length}</span></h3>
        <ul className="sb-kinds" data-testid="sb-kinds">
          {kinds.map((k) => {
            const tab = kindTab(k.kind);
            if (k.kind === "contract" && onContracts) return <li key={k.kind}><button type="button" className="sb-kind-btn" data-testid="sb-kind-contract" title="Open the contracts in Review" onClick={onContracts}><span className="sb-kind-n">{k.n}</span> {k.label}</button></li>;
            if (k.kind === "skill" && renderChip) return <li key={k.kind}><span className="sb-kind-btn sb-kind-static" data-testid="sb-kind-skill" title="Skills have no tab; open one below for what uses it"><span className="sb-kind-n">{k.n}</span> {k.label}</span></li>;
            if (k.kind === "art_slot") return <li key={k.kind}><span className="sb-kind-btn sb-kind-static" data-testid="sb-kind-art_slot" title="Art slots have no sheet; missing art is counted in the Coverage signal"><span className="sb-kind-n">{k.n}</span> {k.label}</span></li>;
            return (
              <li key={k.kind}>
                {tab
                  ? <button type="button" className="sb-kind-btn" data-testid={`sb-kind-${k.kind}`} onClick={() => onTab(tab)}><span className="sb-kind-n">{k.n}</span> {k.label}</button>
                  : <span className="sb-kind-btn sb-kind-static" data-testid={`sb-kind-${k.kind}`}><span className="sb-kind-n">{k.n}</span> {k.label}</span>}
              </li>
            );
          })}
        </ul>
        {renderChip && (
          <div className="sb-skills" data-testid="sb-skills"><span className="sb-ents-lbl">Skills</span>{snap.entities.filter((e) => e.kind === "skill").map((e) => <span key={e.id} className="sb-ent">{renderChip(e)}</span>)}</div>
        )}
      </section>
    </div>
  );
}
