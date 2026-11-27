// Storybook Glossary tab (PLAN_STORYBOOK_V2 V10, read-only):
// Canonical terms, banned terms, and name-style rules, each with its #16/#17 findings and links to rows/entities.
import { useMemo, useState } from "react";
import {
  cleanTodo, fmtSource,
  type EntityIndex, type SbEntity, type SbFinding, type SbGlossary, type SbSnapshot,
} from "./storybookLogic";

function matchCanonicalFindings(term: string, findings: SbFinding[]): SbFinding[] {
  const prefix = `term "${term}"`;
  return findings.filter((f) => f.check === "#16" && f.msg.startsWith(prefix));
}

function matchBannedFindings(term: string, findings: SbFinding[]): SbFinding[] {
  const prefix = `banned term "${term.toLowerCase()}"`;
  return findings.filter((f) => f.check === "#16" && f.msg.toLowerCase().startsWith(prefix));
}

function matchRuleFindings(ruleId: string, findings: SbFinding[]): SbFinding[] {
  const f17 = findings.filter((f) => f.check === "#17");
  if (ruleId === "cross-kind-id") return f17.filter((f) => f.msg.startsWith("cross-kind id"));
  if (ruleId === "id-display-drift") return f17.filter((f) => f.msg.startsWith("id↔display drift"));
  if (ruleId === "naming-style") return f17.filter((f) => f.msg.startsWith("naming style"));
  return [];
}

function FindingRows({ findings, idx, onGo, onReview }: {
  findings: SbFinding[];
  idx: EntityIndex;
  onGo: (e: SbEntity) => void;
  onReview: (e: SbEntity) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (findings.length === 0) return null;
  const shown = expanded ? findings : findings.slice(0, 5);
  return (
    <div className="sb-gloss-hits">
      <ul className="sb-gloss-list">
        {shown.map((f, i) => {
          const ent = f.entityRef ? idx.get(f.entityRef.kind, f.entityRef.id) : null;
          return (
            <li key={`${f.check}-${f.entityRef?.kind ?? ""}-${f.entityRef?.id ?? ""}-${i}`} className={`sb-gloss-hit sb-sev-${f.severity}`}>
              <p className="sb-gloss-msg">{f.msg}</p>
              <div className="sb-gloss-foot">
                {ent && (
                  <button
                    type="button"
                    className="sb-link"
                    data-testid="sb-glossary-row-link"
                    onClick={() => (ent.kind === "line" ? onReview(ent) : onGo(ent))}
                  >
                    → {ent.kind === "line" ? "Review row" : `${ent.kind.replace(/_/g, " ")}: ${cleanTodo(ent.display)}`}
                  </button>
                )}
                {f.source && <span className="sb-mono">{fmtSource(f.source)}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      {findings.length > 5 && (
        <button type="button" className="sb-btn sb-gloss-more" onClick={() => setExpanded((x) => !x)}>
          {expanded ? "Show fewer" : `Show all ${findings.length} findings`}
        </button>
      )}
    </div>
  );
}

export function StorybookGlossary({ snap, idx, onGo, onReview }: {
  snap: SbSnapshot;
  idx: EntityIndex;
  onGo: (e: SbEntity) => void;
  onReview: (e: SbEntity) => void;
}) {
  const [query, setQuery] = useState("");
  const [onlyHits, setOnlyHits] = useState(false);

  const glossary: SbGlossary | null = snap.glossary ?? null;
  const q = query.trim().toLowerCase();

  const canonical = useMemo(() => {
    if (!glossary) return [];
    return glossary.canonical.map((c) => ({
      item: c,
      hits: matchCanonicalFindings(c.term, snap.findings),
    })).filter(({ item, hits }) => {
      if (onlyHits && hits.length === 0) return false;
      if (!q) return true;
      return item.term.toLowerCase().includes(q)
        || item.note.toLowerCase().includes(q)
        || item.variants.some((v) => v.toLowerCase().includes(q))
        || hits.some((h) => h.msg.toLowerCase().includes(q));
    });
  }, [glossary, snap.findings, q, onlyHits]);

  const banned = useMemo(() => {
    if (!glossary) return [];
    return glossary.banned.map((b) => ({
      item: b,
      hits: matchBannedFindings(b.term, snap.findings),
    })).filter(({ item, hits }) => {
      if (onlyHits && hits.length === 0) return false;
      if (!q) return true;
      return item.term.toLowerCase().includes(q)
        || item.note.toLowerCase().includes(q)
        || hits.some((h) => h.msg.toLowerCase().includes(q));
    });
  }, [glossary, snap.findings, q, onlyHits]);

  const rules = useMemo(() => {
    if (!glossary) return [];
    return glossary.nameStyleRules.map((r) => ({
      item: r,
      hits: matchRuleFindings(r.id, snap.findings),
    })).filter(({ item, hits }) => {
      if (onlyHits && hits.length === 0) return false;
      if (!q) return true;
      return item.title.toLowerCase().includes(q)
        || item.description.toLowerCase().includes(q)
        || hits.some((h) => h.msg.toLowerCase().includes(q));
    });
  }, [glossary, snap.findings, q, onlyHits]);

  const total16 = useMemo(() => snap.findings.filter((f) => f.check === "#16").length, [snap.findings]);
  const total17 = useMemo(() => snap.findings.filter((f) => f.check === "#17").length, [snap.findings]);

  if (!glossary) {
    return <p className="sb-empty" data-testid="sb-glossary-empty">No glossary loaded in this snapshot.</p>;
  }

  return (
    <div className="sb-glossary" data-testid="sb-glossary">
      <div className="sb-gloss-head">
        <div className="sb-gloss-meta">
          <span className="sb-tag" data-testid="sb-glossary-source">
            {glossary.source.seeded ? `Seeded from ${glossary.source.path}` : glossary.source.path}
          </span>
          <span className="sb-tag">Read-only</span>
          <span className="sb-tag">Player word: “{glossary.playerWord}”</span>
          <span className="sb-tag">{total16} term finding{total16 === 1 ? "" : "s"} (#16)</span>
          <span className="sb-tag">{total17} naming finding{total17 === 1 ? "" : "s"} (#17)</span>
        </div>
        <div className="sb-gloss-bar">
          <input
            type="search"
            className="sb-search-input"
            aria-label="Filter glossary"
            placeholder="Filter terms, bans, or naming findings…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="sb-glossary-search"
          />
          <button
            type="button"
            className="sb-fbtn"
            aria-pressed={onlyHits}
            data-testid="sb-glossary-only-hits"
            onClick={() => setOnlyHits((v) => !v)}
          >
            Only with findings
          </button>
        </div>
      </div>

      <section className="sb-section" data-testid="sb-glossary-canonical">
        <h3 className="sb-h">Canonical terms <span className="sb-count">{canonical.length}</span></h3>
        {canonical.length === 0 ? <p className="sb-empty sb-empty-sm">No matching canonical terms.</p> : (
          <div className="sb-gloss-cards">
            {canonical.map(({ item, hits }) => (
              <article key={item.id} className={`sb-gloss-card${hits.length > 0 ? " sb-gloss-card-hit" : ""}`} data-testid={`sb-gloss-canon-${item.id}`}>
                <div className="sb-gloss-card-top">
                  <strong className="sb-gloss-term">{item.term}</strong>
                  <span className={`sb-count${hits.length > 0 ? " sb-gloss-badge-warn" : ""}`}>{hits.length} finding{hits.length === 1 ? "" : "s"}</span>
                </div>
                {item.note && <p className="sb-gloss-note">{item.note}</p>}
                {item.variants.length > 0 && (
                  <div className="sb-gloss-variants">
                    <span className="sb-rel-name">Watched variants:</span>{" "}
                    {item.variants.map((v) => <code key={v} className="sb-gloss-var">{v}</code>)}
                  </div>
                )}
                <FindingRows findings={hits} idx={idx} onGo={onGo} onReview={onReview} />
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="sb-section" data-testid="sb-glossary-banned">
        <h3 className="sb-h">Banned terms <span className="sb-count">{banned.length}</span></h3>
        {banned.length === 0 ? <p className="sb-empty sb-empty-sm">No matching banned terms.</p> : (
          <div className="sb-gloss-bans">
            {banned.map(({ item, hits }) => (
              <article key={item.id} className={`sb-gloss-card${hits.length > 0 ? " sb-gloss-card-hit" : ""}`} data-testid={`sb-gloss-ban-${item.id}`}>
                <div className="sb-gloss-card-top">
                  <strong className="sb-gloss-term">{item.display ?? item.term}</strong>
                  <span className={`sb-count${hits.length > 0 ? " sb-gloss-badge-warn" : ""}`}>{hits.length}</span>
                </div>
                {item.note && <p className="sb-gloss-note">{item.note}</p>}
                <FindingRows findings={hits} idx={idx} onGo={onGo} onReview={onReview} />
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="sb-section" data-testid="sb-glossary-rules">
        <h3 className="sb-h">Name-style rules <span className="sb-count">{rules.length}</span></h3>
        {rules.length === 0 ? <p className="sb-empty sb-empty-sm">No matching naming rules.</p> : (
          <div className="sb-gloss-cards">
            {rules.map(({ item, hits }) => (
              <article key={item.id} className={`sb-gloss-card${hits.length > 0 ? " sb-gloss-card-hit" : ""}`} data-testid={`sb-gloss-rule-${item.id}`}>
                <div className="sb-gloss-card-top">
                  <strong className="sb-gloss-term">{item.title}</strong>
                  <span className={`sb-count${hits.length > 0 ? " sb-gloss-badge-warn" : ""}`}>{hits.length} finding{hits.length === 1 ? "" : "s"}</span>
                </div>
                <p className="sb-gloss-note">{item.description}</p>
                <FindingRows findings={hits} idx={idx} onGo={onGo} onReview={onReview} />
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
