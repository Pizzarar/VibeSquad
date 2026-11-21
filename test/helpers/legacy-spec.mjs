// idea-307 oracle: the runner's resume-path readers as they were before they moved onto the fold (runner/runner.mjs at 720398b7,
// verbatim apart from `this` -> `r`). Each parses the WHOLE log with store.read. test/runner-spec-fold.test.mjs asserts the
// fold-based Runner methods return exactly what these return; scripts/bench-runner-spec-reads.mjs times both.
import { bgStopNoticeText, drainNoticeText } from "../../runner/runner.mjs";

function isRetiredMeta(meta) {
  return [meta?.role, meta?.labels?.role].some((r) => { const v = String(r ?? '').trim().toLowerCase(); return v.startsWith('former-') || v === 'old-lead' || v === 'retired' || v === 'old'; });
}
const effModel = (created, meta) => meta?.model ?? created.model ?? undefined;

export function legacyParkedSpec(r, id) {
  if (!r.store.exists(id)) return null;
  const events = r.store.read(id);
  let parked = null;
  let archived = false;
  let stopped = null;
  let refused = null;
  const meta = { ...(events[0]?.meta ?? {}) };
  for (const e of events) {
    if (e.type === 'meta') Object.assign(meta, e.patch, e.patch?.labels ? { labels: { ...meta.labels, ...e.patch.labels } } : {});
    if (e.type === 'parked') parked = e;
    else if (e.type === 'park-drain-refused') refused = e;
    else if (e.type === 'bg-stopped') stopped = e;
    else if (e.type === 'input' && !e.steerOnly) { refused = null; stopped = null; }
    else if (e.type === 'exit') return null;
    else if (e.type === 'archive') archived = true;
    else if (e.type === 'unarchive') archived = false;
    else if (e.type === 'status' && e.status !== 'parked' && e.status !== 'queued') parked = null;
  }
  if (archived || !parked || typeof parked.sessionId !== 'string' || !parked.sessionId || parked.sessionId.startsWith('-')) return null;
  const c = events[0];
  return { provider: c.provider, model: effModel(c, meta), cwd: c.cwd, meta, systemPrompt: parked.systemPrompt ?? undefined, resume: parked.sessionId, ...(refused ? { drainNotice: drainNoticeText(refused.drain ?? {}, Array.isArray(refused.work) ? refused.work : []) } : {}), ...(stopped?.work?.length ? { bgStopNotice: bgStopNoticeText(stopped.work) } : {}) };
}

export function legacyLostSpec(r, id) {
  if (!r.store.exists(id) || r.live.has(id)) return null;
  const events = r.store.read(id);
  let sessionId = null;
  let archived = false;
  const meta = { ...(events[0]?.meta ?? {}) };
  for (const e of events) {
    if (e.type === 'meta') Object.assign(meta, e.patch, e.patch?.labels ? { labels: { ...meta.labels, ...e.patch.labels } } : {});
    if (e.type === 'exit') return null;
    if (e.type === 'archive') archived = true;
    else if (e.type === 'unarchive') archived = false;
    if (e.type === 'session' && e.sessionId) sessionId = e.sessionId;
  }
  const c = events[0];
  if (archived || !sessionId || typeof sessionId !== 'string' || sessionId.startsWith('-') || !r.adapters[c?.provider]?.canPark) return null;
  return { provider: c.provider, model: effModel(c, meta), cwd: c.cwd, meta, systemPrompt: c.systemPrompt ?? undefined, resume: sessionId };
}

export function legacyUnstartedPlan(r, id) {
  if (!r.store.exists(id) || r.live.has(id) || r.queue.some((j) => j.id === id)) return null;
  if (r._foldsWarm) { const f = r._fold(id); if (f && f.status !== 'queued') return null; }
  const events = r.store.read(id);
  const c = events[0];
  if (c?.type !== 'created' || !r.adapters[c.provider]) return null;
  let status = null;
  let statusTs = 0;
  let archived = false;
  let sessionId = null;
  let cut = -1;
  const meta = { ...(c.meta ?? {}) };
  events.forEach((e, i) => {
    if (e.type === 'exit') status = 'exited';
    else if (e.type === 'archive') archived = true;
    else if (e.type === 'unarchive') archived = false;
    else if (e.type === 'session' && e.sessionId) sessionId = e.sessionId;
    else if (e.type === 'meta') Object.assign(meta, e.patch, e.patch?.labels ? { labels: { ...meta.labels, ...e.patch.labels } } : {});
    else if (e.type === 'status') { status = e.status; statusTs = e.ts ?? 0; if (e.status !== 'queued') cut = i; }
  });
  if (status !== 'queued' || archived) return null;
  const inputs = events.filter((e, i) => e.type === 'input' && i > cut && typeof e.text === 'string' && !e.steerOnly);
  if (!inputs.length) return null;
  if (isRetiredMeta(meta)) return null;
  if (r.queueMaxAgeMs > 0 && Date.now() - statusTs > r.queueMaxAgeMs) return null;
  const supersededBy = r._successorOf(id, meta);
  const resumable = sessionId && !sessionId.startsWith('-') && r.adapters[c.provider]?.canPark;
  return {
    spec: { provider: c.provider, model: effModel(c, meta), cwd: c.cwd, meta, systemPrompt: c.systemPrompt ?? undefined, ...(resumable ? { resume: sessionId } : {}) },
    text: inputs.map((e) => e.text).join('\n\n'),
    owner: inputs.some((e) => e.owner === true),
    ts: inputs[0].ts ?? 0,
    supersededBy,
  };
}

export function legacyCutTurn(r, id, meta) {
  let last = null;
  for (const e of r.store.read(id)) if (e.type === 'status') last = e;
  if (!last || !(last.status === 'running' || (last.status === 'starting' && last.resume !== true))) return false;
  if (r.queueMaxAgeMs > 0 && Date.now() - (last.ts ?? 0) > r.queueMaxAgeMs) return false;
  return !isRetiredMeta(meta) && !r._successorOf(id, meta);
}

// Every resume-path answer for one agent, old (full read) or new (fold). Thrown errors are part of the answer.
const settle = (fn) => { try { return { v: fn() }; } catch (err) { return { err: String(err?.message ?? err) }; } };
export function answers(r, id, { legacy }) {
  const parked = settle(() => (legacy ? legacyParkedSpec(r, id) : r._parkedSpec(id)));
  const lost = settle(() => (legacy ? legacyLostSpec(r, id) : r._lostSpec(id)));
  const unstarted = settle(() => (legacy ? legacyUnstartedPlan(r, id) : r._unstartedPlan(id)));
  const metas = [{}, lost.v?.meta ?? null, parked.v?.meta ?? null, { role: 'former-lead' }].filter(Boolean);
  const cut = metas.map((m) => settle(() => (legacy ? legacyCutTurn(r, id, m) : r._cutTurn(id, m))));
  return { parked, lost, unstarted, cut };
}
