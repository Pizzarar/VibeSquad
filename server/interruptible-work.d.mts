export declare const INTERRUPTIBLE_KINDS: ReadonlySet<string>;
export declare function normWorkKey(v: unknown): string;
export declare function isInterruptibleWork(w?: { stakes?: string; kind?: string; role?: string }): boolean;
