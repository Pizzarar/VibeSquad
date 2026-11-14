export const FILE_LOCK_TIMEOUT_MS: number;
export const FILE_LOCK_STALE_MS: number;
export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  alive?: (pid: number) => boolean;
}
export interface FileLockHandle {
  file: string;
  stillOwned(): boolean;
  assertOwned(): void;
}
export function withFileLockSync<T>(targetPath: string, fn: (lock: FileLockHandle) => T, opts?: FileLockOptions): T;
export function withFileLock<T>(targetPath: string, fn: (lock: FileLockHandle) => T | Promise<T>, opts?: FileLockOptions): Promise<T>;
export function updateJsonFileSync<T = any>(
  targetPath: string,
  mutate: (data: T) => T | void,
  opts?: FileLockOptions & { fallback?: T },
): T;
export function updateJsonFile<T = any>(
  targetPath: string,
  mutate: (data: T) => T | void,
  opts?: FileLockOptions & { fallback?: T },
): Promise<T>;
export function reapStaleLock(
  lockFile: string,
  seen: { pid?: number; startedAt?: number; token?: string } | null,
  seenMtime: number,
  opts?: { staleMs?: number; alive?: (pid: number) => boolean },
): boolean;
export function thenMaybe<T, R>(value: T | Promise<T>, f: (v: T) => R): R | Promise<R>;
