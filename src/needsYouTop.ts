import type { TeamView } from "./teams";
import { needsYouRows } from "./BoringInbox";

/** The Normal Needs-you list (finished excluded): what boring-needs-you-count counts. Ctrl+J shares it. */
export function countedNeedsYouRows(views: TeamView[], now: number) {
  return needsYouRows(views, now).filter((r) => r.item.kind !== "finished");
}

/** Ctrl+J target: row 0 of the Needs-you list, or null when nothing needs you. */
export function topNeedsYouId(views: TeamView[], now: number): string | null {
  return countedNeedsYouRows(views, now)[0]?.item.id ?? null;
}
