export const VERDICT_LINE_RE: RegExp;
export const VERDICT_PREFIX_SRC: string;
export function extractVerdictLine(text: unknown): string | null;
export function parseVerdictLine(line: unknown): { verdict: "PASS" | "FAIL"; high: number | null; medium: number | null; low: number | null; severity: "H" | "M" | "L" | null; hash: string } | null;
export function firstLine(text: unknown): string;
export function isReviewerAgent(agent: { id?: string; title?: string | null; profile?: string; labels?: Record<string, unknown> } | null | undefined): boolean;
export function digestVerdictText(args: { workerText: unknown; digestText: unknown; reviewer?: boolean; profile?: string | null }): {
  text: string;
  verdictLine: string | null;
  mismatch: boolean;
  noVerdict: boolean;
};
export const GATE_EXIT: { pass: 0; fail: 1; noVerdict: 2; staleHash: 3; notReviewer: 4; noBranch: 5 };
export function evaluateVerdictGate(args: {
  agent: { id?: string; title?: string | null; labels?: Record<string, unknown> } | null | undefined;
  lastMessage: unknown;
  tip: unknown;
  branch?: string;
}): { code: number; ok: boolean; line: string; reason: string };
