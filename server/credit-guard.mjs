// Prepaid provider credit guard (usa-66, idea-963):
// Polls prepaid provider credit balances (starting with DeepSeek) at most every 30 min via runner/limits.mjs,
// raises ONE `needs-you` when a balance crosses below the configured threshold (default $10), and re-arms only
// after the balance rises back above the threshold. Alert state persists in <home>/runner/credit-alerts.json so
// server restarts never re-fire an already-raised alert.
import fs from "node:fs";
import path from "node:path";
import { appendVsLogEntry } from "./brainstorm.mjs";
import { capKin, normalizeProviderFamily, readLiveCapDoc, resolveCappedProvidersPath } from "./provider-failover.mjs";
import { isForbiddenRealHome } from "./test-guard.mjs";
import { vibesquadHome } from "./user-settings.mjs";
import { CREDIT_POLL_INTERVAL_MS, CreditStore, createCreditPoller } from "../runner/limits.mjs";

export const DEFAULT_CREDIT_THRESHOLD_USD = 10;
export const CREDIT_GUARD_TEAM = "vibesquad";
export const CREDIT_GUARD_LANE = "usage";
const STATE_FILE = "credit-alerts.json";

// Auto circuit-breaker reasons written by server/backend/runner-backend.mjs capProviderOnUpstreamExit
// ("insufficient balance...", "upstream failure...", "binary missing...", "third-party quota..." idea-1077) plus BALANCE_ERROR_RE patterns.
const AUTO_FAULT_REASON_RE = /^(?:insufficient balance|upstream failure|binary missing|third-party quota)\b|insufficient[ _](?:account[ _])?balance|insufficient_quota|credit balance is too low|exceeded your current quota|\b402\W{0,3}payment required/i;
const AUTO_CAP_SOURCES = new Set(["auto", "breaker", "circuit-breaker", "balance", "upstream", "fault", "runner"]);
const DELIBERATE_CAP_SOURCES = new Set(["cli", "manual", "owner", "user"]);
const DELIBERATE_REASON_RE = /^(?:cli|manual|owner|user)\b|\b(?:cli|manual|owner)\s+cap\b/i;

/**
 * True only when a live cap entry is a deliberate owner/manual/cli cap (`vs cap add` -> reason "cli cap",
 * `setProviderCapped` default -> reason "manual cap", or explicit manual/owner reason/source).
 * Auto balance/upstream/binary circuit-breaker caps and ambiguous entries return false so a real top-up
 * alert is never silently suppressed.
 */
export function isDeliberateCap(entry) {
  if (entry === false || entry === null || entry === undefined || entry === 0 || entry === "false" || entry === "") {
    return false;
  }
  if (typeof entry === "string") {
    const r = entry.trim();
    if (!r || AUTO_FAULT_REASON_RE.test(r)) return false;
    return DELIBERATE_REASON_RE.test(r);
  }
  if (typeof entry !== "object") return false;
  const source = String(entry.source ?? "").trim().toLowerCase();
  const reason = String(entry.reason ?? "").trim();
  if (AUTO_CAP_SOURCES.has(source)) return false;
  if (reason && AUTO_FAULT_REASON_RE.test(reason)) return false;
  if (DELIBERATE_CAP_SOURCES.has(source)) return true;
  if (reason && DELIBERATE_REASON_RE.test(reason)) return true;
  return false;
}

/** Read live caps for `home` (or default cap path) via readLiveCapDoc().capped, respecting test-home isolation. */
export function readLiveCreditCaps({ home, cappedProvidersPath, now = Date.now() } = {}) {
  const capPath = cappedProvidersPath || (home ? path.join(home, "capped-providers.json") : resolveCappedProvidersPath({}));
  if (isForbiddenRealHome(path.dirname(capPath))) return {};
  return readLiveCapDoc({ cappedProvidersPath: capPath, now }).capped ?? {};
}

/** True when `provider` (or its capKin family, e.g. opencode <-> deepseek) has a live deliberate cap. */
export function isProviderDeliberatelyCapped(provider, caps) {
  const family = normalizeProviderFamily(provider);
  if (!family || !caps || typeof caps !== "object") return false;
  const kin = capKin(family);
  for (const [k, v] of Object.entries(caps)) {
    if (kin.includes(normalizeProviderFamily(k)) && isDeliberateCap(v)) return true;
  }
  return false;
}

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
 *  - Skips firing (and persists no "alerted" state) when the provider or its capKin family
 *    has a live deliberate (cli/manual/owner) cap. Auto balance-fault caps still fire.
 *  - Stays silent on subsequent checks below threshold (including across server restarts).
 *  - Re-arms only after balance rises strictly above thresholdUsd (balance > thresholdUsd).
 *  - Non-"ok" statuses (no-key, error) neither fire nor clear an armed alert.
 */
export async function evaluateCreditAlerts({
  credits,
  home,
  cappedProvidersPath,
  readCaps,
  thresholdUsd = DEFAULT_CREDIT_THRESHOLD_USD,
  now = Date.now,
  log = ({ text }) => appendVsLogEntry({ teamId: CREDIT_GUARD_TEAM, laneId: CREDIT_GUARD_LANE, agent: "vibesquad-server", type: "needs-you", text }),
} = {}) {
  const threshold = Number.isFinite(Number(thresholdUsd)) && Number(thresholdUsd) >= 0 ? Number(thresholdUsd) : DEFAULT_CREDIT_THRESHOLD_USD;
  const nowMs = now();
  const liveCaps = typeof readCaps === "function"
    ? (readCaps() ?? {})
    : readLiveCreditCaps({ home, cappedProvidersPath, now: nowMs });
  const state = readCreditAlertState(home);
  const fired = [];
  let dirty = false;

  for (const c of Array.isArray(credits) ? credits : []) {
    if (!c || c.status !== "ok" || typeof c.balance !== "number" || !Number.isFinite(c.balance) || !c.provider) continue;
    const provider = String(c.provider);
    const prev = state.providers[provider] && typeof state.providers[provider] === "object" ? state.providers[provider] : { alerted: false };
    const alerted = Boolean(prev.alerted);
    const nowIso = new Date(nowMs).toISOString();

    if (!alerted && c.balance < threshold) {
      if (isProviderDeliberatelyCapped(provider, liveCaps)) continue;
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
  cappedProvidersPath,
  readCaps,
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
  const capsPath = cappedProvidersPath || (home ? path.join(home, "capped-providers.json") : undefined);
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
      return await evaluateCreditAlerts({
        credits,
        home: dir,
        ...(capsPath ? { cappedProvidersPath: capsPath } : {}),
        ...(readCaps ? { readCaps } : {}),
        thresholdUsd,
        now,
        ...(log ? { log } : {}),
      });
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
