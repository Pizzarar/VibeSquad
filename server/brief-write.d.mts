export const BRIEF_HISTORY_KEEP: number;
export const BRIEF_SHRINK_FROM: number;
export const BRIEF_SHRINK_TO: number;
export function backupBrief(laneId: string, fullPath: string): string | null;
export function writeFileAtomic(fullPath: string, text: string): void;
export function writeBriefFile(fullPath: string, laneId: string, text: string): void;
