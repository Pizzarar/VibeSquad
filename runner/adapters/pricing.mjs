// Per-model price table (USD per 1M tokens) so ACP adapters can put a costUsd on turn_done like the claude adapter does.
// Dated 2026-11-07, LIST-PRICE ESTIMATES (not read from any provider API): verify against the provider's pricing page
// when a number matters. Keys match by longest prefix after stripping a "provider/" prefix and a -low/-medium/-high/-minimal variant.
// Entries may be a flat { input, output, cachedRead } or a list of { from?: ISO date, input, output, cachedRead } tiers.
// Unknown model -> no price -> callers omit costUsd (never write 0).
export const MODEL_PRICES = {
  'deepseek-v4-pro': { input: 0.55, output: 2.2, cachedRead: 0.055 },
  'deepseek-v4-flash': { input: 0.14, output: 0.28, cachedRead: 0.014 },
  'deepseek-flash': { input: 0.14, output: 0.28, cachedRead: 0.014 },
  'gemini-4-argon': { input: 2, output: 12, cachedRead: 0.2 }, // retired by N1; kept so old runs still price
  'gemini-4-neon': { input: 3, output: 15, cachedRead: 0.15 }, // N1 2026-11-21: launch list price (secondary sources, 11-18)
  // usa-71 2026-11-27: intro -> GA list prices (secondary sources: apidog.com, braindetox.kr, aipricing.guru; Google page unconfirmed); thinking bills as output (already folded into outputTokens by parseAcpUsage)
  'gemini-4-carbon': [
    { input: 2, output: 10, cachedRead: 0.1 },
    { from: '2026-12-01T00:00:00Z', input: 4, output: 20, cachedRead: 0.2 },
  ],
  'gemini-3.8-flash': { input: 0.5, output: 3, cachedRead: 0.05 },
};

export function validateModelPrices(prices = MODEL_PRICES) {
  const badKeys = [];
  for (const [key, entry] of Object.entries(prices)) {
    const tiers = Array.isArray(entry) ? entry : [entry];
    for (const tier of tiers) {
      if (tier && tier.from != null) {
        if (Number.isNaN(Date.parse(tier.from))) {
          console.error(`Invalid 'from' date for ${key}: ${tier.from}`);
          badKeys.push(key);
          delete prices[key];
          break;
        }
      }
    }
  }
  return badKeys;
}

validateModelPrices(MODEL_PRICES);

export function normalizeModelId(model) {
  return String(model ?? '').toLowerCase().replace(/^[^/]+\//, '').replace(/-(minimal|low|medium|high)$/, '');
}

export function pickTier(entry, atMs) {
  if (!entry) return null;
  let tier = entry;
  if (Array.isArray(entry)) {
    const ts = atMs == null ? Date.now() : typeof atMs === 'string' ? Date.parse(atMs) : Number(atMs);
    let best = null;
    let bestFrom = -Infinity;
    for (const t of entry) {
      const from = t.from == null ? -Infinity : Date.parse(t.from);
      if (from <= ts && (best === null || from >= bestFrom)) { best = t; bestFrom = from; }
    }
    tier = best;
  }
  if (!tier) return null;
  const { from: _from, ...rest } = tier;
  if ('cachedRead' in rest && rest.cachedRead === undefined) {
    delete rest.cachedRead;
  }
  return rest;
}

export function priceFor(model, atMs = Date.now()) {
  const id = normalizeModelId(model);
  if (!id) return null;
  const key = Object.keys(MODEL_PRICES).filter((k) => id === k || id.startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0];
  return key ? pickTier(MODEL_PRICES[key], atMs) : null;
}

/** USD for one turn, or null when the model has no price. `inputTokens` is the whole prompt (fresh + cache read + cache write); cache writes bill at the input rate. */
export function estimateCostUsd(model, { inputTokens = 0, outputTokens = 0, cachedReadTokens = 0, cachedWriteTokens = 0 } = {}, atMs) {
  const p = priceFor(model, atMs);
  if (!p) return null;
  const read = Math.min(cachedReadTokens, inputTokens);
  const fresh = Math.max(0, inputTokens - read);
  return (fresh * p.input + read * (p.cachedRead ?? p.input) + outputTokens * p.output) / 1e6;
}
