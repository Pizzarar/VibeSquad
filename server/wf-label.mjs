// Workflow stamp at dispatch (PLAN_PER_POST03 P1, idea-223): every spawn carries a `wf` label naming its workflow arm, so
// @usage can attribute units from the run record (runner `created` event meta.labels.wf) without merge-subject `[wf:]` tags.
// The arm vocabulary matches the pilot tags already in git history: sonnet / opus / haiku / fable (Claude tiers),
// gemini / flash (Antigravity), dsp / dsf (DeepSeek pro / flash via opencode).

/** Label key carrying the workflow arm. Not protected or stripped by the runner, so a caller may set it (override wins). */
export const WF_LABEL = "wf";
/** Env twin of the label, for spawn paths that cannot pass labels. */
export const WF_ENV = "VS_WF";

const MAX_LEN = 40;

/** A caller-supplied arm, normalised (lowercase, [a-z0-9+._-] only, capped). "" when nothing usable. */
export function normalizeWfLabel(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[?wf:/, "")
    .replace(/\]$/, "")
    .replace(/[^a-z0-9+._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, MAX_LEN);
}

function familyOf(provider) {
  const p = String(provider ?? "").trim().toLowerCase().split("/")[0];
  if (!p) return "";
  if (p === "claude" || p === "anthropic" || p.startsWith("claude-")) return "claude";
  if (p === "antigravity-cli" || p === "antigravity" || p === "agy" || p === "gemini" || p.startsWith("gemini-")) return "gemini";
  if (p === "opencode" || p.includes("deepseek") || p === "dsp") return "deepseek";
  return p;
}

/**
 * Default arm from the resolved provider + model (the model the spawn ends up with after failover and the stakes ladder),
 * falling back to the profile's model, then its name. Returns "unknown" only when nothing identifies the arm.
 */
export function deriveWfArm({ provider, model, profile } = {}) {
  const profModel = String(profile?.model ?? "").trim();
  const profName = String(profile?.name ?? "").trim().toLowerCase();
  const m = String(model ?? "").trim().toLowerCase() || profModel.toLowerCase();
  // A model id may name its own family (e.g. "deepseek/deepseek-flash", "claude-opus-5-5") when the provider is missing.
  const fam = familyOf(provider) || familyOf(profile?.provider) || familyOf(m);
  // The resolved model decides; the profile name only when no model is known (a ladder-upgraded Sonnet profile is opus).
  const hay = m || profName;
  if (fam === "claude") {
    for (const tier of ["opus", "sonnet", "haiku", "fable"]) if (hay.includes(tier)) return tier;
    return "claude";
  }
  if (fam === "gemini") return /flash/.test(hay) ? "flash" : "gemini";
  if (fam === "deepseek") return /flash|\bdsf\b/.test(hay) ? "dsf" : "dsp";
  return normalizeWfLabel(fam) || "unknown";
}

// R0 (PLAN_PER_ROLES_LADDER_1125): an implementer arm picked by spawn_worker (`vs.arm` label) names its wf only when the
// spawn really runs on that arm's family: the Neon arm on Gemini is wf=neon (Gemini reviewers/leads keep wf=gemini); a Neon
// pick that failed over to Claude derives sonnet/opus like any other spawn.
const ARM_WF_FROM = { neon: "gemini" };

/** The `wf` label for a spawn: the caller's label, else its VS_WF env, else the derived arm (refined by a `vs.arm` pick). */
export function resolveWfLabel({ labels, env, provider, model, profile } = {}) {
  const given = normalizeWfLabel(labels?.[WF_LABEL]) || normalizeWfLabel(env?.[WF_ENV]);
  if (given) return given;
  const derived = deriveWfArm({ provider, model, profile });
  const arm = normalizeWfLabel(labels?.["vs.arm"]);
  return arm && ARM_WF_FROM[arm] === derived ? arm : derived;
}
