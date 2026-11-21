export function redactHostPaths<T>(value: T, rootDir?: string, roots?: string[]): T;
export function redactHostPathTokens(text: string, opts?: { rootDir?: string; repoRoots?: string[] }): string;
