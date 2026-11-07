export function createVibesquadMiddleware(rootDir?: string): (req: any, res: any, next?: (err?: unknown) => void) => void;
export function handleHealth(req: any, res: any, rootDir?: string): void;
export function isGatedRead(path: string, url?: string): boolean;
export function isUncLikePath(p: unknown): boolean;
export function handleAuthStatus(req: any, res: any, rootDir?: string): void;
export function handleDesktopInstaller(req: any, res: any, rootDir?: string): void;
export function handleDesktopUpdateJson(req: any, res: any, rootDir?: string): void;
export {
  appendVsLogEntry,
  createAgentClient,
  performBrainstormRestart,
  readBrainstormSummary,
  writeBrainstormSummary,
} from "./brainstorm.mjs";
export {
  addInboxCards,
  getInboxPath,
  listInboxCards,
  readInboxCards,
  sortIdeaCard,
  triageInboxCards,
  writeInboxCards,
  type InboxCard,
  type InboxScope,
  type InboxStatus,
} from "./inbox.mjs";
export {
  broadcastWebPush,
  buildVapidHeaders,
  decryptWebPushPayload,
  encryptWebPushPayload,
  evaluateAgentTransition,
  getOrCreateVapidKeys,
  getPushSubsPath,
  getVapidPath,
  readPushSubscriptions,
  removePushSubscription,
  savePushSubscription,
  sendTestPush,
  sendWebPushToSubscription,
  startPushWatcher,
  toBase64Url,
  fromBase64Url,
  writePushSubscriptions,
} from "./push.mjs";
export function handleLocalImage(req: any, res: any): void;
export function lookupAgentCwd(agentId: unknown): string | null;
export function resolveAllowedImage(raw: unknown, roots?: string[], extraCwd?: string | { agentId?: string; extraCwd?: string | null } | null): string | null;
export {
  LEAD_AUTO_HANDOFF_DEFAULT,
  LEAD_FLAG_DEFAULT,
  LEAD_HARD_CAP_DEFAULT,
  SOFT_FLAG_NUDGE,
  SOFT_FLAG_REASON,
  TAKEOVER_CONFIRM_INSTRUCTION,
  WRITE_HANDOFF_PROMPT,
  buildSuccessorPrompt,
  createLeadHandoffCoordinator,
  findOpenWorkersForLead,
  getHandoffPacketPath,
  leadUsedTokens,
  loadLeadThresholds,
  parseLeadOrd,
  performLeadHandoffHttp,
  readLaneLogEntries,
  resolveLeadProfile,
  resolveTeamAndLane,
  synthesizeHandoffPacket,
} from "./lead-handoff.mjs";
