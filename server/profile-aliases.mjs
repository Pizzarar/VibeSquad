// Legacy profile aliases (docs/PLAN_PROFILES_ROLE_ONLY.md P5c, idea-77): the ONE alias table. Old/short spawn names ->
// the canonical old profile name. profiles.mjs re-exports it as LEGACY_PROFILE_ALIASES; provider-failover.mjs and the
// spawn hook (server/hooks/agent-duties.ts matchStoredProfile) read it from here. A leaf module (no imports) so
// provider-failover.mjs can use it without an import cycle through profiles.mjs (profiles.mjs calls
// registerDefaultFailoverProfiles at load). Workaround: removed with the old names in P5f.
export const LEGACY_PROFILE_ALIASES = Object.freeze({
  "Lead - Opus": "Lead - Claude",
  "Brainstorm - Opus": "Brainstorm - Claude",
  "Art - Gemini": "Art Director - Gemini",
  "Art - Opus": "Art Painter - Opus",
  "Builder - Gemini": "Lead - Gemini",
  "Reviewer - Gemini": "Review - Gemini",
  Lead: "Lead - Claude",
  Brainstorm: "Brainstorm - Claude",
  Buddy: "Brainstorm - Claude",
  RiffBot: "Brainstorm - Claude",
  Worker: "Implement - Sonnet",
  Coder: "Work Order - DSP",
  Reviewer: "Review - Gemini",
  Fast: "Pre-check - Flash",
});
