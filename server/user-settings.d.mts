export const LEGACY_USER_TYPE: string;
export const LEGACY_NEEDS_LABEL: string;
export const LEGACY_NEEDS_REASON: string;
export const LEGACY_NEEDS_UNTIL: string;
export const DEFAULT_USER_NAME: string;
export function vibesquadHome(): string;
export function normalizeUserName(value: unknown): string;
export function loadUserSettings(baseHome?: string): { userName: string };
export function saveUserSettings(patch: { userName?: unknown }, baseHome?: string): { userName: string };
export function readJsonFileWithBom(
  filePath: string,
  opts?: { label?: string; fallback?: any; recordWarning?: boolean; rewriteBom?: boolean; rewriteIfBom?: boolean },
): { ok: boolean; exists: boolean; data: any; value: any; error: string | null; hadBom: boolean };
