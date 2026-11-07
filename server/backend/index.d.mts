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
  unarchiveAgent?(...args: any[]): Promise<any>;
  updateAgent?(...args: any[]): Promise<any>;
  refreshAgent?(...args: any[]): Promise<any>;
  detachAgent?(...args: any[]): Promise<any>;
  deleteHeartbeat?(...args: any[]): Promise<any>;
  subscribe?(...args: any[]): any;
  subscribeConnectionStatus?(...args: any[]): any;
  waitForFinish?(...args: any[]): Promise<any>;
}
export class RunnerBackend implements AgentBackend {
  constructor(opts?: { client?: any; buildPrefix?: (role: string, cwd: string) => Promise<string> });
}
export function sharedRunnerBackend(): RunnerBackend;
export function isRunnerId(id: unknown): boolean;
export function getBackend<T>(client: T): T;
export function readRunnerAgentSync(id: string, opts?: { env?: Record<string, string | undefined> }): any | null;
export function listRunnerAgentsSync(opts?: { env?: Record<string, string | undefined> }): any[];
