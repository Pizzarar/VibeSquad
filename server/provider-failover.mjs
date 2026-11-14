import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { updateJsonFileSync } from "./file-lock.mjs";

export const QUOTA_FAILOVER_THRESHOLD = 95;

export const COUNTERPART_PROFILES = {
  "Lead - Claude": "Lead - Gemini",
  "Lead - Gemini": "Lead - Claude",
  "Brainstorm - Claude": "Brainstorm - Gemini",
  "Brainstorm - Gemini": "Brainstorm - Claude",
  "Review - Sonnet": "Review - Gemini",
  "Review - Gemini": "Review - Sonnet",
  "Check - Haiku": "Pre-check - Flash",
  "Pre-check - Flash": "Check - Haiku",
  "Art Painter - Opus": "Art Director - Gemini",
  "Art Director - Gemini": "Art Painter - Opus",
  "Implement - Sonnet": "Lead - Gemini",
  "Implement - Opus": "Lead - Gemini",
  "Planner - Sonnet": "Lead - Gemini",
  "Spec - Opus": "Lead - Gemini",
  "Work Order - DSP": "Implement - Sonnet",
  "Mechanical - DSF": "Pre-check - Flash",
  "Audit - DSF": "Scout - Flash",
  "Senior Reasoning - DSP": "Lead - Gemini",
};

const BUILTIN_ALIASES = {
  "Lead - Opus": "Lead - Claude",
  "Brainstorm - Opus": "Brainstorm - Claude",
  "Art - Gemini": "Art Director - Gemini",
  "Art - Opus": "Art Painter - Opus",
  "Builder - Gemini": "Lead - Gemini",
  "Reviewer - Gemini": "Review - Gemini",
  "Lead": "Lead - Claude",
  "Brainstorm": "Brainstorm - Claude",
  "Buddy": "Brainstorm - Claude",
  "RiffBot": "Brainstorm - Claude",
  "Worker": "Implement - Sonnet",
  "Coder": "Work Order - DSP",
  "Reviewer": "Review - Gemini",
  "Fast": "Pre-check - Flash",
};

const BUILTIN_FALLBACK_PROFILES = [
  { name: "Lead - Claude", role: "lead", provider: "claude", model: "claude-opus-5-5", modeId: "auto", thinkingOptionId: "medium" },
  {
    name: "Lead - Gemini",
    role: "lead",
    provider: "antigravity-cli",
    model: "gemini-4-argon",
    modeId: "accept-edits",
    thinkingOptionId: "medium",
    featureValues: { approvalPolicy: "skip", shareMcp: "on" },
  },
  { name: "Brainstorm - Claude", role: "brainstorm", provider: "claude", model: "claude-opus-5-5", modeId: "auto", thinkingOptionId: "medium" },
  {
    name: "Brainstorm - Gemini",
    role: "brainstorm",
    provider: "antigravity-cli",
    model: "gemini-4-argon",
    modeId: "accept-edits",
    thinkingOptionId: "medium",
    featureValues: { approvalPolicy: "skip", shareMcp: "on" },
  },
  { name: "Spec - Opus", role: "worker", provider: "claude", model: "claude-opus-5-5", modeId: "auto", thinkingOptionId: "medium" },
  { name: "Planner - Sonnet", role: "worker", provider: "claude", model: "claude-sonnet-5-5", modeId: "auto", thinkingOptionId: "medium" },
  { name: "Implement - Sonnet", role: "worker", provider: "claude", model: "claude-sonnet-5-5", modeId: "auto", thinkingOptionId: "medium" },
  { name: "Implement - Opus", role: "worker", provider: "claude", model: "claude-opus-5-5", modeId: "auto", thinkingOptionId: "medium" },
  { name: "Review - Sonnet", role: "worker", provider: "claude", model: "claude-sonnet-5-5", modeId: "auto", thinkingOptionId: "medium" },
  {
    name: "Review - Gemini",
    role: "worker",
    provider: "antigravity-cli",
    model: "gemini-4-argon",
    modeId: "default",
    thinkingOptionId: "medium",
    featureValues: { approvalPolicy: "skip" },
  },
  { name: "Check - Haiku", role: "worker", provider: "claude", model: "claude-haiku-5-5", modeId: "auto", thinkingOptionId: "low" },
  {
    name: "Pre-check - Flash",
    role: "worker",
    provider: "antigravity-cli",
    model: "gemini-3.8-flash",
    modeId: "default",
    thinkingOptionId: "low",
    featureValues: { approvalPolicy: "skip" },
  },
  {
    name: "Art Director - Gemini",
    role: "worker",
    provider: "antigravity-cli",
    model: "gemini-4-argon",
    modeId: "accept-edits",
    thinkingOptionId: "medium",
    featureValues: { approvalPolicy: "skip", sandbox: "off", shareMcp: "off" },
  },
  { name: "Art Painter - Opus", role: "worker", provider: "claude", model: "claude-opus-5-5", modeId: "auto", thinkingOptionId: "medium" },
  { name: "Work Order - DSP", role: "worker", provider: "opencode", model: "deepseek/deepseek-v4-pro", modeId: "build", thinkingOptionId: "high" },
  { name: "Mechanical - DSF", role: "worker", provider: "opencode", model: "deepseek/deepseek-v4-flash", modeId: "build", thinkingOptionId: "medium" },
  { name: "Audit - DSF", role: "worker", provider: "opencode", model: "deepseek/deepseek-v4-flash", modeId: "plan", thinkingOptionId: "medium" },
  { name: "Senior Reasoning - DSP", role: "worker", provider: "opencode", model: "deepseek/deepseek-v4-pro", modeId: "build", thinkingOptionId: "high" },
];

export const ROLE_FAILOVER_CHAINS = {
  "Lead - Claude": ["Lead - Gemini", "Senior Reasoning - DSP"],
  "Lead - Gemini": ["Lead - Claude", "Senior Reasoning - DSP"],
  "Brainstorm - Claude": ["Brainstorm - Gemini", "Senior Reasoning - DSP"],
  "Brainstorm - Gemini": ["Brainstorm - Claude", "Senior Reasoning - DSP"],
  "Implement - Sonnet": ["Lead - Gemini", "Work Order - DSP"],
  "Implement - Opus": ["Lead - Gemini", "Work Order - DSP"],
  "Planner - Sonnet": ["Lead - Gemini", "Senior Reasoning - DSP"],
  "Spec - Opus": ["Lead - Gemini", "Senior Reasoning - DSP"],
  "Work Order - DSP": ["Implement - Sonnet", "Lead - Gemini"],
  "Mechanical - DSF": ["Pre-check - Flash", "Check - Haiku"],
  "Review - Sonnet": ["Review - Gemini", "Senior Reasoning - DSP"],
  "Review - Gemini": ["Review - Sonnet", "Check - Haiku"],
  "Check - Haiku": ["Pre-check - Flash", "Audit - DSF"],
  "Pre-check - Flash": ["Check - Haiku", "Audit - DSF"],
};

let registeredDefaultProfiles = null;

export function registerDefaultFailoverProfiles(profiles) {
  if (Array.isArray(profiles) && profiles.length > 0) {
    registeredDefaultProfiles = profiles;
  }
}

export function normalizeProviderFamily(providerId) {
  const raw = String(providerId ?? "")
    .trim()
    .toLowerCase()
    .split("/")[0]
    .trim();
  if (!raw) return "";
  if (raw === "claude" || raw === "anthropic" || raw.startsWith("claude-")) return "claude";
  if (raw === "antigravity-cli" || raw === "antigravity" || raw === "gemini" || raw.startsWith("gemini-")) {
    return "antigravity-cli";
  }
  return raw;
}

export function counterpartProfileName(profileName) {
  const raw = String(profileName ?? "").trim();
  if (!raw) return null;
  if (COUNTERPART_PROFILES[raw]) return COUNTERPART_PROFILES[raw];
  const aliased = BUILTIN_ALIASES[raw];
  if (aliased && COUNTERPART_PROFILES[aliased]) return COUNTERPART_PROFILES[aliased];
  const ciKey = Object.keys(COUNTERPART_PROFILES).find((k) => k.toLowerCase() === raw.toLowerCase());
  if (ciKey) return COUNTERPART_PROFILES[ciKey];
  if (/(?:\s*-\s*)Claude$/i.test(raw)) {
    return raw.replace(/(-\s*)Claude$/i, "$1Gemini");
  }
  if (/(?:\s*-\s*)Gemini$/i.test(raw)) {
    return raw.replace(/(-\s*)Gemini$/i, "$1Claude");
  }
  return null;
}

function extractUsageList(usageProviders) {
  if (Array.isArray(usageProviders)) return usageProviders;
  if (usageProviders && typeof usageProviders === "object") {
    if (Array.isArray(usageProviders.providers)) return usageProviders.providers;
    if (Array.isArray(usageProviders.entries)) return usageProviders.entries;
    if (Array.isArray(usageProviders.usage)) return usageProviders.usage;
  }
  return [];
}

function matchesProvider(entry, targetFamily) {
  if (!entry || typeof entry !== "object" || !targetFamily) return false;
  const candidates = [entry.id, entry.sourceId, entry.provider, entry.name, entry.sourceLabel];
  for (const c of candidates) {
    if (c && normalizeProviderFamily(c) === targetFamily) return true;
  }
  return false;
}

export function resolveCappedProvidersPath(opts = {}) {
  if (opts.cappedProvidersPath) return opts.cappedProvidersPath;
  if (process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH) return process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH;
  const base = process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
  return join(base, "capped-providers.json");
}

/** A cap with no reset time is assumed to clear with the 5 h usage window. */
export const CAP_DEFAULT_TTL_MS = 5 * 60 * 60 * 1000;

/** When a cap stops applying, in ms epoch: its reset time if it carries one, else updatedAt + 5 h. Null = unknown age, never expires. */
export function capExpiryMs(entry) {
  if (!entry || typeof entry !== "object") return null;
  for (const k of ["resetsAt", "resetAt", "resetTime"]) {
    const raw = entry[k];
    if (raw === undefined || raw === null || raw === "") continue;
    const num = typeof raw === "number" ? raw : /^\d+(\.\d+)?$/.test(String(raw).trim()) ? Number(raw) : NaN;
    // Epoch seconds (< 1e11, year ~5138 in ms) are common in provider payloads; ms values are larger.
    const t = Number.isFinite(num) ? (num < 1e11 ? num * 1000 : num) : Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  const at = Date.parse(entry.updatedAt);
  return Number.isFinite(at) ? at + CAP_DEFAULT_TTL_MS : null;
}

export function isCapExpired(entry, now = Date.now()) {
  const exp = capExpiryMs(entry);
  return exp !== null && exp <= now;
}

const parseCapFile = (text) => {
  const parsed = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  const capped = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed.capped ?? parsed) : null;
  return capped && typeof capped === "object" && !Array.isArray(capped) ? capped : null;
};

/**
 * Drop expired caps from the file. Re-reads right before writing under the file lock so a cap added by a concurrent
 * writer is kept, and writes atomically so a reader never sees a half-written file. Best effort: a failure leaves the file as it was.
 */
export function pruneExpiredCapsFile(path, now = Date.now()) {
  try {
    updateJsonFileSync(path, (doc) => {
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) return doc;
      const hasWrapper = doc.capped && typeof doc.capped === "object" && !Array.isArray(doc.capped);
      const current = hasWrapper ? doc.capped : doc;
      const live = Object.fromEntries(Object.entries(current).filter(([, v]) => !isCapExpired(v, now)));
      return { ...(hasWrapper ? doc : {}), capped: live };
    }, { fallback: { capped: {} }, timeoutMs: 0 });
  } catch {
    /* best effort: leave file as it was */
  }
}

/** Read the raw `{ capped: { ... } }` object directly from disk (never merges in-memory opts). Expired caps are dropped and pruned from the file. */
function readDiskCaps(opts = {}) {
  const path = resolveCappedProvidersPath(opts);
  let capped;
  try {
    capped = parseCapFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
  if (!capped) return {};
  const now = opts.now ?? Date.now();
  const live = {};
  let pruned = false;
  for (const [k, v] of Object.entries(capped)) {
    if (isCapExpired(v, now)) pruned = true;
    else live[k] = v;
  }
  if (pruned) pruneExpiredCapsFile(path, now);
  return live;
}

/** `{ capped: {...} }` with expired caps removed (and pruned from disk): what `vs cap list` shows. */
export function readLiveCapDoc(opts = {}) {
  return { capped: readDiskCaps(opts) };
}

function isFamilyCapped(caps, targetFamily) {
  if (!caps) return false;
  if (Array.isArray(caps)) {
    return caps.some((id) => normalizeProviderFamily(id) === targetFamily);
  }
  if (caps instanceof Set) {
    for (const id of caps) {
      if (normalizeProviderFamily(id) === targetFamily) return true;
    }
    return false;
  }
  if (typeof caps === "object") {
    for (const [k, v] of Object.entries(caps)) {
      if (normalizeProviderFamily(k) === targetFamily) {
        return v !== false && v !== null && v !== undefined && v !== 0 && v !== "false" && v !== "";
      }
    }
  }
  return false;
}

export function readCappedProviders(opts = {}) {
  const result = {};

  // In-memory overrides (array / Set / object) take priority.
  const overrides = opts.cappedProviders;
  if (overrides) {
    if (Array.isArray(overrides)) {
      for (const id of overrides) {
        const family = normalizeProviderFamily(id);
        if (family) result[family] = { reason: "capped", updatedAt: null };
      }
    } else if (overrides instanceof Set) {
      for (const id of overrides) {
        const family = normalizeProviderFamily(id);
        if (family) result[family] = { reason: "capped", updatedAt: null };
      }
    } else if (typeof overrides === "object") {
      for (const [k, v] of Object.entries(overrides)) {
        const family = normalizeProviderFamily(k);
        if (!family) continue;
        if (v === false || v === null || v === undefined) {
          delete result[family];
          continue;
        }
        result[family] =
          v && typeof v === "object" ? v : { reason: String(v ?? "capped"), updatedAt: null };
      }
    }
  }

  // Disk caps: only read when explicitly enabled or the path env var is set,
  // so unit tests passing mock usageProviders aren't polluted by host disk state.
  const readDisk = (opts.useDiskCaps === true || !!process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH) && opts.ignoreDiskCaps !== true;
  if (readDisk) {
    const disk = readDiskCaps(opts);
    for (const [k, v] of Object.entries(disk)) {
      const family = normalizeProviderFamily(k);
      if (!family) continue;
      result[family] = v && typeof v === "object" ? v : { reason: String(v ?? "capped"), updatedAt: null };
    }
  }

  return result;
}

export function setProviderCapped(providerId, capped = true, { reason = "manual cap", normalizeKey = true, ...opts } = {}) {
  const key = normalizeKey ? normalizeProviderFamily(providerId) : String(providerId ?? "").trim().toLowerCase();
  if (!key) return readCappedProviders(opts);

  const path = resolveCappedProvidersPath(opts);
  const now = opts.now ?? Date.now();
  const next = updateJsonFileSync(
    path,
    (doc) => {
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        throw new Error(`Invalid capped-providers.json structure at ${path}`);
      }
      const hasWrapper = doc.capped && typeof doc.capped === "object" && !Array.isArray(doc.capped);
      const rawMap = hasWrapper ? doc.capped : doc;
      const live = {};
      for (const [k, v] of Object.entries(rawMap)) {
        if (!isCapExpired(v, now)) live[k] = v;
      }
      if (capped) {
        live[key] = { reason, updatedAt: new Date(now).toISOString() };
      } else {
        delete live[key];
        if (!normalizeKey) {
          const fam = normalizeProviderFamily(key);
          if (fam && fam !== key) delete live[fam];
        }
      }
      return { ...(hasWrapper ? doc : {}), capped: live };
    },
    { fallback: { capped: {} }, ...opts },
  );
  return next.capped;
}

export function isProviderOverQuota(providerId, usageProviders = [], threshold = QUOTA_FAILOVER_THRESHOLD, opts = {}) {
  const targetFamily = normalizeProviderFamily(providerId);
  if (!targetFamily) {
    return { overQuota: false, reason: null, usedPct: null };
  }

  // In-memory cap overrides are checked first.
  if (opts.cappedProviders && isFamilyCapped(opts.cappedProviders, targetFamily)) {
    return { overQuota: true, reason: `${targetFamily} is marked capped`, usedPct: 100 };
  }

  const list = extractUsageList(usageProviders);
  const entry = list.find((item) => matchesProvider(item, targetFamily));

  // Persistent disk caps only apply when usage data doesn't already specify the provider,
  // and only when the path env var is set or disk caps are explicitly enabled.
  if (!entry && opts.ignoreDiskCaps !== true) {
    const readDisk = opts.useDiskCaps === true || !!process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH;
    if (readDisk && readCappedProviders(opts)[targetFamily]) {
      return { overQuota: true, reason: `${targetFamily} is marked capped`, usedPct: 100 };
    }
  }

  if (!entry) {
    return { overQuota: false, reason: null, usedPct: null };
  }

  const limitThreshold = typeof threshold === "number" && Number.isFinite(threshold) ? threshold : QUOTA_FAILOVER_THRESHOLD;
  const status = String(entry.status ?? entry?.report?.status ?? "")
    .trim()
    .toLowerCase();
  const windows = Array.isArray(entry.windows)
    ? entry.windows
    : Array.isArray(entry?.report?.windows)
      ? entry.report.windows
      : [];

  const topUsed = typeof entry.usedPct === "number" && Number.isFinite(entry.usedPct) ? entry.usedPct : null;
  const topRemaining = typeof entry.remainingPct === "number" && Number.isFinite(entry.remainingPct) ? entry.remainingPct : null;

  let maxWinUsed = null;
  let minWinRemaining = null;
  for (const w of windows) {
    if (!w || typeof w !== "object") continue;
    if (typeof w.usedPct === "number" && Number.isFinite(w.usedPct)) {
      maxWinUsed = maxWinUsed === null ? w.usedPct : Math.max(maxWinUsed, w.usedPct);
    }
    if (typeof w.remainingPct === "number" && Number.isFinite(w.remainingPct)) {
      minWinRemaining = minWinRemaining === null ? w.remainingPct : Math.min(minWinRemaining, w.remainingPct);
    }
  }

  let effectiveUsedPct = topUsed;
  if (effectiveUsedPct === null && topRemaining !== null) {
    effectiveUsedPct = Math.max(0, Math.min(100, 100 - topRemaining));
  }
  if (maxWinUsed !== null) {
    effectiveUsedPct = effectiveUsedPct === null ? maxWinUsed : Math.max(effectiveUsedPct, maxWinUsed);
  }
  if (effectiveUsedPct === null && minWinRemaining !== null) {
    effectiveUsedPct = Math.max(0, Math.min(100, 100 - minWinRemaining));
  }

  if (status === "unavailable" || status === "error" || status === "exhausted") {
    return {
      overQuota: true,
      reason: `${targetFamily} status is ${status}`,
      usedPct: effectiveUsedPct,
    };
  }

  const remainingTrigger = 100 - limitThreshold;
  const overByTopUsed = topUsed !== null && topUsed >= limitThreshold;
  const overByTopRemaining = topRemaining !== null && topRemaining <= remainingTrigger;
  const overByWinUsed = maxWinUsed !== null && maxWinUsed >= limitThreshold;
  const overByWinRemaining = minWinRemaining !== null && minWinRemaining <= remainingTrigger;

  if (overByTopUsed || overByTopRemaining || overByWinUsed || overByWinRemaining) {
    const reportedPct = effectiveUsedPct ?? limitThreshold;
    return {
      overQuota: true,
      reason: `${targetFamily} usage ${reportedPct}% >= ${limitThreshold}%`,
      usedPct: effectiveUsedPct,
    };
  }

  return {
    overQuota: false,
    reason: null,
    usedPct: effectiveUsedPct,
  };
}

function lookupProfileInList(nameOrProfile, list) {
  if (!nameOrProfile) return null;
  if (typeof nameOrProfile === "object") return nameOrProfile;
  const raw = String(nameOrProfile).trim();
  if (!raw) return null;
  const resolved = BUILTIN_ALIASES[raw] || raw;
  const exact = list.find((p) => p && p.name === resolved);
  if (exact) return exact;
  const byId = list.find((p) => p && p.id && p.id === raw);
  if (byId) return byId;
  const lower = resolved.toLowerCase();
  const ci = list.find((p) => p && String(p.name || "").toLowerCase() === lower);
  if (ci) return ci;
  return null;
}

export function resolveProfileWithFailover(requestedNameOrProfile, profiles = [], usageProviders = [], opts = {}) {
  const defaultPool = registeredDefaultProfiles || BUILTIN_FALLBACK_PROFILES;
  const effectiveProfiles =
    Array.isArray(profiles) && profiles.length > 0
      ? profiles
      : defaultPool;

  const profile =
    lookupProfileInList(requestedNameOrProfile, effectiveProfiles) ||
    lookupProfileInList(requestedNameOrProfile, defaultPool);
  if (!profile) {
    return {
      profile: null,
      failedOver: false,
      fromProfile: typeof requestedNameOrProfile === "string" ? requestedNameOrProfile : null,
      toProfile: null,
      reason: null,
    };
  }

  const threshold = opts?.threshold ?? QUOTA_FAILOVER_THRESHOLD;
  const check = isProviderOverQuota(profile.provider, usageProviders, threshold, opts);
  if (!check.overQuota) {
    return {
      profile,
      failedOver: false,
      fromProfile: null,
      toProfile: null,
      reason: null,
    };
  }

  // Build the failover candidate list: counterpart first, then the role failover
  // chain, then any same-role profiles from other provider families.
  const seen = new Set([profile.name]);
  const candidates = [];
  const push = (name) => {
    const raw = String(name ?? "").trim();
    if (!raw || seen.has(raw)) return;
    seen.add(raw);
    candidates.push(raw);
  };

  push(counterpartProfileName(profile.name));
  const chain = ROLE_FAILOVER_CHAINS[profile.name] || [];
  for (const name of chain) push(name);

  const curFamily = normalizeProviderFamily(profile.provider);
  for (const p of effectiveProfiles) {
    if (!p || !p.name) continue;
    if (p.role === profile.role && normalizeProviderFamily(p.provider) !== curFamily) {
      push(p.name);
    }
  }

  for (const name of candidates) {
    const cand =
      lookupProfileInList(name, effectiveProfiles) ||
      lookupProfileInList(name, defaultPool);
    if (!cand || !cand.provider) continue;
    if (cand.name === profile.name) continue;
    const candCheck = isProviderOverQuota(cand.provider, usageProviders, threshold, opts);
    if (!candCheck.overQuota) {
      return {
        profile: cand,
        failedOver: true,
        fromProfile: profile.name,
        toProfile: cand.name,
        reason: check.reason,
      };
    }
  }

  return {
    profile,
    failedOver: false,
    fromProfile: profile.name,
    toProfile: null,
    reason: check.reason,
  };
}
