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

/** Every lane id and alias (lowercase) across the given lane defs: what a new lane id must not collide with. */
export function takenLaneIds(lanes) {
  return lanes.flatMap((l) => [l.id, ...(l.aliases ?? [])]).map((s) => String(s).toLowerCase());
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
 * The pinned team an idea most likely belongs to, or null. Done and removed lanes and the "_other" bucket are skipped.
 * `lanes` are teams.json lane defs ({ id, name, aliases?, state? }).
 */
export function bestOverlap(text, lanes) {
  let best = null;
  for (const lane of lanes) {
    if (!lane || lane.id === "_other" || lane.state === "done" || lane.state === "removed") continue;
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
export function newPinBrief(laneId, name, idea, { hub = false } = {}) {
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
    ...(hub ? ["## Teams", "- (none yet: one line per Team, state + current block)", "", "## Unsplit threads", "- (none yet)", ""] : []),
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

export const SPIN_OFF_MARKER = "vs:spin-off";
export const SPIN_OFF_MAX = 10;

/**
 * Parse a spin-off proposal: a fence opened by ```vs:spin-off, one Team per line as `Name | 1-line brief`.
 * A leading "- ", "* " or "1. " on the name is dropped. Blank and malformed lines (no `|`, empty name) are
 * skipped; at most SPIN_OFF_MAX rows. A fence nested inside another fence (````, ~~~, ```md) or a blockquote is an
 * example, not an offer; the LAST real vs:spin-off fence wins. Null when there is none or it has no valid row.
 */
export function parseSpinOff(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  let outer = null; // { ch, len, bareFirstLine } of an open non-spin-off fence
  let block = null; // rows of the open spin-off fence
  let last = null;
  for (const line of lines) {
    const f = /^ {0,3}(`{3,}|~{3,})\s*(.*?)\s*$/.exec(line);
    if (block) {
      if (f && f[1][0] === "`" && !f[2]) {
        last = block;
        block = null;
        continue;
      }
      if (!block.length && /^\s*vs:spin-off\s*$/i.test(line)) continue;
      const bar = line.indexOf("|");
      if (bar < 0 || block.length >= SPIN_OFF_MAX) continue;
      const name = line
        .slice(0, bar)
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
        .trim()
        .replace(/^(?:\*\*|`)+|(?:\*\*|`)+$/g, "")
        .trim();
      const brief = line.slice(bar + 1).trim();
      if (name && brief) block.push({ name, brief });
    } else if (outer) {
      if (f && f[1][0] === outer.ch && f[1].length >= outer.len && !f[2]) {
        outer = null;
      } else if (outer.bareFirstLine && line.trim()) {
        outer.bareFirstLine = false;
        if (/^\s*vs:spin-off\s*$/i.test(line)) {
          block = [];
          outer = null;
        }
      }
    } else if (f) {
      if (f[1] === "```" && f[2].toLowerCase() === "vs:spin-off") block = [];
      else outer = { ch: f[1][0], len: f[1].length, bareFirstLine: f[1] === "```" && !f[2] };
    }
  }
  if (block) last = block; // unterminated fence (message cut off)
  return last?.length ? last : null;
}

const hashText = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(36);
};

/**
 * Stable id of a send-to / spin-off card: `${kind}:*:${laneId|teamsKey}:${hash(normalized text)}`. It depends only on
 * what the card says, so it is the same in the hub bar and the inline Timeline card, does not change when the Buddy
 * posts again, and survives a Buddy resume that comes back under another agent id (`agentId` is accepted but not part of
 * the id). Ids stored before that carry the agent id in the `*` slot; `canonicalCardId` maps them to this form.
 */
export function cardId(kind, _agentId, key, text) {
  return `${kind}:*:${key}:${hashText(String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase())}`;
}

/** Old `send-to:<agentId>:...` / `spin-off:<agentId>:...` ids -> the agent-free form; anything else is returned as is. */
export const canonicalCardId = (id) => String(id).replace(/^(send-to|spin-off):[^:]+:/, "$1:*:");

export const sendToCardId = (agentId, offer) => cardId("send-to", agentId, String(offer.laneId).toLowerCase(), offer.text);

/**
 * The offer in the newest Brainstorm message, else null. `legacyIds` are the pre-D1 `${agentId}:${messageId}` ids that a
 * tab still running the old bundle writes when its card is fired, so such a dismissal keeps hiding this card.
 */
export function sendToFrom(agentId, entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const it = entries[i].item;
    if (it?.type !== "assistant_message" || typeof it.text !== "string") continue;
    const offer = parseSendTo(it.text);
    if (!offer) return null;
    return { ...offer, id: sendToCardId(agentId, offer), legacyIds: [`${agentId}:${it.id ?? it.messageId ?? entries[i].seqStart ?? entries[i].timestamp ?? it.text.length}`] };
  }
  return null;
}
export const spinOffCardId = (agentId, teams) =>
  cardId("spin-off", agentId, teams.map((t) => t.name).join(",").toLowerCase(), teams.map((t) => `${t.name}|${t.brief}`).join("\n"));

/** The spin-off offer in the newest assistant message of a Brainstorm timeline, else null. Same message-id scheme as sendToFrom. */
export function spinOffFrom(agentId, entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const it = entries[i].item;
    if (it?.type !== "assistant_message" || typeof it.text !== "string") continue;
    const teams = parseSpinOff(it.text);
    if (!teams) return null;
    return { teams, id: spinOffCardId(agentId, teams) };
  }
  return null;
}
