// /__vibesquad/runner/* : the UI's window onto the agent runner (the browser reaches agents only through these routes).
// Writes are gated by the caller (vibesquad-api.mjs: owner, or an allow-listed verified agent forwarded to the runner's scope rules).
import { sharedRunnerBackend } from "./backend/index.mjs";
import { callerOf } from "./auth.mjs";

const PREFIX = "/__vibesquad/runner/";
const ID_RE = /^rn-[A-Za-z0-9_-]{1,64}$/;

const HEARTBEAT_MS = 15000;

/**
 * GET /__vibesquad/runner/events: SSE of roster upserts, timeline appends and status transitions (RunnerBackend.subscribeEvents).
 * The backend starts it with the full roster; the listener, heartbeat and runner stream are released when the client goes away.
 */
function streamEvents(req, res, backend, heartbeatMs = HEARTBEAT_MS) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  res.write(": ok\n\n");
  const send = (ev) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  let off = null;
  let closed = false;
  const beat = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': hb\n\ndata: {"kind":"hb"}\n\n'); }, heartbeatMs); // comment for proxies; data event so the browser watchdog sees activity
  beat.unref?.();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(beat);
    off?.();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  // The backend delivers the initial roster itself, in order with live events. A runner that is down yields
  // { kind: "disconnected" } (never an empty roster), so the browser keeps the agents it has.
  off = backend.subscribeEvents(send);
  if (closed) off();
}

/** What the browser reads on boot: the runner is always on (every lane runs on it). */
export async function runnerStatus() {
  return { enabled: true };
}

/**
 * `caller` (X1c): the middleware's resolved caller. The middleware admits only the owner and allow-listed agent routes here.
 * An agent caller is forwarded to the runner as that agent ({ id, token }), so the runner's scope rules decide (team, parent,
 * role, protected meta); `owner: true` on input is only ever set for the owner. The body can never name the caller.
 */
export async function handleRunnerApi(req, res, { readBody, sendJson, backend = sharedRunnerBackend(), status = runnerStatus, caller = callerOf(req) }) {
  const agent = caller?.kind === "agent" ? { id: caller.id, token: caller.token } : null;
  const as = agent ? { caller: agent } : {};
  try {
    const parts = (req.url ?? "").split("?")[0].slice(PREFIX.length).split("/").filter(Boolean);
    const url = new URL(req.url, "http://x");
    if (parts[0] === "status") return sendJson(res, 200, await status());
    if (parts[0] === "events" && parts.length === 1 && req.method === "GET") {
      // Connect-only: the VS server's supervisor owns the runner; the stream retries until it is up.
      return streamEvents(req, res, backend);
    }
    if (parts[0] === "agents" && parts.length === 1 && req.method === "GET") {
      if (url.searchParams.get("archived") === "1") {
        const all = await backend.listAgents({ filter: { includeArchived: true } }).catch(() => []);
        return sendJson(res, 200, { enabled: true, agents: all.filter((a) => a.archivedAt) });
      }
      const agents = await backend.listAgents().catch(() => []); // runner not started yet = no agents
      return sendJson(res, 200, { enabled: true, agents });
    }
    if (parts[0] === "sweep" && parts.length === 1 && req.method === "POST") {
      // B3: the 5-min long-done worker sweep, run once over every Squad. Dry run unless the body says apply:true.
      const body = await readBody(req);
      const host = await backend.hookHost();
      if (!host?.sweepDoneWorkersReport) return sendJson(res, 503, { error: "hooks are not running on this server" });
      return sendJson(res, 200, await host.sweepDoneWorkersReport({ apply: body?.apply === true }));
    }
    if (parts[0] === "spawn" && req.method === "POST") {
      const { caller: _claimed, ...body } = (await readBody(req)) ?? {};
      return sendJson(res, 201, { agent: await backend.createAgent({ ...body, ...as }) });
    }
    if (parts[0] === "agents" && ID_RE.test(parts[1] ?? "")) {
      const id = parts[1];
      const action = parts[2];
      if (req.method === "GET" && action === "timeline") {
        const limit = Number(url.searchParams.get("limit") ?? 0) || undefined;
        const before = url.searchParams.get("direction") === "before" ? Number(url.searchParams.get("cursor")) : NaN;
        const opts = Number.isFinite(before) ? { limit, direction: "before", cursor: { epoch: "runner", seq: before } } : { limit };
        return sendJson(res, 200, await backend.fetchAgentTimeline(id, opts));
      }
      if (req.method === "GET" && !action) return sendJson(res, 200, await backend.fetchAgent(id));
      if (req.method === "POST") {
        const body = await readBody(req);
        if (action === "input") {
          await backend.sendAgentPrompt(id, String(body?.text ?? ""), {
            images: Array.isArray(body?.images) ? body.images : undefined,
            activeTurnBehavior: body?.activeTurnBehavior === "interrupt" ? "interrupt" : undefined,
            // Only the owner's composer is a human send; an agent's send is forwarded as that agent (the runner sets
            // senderId from the verified caller, ignores a body `owner`, and downgrades an interrupt it may not cancel).
            owner: !agent,
            ...as,
          });
        }
        else if (action === "cancel") await backend.cancelAgent(id, as);
        else if (action === "archive") await backend.archiveAgent(id, as);
        else if (action === "unarchive") await backend.unarchiveAgent(id, as);
        else if (action === "resume") {
          // Reopens a lost/parked agent in place (same id and history); status stays "closed" when it is not resumable.
          return sendJson(res, 200, { ok: true, agent: await backend.refreshAgent(id, as) });
        }
        else if (action === "meta") await backend.updateAgent(id, body, as);
        else if (action === "config") {
          if (agent) return sendJson(res, 403, { error: "config is owner-only" }); // not on AGENT_WRITE_ALLOWLIST; belt and braces
          return sendJson(res, 200, { ok: true, ...(await backend.setAgentConfig(id, body ?? {})) }); // model / mode / thinking: applies from the next turn
        }
        else return sendJson(res, 404, { error: "not found" });
        return sendJson(res, 200, { ok: true });
      }
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    return sendJson(res, err?.status && err.status >= 400 ? err.status : 500, { error: String(err?.message ?? err) });
  }
}
