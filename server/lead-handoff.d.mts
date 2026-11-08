export const LEAD_FLAG_DEFAULT: number;
export const LEAD_AUTO_HANDOFF_DEFAULT: number;
export const LEAD_HARD_CAP_DEFAULT: number;
export const STALE_PREDECESSOR_MS: number;
export const SOFT_FLAG_REASON: string;
export const SOFT_FLAG_NUDGE: string;
export const WRITE_HANDOFF_PROMPT: string;
export const TAKEOVER_CONFIRM_INSTRUCTION: string;

export function loadTeamsConfig(rootDir?: string): any;
export function loadLeadThresholds(
  teamIdOrDef?: string | Record<string, any> | null,
  rootDir?: string,
): { flagTokens: number; autoHandoffTokens: number; hardCapTokens: number };
export function resolveTeamAndLane(
  lead: any,
  rootDir?: string,
): { teamId: string; teamName: string; laneId: string; laneName: string; teamDef: any };
export function parseLeadOrd(lead: any): number;
export function leadUsedTokens(lead: any, overrideTokens?: number): number;
export function isStalePredecessor(
  lead: any,
  opts?: { now?: number; staleMs?: number },
): boolean;
export function getHandoffPacketPath(teamId: string, laneId: string, baseHome?: string): string;
export function readLaneLogEntries(opts: {
  teamId: string;
  laneId: string;
  sinceIso?: string;
  baseHome?: string;
}): any[];
export function findOpenWorkersForLead(
  agents: any[],
  oldLead: any,
  teamId: string,
  laneId: string,
): any[];
export function synthesizeHandoffPacket(opts: {
  lead: any;
  teamId: string;
  teamName?: string;
  laneId: string;
  laneName?: string;
  openWorkers?: any[];
  rootDir?: string;
  baseHome?: string;
  reason?: string;
}): {
  path: string;
  snapshotPath: string;
  content: string;
  logEntries: any[];
  summaryPath: string;
  summaryContent: string;
  openWorkers: any[];
};
export function buildSuccessorPrompt(opts: {
  laneId: string;
  laneName?: string;
  nextOrd: number;
  oldLead: any;
  oldTitle: string;
  trigger: string;
  packetPath: string;
  packetContent: string;
  summaryPath: string;
  summaryContent: string;
  latestPlan: string;
  openWorkers?: any[];
  steer?: string;
  alreadyRetired?: boolean;
}): string;
export function resolveLeadProfile(
  oldLead: any,
  profilesPath?: string,
): { profileName: string; profile: any; spawnCfg: any };
export function createLeadHandoffCoordinator(deps?: Record<string, any>): {
  evaluateLead(lead: any, options?: Record<string, any>): Promise<any>;
  triggerSelfHandoff(leadOrId: any, options?: Record<string, any>): Promise<any>;
  confirmTakeover(successorId: string): Promise<any>;
  spawnSuccessor(opts: Record<string, any>): Promise<any>;
  hasPendingTakeover(successorId: string): boolean;
  getPendingTakeover(successorId: string): any;
  deletedHeartbeats: string[];
  state: {
    flagged150: Set<string>;
    writePrompted250: Set<string>;
    autoHandedOff250: Set<string>;
    forced300: Set<string>;
    selfHandedOff: Set<string>;
    pendingTakeover: Map<string, any>;
    confirmedTakeovers: Set<string>;
  };
};
export function performLeadHandoffHttp(body?: Record<string, any>, rootDir?: string): Promise<any>;
