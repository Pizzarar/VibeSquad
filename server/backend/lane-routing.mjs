// Per-lane backend switch (docs/PLAN_OWN_DAEMON.md Block 3). Since the runner cutover every lane defaults to the runner.
// A lane opts back into Paseo with `"backend": "paseo"` on its teams.json entry or env VS_PASEO_LANES="lane-a,lane-b".
// Existing Paseo-hosted agents (non rn- ids) keep routing to Paseo by id whenever a daemon is running.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTeamsFilePath } from "../teams-file.mjs";
import { loadUserSettings } from "../user-settings.mjs";
import { isRunnerId } from "./runner-backend.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const norm = (v) => String(v ?? "").trim().toLowerCase();

/**
 * Set-like view of "which lanes live on the runner": every lane (including none) except the ones pinned to Paseo.
 * `has` answers the routing question; `size` is always >= 1 (the runner is always on); iteration yields the lanes
 * explicitly marked runner (teams.json `backend: "runner"` / VS_RUNNER_LANES), which stay valid but are now redundant.
 * Consumers that need the full picture (the browser) read `defaultRunner` + `paseoLanes`, never the iteration.
 */
export class RunnerLaneSet extends Set {
  constructor(explicitRunner = [], paseoLanes = [], defaultRunner = true) {
    super(explicitRunner);
    Object.defineProperty(this, "paseoLanes", { value: new Set(paseoLanes) });
    Object.defineProperty(this, "defaultRunner", { value: defaultRunner });
  }

  has(lane) {
    if (!this.defaultRunner) return super.has(norm(lane));
    return !this.paseoLanes.has(norm(lane));
  }

  get size() {
    return this.defaultRunner ? Math.max(1, super.size) : super.size;
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
  // VS_DEFAULT_BACKEND=paseo is the global rollback (and the test-suite default): only explicit runner lanes use the runner.
  // VS_BACKEND=paseo is the plan's original name for the same escape hatch.
  const rollback = norm(env.VS_DEFAULT_BACKEND) === "paseo" || norm(env.VS_BACKEND) === "paseo";
  return new RunnerLaneSet(explicit, paseo, !rollback);
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

/** Flags a runner-only list result (array or {entries}/{agents}) with a non-enumerable `paseoUnavailable: true`. */
function markPaseoUnavailable(res) {
  if (res && typeof res === "object") Object.defineProperty(res, "paseoUnavailable", { value: true, enumerable: false, configurable: true });
  return res;
}

const paseoDownError = () =>
  Object.assign(new Error("Paseo is not running. Start it in Settings (Start Paseo with VibeSquad) or move this lane to the runner."), { code: "PASEO_UNAVAILABLE" });

/** Paseo is wanted on purpose: the autostart setting is on, or a lane is pinned to Paseo. (Status only: it no longer blocks runner-only operations.) */
export function paseoExpected({ settings, lanes = runnerLanes } = {}) {
  try {
    return (settings ?? loadUserSettings()).startPaseoWithVibeSquad === true || lanes().paseoLanes.size > 0;
  } catch {
    return false;
  }
}

/**
 * Routes by agent id (rn- = runner) and, for createAgent, by lane. Merges list calls.
 * `connect()` never throws for a closed Paseo port (the runner needs no Paseo); it records `paseoUnavailable` instead, and
 * every Paseo-bound call after that rejects with code PASEO_UNAVAILABLE so callers cannot mistake it for a connected daemon.
 */
export class RoutingBackend {
  constructor(paseo, runner, { lanes = runnerLanes, paseoAlive = null } = {}) {
    Object.defineProperty(this, "paseoAlive", { value: paseoAlive });
    Object.defineProperty(this, "paseo", { value: paseo });
    Object.defineProperty(this, "runner", { value: runner });
    Object.defineProperty(this, "lanes", { value: lanes });
    Object.defineProperty(this, "state", { value: { down: false } });
  }

  /** True once connect() found no Paseo daemon listening. */
  get paseoUnavailable() {
    return this.state.down;
  }

  runCli(...args) {
    return this.paseo.runCli(...args);
  }

  /**
   * Fail with RUNNER_DOWN if the runner is down and `lane` routes to it (no lane: any runner lane enabled). Never starts it:
   * only the VS server's supervisor does. A Paseo-pinned lane does not need the runner.
   */
  ensureRunner(lane) {
    if (lane ? !this.lanes().has(norm(lane)) : !this.lanes().size) return Promise.resolve();
    return Promise.resolve(this.runner.requireRunning?.());
  }
}

Object.defineProperty(RoutingBackend.prototype, "connect", {
  configurable: true,
  get() {
    const p = this.paseo.connect;
    if (!p) return undefined;
    // Paseo is optional after the cutover: a closed daemon port must not cost the 5s connect timeout on every call.
    return async () => {
      if (this.paseoAlive && !(await this.paseoAlive())) {
        this.state.down = true;
        return undefined;
      }
      this.state.down = false;
      try {
        return await p.call(this.paseo);
      } catch (e) {
        // The probe said alive (3s cache) but the daemon died or refused: runner lanes must still proceed. Without the
        // production probe wrapper (tests / injected clients) the failure propagates as before.
        if (!this.paseoAlive) throw e;
        this.state.down = true;
        return undefined;
      }
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
        if (this.state.down && paseoFn) return Promise.reject(paseoDownError());
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
      if (this.state.down && fn) return Promise.reject(paseoDownError());
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
        // Paseo down: runner agents only, flagged `paseoUnavailable` so callers that care (a Paseo-pinned lane's duplicate-Buddy
        // guard) can fail closed on their own. A runner-only operation must never be blocked by a Paseo that is not in use.
        let paseoFailed = this.state.down;
        const paseoList = this.state.down
          ? Promise.resolve(null)
          : paseoFn(...args).catch((e) => {
              if (!this.paseoAlive) return Promise.reject(e);
              paseoFailed = true; // died mid-flight: same as down, the caller must be able to tell
              return null;
            });
        const [p, r] = await Promise.all([paseoList, this.runner[name](...args).catch(() => null)]);
        // An unreadable Paseo answer (null / junk) is unknown, not empty: a runner list must not paper over it.
        if (listOf(p) == null) paseoFailed = true;
        const merged = p == null && r != null ? r : mergeLists(p, r);
        return paseoFailed ? markPaseoUnavailable(merged) : merged;
      };
    },
  });
}

/** Cached "is a Paseo daemon accepting connections" check (TCP only, 400ms budget). Custom check/now: own instance, no shared state. */
export function createPaseoProbe({ ttlMs = 3000, now = Date.now, check } = {}) {
  let at = 0;
  let value = false;
  let pending = null;
  let generation = 0;
  const run = async () => {
    try {
      if (check) return await check();
      const { isDaemonListening, readPaseoListen } = await import("../first-run.mjs");
      return await isDaemonListening(readPaseoListen(), 400);
    } catch {
      return false;
    }
  };
  const alive = () => {
    if (pending) return pending;
    if (now() - at < ttlMs) return Promise.resolve(value);
    const gen = generation;
    const mine = run().then((v) => {
      if (gen === generation) {
        at = now();
        value = v;
      }
      if (pending === mine) pending = null;
      return v;
    });
    pending = mine;
    return mine;
  };
  alive.reset = () => {
    generation += 1; // a probe still in flight settles into nothing
    at = 0;
    value = false;
    pending = null;
  };
  return alive;
}

const sharedProbe = createPaseoProbe();

export function paseoDaemonAlive(opts) {
  return opts ? createPaseoProbe(opts)() : sharedProbe();
}

export function resetPaseoProbe() {
  sharedProbe.reset();
}
