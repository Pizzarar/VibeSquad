import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { efficiencySummary, rolesSummary, usageOpenKey, bugInboxCards, buildProfiles, buildRows, COHORT_METRICS, cohortValueText, deltaText, deltaTrend, dur, etaText, filterInbox, floorSegments, inboxBucket, inboxCounts, inboxIdLabel, inboxFrom, inboxStatusLabel, INBOX_FILTERS, laneSummary, lowCostCoverage, profileSummary, sortWorkflows, speedupText, tokText, USAGE_EXPORT_MD_URL, usdText, foldRoles, pctText, relTime, sortProfiles, sortRows, stormText, usageReviewStatus, USAGE_REVIEW_INTERVALS, USAGE_REVIEW_LABELS, withUsageReview, workflowSummary, workIdlePct, type InboxFilter, type LimitRow, type SortKey, type UsageData, type UsageReview } from "./usageHelpers";
import { refreshInboxCards, triageInbox, useInboxCards } from "./IdeaInbox";

// Usage dashboard for the Squads screen (docs/PLAN_USAGE_DASHBOARD.md step 4).
// Data: GET /__vibesquad/providers/usage (server/providers-catalog.mjs getUsage).

const POLL_MS = 60_000;
const MIN_GAP_MS = 10_000;
const REVIEW_POLL_MS = 5_000;
const HIGH_REVIEW_ROUNDS = 2;
const HIGH_FIX_RATE = 0.25;

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

type UsageReviewPostResponse = { ok?: boolean; usageReview?: UsageReview; error?: string };

/** Owner-gated write to the usage-review endpoint (interval change or Run now). Returns the parsed body. */
async function postUsageReview(body: { interval?: string; runNow?: boolean }): Promise<UsageReviewPostResponse> {
  const res = await fetch("/__vibesquad/providers/usage-review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as UsageReviewPostResponse;
  if (!res.ok) throw new Error(j.error ?? `usage-review ${res.status}`);
  return j;
}

type TriageCrtProps = {
  now: number;
  review: UsageReview | null | undefined;
  running: boolean;
  status: string;
  error: string | null;
  onInterval: (interval: string) => void;
  onRun: () => void;
};

/** CRT mail terminal: bug-chaser / perfection cards and usage-review bullets with 1-click Accept / Reject. */
function TriageCrt({ now, review, running, status, error, onInterval, onRun }: TriageCrtProps) {
  const all = useInboxCards();
  const cards = useMemo(() => bugInboxCards(all), [all]);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void refreshInboxCards(); }, []);
  const counts = inboxCounts(cards);
  const shown = filterInbox(cards, filter);
  const triage = async (cardId: string, next: "accepted" | "rejected") => {
    setBusy(cardId);
    setErr(null);
    try {
      await triageInbox({ action: "update", cardId, patch: { status: next } });
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };
  const failure = error ?? err;
  return (
    <section className="usage-crt" data-testid="usage-review">
      <div className="usage-crt-bar">
        <span className="usage-crt-title">MAIL://BUG-AND-PERFECTION</span>
        {review && (
          <div className="usage-review-controls">
            <select className="usage-review-select" value={review.interval} onChange={(e) => onInterval(e.target.value)} aria-label="Usage review interval">
              {USAGE_REVIEW_INTERVALS.map((iv) => (
                <option key={iv} value={iv}>{USAGE_REVIEW_LABELS[iv]}</option>
              ))}
            </select>
            <button type="button" className="usage-review-run" onClick={onRun} disabled={running}>
              {running ? "running…" : "Run now"}
            </button>
          </div>
        )}
        {status && <span className="usage-review-status small">{status}</span>}
        <div className="usage-inbox-tabs" role="tablist" aria-label="Bug Chaser inbox filter">
          {INBOX_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              className={`usage-inbox-tab${filter === f.key ? " is-active" : ""}`}
              data-filter={f.key}
              onClick={() => setFilter(f.key)}
            >
              [{f.label}] <span className="usage-inbox-count">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="usage-bug-inbox" data-testid="usage-bug-inbox">
        {failure && <div className="usage-review-error small">{failure}</div>}
        {shown.length === 0 ? (
          <div className="usage-empty muted small">{cards.length === 0 ? "no bug-chaser cards yet — review suggestions land here" : "nothing in this filter"}</div>
        ) : (
          <ul className="usage-inbox-list">
            {shown.map((c) => {
              const from = inboxFrom(c);
              const bucket = inboxBucket(c);
              const t = Date.parse(c.createdAt);
              return (
                <li key={c.id} className="usage-inbox-row" data-testid="usage-bug-inbox-row" data-status={bucket}>
                  <div className="usage-inbox-meta small">
                    <span>FROM <span className={`usage-inbox-src usage-inbox-src-${from.key}`}>[{from.label}]</span></span>
                    <span>· @{c.laneId || "other"}</span>
                    <span>· {inboxIdLabel(c.id)}</span>
                    {Number.isFinite(t) && <span>· {relTime(t, now)}</span>}
                    {bucket !== "queue" && <span className="usage-inbox-state">· {inboxStatusLabel(c)}</span>}
                  </div>
                  <div className="usage-inbox-text">{c.text}</div>
                  {c.summaryNote && <div className="usage-inbox-note small">{c.summaryNote}</div>}
                  {bucket === "queue" && (
                    <div className="usage-inbox-actions">
                      <button type="button" className="usage-inbox-btn usage-inbox-accept" disabled={busy === c.id} onClick={() => triage(c.id, "accepted")}>[Y] ACCEPT</button>
                      <button type="button" className="usage-inbox-btn usage-inbox-reject" disabled={busy === c.id} onClick={() => triage(c.id, "rejected")}>[N] REJECT</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

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
      <div className="usage-limit-pct">{100 - Math.round(used)}% left<small>({Math.round(used)}% used)</small></div>
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

/** Collapsed-by-default section; open state persists in localStorage under vs.usage.open.<id>. */
function Collapse({ id, testid, summary, className, children }: { id: string; testid: string; summary: string; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(usageOpenKey(id)) === "1"; } catch { return false; }
  });
  return (
    <details
      className={`usage-collapse${className ? ` ${className}` : ""}`}
      data-testid={testid}
      open={open}
      onToggle={(e) => {
        const o = e.currentTarget.open;
        setOpen(o);
        try { localStorage.setItem(usageOpenKey(id), o ? "1" : "0"); } catch { /* storage unavailable */ }
      }}
    >
      <summary className="usage-collapse-head">{summary}</summary>
      {children}
    </details>
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
  { key: "workPct", label: "Work %", num: true },
  { key: "cycle", label: "Cycle (unit/plan)", num: true },
  { key: "fixRate", label: "Fix rate", num: true },
];

export function useUsage(): { data: UsageData | null; error: string | null; refresh: (force?: boolean) => void; applyUsageReview: (review: UsageReview | null | undefined) => void } {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef<((force?: boolean) => void) | null>(null);
  useEffect(() => {
    let alive = true;
    let last = 0;
    let inflight = false;
    const load = async (force = false) => {
      const t = Date.now();
      if (inflight || (!force && t - last < MIN_GAP_MS)) return;
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
    loadRef.current = load;
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, POLL_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      alive = false;
      loadRef.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);
  const refresh = useCallback((force = false) => loadRef.current?.(force), []);
  const applyUsageReview = useCallback((review: UsageReview | null | undefined) => {
    setData((d) => (d ? withUsageReview(d, review) : d));
  }, []);
  return { data, error, refresh, applyUsageReview };
}

export function UsageDashboard() {
  const { data, error, refresh, applyUsageReview } = useUsage();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "costUsd", dir: -1 });
  const [now, setNow] = useState(() => Date.now());
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  useEffect(() => { setNow(Date.now()); }, [data]);
  // While a review is running, force-poll so the last/history/status update as soon as it finishes.
  useEffect(() => {
    if (!data?.usageReview?.inFlight) return;
    const t = window.setInterval(() => refresh(true), REVIEW_POLL_MS);
    return () => window.clearInterval(t);
  }, [data?.usageReview?.inFlight, refresh]);

  const changeInterval = async (interval: string) => {
    setReviewBusy(true);
    setReviewError(null);
    try {
      const j = await postUsageReview({ interval });
      applyUsageReview(j.usageReview);
      refresh(true);
    } catch (e) {
      setReviewError(String((e as Error)?.message ?? e));
    } finally {
      setReviewBusy(false);
    }
  };
  const runNow = async () => {
    setReviewBusy(true);
    setReviewError(null);
    try {
      const j = await postUsageReview({ runNow: true });
      applyUsageReview(j.usageReview);
      refresh(true);
    } catch (e) {
      setReviewError(String((e as Error)?.message ?? e));
    } finally {
      setReviewBusy(false);
    }
  };

  const limits = useMemo(() => {
    const rank = (l: LimitRow) => (l.provider === "antigravity-cli" && l.window === "5h" ? 0 : l.provider === "claude" && l.window === "weekly" ? 1 : 2);
    return [...(data?.limits ?? [])].sort((a, b) => rank(a) - rank(b) || a.provider.localeCompare(b.provider) || a.window.localeCompare(b.window));
  }, [data]);
  const rows = useMemo(() => (data ? sortRows(buildRows(data), sort.key, sort.dir) : []), [data, sort]);
  const profiles = useMemo(() => (data ? sortProfiles(buildProfiles(data)) : []), [data]);
  const workflows = useMemo(() => sortWorkflows(data?.byWorkflow), [data]);

  const review = data?.usageReview;
  const running = Boolean(review?.inFlight) || reviewBusy;
  const reviewStatus = usageReviewStatus(review, now);

  if (!data) {
    return (
      <div className="squads-dashboard" data-testid="squads-dashboard">
        <TriageCrt now={now} review={review} running={running} status={reviewStatus} error={reviewError} onInterval={changeInterval} onRun={runNow} />
        <div className="muted small">{error ? `Usage unavailable: ${error}` : "Loading usage…"}</div>
      </div>
    );
  }
  const flagged = data.loops?.flagged ?? [];
  const storms = data.spawnStorms ?? [];
  const roles = foldRoles(data.byRole ?? []);
  const roleTotal = roles.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const click = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "lane" ? 1 : -1 }));

  return (
    <div className="squads-dashboard" data-testid="squads-dashboard">
      <TriageCrt now={now} review={review} running={running} status={reviewStatus} error={reviewError} onInterval={changeInterval} onRun={runNow} />
      <div className="usage-title">Usage</div>
      <div className="usage-limits" data-testid="usage-limits">
        {limits.length === 0 ? (
          <div className="usage-empty muted small" data-testid="usage-limits-empty">no limit data yet — appears after the next Claude/Gemini turn</div>
        ) : (
          limits.map((l) => <LimitCard key={`${l.provider}|${l.window}`} l={l} now={now} />)
        )}
      </div>

      <Collapse id="roles" testid="usage-roles-collapse" summary={rolesSummary(data.coordination?.coordinationShare, flagged.length, storms.length)}>
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
        {data.spawnStorms && (
          <div className="usage-storms" data-testid="usage-storms">
            <div className="usage-sub">Spawn storms {storms.length > 0 && <span className="usage-flag usage-flag-storm">{storms.length}</span>}</div>
            {storms.length === 0 ? (
              <div className="small muted">none (&lt;3 spawns or zero-turn exits per window)</div>
            ) : (
              storms.slice(0, 5).map((s, i) => (
                <div className="usage-loop small" key={`${s.lane}|${s.role}|${i}`} title={`${s.firstAt} → ${s.lastAt}`}>
                  <span className="usage-flag usage-flag-storm">storm</span> {stormText(s)}
                </div>
              ))
            )}
          </div>
        )}
      </div>
      </Collapse>

      <Collapse id="lanes" testid="usage-lane-collapse" summary={laneSummary(rows)}>
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
                <td className="num">{pctText(r.workPct)}</td>
                <td className="num">{r.unitCycleMs === null && r.planCycleMs === null ? "–" : `${dur(r.unitCycleMs)} / ${dur(r.planCycleMs)}`}</td>
                <td className={`num${r.fixRate !== null && r.fixRate >= HIGH_FIX_RATE ? " usage-high" : ""}`}>{pctText(r.fixRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </Collapse>

      {data.byProfile && (
        <Collapse id="profiles" testid="usage-profile-collapse" className="usage-profiles" summary={profileSummary(profiles)}>
          {profiles.length === 0 ? (
            <div className="small muted">no profile data yet</div>
          ) : (
            <div className="usage-table-wrap">
              <table className="usage-table" data-testid="usage-profile-table">
                <thead>
                  <tr>
                    <th>Profile</th>
                    <th>Provider</th>
                    <th className="num">Runs</th>
                    <th className="num">Turns/run</th>
                    <th className="num">PASS %</th>
                    <th className="num">Merged</th>
                    <th className="num">Rev/unit</th>
                    <th className="num">Cost/unit</th>
                    <th className="num">Fix rate</th>
                    <th className="num">Work/Idle</th>
                  </tr>
                </thead>
                <tbody>
                  {profiles.map((p) => (
                    <tr key={p.key} data-profile={p.profile} data-role={p.role}>
                      <td>{p.profile}</td>
                      <td className="muted">{providerLabel(p.provider)}</td>
                      <td className="num">{p.runs}</td>
                      <td className="num">{p.avgTurnsPerRun.toFixed(1)}</td>
                      <td className="num">{pctText(p.passRate)}</td>
                      <td className="num">{p.mergedUnits}</td>
                      <td className="num">{p.mergedUnits > 0 ? p.avgReviewRounds.toFixed(1) : "–"}</td>
                      <td className="num">{p.costPerMergedUnit === null ? "–" : usd(p.costPerMergedUnit)}</td>
                      <td className={`num${p.fixRate >= HIGH_FIX_RATE ? " usage-high" : ""}`}>{pctText(p.fixRate)}</td>
                      <td className="num">{workIdlePct(p.workPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Collapse>
      )}

      {(data.cohorts || data.floor) && (
        <Collapse id="efficiency" testid="usage-efficiency-collapse" summary={efficiencySummary(data.cohorts, data.floor)}>
        <section className="usage-efficiency" data-testid="usage-efficiency-strip">
          {data.cohorts && (
            <>
              <div className="usage-cohort-tiles">
                {COHORT_METRICS.map((m) => {
                  const c = data.cohorts!;
                  const delta = c.delta?.[m.key];
                  const { trend } = deltaTrend(delta, m.higherIsBetter);
                  return (
                    <div className="usage-cohort-tile" key={m.key} data-metric={m.key} data-trend={trend}>
                      <div className="usage-cohort-label small">{m.label}</div>
                      <div className="usage-cohort-value">{cohortValueText(m.kind, c.recent[m.key])}</div>
                      <div className={`usage-delta usage-delta-${trend} small`}>{deltaText(m.kind, delta)}</div>
                      <div className="usage-cohort-prior small muted">prior {cohortValueText(m.kind, c.prior[m.key])}</div>
                    </div>
                  );
                })}
              </div>
              <div className="small muted">Last {data.cohorts.recent.units} vs Prior {data.cohorts.prior.units} merged units</div>
            </>
          )}
          {data.floor && (
            <div className="usage-floor" data-testid="usage-floor">
              {floorSegments(data.floor).every((g) => g.usd === 0) ? (
                <div className="small muted">no spend recorded yet</div>
              ) : (
                <>
                  <div className="usage-floor-bar" role="img" aria-label="Clean shipping vs waste share of spend">
                    {floorSegments(data.floor).filter((g) => g.share > 0).map((g) => (
                      <div key={g.key} className={`usage-floor-seg usage-floor-${g.key}`} style={{ width: `${g.share * 100}%` }} title={`${g.label}: ${usdText(g.usd)} (${pct(g.share)})`} />
                    ))}
                  </div>
                  <div className="usage-floor-legend small">
                    {floorSegments(data.floor).map((g) => (
                      <span key={g.key} className="usage-floor-key"><i className={`usage-floor-dot usage-floor-${g.key}`} />{g.label} {pctText(g.share)} · {usdText(g.usd)}</span>
                    ))}
                  </div>
                </>
              )}
              <div className="usage-floor-callout small">
                Clean-run floor: <strong>{usdText(data.floor.cleanCostPerUnit)}</strong>/unit · <strong>{tokText(data.floor.cleanTokensPerUnit)}</strong> tokens/unit
                {data.floor.cleanShare !== null && <> · clean {pctText(data.floor.cleanShare)} of spend</>}
              </div>
            </div>
          )}
        </section>
        </Collapse>
      )}

      {(data.savings || workflows.length > 0) && (
        <Collapse id="workflows" testid="usage-workflows-collapse" summary={workflowSummary(data.savings, workflows.length)}>
        <section className="usage-workflows" data-testid="usage-workflows">
          <div className="usage-review-head">
            <div className="usage-sub">Savings vs solo workflow &amp; A/B workflow era</div>
            <a className="usage-export" href={USAGE_EXPORT_MD_URL} download data-testid="usage-export-md">Export Benchmark (.md)</a>
          </div>
          {data.savings && (
            <div className="usage-saving-cards">
              <div className="usage-saving-card" data-testid="usage-saving-routing">
                <div className="usage-cohort-label small">Model routing saved</div>
                <div className="usage-cohort-value">{usdText(data.savings.routingSavingsUsd)}{data.savings.routingSavingsPct !== null && <small> · {pctText(data.savings.routingSavingsPct)}</small>}</div>
                <div className="small muted">vs all-Opus {usdText(data.savings.soloOpusBaselineUsd)}</div>
              </div>
              <div className="usage-saving-card" data-testid="usage-saving-context">
                <div className="usage-cohort-label small">Brief/split context saved</div>
                <div className="usage-cohort-value">{tokText(data.savings.contextSavingsTokens)}<small> tokens</small></div>
                <div className="small muted">vs monolithic {tokText(data.savings.monolithicBaselineTokens)}</div>
              </div>
              <div className="usage-saving-card" data-testid="usage-saving-speedup">
                <div className="usage-cohort-label small">Parallel speedup</div>
                <div className="usage-cohort-value">{speedupText(data.savings.parallelSpeedup)}</div>
                <div className="small muted">agent work / wall clock</div>
              </div>
              <div className="usage-saving-card" data-testid="usage-saving-loc">
                <div className="usage-cohort-label small">Cost / 100 LOC</div>
                <div className="usage-cohort-value">{usdText(data.savings.costPer100Loc)}</div>
                <div className="small muted">{usdText(data.savings.costPerMergedUnit)}/unit · {data.savings.totalLocChanged.toLocaleString()} LOC</div>
              </div>
            </div>
          )}
          {workflows.length === 0 ? (
            <div className="small muted">no merged units tagged yet</div>
          ) : (
            <div className="usage-table-wrap">
              <table className="usage-table" data-testid="usage-workflow-table">
                <thead>
                  <tr>
                    <th>Workflow</th>
                    <th className="num">Units</th>
                    <th className="num">1st-try PASS %</th>
                    <th className="num">Avg rev rounds</th>
                    <th className="num">Cost/unit</th>
                    <th className="num">Cost/100 LOC</th>
                    <th className="num">Avg cycle</th>
                    <th className="num">Fix rate</th>
                  </tr>
                </thead>
                <tbody>
                  {workflows.map((w) => (
                    <tr key={w.workflowMode} data-workflow={w.workflowMode}>
                      <td>
                        {w.workflowMode}
                        {lowCostCoverage(w.costCoverage) && (
                          <span className="usage-estimate usage-low-coverage" title={`Cost known for ${pctText(w.costCoverage)} of units; non-Claude cost may be missing`}>low cost data</span>
                        )}
                      </td>
                      <td className="num">{w.units}</td>
                      <td className="num">{pctText(w.firstTryPassRate)}</td>
                      <td className={`num${w.avgReviewRounds >= HIGH_REVIEW_ROUNDS ? " usage-high" : ""}`}>{w.avgReviewRounds.toFixed(1)}</td>
                      <td className="num">{w.costCoverage === 0 ? "—" : usdText(w.costPerUnit)}</td>
                      <td className="num">{w.costCoverage === 0 ? "—" : usdText(w.costPer100Loc)}</td>
                      <td className="num">{dur(w.avgUnitCycleMs)}</td>
                      <td className={`num${w.fixAfterMergeRate >= HIGH_FIX_RATE ? " usage-high" : ""}`}>{pctText(w.fixAfterMergeRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        </Collapse>
      )}

    </div>
  );
}
