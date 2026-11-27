// Storybook V5: unlock sequence + play order, derived read-only from the registry entities (no EFI access here).
// buildArc(entities) -> { arcs[], playOrder[], gaps[], notDerivable[] }. Pure and deterministic.
//
// What it derives (every item carries `basis`, the data it was derived from):
//   - quest steps: linear per-trader chain (step k needs step k-1); a step at a location also needs that map (location.unlock_order);
//     `reach` steps are reveal markers (room built / skill level); cumulative rep after each step from step.rep.
//   - maps: location.unlock_order (a stage number); sealed_vault style `requires_key` is noted as a gate.
//   - contracts: available once the trader's rep >= rep_req, placed after the first step whose cumulative rep reaches it;
//     a contract at a location also needs that map.
// Stage = the highest location unlock_order a player must have reached (0 = start). Within a stage, order is chain position,
// then trader name: ties across traders are real (the data does not order them) and reported as `ties` in each stage.
// What it cannot derive is listed in `notDerivable` / `gaps` rather than guessed.

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Line entity ids of one quest step's story + title rows (csv rows whose data.id is `<step>.story` / `<step>.title`). */
function stepLineIds(entities) {
  const out = new Map();
  for (const e of entities) {
    if (e.kind !== "line" || typeof e.data?.id !== "string") continue;
    const dp = String(e.data.data_path ?? "");
    if (!/"questlines"/.test(dp) || !/"steps"/.test(dp)) continue;
    const m = /^(.+)\.(title|story)$/.exec(e.data.id);
    if (!m) continue;
    (out.get(m[1]) ?? out.set(m[1], []).get(m[1])).push({ id: e.id, field: m[2] });
  }
  for (const v of out.values()) v.sort((a, b) => (a.field === b.field ? 0 : a.field === "title" ? -1 : 1));
  return out;
}

export function buildArc(entities) {
  const by = (k) => entities.filter((e) => e.kind === k);
  const locs = new Map(by("location").map((l) => [l.id, l]));
  const rooms = new Map(by("room").map((r) => [r.id, r]));
  const traders = new Map(by("trader").map((t) => [t.id, t]));
  const locOrder = (id) => num(locs.get(id)?.data?.unlock_order);
  const lineIds = stepLineIds(entities);
  const gaps = [];
  const notDerivable = [
    "Feature reveals (farming, armory, medicine, ...) live in scripts/progression/feature_reveal.gd (GDScript), not in EFI data; only `reach` quest steps (room built / skill level) appear as reveals.",
    "No onboarding sequence is in EFI data (no onboarding/tutorial rows), so none is listed.",
    "Cross-trader order inside one stage is not set by data: the list sorts by chain position then trader name.",
  ];

  // trader dialogue outside quest steps (rep reactions + encouragement), for the story column
  const reactions = new Map();
  for (const e of by("line")) {
    if (e.data?.origin !== "trader_relations" && e.data?.origin !== "encouragement") continue;
    const t = e.data.speaker;
    (reactions.get(t) ?? reactions.set(t, []).get(t)).push(e.id);
  }

  const arcs = [];
  const playOrder = [];
  const stageOfStep = new Map();
  const steps = by("quest_step");
  const chains = new Map();
  for (const s of steps) {
    const t = String(s.data?.trader ?? "");
    if (!t) { gaps.push({ kind: "quest_step", id: s.id, why: "no trader on the step" }); continue; }
    (chains.get(t) ?? chains.set(t, []).get(t)).push(s);
  }
  for (const [tid, list] of chains) {
    list.sort((a, b) => (num(a.data.index) ?? 0) - (num(b.data.index) ?? 0) || a.id.localeCompare(b.id));
    let stage = 0, rep = 0;
    const out = [];
    const repAt = []; // cumulative rep after step k (0-based)
    list.forEach((s, k) => {
      const gates = [];
      const basis = [];
      const t = s.data.task ?? {};
      if (k > 0) gates.push({ type: "prev_step", id: list[k - 1].id });
      const loc = t.location ? String(t.location) : null;
      if (loc) {
        const lo = locOrder(loc);
        if (lo == null) gaps.push({ kind: "quest_step", id: s.id, why: `location ${loc} has no unlock_order` });
        else { gates.push({ type: "map", id: loc, unlock_order: lo }); stage = Math.max(stage, lo); basis.push("task.location + unlock_order"); }
      }
      if (t.type === "reach") gates.push(t.room ? { type: "room", id: String(t.room), level: t.level ?? null } : { type: "skill", id: String(t.skill ?? ""), level: t.level ?? null });
      if (!traders.get(tid)?.data?.level_0 && k === 0) gates.push({ type: "trader_unlock", id: tid });
      rep += num(s.data.rep) ?? 0;
      repAt.push(rep);
      stageOfStep.set(s.id, stage);
      const item = { id: s.id, index: k + 1, task: t.type ?? null, stage, gates, rep_after: Math.round(rep * 1000) / 1000, lines: lineIds.get(s.id) ?? [], basis: ["chain order", ...basis] };
      out.push(item);
      playOrder.push({ kind: "quest_step", id: s.id, label: s.display, trader: tid, stage, sub: k, gates, basis: item.basis });
      if (t.type === "reach") playOrder.push({ kind: "reveal", id: `${s.id}:reveal`, ref: s.id, label: t.room ? `Room ${rooms.get(String(t.room))?.display ?? t.room} built (level ${t.level ?? "?"})` : `Skill ${t.skill} level ${t.level ?? "?"}`, trader: tid, stage, sub: k + 0.25, gates: [{ type: "prev_step", id: list[k - 1]?.id ?? null }].filter((g) => g.id), basis: ["reach step"] });
    });
    arcs.push({ trader: tid, display: traders.get(tid)?.display ?? tid, level_0: !!traders.get(tid)?.data?.level_0, steps: out, chain_rep: Math.round(rep * 1000) / 1000, reactions: reactions.get(tid) ?? [] });
    chains.set(tid, { list, repAt });
  }
  arcs.sort((a, b) => a.display.localeCompare(b.display));
  for (const [tid, t] of traders) {
    if (!chains.has(tid)) arcs.push({ trader: tid, display: t.display, level_0: !!t.data?.level_0, steps: [], chain_rep: 0, reactions: reactions.get(tid) ?? [] });
    if (!t.data?.level_0) gaps.push({ kind: "trader", id: tid, why: "how this trader unlocks is not in EFI data (level_0 false, no unlock rule)" });
  }

  // maps
  for (const l of locs.values()) {
    const lo = locOrder(l.id);
    if (lo == null) { gaps.push({ kind: "map", id: l.id, why: "no unlock_order" }); continue; }
    const gates = [{ type: "map_order", unlock_order: lo }];
    if (l.data?.requires_key) gates.push({ type: "key", id: String(l.data.requires_key) });
    playOrder.push({ kind: "map", id: l.id, label: l.display, trader: null, stage: lo, sub: -1, gates, basis: ["unlock_order"] });
  }

  // contracts
  for (const c of by("contract")) {
    const tid = String(c.data?.trader ?? "");
    const gates = [];
    const basis = [];
    let stage = 0, sub = -0.5;
    if (tid && traders.has(tid) && !traders.get(tid).data?.level_0) gates.push({ type: "trader_unlock", id: tid });
    const req = num(c.data?.rep_req) ?? 0;
    const loc = c.data?.location ? String(c.data.location) : null;
    if (loc) {
      const lo = locOrder(loc);
      if (lo == null) gaps.push({ kind: "contract", id: c.id, why: `location ${loc} has no unlock_order` });
      else { gates.push({ type: "map", id: loc, unlock_order: lo }); stage = lo; basis.push("location unlock_order"); }
    }
    for (const r of c.data?.requires ? [].concat(c.data.requires) : []) if (r?.skill) gates.push({ type: "skill", id: String(r.skill), level: r.level ?? null });
    if (req > 0) {
      gates.push({ type: "rep", trader: tid, rep: req });
      const ch = chains.get(tid);
      const k = ch?.repAt ? ch.repAt.findIndex((r) => r + 1e-9 >= req) : -1;
      if (k >= 0) { stage = Math.max(stage, stageOfStep.get(ch.list[k].id) ?? 0); sub = k + 0.5; basis.push(`rep ${req} reached after ${ch.list[k].id}`); }
      else {
        sub = (ch?.list?.length ?? 0) + 0.5;
        if (ch?.list?.length) stage = Math.max(stage, stageOfStep.get(ch.list.at(-1).id) ?? 0);
        gaps.push({ kind: "contract", id: c.id, why: ch ? `rep ${req} is above the questline's total (${ch.repAt.at(-1)}); other rep sources not in data, placed after the chain` : `rep ${req} but ${tid || "no trader"} has no questline` });
        basis.push("placed after chain (rep source unknown)");
      }
    } else basis.push("rep 0: available when the trader is");
    playOrder.push({ kind: "contract", id: c.id, label: c.data?.rendered?.title || c.display, trader: tid || null, stage, sub, gates, basis });
  }

  playOrder.sort((a, b) => a.stage - b.stage || a.sub - b.sub || String(a.trader ?? "").localeCompare(String(b.trader ?? "")) || a.id.localeCompare(b.id));
  playOrder.forEach((p, i) => { p.pos = i + 1; });
  const perStage = new Map();
  for (const p of playOrder) if (p.kind === "quest_step") (perStage.get(p.stage) ?? perStage.set(p.stage, new Set()).get(p.stage)).add(p.trader);
  const tiedStages = [...perStage].filter(([, t]) => t.size > 1).map(([st]) => st).sort((x, y) => x - y);
  return { arcs, playOrder, gaps, notDerivable, tiedStages };
}
