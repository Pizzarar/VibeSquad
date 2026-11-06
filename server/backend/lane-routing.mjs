// Per-lane backend switch (docs/PLAN_OWN_DAEMON.md Block 3). Since the runner cutover every lane defaults to the runner.
// A lane opts back into Paseo with `"backend": "paseo"` on its teams.json entry or env VS_PASEO_LANES="lane-a,lane-b".
// Existing Paseo-hosted agents (non rn- ids) keep routing to Paseo by id whenever a daemon is running.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTeamsFilePath } from "../teams-file.mjs";
import { isRunnerId } from "./runner-backend.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const norm = (v) => String(v ?? "").trim().toLowerCase();

/**
 * Set-like view of "which lanes live on the runner": every lane (including none) except the ones pinned to Paseo.
 * `has` answers the routing question; `size` is always >= 1 (the runner is always on); iteration yields the lanes
 * explicitly marked runner (teams.json `backend: "runner"` / VS_RUNNER_LANES), which stay valid but are now redundant.
 */
export class RunnerLaneSet extends Set {
  constructor(explicitRunner = [], paseoLanes = []) {
    super(explicitRunner);
    Object.defineProperty(this, "paseoLanes", { value: new Set(paseoLanes) });
  }

  has(lane) {
    return !this.paseoLanes.has(norm(lane));
  }

  /** The pre-cutover view: only lanes explicitly switched to the runner. */
  explicit() {
    return new Set(this);
  }

  get size() {
    return Math.max(1, super.size);
  }
}

/** Lanes (and aliases) pinned to Paseo; everything else runs on the runner. */
export function runnerLanes({ env = process.env, teamsFile } = {}) {
  const explicit = new Set(String(env.VS_RUNNER_LANES ?? "").split(",").map(norm).filter(Boolean));
  const paseo = new Set(String(env.VS_PASEO_LANES ?? "").split(",").map(norm).filter(Boolean));
  try {
    const file = teamsFile ?? resolveTeamsFilePath(REPO_ROOT);
    const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    for (const team of data?.teams ?? []) {
      for (const lane of team?.lanes ?? []) {
        const backend = norm(lane?.backend);
        if (backend !== "runner" && backend !== "paseo") continue;
        const target = backend === "paseo" ? paseo : explicit;
        target.add(norm(lane.id));
        for (const alias of lane.aliases ?? []) target.add(norm(alias));
      }
    }
  } catch {
    // no readable teams.json: env only
  }
  for (const l of paseo) explicit.delete(l);
  return new RunnerLaneSet(explicit, paseo);
}

export const laneOfCreate = (req) => norm(req?.labels?.lane || req?.env?.VS_LANE);

const PER_ID = [
  "fetchAgent", "getAgent", "sendAgentPrompt", "fetchAgentTimeline", "getAgentTimeline", "cancelAgent",
  "archiveAgent", "updateAgent", "refreshAgent", "detachAgent", "deleteHeartbeat", "waitForFinish",
];
const PASS_TO_PASEO = ["close", "subscribe", "subscribeConnectionStatus"];

const listOf = (res) => (Array.isArray(res) ? res : Array.isArray(res?.entries) ? res.entries : Array.isArray(res?.agents) ? res.agents : null);

function mergeLists(paseoRes, runnerRes) {
  const extra = listOf(runnerRes) ?? [];
  if (!extra.length) return paseoRes;
  const base = listOf(paseoRes);
  if (!base) return runnerRes;
  const merged = [...base, ...extra];
  if (Array.isArray(paseoRes)) return merged;
  return { ...paseoRes, [Array.isArray(paseoRes.entries) ? "entries" : "agents"]: merged };
}

/** Routes by agent id (rn- = runner) and, for createAgent, by lane. Merges list calls. Used only when a lane is switched. */
export class RoutingBackend {
  constructor(paseo, runner, { lanes = runnerLanes, paseoAlive = null } = {}) {
    Object.defineProperty(this, "paseoAlive", { value: paseoAlive });
    Object.defineProperty(this, "paseo", { value: paseo });
    Object.defineProperty(this, "runner", { value: runner });
    Object.defineProperty(this, "lanes", { value: lanes });
  }

  runCli(...args) {
    return this.paseo.runCli(...args);
  }
}

Object.defineProperty(RoutingBackend.prototype, "connect", {
  configurable: true,
  get() {
    const p = this.paseo.connect;
    if (!p) return undefined;
    // Paseo is optional after the cutover: a closed daemon port must not cost the 5s connect timeout on every call.
    // Skipping connect leaves the client unconnected, so Paseo calls reject at once and list calls fall back to the runner.
    return async () => {
      if (this.paseoAlive && !(await this.paseoAlive())) return undefined;
      return p.call(this.paseo);
    };
  },
});
for (const name of PASS_TO_PASEO) {
  Object.defineProperty(RoutingBackend.prototype, name, { configurable: true, get() { return this.paseo[name]; } });
}
for (const name of PER_ID) {
  Object.defineProperty(RoutingBackend.prototype, name, {
    configurable: true,
    get() {
      const paseoFn = this.paseo[name];
      return (...args) => {
        if (isRunnerId(args[0])) return this.runner[name](...args);
        // The raw DaemonClient lacks some seam methods (e.g. sendAgentPrompt): callers guard on typeof and skip, so a
        // Paseo id stays a silent no-op here instead of throwing.
        return paseoFn ? paseoFn(...args) : Promise.resolve(undefined);
      };
    },
  });
}
Object.defineProperty(RoutingBackend.prototype, "createAgent", {
  configurable: true,
  get() {
    return (req, ...rest) => {
      const lane = laneOfCreate(req);
      if (this.lanes().has(lane)) return this.runner.createAgent(req, ...rest);
      const fn = this.paseo.createAgent;
      return fn ? fn(req, ...rest) : Promise.resolve(undefined);
    };
  },
});
for (const name of ["fetchAgents", "listAgents"]) {
  Object.defineProperty(RoutingBackend.prototype, name, {
    configurable: true,
    get() {
      const paseoFn = this.paseo[name];
      if (!paseoFn) return undefined;
      return async (...args) => {
        // Runner agents join the first page only; a later page (cursor) would repeat them.
        if (args[0]?.page?.cursor) return paseoFn(...args);
        const [p, r] = await Promise.all([paseoFn(...args).catch((e) => (this.paseoAlive ? null : Promise.reject(e))), this.runner[name](...args).catch(() => null)]);
        return p == null && r != null ? r : mergeLists(p, r);
      };
    },
  });
}

let probe = { at: 0, value: false, pending: null };

/** Cheap, cached "is a Paseo daemon accepting connections" check (TCP only, 400ms budget, 3s cache). */
export function paseoDaemonAlive({ ttlMs = 3000, now = Date.now, check } = {}) {
  if (probe.pending) return probe.pending;
  if (now() - probe.at < ttlMs) return Promise.resolve(probe.value);
  probe.pending = (async () => {
    try {
      if (check) return await check();
      const { isDaemonListening, readPaseoListen } = await import("../first-run.mjs");
      return await isDaemonListening(readPaseoListen(), 400);
    } catch {
      return false;
    }
  })().then((v) => {
    probe = { at: now(), value: v, pending: null };
    return v;
  });
  return probe.pending;
}

export function resetPaseoProbe() {
  probe = { at: 0, value: false, pending: null };
}
