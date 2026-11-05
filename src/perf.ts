// Feel-pass instrumentation (docs/research/feel-baseline-2026-11.md). Timers only: every call is a
// no-op-safe wrapper and never throws. Marks are always collected in a small ring buffer;
// the overlay (?perf=1) shows them, and send-timing is posted to the team log only when ?perf=1.

export type PerfEntry = { at: number; label: string; ms: number; detail?: string };

const MAX = 300;
const entries: PerfEntry[] = [];
const starts = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

export const perfEnabled = (): boolean => {
  try {
    return new URLSearchParams(location.search).has("perf");
  } catch {
    return false;
  }
};

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function emit() {
  version++;
  listeners.forEach((l) => l());
}

export function perfRecord(label: string, ms: number, detail?: string): void {
  try {
    entries.push({ at: Date.now(), label, ms: Math.round(ms * 10) / 10, detail });
    while (entries.length > MAX) entries.shift();
    if (typeof performance !== "undefined" && performance.measure) {
      try {
        performance.measure(`vs:${label}`, { start: now() - ms, duration: ms, detail });
      } catch {
        /* older engines */
      }
    }
    emit();
  } catch {
    /* timers never throw */
  }
}

/** Start (or restart) a timer keyed by `label` + `key`. */
export function perfStart(label: string, key = ""): void {
  try {
    starts.set(`${label}|${key}`, now());
  } catch {
    /* ignore */
  }
}

/** End a timer started with perfStart; returns ms, or null when it was never started. */
export function perfEnd(label: string, key = "", detail?: string): number | null {
  try {
    const k = `${label}|${key}`;
    const t0 = starts.get(k);
    if (t0 === undefined) return null;
    starts.delete(k);
    const ms = now() - t0;
    perfRecord(label, ms, detail ? `${key} ${detail}`.trim() : key || undefined);
    return ms;
  } catch {
    return null;
  }
}

/** End a timer after the browser has painted (two animation frames), when one is running. */
export function perfEndPainted(label: string, key = "", detail?: string): void {
  try {
    if (!starts.has(`${label}|${key}`)) return;
    if (typeof requestAnimationFrame !== "function") {
      perfEnd(label, key, detail);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => void perfEnd(label, key, detail)));
  } catch {
    /* ignore */
  }
}

// ---- send → rpc resolved → first timeline event → first token rendered ----------------------

type SendRun = { t0: number; rpc?: number; firstEvent?: number; team?: string; lane?: string; done?: boolean };
const sends = new Map<string, SendRun>();

export function perfSendBegin(agentId: string, team?: string, lane?: string): void {
  try {
    sends.set(agentId, { t0: now(), team, lane });
  } catch {
    /* ignore */
  }
}

export function perfSendResolved(agentId: string): void {
  try {
    const s = sends.get(agentId);
    if (s && s.rpc === undefined) s.rpc = now() - s.t0;
  } catch {
    /* ignore */
  }
}

/** Called for each live timeline event of an agent; `isToken` marks assistant text arriving. */
export function perfSendEvent(agentId: string, isToken: boolean): void {
  try {
    const s = sends.get(agentId);
    if (!s || s.done) return;
    const t = now() - s.t0;
    if (s.firstEvent === undefined) s.firstEvent = t;
    if (!isToken) return;
    s.done = true;
    const render = () => {
      const tok = now() - s.t0;
      sends.delete(agentId);
      const fmt = (n?: number) => (n === undefined ? "n/a" : String(Math.round(n)));
      const text = `send-timing agent=${agentId} rpc=${fmt(s.rpc)}ms first-event=${fmt(s.firstEvent)}ms first-token-rendered=${fmt(tok)}ms`;
      perfRecord("send→first-token", tok, `${agentId} rpc=${fmt(s.rpc)} first-event=${fmt(s.firstEvent)}`);
      if (perfEnabled() && s.team) {
        void fetch("/__vibesquad/vs-log", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ team: s.team, lane: s.lane || s.team, type: "metric", agent: agentId, text, refs: [agentId] }),
        }).catch(() => undefined);
      }
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(render));
    else render();
  } catch {
    /* ignore */
  }
}

// ---- store for the overlay ------------------------------------------------------------------

export const perfEntries = (): readonly PerfEntry[] => entries;
export const perfVersion = () => version;
export function perfSubscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function perfClear(): void {
  entries.length = 0;
  emit();
}

export function perfMedianByLabel(): Array<{ label: string; n: number; median: number; max: number }> {
  const by = new Map<string, number[]>();
  for (const e of entries) by.set(e.label, [...(by.get(e.label) ?? []), e.ms]);
  return [...by].map(([label, xs]) => {
    const s = [...xs].sort((a, b) => a - b);
    return { label, n: s.length, median: s[Math.floor(s.length / 2)]!, max: s[s.length - 1]! };
  });
}

export function perfReportText(): string {
  const lines = ["# VibeSquad perf (" + new Date().toISOString() + ")", ""];
  for (const r of perfMedianByLabel()) lines.push(`${r.label}: n=${r.n} median=${r.median}ms max=${r.max}ms`);
  lines.push("", "# raw (time label ms detail)");
  for (const e of entries) lines.push(`${new Date(e.at).toISOString()}\t${e.label}\t${e.ms}\t${e.detail ?? ""}`);
  return lines.join("\n");
}
