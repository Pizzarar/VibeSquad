import { getBackend } from "./backend/index.mjs";
import { detachLiveChildrenViaClient, listDaemonAgents } from "./detach-children.mjs";

export const JANITOR_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * Returns true only when `agent` is a non-archived closed worker (`role=worker`)
 * whose closed/updated/created timestamp is at least `maxAgeMs` ago.
 */
export function isJanitorCandidate(agent, { now = Date.now(), maxAgeMs = JANITOR_MAX_AGE_MS } = {}) {
  if (!agent || typeof agent !== "object") return false;
  if (agent.archivedAt) return false;
  if (agent.status !== "closed") return false;
  if (String(agent.labels?.role || "").toLowerCase() !== "worker") return false;
  const closedTs = Date.parse(agent.closedAt || agent.updatedAt || agent.createdAt || "");
  if (!Number.isFinite(closedTs)) return false;
  return now - closedTs >= maxAgeMs;
}

/**
 * Filters `agents` down to janitor candidates.
 */
export function findJanitorCandidates(agents, opts = {}) {
  if (!Array.isArray(agents)) return [];
  return agents.filter((a) => isJanitorCandidate(a?.agent ?? a, opts)).map((a) => a?.agent ?? a);
}

export const STALL_QUEUED_MS = 15 * 60 * 1000;
export const STALL_RUNNING_MS = 30 * 60 * 1000;

/**
 * Returns "queued" / "running" when `agent` is a non-archived `role=worker` that has sat queued (never started)
 * or running with no activity for at least the matching threshold; otherwise null. Flag-only: never acts on it.
 */
export function stalledWorkerKind(
  agent,
  { now = Date.now(), queuedMs = STALL_QUEUED_MS, runningMs = STALL_RUNNING_MS } = {},
) {
  if (!agent || typeof agent !== "object") return null;
  if (agent.archivedAt) return null;
  if (String(agent.labels?.role || "").toLowerCase() !== "worker") return null;
  const status = String(agent.status || "").toLowerCase();
  if (status !== "queued" && status !== "running") return null;
  const ts = Date.parse(agent.lastActivityAt || agent.updatedAt || agent.createdAt || "");
  if (!Number.isFinite(ts)) return null;
  return now - ts >= (status === "queued" ? queuedMs : runningMs) ? status : null;
}

/**
 * Lists stalled workers as `{ id, status, silentMs }`.
 */
export function findStalledWorkers(agents, opts = {}) {
  if (!Array.isArray(agents)) return [];
  const now = opts.now ?? Date.now();
  const out = [];
  for (const raw of agents) {
    const a = raw?.agent ?? raw;
    const kind = stalledWorkerKind(a, opts);
    if (!kind) continue;
    const ts = Date.parse(a.lastActivityAt || a.updatedAt || a.createdAt);
    out.push({ id: a.id, status: kind, silentMs: now - ts });
  }
  return out;
}

/**
 * Scans non-archived daemon agents, detaches live children of each candidate worker first
 * (so live children are never cascade-archived), and archives eligible closed workers.
 */
export async function runSessionJanitor(client, { now = Date.now(), maxAgeMs = JANITOR_MAX_AGE_MS, agents } = {}) {
  const backend = getBackend(client);
  const rawList = agents ?? (await listDaemonAgents(backend));
  const list = Array.isArray(rawList) ? rawList.map((a) => a?.agent ?? a) : [];
  const candidates = findJanitorCandidates(list, { now, maxAgeMs });
  const archived = [];
  const detachedChildren = [];
  const skipped = [];
  const errors = [];

  for (const a of candidates) {
    const detached = await detachLiveChildrenViaClient(backend, a.id);
    if (detached.detached.length > 0) {
      detachedChildren.push(...detached.detached);
    }
    if (detached.failed.length > 0) {
      skipped.push({ id: a.id, reason: "detach-failed", failed: detached.failed });
      continue;
    }
    try {
      await backend.archiveAgent(a.id);
      archived.push(a.id);
    } catch (e) {
      errors.push({ id: a.id, error: String(e?.message ?? e) });
    }
  }

  return {
    ok: true,
    scanned: list.length,
    candidates: candidates.length,
    archived,
    detachedChildren,
    skipped,
    errors,
    stalled: findStalledWorkers(list, { now }),
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  if (req && req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

/**
 * HTTP handler for `/__vibesquad/janitor/run`:
 * - GET: returns candidate count/ids without archiving
 * - POST: reads optional JSON `{ maxAgeMs }` and runs `runSessionJanitor`, returning 200 JSON
 */
export async function handleJanitorRun(
  req,
  res,
  { client: injectedClient, createClient, now: injectedNow, defaultMaxAgeMs = JANITOR_MAX_AGE_MS, agents } = {},
) {
  const method = String(req?.method || "GET").toUpperCase();
  const ownedClient = !injectedClient && typeof createClient === "function" ? createClient() : null;
  const client = injectedClient ?? ownedClient;
  const ownedBackend = getBackend(ownedClient);

  try {
    if (ownedClient && typeof ownedBackend.connect === "function") {
      await ownedBackend.connect().catch(() => {});
    }
    const now = typeof injectedNow === "function" ? injectedNow() : (injectedNow ?? Date.now());

    if (method === "GET") {
      let maxAgeMs = defaultMaxAgeMs;
      try {
        const u = new URL(req.url || "/", "http://localhost");
        if (u.searchParams.has("maxAgeMs")) {
          const parsed = Number(u.searchParams.get("maxAgeMs"));
          if (Number.isFinite(parsed) && parsed >= 0) maxAgeMs = parsed;
        }
      } catch {}
      const rawList = agents ?? (client ? await listDaemonAgents(client) : []);
      const list = Array.isArray(rawList) ? rawList.map((a) => a?.agent ?? a) : [];
      const candidates = findJanitorCandidates(list, { now, maxAgeMs });
      sendJson(res, 200, {
        ok: true,
        scanned: list.length,
        candidates: candidates.length,
        candidateIds: candidates.map((c) => c.id),
        stalled: findStalledWorkers(list, { now }),
      });
      return true;
    }

    if (method === "POST") {
      const body = await readJsonBody(req);
      const maxAgeMs =
        typeof body?.maxAgeMs === "number" && Number.isFinite(body.maxAgeMs) && body.maxAgeMs >= 0
          ? body.maxAgeMs
          : defaultMaxAgeMs;
      const result = await runSessionJanitor(client, { now, maxAgeMs, agents });
      sendJson(res, 200, result);
      return true;
    }

    sendJson(res, 405, { ok: false, error: "Method not allowed" });
    return true;
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    return true;
  } finally {
    if (ownedClient && typeof ownedBackend.close === "function") {
      await ownedBackend.close().catch(() => {});
    }
  }
}

/**
 * Connect/Vite middleware serving `/__vibesquad/janitor/run`.
 */
export function createJanitorMiddleware(opts = {}) {
  return async function janitorMiddleware(req, res, next) {
    const pathname = String(req?.url || "").split("?")[0];
    if (pathname !== "/__vibesquad/janitor/run") {
      if (typeof next === "function") return next();
      return false;
    }
    return handleJanitorRun(req, res, opts);
  };
}
