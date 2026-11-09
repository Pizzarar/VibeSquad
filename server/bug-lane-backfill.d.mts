type TeamLike = { id: string; lanes?: any[]; [k: string]: any };
export const TEMPLATE_DEFAULTS: Record<string, string | number>;
export function seedStandingLane<T extends TeamLike>(team: T, kind: "bug" | "audit", existingTeams?: any[]): T;
export function seedBugLane<T extends TeamLike>(team: T, existingTeams?: any[]): T;
export function diffAgainstTemplate<T extends TeamLike>(team: T, allTeams?: any[]): { next: T; auto: { rule: string; detail?: string }[]; logOnly: { rule: string }[] };
export function reconcileTemplate<T extends TeamLike>(teams: T[]): { teams: T[]; auto: { team: string; rule: string; detail?: string }[]; logOnly: { team: string; rule: string }[] };
export function backfillBugLanes<T extends TeamLike>(teams: T[]): T[];
export function persistTemplateReconcile(rootDir: string): { changed: boolean; auto: { team: string; rule: string; detail?: string }[]; logOnly: { team: string; rule: string }[] };
