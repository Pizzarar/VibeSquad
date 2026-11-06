type Ent = { item: any; seqStart?: number; seqEnd?: number; liveSeqs?: number[]; sourceSeqRanges?: { startSeq: number; endSeq: number }[]; segStart?: number; turnId?: string; turnEnd?: boolean; [k: string]: any };
export function sameMessage(a: any, b: any): boolean;
export function lastSeqOf(e: Ent): number | null;
export function firstSeqOf(e: Ent): number | null;
export function joinTarget<T extends Ent>(entries: T[], next: T): number;
export function joinInto<T extends Ent>(target: T, next: T, opts?: { trailing?: T[]; snapshot?: boolean }): T;
export function coalesceReplies<T extends Ent>(entries: T[]): T[];
export function joinPages<T extends Ent>(older: T[], newer: T[]): T[];
export function markTurnBoundary<T extends Ent>(entries: T[]): T[];
