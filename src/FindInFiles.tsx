import { useEffect, useMemo, useRef, useState } from "react";
import { DEMO } from "./paseo";
import { openInFiles, type NavAgent } from "./QuickOpen";
import { groupMatches, matchRanges, splitMarked, type SearchMatch } from "./navigateLogic";

// Find in files (Ctrl+Shift+F): searches the active agent's cwd through GET /__vibesquad/search
// (`git grep`, or `rg` when it is on PATH), groups hits by file, and a click opens Files at that line.
// The last query and results survive closing the panel, like an editor's search view.

type Result = { matches: SearchMatch[]; truncated: boolean; engine?: string };

let last: { cwd: string; q: string; regex: boolean; caseSensitive: boolean; result: Result | null } = { cwd: "", q: "", regex: false, caseSensitive: false, result: null };

const DEMO_MATCHES: SearchMatch[] = [
  { path: "src/App.tsx", line: 12, col: 10, text: "import { FilesPanel } from \"./FilesPanel\";" },
  { path: "src/FilesPanel.tsx", line: 80, col: 17, text: "export function FilesPanel({" },
];

export function FindInFiles({ agent, onClose }: { agent: NavAgent | null; onClose: () => void }) {
  const cwd = agent?.cwd ?? "";
  const keep = last.cwd === cwd;
  const [q, setQ] = useState(keep ? last.q : "");
  const [regex, setRegex] = useState(keep && last.regex);
  const [caseSensitive, setCase] = useState(keep && last.caseSensitive);
  const [result, setResult] = useState<Result | null>(keep ? last.result : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const restored = useRef(keep && !!last.result);

  useEffect(() => {
    last = { cwd, q, regex, caseSensitive, result };
  }, [cwd, q, regex, caseSensitive, result]);

  useEffect(() => {
    if (!cwd || !q.trim()) {
      setResult(null);
      setErr("");
      setBusy(false);
      return;
    }
    if (restored.current) {
      restored.current = false; // reopened with the last results: don't re-run the same search
      return;
    }
    const ac = new AbortController();
    setBusy(true);
    const h = setTimeout(() => {
      if (DEMO) {
        const needle = q.toLowerCase();
        setResult({ matches: DEMO_MATCHES.filter((m) => m.text.toLowerCase().includes(needle)), truncated: false, engine: "demo" });
        setBusy(false);
        return;
      }
      const qs = new URLSearchParams({ cwd, q, ...(regex ? { regex: "1" } : {}), ...(caseSensitive ? { case: "1" } : {}) });
      fetch(`/__vibesquad/search?${qs}`, { signal: ac.signal })
        .then(async (r) => {
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
          setErr("");
          setSel(0);
          setResult({ matches: j.matches ?? [], truncated: !!j.truncated, engine: j.engine });
        })
        .catch((e) => {
          if (ac.signal.aborted) return;
          setResult(null);
          setErr(String(e?.message ?? e));
        })
        .finally(() => !ac.signal.aborted && setBusy(false));
    }, 300);
    return () => {
      clearTimeout(h);
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, q, regex, caseSensitive]);

  const groups = useMemo(() => groupMatches(result?.matches ?? []), [result]);
  const flat = useMemo(() => groups.flatMap((g) => g.matches), [groups]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const pick = (m: SearchMatch) => {
    if (!agent) return;
    onClose();
    openInFiles(agent.id, m.path, m.line);
  };

  let idx = 0;
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="cmd-palette find-files" data-testid="find-in-files" role="dialog" aria-label="Find in files" onMouseDown={(e) => e.stopPropagation()}>
        <div className="find-files-bar">
          <input
            autoFocus
            data-testid="find-in-files-input"
            value={q}
            placeholder={agent ? `Find in ${agent.title}…` : "Find in files…"}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(flat.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter" && flat[sel]) pick(flat[sel]);
            }}
          />
          <button className={`find-toggle ${caseSensitive ? "on" : ""}`} data-testid="find-in-files-case" aria-pressed={caseSensitive} title="Match case" onClick={() => setCase((v) => !v)}>
            Aa
          </button>
          <button className={`find-toggle ${regex ? "on" : ""}`} data-testid="find-in-files-regex" aria-pressed={regex} title="Use regular expression" onClick={() => setRegex((v) => !v)}>
            .*
          </button>
        </div>
        <div className="cmd-list" ref={listRef}>
          {!agent && <div className="cmd-empty muted">Open an agent first: find in files searches its working folder.</div>}
          {agent && busy && <div className="cmd-empty muted">Searching…</div>}
          {agent && err && (
            <div className="cmd-empty dup-warning" role="alert">
              {err}
            </div>
          )}
          {!busy && result && flat.length === 0 && (
            <div className="cmd-empty muted" data-testid="find-in-files-empty">
              No results
            </div>
          )}
          {!busy && result && flat.length > 0 && (
            <div className="cmd-empty muted small" data-testid="find-in-files-summary">
              {flat.length}
              {result.truncated ? "+" : ""} result{flat.length === 1 ? "" : "s"} in {groups.length} file{groups.length === 1 ? "" : "s"}
              {result.truncated ? " (stopped early: narrow the search)" : ""}
            </div>
          )}
          {!busy &&
            groups.map((g) => (
              <div key={g.path} className="find-group" data-testid="find-in-files-group">
                <div className="find-group-head" title={g.path}>
                  <b>{g.path}</b> <span className="muted small">{g.matches.length}</span>
                </div>
                {g.matches.map((m) => {
                  const i = idx++;
                  const parts = splitMarked(m.text, matchRanges(m.text, q, { regex, caseSensitive }));
                  return (
                    <button key={`${m.line}:${m.col}`} data-idx={i} className={`cmd-item find-hit ${i === sel ? "on" : ""}`} data-testid="find-in-files-hit" onMouseEnter={() => setSel(i)} onClick={() => pick(m)}>
                      <span className="find-lineno">{m.line}</span>
                      <span className="find-text">{parts.map((p, k) => (p.mark ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>))}</span>
                    </button>
                  );
                })}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
