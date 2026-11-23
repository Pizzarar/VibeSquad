// Quota alert: once per window crossing, when a provider window is nearly exhausted, push to the phone and write a needs-you log entry.
// Reads runner/limits.jsonl through readLimits (injected); never runs in the runner process. State: <home>/quota-alerts.json.
import fs from "node:fs";
import path from "node:path";
import { isForbiddenRealHome } from "./test-guard.mjs";
import { vibesquadHome } from "./user-settings.mjs";

export const QUOTA_ALERT_LEFT_PCT = 2;
/** provider -> window names ("*" = all windows). */
export const QUOTA_ALERT_WINDOWS = { claude: ["*"] };
const STATE_FILE = "quota-alerts.json";
const STATE_KEEP_MS = 14 * 86400_000;

export const alertKey = (a) => `${a.provider}|${a.window}|${a.resetsAt}`;
const stateFile = (home) => path.join(home || vibesquadHome(), STATE_FILE);

export function readQuotaState(home) {
  const dir = home || vibesquadHome();
  if (isForbiddenRealHome(dir)) return { fired: {} };
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(dir), "utf8"));
    return { fired: j && typeof j.fired === "object" && j.fired ? j.fired : {} };
  } catch { return { fired: {} }; }
}

function writeQuotaState(home, state) {
  const dir = home || vibesquadHome();
  if (isForbiddenRealHome(dir)) return;
  const file = stateFile(dir);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function windowWatched(provider, window, windows = QUOTA_ALERT_WINDOWS) {
  const w = windows[provider];
  return !!w && (w.includes("*") || w.includes(window));
}

/** Limit rows at/over the threshold, with a known future resetsAt, on watched windows. */
export function crossings(limits, { now = Date.now(), leftPct = QUOTA_ALERT_LEFT_PCT, windows = QUOTA_ALERT_WINDOWS } = {}) {
  return (limits ?? []).filter((l) => {
    const reset = Date.parse(l?.resetsAt ?? "");
    return windowWatched(l.provider, l.window, windows) && Number(l.usedPct) >= 100 - leftPct && Number.isFinite(reset) && reset > now;
  });
}

/** Payload for GET /__vibesquad/providers/usage: fired alerts whose window is still >= threshold and before resetsAt. */
export function activeQuotaAlerts(limits, home, { now = Date.now(), ...opts } = {}) {
  const { fired } = readQuotaState(home);
  return crossings(limits, { now, ...opts })
    .map((l) => ({ provider: l.provider, window: l.window, usedPct: l.usedPct, resetsAt: l.resetsAt, firedAt: fired[alertKey(l)]?.firedAt ?? null }))
    .filter((a) => a.firedAt);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export function relTime(resetsAt, now) {
  const mins = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60000));
  if (mins < 60) return `in ${mins}m`;
  if (mins < 2880) return `in ${Math.round(mins / 60)}h`;
  return `in ${Math.round(mins / 1440)}d`;
}

/**
 * One check. Deps: readLimits(home), push(payload), runVs(args), now(). Persists the dedupe key BEFORE sending (at most once per crossing).
 * Returns the alerts fired this call.
 */
export async function checkQuotaAlerts({ home, readLimits, push, pushEnabled = () => true, runVs, now = Date.now, windows = QUOTA_ALERT_WINDOWS, leftPct = QUOTA_ALERT_LEFT_PCT, log = () => {} } = {}) {
  const t = now();
  const hits = crossings(readLimits(home), { now: t, leftPct, windows });
  const state = readQuotaState(home);
  const fresh = hits.filter((l) => !state.fired[alertKey(l)]);
  const firedNow = [];
  if (!fresh.length) return firedNow;
  const firedAt = new Date(t).toISOString();
  for (const l of fresh) state.fired[alertKey(l)] = { firedAt, usedPct: l.usedPct };
  for (const [k, v] of Object.entries(state.fired)) { // prune long-dead windows
    const reset = Date.parse(k.split("|")[2] ?? "");
    if (Number.isFinite(reset) && reset < t - STATE_KEEP_MS) delete state.fired[k];
    else if (!v?.firedAt) delete state.fired[k];
  }
  writeQuotaState(home, state);
  for (const l of fresh) {
    const label = `${cap(l.provider)} ${l.window}`;
    const left = Math.max(0, Math.round(100 - l.usedPct));
    if (pushEnabled("needs-you")) {
      try {
        await push({ title: `${label}: ${left}% left`, body: `resets ${relTime(l.resetsAt, t)}; spend a reset now?`, url: "/?focus=usage", tag: `quota-${l.provider}-${l.window}`, kind: "needs-you" });
      } catch (e) { log(`quota-alert push failed: ${e?.message ?? e}`); }
    }
    const r = await Promise.resolve(runVs(["log", "needs-you", `${label} ${left}% left, resets ${l.resetsAt}`, "--team", "vibesquad", "--lane", "usage"])).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (!r?.ok) log(`quota-alert needs-you log failed: ${r?.error}`);
    firedNow.push({ provider: l.provider, window: l.window, usedPct: l.usedPct, resetsAt: l.resetsAt, firedAt });
  }
  return firedNow;
}

/** Cheap interval watcher: only reads limits.jsonl when its mtime/size changed; one check in flight at a time. */
export function startQuotaAlertWatcher({ home, intervalMs = 30_000, ...deps } = {}) {
  const dir = home || vibesquadHome();
  const file = path.join(dir, "runner", "limits.jsonl");
  let sig = null, busy = false, timer = null;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      let s = null;
      try { const st = fs.statSync(file); s = `${st.mtimeMs}:${st.size}`; } catch { s = null; }
      if (s === null || s === sig) return;
      await checkQuotaAlerts({ home: dir, ...deps });
      sig = s;
    } catch (e) { deps.log?.(`quota-alert check failed: ${e?.message ?? e}`); }
    finally { busy = false; }
  };
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return { tick, stop() { clearInterval(timer); } };
}
