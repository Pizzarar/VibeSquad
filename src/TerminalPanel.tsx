import { useCallback, useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import type { TerminalStreamEvent } from "@getpaseo/client/internal/daemon-client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { daemonClient, DEMO } from "./paseo";
import { captureFileName, captureText } from "./fileOps";
import { captureTerminalLines, renameTerminalTitle } from "./paseoFiles";

type TerminalTab = { id: string; name: string };
type TerminalInstance = { term: Terminal; fit: FitAddon };

let demoCounter = 0;

export const TERMINAL_THEME = {
  background: "#0d111c",
  foreground: "#e2e8f0",
  cursor: "#00f5d4",
  cursorAccent: "#0d111c",
  selectionBackground: "rgba(0, 245, 212, 0.22)",
  black: "#0d111c",
  red: "#ff5c8a",
  green: "#2ee59d",
  yellow: "#ffd166",
  blue: "#5cc8ff",
  magenta: "#c77dff",
  cyan: "#00f5d4",
  white: "#e2e8f0",
  brightBlack: "#4a5578",
  brightRed: "#ff85a8",
  brightGreen: "#5cf2b8",
  brightYellow: "#ffe08f",
  brightBlue: "#8ad8ff",
  brightMagenta: "#d9a3ff",
  brightCyan: "#5ffbe6",
  brightWhite: "#ffffff",
};

function resizeTerminal(terminalId: string, cols: number, rows: number) {
  if (DEMO || cols < 1 || rows < 1) return;
  try {
    daemonClient.sendTerminalInput(terminalId, { type: "resize", cols, rows } as never);
  } catch {}
}

export function TerminalPanel({ agent }: { agent: PaseoAgent }) {
  const cwd = agent.cwd ?? "";
  // Paseo 0.14 scopes terminals by workspace: listTerminals(cwd) alone comes back empty.
  const workspaceId = (agent as { workspaceId?: string | null }).workspaceId ?? undefined;
  const scope = workspaceId ? { workspaceId } : undefined;
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const unsubsRef = useRef<Map<string, () => void>>(new Map());
  const termInstancesRef = useRef<Map<string, TerminalInstance>>(new Map());
  const containerRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());
  const pendingOutputRef = useRef<Map<string, (Uint8Array | string)[]>>(new Map());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const renamingRef = useRef<string | null>(null); // guards Enter + blur from committing twice
  const [renameValue, setRenameValue] = useState("");
  const [tabErr, setTabErr] = useState("");
  const [capture, setCapture] = useState<{ title: string; text: string; err: string; busy: boolean; copied: boolean } | null>(null);

  const writeToTerm = useCallback((id: string, data: Uint8Array | string) => {
    const inst = termInstancesRef.current.get(id);
    if (inst) {
      inst.term.write(data);
    } else {
      const buf = pendingOutputRef.current.get(id) ?? [];
      buf.push(data);
      pendingOutputRef.current.set(id, buf);
    }
  }, []);

  const mountXterm = useCallback((terminalId: string, el: HTMLDivElement) => {
    if (termInstancesRef.current.has(terminalId)) return;
    const term = new Terminal({
      convertEol: true,
      theme: TERMINAL_THEME,
      fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try { fit.fit(); } catch {}

    term.onData((data: string) => {
      if (DEMO) {
        term.write(data === "\r" ? "\r\n$ " : data);
        return;
      }
      daemonClient.sendTerminalInput(terminalId, { type: "input", data });
    });

    termInstancesRef.current.set(terminalId, { term, fit });

    const buf = pendingOutputRef.current.get(terminalId);
    if (buf?.length) {
      for (const chunk of buf) term.write(chunk);
      pendingOutputRef.current.delete(terminalId);
    }
  }, []);

  // Load existing terminals on mount
  useEffect(() => {
    let cancelled = false;

    function subscribeToTerminal(terminalId: string) {
      const sub = daemonClient.observeTerminal(
        terminalId,
        (event: TerminalStreamEvent) => {
          if (event.type === "output" || event.type === "restore") {
            writeToTerm(terminalId, event.data);
          }
        },
        { restore: { mode: "full-snapshot" } },
      );
      unsubsRef.current.set(terminalId, () => { sub.release().catch(() => {}); });
    }

    async function loadTerminals() {
      if (DEMO) {
        demoCounter++;
        const id = `demo-term-${demoCounter}`;
        setTabs([{ id, name: `Terminal ${demoCounter}` }]);
        setActiveId(id);
        return;
      }
      try {
        const result = await daemonClient.listTerminals(cwd, undefined, scope);
        const loaded = result.terminals.map((t) => ({
          id: t.id,
          name: (t as { title?: string; name?: string }).title ?? (t as { name?: string }).name ?? t.id.slice(-6),
        }));
        if (cancelled) return;
        if (loaded.length > 0) {
          setTabs(loaded);
          setActiveId(loaded[0].id);
          for (const t of loaded) subscribeToTerminal(t.id);
        }
      } catch {
        // ignore connection errors; user can create a terminal manually
      }
    }
    loadTerminals();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, workspaceId]);

  // Refit + resize the daemon PTY on tab switch, container resize and window resize
  useEffect(() => {
    if (!activeId) return;
    const el = containerRefsMap.current.get(activeId);
    if (!el) return;
    const inst = termInstancesRef.current.get(activeId);
    if (!inst) return;

    const refit = () => {
      try {
        inst.fit.fit();
        resizeTerminal(activeId, inst.term.cols, inst.term.rows);
      } catch {}
    };
    const raf = requestAnimationFrame(refit);
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    window.addEventListener("resize", refit);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", refit);
    };
  }, [activeId, tabs.length]);

  // Cleanup on unmount
  useEffect(
    () => () => {
      for (const unsub of unsubsRef.current.values()) unsub();
      for (const { term } of termInstancesRef.current.values()) {
        try { term.dispose(); } catch {}
      }
    },
    [],
  );

  const createTerminal = async () => {
    if (DEMO) {
      demoCounter++;
      const id = `demo-term-${demoCounter}`;
      const name = `Terminal ${demoCounter}`;
      setTabs((prev) => [...prev, { id, name }]);
      setActiveId(id);
      return;
    }
    try {
      const result = await daemonClient.createTerminal(cwd, `Terminal ${tabs.length + 1}`, undefined, scope);
      const termId = (result as { terminal?: { id?: string } }).terminal?.id;
      if (!termId) return;
      const newTab: TerminalTab = { id: termId, name: `Terminal ${tabs.length + 1}` };
      setTabs((prev) => [...prev, newTab]);
      setActiveId(termId);

      const sub = daemonClient.observeTerminal(
        termId,
        (event: TerminalStreamEvent) => {
          if (event.type === "output" || event.type === "restore") {
            writeToTerm(termId, event.data);
          }
        },
        { restore: { mode: "full-snapshot" } },
      );
      unsubsRef.current.set(termId, () => { sub.release().catch(() => {}); });
    } catch (e) {
      console.error("createTerminal failed", e);
    }
  };

  const killTab = async (terminalId: string) => {
    if (!DEMO) {
      try { await daemonClient.killTerminal(terminalId); } catch {}
    }
    const unsub = unsubsRef.current.get(terminalId);
    if (unsub) {
      unsub();
      unsubsRef.current.delete(terminalId);
    }
    const inst = termInstancesRef.current.get(terminalId);
    if (inst) {
      try { inst.term.dispose(); } catch {}
      termInstancesRef.current.delete(terminalId);
    }
    containerRefsMap.current.delete(terminalId);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== terminalId);
      setActiveId((a) => (a === terminalId ? (next[0]?.id ?? null) : a));
      return next;
    });
  };

  const startRename = (t: TerminalTab) => {
    setTabErr("");
    renamingRef.current = t.id;
    setRenamingId(t.id);
    setRenameValue(t.name);
  };

  const commitRename = async () => {
    const id = renamingRef.current;
    if (!id) return;
    const title = renameValue.trim();
    renamingRef.current = null;
    setRenamingId(null);
    if (!title || title === tabs.find((t) => t.id === id)?.name) return;
    try {
      if (!DEMO) await renameTerminalTitle(id, title);
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, name: title } : t)));
    } catch (e) {
      setTabErr(`Rename failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  useEffect(() => {
    if (!capture) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCapture(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [capture]);

  const captureActive = async () => {
    const tab = tabs.find((t) => t.id === activeId);
    if (!tab) return;
    setCapture({ title: tab.name, text: "", err: "", busy: true, copied: false });
    try {
      const lines = DEMO ? ["$ npm run build", "build ok", ""] : await captureTerminalLines(tab.id);
      setCapture((c) => c && { ...c, text: captureText(lines), busy: false });
    } catch (e) {
      setCapture((c) => c && { ...c, err: e instanceof Error ? e.message : String(e), busy: false });
    }
  };

  const copyCapture = async () => {
    if (!capture) return;
    try {
      await navigator.clipboard.writeText(capture.text);
      setCapture((c) => c && { ...c, copied: true });
    } catch {
      setCapture((c) => c && { ...c, err: "Copy blocked by the browser" });
    }
  };

  const saveCapture = () => {
    if (!capture) return;
    const url = URL.createObjectURL(new Blob([capture.text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = captureFileName(capture.title, new Date());
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  return (
    <div className="terminal-panel" data-testid="terminal-panel">
      <div className="terminal-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`terminal-tab${t.id === activeId ? " active" : ""}`}
            data-testid="terminal-tab"
            title={t.name}
            onClick={() => setActiveId(t.id)}
            onDoubleClick={() => startRename(t)}
          >
            {renamingId === t.id ? (
              <input
                className="terminal-tab-input"
                data-testid="terminal-rename-input"
                autoFocus
                value={renameValue}
                maxLength={60}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenameValue(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") void commitRename();
                  else if (e.key === "Escape") { renamingRef.current = null; setRenamingId(null); }
                }}
              />
            ) : (
              <span className="terminal-tab-name">{t.name}</span>
            )}
            <span
              className="terminal-tab-close"
              role="button"
              aria-label="Close"
              onClick={(e) => {
                e.stopPropagation();
                void killTab(t.id);
              }}
            >
              ✕
            </span>
          </button>
        ))}
        <button
          className="btn ghost small"
          data-testid="terminal-new-btn"
          onClick={() => void createTerminal()}
        >
          + New Terminal
        </button>
        {activeId && (
          <>
            <button
              className="btn ghost small"
              data-testid="terminal-rename-btn"
              title="Rename this terminal (or double-click its tab)"
              onClick={() => { const t = tabs.find((x) => x.id === activeId); if (t) startRename(t); }}
            >
              Rename
            </button>
            <button
              className="btn ghost small"
              data-testid="terminal-capture-btn"
              title="Snapshot this terminal's output as text"
              onClick={() => void captureActive()}
            >
              Capture output
            </button>
          </>
        )}
      </div>
      {tabErr && <div className="stat-alert small" data-testid="terminal-tab-error">{tabErr}</div>}
      {capture && (
        <div className="modal-back" onMouseDown={() => setCapture(null)}>
          <div className="modal wide terminal-capture-modal" data-testid="terminal-capture-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>Captured output · {capture.title}</span>
            </div>
            <div className="modal-body">
              {capture.busy ? (
                <div className="muted small">Capturing…</div>
              ) : capture.err ? (
                <div className="stat-alert small" data-testid="terminal-capture-error">{capture.err}</div>
              ) : (
                <pre className="terminal-capture-text" data-testid="terminal-capture-text">{capture.text || "(terminal is empty)"}</pre>
              )}
            </div>
            <div className="modal-foot">
              {capture.copied && <span className="muted small">Copied</span>}
              <button className="btn ghost" data-testid="terminal-capture-copy" disabled={capture.busy || !capture.text} onClick={() => void copyCapture()}>Copy</button>
              <button className="btn ok" data-testid="terminal-capture-save" disabled={capture.busy || !capture.text} onClick={saveCapture}>Save as .txt</button>
              <button className="btn ghost" data-testid="terminal-capture-close" onClick={() => setCapture(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {tabs.length === 0 ? (
        <div className="muted" style={{ padding: 16 }}>
          No terminals open — click <b>+ New Terminal</b> to start one.
        </div>
      ) : (
        tabs.map((t) => {
          const isActive = t.id === activeId;
          return (
            <div
              key={t.id}
              className="terminal-output"
              data-testid={isActive ? "terminal-output" : undefined}
              style={{ display: isActive ? "block" : "none" }}
              ref={(el) => {
                if (el) {
                  containerRefsMap.current.set(t.id, el);
                  mountXterm(t.id, el);
                } else {
                  containerRefsMap.current.delete(t.id);
                }
              }}
            />
          );
        })
      )}
    </div>
  );
}
