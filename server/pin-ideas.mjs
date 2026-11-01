// Pinned teams step 6 (docs/PLAN_PINNED_FEATURES.md §5): idea capture helpers shared by the UI
// (src/pins.ts re-exports them) and `vs pin new` (cli/vs.mjs). Pure: no fs, no fetch.

/** Lane id from a team name: lowercase, dashes, max 32 chars. */
export function slugLaneId(name) {
  const slug = String(name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || "team";
}

/** `base`, or `base-2`, `base-3`… when it is taken (case-insensitive). */
export function uniqueLaneId(base, taken) {
  const used = new Set([...taken].map((s) => String(s).toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!used.has(id)) return id;
  }
}

const STOP = new Set(
  "a an and are as at be but by can do for from get how i if in into is it its just me my new of on or our so some that the then this to up we what when with x thought think idea team teams".split(" "),
);

/** Content words of a text (lowercase, plural s dropped, stop words removed). */
export function ideaWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** Overlap needed before an idea is offered to an existing team instead of a new one. */
export const OVERLAP_THRESHOLD = 0.5;

/**
 * How much of a team's name the idea text covers, 0..1. Words count by length, so the distinctive
 * word ("scavenging") matters more than "ui". A word matches exactly or by a shared 5-letter stem.
 */
export function overlapScore(text, lane) {
  const have = new Set(ideaWords(text));
  const names = [lane.name, ...(lane.aliases ?? [])];
  let best = 0;
  for (const n of names) {
    const want = [...new Set(ideaWords(n))];
    if (!want.length) continue;
    const total = want.reduce((s, w) => s + w.length, 0);
    const hit = want
      .filter((w) => have.has(w) || (w.length >= 5 && [...have].some((h) => h.length >= 5 && h.slice(0, 5) === w.slice(0, 5))))
      .reduce((s, w) => s + w.length, 0);
    best = Math.max(best, hit / total);
  }
  return best;
}

/**
 * The pinned team an idea most likely belongs to, or null. Done lanes and the "_other" bucket are skipped.
 * `lanes` are teams.json lane defs ({ id, name, aliases?, state? }).
 */
export function bestOverlap(text, lanes) {
  let best = null;
  for (const lane of lanes) {
    if (!lane || lane.id === "_other" || lane.state === "done") continue;
    const score = String(lane.name).toLowerCase() === String(text).trim().toLowerCase() ? 1 : overlapScore(text, lane);
    if (score >= OVERLAP_THRESHOLD && (!best || score > best.score)) best = { lane, score };
  }
  return best;
}

/** First line of an idea, trimmed to a short team name. */
export function nameFromIdea(text) {
  const first = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const clean = first.replace(/^(i just thought of|what about|idea:)\s*/i, "").replace(/[.!?]+$/, "");
  return clean.length > 40 ? `${clean.slice(0, 40).replace(/\s+\S*$/, "")}` : clean;
}

/** A fresh team brief (same sections as server/brainstorm.mjs) with the idea under Open. */
export function newPinBrief(laneId, name, idea) {
  const ideaLines = String(idea ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return [
    `# Brainstorm Summary · ${String(name || laneId).toUpperCase()} (\`${laneId}\`)`,
    "",
    "> Rolling team brief (< ~5k tokens). Updated on every decision.",
    "",
    "## Who's here",
    "- (VibeSquad fills this in)",
    "",
    "## Done when",
    "- (what makes this team finished)",
    "",
    "## Decided",
    "- (none recorded yet)",
    "",
    "## Open",
    ...(ideaLines.length ? [`- ${ideaLines[0]}`, ...ideaLines.slice(1).map((l) => `  ${l}`)] : ["- (none recorded yet)"]),
    "",
    "## In flight",
    "- (none recorded yet)",
    "",
  ].join("\n");
}

/** The fenced line a Brainstorm posts under "That sounds like <Team>. Send it there?". */
export const SEND_TO_MARKER = "vs:send-to";

/**
 * Parse a misroute offer: a line `vs:send-to <lane-id>` (fenced or bare), the idea text on the
 * following lines up to the closing fence. Returns null when the message has no such line.
 */
export function parseSendTo(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^vs:send-to\s+([A-Za-z0-9_-]+)\s*$/.exec(lines[i].replace(/`/g, "").trim());
    if (!m) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*```/.test(lines[j])) break;
      body.push(lines[j]);
    }
    const idea = body.join("\n").trim();
    return { laneId: m[1], text: idea };
  }
  return null;
}
