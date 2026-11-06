// Pinned teams step 5: the Mark complete steps with every side effect injected, so they can be
// tested in node and retried safely. src/pinActions.ts markPinComplete wires the real effects.
// Retry rules: the Brainstorm's profile is saved before anything retires, the brief gets at most
// one "Done <date>" / "Shipped <date>: <goal>" line per day, and state is saved last.
import type { Member, TeamsUpdater } from "./teams.ts";
import { appendBriefLine, briefStamp, completeBlocker, isContentLine, patchLane, type Pin } from "./pins.ts";

export type CompleteEffects = {
  /** Current brief text. */
  readBrief: (laneId: string) => Promise<string>;
  writeBrief: (laneId: string, content: string) => Promise<void>;
  retire: (agent: Member["agent"], laneName: string) => Promise<void>;
  archive: (id: string) => Promise<unknown>;
  /** Saves as an updater so the patch re-applies to the fresh registry on a write conflict. */
  saveTeams: (update: TeamsUpdater) => Promise<unknown>;
  now?: () => Date;
  /** Skip the brief (demo mode). */
  skipBrief?: boolean;
};

/** The brief with `line` appended, or null when its last non-blank line already is `line`. */
export function appendBriefLineOnce(brief: string, line: string): string | null {
  const last = brief.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean).pop();
  return last === line ? null : appendBriefLine(brief, line);
}

const isWaitingGoalLine = (t: string): boolean => /^[-*]?\s*\(\s*waiting for next goal\s*\)\.?$/i.test(t);

/**
 * Standing team completion: moves the content under `## Done when` into a trailing
 * `Shipped <dateStamp>: <goal>` line and resets `## Done when` to `- (waiting for next goal)`.
 * Safe to retry on the same day after `## Done when` has already been reset.
 */
export function shipGoalBrief(brief: string, dateStamp: string): string {
  const lines = brief.replace(/\r\n/g, "\n").split("\n");
  const doneHeaderIdx = lines.findIndex((l) => /^##\s+Done when\s*$/i.test(l));
  let nextHeaderIdx = lines.length;
  const goalItems: string[] = [];

  if (doneHeaderIdx !== -1) {
    for (let i = doneHeaderIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) {
        nextHeaderIdx = i;
        break;
      }
      const t = lines[i].trim();
      if (!t || t.startsWith(">") || isWaitingGoalLine(t) || !isContentLine(t)) continue;
      const item = t.replace(/^[-*]\s*/, "").trim();
      if (item) goalItems.push(item);
    }
  }

  const extracted = goalItems.join("; ");
  const lastNonBlank = lines.map((l) => l.trim()).filter(Boolean).pop() ?? "";
  if (!extracted && lastNonBlank.startsWith(`Shipped ${dateStamp}:`)) {
    return brief;
  }

  const goal = extracted || "goal";
  let rebuilt = brief;
  if (doneHeaderIdx !== -1) {
    const replacement = nextHeaderIdx < lines.length ? ["- (waiting for next goal)", ""] : ["- (waiting for next goal)"];
    const nextLines = [...lines.slice(0, doneHeaderIdx + 1), ...replacement, ...lines.slice(nextHeaderIdx)];
    rebuilt = nextLines.join("\n");
  }
  const shippedLine = `Shipped ${dateStamp}: ${goal}`;
  return appendBriefLineOnce(rebuilt, shippedLine) ?? rebuilt;
}

export async function runMarkComplete(pin: Pin, fx: CompleteEffects): Promise<{ ok: true } | { ok: false; blocked: string }> {
  const blocked = completeBlocker(pin);
  if (blocked) return { ok: false, blocked };
  const now = fx.now?.() ?? new Date();
  const bs = pin.brainstorm?.agent;
  const standing = Boolean(pin.lane.standing);

  // 1. Remember the Brainstorm's profile before it is archived, so a retry (no live Brainstorm) keeps it.
  const profile = bs?.labels?.profile;
  if (profile && profile !== pin.lane.lastProfile) {
    await fx.saveTeams((cur) => patchLane(cur, pin.squad.id, pin.lane.id, { lastProfile: profile }));
  }

  // 2. Standing teams log "Shipped <date>: <goal>" and reset "## Done when"; disposable teams append "Done <date>".
  if (!fx.skipBrief) {
    try {
      if (standing) {
        const cur = await fx.readBrief(pin.lane.id);
        const next = shipGoalBrief(cur, briefStamp(now));
        if (next !== cur) await fx.writeBrief(pin.lane.id, next);
      } else {
        const next = appendBriefLineOnce(await fx.readBrief(pin.lane.id), `Done ${briefStamp(now)}`);
        if (next !== null) await fx.writeBrief(pin.lane.id, next);
      }
    } catch {}
  }

  // 3. Retire the occupants. Stale/already-archived/ghost agents never prevent saving the lane state.
  if (bs) {
    await fx.retire(bs, pin.lane.name).catch(() => {});
    await fx.archive(bs.id).catch(() => {});
  }
  if (pin.lead) await fx.retire(pin.lead.agent, pin.lane.name).catch(() => {});

  // 4. Standing teams sleep in place (state="pinned"); disposable teams move to the Done shelf.
  if (standing) {
    await fx.saveTeams((cur) => patchLane(cur, pin.squad.id, pin.lane.id, { state: "pinned", doneAt: undefined }));
  } else {
    await fx.saveTeams((cur) => patchLane(cur, pin.squad.id, pin.lane.id, { state: "done", doneAt: now.toISOString() }));
  }
  return { ok: true };
}
