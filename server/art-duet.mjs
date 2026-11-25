// Art duet (Painter + Director): the profile pairs, and which Director still serves a live Painter.
// Shared by the spawn tool (server/mcp/tools.mjs: spawning one half starts the other) and the worker auto-close
// (server/hooks/agent-duties.ts: a Director is not closed while its Painter is live, idea-783).

// Old names pair with old names; P5c role names ("Art Painter" / "Art Director") pair with role names.
export const ART_DUET = {
  "Art Painter - Opus": "Art Director - Gemini",
  "Art Director - Gemini": "Art Painter - Opus",
  "Art Painter": "Art Director",
  "Art Director": "Art Painter",
};
export const ART_PAINTERS = new Set(["Art Painter - Opus", "Art Painter"]);

const clean = (v) => String(v ?? "").trim();
const DEAD = new Set(["closed", "error", "archived", "exited"]);

/** A duet member that still counts as live: not archived, not exited/closed/errored (idle/parked/queued/running all count). */
export function isLiveDuetMember(a) {
  return !!a && !a.archivedAt && !DEAD.has(clean(a.status).toLowerCase());
}

/** An Art Director half (by profile label) that names its job: the only kind of worker liveDuetPainterOf can hold. */
export function isDuetDirector(labels) {
  const profile = clean(labels?.profile);
  return !!profile && !ART_PAINTERS.has(profile) && !!ART_DUET[profile] && !!clean(labels?.job);
}

/**
 * idea-783: the id of the live Art Painter a Director serves, else null. The pair is the spawn tool's own key: the partner
 * profile, the same `job` label and the same lane. Only a Director is ever held this way (the Painter drives the loop and
 * closes on its own final report, which then frees its Director for the normal close paths).
 */
export function liveDuetPainterOf(director, agents) {
  const labels = director?.labels ?? {};
  if (!isDuetDirector(labels)) return null;
  const job = clean(labels.job);
  const painter = ART_DUET[clean(labels.profile)];
  const lane = clean(labels.lane).toLowerCase();
  const hit = (agents ?? []).find((a) => a && a.id !== director.id && isLiveDuetMember(a)
    && clean(a.labels?.profile) === painter && clean(a.labels?.job) === job && clean(a.labels?.lane).toLowerCase() === lane);
  return hit?.id ?? null;
}
