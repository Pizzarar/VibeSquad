type Ent = { item: any; seqStart?: number; seqEnd?: number; liveSeqs?: number[]; sourceSeqRanges?: { startSeq: number; endSeq: number }[]; segStart?: number; turnId?: string; turnEnd?: boolean; fromSeq?: number; toSeq?: number; [k: string]: any };
export function sameMessage(a: any, b: any): boolean;
export function rejoinRun<T extends Ent>(msg: T, thoughts: T[], next: T): T[] | null;
export function rejoinTail<T extends Ent>(entries: T[], next: T): { from: number; items: T[] } | null;
export function coalesceReplies<T extends Ent>(entries: T[]): T[];
export function joinPages<T extends Ent>(older: T[], newer: T[]): T[];
export function markTurnBoundary<T extends Ent>(entries: T[]): T[];
