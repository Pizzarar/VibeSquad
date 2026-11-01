export type InboxScope = "art" | "mechanic" | "plugin" | "UI" | "infra" | "docs" | "other";
export type InboxStatus = "parked" | "handed-off" | "archived";

export interface InboxCard {
  id: string;
  text: string;
  title: string;
  teamId: string;
  laneId: string;
  scope: InboxScope;
  relatedCardId?: string | null;
  relatedReason?: string | null;
  mergedFromIds?: string[];
  status: InboxStatus;
  topicAgentId?: string | null;
  summaryNote?: string | null;
  source?: string;
  createdAt: string;
  updatedAt: string;
}

export const INBOX_SCOPES: InboxScope[];
export const INBOX_LANES: string[];

export function getInboxPath(baseHome?: string): string;
export function loadTeamsForInbox(rootDir?: string): any[];
export function readInboxCards(baseHome?: string): InboxCard[];
export function writeInboxCards(cards: InboxCard[], baseHome?: string): InboxCard[];
export function extractSignificantTokens(text: string): string[];
export function buildConciseTitle(rawText: string): string;
export function teamIdForLane(laneId: string, rawText?: string, teams?: any[]): string;
export function sortIdeaCard(
  rawText: string,
  existingCards?: InboxCard[],
  teams?: any[],
): {
  title: string;
  teamId: string;
  laneId: string;
  scope: InboxScope;
  relatedCardId: string | null;
  relatedReason: string | null;
  matchedDomain: boolean;
};
export function splitIdeaDump(input: string | string[], splitDump?: boolean): string[];
export function matchesTeamFilter(card: InboxCard, teamFilter: string, teams?: any[]): boolean;
export function listInboxCards(
  filter?: { teamId?: string; team?: string; laneId?: string; lane?: string; status?: string; baseHome?: string },
  rootDir?: string,
): InboxCard[];
export function addInboxCards(
  body: {
    text?: string;
    ideas?: string[];
    teamId?: string;
    defaultLaneId?: string;
    laneId?: string;
    source?: string;
    splitDump?: boolean;
    baseHome?: string;
  },
  rootDir?: string,
): {
  ok: true;
  added: InboxCard[];
  cards: InboxCard[];
  summary: string;
};
export function triageInboxCards(
  body: {
    action: "merge" | "bounce" | "update" | "delete" | "archive";
    targetId?: string;
    sourceIds?: string[];
    sourceId?: string;
    cardId?: string;
    teamId?: string;
    laneId?: string;
    lane?: string;
    scope?: InboxScope;
    patch?: Partial<InboxCard>;
    archive?: boolean;
    baseHome?: string;
  },
  rootDir?: string,
): {
  ok: true;
  action: string;
  card: InboxCard;
  mergedIds?: string[];
  cards: InboxCard[];
};
