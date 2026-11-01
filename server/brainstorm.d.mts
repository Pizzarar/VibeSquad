export function readPaseoConfig(rootDir?: string): { listen: string; serverId: string; home: string };
export function createDaemonClient(rootDir?: string): any;
export function readBrainstormSummary(laneRaw: string, rootDir?: string): { laneId: string; path: string; fullPath: string; content: string };
export function writeBrainstormSummary(laneRaw: string, content: string, rootDir?: string): { laneId: string; path: string; fullPath: string; content: string };
export function findNewestPlanFile(cwd?: string, rootDir?: string): string;
export function appendVsLogEntry(opts: { teamId?: string; laneId?: string; agent?: string; type?: string; text: string; refs?: string[] }): { entry: any; path: string; teamLogPath: string };
export function buildBrainstormInitialPrompt(opts: { laneId: string; laneUpper: string; summaryContent: string; latestPlan: string; pendingPrompt?: string }): string;
export function performBrainstormRestart(body: any, rootDir?: string): Promise<any>;
