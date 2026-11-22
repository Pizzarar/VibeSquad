export interface GitDirs {
  gitDir: string;
  commonDir: string;
}
export function gitDirsFs(cwd: string | undefined | null): Promise<GitDirs | null>;
export function readHeadFs(dirs: GitDirs | null): Promise<{ branch: string; sha?: undefined } | { sha: string; branch?: undefined } | null>;
export function resolveRefsFs(dirs: GitDirs | null, refs: string[]): Promise<Map<string, string> | null>;
