// Entity sheets (PLAN_STORYBOOK_V2 V4): one rich sheet per map (location), character (trader/squad/speaker),
// enemy, and item. Shows text lines (linking into Review), navigable entity links, and findings.
// Line rows share the Review rows' live V6 mark state (useMarks via `marks`), clean chrome, and OK / Redo / Edit buttons.
import { useMemo, type ReactNode } from "react";
import {
  checkLabel, cleanTodo, contractTitle, lineChipLabel, enemySheetData, entityFindings, fmtSource, fmtWindow, formatNeverSays, itemSheetData, locationView, plainText,
  type CharacterView, type EntityIndex, type SbEntity, type SbFinding,
} from "./storybookLogic";
import { MarkButtons, type MarksApi } from "./StorybookMarks";
import { PROGRESS_BUCKET_LABEL, liveLineBucket } from "./storybookProgress";
import { ProgressBarRow, type ProgressOpenHandler } from "./StorybookProgress";
import type { ProgressEntry } from "./storybookProgress";

export type ChipRenderer = (e: SbEntity, label?: string) => ReactNode;

function SheetSection({ title, n, empty = "None.", children }: { title: string; n: number; empty?: string; children: ReactNode }) {
  return (
    <section className="sb-section">
      <h4 className="sb-h">{title} <span className="sb-count">{n}</span></h4>
      {n > 0 ? <ul className="sb-list">{children}</ul> : <p className="sb-empty sb-empty-sm">{empty}</p>}
    </section>
  );
}

function SheetFindings({ findings }: { findings: SbFinding[] }) {
  return (
    <SheetSection title="Findings" n={findings.length} empty="No findings on this entity.">
      {findings.map((f, i) => (
        <li key={`${f.check}:${i}`} className={`sb-sheet-finding sb-sev-${f.severity}`}>
          <span className="sb-tag sb-check" title={`Check ${f.check}`}>{f.check} {checkLabel(f.check)}</span>
          <span className="sb-tag">{f.severity}</span>
          <span className="sb-sheet-msg">{f.msg}</span>
          {f.source && <span className="sb-mono">{fmtSource(f.source)}</span>}
        </li>
      ))}
    </SheetSection>
  );
}

const BUCKET_CLASS = { ok: "owner-ok", draft: "draft", rewrite: "needs-rewrite", todo: "story-todo" } as const;

/** Chips for contracts read as the player sees them (V9 rendered title), never the raw id (x_fence_sealed_vault). */
const titled = (renderChip: ChipRenderer): ChipRenderer => (e, label) => renderChip(e, label ?? (e.kind === "contract" ? contractTitle(e) : undefined));

function LineRow({ line, renderChip, onReview, marks }: { line: SbEntity; renderChip: ChipRenderer; onReview: (e: SbEntity) => void; marks?: MarksApi }) {
  const raw = typeof line.data?.status === "string" && line.data.status ? line.data.status : null;
  const bucket = liveLineBucket(marks ? marks.stateOf(line).kind : "none", raw, line.production);
  const text = cleanTodo(String(line.data?.text ?? line.display));
  return (
    <li className="sb-sheet-line" data-testid="sb-sheet-line" data-status={bucket}>
      <div className="sb-sheet-line-top">
        {renderChip(line, lineChipLabel(line))}
        <span className={`sb-status sb-st-${BUCKET_CLASS[bucket]}`} data-testid="sb-sheet-line-status">{PROGRESS_BUCKET_LABEL[bucket]}</span>
        {marks && <span className="sb-row-actions" data-slot="row-actions"><MarkButtons e={line} m={marks} /></span>}
        <button type="button" className="sb-link sb-review-jump" data-testid={`sb-line-review-${line.id}`} onClick={() => onReview(line)}>Review row →</button>
      </div>
      <p className="sb-quote">{text}</p>
    </li>
  );
}

/** Map sheet (World tab): lore/vibe, roster, boss, containers, quests, contracts, lines, findings. */
export function MapSheet({ loc, idx, findings, renderChip, onReview, progress, onProgress, marks }: {
  loc: SbEntity; idx: EntityIndex; findings: SbFinding[]; renderChip: ChipRenderer; onReview: (e: SbEntity) => void;
  progress?: ProgressEntry | null; onProgress?: ProgressOpenHandler; marks?: MarksApi;
}) {
  renderChip = titled(renderChip);
  const v = useMemo(() => locationView(loc, idx), [loc, idx]);
  const ownFindings = useMemo(() => entityFindings(loc, findings), [loc, findings]);
  const boss = v.enemies.find((e) => e.boss) ?? null;
  const roster = v.enemies.filter((e) => !e.boss);
  const containers: { id: string; name: string; weight: number | null; rows: { item_id: string; quantity: number; chance_bp: number | null }[] }[] =
    Array.isArray(loc.data?.containers) ? loc.data.containers : [];
  const d = loc.data ?? {};

  return (
    <article className="sb-sheet" data-testid={`sb-sheet-location-${loc.id}`}>
      <header className="sb-sheet-head">
        <h3>{loc.display} <span className="sb-kind">location</span></h3>
        <div className="sb-sheet-meta">
          {d.threat_tier && <span className="sb-tag">{String(d.threat_tier)} threat</span>}
          {d.default_raid_seconds != null && <span className="sb-tag">raid {String(d.default_raid_seconds)}s</span>}
          <span className="sb-mono">{fmtSource(loc.source)}</span>
        </div>
      </header>
      {progress && <ProgressBarRow entry={progress} onOpen={onProgress} compact testId={`sb-sheet-progress-location-${loc.id}`} />}

      <SheetSection title="Lore & vibe" n={v.lore.length} empty="No lore/vibe entry for this map.">
        {v.lore.map((l) => (
          <li key={l.id}>
            {renderChip(l)}
            <p className="sb-quote">{plainText(String(l.data?.text ?? ""))}</p>
          </li>
        ))}
      </SheetSection>

      <SheetSection title="Boss" n={boss ? 1 : 0} empty="No boss assigned.">
        {boss && (
          <li>
            {boss.entity ? renderChip(boss.entity) : <span className="sb-dangling">{boss.id} (no such enemy)</span>}
            <span className="sb-win">boss at {boss.minS ?? "?"}s</span>
          </li>
        )}
      </SheetSection>

      <SheetSection title="Roster (enemies & spawn windows)" n={roster.length}>
        {roster.map((en, i) => (
          <li key={`${i}:${en.id}`}>
            {en.entity ? renderChip(en.entity) : <span className="sb-dangling">{en.id} (no such enemy)</span>}
            <span className="sb-win">{fmtWindow(en.minS, en.maxS)}</span>
          </li>
        ))}
      </SheetSection>

      <SheetSection title="Containers" n={containers.length} empty="No containers defined.">
        {containers.map((c, i) => (
          <li key={`${c.id || i}`} className="sb-container-row">
            <strong>{c.name}</strong>
            {c.weight != null && <span className="sb-win">wt {c.weight}</span>}
            <div className="sb-chip-row">
              {c.rows.map((r, j) => {
                const it = idx.get("item", r.item_id);
                return it ? <span key={`${j}:${r.item_id}`}>{renderChip(it)}</span> : <span key={`${j}:${r.item_id}`} className="sb-dangling">{r.item_id}</span>;
              })}
            </div>
          </li>
        ))}
      </SheetSection>

      <SheetSection title="Quests" n={v.quests.length}>
        {v.quests.map((q) => (
          <li key={q.id}>{renderChip(q, `${idx.get("trader", String(q.data?.trader ?? ""))?.display ?? q.data?.trader ?? ""} #${q.data?.index ?? ""} ${cleanTodo(q.display)}`)}</li>
        ))}
      </SheetSection>

      <SheetSection title="Contracts" n={v.contracts.length}>
        {v.contracts.map((c) => <li key={c.id}>{renderChip(c)}</li>)}
      </SheetSection>

      <SheetSection title="Text lines" n={v.lines.length}>
        {v.lines.map((l) => <LineRow key={l.id} line={l} renderChip={renderChip} onReview={onReview} marks={marks} />)}
      </SheetSection>

      <SheetFindings findings={ownFindings} />
    </article>
  );
}

/** Character sheet (Cast tab): voice card, rivals, links, every line (linking to Review), findings. */
export function CharacterSheet({ ch, idx, findings, renderChip, onReview, progress, onProgress, marks }: {
  ch: CharacterView; idx: EntityIndex; findings: SbFinding[]; renderChip: ChipRenderer; onReview: (e: SbEntity) => void;
  progress?: ProgressEntry | null; onProgress?: ProgressOpenHandler; marks?: MarksApi;
}) {
  renderChip = titled(renderChip);
  const d = ch.card?.data ?? {};
  const neverSays = useMemo(() => formatNeverSays(d.neverSays), [d.neverSays]);
  const rivalIds: string[] = Array.isArray(d.rivals) ? d.rivals : Array.isArray(ch.entity?.data?.rivals) ? ch.entity.data.rivals : [];
  const ownFindings = useMemo(() => {
    const out: SbFinding[] = [];
    if (ch.entity) out.push(...entityFindings(ch.entity, findings));
    if (ch.card) out.push(...entityFindings(ch.card, findings));
    return out;
  }, [ch, findings]);
  const linkedTargets = useMemo(() => {
    if (!ch.entity) return [];
    return ch.entity.links
      .filter((l) => l.rel !== "rival")
      .map((l) => ({ rel: l.rel, ent: idx.get(l.kind, l.id), raw: `${l.kind}:${l.id}` }));
  }, [ch.entity, idx]);

  return (
    <article className="sb-sheet" data-testid={`sb-sheet-character-${ch.id}`}>
      <header className="sb-sheet-head">
        <h3>{ch.speaker} <span className="sb-kind">{ch.kind}</span></h3>
        {ch.entity && <span className="sb-mono">{fmtSource(ch.entity.source)}</span>}
      </header>
      {progress && <ProgressBarRow entry={progress} onOpen={onProgress} compact testId={`sb-sheet-progress-${ch.id}`} />}

      {ch.card ? (
        <section className="sb-voice" data-testid="sb-voice-card">
          <h4 className="sb-h">Voice card <span className="sb-mono">{fmtSource(ch.card.source)}</span></h4>
          <dl className="sb-card-meta">
            {d.who && <><dt>Who</dt><dd>{plainText(String(d.who))}</dd></>}
            {d.pronoun && <><dt>Pronoun</dt><dd>{String(d.pronoun)}</dd></>}
            {d.playerWord && <><dt>Calls player</dt><dd>{[d.playerWord, ...(d.callsPlayer ?? [])].join(", ")}</dd></>}
            {neverSays.length > 0 && <><dt>Never says</dt><dd>{neverSays.join(", ")}</dd></>}
            {Array.isArray(d.samples) && d.samples.length > 0 && <><dt>Samples</dt><dd>{d.samples.map((x: unknown) => plainText(String(x))).join(" / ")}</dd></>}
          </dl>
        </section>
      ) : <p className="sb-empty sb-empty-sm">No voice card for {ch.speaker}.</p>}

      {rivalIds.length > 0 && (
        <SheetSection title="Rivals" n={rivalIds.length}>
          {rivalIds.map((rid) => {
            const tr = idx.get("trader", rid);
            return <li key={rid}>{tr ? renderChip(tr) : <span className="sb-dangling">{rid}</span>}</li>;
          })}
        </SheetSection>
      )}

      {linkedTargets.length > 0 && (
        <SheetSection title="Links" n={linkedTargets.length}>
          {linkedTargets.map((lk, i) => (
            <li key={`${lk.rel}:${lk.raw}:${i}`}>
              <span className="sb-rel-name">{lk.rel.replace(/_/g, " ")}</span>
              {lk.ent ? renderChip(lk.ent) : <span className="sb-dangling">{lk.raw}</span>}
            </li>
          ))}
        </SheetSection>
      )}

      <SheetSection title="Lines" n={ch.lines.length}>
        {ch.lines.map((l) => <LineRow key={l.id} line={l} renderChip={renderChip} onReview={onReview} marks={marks} />)}
      </SheetSection>

      <SheetFindings findings={ownFindings} />
    </article>
  );
}

/** Enemy sheet (Cast tab): name + CONTENT_BREADTH look line, missing-description flag, spawns, drops, quests, findings. */
export function EnemySheet({ enemy, idx, findings, renderChip, onReview, progress, onProgress, marks }: {
  enemy: SbEntity; idx: EntityIndex; findings: SbFinding[]; renderChip: ChipRenderer; onReview: (e: SbEntity) => void;
  progress?: ProgressEntry | null; onProgress?: ProgressOpenHandler; marks?: MarksApi;
}) {
  renderChip = titled(renderChip);
  const s = useMemo(() => enemySheetData(enemy, idx, findings), [enemy, idx, findings]);
  const d = enemy.data ?? {};

  return (
    <article className="sb-sheet" data-testid={`sb-sheet-enemy-${enemy.id}`}>
      <header className="sb-sheet-head">
        <h3>{enemy.display} <span className="sb-kind">{d.boss ? "boss enemy" : "enemy"}</span></h3>
        <div className="sb-sheet-meta">
          <span className="sb-tag">HP {d.hp ?? "?"}</span>
          <span className="sb-tag">ATK {d.attack ?? "?"}</span>
          <span className="sb-tag">DEF {d.defense ?? "?"}</span>
          {d.xp != null && <span className="sb-tag">XP {d.xp}</span>}
          <span className="sb-mono">{fmtSource(enemy.source)}</span>
        </div>
      </header>
      {progress && <ProgressBarRow entry={progress} onOpen={onProgress} compact testId={`sb-sheet-progress-enemy-${enemy.id}`} />}

      <section className="sb-section">
        <h4 className="sb-h">Description &amp; look</h4>
        {s.missingDescription ? (
          <p className="sb-flag-warn" data-testid="sb-enemy-no-desc">Missing description in enemies.json (only name + look line exist).</p>
        ) : (
          <p className="sb-quote">{String(d.description)}</p>
        )}
        {s.look ? (
          <div className="sb-sheet-look">
            <span className="sb-rel-name">CONTENT_BREADTH look</span>
            <p className="sb-quote">{String(s.look.data?.text ?? "")}</p>
          </div>
        ) : <p className="sb-empty sb-empty-sm">No CONTENT_BREADTH look line.</p>}
      </section>

      <SheetSection title="Spawns at" n={s.spawns.length}>
        {s.spawns.map((sp, i) => (
          <li key={`${sp.location.id}:${i}`}>
            {renderChip(sp.location)}
            <span className="sb-win">{sp.boss ? `boss at ${sp.minS ?? "?"}s` : fmtWindow(sp.minS, sp.maxS)}</span>
          </li>
        ))}
      </SheetSection>

      <SheetSection title="Drops" n={s.drops.length}>
        {s.drops.map((it) => <li key={it.id}>{renderChip(it)}</li>)}
      </SheetSection>

      <SheetSection title="Quests &amp; contracts" n={s.quests.length + s.contracts.length}>
        {s.quests.map((q) => <li key={q.id}>{renderChip(q)}</li>)}
        {s.contracts.map((c) => <li key={c.id}>{renderChip(c)}</li>)}
      </SheetSection>

      {s.lines.length > 0 && (
        <SheetSection title="Text lines" n={s.lines.length}>
          {s.lines.map((l) => <LineRow key={l.id} line={l} renderChip={renderChip} onReview={onReview} marks={marks} />)}
        </SheetSection>
      )}

      <SheetFindings findings={s.findings} />
    </article>
  );
}

/** Item sheet (Items tab): description y/n, sources (loot/trader/recipe/node), uses (quests/contracts/recipes/rooms), lines, findings. */
export function ItemSheet({ item, idx, findings, renderChip, onReview, progress, onProgress, marks }: {
  item: SbEntity; idx: EntityIndex; findings: SbFinding[]; renderChip: ChipRenderer; onReview: (e: SbEntity) => void;
  progress?: ProgressEntry | null; onProgress?: ProgressOpenHandler; marks?: MarksApi;
}) {
  renderChip = titled(renderChip);
  const s = useMemo(() => itemSheetData(item, idx, findings), [item, idx, findings]);
  const d = item.data ?? {};

  return (
    <article className="sb-sheet" data-testid={`sb-sheet-item-${item.id}`}>
      <header className="sb-sheet-head">
        <h3>{item.display} <span className="sb-kind">item · {item.id}</span></h3>
        <div className="sb-sheet-meta">
          {d.category && <span className="sb-tag">{String(d.category)}</span>}
          {d.tier != null && <span className="sb-tag">tier {String(d.tier)}</span>}
          {d.base_value != null && <span className="sb-tag">val {String(d.base_value)}</span>}
          <span className={`sb-tag ${s.hasDescription ? "sb-st-owner-ok" : "sb-cat-missing"}`} data-testid="sb-item-desc-yn">
            description: {s.hasDescription ? "yes" : "no"}
          </span>
          {s.isUnobtainable && <span className="sb-tag sb-cat-broken">#13 unobtainable</span>}
          {s.isOrphan && <span className="sb-tag sb-cat-inconsistent">#14 orphan</span>}
          {s.isNoStory && <span className="sb-tag sb-cat-missing">#15 no story</span>}
          <span className="sb-mono">{fmtSource(item.source)}</span>
        </div>
      </header>
      {progress && <ProgressBarRow entry={progress} onOpen={onProgress} compact testId={`sb-sheet-progress-item-${item.id}`} />}

      <section className="sb-section">
        <h4 className="sb-h">Description</h4>
        {s.hasDescription ? <p className="sb-quote">{String(d.description)}</p> : <p className="sb-empty sb-empty-sm">No description in items.json.</p>}
      </section>

      <SheetSection title="Sources (loot, trader stock, recipe, node)" n={s.sources.length} empty="No source found (not in loot, trader stock, recipes, or nodes).">
        {s.sources.map((src, i) => (
          <li key={`${src.kind}:${src.id}:${src.rel}:${i}`}>
            <span className="sb-rel-name">{src.rel.replace(/_/g, " ")}</span>
            {src.entity ? renderChip(src.entity) : <span className="sb-tag">{src.kind}: {src.label}</span>}
          </li>
        ))}
      </SheetSection>

      <SheetSection title="Uses (quests, contracts, recipes, upgrades)" n={s.uses.length} empty="Not used by any quest, contract, recipe, or upgrade.">
        {s.uses.map((u, i) => (
          <li key={`${u.kind}:${u.id}:${u.rel}:${i}`}>
            <span className="sb-rel-name">{u.rel.replace(/_/g, " ")}</span>
            {u.entity ? renderChip(u.entity) : <span className="sb-tag">{u.kind}: {u.label}</span>}
          </li>
        ))}
      </SheetSection>

      {s.lines.length > 0 && (
        <SheetSection title="Text lines" n={s.lines.length}>
          {s.lines.map((l) => <LineRow key={l.id} line={l} renderChip={renderChip} onReview={onReview} marks={marks} />)}
        </SheetSection>
      )}

      <SheetFindings findings={s.findings} />
    </article>
  );
}
