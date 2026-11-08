export const FILE_LOCK_TIMEOUT_MS: number;
export const FILE_LOCK_STALE_MS: number;
export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  alive?: (pid: number) => boolean;
}
export function withFileLockSync<T>(targetPath: string, fn: () => T, opts?: FileLockOptions): T;
export function updateJsonFileSync<T = any>(
  targetPath: string,
  mutate: (data: T) => T | void,
  opts?: FileLockOptions & { fallback?: T },
): T;
