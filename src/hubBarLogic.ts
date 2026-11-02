// Pure helpers for the RiffBot hub bar (src/HubBar.tsx).
/** Count the bullets under `## Unsplit threads` (a lone "none" bullet counts as 0). */
export function countUnsplit(brief: string): number {
  const lines = brief.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Unsplit threads\s*$/i.test(l));
  if (start < 0) return 0;
  let n = 0;
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    const m = /^\s*[-*]\s+(.*\S)/.exec(l);
    if (m && !/^(none|n\/a|-)\.?$/i.test(m[1].replace(/[*_`]/g, "").trim())) n++;
  }
  return n;
}
