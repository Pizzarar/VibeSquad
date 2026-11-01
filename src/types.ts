export {
  BRAINSTORM_WARN_DEFAULT,
  BRAINSTORM_RESTART_DEFAULT,
  getBrainstormThresholds,
  isBrainstormAgent,
  isTopicBrainstorm,
  topicOfBrainstorm,
  brainstormUsedTokens,
  teamForAgent,
  type LaneDef,
  type TeamDef,
  type TeamConfig,
  type Kind,
  type AgentType,
  type Attention,
  type Member,
  type TeamView,
} from "./teams";

export type InboxScope = "art" | "mechanic" | "plugin" | "UI" | "infra" | "docs" | "other";
export type InboxStatus = "parked" | "handed-off" | "archived";

export interface InboxCard {
  id: string;             // e.g. "idea-1" or short id
  text: string;           // raw idea text
  title: string;          // concise 3-7 word title
  teamId: string;         // e.g. "vibesquad" | "acme-app"
  laneId: string;         // e.g. "vibesquad" | "main-game" | "ui-lab" | "plugins" | "site-polish"
  scope: InboxScope;
  relatedCardId?: string | null; // "goes with card X" suggestion from sorter
  relatedReason?: string | null;
  mergedFromIds?: string[];      // if lead merged multiple cards into one feature card
  status: InboxStatus;
  topicAgentId?: string | null;  // for P3 topic brainstorms
  topicTitle?: string | null;
  topicOpenedAt?: string | null;
  handedOffAt?: string | null;
  summaryNote?: string | null;
  source?: string;        // "ui" | "brainstorm-dump" | "cli"
  createdAt: string;
  updatedAt: string;
}
