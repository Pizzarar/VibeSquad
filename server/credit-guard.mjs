// Prepaid provider credit guard (usa-66, idea-963):
// Polls prepaid provider credit balances (starting with DeepSeek) at most every 30 min via runner/limits.mjs,
// raises ONE `needs-you` when a balance crosses below the configured threshold (default $10), and re-arms only
// after the balance rises back above the threshold. Alert state persists in <home>/runner/credit-alerts.json so
// server restarts never re-fire an already-raised alert.
import fs from "node:fs";
import path from "node:path";
import { appendVsLogEntry } from "./brainstorm.mjs";
import { isForbiddenRealHome } from "./test-guard.mjs";
import { vibesquadHome } from "./user-settings.mjs";
import { CREDIT_POLL_INTERVAL_MS, CreditStore, createCreditPoller } from "../runner/limits.mjs";

export const DEFAULT_CREDIT_THRESHOLD_USD = 10;
export const CREDIT_GUARD_TEAM = "vibesquad";
export const CREDIT_GUARD_LANE = "usage";
const STATE_FILE = "credit-alerts.json";

const PROVIDER_DISPLAY = Object.freeze({
  deepseek: "DeepSeek",
});

function providerDisplayName(provider) {
  const key = String(provider ?? "").trim().toLowerCase();
  return PROVIDER_DISPLAY[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : "Provider");
}

function formatMoney(amount, currency = "USD") {
  const cur = String(currency || "USD").toUpperCase();
  const sym = cur === "USD" ? "$" : `${cur} `;
  const n = Number(amount);
  const formatted = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return `${sym}${formatted}`;
}

function formatBalance(amount, currency = "USD") {
  const cur = String(currency || "USD").toUpperCase();
  const sym = cur === "USD" ? "$" : `${cur} `;
  return `${sym}${Number(amount).toFixed(2)}`;
}

/** Build the owner-facing needs-you message (e.g. "DeepSeek credit $7.12 < $10 threshold: top up"). */
export function formatCreditAlertMessage({ provider, balance, currency = "USD", thresholdUsd = DEFAULT_CREDIT_THRESHOLD_USD }) {
  return `${providerDisplayName(provider)} credit ${formatBalance(balance, currency)} < ${formatMoney(thresholdUsd, currency)} threshold: top up`;
}

function statePath(home) {
  return path.join(home || vibesquadHome(), "runner", STATE_FILE);
}

/** Read persisted credit-alert dedupe state from <home>/runner/credit-alerts.json. */
export function readCreditAlertState(home) {
  const dir = home || vibesquadHome();
  if (isForbiddenRealHome(dir)) return { providers: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(dir), "utf8"));
    const providers = parsed && typeof parsed.providers === "object" && parsed.providers && !Array.isArray(parsed.providers) ? parsed.providers : {};
    return { providers };
  } catch {
    return { providers: {} };
  }
}

/** Persist credit-alert dedupe state atomically (tmp + rename) under <home>/runner/credit-alerts.json. */
export function writeCreditAlertState(home, state) {
  const dir = home || vibesquadHome();
  if (isForbiddenRealHome(dir)) return;
  const file = statePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ providers: state?.providers ?? {} }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Evaluate credit readings against thresholdUsd with persisted dedupe + re-arm:
 *  - Fires once when status === "ok" and balance < thresholdUsd while not alerted.
 *  - Stays silent on subsequent checks below threshold (including across server restarts).
 *  - Re-arms only after balance rises strictly above thresholdUsd (balance > thresholdUsd).
 *  - Non-"ok" statuses (no-key, error) neither fire nor clear an armed alert.
 */
export async function evaluateCreditAlerts({
  credits,
  home,
  thresholdUsd = DEFAULT_CREDIT_THRESHOLD_USD,
  now = Date.now,
  log = ({ text }) => appendVsLogEntry({ teamId: CREDIT_GUARD_TEAM, laneId: CREDIT_GUARD_LANE, agent: "vibesquad-server", type: "needs-you", text }),
} = {}) {
  const threshold = Number.isFinite(Number(thresholdUsd)) && Number(thresholdUsd) >= 0 ? Number(thresholdUsd) : DEFAULT_CREDIT_THRESHOLD_USD;
  const state = readCreditAlertState(home);
  const fired = [];
  let dirty = false;

  for (const c of Array.isArray(credits) ? credits : []) {
    if (!c || c.status !== "ok" || typeof c.balance !== "number" || !Number.isFinite(c.balance) || !c.provider) continue;
    const provider = String(c.provider);
    const prev = state.providers[provider] && typeof state.providers[provider] === "object" ? state.providers[provider] : { alerted: false };
    const alerted = Boolean(prev.alerted);
    const nowIso = new Date(now()).toISOString();

    if (!alerted && c.balance < threshold) {
      const text = formatCreditAlertMessage({ provider, balance: c.balance, currency: c.currency || "USD", thresholdUsd: threshold });
      await log({ provider, balance: c.balance, currency: c.currency || "USD", thresholdUsd: threshold, text });
      state.providers[provider] = {
        alerted: true,
        alertedAt: nowIso,
        lastBalance: c.balance,
        thresholdUsd: threshold,
      };
      writeCreditAlertState(home, state);
      dirty = false;
      fired.push({ provider, balance: c.balance, currency: c.currency || "USD", thresholdUsd: threshold, alertedAt: nowIso, text });
    } else if (alerted && c.balance > threshold) {
      state.providers[provider] = {
        alerted: false,
        rearmedAt: nowIso,
        lastBalance: c.balance,
        thresholdUsd: threshold,
      };
      dirty = true;
    }
  }

  if (dirty) writeCreditAlertState(home, state);
  return fired;
}

/**
 * Server-side periodic watcher: polls prepaid credits (at most every intervalMs, default 30 min) and evaluates alerts.
 * VS_CREDIT_GUARD=0 opts out. All I/O injectable for tests.
 */
export function startCreditGuardWatcher({
  home,
  intervalMs = CREDIT_POLL_INTERVAL_MS,
  env = process.env,
  getThreshold = () => DEFAULT_CREDIT_THRESHOLD_USD,
  poller,
  fetchImpl,
  resolveKey,
  log,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (env.VS_CREDIT_GUARD === "0") return { stop() {}, tick: async () => [], disabled: true };
  const dir = home || vibesquadHome();
  const store = new CreditStore(path.join(dir, "runner", "credits.json"));
  const poll = poller ?? createCreditPoller({ store, minIntervalMs: intervalMs, now, fetchImpl, resolveKey, env });
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (stopped || busy) return [];
    busy = true;
    try {
      const credits = await poll();
      if (stopped) return [];
      const thresholdUsd = typeof getThreshold === "function" ? getThreshold() : DEFAULT_CREDIT_THRESHOLD_USD;
      return await evaluateCreditAlerts({ credits, home: dir, thresholdUsd, now, ...(log ? { log } : {}) });
    } catch (e) {
      console.warn(`[vibesquad] credit-guard: ${e?.message ?? e}`);
      return [];
    } finally {
      busy = false;
    }
  };

  const timer = setIntervalFn(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return {
    tick,
    stop: () => {
      stopped = true;
      clearIntervalFn(timer);
      poll.shutdown?.();
    },
  };
}
