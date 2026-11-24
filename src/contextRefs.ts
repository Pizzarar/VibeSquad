// Chat inline code that is a context ref (`` `msg:-N` `` or `` `idea-N` ``) becomes a link:
// msg refs open a compact popover with the referenced assistant message, idea refs with the
// inbox card. Pure, so node --test can load it (no react / dom imports).

export type MsgRef = { kind: "msg"; n: number };
export type IdeaRef = { kind: "idea"; id: string };
export type ContextRef = MsgRef | IdeaRef;

/** `msg:-N` is the Nth earlier reply; the plan bounds N to 1..20 so a token stays typeable and stable. */
export const MSG_REF_MAX = 20;

const MSG_REF_RE = /^msg:-(\d+)$/;
const IDEA_REF_RE = /^idea-(\d+)$/;

/**
 * Parse a backticked inline-code token as a context ref. Returns null unless the WHOLE token is
 * exactly `msg:-N` (N 1..20) or `idea-N` (N >= 1): `msg:-0`, `msg:-21`, and any extra text reject,
 * so bare/prose mentions (`see msg:-2`, `idea-1 next`) stay plain code.
 */
export function parseContextRef(code: string): ContextRef | null {
  const msg = MSG_REF_RE.exec(code);
  if (msg) {
    const n = Number(msg[1]);
    return n >= 1 && n <= MSG_REF_MAX ? { kind: "msg", n } : null;
  }
  const idea = IDEA_REF_RE.exec(code);
  if (idea) {
    const n = Number(idea[1]);
    return n >= 1 ? { kind: "idea", id: `idea-${idea[1]}` } : null;
  }
  return null;
}

/** A timeline entry as the resolver sees it (an { item } wrapper or a bare item, plus an optional agent id). */
export type RefEntry = {
  item?: any;
  agentId?: string;
  timestamp?: string;
  seqStart?: number;
  seqEnd?: number;
};

export type MsgResolution =
  | { status: "ok"; entry: RefEntry }
  | { status: "not-loaded" };

/** The agent an entry belongs to: item.agentId || entry.agentId, else undefined (single-agent timeline). */
function entryAgent(e: RefEntry | undefined): string | undefined {
  if (!e) return undefined;
  const it = e.item as any;
  const a = (it && typeof it.agentId === "string" && it.agentId) || e.agentId;
  return typeof a === "string" && a ? a : undefined;
}

/**
 * `msg:-n` = the nth earlier assistant message from the SAME agent, counted back from the citing
 * entry. User messages, tool/reasoning rows and assistant messages from other agents are skipped.
 * Fewer than n qualifying messages before the citing entry (older than the loaded history) ->
 * `{ status: "not-loaded" }`. A single-agent timeline has no per-entry agent id, so every assistant
 * message counts as the citing agent's.
 */
export function resolveMsgRef(
  entries: RefEntry[],
  citing: RefEntry,
  n: number,
  citingAgentId?: string,
): MsgResolution {
  const idx = entries.indexOf(citing);
  if (idx < 0) return { status: "not-loaded" };
  const self = entryAgent(citing) ?? citingAgentId;
  let seen = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const e = entries[i];
    const it = e?.item as any;
    if (!it || it.type !== "assistant_message") continue;
    const a = entryAgent(e);
    if (self !== undefined && a !== undefined && a !== self) continue;
    seen++;
    if (seen === n) return { status: "ok", entry: e };
  }
  return { status: "not-loaded" };
}
