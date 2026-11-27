// Storybook V5 (docs/PLAN_STORYBOOK_V2.md): per-trader story column + one play-order list, inside the Quests tab.
// Data is snap.arc from server/storybook/unlocks.mjs; this file only renders it. No Mermaid timeline (apostrophes, tall).
import { useMemo, useRef } from "react";
import { cleanTodo, partitionPlayOrder, playItemLabel, type EntityIndex, type SbArc, type SbArcGate, type SbEntity, type SbPlayItem } from "./storybookLogic";

export type ArcProps = {
  arc: SbArc | undefined;
  idx: EntityIndex;
  /** Chip for an entity (the host owns card/hover behaviour). */
  chip: (e: SbEntity, label?: string) => React.ReactNode;
  /** Open a dialogue line's row in Review. */
  openLine: (e: SbEntity) => void;
  /** V6: OK / Redo / Edit on a step title or story line. */
  actions?: (e: SbEntity) => React.ReactNode;
  /** V6: progress + batch marks on an arc card (its step + reaction lines). */
  batch?: (lines: SbEntity[], label: string) => React.ReactNode;
};

const KIND_LABEL: Record<string, string> = { map: "Map", reveal: "Reveal", quest_step: "Quest", contract: "Contract" };

export function gateText(g: SbArcGate, idx: EntityIndex): string {
  const nm = (k: string, id?: string | null) => (id ? cleanTodo(idx.get(k, id)?.display ?? id) : "?");
  switch (g.type) {
    case "prev_step": return `after ${nm("quest_step", g.id)}`;
    case "map": return `needs map ${nm("location", g.id)} (#${g.unlock_order})`;
    case "map_order": return `map #${g.unlock_order}`;
    case "key": return `key ${nm("item", g.id)}`;
    case "room": return `room ${nm("room", g.id)}${g.level ? ` lvl ${g.level}` : ""}`;
    case "skill": return `${nm("skill", g.id)}${g.level ? ` lvl ${g.level}` : ""}`;
    case "rep": return `${nm("trader", g.trader)} rep ${g.rep}`;
    case "trader_unlock": return `${nm("trader", g.id)} unlocked (rule not in data)`;
    default: return g.type;
  }
}

function Gates({ gates, idx, chip }: { gates: SbArcGate[]; idx: EntityIndex; chip?: (e: SbEntity, label?: string) => React.ReactNode }) {
  const g = gates.filter((x) => x.type !== "map_order");
  if (!g.length) return null;
  return (
    <span className="sb-arc-gates">
      {g.map((x, i) => {
        const sep = i > 0 ? " · " : "";
        if (chip && x.type === "map" && x.id) {
          const loc = idx.get("location", x.id);
          if (loc) return <span key={`g${i}`} className="sb-arc-gate">{sep}needs map {chip(loc)} (#{x.unlock_order})</span>;
        }
        return <span key={`g${i}`} className="sb-arc-gate">{sep}{gateText(x, idx)}</span>;
      })}
    </span>
  );
}

function StepTask({ e, idx, chip }: { e: SbEntity | null; idx: EntityIndex; chip: (e: SbEntity, label?: string) => React.ReactNode }) {
  const t = e?.data?.task;
  if (!t) return null;
  const item = t.item_id ? idx.get("item", String(t.item_id)) : null;
  const enemy = t.enemy_id ? idx.get("enemy", String(t.enemy_id)) : null;
  const loc = t.location ? idx.get("location", String(t.location)) : null;
  const room = t.room ? idx.get("room", String(t.room)) : null;
  const skill = t.skill ? idx.get("skill", String(t.skill)) : null;
  const verb = [t.type, t.qty ? `×${t.qty}` : ""].filter(Boolean).join(" ").replace(/_/g, " ");
  const hasPrimary = Boolean(t.item_id || t.enemy_id);
  return (
    <span className="sb-arc-task" data-testid="sb-arc-task">
      {verb && <span>{verb}</span>}
      {t.item_id && (item ? chip(item) : <span>{String(t.item_id).replace(/_/g, " ")}</span>)}
      {t.enemy_id && (enemy ? chip(enemy) : <span>{String(t.enemy_id).replace(/_/g, " ")}</span>)}
      {t.location && <>{hasPrimary ? " @ " : ""}{loc ? chip(loc) : <span>{String(t.location).replace(/_/g, " ")}</span>}</>}
      {t.room && <>{room ? chip(room) : <span>{String(t.room).replace(/_/g, " ")}</span>}{t.level ? ` lvl ${t.level}` : ""}</>}
      {t.skill && <>{skill ? chip(skill) : <span>{String(t.skill).replace(/_/g, " ")}</span>}{t.level ? ` lvl ${t.level}` : ""}</>}
    </span>
  );
}

export function StorybookArc({ arc, idx, chip, openLine, mode, actions, batch }: ArcProps & { mode: "arcs" | "order" }) {
  const byTrader = useMemo(() => (arc?.arcs ?? []).filter((a) => a.steps.length || a.reactions.length), [arc]);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const playPart = useMemo(() => (arc ? partitionPlayOrder(arc, idx) : null), [arc, idx]);
  if (!arc) return <p className="sb-empty">No arc data in this snapshot.</p>;
  const lineRow = (id: string, field?: string) => {
    const l = idx.get("line", id);
    if (!l) return null;
    const text = cleanTodo(String(l.data?.text ?? l.data?.current_text ?? l.display));
    return (
      <div key={id} className="sb-arc-line" data-testid="sb-arc-line">
        {field && <span className="sb-arc-field">{field}</span>}
        <span className="sb-arc-text">{text}</span>
        <button type="button" className="sb-arc-open" onClick={() => openLine(l)} aria-label="Open this line in Review">Review row →</button>
        {actions && <div className="sb-arc-actions">{actions(l)}</div>}
      </div>
    );
  };
  const renderPlayRow = (p: SbPlayItem, showPos: boolean) => {
    const e = p.kind === "reveal" ? idx.get("quest_step", p.ref ?? "") : idx.get(p.kind === "map" ? "location" : p.kind, p.id);
    const lbl = playItemLabel(p, idx);
    return (
      <li key={p.id} className={`sb-order-item sb-order-${p.kind}`}>
        {showPos && <span className="sb-order-pos">{p.pos}</span>}
        <span className="sb-order-kind">{KIND_LABEL[p.kind]}</span>
        {e ? chip(e, lbl) : <span>{lbl ?? p.label}</span>}
        {p.trader && <span className="sb-order-who">{idx.get("trader", p.trader)?.display ?? p.trader}</span>}
        <Gates gates={p.gates} idx={idx} />
      </li>
    );
  };
  if (mode === "order") {
    const { ordered, unordered, unorderedCount } = playPart!;
    let stage = -1;
    return (
      <div>
        <p className="sb-arc-note" data-testid="sb-arc-order-note">
          {ordered.length} items in player order, derived from map unlock order, questline chains and contract rep gates.{" "}
          {unorderedCount > 0 ? `${unorderedCount} grouped below under "Unlock rule not in EFI data" (${unordered.length} traders).` : "All items ordered."}
        </p>
        <ol className="sb-order" data-testid="sb-play-order">
          {ordered.map((p: SbPlayItem) => {
            const head = p.stage !== stage ? (stage = p.stage, <li key={`s${p.stage}`} className="sb-order-stage" role="presentation">{p.stage === 0 ? "From the start" : `Stage ${p.stage}`}</li>) : null;
            return [head, renderPlayRow(p, true)];
          })}
        </ol>
        {unorderedCount > 0 && (
          <section className="sb-order-unordered" data-testid="sb-play-order-unordered">
            <h3 className="sb-h">Unlock rule not in EFI data <span className="sb-count">{unorderedCount}</span></h3>
            {unordered.map((g) => (
              <details key={g.trader || "_other"} className="sb-order-ugroup" data-testid={`sb-order-ugroup-${g.trader || "other"}`}>
                <summary>{g.display} <span className="sb-count">{g.items.length}</span></summary>
                <ul className="sb-order">
                  {g.items.map((p) => renderPlayRow(p, false))}
                </ul>
              </details>
            ))}
          </section>
        )}
        <GapList arc={arc} idx={idx} />
      </div>
    );
  }
  const jumpToTrader = (tid: string) => {
    const el = sectionRefs.current[tid];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("sb-flash");
    setTimeout(() => el.classList.remove("sb-flash"), 1400);
  };
  return (
    <div>
      <p className="sb-arc-note">Each trader&apos;s quest steps in the order the player meets them, with the dialogue inline. {arc.arcs.length} traders, {byTrader.reduce((n, a) => n + a.steps.length, 0)} steps.</p>
      {byTrader.length > 1 && (
        <nav className="sb-arc-index" aria-label="Jump to trader arc" data-testid="sb-arc-index">
          {byTrader.map((a) => (
            <button key={a.trader} type="button" className="sb-seg-btn" data-testid={`sb-arc-jump-${a.trader}`} onClick={() => jumpToTrader(a.trader)}>
              {a.display} <span className="sb-count">{a.steps.length}</span>
            </button>
          ))}
        </nav>
      )}
      <div className="sb-arcs" data-testid="sb-arcs">
        {byTrader.map((a) => {
          const t = idx.get("trader", a.trader);
          return (
            <section key={a.trader} ref={(el) => { sectionRefs.current[a.trader] = el; }} className="sb-arc" data-testid={`sb-arc-${a.trader}`}>
              <h3 className="sb-arc-h">{t ? chip(t, a.display) : a.display}<span className="sb-count">{a.steps.length} steps · rep {a.chain_rep}</span></h3>
              {batch && batch([...a.steps.flatMap((s) => s.lines.map((l) => l.id)), ...a.reactions].map((id) => idx.get("line", id)).filter((x): x is SbEntity => Boolean(x)), a.display)}
              {!a.level_0 && <div className="sb-arc-gates">Not available at the start (unlock rule not in data).</div>}
              <ol className="sb-arc-steps">
                {a.steps.map((s) => {
                  const e = idx.get("quest_step", s.id);
                  return (
                    <li key={s.id} className="sb-arc-step">
                      <div className="sb-arc-stephead">
                        <span className="sb-order-pos">{s.index}</span>
                        {e ? chip(e, cleanTodo(e.display)) : s.id}
                        <StepTask e={e} idx={idx} chip={chip} />
                      </div>
                      <Gates gates={s.gates} idx={idx} chip={chip} />
                      {s.lines.map((l) => lineRow(l.id, l.field))}
                    </li>
                  );
                })}
              </ol>
              {a.reactions.length > 0 && (
                <details className="sb-arc-react">
                  <summary>Reactions &amp; encouragement ({a.reactions.length})</summary>
                  {a.reactions.map((id) => lineRow(id))}
                </details>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function GapList({ arc, idx }: { arc: SbArc; idx: EntityIndex }) {
  if (!arc.gaps.length && !arc.notDerivable.length) return null;
  return (
    <details className="sb-arc-gaps" data-testid="sb-arc-gaps">
      <summary>What could not be ordered ({arc.gaps.length}) and what is not in the data ({arc.notDerivable.length})</summary>
      <ul>
        {arc.gaps.map((g, i) => <li key={`${g.kind}:${g.id}:${i}`}><b>{g.kind} {cleanTodo(idx.get(g.kind === "map" ? "location" : g.kind, g.id)?.display ?? g.id)}</b>: {g.why}</li>)}
        {arc.notDerivable.map((n, i) => <li key={`n${i}`}>{n}</li>)}
      </ul>
    </details>
  );
}
