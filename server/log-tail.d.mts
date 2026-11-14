export function linesFromEndSync(file: string, opts?: { chunkSize?: number }): Generator<string, void, undefined>;
export function linesFromEnd(file: string, opts?: { chunkSize?: number }): AsyncGenerator<string, void, undefined>;
export function tailLinesSync(file: string, n: number, opts?: { chunkSize?: number }): string[];
export function tailLines(file: string, n: number, opts?: { chunkSize?: number }): Promise<string[]>;
