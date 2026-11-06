export interface AgentBackend {
  connect?(...args: any[]): Promise<any>;
  close?(...args: any[]): Promise<any>;
  createAgent?(...args: any[]): Promise<any>;
  fetchAgent?(...args: any[]): Promise<any>;
  fetchAgents?(...args: any[]): Promise<any>;
  listAgents?(...args: any[]): Promise<any>;
  getAgent?(...args: any[]): Promise<any>;
  sendAgentPrompt?(...args: any[]): Promise<any>;
  fetchAgentTimeline?(...args: any[]): Promise<any>;
  getAgentTimeline?(...args: any[]): Promise<any>;
  cancelAgent?(...args: any[]): Promise<any>;
  archiveAgent?(...args: any[]): Promise<any>;
  updateAgent?(...args: any[]): Promise<any>;
  refreshAgent?(...args: any[]): Promise<any>;
  detachAgent?(...args: any[]): Promise<any>;
  deleteHeartbeat?(...args: any[]): Promise<any>;
  subscribe?(...args: any[]): any;
  subscribeConnectionStatus?(...args: any[]): any;
  waitForFinish?(...args: any[]): Promise<any>;
  runCli(paseoHome: string, args: string[], timeoutMs?: number): string | null;
}
export class PaseoBackend implements AgentBackend {
  constructor(client: any);
  readonly client: any;
  runCli(paseoHome: string, args: string[], timeoutMs?: number): string | null;
}
export const BACKEND_METHODS: string[];
export class RunnerBackend implements AgentBackend {
  constructor(opts?: { client?: any; buildPrefix?: (role: string, cwd: string) => Promise<string> });
  runCli(): null;
}
export class RoutingBackend implements AgentBackend {
  constructor(paseo: PaseoBackend, runner: RunnerBackend, opts?: { lanes?: () => Set<string>; paseoAlive?: (() => Promise<boolean>) | null });
  readonly paseo: PaseoBackend;
  readonly runner: RunnerBackend;
  runCli(paseoHome: string, args: string[], timeoutMs?: number): string | null;
}
export function sharedRunnerBackend(): RunnerBackend;
export function isRunnerId(id: unknown): boolean;
export class RunnerLaneSet extends Set<string> {
  constructor(explicitRunner?: Iterable<string>, paseoLanes?: Iterable<string>);
  readonly paseoLanes: Set<string>;
  explicit(): Set<string>;
}
export function paseoDaemonAlive(opts?: { ttlMs?: number; now?: () => number; check?: () => Promise<boolean> }): Promise<boolean>;
export function runnerLanes(opts?: { env?: Record<string, string | undefined>; teamsFile?: string }): Set<string>;
export function getBackend<T>(client: T, opts?: { lanes?: () => Set<string>; runner?: RunnerBackend; force?: boolean; paseoAlive?: (() => Promise<boolean>) | null }): T extends null | undefined ? T : any;
export function getCliBackend(): AgentBackend;
export function hasCustomMockCli(): boolean;
export function hasCustomOfflineStore(paseoHome: string): boolean;
export function run(command: string, args: string[], timeoutMs: number): any;
export function readRunnerAgentSync(id: string, opts?: { env?: Record<string, string | undefined> }): any | null;
export function listRunnerAgentsSync(opts?: { env?: Record<string, string | undefined> }): any[];
