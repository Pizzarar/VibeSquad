// B17 (@bor): Normal-mode deadspace fix. The inline "Split · pick an agent" picker (replaces the blank split-empty void) and the
// quick-jump data the enriched empty-lane card shares. Presentational + pure builders only: BoringAde supplies the open handlers,
// so this file never reaches into its state (keeps the BoringAde.tsx diff surgical).
import { useState, type ReactNode } from "react";

export type PickerPill = { key: string; label: string; live: boolean; onOpen: () => void };
export type PickerLane = { key: string; name: string; code: string; dot: string; needs: boolean; sub: string; pills: PickerPill[] };
export type PickerAgent = { key: string; title: string; sub: string; dot: string; needs: boolean; onOpen: () => void };
export type PickerData = { active: PickerAgent[]; lanes: PickerLane[] };

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
const isActive = (status: string, needs: boolean, err: boolean) => needs || err || status === "running";

/** Desk + lanes + the Needs-you / Active-now strip for one project. Pure: same model in, same cards out. */
export function buildPickerData(m: ModelLike, h: PickerHandlers): PickerData {
  const lanes: PickerLane[] = [];
  const active: PickerAgent[] = [];
  const pushActive = (key: string, title: string, status: string, needs: boolean, err: boolean, onOpen: () => void) => {
    if (isActive(status, needs, err)) active.push({ key, title, sub: word(status, needs, err), dot: `boring-dot ${status} ${h.glyphCls(status, err ? "error" : needs ? "needs-you" : null)}`, needs: needs || err, onOpen });
  };
  const core = (key: "overlord" | "riffbot", laneId: "_overlord" | "_riffbot", name: string) => {
    const r = m.core[key];
    lanes.push({ key: laneId, name, code: "Desk", dot: `boring-dot ${r.status} ${h.glyphCls(r.status, r.err ? "error" : r.needsYou > 0 ? "needs-you" : null)}`, needs: r.needsYou > 0 || r.err, sub: word(r.status, r.needsYou > 0, r.err), pills: [{ key: "open", label: "Open", live: Boolean(r.agentId), onOpen: () => h.openCore(laneId, r.agentId) }] });
    pushActive(laneId, name, r.status, r.needsYou > 0, r.err, () => h.openCore(laneId, r.agentId));
  };
  core("overlord", "_overlord", "★ Overlord");
  core("riffbot", "_riffbot", "RiffBot");
  const b = m.core.bugs;
  lanes.push({ key: "_bugs", name: "Bugs", code: "@bug", dot: `boring-dot ${b.agentId ? "running" : "none"} ${h.glyphCls(b.agentId ? "idle" : "none", b.err ? "error" : b.needsYou > 0 ? "needs-you" : null)}`, needs: b.needsYou > 0 || b.err, sub: b.needsYou > 0 ? "Needs you" : b.agentId ? "Buddy live" : "No agent", pills: [{ key: "open", label: "Open", live: Boolean(b.agentId), onOpen: () => h.openBugs() }] });
  if (b.needsYou > 0 || b.err) pushActive("_bugs", "Bugs", "idle", b.needsYou > 0, b.err, () => h.openBugs());
  for (const c of m.conversations) {
    const needs = c.needsYou > 0 || c.err;
    const run = (c.running ?? 0) > 0;
    const status = run ? "running" : c.brainstormStatus;
    lanes.push({
      key: c.laneId, name: c.name, code: c.code,
      dot: `boring-dot ${status} ${h.glyphCls(status, c.err ? "error" : c.needsYou > 0 ? "needs-you" : null)}`,
      needs, sub: word(status, c.needsYou > 0, c.err),
      pills: [
        { key: "brainstorm", label: "Buddy", live: Boolean(c.brainstormId), onOpen: () => h.openRole(c.laneId, "brainstorm") },
        { key: "lead", label: "Lead", live: Boolean(c.leadId), onOpen: () => h.openRole(c.laneId, "lead") },
      ],
    });
    if (c.leadId && isActive(c.leadStatus, c.needsYou > 0, c.err)) pushActive(`${c.laneId}:lead`, `Lead · ${c.name}`, c.leadStatus, c.needsYou > 0, c.err, () => h.openAgent(c.leadId!));
    else if (c.brainstormId && isActive(c.brainstormStatus, c.needsYou > 0, c.err)) pushActive(`${c.laneId}:bs`, `Buddy · ${c.name}`, c.brainstormStatus, c.needsYou > 0, c.err, () => h.openAgent(c.brainstormId!));
    for (const w of c.pin.workers ?? []) if (w && w.agent.status === "running") pushActive(`w:${w.agent.id}`, w.agent.title ?? w.agent.id.slice(0, 8), "running", false, false, () => h.openAgent(w.agent.id));
  }
  active.sort((a, z) => Number(z.needs) - Number(a.needs));
  return { active, lanes };
}

/** Header + body of the split picker; the host owns the `boring-split-empty` wrapper, the Close split button (`children`) and the footer hint. */
export function BoringPanePicker({ data, children }: { data: PickerData; children?: ReactNode }) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const hit = (...s: string[]) => !needle || s.some((x) => x.toLowerCase().includes(needle));
  const active = data.active.filter((a) => hit(a.title, a.sub));
  const lanes = data.lanes.filter((l) => hit(l.name, l.code));
  const nothing = active.length === 0 && lanes.length === 0;
  return (
    <>
      <div className="boring-pp-head">
        <h2 className="boring-pp-title">Pick an agent or lane</h2>
        <input className="boring-pp-filter" type="search" data-testid="boring-pp-filter" aria-label="Filter lanes or agents" placeholder="Filter lanes or agents…" value={q} onChange={(e) => setQ(e.target.value)} />
        {children}
      </div>
      <div className="boring-pp-body">
        {active.length > 0 && (
          <section className="boring-pp-sec" data-testid="boring-pp-active" aria-label="Needs you and active now">
            <h3 className="boring-pp-h">Needs you · Active now</h3>
            <div className="boring-pp-strip">
              {active.map((a) => (
                <button key={a.key} type="button" className={`boring-pp-agent${a.needs ? " attn" : ""}`} data-testid={`boring-pp-agent-${a.key}`} onClick={a.onOpen}>
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
                      <button key={p.key} type="button" className={`boring-pp-pill${p.live ? " live" : ""}`} data-testid={`boring-pp-open-${l.key}-${p.key}`} aria-label={`Open ${l.name} ${p.label}`} onClick={p.onOpen}>{p.label}</button>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
        {nothing && <p className="boring-pp-none" data-testid="boring-pp-none">No lane or agent matches “{q.trim()}”.</p>}
      </div>
    </>
  );
}

export type QuickJump = { key: string; label: string; sub: string; dot: string; onOpen: () => void };
/** Empty-lane card quick-jumps: sibling role, live workers in this lane, then other active lanes (never the lane itself). */
export function buildQuickJumps(m: ModelLike, selectedLaneId: string | null, h: PickerHandlers): { here: QuickJump[]; others: QuickJump[] } {
  const here: QuickJump[] = [];
  const c = m.conversations.find((x) => x.laneId === selectedLaneId);
  if (c) {
    if (c.leadId) here.push({ key: "lead", label: "Open the Lead", sub: word(c.leadStatus, false, false), dot: `boring-dot ${c.leadStatus} ${h.glyphCls(c.leadStatus)}`, onOpen: () => h.openAgent(c.leadId!) });
    if (c.brainstormId) here.push({ key: "brainstorm", label: "Open Brainstorm", sub: word(c.brainstormStatus, false, false), dot: `boring-dot ${c.brainstormStatus} ${h.glyphCls(c.brainstormStatus)}`, onOpen: () => h.openAgent(c.brainstormId!) });
    for (const w of c.pin.workers ?? []) if (w && w.agent.status === "running") here.push({ key: `w:${w.agent.id}`, label: w.agent.title ?? w.agent.id.slice(0, 8), sub: "Worker · working", dot: `boring-dot running ${h.glyphCls("running")}`, onOpen: () => h.openAgent(w.agent.id) });
  }
  const d = buildPickerData(m, h);
  const others = d.lanes
    .filter((l) => l.key !== selectedLaneId && l.code !== "Desk" && (l.needs || /Working/.test(l.sub)))
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
