// Pure helpers for the RiffBot hub bar (src/HubBar.tsx).
import { isContentLine } from "./pins.ts";

/** Count the bullets under `## Unsplit threads` (a lone "none" bullet counts as 0). */
export function countUnsplit(brief: string): number {
  const lines = brief.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Unsplit threads\s*$/i.test(l));
  if (start < 0) return 0;
  let n = 0;
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    const m = /^\s*[-*]\s+(.*\S)/.exec(l);
    const text = m?.[1].replace(/[*_`]/g, "").trim();
    if (text && isContentLine(text) && !/^(n\/a|-)\.?$/i.test(text)) n++;
  }
  return n;
}

/** Minimal inbox card shape the bug button reads (server/inbox.mjs). */
export type BugCard = { id?: string; laneId?: string; status?: string };

const cardNum = (c: BugCard): number => Number(/^idea-(\d+)$/i.exec(String(c.id ?? ""))?.[1] ?? 0);

/** Open (parked) cards for the bug lane: `total` is the shown N, `unseen` the ones newer than `seenMax` (the highest id seen when last opened). */
export function bugCounts(cards: ReadonlyArray<BugCard>, laneId: string, seenMax: number): { total: number; unseen: number; max: number } {
  const mine = cards.filter((c) => String(c.laneId ?? "").toLowerCase() === laneId.toLowerCase() && (!c.status || c.status === "parked"));
  return { total: mine.length, unseen: mine.filter((c) => cardNum(c) > seenMax).length, max: mine.reduce((m, c) => Math.max(m, cardNum(c)), 0) };
}
