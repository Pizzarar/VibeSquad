// Per-model price table (USD per 1M tokens) so ACP adapters can put a costUsd on turn_done like the claude adapter does.
// Dated 2026-11-07, LIST-PRICE ESTIMATES (not read from any provider API): verify against the provider's pricing page
// when a number matters. Keys match by longest prefix after stripping a "provider/" prefix and a -low/-medium/-high/-minimal variant.
// Unknown model -> no price -> callers omit costUsd (never write 0).
export const MODEL_PRICES = {
  'deepseek-v4-pro': { input: 0.55, output: 2.2, cachedRead: 0.055 },
  'deepseek-v4-flash': { input: 0.14, output: 0.28, cachedRead: 0.014 },
  'deepseek-flash': { input: 0.14, output: 0.28, cachedRead: 0.014 },
  'gemini-4-argon': { input: 2, output: 12, cachedRead: 0.2 },
  'gemini-3.8-flash': { input: 0.5, output: 3, cachedRead: 0.05 },
};

export function normalizeModelId(model) {
  return String(model ?? '').toLowerCase().replace(/^[^/]+\//, '').replace(/-(minimal|low|medium|high)$/, '');
}

export function priceFor(model) {
  const id = normalizeModelId(model);
  if (!id) return null;
  const key = Object.keys(MODEL_PRICES).filter((k) => id === k || id.startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0];
  return key ? MODEL_PRICES[key] : null;
}

/** USD for one turn, or null when the model has no price. `inputTokens` is the whole prompt (fresh + cache read + cache write); cache writes bill at the input rate. */
export function estimateCostUsd(model, { inputTokens = 0, outputTokens = 0, cachedReadTokens = 0, cachedWriteTokens = 0 } = {}) {
  const p = priceFor(model);
  if (!p) return null;
  const read = Math.min(cachedReadTokens, inputTokens);
  const fresh = Math.max(0, inputTokens - read);
  return (fresh * p.input + read * (p.cachedRead ?? p.input) + outputTokens * p.output) / 1e6;
}
