// Storybook Home (PLAN_STORYBOOK_V2 V2): the landing tab. Counts per entity kind, the 4 audit signals, and attention buckets
// (Problems, Story issues, Text to review) that each open the matching Findings view. Pure derivation from the snapshot; read-only.
import { useMemo } from "react";
import {
  AUDIT_HELP, AUDIT_LABEL, AUDIT_SIGNALS, FINDING_SCOPE_HELP, FINDING_SCOPE_LABEL, auditCounts, kindCounts, kindTab, scopeCounts,
  type FindingScope, type ListItem, type SbSnapshot,
} from "./storybookLogic";

const BUCKETS: FindingScope[] = ["problems", "story", "coverage", "text"];

export function StorybookHome({ snap, items, onTab, onFindings, onSignal }: { snap: SbSnapshot; items: ListItem[]; onTab: (tab: string) => void; onFindings: (scope: FindingScope) => void; onSignal?: (signal: string) => void }) {
  const kinds = useMemo(() => kindCounts(snap.entities), [snap]);
  const scopes = useMemo(() => scopeCounts(items), [items]);
  const audit = useMemo(() => auditCounts(snap.audit), [snap]);
  return (
    <div className="sb-home" data-testid="sb-overview">
      <section className="sb-section">
        <h3 className="sb-h">Needs attention</h3>
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
      {audit && (
        <section className="sb-section">
          <h3 className="sb-h">Audit signals</h3>
          <div className="sb-signals" data-testid="sb-signals">
            {AUDIT_SIGNALS.map((s) => (
              <button key={s} type="button" className={`sb-signal${audit[s] ? " sb-signal-on" : ""}`} data-testid={`sb-signal-${s}`} onClick={() => onSignal?.(s)}>
                <span className="sb-signal-name">{AUDIT_LABEL[s]}</span>
                <span className="sb-signal-n">{audit[s]}</span>
                <span className="sb-signal-help">{AUDIT_HELP[s]}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="sb-section">
        <h3 className="sb-h">What is in here <span className="sb-count">{snap.entities.length}</span></h3>
        <ul className="sb-kinds" data-testid="sb-kinds">
          {kinds.map((k) => {
            const tab = kindTab(k.kind);
            return (
              <li key={k.kind}>
                {tab
                  ? <button type="button" className="sb-kind-btn" data-testid={`sb-kind-${k.kind}`} onClick={() => onTab(tab)}><span className="sb-kind-n">{k.n}</span> {k.label}</button>
                  : <span className="sb-kind-btn sb-kind-static" data-testid={`sb-kind-${k.kind}`}><span className="sb-kind-n">{k.n}</span> {k.label}</span>}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
