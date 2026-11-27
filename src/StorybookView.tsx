// Storybook view (SB5, docs/PLAN_STORYBOOK_V1.md). READ-ONLY: quest web per trader chain, per-location, per-character,
// findings list. Data: GET /api/storybook/:project (SB4) in the SB1 snapshot shape. All grouping/filter/Mermaid logic is in storybookLogic.ts.
// Entry: the Code | Storybook tabs, the "Open Storybook: <project>" palette command, the phone ⋯ entry → openStorybook(); App renders this instead of the cockpit.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { MermaidView } from "./MermaidView";
import { rootZoom } from "./pinMenuPlace";
import {
  SB_CATEGORIES, SB_CATEGORY_LABEL, NO_STORYBOOK,
  SB_CATEGORY_HELP, signalCard, buildListItems, chainToMermaid, checkLabel, characterViews, groupCharacterViews, countByCategory, entityCard, entityNavTarget, filterItems, fmtSource,
  FINDING_SCOPE_HELP, FINDING_SCOPE_LABEL, effectiveScope, problemCount, scopeCounts, scopeItems, type FindingScope,
  entityKey, indexEntities, auditCounts, buildTextChanges, type SbChanges, interpretLoad, interpretRefresh, questChains, shortSha, toggleCategory, cleanTodo,
  type EntityIndex, type LoadState, type SbCategory, type SbEntity, type SbFinding, type SbSnapshot, type ListItem,
} from "./storybookLogic";
import { ProjectTabs } from "./ProjectTabs";
import { StorybookHome } from "./StorybookHome";
import type { TextChanges, TextPreset } from "./StorybookText";
import { StorybookText, type TextFocus } from "./StorybookText";
import { buildReviewRows } from "./storybookReview";
import { StorybookArc } from "./StorybookArc";
import { MarkBatch, MarkButtons, MarksBar, useMarks, type MarksApi } from "./StorybookMarks";
import { StorybookItems } from "./StorybookItems";
import { StorybookGlossary } from "./StorybookGlossary";
import { CharacterSheet, EnemySheet, MapSheet, type ChipRenderer } from "./StorybookSheet";
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
let popped = false; // U2: the open Storybook is a ?sb= entry Back/Forward landed on (not openStorybook's push, not a cold link)
let replaceUntil = 0;
let backUntil = 0; // U1 r2: a close's history.back() is in flight until its popstate (bounded, in case it never arrives)
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
  popped = false;
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
  const mine = Boolean(urlProject()) && ((pushed && history.state?.sb === target.projectId) || popped);
  target = null;
  pushed = false;
  popped = false;
  if (replace) replaceUntil = Date.now() + 1000;
  if (mine && !replace) { backUntil = Date.now() + 1000; history.back(); } // popstate finds no ?sb= and target already null: nothing more to do
  else if (urlProject() || history.state?.sb) history.replaceState(null, "", withSb(null));
  emit();
}
if (typeof window !== "undefined") {
  const id0 = urlProject();
  target = id0 ? { projectId: id0, name: id0 } : null; // reload / shared link
  window.addEventListener("popstate", () => {
    backUntil = 0;
    const id = urlProject();
    if (!id) { if (target) { target = null; pushed = false; popped = false; emit(); } return; }
    // U2 (idea-971): a ?sb= entry reached by Back/Forward is one of this session's entries, so Esc / Close on it goes Back, as right after
    // opening. Stripping ?sb= in place (the cold-link close) could leave two identical entries side by side: a dead Back press.
    popped = true;
    if (target?.projectId !== id) { target = { projectId: id, name: id }; emit(); }
  });
}
/** Live value (module state) for effects that run in the commit that opened / closed the takeover (App's URL sync). */
export const getStorybookTarget = (): Target => target;
/** U1 r2: true between a close's history.back() and its popstate. BoringApp remounts (target already null) before the pop lands, and
 * the URL still names the Storybook entry: App's URL sync must not write until the pop re-lands the screen (B1 then replaces). */
export const storybookBackInFlight = (): boolean => Date.now() < backUntil;
export function useStorybookTarget(): Target {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => target, () => null);
}

/** One shared probe status per project behind the ⋯ menu, the topbar tabs and the phone drawer:
 *  unknown = not fetched yet; present = HEAD 2xx; missing = HEAD 404. Non-2xx / network errors clear the entry so the next read retries. */
const probe = new Map<string, "unknown" | "present" | "missing">();
const probeFailed = new Set<string>();
const probeReprobeAt = new Map<string, number>();
const PROBE_REPROBE_MS = 5000;
// A probe can resolve after the ⋯ menu / phone drawer first reads it (slow host): notify subscribers so consumers re-render
// (same subscribe/notify shape as the `target` store above).
const probeSubs = new Set<() => void>();
const subscribeProbe = (cb: () => void) => { probeSubs.add(cb); return () => { probeSubs.delete(cb); }; };
const probeEmit = () => probeSubs.forEach((f) => f());
/** Known-missing probe (UX R18 m6): true once a project is known to have no Storybook (404), so the ⋯ menu can hide. */
export function probeStorybook(projectId: string): boolean {
  if (!probe.has(projectId)) {
    probe.set(projectId, "unknown");
    // Only a definite 404 means "no Storybook"; a 2xx means present; network errors / 5xx are forgotten so the next read retries.
    void fetch(api(projectId), { method: "HEAD" }).then((r) => {
      if (r.status === 404) { probe.set(projectId, "missing"); probeEmit(); }
      else if (r.ok) { probe.set(projectId, "present"); probeEmit(); }
      else { probeFailed.add(projectId); probeReprobeAt.set(projectId, Date.now()); probe.delete(projectId); probeEmit(); }
      if (probe.has(projectId)) { probeFailed.delete(projectId); probeReprobeAt.delete(projectId); }
    }).catch(() => { probeFailed.add(projectId); probeReprobeAt.set(projectId, Date.now()); probe.delete(projectId); probeEmit(); });
  }
  return probe.get(projectId) === "missing";
}

/** Pure cache read (no fetch): true once a project is known to have no Storybook (404). */
export function isStorybookMissing(projectId: string): boolean {
  return probe.get(projectId) === "missing";
}

function reprobeStorybook(projectId: string): void {
  if (probe.has(projectId) || !probeFailed.has(projectId)) return;
  const now = Date.now();
  if (now - (probeReprobeAt.get(projectId) ?? -Infinity) < PROBE_REPROBE_MS) return;
  probeReprobeAt.set(projectId, now);
  probeStorybook(projectId);
}

/** Probe a project if never probed, or re-probe through the 5s throttle if a prior probe failed. Call from effects only. */
export function ensureStorybookProbe(projectId: string): void {
  if (probe.has(projectId)) return;
  if (probeFailed.has(projectId)) reprobeStorybook(projectId);
  else probeStorybook(projectId);
}

/** Subscribe to probe store updates and trigger throttled probes for a list of projects in an effect. */
export function useStorybookProbes(projectIds: readonly string[], active = true): number {
  const [rev, setRev] = useState(0);
  useEffect(() => subscribeProbe(() => setRev((n) => n + 1)), []);
  const key = projectIds.join("\n");
  useEffect(() => {
    if (!active || !key) return;
    for (const id of key.split("\n")) ensureStorybookProbe(id);
  }, [active, key]);
  return rev;
}

function useStorybookProbe(projectId: string | null): void {
  useEffect(() => {
    if (!projectId) return;
    probeStorybook(projectId);
    const onFocus = () => reprobeStorybook(projectId);
    const onVis = () => { if (document.visibilityState === "visible") reprobeStorybook(projectId); };
    if (typeof window !== "undefined") window.addEventListener("focus", onFocus);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
    return () => {
      if (typeof window !== "undefined") window.removeEventListener("focus", onFocus);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
    };
  }, [projectId]);
}

/** Subscribe to the known-missing probe and re-render when it resolves (useStorybookTarget pattern). */
export function useStorybookMissing(projectId: string | null): boolean {
  const isMissing = useSyncExternalStore(
    subscribeProbe,
    () => (projectId ? probe.get(projectId) === "missing" : false),
    () => false,
  );
  useStorybookProbe(projectId);
  return isMissing;
}

/** True only once a project is KNOWN to have a Storybook (HEAD 2xx) — never optimistic, so the topbar tabs
 *  don't flicker for projects that have none. Built on the same probe store/emitter as useStorybookMissing. */
export function useStorybookPresent(projectId: string | null): boolean {
  const isPresent = useSyncExternalStore(
    subscribeProbe,
    () => (projectId ? probe.get(projectId) === "present" : false),
    () => false,
  );
  useStorybookProbe(projectId);
  return isPresent;
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

function useCard(idx: EntityIndex, onGo?: (e: SbEntity) => void) {
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
  const node = card ? <CardPopover entity={card.entity} anchor={card.anchor} idx={idx} onClose={hide} onGo={onGo} /> : null;
  return { show, hide, cancel, quiet, node };
}

function CardPopover({ entity, anchor, idx, onClose, onGo }: { entity: SbEntity; anchor: DOMRect; idx: EntityIndex; onClose: () => void; onGo?: (e: SbEntity) => void }) {
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const c = useMemo(() => entityCard(entity, idx), [entity, idx]);
  const canNav = Boolean(onGo && entityNavTarget(entity));
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
      {(canNav || coarse()) && (
        <div className="ref-popover-foot">
          {canNav && <button type="button" className="btn ghost small sb-btn" data-testid="sb-card-open-sheet" onClick={() => { onClose(); onGo?.(entity); }}>Open sheet →</button>}
          {coarse() && <button type="button" className="btn ghost small sb-btn" onClick={onClose}>Close</button>}
        </div>
      )}
    </div>,
    document.body,
  );
}

type CardApi = ReturnType<typeof useCard>;

/** Entity chip: hover/focus (desktop) previews the card; click navigates to the entity's sheet (or opens card if no sheet). */
function Chip({ e, card, onGo, label }: { e: SbEntity; card: CardApi; onGo?: (e: SbEntity) => void; label?: string }) {
  const canGo = Boolean(onGo && entityNavTarget(e));
  return (
    <button type="button" className={`sb-chip sb-k-${e.kind}`} data-sb-card-trigger data-sb-chip={`${e.kind}\u0000${e.id}`} data-testid={`sb-chip-${e.kind}-${e.id}`}
      onMouseEnter={(ev) => { if (!coarse()) card.show(e, ev.currentTarget, 250); }}
      onMouseLeave={() => { if (!coarse()) card.cancel(); }}
      onFocus={(ev) => { if (!coarse()) card.show(e, ev.currentTarget); }}
      onBlur={(ev) => { if (!coarse() && !(ev.relatedTarget as Element | null)?.closest?.(".sb-card")) card.hide(); }}
      onClick={(ev) => { ev.stopPropagation(); if (canGo && onGo) { card.hide(); onGo(e); } else card.show(e, ev.currentTarget); }}>
      {label ?? cleanTodo(e.display)}
    </button>
  );
}

// ── tabs ─────────────────────────────────────────────────────────────────────────
// Tab registry: fixed slots in nav order. A slot with `built: false` is hidden, so V3/V6 (Review), V4 (Items) and V10 (Glossary) each
// flip one entry and add one render case instead of re-editing the nav.
type Tab = "home" | "review" | "quests" | "world" | "cast" | "items" | "problems" | "glossary";
const TABS: { id: Tab; label: string; built: boolean }[] = [
  { id: "home", label: "Home", built: true },
  { id: "review", label: "Review", built: true }, // hosts "Text to review" until V3/V6 fill it
  { id: "quests", label: "Quests", built: true }, // Quest web now; arcs + play order land here (V5)
  { id: "world", label: "World", built: true }, // maps (Locations)
  { id: "cast", label: "Cast", built: true }, // characters + enemies
  { id: "items", label: "Items", built: true }, // V4
  { id: "problems", label: "Problems", built: true },
  { id: "glossary", label: "Glossary", built: true }, // V10
];
const NO_SEL: Record<Tab, string | null> = { home: null, review: null, quests: null, world: null, cast: null, items: null, problems: null, glossary: null };

function QuestWeb({ idx, card, sel, setSel, onGo }: { idx: EntityIndex; card: CardApi; sel: string | null; setSel: (s: string) => void; onGo: (e: SbEntity) => void }) {
  const chains = useMemo(() => questChains(idx), [idx]);
  const chain = chains.find((c) => c.traderId === sel) ?? chains[0];
  const graph = useMemo(() => (chain ? chainToMermaid(chain, idx) : null), [chain, idx]);
  if (!chain || !graph) return <p className="sb-empty">No quest steps in this snapshot.</p>;
  const onGraph = (ev: React.MouseEvent, hover: boolean) => {
    const g = (ev.target as Element).closest?.("[data-node-id]");
    const e = g ? graph.nodes[g.getAttribute("data-node-id") ?? ""] : null;
    if (!g || !e) return;
    if (hover) { if (!coarse()) card.show(e, g, 250); }
    else if (entityNavTarget(e)) { card.hide(); onGo(e); }
    else card.show(e, g);
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
            <Chip e={s} card={card} onGo={onGo} label={`${s.data?.index ?? ""}. ${cleanTodo(s.display)}`} />
            {s.links.filter((l) => l.rel !== "trader").map((l) => { const t = idx.get(l.kind, l.id); return t ? <span key={`${l.rel}\u0000${l.kind}\u0000${l.id}`} className="sb-rel"><span className="sb-rel-name">{l.rel.replace(/_/g, " ")}</span><Chip e={t} card={card} onGo={onGo} /></span> : null; })}
          </li>
        ))}
      </ol>
    </div>
  );
}

type QuestMode = "web" | "arcs" | "order";
const QUEST_MODES: [QuestMode, string][] = [["arcs", "Story arcs"], ["order", "Play order"], ["web", "Quest web"]];
function QuestsTab({ snap, idx, card, sel, setSel, onGo, openLine, renderChip, marks }: { snap: SbSnapshot; idx: EntityIndex; card: CardApi; sel: string | null; setSel: (s: string) => void; onGo: (e: SbEntity) => void; openLine: (e: SbEntity) => void; renderChip: ChipRenderer; marks?: MarksApi }) {
  const [mode, setMode] = useState<QuestMode>("arcs");
  const chip = renderChip;
  return (
    <div>
      <div className="sb-seg" role="tablist" aria-label="Quest views">
        {QUEST_MODES.map(([m, l]) => <button key={m} type="button" role="tab" aria-selected={mode === m} className="sb-seg-btn" onClick={() => setMode(m)}>{l}</button>)}
      </div>
      {mode === "web" ? <QuestWeb idx={idx} card={card} sel={sel} setSel={setSel} onGo={onGo} /> : <StorybookArc arc={snap.arc} idx={idx} chip={chip} openLine={openLine} mode={mode}
        actions={marks ? (l) => <MarkButtons e={l} m={marks} /> : undefined} batch={marks ? (ls, label) => <MarkBatch entities={ls} label={label} m={marks} /> : undefined} />}
      {marks && mode === "arcs" && <MarksBar m={marks} />}
    </div>
  );
}

function Locations({ idx, findings, sel, setSel, renderChip, onReview }: {
  idx: EntityIndex; findings: SbFinding[]; sel: string | null; setSel: (s: string) => void; renderChip: ChipRenderer; onReview: (e: SbEntity) => void;
}) {
  const locs = useMemo(() => idx.byKind("location"), [idx]);
  const loc = locs.find((l) => l.id === sel) ?? locs[0];
  if (!loc) return <p className="sb-empty">No locations in this snapshot.</p>;
  return (
    <div>
      <div className="sb-seg" role="tablist" aria-label="Locations">
        {locs.map((l) => <button key={l.id} type="button" role="tab" aria-selected={l.id === loc.id} className="sb-seg-btn" onClick={() => setSel(l.id)}>{l.display}</button>)}
      </div>
      <MapSheet loc={loc} idx={idx} findings={findings} renderChip={renderChip} onReview={onReview} />
    </div>
  );
}

function Characters({ idx, findings, sel, setSel, renderChip, onReview }: {
  idx: EntityIndex; findings: SbFinding[]; sel: string | null; setSel: (s: string) => void; renderChip: ChipRenderer; onReview: (e: SbEntity) => void;
}) {
  const chars = useMemo(() => characterViews(idx), [idx]);
  const grouped = useMemo(() => groupCharacterViews(chars), [chars]);
  const ordered = useMemo(() => [...grouped.traders, ...grouped.squad, ...grouped.screens], [grouped]);
  const enemies = useMemo(() => idx.byKind("enemy").sort((a, b) => a.display.localeCompare(b.display)), [idx]);
  const isEnemySel = Boolean(sel && sel.startsWith("enemy:"));
  const [group, setGroup] = useState<"characters" | "enemies">(isEnemySel ? "enemies" : "characters");
  const [screensOpen, setScreensOpen] = useState(false);
  const [scrollTick, setScrollTick] = useState(0);
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (sel?.startsWith("enemy:")) setGroup("enemies");
    else if (sel) setGroup("characters");
  }, [sel]);
  const enemy = isEnemySel ? enemies.find((e) => `enemy:${e.id.toLowerCase()}` === sel) ?? enemies[0] : enemies[0];
  const ch = !isEnemySel ? ordered.find((c) => c.id === sel) ?? ordered[0] : ordered[0];
  const chInScreens = Boolean(ch && grouped.screens.some((s) => s.id === ch.id));
  useEffect(() => {
    if (chInScreens) setScreensOpen(true);
  }, [chInScreens]);
  useEffect(() => {
    if (!scrollTick) return;
    const el = sheetRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.top > window.innerHeight * 0.6) el.scrollIntoView({ block: "start" });
  }, [scrollTick]);
  const pickCast = (id: string) => { setSel(id); setScrollTick((n) => n + 1); };
  if (!chars.length && !enemies.length) return <p className="sb-empty">No characters or enemies in this snapshot.</p>;
  const chipBtn = (c: typeof chars[number]) => (
    <button key={c.id} type="button" role="tab" aria-selected={c.id === ch?.id} className="sb-seg-btn" onClick={() => pickCast(c.id)}>
      {c.speaker}{c.lines.length > 0 && <span className="sb-count">{c.lines.length}</span>}
    </button>
  );
  return (
    <div>
      <div className="sb-seg" role="group" aria-label="Cast group" data-testid="sb-cast-group">
        <button type="button" className="sb-seg-btn" aria-pressed={group === "characters"} data-testid="sb-cast-characters" onClick={() => { setGroup("characters"); if (ch) setSel(ch.id); }}>
          Characters <span className="sb-count">{chars.length}</span>
        </button>
        <button type="button" className="sb-seg-btn" aria-pressed={group === "enemies"} data-testid="sb-cast-enemies" onClick={() => { setGroup("enemies"); if (enemy) setSel(`enemy:${enemy.id.toLowerCase()}`); }}>
          Enemies <span className="sb-count">{enemies.length}</span>
        </button>
      </div>
      {group === "enemies" ? (
        enemies.length === 0 ? <p className="sb-empty">No enemies in this snapshot.</p> : (
          <>
            <div className="sb-seg" role="tablist" aria-label="Enemies">
              {enemies.map((e) => {
                const key = `enemy:${e.id.toLowerCase()}`;
                return <button key={key} type="button" role="tab" aria-selected={enemy?.id === e.id} className="sb-seg-btn" onClick={() => pickCast(key)}>{e.display}{e.data?.boss ? " ★" : ""}</button>;
              })}
            </div>
            <div ref={sheetRef} className="sb-cast-sheet" data-testid="sb-cast-sheet">
              {enemy && <EnemySheet enemy={enemy} idx={idx} findings={findings} renderChip={renderChip} onReview={onReview} />}
            </div>
          </>
        )
      ) : (
        chars.length === 0 ? <p className="sb-empty">No speakers in this snapshot.</p> : (
          <>
            {grouped.traders.length > 0 && (
              <div className="sb-cast-sec" data-testid="sb-cast-traders">
                <h4 className="sb-cast-lbl">Traders <span className="sb-count">{grouped.traders.length}</span></h4>
                <div className="sb-seg" role="tablist" aria-label="Traders">{grouped.traders.map(chipBtn)}</div>
              </div>
            )}
            {grouped.squad.length > 0 && (
              <div className="sb-cast-sec" data-testid="sb-cast-squad">
                <h4 className="sb-cast-lbl">Squad <span className="sb-count">{grouped.squad.length}</span></h4>
                <div className="sb-seg" role="tablist" aria-label="Squad">{grouped.squad.map(chipBtn)}</div>
              </div>
            )}
            {grouped.screens.length > 0 && (
              <details className="sb-cast-screens" data-testid="sb-cast-screens" open={screensOpen} onToggle={(ev) => setScreensOpen(ev.currentTarget.open)}>
                <summary className="sb-cast-lbl">Screens &amp; system <span className="sb-count">{grouped.screens.length}</span></summary>
                <div className="sb-seg" role="tablist" aria-label="Screens and system">{grouped.screens.map(chipBtn)}</div>
              </details>
            )}
            <div ref={sheetRef} className="sb-cast-sheet" data-testid="sb-cast-sheet">
              {ch && <CharacterSheet ch={ch} idx={idx} findings={findings} renderChip={renderChip} onReview={onReview} />}
            </div>
          </>
        )
      )}
    </div>
  );
}

const PAGE = 200; // the text inventory is thousands of rows; render a page at a time

function Findings({ items: allItems, idx, card, active, setActive, scope: scopeIn, setScope, scopes: allowed, goTo, checks = null, clearChecks }: { checks?: ReadonlySet<string> | null; clearChecks?: () => void; items: ListItem[]; idx: EntityIndex; card: CardApi; active: ReadonlySet<SbCategory>; setActive: (s: Set<SbCategory>) => void; scope: FindingScope; setScope: (s: FindingScope) => void; scopes: FindingScope[]; goTo: (e: SbEntity) => void }) {
  const scope = effectiveScope(scopeIn, checks);
  const items = allItems;
  const scoped = useMemo(() => scopeItems(items, scope).filter((it) => !checks || (it.check != null && checks.has(it.check))), [items, scope, checks]);
  const scopes = useMemo(() => scopeCounts(items), [items]);
  const counts = useMemo(() => countByCategory(scoped), [scoped]);
  const filtered = useMemo(() => filterItems(scoped, active), [scoped, active]);
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [scope, active, items]);
  const shown = useMemo(() => filtered.slice(0, limit), [filtered, limit]);
  const cats = SB_CATEGORIES.filter((c) => counts[c] > 0 || active.has(c));
  return (
    <div>
      {allowed.length > 1 && <div className="sb-seg" role="group" aria-label="Findings scope" data-testid="sb-scope">
        {allowed.filter((s) => s === "problems" || s === "story" || scopes[s] > 0 || scope === s).map((s) => (
          <button key={s} type="button" className="sb-seg-btn" aria-pressed={scope === s} data-testid={`sb-scope-${s}`} title={FINDING_SCOPE_HELP[s]} onClick={() => { setScope(s); setActive(new Set()); clearChecks?.(); }}>
            {FINDING_SCOPE_LABEL[s]} <span className="sb-count">{scopes[s]}</span>
          </button>
        ))}
      </div>}
      <p className="sb-scope-help">{FINDING_SCOPE_HELP[scope]}</p>
      <div className="sb-filter" role="group" aria-label="Filter findings" data-testid="sb-filter">
        {cats.length > 1 && cats.map((c) => (
          <button key={c} type="button" className="sb-fbtn" aria-pressed={active.has(c)} data-testid={`sb-filter-${c}`} title={SB_CATEGORY_HELP[c]} onClick={() => setActive(toggleCategory(active, c))}>
            {SB_CATEGORY_LABEL[c]} <span className="sb-count">{counts[c]}</span>
          </button>
        ))}
        {checks && <button type="button" className="sb-fbtn" aria-pressed="true" data-testid="sb-checks-chip" title="Filtered to the checks behind the Home signal card (click to clear)" onClick={() => clearChecks?.()}>Checks {[...checks].join(" ")} <span className="sb-count">{scoped.length}</span></button>}
        {(active.size > 0 || checks) && <button type="button" className="sb-fbtn sb-fclear" onClick={() => { setActive(new Set()); clearChecks?.(); }}>Clear</button>}
      </div>
      <dl className="sb-legend" data-testid="sb-legend">
        {cats.map((c) => <div key={c}><dt>{SB_CATEGORY_LABEL[c]}</dt><dd>{SB_CATEGORY_HELP[c]}</dd></div>)}
      </dl>
      {shown.length === 0 ? <p className="sb-empty">{items.length === 0 ? "No findings." : scope === "story" && scoped.length === 0 ? "No story issues." : "No findings match this filter."}</p> : (
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
      {filtered.length > shown.length && <button type="button" className="sb-btn sb-more" data-testid="sb-more" onClick={() => setLimit((n) => n + PAGE)}>Show {Math.min(PAGE, filtered.length - shown.length)} more ({filtered.length - shown.length} left)</button>}
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
  const [tab, setTab] = useState<Tab>("home");
  const [sel, setSelAll] = useState<Record<Tab, string | null>>(NO_SEL);
  // Each findings tab keeps its own category filter (a Problems filter must not leak into Review's text rows).
  const [activeProblems, setActiveProblems] = useState<Set<SbCategory>>(new Set());
  const [textFocus, setTextFocus] = useState<TextFocus>(null); // "→ line": the Review row to open, scroll to and flash
  const clearTextFocus = useCallback(() => setTextFocus(null), []);
  const [scope, setScope] = useState<FindingScope>("problems"); // Problems tab: problems | story
  const [checks, setChecks] = useState<ReadonlySet<string> | null>(null); // Home signal card -> Problems filtered to that signal's checks
  const [changes, setChanges] = useState<SbChanges | null>(null); // V8
  const [seenBusy, setSeenBusy] = useState(false);
  const [seenError, setSeenError] = useState<string | null>(null);
  const [preset, setPreset] = useState<TextPreset>(null);

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
  const changesSeq = useRef(0);
  useEffect(() => {
    changesSeq.current++;
    setChanges(null);
    setSeenError(null);
    return () => { changesSeq.current++; };
  }, [projectId, initial]);
  const loadChanges = useCallback(async () => {
    if (initial) return;
    const my = ++changesSeq.current;
    try {
      const r = await call(`${api(projectId)}/changes`);
      if (changesSeq.current !== my) return;
      setChanges(r.status === 200 && r.body && typeof r.body === "object" && r.body.counts ? (r.body as SbChanges) : null);
    } catch { if (changesSeq.current === my) setChanges(null); }
  }, [projectId, initial]);
  const snapSha = snap?.sha;
  useEffect(() => { if (snapSha) void loadChanges(); }, [snapSha, loadChanges]);
  // Explicit only: "I've seen up to sha X". Loading Home never marks anything seen.
  const markSeen = useCallback(async () => {
    if (!snapSha) return;
    setSeenBusy(true); setSeenError(null);
    try {
      const r = await call(`${api(projectId)}/changes/seen`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha: snapSha }) });
      if (r.status !== 200) setSeenError(String(r.body?.error ?? `Could not save (HTTP ${r.status})`));
      else await loadChanges();
    } catch (e) { setSeenError(e instanceof Error ? e.message : String(e)); }
    finally { setSeenBusy(false); }
  }, [projectId, snapSha, loadChanges]);
  const textChanges = useMemo<TextChanges>(() => buildTextChanges(changes), [changes]);
  const idx = useMemo(() => indexEntities(snap?.entities ?? []), [snap]);
  const items = useMemo(() => (snap ? buildListItems(snap) : []), [snap]);
  const problems = useMemo(() => problemCount(items), [items]);
  const pick = useCallback((t: Tab) => (s: string) => setSelAll((o) => ({ ...o, [t]: s })), []);
  const goToRef = useRef<(e: SbEntity) => void>(() => {});
  const card = useCard(idx, (e) => goToRef.current(e));
  const reviewRows = useMemo(() => (snap ? buildReviewRows(snap.entities, idx, items) : []), [snap, idx, items]);
  const marks = useMarks(projectId, idx); // V6 owner marks
  const rowEntity = useCallback((r: { kind: string; entityId: string }) => idx.get(r.kind, r.entityId), [idx]);
  const mineTest = useCallback((r: { kind: string; entityId: string }) => marks.stateOf(rowEntity(r)).kind !== "none", [marks, rowEntity]);

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

  // Open a line/contract's Review queue row directly (V3 "→ line", V5 "Review row →", V4 sheet "→ Review").
  const openReviewRow = useCallback((e: SbEntity) => {
    card.quiet();
    card.hide();
    setTextFocus({ id: entityKey(e.kind, e.id), n: Date.now() });
    setTab("review");
  }, [card]);

  // Entity chip / popover / finding -> its sheet in the right tab (or Review row for lines).
  const goTo = useCallback((e: SbEntity) => {
    card.quiet();
    card.hide();
    const nav = entityNavTarget(e);
    if (nav) {
      if (nav.tab === "review") {
        setTextFocus({ id: entityKey(e.kind, e.id), n: Date.now() });
        setTab("review");
        return;
      }
      if (nav.sel) pick(nav.tab)(nav.sel);
      setTab(nav.tab);
      if (nav.jump) setJump(nav.jump);
      return;
    }
    const el = [...document.querySelectorAll("[data-sb-chip]")].find((n) => n.getAttribute("data-sb-chip") === `${e.kind}\u0000${e.id}`);
    if (el) card.show(e, el);
  }, [card, pick]);
  goToRef.current = goTo;

  const clearTextPreset = useCallback(() => setPreset(null), []);
  const onSignal = useCallback((signal: string) => {
    const nav = signalCard(signal, items, null).target;
    if (nav.tab === "review") {
      setPreset({ only: "unreviewed", n: Date.now() });
      setTab("review");
      return;
    }
    setScope(nav.scope ?? "problems");
    setActiveProblems(new Set());
    setChecks(nav.checks ? new Set(nav.checks) : null);
    setTab("problems");
  }, [items]);

  const renderChip: ChipRenderer = useCallback((e, label) => <Chip e={e} card={card} onGo={goTo} label={label} />, [card, goTo]);

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
    const el = [...document.querySelectorAll<HTMLElement>(".sb-step [data-sb-chip], .sb-arc-step [data-sb-chip]")].find((n) => n.getAttribute("data-sb-chip") === jump);
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
        <button type="button" className="sb-btn sb-back" data-testid="sb-back" aria-label="Back" onClick={() => onClose()}><span className="sb-back-arrow" aria-hidden="true">←</span><span className="sb-back-text" aria-hidden="true"> Back</span></button>
        <div className="sb-title">
          <span className="sb-eye" aria-hidden="true">◉</span>
          <h2><span className="sb-word">Storybook </span><span className="sb-sep" aria-hidden="true">· </span><span className="sb-proj">{name}</span></h2>
        </div>
        <ProjectTabs projectId={projectId} name={name} active="storybook" />
        <div className="sb-head-right">
          {needsYou > 0 && onNeedsYou && <button type="button" className="sb-btn sb-needs" data-testid="sb-needs-you" onClick={onNeedsYou} title="Leave Storybook and open the top Needs-you item (Ctrl+J)">{needsYou} need{needsYou === 1 ? "s" : ""} you</button>}
          {snap && <span className="sb-sha sb-mono" title={`${snap.ref} @ ${snap.sha} · generated ${snap.generatedAt}`} data-testid="sb-sha">{snap.ref} @ {shortSha(snap.sha)}</span>}
          {checked && <span className="sb-checked" role="status" data-testid="sb-checked">{checked}</span>}
          <button type="button" className={`sb-btn sb-refresh${busy ? " sb-busy" : ""}`} data-testid="sb-refresh" aria-label="Refresh" aria-busy={busy} title="Re-snapshot Storybook" onClick={() => void refresh()} disabled={busy || state.kind === "loading"}><span className="sb-refresh-icon" aria-hidden="true">↻</span><span className="sb-refresh-text" aria-hidden="true">{busy ? "Refreshing…" : "Refresh"}</span></button>
        </div>
      </header>
      {checked && <div className="sb-checked sb-checked-row" role="status" data-testid="sb-checked-row">{checked}</div>}
      {notice && <div className="sb-notice" role="status" data-testid="sb-notice">{notice}</div>}
      {state.kind === "loading" && <p className="sb-empty">Loading Storybook…</p>}
      {state.kind === "none" && <p className="sb-empty" data-testid="sb-none">{NO_STORYBOOK}. Storybook needs a registered adapter for the project’s repo; ask the squad lead to add one.</p>}
      {state.kind === "error" && <p className="sb-empty sb-err" role="alert">Couldn’t load Storybook: {state.message}</p>}
      {snap && (
        <>
          {snap.warnings.length > 0 && <details className="sb-warn"><summary>{snap.warnings.length} adapter warning{snap.warnings.length === 1 ? "" : "s"}</summary><ul>{snap.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
          <nav className="sb-tabs" role="tablist" aria-label="Storybook views">
            {TABS.filter((t) => t.built).map(({ id: t, label }) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className="sb-tab" data-testid={`sb-tab-${t}`} onClick={() => setTab(t)}>
                {label}{t === "problems" && <span className="sb-count" data-testid="sb-problem-count" title="Broken references and story issues only; text is under Review, writing gaps under Coverage, drift under Other checks">{problems}</span>}
              </button>
            ))}
          </nav>
          <main className="sb-body">
            {tab === "home" && <StorybookHome snap={snap} items={items} onTab={(t) => setTab(t as Tab)} onFindings={(sc) => { if (sc === "text") { setPreset({ only: "unreviewed", n: Date.now() }); setTab("review"); } else { setScope(sc); setTab("problems"); setActiveProblems(new Set()); setChecks(null); } }} onSignal={onSignal} changes={changes} onChanges={() => { setPreset({ only: "changed", n: Date.now() }); setTab("review"); }} onMarkSeen={() => void markSeen()} seenBusy={seenBusy} seenError={seenError} onContracts={() => { setPreset({ only: "contracts", n: Date.now() }); setTab("review"); }} renderChip={renderChip} />}
            {tab === "review" && <StorybookText rows={reviewRows} idx={idx} changes={textChanges} preset={preset} onPresetConsumed={clearTextPreset} focus={textFocus} onFocusConsumed={clearTextFocus} renderChip={renderChip}
              header={<MarksBar m={marks} />} mineTest={mineTest} renderActions={(r) => <MarkButtons e={rowEntity(r)} m={marks} />}
              renderGroupExtra={(g) => <MarkBatch entities={g.rows.map(rowEntity).filter((x): x is SbEntity => Boolean(x))} label={g.label} m={marks} />} />}
            {tab === "quests" && <QuestsTab snap={snap} idx={idx} card={card} sel={sel.quests} setSel={pick("quests")} onGo={goTo} openLine={openReviewRow} renderChip={renderChip} marks={marks} />}
            {tab === "world" && <Locations idx={idx} findings={snap.findings} sel={sel.world} setSel={pick("world")} renderChip={renderChip} onReview={openReviewRow} />}
            {tab === "cast" && <Characters idx={idx} findings={snap.findings} sel={sel.cast} setSel={pick("cast")} renderChip={renderChip} onReview={openReviewRow} />}
            {tab === "items" && <StorybookItems idx={idx} findings={snap.findings} sel={sel.items} setSel={pick("items")} renderChip={renderChip} onReview={openReviewRow} />}
            {tab === "problems" && <Findings items={items} idx={idx} card={card} active={activeProblems} setActive={setActiveProblems} scope={scope} setScope={setScope} scopes={["problems", "story", "coverage", "other", "toolong", "dev"]} goTo={goTo} checks={checks} clearChecks={() => { setChecks(null); setScope((sc) => effectiveScope(sc, null)); }} />}
            {tab === "glossary" && <StorybookGlossary snap={snap} idx={idx} onGo={goTo} onReview={openReviewRow} />}
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
