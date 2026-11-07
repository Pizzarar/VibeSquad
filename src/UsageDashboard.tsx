import { useEffect, useMemo, useState } from "react";
import { buildRows, etaText, foldRoles, relTime, sortRows, type LimitRow, type SortKey, type UsageData } from "./usageHelpers";

// Usage dashboard for the Squads screen (docs/PLAN_USAGE_DASHBOARD.md step 4).
// Data: GET /__vibesquad/providers/usage (server/providers-catalog.mjs getUsage).

const POLL_MS = 60_000;
const MIN_GAP_MS = 10_000;
const HIGH_REVIEW_ROUNDS = 2;

const PROVIDER_LABEL: Record<string, string> = {
  claude: "Claude",
  "antigravity-cli": "Gemini",
  "antigravity-cli/claude-gpt": "Google plan · Claude/GPT",
};
const WINDOW_LABEL: Record<string, string> = { "5h": "5h", weekly: "weekly" };

const providerLabel = (p: string) => PROVIDER_LABEL[p] ?? p;
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const usd = (n: number) => `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

function LimitCard({ l, now }: { l: LimitRow; now: number }) {
  const used = Math.max(0, Math.min(100, l.usedPct));
  const level = used >= 90 ? "hot" : used >= 70 ? "warn" : "ok";
  const resetMs = l.resetsAt ? Date.parse(l.resetsAt) : null;
  const estimate = l.source === "estimate";
  return (
    <div className={`usage-limit usage-${level}`} data-testid="usage-limit-card" data-provider={l.provider} data-window={l.window}>
      <div className="usage-limit-head">
        <span className="usage-limit-name">{providerLabel(l.provider)}</span>
        <span className="usage-limit-win">{WINDOW_LABEL[l.window] ?? l.window}</span>
        {estimate && <span className="usage-estimate" title="Local estimate from our own token counts, not a provider-reported number">estimate</span>}
      </div>
      <div className="usage-limit-pct">{Math.round(used)}<small>% used</small></div>
      <div className="usage-bar" role="progressbar" aria-valuenow={Math.round(used)} aria-valuemin={0} aria-valuemax={100}>
        <div className="usage-bar-fill" style={{ width: `${used}%` }} />
      </div>
      <div className="usage-limit-meta small">
        <span title={resetMs ? new Date(resetMs).toLocaleString() : undefined}>{resetMs ? `resets ${relTime(resetMs, now)}` : "reset unknown"}</span>
        <span>{l.burnPctPerHour > 0 ? `burn ${l.burnPctPerHour}%/h` : "burn 0%/h"}</span>
      </div>
      <div className={`usage-eta small${l.etaToCap ? " usage-eta-warn" : ""}`}>{etaText(l)}</div>
    </div>
  );
}

const COLS: { key: SortKey; label: string; num: boolean }[] = [
  { key: "lane", label: "Lane", num: false },
  { key: "tokens", label: "Tokens", num: true },
  { key: "costUsd", label: "Cost", num: true },
  { key: "turns", label: "Turns", num: true },
  { key: "avg", label: "Avg tok/turn", num: true },
  { key: "coord", label: "Coord/Exec", num: true },
  { key: "restarts", label: "Restarts", num: true },
  { key: "handoffs", label: "Handoffs", num: true },
  { key: "merged", label: "Merged", num: true },
  { key: "rounds", label: "Rev rounds/unit", num: true },
  { key: "costUnit", label: "Cost/unit", num: true },
];

export function useUsage(): { data: UsageData | null; error: string | null } {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let last = 0;
    let inflight = false;
    const load = async () => {
      const t = Date.now();
      if (inflight || t - last < MIN_GAP_MS) return;
      inflight = true;
      last = t;
      try {
        const res = await fetch("/__vibesquad/providers/usage");
        if (!res.ok) throw new Error(`usage ${res.status}`);
        const j = await res.json();
        if (alive) { setData(j); setError(null); }
      } catch (e) {
        if (alive) setError(String((e as Error)?.message ?? e));
      } finally {
        inflight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);
  return { data, error };
}

export function UsageDashboard() {
  const { data, error } = useUsage();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "costUsd", dir: -1 });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); }, [data]);

  const limits = useMemo(() => {
    const rank = (l: LimitRow) => (l.provider === "antigravity-cli" && l.window === "5h" ? 0 : l.provider === "claude" && l.window === "weekly" ? 1 : 2);
    return [...(data?.limits ?? [])].sort((a, b) => rank(a) - rank(b) || a.provider.localeCompare(b.provider) || a.window.localeCompare(b.window));
  }, [data]);
  const rows = useMemo(() => (data ? sortRows(buildRows(data), sort.key, sort.dir) : []), [data, sort]);

  if (!data) {
    return (
      <div className="squads-dashboard" data-testid="squads-dashboard">
        <div className="muted small">{error ? `Usage unavailable: ${error}` : "Loading usage…"}</div>
      </div>
    );
  }
  const flagged = data.loops?.flagged ?? [];
  const roles = foldRoles(data.byRole);
  const roleTotal = roles.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const click = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "lane" ? 1 : -1 }));

  return (
    <div className="squads-dashboard" data-testid="squads-dashboard">
      <div className="usage-title">Usage</div>
      <div className="usage-limits" data-testid="usage-limits">
        {limits.length === 0 ? (
          <div className="usage-empty muted small" data-testid="usage-limits-empty">no limit data yet — appears after the next Claude/Gemini turn</div>
        ) : (
          limits.map((l) => <LimitCard key={`${l.provider}|${l.window}`} l={l} now={now} />)
        )}
      </div>

      <div className="usage-split">
        <div className="usage-roles" data-testid="usage-roles">
          <div className="usage-sub">Role split</div>
          {roles.map((r) => {
            const t = r.inputTokens + r.outputTokens;
            return (
              <div className="usage-role" key={r.role} data-role={r.role}>
                <span className="usage-role-name">{r.role || "unknown"}</span>
                <div className="usage-bar usage-bar-thin"><div className="usage-bar-fill" style={{ width: `${roleTotal ? (t / roleTotal) * 100 : 0}%` }} /></div>
                <span className="small">{tok(t)} · {usd(r.costUsd)} · {r.turns}t · {tok(r.avgTokensPerTurn)}/t</span>
              </div>
            );
          })}
          {data.coordination && (
            <div className="small muted usage-coord">coordination {pct(data.coordination.coordinationShare)} vs execution {pct(1 - data.coordination.coordinationShare)} of tokens</div>
          )}
        </div>
        <div className="usage-loops" data-testid="usage-loops">
          <div className="usage-sub">Loop flags {flagged.length > 0 && <span className="usage-flag">{flagged.length}</span>}</div>
          {flagged.length === 0 ? (
            <div className="small muted">none (&gt;{data.loops?.threshold ?? "?"} turns with no PASS)</div>
          ) : (
            flagged.slice(0, 5).map((f) => (
              <div className="usage-loop small" key={f.agentId} title={f.title}>
                <span className="usage-flag">loop</span> {f.lane} · {f.role} · {f.turns} turns
              </div>
            ))
          )}
        </div>
      </div>

      <div className="usage-table-wrap">
        <table className="usage-table" data-testid="usage-lane-table">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.key} className={c.num ? "num" : ""} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                  <button type="button" className="usage-th" onClick={() => click(c.key)}>
                    {c.label}{sort.key === c.key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={COLS.length} className="muted small">no lane usage recorded yet</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.lane} data-lane={r.lane} className={r.looped ? "usage-row-loop" : ""}>
                <td>{r.lane}{r.looped > 0 && <span className="usage-flag" title="agent over the turn threshold with no PASS">loop</span>}</td>
                <td className="num">{tok(r.tokens)}</td>
                <td className="num">{usd(r.costUsd)}</td>
                <td className="num">{r.turns}</td>
                <td className="num">{tok(r.avg)}</td>
                <td className="num">{pct(r.coord)}/{pct(1 - r.coord)}</td>
                <td className="num">{r.restarts}</td>
                <td className="num">{r.handoffs}</td>
                <td className="num">{r.merged || "–"}</td>
                <td className={`num${r.rounds !== null && r.rounds >= HIGH_REVIEW_ROUNDS ? " usage-high" : ""}`}>{r.rounds === null ? "–" : r.rounds.toFixed(1)}</td>
                <td className="num">{r.costUnit === null ? "–" : usd(r.costUnit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
