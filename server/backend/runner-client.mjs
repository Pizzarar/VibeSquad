// HTTP client + process lifecycle for the VS agent runner (runner/server.mjs).
// Discovery: <home>/runner.json (port, pid) and <home>/token (bearer, mode 0600).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isForbiddenRealHome } from "../test-guard.mjs";
import { acquireStartLock, releaseLock } from "../../runner/lock.mjs";

const RUNNER_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "runner", "server.mjs");

/** Three missed 15s runner heartbeats and the event stream is treated as dead. */
const STREAM_IDLE_MS = 45000;

export const runnerHome = (env = process.env) => path.join(env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad"), "runner");

export function readDiscovery(home) {
  if (isForbiddenRealHome(home)) return null; // under a test runner the real runner does not exist
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

const clean = (v) => String(v ?? "").trim();

/**
 * How this process authenticates to the runner (X1a, final shape X1d), from its env. Same rule as tools.mjs agentCallerOf
 * and cli/vs.mjs ownerProofFromEnv: any agent identity in the env makes this an agent shell.
 *   - neither VS_AGENT_ID / PASEO_AGENT_ID nor VS_AGENT_TOKEN: the admin bearer (<home>/token): the VS server, its hook
 *     host, restart-runtime → null.
 *   - VS_AGENT_ID + VS_AGENT_TOKEN: agent headers only (the bearer is never sent) → { id, token }.
 *   - one without the other (an id whose child predates the token, or a leftover token with the id cleared): an incomplete
 *     agent caller → { id, token } with one of them empty; authHeadersFor refuses it (403) before any request is built.
 *     An agent shell never falls back to the admin bearer (X1d review R1 H1; the X1a-X1b rollout flag is gone).
 */
export function agentCallerFromEnv(env = process.env) {
  const id = clean(env.VS_AGENT_ID) || clean(env.PASEO_AGENT_ID);
  const token = clean(env.VS_AGENT_TOKEN);
  if (!id && !token) return null;
  return { id, token };
}

/**
 * Request headers for a caller: agent headers for a complete { id, token }; the bearer only for null/undefined (admin,
 * an explicit choice by the VS server or restart-runtime). An incomplete pair throws a 403 RunnerHttpError: nothing is
 * sent, and it is never the bearer.
 */
export function authHeadersFor(caller, bearer) {
  if (caller === null || caller === undefined) return { authorization: `Bearer ${bearer}` };
  const id = clean(caller.id);
  const token = clean(caller.token);
  if (!id || !token) throw new RunnerHttpError(403, `403: agent token invalid for ${id || "(no VS_AGENT_ID)"} (an agent caller needs both VS_AGENT_ID and VS_AGENT_TOKEN; an agent shell never uses the runner's admin bearer)`);
  return { "x-vs-agent-id": id, "x-vs-agent-token": token };
}

/** Thrown by every non-owner path when the runner is not up: they connect, they never start it. */
export class RunnerDownError extends RunnerHttpError {
  constructor(message = "RUNNER_DOWN: the VibeSquad runner is not running. The VibeSquad server starts it (and restarts it if it dies); start or restart VibeSquad.") {
    super(503, message);
    this.code = "RUNNER_DOWN";
  }
}

export class RunnerClient {
  /**
   * caller: who this client is by default. undefined = resolved from the process env on every request (agentCallerFromEnv:
   * an agent's MCP sidecar sends its own token, the VS server sends the admin bearer); null = always the admin bearer;
   * { id, token } = always that agent. A per-request `opts.caller` (the VS server forwarding a verified agent, X1c) wins.
   */
  constructor({ home, fetchImpl = fetch, spawnImpl = spawn, startTimeoutMs = 8000, requestTimeoutMs = 15000, queueMs = 10 * 60_000, probeTimeoutMs = 2000, caller, env = process.env } = {}) {
    this.queueMs = queueMs; // the runner's slot-queue wait: create/input may legitimately take this long
    this.probeTimeoutMs = probeTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this._home = home; // undefined = follow VIBESQUAD_HOME on every use (the shared backend outlives env changes)
    this._connHome = null;
    this.fetch = fetchImpl;
    this.spawn = spawnImpl;
    this.startTimeoutMs = startTimeoutMs;
    this.conn = null; // { port, token }
    this.starting = null;
    this.caller = caller;
    this.env = env;
    this.writeSeq = 0; // bumped when a non-GET request settles: a coalesced read started before a write must not answer a reader after it
  }

  /** Headers for a request: the explicit per-call caller, else this client's, else the process env. Admin = the bearer. */
  authHeaders(opts = {}) {
    const caller = "caller" in opts ? opts.caller : this.caller !== undefined ? this.caller : agentCallerFromEnv(this.env);
    return authHeadersFor(caller, this.conn?.token);
  }

  /** GET /verify-agent as `caller` ({ id, token }): the runner's verified record, or a 403 RunnerHttpError. */
  verifyAgent(caller) {
    return this.request("GET", "/verify-agent", undefined, { caller });
  }

  /** Explicit `home` wins; otherwise resolved per call so a cached client never keeps pointing at an earlier VIBESQUAD_HOME. */
  get home() {
    const home = this._home ?? runnerHome();
    if (home !== this._connHome) {
      this._connHome = home;
      this.conn = null; // discovery belongs to the old home
    }
    return home;
  }
  set home(v) {
    this._home = v;
  }

  async request(method, route, body, opts = {}) {
    if (method !== "GET") {
      try {
        return await this._requestOnce(method, route, body, opts);
      } finally {
        this.writeSeq++;
      }
    }
    try {
      return await this._requestOnce(method, route, body, opts);
    } catch (err) {
      if (!err?.transport || method !== "GET") throw err;
      // Idempotent read: one retry, but only if re-discovery found a different runner (a timeout on the same port would just hang again).
      const next = readDiscovery(this.home);
      if (!next || next.port === err.port) throw err;
      this.conn = next;
      return this._requestOnce(method, route, body, opts);
    }
  }

  async _requestOnce(method, route, body, opts = {}) {
    const home = this.home; // also drops a conn cached for a different home
    if (!this.conn) this.conn = readDiscovery(home);
    if (!this.conn) throw new RunnerHttpError(0, "runner is not running");
    const { port } = this.conn;
    const auth = this.authHeaders(opts);
    const ac = new AbortController();
    // create/input queue for a slot inside the runner (up to queueMs), so a silent 15s is not proof of a hang: probe /health instead.
    const queued = method === "POST" && (route === "/agents" || /^\/agents\/[^/]+\/input$/.test(route));
    const hardDeadline = Date.now() + this.queueMs + this.requestTimeoutMs;
    let timer;
    let done = false;
    const arm = () => {
      timer = setTimeout(async () => {
        if (!queued || Date.now() >= hardDeadline) return ac.abort();
        let healthy = false;
        try {
          const h = await this.fetch(`http://127.0.0.1:${port}/health`, { headers: auth, signal: AbortSignal.timeout(this.probeTimeoutMs) });
          healthy = h.ok;
        } catch { /* unreachable */ }
        if (done || ac.signal.aborted) return;
        if (healthy) arm();
        else ac.abort();
      }, this.requestTimeoutMs);
    };
    arm();
    let res;
    let data;
    try {
      res = await this.fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      // Connect error or timeout: the runner is hung or moved to a new port. Drop the stale conn so the next call re-reads discovery.
      this.conn = null;
      const err = new RunnerHttpError(504, ac.signal.aborted ? `runner not responding (no answer in ${Math.round(this.requestTimeoutMs / 1000)}s)` : `runner not responding (${e?.cause?.code || e?.message || "connection failed"})`);
      err.transport = true;
      err.port = port;
      throw err;
    } finally {
      done = true;
      clearTimeout(timer);
    }
    if (!res.ok) throw new RunnerHttpError(res.status, data.error || `runner ${res.status}`);
    return data;
  }

  /**
   * Tail the runner's /events SSE stream. Reconnects (retryMs) until close(); onOpen/onClose bracket each connection,
   * onMessage gets each parsed { id, event }. close() aborts the request and clears the retry timer: nothing lingers.
   */
  stream({ onMessage, onOpen, onClose, retryMs = 2000, idleMs = STREAM_IDLE_MS } = {}) {
    let closed = false;
    let ac = null;
    let timer = null;
    let idle = null;
    // The runner heartbeats every 15s: a stream that goes quiet without erroring (half-open socket) would freeze live chat
    // until the VS server restarts, so silence past idleMs aborts it and falls into the normal reconnect.
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ac?.abort(), idleMs);
      idle.unref?.();
    };
    const run = async () => {
      let opened = false;
      try {
        this.conn = readDiscovery(this.home) ?? this.conn;
        if (!this.conn) throw new Error("runner is not running");
        ac = new AbortController();
        // The event stream is admin only (the VS server's lifecycle bus): always the bearer.
        const res = await this.fetch(`http://127.0.0.1:${this.conn.port}/events`, { headers: authHeadersFor(null, this.conn.token), signal: ac.signal });
        if (!res.ok || !res.body) throw new Error(`runner events ${res.status}`);
        opened = true;
        arm();
        if (!closed) onOpen?.();
        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of res.body) {
          arm();
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
            if (!data) continue;
            try { onMessage?.(JSON.parse(data)); } catch { /* malformed frame: skip */ }
          }
        }
      } catch {
        this.conn = null; // stale discovery (runner restarted on a new port): re-read next time
      }
      clearTimeout(idle);
      if (opened && !closed) onClose?.();
      if (!closed) {
        timer = setTimeout(run, retryMs);
        timer.unref?.();
      }
    };
    run();
    return {
      close() {
        closed = true;
        clearTimeout(timer);
        clearTimeout(idle);
        ac?.abort();
      },
    };
  }

  async healthy() {
    this.conn = readDiscovery(this.home);
    if (!this.conn) return false;
    try {
      await this.request("GET", "/health");
      return true;
    } catch (e) {
      if (e?.status === 403) throw e; // an incomplete or wrong agent identity is a refusal, not a runner that is down
      this.conn = null;
      return false;
    }
  }

  /** Connect-only: resolves when a live runner answers, else throws RUNNER_DOWN. Never spawns. */
  async requireRunning() {
    if (!(await this.healthy())) throw new RunnerDownError();
  }

  /**
   * OWNER ONLY (the VS server's runner supervisor, server/runner-supervisor.mjs): attach to a live runner, else start one
   * detached (so a VS restart never kills agents). Every other caller uses requireRunning().
   */
  startOwned() {
    this.starting ??= (async () => {
      if (isForbiddenRealHome(this.home)) throw new Error("refusing to start a runner in the real home under a test runner");
      if (await this.healthy()) return;
      fs.mkdirSync(this.home, { recursive: true });
      // Cross-process start lock: concurrent callers (other VS processes, CLI one-liners) wait for the one that holds it
      // instead of each spawning a runner. A crashed holder's lock goes stale after STALE_START_LOCK_MS.
      const lockFile = path.join(this.home, "starting.lock");
      const deadline = Date.now() + this.startTimeoutMs;
      while (!acquireStartLock(lockFile)) {
        if (await this.healthy()) return;
        if (Date.now() >= deadline) throw new Error("runner did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
      try {
        if (await this.healthy()) return; // someone finished starting it while we waited
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
        const startDeadline = Date.now() + this.startTimeoutMs;
        while (Date.now() < startDeadline) {
          if (await this.healthy()) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error("runner did not start");
      } finally {
        releaseLock(lockFile);
      }
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
}
