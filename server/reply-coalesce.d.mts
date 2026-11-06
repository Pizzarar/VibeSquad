type Ent = { item: any; seqStart?: number; seqEnd?: number; liveSeqs?: number[]; sourceSeqRanges?: { startSeq: number; endSeq: number }[]; segStart?: number; [k: string]: any };
export function sameMessage(a: any, b: any): boolean;
export function followsDirectly(a: Ent, b: Ent): boolean;
export function rejoinReply<T extends Ent>(msg: T, thought: T, next: T): [T, T] | null;
export function coalesceReplies<T extends Ent>(entries: T[]): T[];
