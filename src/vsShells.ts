// Client for /__vibesquad/terminals/* and /__vibesquad/workspace-scripts/* (server/terminals-api.mjs): shells and
// package.json scripts keyed by directory, so runner agents (no Paseo workspaceId) get them too.
import { isRemoteMode } from "./remoteTransport";
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
// Remote: the proxy returns terminal bodies under the 512 KB text cap, so ask for the tail only.
export const vsTerminalOutput = (id: string) => call<{ text: string }>(`${T}/${id}/output${isRemoteMode() ? "?max=60000" : ""}`).then((r) => r.text);

export const vsListScripts = (cwd: string) => call<{ scripts: VsScript[] }>(`${S}?cwd=${encodeURIComponent(cwd)}`).then((r) => r.scripts);
export const vsStartScript = (cwd: string, name: string) => call(`${S}/start`, { cwd, name });
export const vsStopScript = (cwd: string, name: string) => call(`${S}/stop`, { cwd, name });
export const vsScriptLogs = (cwd: string, name: string) => call<{ text: string }>(`${S}/logs?cwd=${encodeURIComponent(cwd)}&name=${encodeURIComponent(name)}`).then((r) => r.text);
export const vsScriptLogsUrl = (cwd: string, name: string) => `${S}/logs?stream=1&cwd=${encodeURIComponent(cwd)}&name=${encodeURIComponent(name)}`;

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((ok) => { const t = setTimeout(ok, ms); signal.addEventListener("abort", () => { clearTimeout(t); ok(); }, { once: true }); });

/**
 * Remote mode has no streaming (vs.http is request/response), so the same `url` a stream would use is turned into a
 * cursor long-poll: terminals GET .../poll?since=<cursor>&wait=1000 (the server holds up to ~1 s), script logs re-read
 * the whole log every 1.5 s and emit what is new.
 */
function vsPoll(url: string, onData: (d: string) => void, onExit?: (code: number | null) => void): () => void {
  const ctl = new AbortController();
  const term = /^\/__vibesquad\/terminals\/(tm-[a-f0-9]{12})\/stream$/.exec(url)?.[1];
  const logs = url.startsWith(`${S}/logs?`) ? url.replace("stream=1&", "") : null;
  void (async () => {
    let cursor: number | undefined;
    let sent = 0;
    while (!ctl.signal.aborted && (term || logs)) {
      const started = Date.now();
      try {
        const res = await fetch(term ? `${T}/${term}/poll?${cursor === undefined ? "" : `since=${cursor}&`}wait=1000` : logs!, { signal: ctl.signal });
        if (res.status === 404 || res.status === 403) return;
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { text?: string; next?: number; exited?: { code: number | null } | null };
        if (term) {
          if (j.text) onData(j.text);
          if (typeof j.next === "number") cursor = j.next;
          if (j.exited) return void onExit?.(j.exited.code ?? null);
        } else {
          const all = j.text ?? "";
          if (all.length < sent) sent = 0;
          if (all.length > sent) onData(all.slice(sent));
          sent = all.length;
        }
      } catch {
        if (ctl.signal.aborted) return;
        await sleep(2000, ctl.signal);
        continue;
      }
      // A held poll already paced itself; one that came back at once and empty must not spin.
      await sleep(term ? (Date.now() - started < 200 ? 300 : 0) : 1500, ctl.signal);
    }
  })();
  return () => ctl.abort();
}

/** Reads a server-sent-event stream (output arrives as `{d}`, an `exit` event ends it). Returns a function that stops it. */
export function vsStream(url: string, onData: (d: string) => void, onExit?: (code: number | null) => void): () => void {
  if (isRemoteMode()) return vsPoll(url, onData, onExit);
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
