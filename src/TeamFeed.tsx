import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO } from "./paseo";
import { demoLog, type FeedEntry } from "./demo";
import type { TeamDef } from "./teams";
import { Ago } from "./ui";
import { useDraft } from "./drafts";
import { shouldComposerSubmit } from "./IdeaInbox";

export const LOG_LIMIT = 240;
const TYPES = ["aub", "done", "decision", "blocker", "needs-aub", "handoff", "metric"] as const;

export async function postLog(team: string, entry: { type: "aub" | "handoff"; text: string; agent?: string; lane?: string; refs?: string[] }): Promise<FeedEntry> {
  if (DEMO) return { ts: new Date().toISOString(), agent: entry.agent ?? "aub", lane: entry.lane ?? "", refs: [], ...entry };
  const res = await fetch("/__vibesquad/log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ team, ...entry }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `log post failed (${res.status})`);
  return body as FeedEntry;
}

async function fetchLog(team: string): Promise<FeedEntry[]> {
  if (DEMO) return demoLog();
  const res = await fetch(`/__vibesquad/log?team=${encodeURIComponent(team)}`);
  if (!res.ok) throw new Error(`log fetch failed (${res.status})`);
  return (await res.json()) as FeedEntry[];
}

// Owner's entries first (pinned), then everything else newest-first.
function ordered(entries: FeedEntry[]): FeedEntry[] {
  const newest = (a: FeedEntry, b: FeedEntry) => b.ts.localeCompare(a.ts);
  const aub = entries.filter((e) => e.type === "aub").sort(newest).slice(0, 3);
  const pinned = new Set(aub);
  return [...aub, ...entries.filter((e) => !pinned.has(e)).sort(newest)].slice(0, 40);
}

function Ref({ r }: { r: string }) {
  if (/^https?:\/\//.test(r))
    return (
      <a className="feed-ref" href={r} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
        {r.replace(/^https?:\/\/(www\.)?/, "")}
      </a>
    );
  return (
    <button className="feed-ref" title="Copy to clipboard" onClick={() => navigator.clipboard?.writeText(r).catch(() => {})}>
      {r}
    </button>
  );
}

export const TeamFeed = memo(function TeamFeed({ team }: { team: TeamDef }) {
  const [open, setOpen] = useState(true);
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [error, setError] = useState("");
  const [draft, setDraft, clearDraft] = useDraft(`feed:${team.id}:draft`);
  const [busy, setBusy] = useState(false);

  // Polls return the whole log; only re-render when it actually changed.
  const lastRaw = useRef("");
  const load = useCallback(() => {
    fetchLog(team.id)
      .then((e) => {
        const raw = JSON.stringify(e);
        if (raw !== lastRaw.current) {
          lastRaw.current = raw;
          setEntries(e);
        }
        setError("");
      })
      .catch((e) => setError(String(e)));
  }, [team.id]);

  useEffect(() => {
    lastRaw.current = "";
    load();
    if (DEMO) return;
    // No polling while the tab is hidden; catch up as soon as it is visible again.
    const t = setInterval(() => document.hidden || load(), 10_000);
    const onVisible = () => document.hidden || load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const over = draft.length > LOG_LIMIT;
  const post = async () => {
    const text = draft.trim();
    if (!text || over) return;
    setBusy(true);
    try {
      const e = await postLog(team.id, { type: "aub", text });
      setEntries((cur) => [...cur, e]);
      clearDraft();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  // Typing in the composer must not rebuild the entry list.
  const listItems = useMemo(
    () =>
      ordered(entries).map((e, i) => (
        <div key={`${e.ts}-${i}`} className={`feed-entry ${e.type}`}>
          <span className={`feed-type ${e.type}`}>{e.type === "aub" ? "★ AUB" : e.type}</span>
          {e.lane && <span className="lane-tag">{e.lane}</span>}
          <span className="feed-text">
            {e.text}
            {e.refs?.map((r) => <Ref key={r} r={r} />)}
          </span>
          <span className="muted small feed-meta" title={`${e.agent} · ${e.ts}`}>
            {e.type === "aub" ? "" : `${e.agent.startsWith("★ LEAD · ") ? `★ ${e.agent.slice(9)}` : e.agent} · `}
            <Ago iso={e.ts} /> ago
          </span>
        </div>
      )),
    [entries],
  );
  return (
    <section className="team-feed">
      <button className="cast-toggle feed-toggle" onClick={() => setOpen(!open)}>
        <span>{open ? "▾" : "▸"} TEAM STANDUP FEED</span>
        <span className="cast-summary">
          {TYPES.map((t) => {
            const n = entries.filter((e) => e.type === t).length;
            return (
              n > 0 && (
                <span key={t} className={`feed-type ${t}`}>
                  {t} {n}
                </span>
              )
            );
          })}
        </span>
      </button>
      {open && (
        <>
          <div className="feed-list">
            {error && <div className="stat-alert small">{error}</div>}
            {listItems.length === 0 && !error && <div className="muted small">No log entries yet. Leads write with `vs log`.</div>}
            {listItems}
          </div>
          <div className="feed-composer">
            <textarea
              className="inbox-input"
              rows={draft.includes("\n") ? Math.min(3, draft.split(/\r?\n/).length) : 1}
              style={{ flex: 1, background: "var(--navy)", color: "var(--text)", border: "1px solid var(--line)", padding: "5px 8px", font: "inherit", resize: "vertical" }}
              value={draft}
              placeholder="Post as owner (type=aub), pinned for leads…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (shouldComposerSubmit(e)) {
                  e.preventDefault();
                  void post();
                }
              }}
            />
            <span className={`feed-count ${over ? "over" : ""}`}>
              {draft.length}/{LOG_LIMIT}
            </span>
            <button className="btn ok" disabled={busy || !draft.trim() || over} onClick={post}>
              Post as owner
            </button>
          </div>
        </>
      )}
    </section>
  );
});
