export const WHOS_HERE_HEADING: string;
export function whosHereBody(agents: any[], laneId: string): string;
export function applyWhosHere(content: string, body: string): string;
export function refreshWhosHere(opts: { laneId: string; agents: any[]; rootDir: string }): { changed: boolean; body: string; path: string };
