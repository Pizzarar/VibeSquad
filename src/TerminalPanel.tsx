import { useCallback, useEffect, useRef, useState } from "react";
import type { PaseoAgent } from "@getpaseo/client";
import type { TerminalStreamEvent } from "@getpaseo/client/internal/daemon-client";
import { daemonClient, DEMO } from "./paseo";

type TerminalTab = {
  id: string;
  name: string;
  output: string;
};

type DemoTab = TerminalTab & { demo: true };

let demoCounter = 0;

function makeDemoTab(): DemoTab {
  demoCounter++;
  return { id: `demo-term-${demoCounter}`, name: `Terminal ${demoCounter}`, output: "$ ", demo: true };
}

function stripAnsi(data: Uint8Array | string): string {
  const str = typeof data === "string" ? data : new TextDecoder().decode(data);
  return str.replace(/\x1b\[[0-9;]*[mGKHFJABCDHfSTchlnsu]/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function TerminalPanel({ agent }: { agent: PaseoAgent }) {
  const cwd = agent.cwd ?? "";
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const outputRef = useRef<HTMLDivElement>(null);
  const unsubsRef = useRef<Map<string, () => void>>(new Map());
  const demoTabsRef = useRef<Map<string, DemoTab>>(new Map());

  const appendOutput = useCallback((id: string, text: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, output: t.output + text } : t)),
    );
  }, []);

  // Load existing terminals on mount
  useEffect(() => {
    let cancelled = false;
    async function loadTerminals() {
      if (DEMO) {
        const tab = makeDemoTab();
        demoTabsRef.current.set(tab.id, tab);
        setTabs([tab]);
        setActiveId(tab.id);
        return;
      }
      try {
        const result = await daemonClient.listTerminals(cwd);
        const loaded = result.terminals.map((t) => ({
          id: t.id,
          name: t.title ?? t.name ?? t.id.slice(-6),
          output: "",
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
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  });

  // Cleanup subscriptions on unmount
  useEffect(
    () => () => {
      for (const unsub of unsubsRef.current.values()) unsub();
    },
    [],
  );

  function subscribeToTerminal(terminalId: string) {
    const sub = daemonClient.observeTerminal(
      terminalId,
      (event: TerminalStreamEvent) => {
        if (event.type === "output" || event.type === "restore") {
          appendOutput(terminalId, stripAnsi(event.data));
        }
      },
      { restore: { mode: "full-snapshot" } },
    );
    unsubsRef.current.set(terminalId, () => { sub.release().catch(() => {}); });
  }

  const createTerminal = async () => {
    if (DEMO) {
      const tab = makeDemoTab();
      demoTabsRef.current.set(tab.id, tab);
      setTabs((prev) => [...prev, tab]);
      setActiveId(tab.id);
      return;
    }
    try {
      const result = await daemonClient.createTerminal(cwd, `Terminal ${tabs.length + 1}`);
      const termId = result.terminal?.id;
      if (!termId) return;
      const newTab: TerminalTab = {
        id: termId,
        name: `Terminal ${tabs.length + 1}`,
        output: "",
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveId(termId);
      subscribeToTerminal(termId);
    } catch (e) {
      console.error("createTerminal failed", e);
    }
  };

  const killTab = async (terminalId: string) => {
    if (DEMO) {
      setTabs((prev) => prev.filter((t) => t.id !== terminalId));
      setActiveId((prev) => (prev === terminalId ? null : prev));
      demoTabsRef.current.delete(terminalId);
      return;
    }
    try {
      await daemonClient.killTerminal(terminalId);
    } catch {
      // best-effort
    }
    const unsub = unsubsRef.current.get(terminalId);
    if (unsub) {
      unsub();
      unsubsRef.current.delete(terminalId);
    }
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== terminalId);
      if (activeId === terminalId) setActiveId(next[0]?.id ?? null);
      return next;
    });
  };

  const sendInput = (terminalId: string, text: string) => {
    if (DEMO) {
      const demoTab = demoTabsRef.current.get(terminalId);
      if (demoTab) {
        appendOutput(terminalId, text + "\n$ ");
      }
      return;
    }
    daemonClient.sendTerminalInput(terminalId, { type: "input", data: text + "\r" });
  };

  const sendCtrlC = (terminalId: string) => {
    if (DEMO) {
      appendOutput(terminalId, "^C\n$ ");
      return;
    }
    daemonClient.sendTerminalInput(terminalId, { type: "input", data: "\x03" });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && activeId) {
      sendInput(activeId, input);
      setInput("");
    }
  };

  const activeTab = tabs.find((t) => t.id === activeId);

  return (
    <div className="terminal-panel" data-testid="terminal-panel">
      <div className="terminal-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`terminal-tab${t.id === activeId ? " active" : ""}`}
            data-testid="terminal-tab"
            onClick={() => setActiveId(t.id)}
          >
            {t.name}
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
      </div>
      {activeTab ? (
        <>
          <div
            ref={outputRef}
            className="terminal-output"
            data-testid="terminal-output"
          >
            <pre className="terminal-text">{activeTab.output}</pre>
          </div>
          <div className="terminal-input-bar">
            <input
              className="terminal-input"
              data-testid="terminal-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Command…"
              spellCheck={false}
            />
            <button
              className="btn ghost small"
              title="Ctrl+C"
              onClick={() => activeId && sendCtrlC(activeId)}
            >
              ^C
            </button>
          </div>
        </>
      ) : (
        <div className="muted" style={{ padding: 16 }}>
          No terminals open — click <b>+ New Terminal</b> to start one.
        </div>
      )}
    </div>
  );
}
