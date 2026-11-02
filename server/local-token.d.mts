export const LOCAL_TOKEN_HEADER: string;
export const LOCAL_TOKEN_FILE: string;
export function localTokenPath(home?: string): string;
export function readLocalToken(file?: string): string | null;
export function localTokenHeaders(file?: string): Record<string, string>;
export function ensureLocalToken(file?: string): string;
