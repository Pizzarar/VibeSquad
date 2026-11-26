// B17 (@bor): Normal-mode deadspace fix. The inline "Split · pick an agent" picker (replaces the blank split-empty void) and the
// quick-jump data the enriched empty-lane card shares. Presentational + pure builders only: BoringAde supplies the open handlers,
// so this file never reaches into its state (keeps the BoringAde.tsx diff surgical).
import { useEffect, useRef, useState, type ReactNode } from "react";

/** B17: which lane/role a dormant pill's empty card is for (pane-local; the host never reuses its selectedLaneId for it). */
export type CardTarget = { key: string; pill: string };
export type PickerPill = { key: string; label: string; live: boolean; onOpen: () => void };
export type PickerLane = { key: string; name: string; code: string; dot: string; needs: boolean; needsCount?: number; working: boolean; sub: string; pills: PickerPill[] };
export type PickerAgent = { key: string; title: string; sub: string; dot: string; needs: boolean; onOpen: () => void };
export type PickerData = { active: PickerAgent[]; lanes: PickerLane[] };
/** B18c: another awake project's lanes, shown under a collapsed "Other projects (N)" disclosure. */
export type OtherProject = { id: string; name: string; needsYou: number; lanes: PickerLane[] };
/** One row of the Needs-you / Active-now strip. Built by the host from the SAME rows the sidebar Needs-you section uses (needsYouRows) plus every running member. */
export type StripItem = { id: string; title: string; sub: string; needs: boolean; err?: boolean };

type Mem = { agent: { id: string; status?: string; title?: string | null } } | null | undefined;
type ModelLike = {
  core: {
    overlord: { agentId: string | null; status: string; needsYou: number; err: boolean; short: string };
    riffbot: { agentId: string | null; status: string; needsYou: number; err: boolean; short: string };
    bugs: { agentId: string | null; pin: unknown; needsYou: number; err: boolean };
  };
  conversations: { laneId: string; name: string; code: string; pin: { lead: Mem; brainstorm: Mem; workers?: Mem[] }; brainstormId: string | null; brainstormStatus: string; leadId: string | null; leadStatus: string; needsYou: number; err: boolean; running?: number }[];
};
export type PickerHandlers = {
  glyphCls: (status: string | null | undefined, tone?: string | null) => string;
  openAgent: (agentId: string) => void;
  openCore: (laneId: "_overlord" | "_riffbot", agentId: string | null) => void;
  openBugs: () => void;
  openRole: (laneId: string, role: "brainstorm" | "lead") => void;
};

const word = (status: string, needs: boolean, err: boolean) => (err ? "Error" : needs ? "Needs you" : status === "running" ? "Working" : status === "none" ? "No agent" : "Idle");

/** Desk + lanes + the Needs-you / Active-now strip for one project. Pure: same model in, same cards out. */
/** Desk + lanes for one project, plus the Needs-you / Active-now strip from `strip` (same source as the sidebar Needs-you section). */
export function buildPickerData(m: ModelLike, h: PickerHandlers, strip: StripItem[] = []): PickerData {
  const lanes: PickerLane[] = [];
  const core = (key: "overlord" | "riffbot", laneId: "_overlord" | "_riffbot", name: string) => {
    const r = m.core[key];
    lanes.push({ key: laneId, name, code: "Desk", dot: `boring-dot ${r.status} ${h.glyphCls(r.status, r.err ? "error" : r.needsYou > 0 ? "needs-you" : null)}`, needs: r.needsYou > 0 || r.err, needsCount: r.needsYou, working: r.status === "running", sub: word(r.status, r.needsYou > 0, r.err), pills: [{ key: "open", label: "Open", live: Boolean(r.agentId), onOpen: () => h.openCore(laneId, r.agentId) }] });
  };
  core("overlord", "_overlord", "★ Overlord");
  core("riffbot", "_riffbot", "RiffBot");
  const b = m.core.bugs;
  lanes.push({ key: "_bugs", name: "Bugs", code: "@bug", dot: `boring-dot ${b.agentId ? "running" : "none"} ${h.glyphCls(b.agentId ? "idle" : "none", b.err ? "error" : b.needsYou > 0 ? "needs-you" : null)}`, needs: b.needsYou > 0 || b.err, needsCount: b.needsYou, working: false, sub: b.needsYou > 0 ? "Needs you" : b.agentId ? "Buddy live" : "No agent", pills: [{ key: "open", label: "Open", live: Boolean(b.agentId), onOpen: () => h.openBugs() }] });
  for (const c of m.conversations) {
    const needs = c.needsYou > 0 || c.err;
    const run = (c.running ?? 0) > 0;
    const status = run ? "running" : c.leadId ? c.leadStatus : c.brainstormStatus;
    const roles = [c.leadId && `Lead ${word(c.leadStatus, false, false).toLowerCase()}`, c.brainstormId && `Buddy ${word(c.brainstormStatus, false, false).toLowerCase()}`].filter(Boolean).join(" · ");
    lanes.push({
      key: c.laneId, name: c.name, code: c.code,
      dot: `boring-dot ${status} ${h.glyphCls(status, c.err ? "error" : c.needsYou > 0 ? "needs-you" : null)}`,
      needs, needsCount: c.needsYou, working: run, sub: c.err ? "Error" : needs ? "Needs you" : roles || "No agent",
      pills: [
        { key: "brainstorm", label: "Buddy", live: Boolean(c.brainstormId), onOpen: () => h.openRole(c.laneId, "brainstorm") },
        { key: "lead", label: "Lead", live: Boolean(c.leadId), onOpen: () => h.openRole(c.laneId, "lead") },
      ],
    });
  }
  const active: PickerAgent[] = strip.map((i) => ({ key: i.id, title: i.title, sub: i.sub, dot: `boring-dot ${i.needs ? "idle" : "running"} ${h.glyphCls(i.needs ? "idle" : "running", i.err ? "error" : i.needs ? "needs-you" : null)}`, needs: i.needs, onOpen: () => h.openAgent(i.id) }));
  active.sort((a, z) => Number(z.needs) - Number(a.needs));
  return { active, lanes };
}

/**
 * Header + body of the split picker; the host owns the `boring-split-empty` wrapper, the Close split button (`children`) and the footer hint.
 * `getData` runs only while the picker is mounted (the host's split tree is built every render). A dormant pill selects the lane in the host, then
 * `renderEmpty` shows that lane's empty card here with a Back link. Keyboard: filter autofocuses, Enter opens the first match, Esc backs out / clears / closes.
 */
export function BoringPanePicker({ getData, renderEmpty, emptyTarget, onEmptyTarget, onClose, focusOnMount = true, otherProjects, children }: { focusOnMount?: boolean; otherProjects?: OtherProject[]; getData: () => PickerData; renderEmpty?: (t: CardTarget) => ReactNode; emptyTarget?: CardTarget | null; onEmptyTarget?: (t: CardTarget | null) => void; onClose?: () => void; children?: ReactNode }) {
  const [q, setQ] = useState("");
  const [localEmpty, setLocalEmpty] = useState<CardTarget | null>(null);
  // Controlled when the host passes emptyTarget (so its breadcrumb can name the lane); local otherwise.
  const emptyFor = emptyTarget !== undefined ? emptyTarget : localEmpty;
  const setEmptyFor = (t: CardTarget | null) => { setLocalEmpty(t); onEmptyTarget?.(t); };
  const filterRef = useRef<HTMLInputElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  // idea-1075 (UX R1 M1): the focus grab makes the right pane active (host onFocusCapture), so a remount while the LEFT pane is active must not take it.
  useEffect(() => { if (focusOnMount) filterRef.current?.focus(); }, []);
  // The grid unmounts under a clicked pill: park focus on Back (or the filter on return) so Esc/Tab keep working.
  const didShow = useRef(false);
  useEffect(() => { if (emptyFor) { didShow.current = true; backRef.current?.focus(); } else if (didShow.current) { didShow.current = false; filterRef.current?.focus(); } }, [emptyFor]);
  const data = getData();
  const needle = q.trim().toLowerCase();
  const hit = (...s: string[]) => !needle || s.some((x) => x.toLowerCase().includes(needle));
  const active = data.active.filter((a) => hit(a.title, a.sub));
  const lanes = data.lanes.filter((l) => hit(l.name, l.code));
  // The strip also matches a lane's @code (typing "@ui-bois" narrows both lists to that lane's agents).
  const codeHits = needle ? data.lanes.filter((l) => l.code && hit(l.code)).map((l) => l.name.toLowerCase()) : [];
  const activeShown = needle ? data.active.filter((a) => hit(a.title, a.sub) || codeHits.some((n) => a.title.toLowerCase().includes(n) || a.sub.toLowerCase().includes(n))) : active;
  // B18c: other awake projects. A non-empty filter keeps only matching lanes (project name matches keep all its lanes) and auto-opens the disclosure.
  const others = (otherProjects ?? []).map((p) => {
    const lanes = !needle || hit(p.name) ? p.lanes : p.lanes.filter((l) => hit(l.name, l.code));
    const needsYou = !needle || hit(p.name) ? p.needsYou : lanes.reduce((n, l) => n + (l.needsCount ?? (l.needs ? 1 : 0)), 0);
    return { ...p, lanes, needsYou };
  }).filter((p) => p.lanes.length > 0);
  const othersNeeds = others.reduce((n, p) => n + p.needsYou, 0);
  const nothing = activeShown.length === 0 && lanes.length === 0 && others.length === 0;
  // A dormant pill only shows its card here: it must not select the lane in the host (that rewrote the left pane's card).
  const openLane = (laneKey: string, pill: string, onOpen: () => void, live: boolean) => { if (live || !renderEmpty) onOpen(); else setEmptyFor({ key: laneKey, pill }); };
  const first = () => {
    if (activeShown[0]) return activeShown[0].onOpen();
    const l = lanes[0];
    if (l) { const p = l.pills.find((x) => x.live) ?? l.pills[0]; return openLane(l.key, p.key, p.onOpen, p.live); }
    const ol = others[0]?.lanes[0];
    if (ol) { const p = ol.pills.find((x) => x.live) ?? ol.pills[0]; p.onOpen(); }
  };
  const onKeyDown = (e: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (emptyFor) setEmptyFor(null);
      else if (q) setQ("");
      else onClose?.();
    }
  };
  return (
    <div className="boring-pp-root" onKeyDown={onKeyDown}>
      <div className="boring-pp-head">
        <h2 className="boring-pp-title">Pick an agent or lane</h2>
        <input ref={filterRef} className="boring-pp-filter" type="search" data-testid="boring-pp-filter" aria-label="Filter lanes or agents" placeholder="Filter lanes or agents…" value={q} onChange={(e) => { setQ(e.target.value); setEmptyFor(null); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); first(); } }} />
        {children}
      </div>
      {emptyFor && renderEmpty ? (
        <div className="boring-pp-body" data-testid="boring-pp-empty">
          <button ref={backRef} type="button" className="boring-pp-back" data-testid="boring-pp-back" onClick={() => setEmptyFor(null)}>← All lanes</button>
          {renderEmpty(emptyFor)}
        </div>
      ) : (
        <div className="boring-pp-body">
          {activeShown.length > 0 && (
            <section className="boring-pp-sec" data-testid="boring-pp-active" aria-label="Needs you and active now">
              <h3 className="boring-pp-h">Needs you · Active now</h3>
              <div className="boring-pp-strip">
                {activeShown.map((a) => (
                  <button key={a.key} type="button" className={`boring-pp-agent${a.needs ? " attn" : ""}`} data-testid={`boring-pp-agent-${a.key}`} onClick={a.onOpen} title={`${a.title} · ${a.sub}`}>
                    <span className={a.dot} aria-hidden="true" />
                    <span className="boring-pp-name">{a.title}</span>
                    <span className="boring-pp-sub">{a.sub}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {lanes.length > 0 && (
            <section className="boring-pp-sec" data-testid="boring-pp-lanes" aria-label="Project lanes">
              <h3 className="boring-pp-h">Project lanes</h3>
              <div className="boring-pp-grid">
                {lanes.map((l) => (
                  <div key={l.key} className={`boring-pp-lane${l.needs ? " attn" : ""}`} data-testid={`boring-pp-lane-${l.key}`}>
                    <span className={l.dot} aria-hidden="true" />
                    <span className="boring-pp-name" title={l.name}>{l.name}</span>
                    {l.code && <code className="boring-pp-code">{l.code}</code>}
                    <span className="boring-pp-sub">{l.sub}</span>
                    <span className="boring-pp-pills">
                      {l.pills.map((p) => (
                        <button key={p.key} type="button" className={`boring-pp-pill${p.live ? " live" : ""}`} data-testid={`boring-pp-open-${l.key}-${p.key}`} aria-label={`Open ${l.name} ${p.label}${p.live ? "" : " (not running)"}`} onClick={() => openLane(l.key, p.key, p.onOpen, p.live)}>{p.label}</button>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {others.length > 0 && (
            <details className="boring-pp-others" data-testid="boring-pp-others" open={needle ? true : undefined}>
              <summary className="boring-pp-others-sum" data-testid="boring-pp-others-sum">Other projects ({others.length}){othersNeeds > 0 && <span className="boring-pp-others-badge" data-testid="boring-pp-others-badge">{othersNeeds} needs you</span>}</summary>
              {others.map((p) => (
                <section key={p.id} className="boring-pp-sec boring-pp-other" data-testid={`boring-pp-other-${p.id}`} aria-label={`${p.name} lanes`}>
                  <h3 className="boring-pp-h">{p.name}</h3>
                  <div className="boring-pp-grid">
                    {p.lanes.map((l) => (
                      <div key={l.key} className={`boring-pp-lane${l.needs ? " attn" : ""}`} data-testid={`boring-pp-other-lane-${p.id}-${l.key}`}>
                        <span className={l.dot} aria-hidden="true" />
                        <span className="boring-pp-name" title={l.name}>{l.name}</span>
                        {l.code && <code className="boring-pp-code">{l.code}</code>}
                        <span className="boring-pp-sub">{l.sub}</span>
                        <span className="boring-pp-pills">
                          {l.pills.map((pl) => (<button key={pl.key} type="button" className={`boring-pp-pill${pl.live ? " live" : ""}`} data-testid={`boring-pp-other-open-${p.id}-${l.key}-${pl.key}`} aria-label={`Open ${p.name} ${l.name} ${pl.label}${pl.live ? "" : " (not running)"}`} onClick={pl.onOpen}>{pl.label}</button>))}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </details>
          )}
          {nothing && <p className="boring-pp-none" data-testid="boring-pp-none">No lane or agent matches “{q.trim()}”.</p>}
        </div>
      )}
    </div>
  );
}

export type QuickJump = { key: string; label: string; sub: string; dot: string; onOpen: () => void };
/** Empty-lane card quick-jumps: sibling role, live workers in this lane, then other active lanes (never the lane itself). */
export function buildQuickJumps(m: ModelLike, selectedLaneId: string | null, h: PickerHandlers): { here: QuickJump[]; others: QuickJump[] } {
  const here: QuickJump[] = [];
  const c = m.conversations.find((x) => x.laneId === selectedLaneId);
  if (c) {
    if (c.leadId) here.push({ key: "lead", label: "Lead", sub: word(c.leadStatus, false, false), dot: `boring-dot ${c.leadStatus} ${h.glyphCls(c.leadStatus)}`, onOpen: () => h.openAgent(c.leadId!) });
    if (c.brainstormId) here.push({ key: "brainstorm", label: "Brainstorm", sub: word(c.brainstormStatus, false, false), dot: `boring-dot ${c.brainstormStatus} ${h.glyphCls(c.brainstormStatus)}`, onOpen: () => h.openAgent(c.brainstormId!) });
    for (const w of c.pin.workers ?? []) if (w && w.agent.status === "running") here.push({ key: `w:${w.agent.id}`, label: w.agent.title ?? w.agent.id.slice(0, 8), sub: "Working", dot: `boring-dot running ${h.glyphCls("running")}`, onOpen: () => h.openAgent(w.agent.id) });
  }
  const d = buildPickerData(m, h);
  const others = d.lanes
    .filter((l) => l.key !== selectedLaneId && l.code !== "Desk" && (l.needs || l.working))
    .slice(0, 6)
    .map((l) => ({ key: l.key, label: l.name, sub: l.sub, dot: l.dot, onOpen: l.pills.find((p) => p.live)?.onOpen ?? l.pills[0].onOpen }));
  return { here, others };
}

export function BoringEmptyJumps({ here, others }: { here: QuickJump[]; others: QuickJump[] }) {
  if (here.length === 0 && others.length === 0) return null;
  const row = (j: QuickJump) => (
    <button key={j.key} type="button" className="boring-pp-agent" data-testid={`boring-empty-jump-${j.key}`} onClick={j.onOpen}>
      <span className={j.dot} aria-hidden="true" />
      <span className="boring-pp-name">{j.label}</span>
      <span className="boring-pp-sub">{j.sub}</span>
    </button>
  );
  return (
    <div className="boring-empty-jumps" data-testid="boring-empty-jumps">
      {here.length > 0 && (<section data-testid="boring-empty-here"><h3 className="boring-pp-h">Available in this lane</h3><div className="boring-pp-strip">{here.map(row)}</div></section>)}
      {others.length > 0 && (<section data-testid="boring-empty-others"><h3 className="boring-pp-h">Other active lanes</h3><div className="boring-pp-strip">{others.map(row)}</div></section>)}
    </div>
  );
}
