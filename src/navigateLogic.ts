// Quick open fuzzy ranking + find-in-files result grouping. Pure (tested in test/ade-navigate.test.mjs).

export type FuzzyHit = { path: string; score: number; positions: number[] };

const isSep = (c: string) => c === "/" || c === "\\" || c === "_" || c === "-" || c === "." || c === " ";

/**
 * Subsequence match of `q` in `path`, case-insensitive. Higher score is better; null when not all
 * query characters appear in order. Rewards consecutive runs, segment starts and basename hits, and
 * prefers short paths. Spaces in the query are ignored ("files panel" finds FilesPanel.tsx).
 */
export function fuzzyScore(path: string, query: string): FuzzyHit | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return { path, score: 0, positions: [] };
  const p = path.toLowerCase();
  const baseStart = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1;
  // Greedy from the right inside the basename first gives "basename wins"; fall back to a left greedy scan.
  const tryFrom = (start: number): number[] | null => {
    const pos: number[] = [];
    let j = start;
    for (const ch of q) {
      const k = p.indexOf(ch, j);
      if (k < 0) return null;
      pos.push(k);
      j = k + 1;
    }
    return pos;
  };
  const candidates = [tryFrom(baseStart), tryFrom(0)].filter((x): x is number[] => !!x);
  // Also try anchoring the first char at each segment start, which finds "fp" → "Files/Panel" style hits.
  for (let i = 0; i < p.length && candidates.length < 12; i++) {
    if (p[i] === q[0] && (i === 0 || isSep(path[i - 1]) || (path[i] >= "A" && path[i] <= "Z" && path[i - 1] >= "a" && path[i - 1] <= "z"))) {
      const pos = tryFrom(i);
      if (pos) candidates.push(pos);
    }
  }
  if (!candidates.length) return null;
  let best: FuzzyHit | null = null;
  for (const pos of candidates) {
    let score = 0;
    for (let i = 0; i < pos.length; i++) {
      const k = pos[i];
      score += 1;
      if (i > 0 && pos[i - 1] === k - 1) score += 5;
      if (k === 0 || isSep(path[k - 1])) score += 4;
      else if (path[k] >= "A" && path[k] <= "Z" && path[k - 1] >= "a" && path[k - 1] <= "z") score += 4; // camelCase hump = a segment start
      if (k >= baseStart) score += 2;
    }
    if (p.slice(baseStart).startsWith(q)) score += 10;
    if (p.slice(baseStart) === q || p.slice(baseStart).replace(/\.[^.]+$/, "") === q) score += 10;
    score -= Math.min(path.length, 200) * 0.05;
    if (!best || score > best.score) best = { path, score, positions: pos };
  }
  return best;
}

/** Best `limit` paths for the query; an empty query lists the shortest paths first. */
export function rankFiles(files: string[], query: string, limit = 50): FuzzyHit[] {
  if (!query.trim()) {
    return [...files]
      .sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length || a.localeCompare(b))
      .slice(0, limit)
      .map((path) => ({ path, score: 0, positions: [] }));
  }
  const hits: FuzzyHit[] = [];
  for (const f of files) {
    const h = fuzzyScore(f, query);
    if (h) hits.push(h);
  }
  return hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path)).slice(0, limit);
}

export type SearchMatch = { path: string; line: number; col: number; text: string };
export type FileGroup = { path: string; matches: SearchMatch[] };

/** Groups server matches by file, keeping the server's order (files and lines). */
export function groupMatches(matches: SearchMatch[]): FileGroup[] {
  const by = new Map<string, FileGroup>();
  for (const m of matches) {
    let g = by.get(m.path);
    if (!g) by.set(m.path, (g = { path: m.path, matches: [] }));
    g.matches.push(m);
  }
  return [...by.values()];
}

/** [start, end) ranges of the query in a result line, for highlighting. Bad regexes give []. */
export function matchRanges(text: string, q: string, opts: { regex?: boolean; caseSensitive?: boolean } = {}): [number, number][] {
  if (!q) return [];
  const out: [number, number][] = [];
  if (opts.regex) {
    let re: RegExp;
    try {
      re = new RegExp(q, opts.caseSensitive ? "g" : "gi");
    } catch {
      return [];
    }
    for (const m of text.matchAll(re)) {
      if (!m[0]) break;
      out.push([m.index!, m.index! + m[0].length]);
      if (out.length >= 20) break;
    }
    return out;
  }
  const hay = opts.caseSensitive ? text : text.toLowerCase();
  const needle = opts.caseSensitive ? q : q.toLowerCase();
  for (let i = hay.indexOf(needle); i >= 0 && out.length < 20; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length]);
  return out;
}

/** Splits text into plain / marked parts for the given ranges (sorted, non-overlapping). */
export function splitMarked(text: string, ranges: [number, number][]): { text: string; mark: boolean }[] {
  const parts: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s < at) continue;
    if (s > at) parts.push({ text: text.slice(at, s), mark: false });
    parts.push({ text: text.slice(s, e), mark: true });
    at = e;
  }
  if (at < text.length) parts.push({ text: text.slice(at), mark: false });
  return parts;
}

/** Ranges for the fuzzy positions (each matched char its own range, merged when adjacent). */
export function positionRanges(positions: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of positions) {
    const last = out[out.length - 1];
    if (last && last[1] === p) last[1] = p + 1;
    else out.push([p, p + 1]);
  }
  return out;
}
