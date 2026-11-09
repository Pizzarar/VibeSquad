export function seedBugLane<T extends { id: string; lanes?: any[] }>(team: T, existingTeams?: any[]): T;
export function backfillBugLanes<T extends { id: string; lanes?: any[] }>(teams: T[]): T[];
export function persistBugLaneBackfill(rootDir: string): { changed: boolean; added?: { team: string; lane: string }[] };
