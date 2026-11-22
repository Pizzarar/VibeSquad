export interface GitExecResult {
  ok: boolean;
  out: string;
  code: number | null;
}
export function gitExecOffLoop(cwd: string, args: string[], timeoutMs: number): Promise<GitExecResult>;
export const gitSpawnStats: { workerSpawns: number };
export function _resetGitSpawn(): void;
