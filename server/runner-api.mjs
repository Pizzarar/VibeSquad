// /__vibesquad/runner/* : the UI's window onto runner-backed lanes (the browser only speaks the Paseo websocket,
// so runner agents reach it through these routes). Writes are owner-gated by the caller (vibesquad-api.mjs).
import { paseoDaemonAlive, paseoExpected, runnerLanes } from "./backend/lane-routing.mjs";
import { sharedRunnerBackend } from "./backend/index.mjs";

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
  const beat = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(": hb\n\n"); }, heartbeatMs);
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

/**
 * What the browser needs to route a lane: `defaultRunner` (every lane not pinned to Paseo runs on the runner), the pinned
 * `paseoLanes`, the explicit runner `lanes` (legacy list), and `paseo` = whether it is wanted / reachable right now.
 */
export async function runnerStatus(laneSet, { alive = paseoDaemonAlive, expected = () => paseoExpected({ lanes: () => laneSet }) } = {}) {
  const defaultRunner = laneSet.defaultRunner !== false;
  return {
    enabled: laneSet.size > 0,
    defaultBackend: defaultRunner ? "runner" : "paseo",
    lanes: [...laneSet],
    paseoLanes: [...(laneSet.paseoLanes ?? [])],
    paseo: { expected: expected(), reachable: await alive().catch(() => false) },
  };
}

export async function handleRunnerApi(req, res, { readBody, sendJson, backend = sharedRunnerBackend(), lanes = runnerLanes, status = runnerStatus, ensureRunner = false }) {
  try {
    const parts = (req.url ?? "").split("?")[0].slice(PREFIX.length).split("/").filter(Boolean);
    const url = new URL(req.url, "http://x");
    const laneSet = lanes();
    if (parts[0] === "status") return sendJson(res, 200, await status(laneSet));
    if (!laneSet.size) return sendJson(res, 200, { enabled: false, agents: [] });
    if (parts[0] === "events" && parts.length === 1 && req.method === "GET") {
      // The runner is VibeSquad's own daemon now: an owner's open UI starts it (detached, single-flight, cooled down after a failure)
      // instead of showing "disconnected" until the first spawn. Non-owners just get the stream.
      if (ensureRunner) await backend.ensureRunningOnce?.();
      return streamEvents(req, res, backend);
    }
    if (parts[0] === "agents" && parts.length === 1 && req.method === "GET") {
      const agents = await backend.listAgents().catch(() => []); // runner not started yet = no agents
      return sendJson(res, 200, { enabled: true, agents });
    }
    if (parts[0] === "spawn" && req.method === "POST") {
      const body = await readBody(req);
      const lane = String(body?.labels?.lane || body?.env?.VS_LANE || "").trim().toLowerCase();
      if (!laneSet.has(lane)) return sendJson(res, 400, { error: `lane "${lane}" is not switched to the runner` });
      return sendJson(res, 201, { agent: await backend.createAgent(body) });
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
          });
        }
        else if (action === "cancel") await backend.cancelAgent(id);
        else if (action === "archive") await backend.archiveAgent(id);
        else if (action === "meta") await backend.updateAgent(id, body);
        else return sendJson(res, 404, { error: "not found" });
        return sendJson(res, 200, { ok: true });
      }
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    return sendJson(res, err?.status && err.status >= 400 ? err.status : 500, { error: String(err?.message ?? err) });
  }
}
