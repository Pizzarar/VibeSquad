export function defangPromptFences(text: unknown): string;
export function contentRevision(text: unknown): string;
export function createWindowLimiter(opts: { max: number; windowMs?: number; now?: () => number }): { take(): boolean; reset(): void };
export function isSpawnId(s: unknown): boolean;
