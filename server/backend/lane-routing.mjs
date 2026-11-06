// Per-lane backend switch (docs/PLAN_OWN_DAEMON.md Block 3). Default for every lane = Paseo.
// A lane moves to the runner via env VS_RUNNER_LANES="lane-a,lane-b" or `"backend": "runner"` on its teams.json entry.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTeamsFilePath } from "../teams-file.mjs";
import { isRunnerId } from "./runner-backend.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const norm = (v) => String(v ?? "").trim().toLowerCase();

/** Lowercased lane ids (and aliases) switched to the runner. Empty set = everything stays on Paseo. */
export function runnerLanes({ env = process.env, teamsFile } = {}) {
  const lanes = new Set(String(env.VS_RUNNER_LANES ?? "").split(",").map(norm).filter(Boolean));
  try {
    const file = teamsFile ?? resolveTeamsFilePath(REPO_ROOT);
    const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    for (const team of data?.teams ?? []) {
      for (const lane of team?.lanes ?? []) {
        if (norm(lane?.backend) !== "runner") continue;
        lanes.add(norm(lane.id));
        for (const alias of lane.aliases ?? []) lanes.add(norm(alias));
      }
    }
  } catch {
    // no readable teams.json: env only
  }
  return lanes;
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
  constructor(paseo, runner, { lanes = runnerLanes } = {}) {
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
    return p ? () => p.call(this.paseo) : undefined;
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
        if (!paseoFn) throw new TypeError(`${name} is not available`);
        return paseoFn(...args);
      };
    },
  });
}
Object.defineProperty(RoutingBackend.prototype, "createAgent", {
  configurable: true,
  get() {
    return (req, ...rest) => {
      const lane = laneOfCreate(req);
      if (lane && this.lanes().has(lane)) return this.runner.createAgent(req, ...rest);
      const fn = this.paseo.createAgent;
      if (!fn) throw new TypeError("createAgent is not available");
      return fn(req, ...rest);
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
        const [p, r] = await Promise.all([paseoFn(...args), this.runner[name](...args).catch(() => null)]);
        return mergeLists(p, r);
      };
    },
  });
}
