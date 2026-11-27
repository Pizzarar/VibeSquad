// Storybook V5 (docs/PLAN_STORYBOOK_V2.md): per-trader story column + one play-order list, inside the Quests tab.
// Data is snap.arc from server/storybook/unlocks.mjs; this file only renders it. No Mermaid timeline (apostrophes, tall).
import { useMemo } from "react";
import { cleanTodo, type EntityIndex, type SbArc, type SbArcGate, type SbEntity, type SbPlayItem } from "./storybookLogic";

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

function Gates({ gates, idx }: { gates: SbArcGate[]; idx: EntityIndex }) {
  const g = gates.filter((x) => x.type !== "map_order");
  return g.length ? <span className="sb-arc-gates">{g.map((x) => gateText(x, idx)).join(" · ")}</span> : null;
}

function taskText(e: SbEntity | null): string {
  const t = e?.data?.task;
  if (!t) return "";
  const parts = [t.type, t.qty ? `×${t.qty}` : "", t.item_id ?? t.enemy_id ?? t.location ?? t.room ?? t.skill ?? ""].filter((x) => x !== "" && x != null);
  return parts.join(" ").replace(/_/g, " ");
}

export function StorybookArc({ arc, idx, chip, openLine, mode, actions, batch }: ArcProps & { mode: "arcs" | "order" }) {
  const byTrader = useMemo(() => (arc?.arcs ?? []).filter((a) => a.steps.length || a.reactions.length), [arc]);
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
  if (mode === "order") {
    let stage = -1;
    return (
      <div>
        <p className="sb-arc-note" data-testid="sb-arc-order-note">{arc.playOrder.length} items in player order, derived from map unlock order, questline chains and contract rep gates. {arc.gaps.length} could not be fully ordered ({arc.gaps.length ? "see below" : "none"}).</p>
        <ol className="sb-order" data-testid="sb-play-order">
          {arc.playOrder.map((p: SbPlayItem) => {
            const head = p.stage !== stage ? (stage = p.stage, <li key={`s${p.stage}`} className="sb-order-stage" role="presentation">{p.stage === 0 ? "From the start" : `Stage ${p.stage}`}</li>) : null;
            const e = p.kind === "reveal" ? idx.get("quest_step", p.ref ?? "") : idx.get(p.kind === "map" ? "location" : p.kind, p.id);
            return [head, (
              <li key={p.id} className={`sb-order-item sb-order-${p.kind}`}>
                <span className="sb-order-pos">{p.pos}</span>
                <span className="sb-order-kind">{KIND_LABEL[p.kind]}</span>
                {e ? chip(e, p.kind === "reveal" ? p.label : p.kind === "contract" ? cleanTodo(p.id) : undefined) : <span>{p.label}</span>}
                {p.trader && <span className="sb-order-who">{idx.get("trader", p.trader)?.display ?? p.trader}</span>}
                <Gates gates={p.gates} idx={idx} />
              </li>
            )];
          })}
        </ol>
        <GapList arc={arc} idx={idx} />
      </div>
    );
  }
  return (
    <div>
      <p className="sb-arc-note">Each trader&apos;s quest steps in the order the player meets them, with the dialogue inline. {arc.arcs.length} traders, {byTrader.reduce((n, a) => n + a.steps.length, 0)} steps.</p>
      <div className="sb-arcs" data-testid="sb-arcs">
        {byTrader.map((a) => {
          const t = idx.get("trader", a.trader);
          return (
            <section key={a.trader} className="sb-arc" data-testid={`sb-arc-${a.trader}`}>
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
                        <span className="sb-arc-task">{taskText(e)}</span>
                      </div>
                      <Gates gates={s.gates} idx={idx} />
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
