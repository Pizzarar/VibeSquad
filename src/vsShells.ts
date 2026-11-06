// Client for /__vibesquad/terminals/* and /__vibesquad/workspace-scripts/* (server/terminals-api.mjs): shells and
// package.json scripts keyed by directory, so runner agents (no Paseo workspaceId) get them too.
import { isRunnerId } from "./runnerBridge";

const T = "/__vibesquad/terminals";
const S = "/__vibesquad/workspace-scripts";

export type VsTerminal = { id: string; cwd: string; name: string; pty: boolean; exited: { code: number | null } | null };
export type VsScript = { scriptName: string; command: string; type: "script"; lifecycle: "running" | "stopped"; port: null; exitCode: number | null };

/** Runner agents use the VS routes (they have no Paseo workspace); Paseo-backed agents keep the daemon RPCs. */
export const usesVsShells = (agentId: string | undefined): boolean => isRunnerId(agentId);

async function call<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `request failed (${res.status})`);
  return json as T;
}

export const vsListTerminals = (cwd: string) => call<{ terminals: VsTerminal[] }>(`${T}?cwd=${encodeURIComponent(cwd)}`).then((r) => r.terminals);
export const vsCreateTerminal = (cwd: string, name: string, cols: number, rows: number) => call<{ terminal: VsTerminal }>(T, { cwd, name, cols, rows }).then((r) => r.terminal);
export const vsTerminalInput = (id: string, data: string) => call(`${T}/${id}/input`, { data });
export const vsTerminalResize = (id: string, cols: number, rows: number) => call(`${T}/${id}/resize`, { cols, rows });
export const vsTerminalRename = (id: string, name: string) => call(`${T}/${id}/rename`, { name });
export const vsKillTerminal = (id: string) => call(`${T}/${id}/kill`, {});
export const vsTerminalOutput = (id: string) => call<{ text: string }>(`${T}/${id}/output`).then((r) => r.text);

export const vsListScripts = (cwd: string) => call<{ scripts: VsScript[] }>(`${S}?cwd=${encodeURIComponent(cwd)}`).then((r) => r.scripts);
export const vsStartScript = (cwd: string, name: string) => call(`${S}/start`, { cwd, name });
export const vsStopScript = (cwd: string, name: string) => call(`${S}/stop`, { cwd, name });
export const vsScriptLogs = (cwd: string, name: string) => call<{ text: string }>(`${S}/logs?cwd=${encodeURIComponent(cwd)}&name=${encodeURIComponent(name)}`).then((r) => r.text);
export const vsScriptLogsUrl = (cwd: string, name: string) => `${S}/logs?stream=1&cwd=${encodeURIComponent(cwd)}&name=${encodeURIComponent(name)}`;

/** Reads a server-sent-event stream (output arrives as `{d}`, an `exit` event ends it). Returns a function that stops it. */
export function vsStream(url: string, onData: (d: string) => void, onExit?: (code: number | null) => void): () => void {
  const ctl = new AbortController();
  void (async () => {
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok || !res.body) return;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!data) continue;
          const parsed = JSON.parse(data) as { d?: string; code?: number | null };
          if (event === "exit") onExit?.(parsed.code ?? null);
          else if (typeof parsed.d === "string") onData(parsed.d);
        }
      }
    } catch {
      /* aborted or the server went away */
    }
  })();
  return () => ctl.abort();
}

export const vsTerminalStreamUrl = (id: string) => `${T}/${id}/stream`;
