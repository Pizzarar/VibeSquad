// HTTP client + process lifecycle for the VS agent runner (runner/server.mjs).
// Discovery: <home>/runner.json (port, pid) and <home>/token (bearer, mode 0600).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "runner", "server.mjs");

export const runnerHome = (env = process.env) => path.join(env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"), "runner");

export function readDiscovery(home) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(home, "runner.json"), "utf8"));
    const token = fs.readFileSync(path.join(home, "token"), "utf8").trim();
    return info?.port && token ? { port: info.port, pid: info.pid, token } : null;
  } catch {
    return null;
  }
}

export class RunnerHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class RunnerClient {
  constructor({ home = runnerHome(), fetchImpl = fetch, spawnImpl = spawn, startTimeoutMs = 8000 } = {}) {
    this.home = home;
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.startTimeoutMs = startTimeoutMs;
    this.conn = null; // { port, token }
    this.starting = null;
  }

  async request(method, route, body) {
    if (!this.conn) this.conn = readDiscovery(this.home);
    if (!this.conn) throw new RunnerHttpError(0, "runner is not running");
    const res = await this.fetch(`http://127.0.0.1:${this.conn.port}${route}`, {
      method,
      headers: { authorization: `Bearer ${this.conn.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new RunnerHttpError(res.status, data.error || `runner ${res.status}`);
    return data;
  }

  async healthy() {
    this.conn = readDiscovery(this.home);
    if (!this.conn) return false;
    try {
      await this.request("GET", "/health");
      return true;
    } catch {
      this.conn = null;
      return false;
    }
  }

  /** Attach to a live runner, else start one detached (so a VS restart never kills agents). */
  ensureRunning() {
    this.starting ??= (async () => {
      if (await this.healthy()) return;
      fs.mkdirSync(this.home, { recursive: true });
      // Detached + own log + unref: a short-lived CLI one-liner must be able to exit without taking the runner
      // (and every agent under it) with it. stdio goes to a file, never a pipe the parent has to keep open.
      const log = fs.openSync(path.join(this.home, "runner.log"), "a");
      let child;
      try {
        child = this.spawn(process.execPath, [RUNNER_ENTRY, "--home", this.home], {
          detached: true,
          stdio: ["ignore", log, log],
          windowsHide: true,
          shell: false,
        });
      } finally {
        fs.closeSync(log);
      }
      child.unref?.();
      const deadline = Date.now() + this.startTimeoutMs;
      while (Date.now() < deadline) {
        if (await this.healthy()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("runner did not start");
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
}
