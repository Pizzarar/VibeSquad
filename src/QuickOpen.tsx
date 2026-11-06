import { useEffect, useMemo, useState } from "react";
import { DEMO } from "./demoFlag";
import { isShown, getPanes, openAgent } from "./panes";
import { openRightDockTab } from "./RightDock";
import { positionRanges, rankFiles, splitMarked } from "./navigateLogic";

// Quick open (Ctrl+P): fuzzy file list for the active agent's cwd; Enter opens it in the Files dock.
// The list comes from the VS server (GET /__vibesquad/files: `git ls-files`, cached 30s per cwd) and is
// ranked here. The daemon's getDirectorySuggestions is fuzzy too but can take 15s+ on big repos.

export type NavAgent = { id: string; cwd: string; title: string };

const DEMO_FILES = ["README.md", "package.json", "src/App.tsx", "src/FilesPanel.tsx", "src/QuickOpen.tsx", "src/styles.css", "server/serve.mjs", "docs/NAMING.md"];

/** Shows the agent's drawer if needed, then opens the file (at a line) in its Files dock. */
export function openInFiles(agentId: string, path: string, line?: number) {
  if (!isShown(getPanes(), agentId)) openAgent(agentId);
  openRightDockTab("Files", { filePath: path, line });
}

const listCache = new Map<string, Promise<{ files: string[]; truncated: boolean }>>();

async function fetchFiles(cwd: string, refresh = false): Promise<{ files: string[]; truncated: boolean }> {
  if (DEMO) return { files: DEMO_FILES, truncated: false };
  if (!refresh && listCache.has(cwd)) return listCache.get(cwd)!;
  const p = fetch(`/__vibesquad/files?cwd=${encodeURIComponent(cwd)}${refresh ? "&refresh=1" : ""}`)
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return { files: (j.files ?? []) as string[], truncated: !!j.truncated };
    })
    .catch((e) => {
      listCache.delete(cwd);
      throw e;
    });
  listCache.set(cwd, p);
  setTimeout(() => listCache.get(cwd) === p && listCache.delete(cwd), 30_000);
  return p;
}

export function QuickOpen({ agent, onClose }: { agent: NavAgent | null; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [err, setErr] = useState("");
  const cwd = agent?.cwd ?? "";

  useEffect(() => {
    if (!cwd) return;
    let live = true;
    fetchFiles(cwd).then(
      (r) => {
        if (!live) return;
        setFiles(r.files);
        setTruncated(r.truncated);
      },
      (e) => live && setErr(String(e?.message ?? e)),
    );
    return () => {
      live = false;
    };
  }, [cwd]);

  const shown = useMemo(() => (files ? rankFiles(files, q, 50) : []), [files, q]);

  const pick = (path: string) => {
    if (!agent) return;
    onClose();
    openInFiles(agent.id, path);
  };

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="cmd-palette" data-testid="quick-open" role="dialog" aria-label="Quick open file" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          data-testid="quick-open-input"
          value={q}
          placeholder={agent ? `Open a file in ${agent.title}…` : "Open a file…"}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.max(0, Math.min(shown.length - 1, s + 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === "Enter" && shown[sel]) pick(shown[sel].path);
          }}
        />
        <div className="cmd-list">
          {!agent && <div className="cmd-empty muted">Open an agent first: quick open lists its working folder.</div>}
          {agent && err && (
            <div className="cmd-empty dup-warning" role="alert">
              Could not list files: {err}
            </div>
          )}
          {agent && !err && !files && <div className="cmd-empty muted">Listing files…</div>}
          {files && shown.length === 0 && <div className="cmd-empty muted">No matching files</div>}
          {shown.map((h, i) => {
            const parts = splitMarked(h.path, positionRanges(h.positions));
            return (
              <button key={h.path} className={`cmd-item nav-path ${i === sel ? "on" : ""}`} data-testid="quick-open-item" onMouseEnter={() => setSel(i)} onClick={() => pick(h.path)} title={h.path}>
                {parts.map((p, k) => (p.mark ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>))}
              </button>
            );
          })}
          {truncated && <div className="cmd-empty muted small">Large folder: only the first 20,000 files are listed.</div>}
        </div>
      </div>
    </div>
  );
}
