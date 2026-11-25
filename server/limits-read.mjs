// Provider limit windows: <runner home>/runner/limits.jsonl, one JSON line per sample (written by runner/limits.mjs):
// {at, provider, window:"5h"|"weekly", usedPct, resetsAt, source:"provider"|"estimate", agentId}
// readLimits is what the usage panel / `vs usage` show (providers-catalog.mjs re-exports it). A leaf module (node + two
// tiny helpers only) so the spawn hook (server/hooks/agent-duties.ts) can read live quota without the whole catalog.
// G2 idea-1012 (PLAN_PER_ROLES_LADDER_1125): liveQuotaUsage turns those rows into the usageProviders list spawn failover
// (provider-failover.mjs isProviderOverQuota, QUOTA_FAILOVER_THRESHOLD) judges, dropping stale and rolled-over readings.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isForbiddenRealHome } from "./test-guard.mjs";
import { vibesquadHome } from "./user-settings.mjs";
import { AGY_CLAUDE_FAMILY } from "./model-ids.mjs";

const BURN_LOOKBACK_MS = 2 * 3600_000;

const toMs = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};
/** Event ts -> ms, rejecting values that are not a valid date (e.g. 1e20). */
const tsMs = (v) => {
  const n = toMs(v);
  return n !== null && !Number.isNaN(new Date(n).getTime()) ? n : null;
};
const getOrSet = (m, k, mk) => m.get(k) ?? m.set(k, mk()).get(k);

/** Latest sample per provider/window + burn rate (%/h over the last 2h of the current window) + ETA-to-cap. Missing file -> []. */
export function readLimits(home) {
  const dir = home || vibesquadHome();
  if (isForbiddenRealHome(dir)) return [];
  let text = "";
  try { text = readFileSync(join(dir, "runner", "limits.jsonl"), "utf8"); } catch { return []; }
  // Sidecar: last *check* time per provider/window (updated on every poll, even when the sample didn't change).
  let checked = {};
  try { checked = JSON.parse(readFileSync(join(dir, "runner", "limits-checked.json"), "utf8")); } catch { checked = {}; }
  if (typeof checked !== "object" || checked === null || Array.isArray(checked)) checked = {};
  const groups = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const at = toMs(r?.at);
    const used = Number(r?.usedPct);
    if (!r?.provider || !r?.window || at === null || !Number.isFinite(used)) continue;
    getOrSet(groups, `${r.provider}|${r.window}`, () => []).push({ ...r, atMs: at, used, resetMs: toMs(r.resetsAt) });
  }
  const out = [];
  for (const pts of groups.values()) {
    pts.sort((x, y) => x.atMs - y.atMs);
    const last = pts[pts.length - 1];
    // Current window starts after the last usedPct drop or the last change of a known resetsAt (both mean the window rolled over).
    let start = 0;
    for (let i = 1; i < pts.length; i++) {
      const rolled = pts[i].used < pts[i - 1].used || (pts[i].resetMs !== null && pts[i - 1].resetMs !== null && pts[i].resetMs !== pts[i - 1].resetMs);
      if (rolled) start = i;
    }
    const cur = pts.slice(start).filter((p) => p.atMs >= last.atMs - BURN_LOOKBACK_MS);
    const hours = (last.atMs - cur[0].atMs) / 3600_000;
    const burn = Math.max(0, hours > 0 ? (last.used - cur[0].used) / hours : 0);
    let etaToCap = null;
    if (burn > 0) {
      const eta = last.used >= 100 ? last.atMs : last.atMs + ((100 - last.used) / burn) * 3600_000;
      if (last.resetMs === null || eta < last.resetMs) etaToCap = new Date(eta).toISOString();
    }
    const sidecarMs = tsMs(checked[`${last.provider}|${last.window}`]);
    const checkedMs = sidecarMs === null ? last.atMs : Math.max(sidecarMs, last.atMs);
    out.push({
      provider: last.provider, window: last.window, usedPct: last.used,
      resetsAt: last.resetMs === null ? null : new Date(last.resetMs).toISOString(),
      source: last.source ?? "provider", agentId: last.agentId ?? null, at: new Date(last.atMs).toISOString(),
      checkedAt: new Date(checkedMs).toISOString(),
      burnPctPerHour: Math.round(burn * 100) / 100, etaToCap,
    });
  }
  return out.sort((x, y) => x.provider.localeCompare(y.provider) || x.window.localeCompare(y.window));
}


/**
 * Freshness bound for a quota reading (G2): a row whose last check (limits-checked.json sidecar, else its `at`) is older
 * than this never triggers a switch. 5h = the shortest quota window. Why not the sampler cadence (agy polls at most every
 * 30 min, Claude reports per turn): samples only arrive while that provider's turns run, so a provider AT its cap stops
 * reporting (its agents die). 11-25: Claude hit 100% at 13:42Z, resetsAt 17:20Z, no newer 5h sample for hours; a 60 min
 * bound would have released the failover at 14:42Z and successors would have died until 17:20Z. Within a window usage
 * only rises until resetsAt, so resetsAt is the precise guard; this bound catches rows with no/garbled resetsAt or a
 * stuck file.
 */
export const QUOTA_READING_MAX_AGE_MS = 5 * 3600_000;

/**
 * Length of each quota window (G2 r1). A long window's row (weekly) with a valid resetsAt still ahead is kept up to its
 * window length, not the 5h bound: once a provider sits at its weekly cap its turns stop, so no new sample arrives, and
 * dropping the row after 5h flipped spawns back onto it mid-limit every 5h. A resetsAt further out than one window is
 * garbled and gets only the 5h bound. 5h rows and rows with no resetsAt keep the 5h bound.
 */
export const QUOTA_WINDOW_MS = Object.freeze({ "5h": 5 * 3600_000, weekly: 7 * 24 * 3600_000 });

/**
 * readLimits rows -> usageProviders entries ({ id, source, windows: [{ window, usedPct, resetsAt }] }, one per provider
 * family) for provider-failover.isProviderOverQuota. A row is dropped when its reading is older than maxAgeMs (a weekly
 * row with resetsAt ahead: older than its window, QUOTA_WINDOW_MS), when its
 * resetsAt has passed (the window rolled over: the old % no longer applies), or when usedPct is not a number. The agy
 * Claude/GPT pool rows (`antigravity-cli/claude-gpt`) feed the agy-claude family only (R10: id `agy-claude`, same age and
 * resetsAt guards), never antigravity-cli: Gemini spawns don't draw on that pool. Other `/` pool rows are dropped.
 * Missing data -> [] (no switch).
 */
/** R10: pool rows that belong to a routing family of their own (provider row -> usageProviders id). */
const POOL_ROW_FAMILIES = Object.freeze({ "antigravity-cli/claude-gpt": AGY_CLAUDE_FAMILY });

export function usageFromLimits(rows, { now = Date.now(), maxAgeMs = QUOTA_READING_MAX_AGE_MS } = {}) {
  const byProvider = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const raw = String(r?.provider ?? "").trim();
    const provider = POOL_ROW_FAMILIES[raw.toLowerCase()] ?? raw;
    if (!provider || provider.includes("/")) continue;
    const used = Number(r?.usedPct);
    if (r?.usedPct === null || r?.usedPct === undefined || !Number.isFinite(used)) continue;
    const seenMs = Math.max(tsMs(r.checkedAt) ?? -Infinity, tsMs(r.at) ?? -Infinity);
    const resetMs = tsMs(r.resetsAt);
    if (resetMs !== null && resetMs <= now) continue;
    const windowMs = QUOTA_WINDOW_MS[String(r.window ?? "")] ?? 0;
    const heldToReset = resetMs !== null && windowMs > QUOTA_READING_MAX_AGE_MS && resetMs - now <= windowMs;
    if (!Number.isFinite(seenMs) || now - seenMs > (heldToReset ? Math.max(maxAgeMs, windowMs) : maxAgeMs)) continue;
    getOrSet(byProvider, provider, () => []).push({ window: String(r.window ?? ""), usedPct: used, resetsAt: r.resetsAt ?? null });
  }
  return [...byProvider].map(([id, windows]) => ({ id, source: "limits.jsonl", windows }));
}

// readLimits re-parses the whole append-only file: cache its rows on the two files' mtime+size (spawns call this a few times each).
let rowsCache = null; // { key, rows }
const fileSig = (f) => {
  try {
    const st = statSync(f);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
};

/**
 * The live usageProviders list for spawn failover: readLimits(home) filtered by usageFromLimits. Never throws (a read
 * error = [] = no switch, the same as no data). `read` is injectable for tests.
 * @param {{ home?: string, now?: number, maxAgeMs?: number, read?: (home?: string) => any[] }} [opts]
 * @returns {{ id: string, source: string, windows: { window: string, usedPct: number, resetsAt: string | null }[] }[]}
 */
export function liveQuotaUsage({ home, now = Date.now(), maxAgeMs = QUOTA_READING_MAX_AGE_MS, read } = {}) {
  try {
    let rows;
    if (read) rows = read(home);
    else {
      const dir = home || vibesquadHome();
      const key = `${dir}|${fileSig(join(dir, "runner", "limits.jsonl"))}|${fileSig(join(dir, "runner", "limits-checked.json"))}`;
      if (rowsCache?.key !== key) rowsCache = { key, rows: readLimits(dir) };
      rows = rowsCache.rows;
    }
    return usageFromLimits(rows, { now, maxAgeMs });
  } catch {
    return [];
  }
}
