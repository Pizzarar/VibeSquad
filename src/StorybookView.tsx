// Storybook view (SB5, docs/PLAN_STORYBOOK_V1.md). READ-ONLY: quest web per trader chain, per-location, per-character,
// findings list. Data: GET /api/storybook/:project (SB4) in the SB1 snapshot shape. All grouping/filter/Mermaid logic is in storybookLogic.ts.
// Entry: the project ⋯ menu ("Open Storybook", CommandPalette.teamCtxItems) → openStorybook(); App renders this instead of the cockpit.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { MermaidView } from "./MermaidView";
import { rootZoom } from "./pinMenuPlace";
import {
  SB_CATEGORIES, SB_CATEGORY_LABEL, NO_STORYBOOK,
  SB_CATEGORY_HELP, buildListItems, chainToMermaid, checkLabel, plainText, characterViews, countByCategory, entityCard, filterItems, fmtSource, fmtWindow,
  indexEntities, interpretLoad, interpretRefresh, locationView, questChains, shortSha, toggleCategory, cleanTodo,
  type EntityIndex, type LoadState, type SbCategory, type SbEntity, type SbSnapshot, type ListItem,
} from "./storybookLogic";
import "./storybook.css";

// ── open/close store (module-level, like openOverlay) ───────────────────────────
type Target = { projectId: string; name: string } | null;
let target: Target = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
// The open Storybook is mirrored in the URL (?sb=<project>) so reload / a shared link / Back+Forward keep it (UX R18 m8).
const urlProject = (): string | null => (typeof location === "undefined" ? null : new URLSearchParams(location.search).get("sb") || null);
const withSb = (projectId: string | null): string => {
  const p = new URLSearchParams(location.search);
  if (projectId) p.set("sb", projectId); else p.delete("sb");
  const q = p.toString();
  return `${location.pathname}${q ? `?${q}` : ""}${location.hash}`;
};
let pushed = false;
let replaceUntil = 0;
/** After a forward-nav close ("replace"), the next URL sync should replaceState (the stripped entry is reused, so history has no duplicate). */
export function takeStorybookReplace(): boolean {
  const r = Date.now() < replaceUntil;
  replaceUntil = 0;
  return r;
}
export function openStorybook(projectId: string, name?: string): void {
  target = { projectId, name: name || projectId };
  history.pushState({ sb: projectId }, "", withSb(projectId));
  pushed = true;
  emit();
}
/**
 * mode "back" (user Back/Esc): undo our own pushed entry with history.back() while it is still the current entry.
 * mode "replace" (forward navigation: palette/sidebar/Ctrl+J, which push their own entry next): strip ?sb= and our entry state
 * in place, synchronously, never history.back() (it is async and would land after, and undo, the navigation).
 * Re-entry safe: target/pushed are cleared before anything async, so a second call (double Esc / double click) is a no-op.
 */
export function closeStorybook(mode?: unknown): void {
  if (!target) return;
  const replace = mode === "replace"; // anything else (a click event handed in as a handler, undefined) means user Back
  const mine = pushed && Boolean(urlProject()) && history.state?.sb === target.projectId;
  target = null;
  pushed = false;
  if (replace) replaceUntil = Date.now() + 1000;
  if (mine && !replace) history.back(); // popstate finds no ?sb= and target already null: nothing more to do
  else if (urlProject() || history.state?.sb) history.replaceState(null, "", withSb(null));
  emit();
}
if (typeof window !== "undefined") {
  const id0 = urlProject();
  target = id0 ? { projectId: id0, name: id0 } : null; // reload / shared link
  window.addEventListener("popstate", () => {
    const id = urlProject();
    if (!id) { if (target) { target = null; pushed = false; emit(); } }
    else if (target?.projectId !== id) { target = { projectId: id, name: id }; emit(); }
  });
}
export function useStorybookTarget(): Target {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => target, () => null);
}

/** Known-missing probe for the ⋯ menu (UX R18 m6): true once a project is known to have no Storybook (404), so the item can hide. */
const missing = new Map<string, boolean>();
export function probeStorybook(projectId: string): boolean {
  if (!missing.has(projectId)) {
    missing.set(projectId, false);
    // Only a definite 404 means "no Storybook"; network errors / 5xx are forgotten so the next menu build retries.
    void fetch(api(projectId), { method: "HEAD" }).then((r) => { if (r.status === 404) missing.set(projectId, true); else if (!r.ok) missing.delete(projectId); }).catch(() => { missing.delete(projectId); });
  }
  return missing.get(projectId) === true;
}

// ── data ─────────────────────────────────────────────────────────────────────────
const api = (projectId: string) => `/api/storybook/${encodeURIComponent(projectId)}`;
async function call(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, init);
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body };
}

// ── card popover (RefPopover look + placement: same .ref-popover classes, rootZoom clamp, hover desktop / tap coarse) ──
type CardState = { entity: SbEntity; anchor: DOMRect } | null;
const coarse = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

function useCard(idx: EntityIndex) {
  const [card, setCard] = useState<CardState>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const hide = useCallback(() => { clear(); setCard(null); }, []);
  // After a programmatic jump the pointer may sit over whatever lands beneath it: drop any armed hover timer and ignore hover until
  // the pointer really moves (synthetic post-scroll mouse events carry no movement), with a 3s safety release.
  const quietUntil = useRef(0);
  const quiet = useCallback(() => {
    clear();
    quietUntil.current = Date.now() + 3000;
    const release = (e: PointerEvent) => { if (e.movementX || e.movementY) { quietUntil.current = 0; window.removeEventListener("pointermove", release); } };
    window.addEventListener("pointermove", release);
    setTimeout(() => window.removeEventListener("pointermove", release), 3100);
  }, []);
  const show = useCallback((entity: SbEntity, el: Element, delay = 0) => {
    clear();
    if (delay && Date.now() < quietUntil.current) return; // hover left under the pointer after a jump must not open a wrong card
    const anchor = el.getBoundingClientRect();
    if (delay) timer.current = setTimeout(() => setCard({ entity, anchor }), delay);
    else setCard({ entity, anchor });
  }, []);
  const cancel = useCallback(() => clear(), []);
  useEffect(() => clear, []);
  const node = card ? <CardPopover entity={card.entity} anchor={card.anchor} idx={idx} onClose={hide} /> : null;
  return { show, hide, cancel, quiet, node };
}

function CardPopover({ entity, anchor, idx, onClose }: { entity: SbEntity; anchor: DOMRect; idx: EntityIndex; onClose: () => void }) {
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const c = useMemo(() => entityCard(entity, idx), [entity, idx]);
  useLayoutEffect(() => {
    const p = pop.current;
    if (!p) return;
    const z = rootZoom();
    const w = p.offsetWidth, h = p.offsetHeight, vw = window.innerWidth / z, vh = window.innerHeight / z, m = 4;
    const left = Math.max(m, Math.min(anchor.left / z, vw - w - m));
    const below = anchor.bottom / z + m, above = anchor.top / z - m - h;
    setPos({ left, top: below + h <= vh - m ? below : above >= m ? above : Math.max(m, vh - h - m) });
  }, [anchor, entity]);
  useEffect(() => {
    const away = (e: PointerEvent) => { if (pop.current && !pop.current.contains(e.target as Node) && !(e.target as Element).closest?.("[data-sb-card-trigger]")) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    window.addEventListener("scroll", onClose, true);
    return () => { window.removeEventListener("pointerdown", away); window.removeEventListener("keydown", esc); window.removeEventListener("scroll", onClose, true); };
  }, [onClose]);
  return createPortal(
    <div ref={pop} className="ref-popover sb-card" role="dialog" aria-label={`${c.title} details`} data-testid="sb-card"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
      onMouseLeave={() => { if (!coarse()) onClose(); }}>
      <div className="ref-popover-body">
        <div className="ref-popover-title">{c.title} <span className="sb-kind">{c.kindLabel}</span></div>
        {c.text && <div className="ref-popover-text">{c.text}</div>}
        <dl className="sb-card-meta">
          {c.speaker && <><dt>Speaker</dt><dd>{c.speaker}</dd></>}
          {c.area && <><dt>Area</dt><dd>{c.area}</dd></>}
          {c.status && <><dt>Status</dt><dd>{c.status}</dd></>}
          {c.ownerNote && <><dt>Owner note</dt><dd>{c.ownerNote}</dd></>}
          {c.source && <><dt>Source</dt><dd className="sb-mono">{c.source}</dd></>}
        </dl>
      </div>
      {coarse() && <div className="ref-popover-foot"><button type="button" className="btn ghost small sb-btn" onClick={onClose}>Close</button></div>}
    </div>,
    document.body,
  );
}

type CardApi = ReturnType<typeof useCard>;

/** Entity chip: hover/focus (desktop) or tap (touch) opens the card. */
function Chip({ e, card, onGo, label }: { e: SbEntity; card: CardApi; onGo?: () => void; label?: string }) {
  return (
    <button type="button" className={`sb-chip sb-k-${e.kind}`} data-sb-card-trigger data-sb-chip={`${e.kind}\u0000${e.id}`} data-testid={`sb-chip-${e.kind}-${e.id}`}
      onMouseEnter={(ev) => { if (!coarse()) card.show(e, ev.currentTarget, 250); }}
      onMouseLeave={() => { if (!coarse()) card.cancel(); }}
      onFocus={(ev) => { if (!coarse()) card.show(e, ev.currentTarget); }}
      onBlur={(ev) => { if (!coarse() && !(ev.relatedTarget as Element | null)?.closest?.(".sb-card")) card.hide(); }}
      onClick={(ev) => { ev.stopPropagation(); if (onGo && !coarse()) onGo(); else card.show(e, ev.currentTarget); }}>
      {label ?? cleanTodo(e.display)}
    </button>
  );
}

// ── tabs ─────────────────────────────────────────────────────────────────────────
type Tab = "quests" | "locations" | "characters" | "findings";
const TAB_LABEL: Record<Tab, string> = { quests: "Quest web", locations: "Locations", characters: "Characters", findings: "Findings" };

function QuestWeb({ idx, card, sel, setSel }: { idx: EntityIndex; card: CardApi; sel: string | null; setSel: (s: string) => void }) {
  const chains = useMemo(() => questChains(idx), [idx]);
  const chain = chains.find((c) => c.traderId === sel) ?? chains[0];
  const graph = useMemo(() => (chain ? chainToMermaid(chain, idx) : null), [chain, idx]);
  if (!chain || !graph) return <p className="sb-empty">No quest steps in this snapshot.</p>;
  const onGraph = (ev: React.MouseEvent, hover: boolean) => {
    const g = (ev.target as Element).closest?.("[data-node-id]");
    const e = g ? graph.nodes[g.getAttribute("data-node-id") ?? ""] : null;
    if (!g || !e) return;
    if (hover) { if (!coarse()) card.show(e, g, 250); } else card.show(e, g);
  };
  return (
    <div>
      <div className="sb-seg" role="tablist" aria-label="Trader chains">
        {chains.map((c) => (
          <button key={c.traderId} type="button" role="tab" aria-selected={c.traderId === chain.traderId} className="sb-seg-btn" onClick={() => setSel(c.traderId)}>
            {c.trader?.display ?? c.traderId} <span className="sb-count">{c.steps.length}</span>
          </button>
        ))}
      </div>
      <div className="sb-graph" data-testid="sb-quest-graph" data-sb-card-trigger onMouseOver={(e) => onGraph(e, true)} onMouseOut={() => card.cancel()} onClick={(e) => onGraph(e, false)}>
        <MermaidView code={graph.code} />
      </div>
      <h3 className="sb-h">Steps</h3>
      <ol className="sb-steps">
        {chain.steps.map((s) => (
          <li key={s.id} className="sb-step">
            <Chip e={s} card={card} label={`${s.data?.index ?? ""}. ${cleanTodo(s.display)}`} />
            {s.links.filter((l) => l.rel !== "trader").map((l) => { const t = idx.get(l.kind, l.id); return t ? <span key={`${l.rel}\u0000${l.kind}\u0000${l.id}`} className="sb-rel"><span className="sb-rel-name">{l.rel.replace(/_/g, " ")}</span><Chip e={t} card={card} /></span> : null; })}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Locations({ idx, card, sel, setSel }: { idx: EntityIndex; card: CardApi; sel: string | null; setSel: (s: string) => void }) {
  const locs = useMemo(() => idx.byKind("location"), [idx]);
  const loc = locs.find((l) => l.id === sel) ?? locs[0];
  const v = useMemo(() => (loc ? locationView(loc, idx) : null), [loc, idx]);
  if (!loc || !v) return <p className="sb-empty">No locations in this snapshot.</p>;
  return (
    <div>
      <div className="sb-seg" role="tablist" aria-label="Locations">
        {locs.map((l) => <button key={l.id} type="button" role="tab" aria-selected={l.id === loc.id} className="sb-seg-btn" onClick={() => setSel(l.id)}>{l.display}</button>)}
      </div>
      <p className="sb-sub"><Chip e={loc} card={card} label="Location card" /> <span className="sb-mono">{fmtSource(loc.source)}</span></p>
      <Section title="Quests" n={v.quests.length}>{v.quests.map((q) => <li key={q.id}><Chip e={q} card={card} label={`${idx.get("trader", String(q.data?.trader ?? ""))?.display ?? q.data?.trader ?? ""} #${q.data?.index ?? ""} ${cleanTodo(q.display)}`} /></li>)}</Section>
      <Section title="Enemies & spawn windows" n={v.enemies.length}>
        {v.enemies.map((en, i) => (
          <li key={`${i}:${en.id}${en.boss ? "b" : ""}`}>
            {en.entity ? <Chip e={en.entity} card={card} /> : <span className="sb-dangling">{en.id} (no such enemy)</span>}
            <span className="sb-win">{en.boss ? `boss at ${en.minS ?? "?"}s` : fmtWindow(en.minS, en.maxS)}</span>
          </li>
        ))}
      </Section>
      <Section title="Contracts" n={v.contracts.length}>{v.contracts.map((c) => <li key={c.id}><Chip e={c} card={card} /></li>)}</Section>
      <Section title="Lore" n={v.lore.length + v.lines.length}>
        {v.lore.map((l) => <li key={l.id}><Chip e={l} card={card} /><p className="sb-quote">{plainText(String(l.data?.text ?? ""))}</p></li>)}
        {v.lines.map((l) => <li key={l.id}><Chip e={l} card={card} label="Line" /><p className="sb-quote">{String(l.data?.text ?? l.display)}</p></li>)}
      </Section>
    </div>
  );
}

function Section({ title, n, children }: { title: string; n: number; children: React.ReactNode }) {
  return (
    <section className="sb-section">
      <h3 className="sb-h">{title} <span className="sb-count">{n}</span></h3>
      {n ? <ul className="sb-list">{children}</ul> : <p className="sb-empty">None.</p>}
    </section>
  );
}

function Characters({ idx, card, sel, setSel }: { idx: EntityIndex; card: CardApi; sel: string | null; setSel: (s: string) => void }) {
  const chars = useMemo(() => characterViews(idx), [idx]);
  const ch = chars.find((c) => c.id === sel) ?? chars[0];
  if (!ch) return <p className="sb-empty">No speakers in this snapshot.</p>;
  const d = ch.card?.data ?? {};
  return (
    <div>
      <div className="sb-seg" role="tablist" aria-label="Characters">
        {chars.map((c) => <button key={c.id} type="button" role="tab" aria-selected={c.id === ch.id} className="sb-seg-btn" onClick={() => setSel(c.id)}>{c.speaker}{c.lines.length > 0 && <span className="sb-count">{c.lines.length}</span>}</button>)}
      </div>
      {ch.card ? (
        <section className="sb-voice" data-testid="sb-voice-card">
          <h3 className="sb-h">Voice card <span className="sb-mono">{fmtSource(ch.card.source)}</span></h3>
          <dl className="sb-card-meta">
            {d.who && <><dt>Who</dt><dd>{plainText(String(d.who))}</dd></>}
            {d.pronoun && <><dt>Pronoun</dt><dd>{String(d.pronoun)}</dd></>}
            {d.playerWord && <><dt>Calls player</dt><dd>{[d.playerWord, ...(d.callsPlayer ?? [])].join(", ")}</dd></>}
            {Array.isArray(d.neverSays) && d.neverSays.length > 0 && <><dt>Never says</dt><dd>{d.neverSays.join(", ")}</dd></>}
            {Array.isArray(d.rivals) && d.rivals.length > 0 && <><dt>Rivals</dt><dd>{d.rivals.join(", ")}</dd></>}
            {Array.isArray(d.samples) && d.samples.length > 0 && <><dt>Samples</dt><dd>{d.samples.map((x: unknown) => plainText(String(x))).join(" / ")}</dd></>}
          </dl>
        </section>
      ) : <p className="sb-empty">No voice card for {ch.speaker}.</p>}
      <Section title="Lines" n={ch.lines.length}>
        {ch.lines.map((l) => (
          <li key={l.id}>
            <Chip e={l} card={card} label={String(l.data?.origin ?? "line")} />
            {typeof l.data?.status === "string" && l.data.status && <span className={`sb-status sb-st-${String(l.data.status).toLowerCase().replace(/[^a-z]+/g, "-")}`}>{l.data.status}</span>}
            <p className="sb-quote">{String(l.data?.text ?? l.display)}</p>
          </li>
        ))}
      </Section>
    </div>
  );
}

function Findings({ items, idx, card, active, setActive, goTo }: { items: ListItem[]; idx: EntityIndex; card: CardApi; active: ReadonlySet<SbCategory>; setActive: (s: Set<SbCategory>) => void; goTo: (e: SbEntity) => void }) {
  const counts = useMemo(() => countByCategory(items), [items]);
  const shown = useMemo(() => filterItems(items, active), [items, active]);
  return (
    <div>
      <div className="sb-filter" role="group" aria-label="Filter findings" data-testid="sb-filter">
        {SB_CATEGORIES.map((c) => (
          <button key={c} type="button" className="sb-fbtn" aria-pressed={active.has(c)} data-testid={`sb-filter-${c}`} title={SB_CATEGORY_HELP[c]} onClick={() => setActive(toggleCategory(active, c))}>
            {SB_CATEGORY_LABEL[c]} <span className="sb-count">{counts[c]}</span>
          </button>
        ))}
        {active.size > 0 && <button type="button" className="sb-fbtn sb-fclear" onClick={() => setActive(new Set())}>Clear</button>}
      </div>
      <dl className="sb-legend" data-testid="sb-legend">
        {SB_CATEGORIES.map((c) => <div key={c}><dt>{SB_CATEGORY_LABEL[c]}</dt><dd>{SB_CATEGORY_HELP[c]}</dd></div>)}
      </dl>
      {shown.length === 0 ? <p className="sb-empty">{items.length === 0 ? "No findings." : "No findings match this filter."}</p> : (
        <ul className="sb-findings" data-testid="sb-findings">
          {shown.map((it) => {
            const ent = it.entityRef ? idx.get(it.entityRef.kind, it.entityRef.id) : null;
            return (
              <li key={it.key} className={`sb-finding sb-sev-${it.severity}`}>
                <div className="sb-finding-top">
                  <span className={`sb-tag sb-cat-${it.category}`}>{SB_CATEGORY_LABEL[it.category]}</span>
                  {it.check && <span className="sb-tag sb-check" title={`Check ${it.check}`}>{checkLabel(it.check)}</span>}
                  <span className="sb-tag">{it.severity}</span>
                </div>
                <p className="sb-finding-msg">{it.msg}</p>
                <div className="sb-finding-foot">
                  {ent ? <button type="button" className="sb-link" data-testid="sb-finding-entity" onClick={() => goTo(ent)}>→ {ent.kind.replace(/_/g, " ")}: {cleanTodo(ent.display)}</button>
                    : it.entityRef ? <span className="sb-dangling">{it.entityRef.kind}:{it.entityRef.id} (not in snapshot)</span> : null}
                  {ent && <Chip e={ent} card={card} label="Open card" />}
                  {it.source && <span className="sb-mono">{fmtSource(it.source)}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── the view ─────────────────────────────────────────────────────────────────────
export function StorybookView({ projectId, name, onClose, initial, needsYou = 0, onNeedsYou }: { projectId: string; name: string; onClose: () => void; initial?: SbSnapshot; needsYou?: number; onNeedsYou?: () => void }) {
  const [state, setState] = useState<LoadState>(initial ? { kind: "ok", snap: initial } : { kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const [jump, setJump] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("quests");
  const [sel, setSelAll] = useState<Record<Tab, string | null>>({ quests: null, locations: null, characters: null, findings: null });
  const [active, setActive] = useState<Set<SbCategory>>(new Set());

  // One request sequence shared by the initial GET and refresh(): only the newest response may write state, and a project
  // change (or unmount) invalidates everything in flight.
  const seq = useRef(0);
  useEffect(() => {
    if (initial) { setState({ kind: "ok", snap: initial }); return; }
    const my = ++seq.current;
    setState({ kind: "loading" });
    setNotice(null);
    setChecked(null);
    call(api(projectId))
      .then((r) => { if (seq.current === my) setState(interpretLoad(r.status, r.body)); })
      .catch((e) => { if (seq.current === my) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }); });
    return () => { seq.current++; };
  }, [projectId, initial]);

  const snap = state.kind === "ok" ? state.snap : null;
  const idx = useMemo(() => indexEntities(snap?.entities ?? []), [snap]);
  const items = useMemo(() => (snap ? buildListItems(snap) : []), [snap]);
  const card = useCard(idx);

  const refresh = async () => {
    const my = ++seq.current;
    setBusy(true);
    setNotice(null);
    try {
      const r = await call(`${api(projectId)}/refresh`, { method: "POST" });
      if (seq.current !== my) return;
      const out = interpretRefresh(r.status, r.body);
      if (out.error) setNotice(out.error);
      else {
        if (out.snap) setState({ kind: "ok", snap: out.snap });
        else {
          const g = await call(api(projectId));
          if (seq.current !== my) return;
          setState(interpretLoad(g.status, g.body));
        }
        setNotice(out.notice);
        setChecked(out.status);
      }
    } catch (e) {
      if (seq.current === my) setNotice(`Refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (seq.current === my) setBusy(false);
    }
  };

  const pick = (t: Tab) => (s: string) => setSelAll((o) => ({ ...o, [t]: s }));
  // Finding → its entity: open the view that shows it; kinds with no dedicated view get the card.
  const goTo = (e: SbEntity) => {
    card.quiet();
    if (e.kind === "location") { pick("locations")(e.id); setTab("locations"); }
    else if (e.kind === "quest_step") { pick("quests")(String(e.data?.trader ?? e.id)); setTab("quests"); setJump(`${e.kind}\u0000${e.id}`); }
    else if (e.kind === "line" || e.kind === "trader" || e.kind === "squad" || e.kind === "voice_card") {
      const sp = e.kind === "line" ? (e.links.find((l) => l.rel === "spoken_by")?.id ?? String(e.data?.speaker ?? "")) : e.id;
      pick("characters")(sp.toLowerCase()); setTab("characters");
    } else {
      const el = [...document.querySelectorAll("[data-sb-chip]")].find((n) => n.getAttribute("data-sb-chip") === `${e.kind}\u0000${e.id}`); // attribute compare, not a selector built from the id
      if (el) card.show(e, el);
    }
  };

  // Esc = Back (UX R19 M3). Capture phase + preventDefault so App's Esc → Squads Home handler skips it; an open card takes Esc first.
  const cardOpen = card.node != null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || cardOpen) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector(".modal-back, [role='dialog']")) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cardOpen, onClose]);

  // Finding → quest step: scroll to the step's chip, focus it (which opens its card) and flash it (UX R18 m9).
  useEffect(() => {
    if (!jump || tab !== "quests") return;
    const el = [...document.querySelectorAll<HTMLElement>(".sb-step [data-sb-chip]")].find((n) => n.getAttribute("data-sb-chip") === jump);
    setJump(null);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.focus({ preventScroll: true });
    el.classList.add("sb-flash");
    setTimeout(() => el.classList.remove("sb-flash"), 1800);
  }, [jump, tab, sel.quests]);

  return (
    <div className="sb-root" data-testid="storybook-view">
      <header className="sb-head">
        <button type="button" className="sb-btn sb-back" data-testid="sb-back" onClick={() => onClose()}>← Back</button>
        <div className="sb-title">
          <span className="sb-eye" aria-hidden="true">◉</span>
          <h2>Storybook <span className="sb-proj">· {name}</span></h2>
        </div>
        <div className="sb-head-right">
          {needsYou > 0 && onNeedsYou && <button type="button" className="sb-btn sb-needs" data-testid="sb-needs-you" onClick={onNeedsYou} title="Leave Storybook and open the top Needs-you item (Ctrl+J)">{needsYou} need{needsYou === 1 ? "s" : ""} you</button>}
          {snap && <span className="sb-sha sb-mono" title={`${snap.ref} @ ${snap.sha} · generated ${snap.generatedAt}`} data-testid="sb-sha">{snap.ref} @ {shortSha(snap.sha)}</span>}
          {checked && <span className="sb-checked" role="status" data-testid="sb-checked">{checked}</span>}
          <button type="button" className="sb-btn" data-testid="sb-refresh" onClick={() => void refresh()} disabled={busy || state.kind === "loading"}>{busy ? "Refreshing…" : "Refresh"}</button>
        </div>
      </header>
      {notice && <div className="sb-notice" role="status" data-testid="sb-notice">{notice}</div>}
      {state.kind === "loading" && <p className="sb-empty">Loading Storybook…</p>}
      {state.kind === "none" && <p className="sb-empty" data-testid="sb-none">{NO_STORYBOOK}. Storybook needs a registered adapter for the project’s repo; ask the squad lead to add one.</p>}
      {state.kind === "error" && <p className="sb-empty sb-err" role="alert">Couldn’t load Storybook: {state.message}</p>}
      {snap && (
        <>
          {snap.warnings.length > 0 && <details className="sb-warn"><summary>{snap.warnings.length} adapter warning{snap.warnings.length === 1 ? "" : "s"}</summary><ul>{snap.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
          <nav className="sb-tabs" role="tablist" aria-label="Storybook views">
            {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className="sb-tab" data-testid={`sb-tab-${t}`} onClick={() => setTab(t)}>
                {TAB_LABEL[t]}{t === "findings" && <span className="sb-count">{items.length}</span>}
              </button>
            ))}
          </nav>
          <main className="sb-body">
            {tab === "quests" && <QuestWeb idx={idx} card={card} sel={sel.quests} setSel={pick("quests")} />}
            {tab === "locations" && <Locations idx={idx} card={card} sel={sel.locations} setSel={pick("locations")} />}
            {tab === "characters" && <Characters idx={idx} card={card} sel={sel.characters} setSel={pick("characters")} />}
            {tab === "findings" && <Findings items={items} idx={idx} card={card} active={active} setActive={setActive} goTo={goTo} />}
          </main>
        </>
      )}
      {card.node}
    </div>
  );
}

/** Mounted by App when a project's Storybook is open. */
export function StorybookHost({ needsYou, onNeedsYou, projectName }: { needsYou?: number; onNeedsYou?: () => void; projectName?: (id: string) => string | undefined }) {
  const t = useStorybookTarget();
  if (!t) return null;
  return <StorybookView key={t.projectId} projectId={t.projectId} name={projectName?.(t.projectId) ?? t.name} onClose={() => closeStorybook()} needsYou={needsYou} onNeedsYou={onNeedsYou} />;
}
