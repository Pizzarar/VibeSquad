// E2 (docs/PLAN_ANDROID_END_STATE.md Phase 2): the structured Overlord escalation. Pure, no React: test/decision-card.test.mjs imports this directly.
//
//   ```vs:decision
//   summary: Merge of unit-x is blocked: 2 tests fail on master.
//   do: Rebase unit-x on master and rerun the suite
//   alt: Merge anyway and fix forward
//   alt: Hold the merge until the owner reviews
//   vs:riff @and
//   ```
//
// `summary` and `do` are required; `alt` repeats; the riff route is optional and must be a lane slug (anything else is dropped, the card stays).
import { cardId } from "../server/pin-ideas.mjs";

export const DECISION_MARKER = "vs:decision";
export const DECISION_MAX_ALTS = 6;
const FIELD_MAX = 240;

export type Decision = {
  summary: string;
  action: string;
  alternatives: string[];
  /** Lane slug of the Buddy to jump to, without the `@`. */
  riffLane: string | null;
};

export type DecisionOffer = Decision & { id: string };

/** A lane id as teams.json writes it: lowercase letters/digits, `-` or `_` inside. Rejects paths, spaces, markup. */
export const LANE_SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, FIELD_MAX);

/** `@and`, `and`, `` `@and` `` -> `and`; null when it is not a lane slug. */
export function parseRiffLane(raw: string): string | null {
  const v = raw.replace(/`/g, "").trim().replace(/^@/, "");
  return LANE_SLUG.test(v) ? v : null;
}

/** Parse the BODY of a vs:decision fence. Null when `summary` or `do` is missing/empty. */
export function parseDecision(body: string): Decision | null {
  let summary = "";
  let action = "";
  let riffLane: string | null = null;
  const alternatives: string[] = [];
  for (const line of String(body ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const t = line.trim();
    if (!t || /^```/.test(t)) continue;
    const riff = /^(?:vs:riff|riff)\s*:?\s+(\S+)\s*$/i.exec(t);
    if (riff) {
      riffLane = parseRiffLane(riff[1]);
      continue;
    }
    const f = /^([A-Za-z]+)\s*:\s*(.*)$/.exec(t);
    if (!f) continue;
    const key = f[1].toLowerCase();
    const val = clip(f[2]);
    if (!val) continue;
    if (key === "summary" && !summary) summary = val;
    else if ((key === "do" || key === "action" || key === "recommend") && !action) action = val;
    else if ((key === "alt" || key === "alternative" || key === "option") && alternatives.length < DECISION_MAX_ALTS) alternatives.push(val);
  }
  if (!summary || !action) return null;
  return { summary, action, alternatives: alternatives.filter((a) => a.toLowerCase() !== action.toLowerCase()), riffLane };
}

/** Stable, agent-free id (same scheme as send-to / spin-off): the dismissal follows the card text across resumes and devices. */
export const decisionCardId = (agentId: string, d: Decision): string =>
  cardId("decision", agentId, d.riffLane ?? "-", [d.summary, d.action, ...d.alternatives].join("\n"));

/** The last REAL vs:decision fence in a message. A fence nested in another fence (````, ~~~, ```md) is an example, not an offer. */
export function decisionFromText(agentId: string, text: string): DecisionOffer | null {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  let outer: { ch: string; len: number } | null = null;
  let block: string[] | null = null;
  let last: string[] | null = null;
  for (const line of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})\s*(\S*)\s*$/.exec(line);
    if (block) {
      if (f && f[1][0] === "`" && f[1].length >= 3 && !f[2]) {
        last = block;
        block = null;
      } else block.push(line);
    } else if (outer) {
      if (f && f[1][0] === outer.ch && f[1].length >= outer.len && !f[2]) outer = null;
    } else if (f) {
      if (f[1] === "```" && f[2].toLowerCase() === DECISION_MARKER) block = [];
      else outer = { ch: f[1][0], len: f[1].length };
    }
  }
  if (block) last = block; // unterminated fence (message cut off)
  const d = last ? parseDecision(last.join("\n")) : null;
  return d ? { ...d, id: decisionCardId(agentId, d) } : null;
}

/** The decision in the newest assistant message of a timeline (older ones are stale: the Overlord has moved on), else null. */
export function decisionFromEntries(agentId: string, entries: { item?: { type?: string; text?: unknown } }[]): DecisionOffer | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const it = entries[i]?.item;
    if (it?.type !== "assistant_message" || typeof it.text !== "string" || !it.text.trim()) continue;
    return decisionFromText(agentId, it.text);
  }
  return null;
}

/** The text sent to the Overlord when the owner taps a button. Plain sentences: the Overlord reads them as the owner's reply. */
export const approvalText = (d: Pick<Decision, "action">): string => `Approved: ${d.action}. Go ahead.`;
export const alternativeText = (alt: string): string => `Not the recommended fix. Do this instead: ${alt}`;

/** True while the agent still carries an un-cleared needs-you label, current or legacy key. */
export function hasActiveNeedsYou(labels: Record<string, string> | undefined, legacyKey: string): boolean {
  const live = (k: string) => !!labels?.[k] && labels[k] !== "cleared";
  return live("needs-you") || live(legacyKey);
}
