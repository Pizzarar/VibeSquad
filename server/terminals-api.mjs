// /__vibesquad/terminals/* and /__vibesquad/workspace-scripts/*: shells and package.json scripts keyed by directory
// (an agent cwd / team path), so runner agents (workspaceId: null) get them too. Owner-only: the caller (vibesquad-api.mjs)
// gates both the writes and the reads, because a stream is a live shell.
import { loadNodePty, sharedTerminals } from "./terminals.mjs";
import { sharedScripts } from "./workspace-scripts.mjs";

export const TERMINALS_PREFIX = "/__vibesquad/terminals";
export const SCRIPTS_PREFIX = "/__vibesquad/workspace-scripts";
export const isTerminalsPath = (path) =>
  path === TERMINALS_PREFIX || path.startsWith(`${TERMINALS_PREFIX}/`) || path === SCRIPTS_PREFIX || path.startsWith(`${SCRIPTS_PREFIX}/`);

const ID_RE = /^tm-[a-f0-9]{12}$/;

/** Server-sent events over a plain response: `data:` lines carry JSON; an `exit` event ends the stream. */
function openStream(req, res) {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders?.();
  const send = (event, data) => res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 20_000);
  ping.unref?.();
  return { send, close: () => clearInterval(ping) };
}

/**
 * @param {{ readBody: Function, sendJson: Function, resolveCwd: (cwd: string) => string | null | Promise<string | null>,
 *           terminals?: import("./terminals.mjs").TerminalManager, scripts?: import("./workspace-scripts.mjs").ScriptManager }} deps
 * resolveCwd returns the real path of a cwd inside a known team / agent path, or null (refused).
 */
export async function handleTerminalsApi(req, res, { readBody, sendJson, resolveCwd, terminals = sharedTerminals(), scripts = sharedScripts() }) {
  try {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const method = req.method;
    const cwdOf = async (raw) => {
      const real = await resolveCwd(String(raw ?? ""));
      if (!real) throw Object.assign(new Error("cwd is not inside a known team or agent path"), { status: 403 });
      return real;
    };
    const stream = (subscribe) => {
      // The 200 + ping timer only start once subscribe() has accepted the id, so an unknown id is a plain 404.
      let s;
      let off = () => {};
      const open = () => (s ??= openStream(req, res));
      const end = () => { off(); s?.close(); };
      off = subscribe({
        onData: (d) => open().send("", { d }),
        onExit: (e) => { open().send("exit", e); end(); res.end(); },
      });
      open();
      req.on("close", end);
    };

    if (path === TERMINALS_PREFIX) {
      if (method === "GET") return sendJson(res, 200, { terminals: terminals.list(await cwdOf(url.searchParams.get("cwd"))), ptyAvailable: Boolean(await loadNodePty()) });
      if (method === "POST") {
        const body = await readBody(req);
        const terminal = await terminals.create({ cwd: await cwdOf(body?.cwd), name: body?.name, cols: body?.cols, rows: body?.rows });
        return sendJson(res, 201, { terminal });
      }
    }
    if (path.startsWith(`${TERMINALS_PREFIX}/`)) {
      const [id, action] = path.slice(TERMINALS_PREFIX.length + 1).split("/");
      if (!ID_RE.test(id ?? "")) return sendJson(res, 404, { error: "not found" });
      if (method === "GET" && action === "stream") return stream((h) => terminals.subscribe(id, h));
      if (method === "GET" && action === "output") return sendJson(res, 200, { text: terminals.output(id) });
      if (method === "POST") {
        const body = await readBody(req);
        if (action === "input") terminals.input(id, body?.data);
        else if (action === "resize") terminals.resize(id, body?.cols, body?.rows);
        else if (action === "rename") terminals.rename(id, body?.name);
        else if (action === "kill") terminals.kill(id);
        else return sendJson(res, 404, { error: "not found" });
        return sendJson(res, 200, { ok: true });
      }
    }

    if (path === SCRIPTS_PREFIX && method === "GET") {
      return sendJson(res, 200, { scripts: scripts.list(await cwdOf(url.searchParams.get("cwd"))) });
    }
    if (path === `${SCRIPTS_PREFIX}/logs` && method === "GET") {
      const cwd = await cwdOf(url.searchParams.get("cwd"));
      const name = String(url.searchParams.get("name") ?? "");
      if (url.searchParams.get("stream") === "1") return stream((h) => scripts.subscribe(cwd, name, h));
      return sendJson(res, 200, { text: scripts.logs(cwd, name) });
    }
    if ((path === `${SCRIPTS_PREFIX}/start` || path === `${SCRIPTS_PREFIX}/stop`) && method === "POST") {
      const body = await readBody(req);
      const cwd = await cwdOf(body?.cwd);
      const name = String(body?.name ?? "");
      return sendJson(res, 200, path.endsWith("/start") ? scripts.start(cwd, name) : await scripts.stop(cwd, name));
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    if (res.headersSent) return res.end();
    return sendJson(res, err?.status >= 400 ? err.status : 500, { error: String(err?.message ?? err) });
  }
}
