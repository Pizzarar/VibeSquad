import { useCallback, useEffect, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import { daemonClient, DEMO } from "./paseo";
import { openRightDockTab } from "./RightDock";
import {
  AGENTS_TEMPLATE,
  contextFilesFor,
  FAMILY_LABEL,
  isLoadedBy,
  LIST_TIMEOUT_MS,
  providerFamily,
  withTimeout,
} from "./projectContext";

type Scan = { status: "loading" } | { status: "error" } | { status: "ok"; present: Set<string> };

const DEMO_PRESENT = new Set(["AGENTS.md", "CLAUDE.md"]);

/** File names in `dir` (relative to cwd), time-boxed. A missing folder lists as empty; null = couldn't list. */
async function listNames(cwd: string, dir: string): Promise<string[] | null> {
  const run = daemonClient.listDirectory(cwd, dir).then(
    (r) => r.entries.filter((e) => e.kind === "file").map((e) => (dir ? `${dir}/${e.name}` : e.name)),
    (e) => (/not found|ENOENT|no such|does not exist|missing/i.test(String(e)) ? [] : Promise.reject(e)),
  );
  const { value, timedOut } = await withTimeout(run, LIST_TIMEOUT_MS, null as string[] | null);
  return timedOut ? null : value;
}

export function ProjectPanel({ agent }: { agent: PaseoAgent }) {
  const cwd = agent.cwd ?? "";
  const lane = ((agent.labels ?? {}) as Record<string, string>).lane;
  const files = contextFilesFor(lane);
  const family = providerFamily(agent.provider);
  const [scan, setScan] = useState<Scan>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState("");

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    setScan({ status: "loading" });
    (async () => {
      if (DEMO) {
        setScan({ status: "ok", present: DEMO_PRESENT });
        return;
      }
      const dirs = [...new Set(files.map((f) => f.path.split("/").slice(0, -1).join("/")))];
      const lists = await Promise.all(dirs.map((d) => listNames(cwd, d)));
      if (cancelled) return;
      if (lists[dirs.indexOf("")] === null) {
        setScan({ status: "error" });
        return;
      }
      setScan({ status: "ok", present: new Set(lists.flatMap((l) => l ?? [])) });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, lane, nonce]);

  const createAgentsMd = useCallback(async () => {
    setCreating(true);
    setCreateErr("");
    try {
      // writeFile only updates existing files, so make the empty file first, then fill it.
      const made = await daemonClient.createFileEntry({ cwd, parentPath: "", name: "AGENTS.md", kind: "file" });
      const err = (made as { error?: string | null })?.error;
      if (err) throw new Error(err);
      const cur = await daemonClient.readFile(cwd, "AGENTS.md");
      const res = await daemonClient.writeFile({ cwd, path: "AGENTS.md", content: AGENTS_TEMPLATE, expectedModifiedAt: cur.modifiedAt });
      const status = (res as { status?: string; error?: string })?.status;
      if (status === "conflict" || status === "error") throw new Error((res as { error?: string }).error || `write ${status}`);
      setNonce((n) => n + 1);
      openRightDockTab("Files", { filePath: "AGENTS.md" });
    } catch (e) {
      setCreateErr(`Couldn't create AGENTS.md: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCreating(false);
    }
  }, [cwd]);

  if (!cwd) {
    return (
      <div className="project-panel muted small" data-testid="project-panel-empty">
        This agent has no project folder, so there are no context files to show.
      </div>
    );
  }

  return (
    <div className="project-panel" data-testid="project-panel">
      <div className="project-head">
        <div className="project-title">Project rules</div>
        <button className="btn ghost small" onClick={() => setNonce((n) => n + 1)} title="Re-check which files exist">
          ↻
        </button>
      </div>
      <div className="muted small project-cwd" title={cwd}>{cwd}</div>
      <p className="muted small project-hint">
        Each provider reads its own files from this folder when the agent starts. VibeSquad shows and edits them; it
        doesn't inject them. This agent runs on <b>{FAMILY_LABEL[family]}</b>.
      </p>
      {scan.status === "loading" && <div className="muted small">Checking files…</div>}
      {scan.status === "error" && (
        <div className="muted small" data-testid="project-panel-error">
          Couldn't list this folder. <button className="btn ghost small" onClick={() => setNonce((n) => n + 1)}>Retry</button>
        </div>
      )}
      {scan.status === "ok" && (
        <ul className="project-files">
          {files.map((f) => {
            const present = scan.present.has(f.path);
            const mine = isLoadedBy(f, agent.provider);
            return (
              <li
                key={f.path}
                className={`project-file${present ? "" : " missing"}${mine ? " mine" : ""}`}
                data-testid="project-file"
                data-path={f.path}
                data-present={present ? "1" : "0"}
              >
                {present ? (
                  <button
                    className="project-file-name"
                    title={`Open ${f.path} in Files`}
                    onClick={() => openRightDockTab("Files", { filePath: f.path })}
                  >
                    📄 {f.path}
                  </button>
                ) : (
                  <span className="project-file-name muted">{f.path} <span className="small">(not found)</span></span>
                )}
                <span className="project-badges">
                  {f.loadedBy.map((fam) => (
                    <span
                      key={fam}
                      className={`project-badge${fam === family ? " current" : ""}`}
                      data-testid={fam === family ? "project-badge-current" : "project-badge"}
                      title={fam === family ? "Loaded by this agent" : `Loaded by ${FAMILY_LABEL[fam]} agents`}
                    >
                      {FAMILY_LABEL[fam]}
                    </span>
                  ))}
                  {!f.loadedBy.length && <span className="project-badge none">{f.note ?? "not auto-loaded"}</span>}
                </span>
                {present && mine && <span className="project-mine small">loaded by this agent</span>}
                {!present && f.path === "AGENTS.md" && (
                  <button
                    className="btn small"
                    data-testid="project-create-agents"
                    disabled={creating}
                    onClick={() => void createAgentsMd()}
                  >
                    {creating ? "Creating…" : "Create AGENTS.md"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {createErr && <div className="stat-alert small">{createErr}</div>}
    </div>
  );
}
