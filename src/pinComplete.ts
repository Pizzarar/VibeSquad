// Pinned teams step 5: the Mark complete steps with every side effect injected, so they can be
// tested in node and retried safely. src/pinActions.ts markPinComplete wires the real effects.
// Retry rules: the Brainstorm's profile is saved before anything retires, the brief gets at most
// one "Done <date>" line per day, and state=done is saved last, only after every step succeeded.
import type { Member, TeamsUpdater } from "./teams.ts";
import { appendBriefLine, briefStamp, completeBlocker, patchLane, type Pin } from "./pins.ts";

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

export async function runMarkComplete(pin: Pin, fx: CompleteEffects): Promise<{ ok: true } | { ok: false; blocked: string }> {
  const blocked = completeBlocker(pin);
  if (blocked) return { ok: false, blocked };
  const now = fx.now?.() ?? new Date();
  const bs = pin.brainstorm?.agent;

  // 1. Remember the Brainstorm's profile before it is archived, so a retry (no live Brainstorm) keeps it.
  const profile = bs?.labels?.profile;
  if (profile && profile !== pin.lane.lastProfile) {
    await fx.saveTeams((cur) => patchLane(cur, pin.squad.id, pin.lane.id, { lastProfile: profile }));
  }

  // 2. One "Done <date>" line, even when a failed attempt already wrote it.
  if (!fx.skipBrief) {
    const next = appendBriefLineOnce(await fx.readBrief(pin.lane.id), `Done ${briefStamp(now)}`);
    if (next !== null) await fx.writeBrief(pin.lane.id, next);
  }

  // 3. Retire the occupants. Any throw stops here, before the state changes, so the click can be retried.
  if (bs) {
    await fx.retire(bs, pin.lane.name);
    await fx.archive(bs.id).catch(() => {});
  }
  if (pin.lead) await fx.retire(pin.lead.agent, pin.lane.name);

  // 4. Only now move the pin to the Done shelf.
  await fx.saveTeams((cur) => patchLane(cur, pin.squad.id, pin.lane.id, { state: "done", doneAt: now.toISOString() }));
  return { ok: true };
}
