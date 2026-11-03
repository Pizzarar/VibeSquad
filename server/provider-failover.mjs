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
};

const BUILTIN_ALIASES = {
  "Lead - Opus": "Lead - Claude",
  "Brainstorm - Opus": "Brainstorm - Claude",
  "Art - Gemini": "Art Director - Gemini",
  "Art - Opus": "Art Painter - Opus",
  "Builder - Gemini": "Lead - Gemini",
  "Reviewer - Gemini": "Review - Gemini",
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
];

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

export function isProviderOverQuota(providerId, usageProviders = [], threshold = QUOTA_FAILOVER_THRESHOLD) {
  const targetFamily = normalizeProviderFamily(providerId);
  if (!targetFamily) {
    return { overQuota: false, reason: null, usedPct: null };
  }
  const list = extractUsageList(usageProviders);
  const entry = list.find((item) => matchesProvider(item, targetFamily));
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
  const effectiveProfiles =
    Array.isArray(profiles) && profiles.length > 0
      ? profiles
      : registeredDefaultProfiles || BUILTIN_FALLBACK_PROFILES;

  const profile = lookupProfileInList(requestedNameOrProfile, effectiveProfiles);
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
  const check = isProviderOverQuota(profile.provider, usageProviders, threshold);
  if (!check.overQuota) {
    return {
      profile,
      failedOver: false,
      fromProfile: null,
      toProfile: null,
      reason: null,
    };
  }

  const targetName = counterpartProfileName(profile.name);
  let counterpart = targetName ? lookupProfileInList(targetName, effectiveProfiles) : null;

  if (!counterpart) {
    const curFamily = normalizeProviderFamily(profile.provider);
    const oppositeFamily = curFamily === "claude" ? "antigravity-cli" : curFamily === "antigravity-cli" ? "claude" : "";
    if (oppositeFamily) {
      counterpart =
        effectiveProfiles.find(
          (p) => p && p.role === profile.role && normalizeProviderFamily(p.provider) === oppositeFamily,
        ) ||
        effectiveProfiles.find((p) => p && normalizeProviderFamily(p.provider) === oppositeFamily) ||
        null;
    }
  }

  if (!counterpart) {
    return {
      profile,
      failedOver: false,
      fromProfile: profile.name,
      toProfile: null,
      reason: check.reason,
    };
  }

  const counterpartCheck = isProviderOverQuota(counterpart.provider, usageProviders, threshold);
  if (counterpartCheck.overQuota) {
    return {
      profile,
      failedOver: false,
      fromProfile: profile.name,
      toProfile: null,
      reason: check.reason,
    };
  }

  return {
    profile: counterpart,
    failedOver: true,
    fromProfile: profile.name,
    toProfile: counterpart.name,
    reason: check.reason,
  };
}
