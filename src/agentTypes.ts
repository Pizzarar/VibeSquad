// The agent shapes the browser reads. They mirror what the runner's roster/timeline routes return (RunnerBackend maps its
// records into this shape).

export type AgentStatus = "initializing" | "idle" | "running" | "error" | "closed";

export type AgentSelectOption = {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: Record<string, unknown>;
};

export type AgentFeature =
  | { type: "toggle"; id: string; label: string; description?: string; tooltip?: string; icon?: string; value: boolean }
  | {
      type: "select";
      id: string;
      label: string;
      description?: string;
      tooltip?: string;
      icon?: string;
      desktopTrigger?: "icon" | "label";
      value: string | null;
      options: AgentSelectOption[];
    };

export type AgentMode = { id: string; label: string; description?: string; icon?: string; colorTier?: string };

export type AgentPermissionRequest = {
  id: string;
  provider: string;
  name: string;
  kind: "tool" | "plan" | "question" | "mode" | "other";
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  detail?: Record<string, unknown> & { type?: string };
  suggestions?: unknown[];
  actions?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
};

export type AgentUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
};

export type PaseoAgent = {
  id: string;
  /** The VibeSquad host (~/.vibesquad/host-id) this record came from; set client-side from the response envelope (E4a). */
  hostId?: string;
  provider: string;
  cwd: string;
  workspaceId?: string;
  model: string | null;
  features?: AgentFeature[];
  thinkingOptionId?: string | null;
  effectiveThinkingOptionId?: string | null;
  createdAt: string;
  updatedAt: string;
  lastUserMessageAt: string | null;
  status: AgentStatus;
  /** Set while the runner holds this agent's prompt for a free turn slot: how many same-provider prompts are in front. */
  queued?: { ahead: number };
  activeTurn?: { turnId: string; startedAt: string | null } | null;
  capabilities: Record<string, boolean | undefined>;
  currentModeId: string | null;
  availableModes: AgentMode[];
  pendingPermissions: AgentPermissionRequest[];
  persistence: unknown | null;
  runtimeInfo?: {
    provider: string;
    sessionId: string | null;
    model?: string | null;
    thinkingOptionId?: string | null;
    modeId?: string | null;
    extra?: Record<string, unknown>;
  };
  lastUsage?: AgentUsage;
  lastError?: string;
  title: string | null;
  labels: Record<string, string>;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  attentionTimestamp?: string | null;
  archivedAt?: string | null;
  providerUnavailable?: boolean;
  internal?: boolean;
};

/** A registered workspace row (only the demo roster still produces these). */
export type PaseoWorkspace = {
  id: string;
  /** See PaseoAgent.hostId. */
  hostId?: string;
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  projectKind: "git" | "non_git" | "directory";
  workspaceKind: "directory" | "local_checkout" | "checkout" | "worktree";
  name: string;
  title?: string | null;
  status?: string;
  activityAt?: string | null;
  diffStat?: { additions: number; deletions: number } | null;
  gitRuntime?: { currentBranch?: string | null; isPaseoOwnedWorktree?: boolean; aheadBehind?: { ahead?: number; behind?: number } | null; aheadOfOrigin?: number | null; isDirty?: boolean | null } | null;
  githubRuntime?: { pullRequest?: { number?: number; state?: string; isMerged?: boolean } | null } | null;
  [key: string]: unknown;
};

/** What a send does when the agent is mid-turn. */
export type ActiveTurnBehavior = "interrupt" | "steer";

/** A timeline event as the runner's handle delivers it to Timeline.tsx (the runner only signals "changed", the rows are refetched). */
export type PaseoAgentTimelineEvent = { agentId?: string; seq?: number; timestamp?: string; event: { type: string; item?: any; turnId?: string; [key: string]: unknown } };

export type FileExplorerEntry = { name: string; path: string; kind: "file" | "directory"; size: number; modifiedAt: string };
export type FileExplorerDirectoryPayload = { path: string; entries: FileExplorerEntry[] };
