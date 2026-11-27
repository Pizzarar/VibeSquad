// Storybook in-app "How to use" walkthrough (PLAN_STORYBOOK_V2 W4-guide / V7).
// Pure data + localStorage helpers kept in one file so V7 can edit copy without touching components.

export const GUIDE_TABS = ["home", "review", "quests", "world", "cast", "items", "problems", "glossary"] as const;
export type GuideTab = (typeof GUIDE_TABS)[number];

export const GUIDE_PRESETS = ["changed", "contracts", "unreviewed"] as const;
export type GuidePresetOnly = (typeof GUIDE_PRESETS)[number];

export const GUIDE_SCOPES = ["problems", "story", "coverage", "other", "toolong", "dev"] as const;
export type GuideFindingScope = (typeof GUIDE_SCOPES)[number];

export const GUIDE_QUEST_MODES = ["arcs", "order", "web"] as const;
export type GuideQuestMode = (typeof GUIDE_QUEST_MODES)[number];

export type GuideTarget = {
  tab: GuideTab;
  presetOnly?: GuidePresetOnly;
  findingScope?: GuideFindingScope;
  questMode?: GuideQuestMode;
  /** Optional element data-testid to scroll into view after navigating. */
  scrollTestId?: string;
  /** Optional fallback data-testid when scrollTestId is not mounted (e.g. End session before first mark). */
  fallbackScrollTestId?: string;
  /** Briefly highlight the scrolled target with .sb-flash. */
  highlight?: boolean;
};

export type GuideStep = {
  id: string;
  title: string;
  body: string;
  cta: string;
  target: GuideTarget;
};

export const GUIDE_TITLE = "How to use Storybook";
export const GUIDE_SUBTITLE = "Eight quick steps to review, mark, and check your game’s text.";
export const GUIDE_FOOTER_NOTE = "Reopen anytime from Home or ? in the header.";

export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    id: "home",
    title: "Start on Home",
    body: "Home puts what needs your eye first: real Problems, writing Coverage, what Changed since last time, and overall progress.",
    cta: "Show me",
    target: { tab: "home" },
  },
  {
    id: "arcs",
    title: "Review a trader’s arc",
    body: "Open Quests → Story arcs to read a trader’s whole storyline in order and mark lines right on the page.",
    cta: "Show me",
    target: { tab: "quests", questMode: "arcs" },
  },
  {
    id: "mark",
    title: "Mark lines in Review",
    body: "Use OK, Redo (with a note), or Edit (your own rewrite), or press j/k to move, 1/2/3 to mark, and OK all on a group.",
    cta: "Show me",
    target: { tab: "review" },
  },
  {
    id: "session",
    title: "End your session safely",
    body: "End session commits your marks to a separate EFI review branch—it never touches EFI main, and merging is always your call.",
    cta: "Show me",
    target: { tab: "review", scrollTestId: "sb-end-session", fallbackScrollTestId: "sb-marksbar", highlight: true },
  },
  {
    id: "contracts",
    title: "Leave notes on contracts",
    body: "A note on any contract is saved on its shared template row as contract:<id>, so it survives every pack rebuild.",
    cta: "Show me",
    target: { tab: "review", presetOnly: "contracts" },
  },
  {
    id: "find",
    title: "Find who says it and where",
    body: "Use Search in Review or open Cast, World, and Items sheets to see every line linked to a person, map, or item.",
    cta: "Show me",
    target: { tab: "cast" },
  },
  {
    id: "coherence",
    title: "Check terms and coherence",
    body: "Glossary catches banned or drifted terms, and Other checks lists naming and length notes without crowding Problems.",
    cta: "Show me",
    target: { tab: "glossary" },
  },
  {
    id: "changes",
    title: "See what changed since last time",
    body: "Home shows what is new, changed, or gone since you last clicked Mark seen, with one tap to review just those rows.",
    cta: "Show me",
    target: { tab: "home", scrollTestId: "sb-changes" },
  },
];

const STORAGE_PREFIX = "storybook.guide.dismissed.v1:";

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function guideDismissKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

export function isGuideDismissed(projectId: string, storage: StorageLike | null = defaultStorage()): boolean {
  if (!projectId || !storage) return false;
  try {
    return storage.getItem(guideDismissKey(projectId)) === "1";
  } catch {
    return false;
  }
}

export function setGuideDismissed(projectId: string, storage: StorageLike | null = defaultStorage()): void {
  if (!projectId || !storage) return;
  try {
    storage.setItem(guideDismissKey(projectId), "1");
  } catch {
    /* ignore quota / private-mode storage errors */
  }
}

export function shouldAutoOpenGuide(projectId: string, storage: StorageLike | null = defaultStorage()): boolean {
  return Boolean(projectId) && !isGuideDismissed(projectId, storage);
}
