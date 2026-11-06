// /__vibesquad/runner/* : the UI's window onto runner-backed lanes (the browser only speaks the Paseo websocket,
// so runner agents reach it through these routes). Writes are owner-gated by the caller (vibesquad-api.mjs).
import { runnerLanes } from "./backend/lane-routing.mjs";
import { sharedRunnerBackend } from "./backend/index.mjs";

const PREFIX = "/__vibesquad/runner/";
const ID_RE = /^rn-[A-Za-z0-9_-]{1,64}$/;

export async function handleRunnerApi(req, res, { readBody, sendJson, backend = sharedRunnerBackend(), lanes = runnerLanes }) {
  try {
    const parts = (req.url ?? "").split("?")[0].slice(PREFIX.length).split("/").filter(Boolean);
    const url = new URL(req.url, "http://x");
    const laneSet = lanes();
    if (parts[0] === "status") return sendJson(res, 200, { enabled: laneSet.size > 0, lanes: [...laneSet] });
    if (!laneSet.size) return sendJson(res, 200, { enabled: false, agents: [] });
    if (parts[0] === "agents" && parts.length === 1 && req.method === "GET") {
      const agents = await backend.listAgents().catch(() => []); // runner not started yet = no agents
      return sendJson(res, 200, { enabled: true, agents });
    }
    if (parts[0] === "spawn" && req.method === "POST") {
      const body = await readBody(req);
      const lane = String(body?.labels?.lane || body?.env?.VS_LANE || "").trim().toLowerCase();
      if (!lane || !laneSet.has(lane)) return sendJson(res, 400, { error: `lane "${lane}" is not switched to the runner` });
      return sendJson(res, 201, { agent: await backend.createAgent(body) });
    }
    if (parts[0] === "agents" && ID_RE.test(parts[1] ?? "")) {
      const id = parts[1];
      const action = parts[2];
      if (req.method === "GET" && action === "timeline") {
        const limit = Number(url.searchParams.get("limit") ?? 0) || undefined;
        return sendJson(res, 200, await backend.fetchAgentTimeline(id, { limit }));
      }
      if (req.method === "GET" && !action) return sendJson(res, 200, await backend.fetchAgent(id));
      if (req.method === "POST") {
        const body = await readBody(req);
        if (action === "input") await backend.sendAgentPrompt(id, String(body?.text ?? ""));
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
