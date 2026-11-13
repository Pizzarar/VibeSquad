// Hosts the Paseo plugin's hook closure (server/hooks/agent-duties.ts) for runner agents (docs/lanes/runner-pilot/B11-hook-inventory.md).
// The plugin is written against a tiny duck-typed server (`before` / `on`) and a `paseo` facade; this module provides both,
// backed by a RunnerBackend, so prompt layering, labelling, digests, wakeups and lead handoff run the SAME code for rn-* agents.
// Paseo agents keep getting the plugin from the Paseo daemon only; this host is only ever fed runner events, so nothing double-fires.

const GENERIC = new Set(["agent.create", "agent.created", "agent.turn_started", "agent.turn_ended", "send_agent_prompt", "agent.send"]);

let pluginModule;
const loadPlugin = () => (pluginModule ??= import("../hooks/agent-duties.ts"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOT_FINISHED_AFTER_MS = 60_000;

/** The `paseo.agents` / `paseo.schedules` surface the plugin calls, answered by the runner. `pollMs`: status poll interval (tests shorten it). */
export function runnerPaseoFacade(backend, plugin, { pollMs = 1000 } = {}) {
  const tl = async (id, opts = {}) => ({ entries: (await backend.fetchAgentTimeline(id, { limit: opts.limit })).entries });
  const seqOf = (e) => e.seqEnd ?? e.seqStart;

  /**
   * The turn after timeline seq `floor`: entries other than the user's prompts, the last error among them, and the newest seq.
   * A runner turn that dies on a provider error (EOF, ACP prompt rejection) logs `error` then goes idle, so the status alone reads
   * like a clean finish: the error item is how the caller learns the turn failed (and waits for the A4 retry, idea-207 H2).
   */
  const turnAfter = async (id, floor) => {
    const { entries } = await tl(id, { limit: 50 }).catch(() => ({ entries: [] }));
    const fresh = entries.filter((e) => e.item?.type !== "user_message" && (seqOf(e) ?? Infinity) > floor);
    const err = fresh.findLast((e) => e.item.type === "error");
    const lastSeq = entries.reduce((m, e) => Math.max(m, seqOf(e) ?? -1), floor);
    return { any: fresh.length > 0, error: err ? String(err.item.message ?? "turn failed") : null, lastSeq };
  };

  /**
   * Resolves like DaemonClient.waitForFinish, but an agent that has not started its first turn is not "finished", and only timeline
   * items after `floor` count: a second wait (after an A4 retry was sent) must not return on the previous turn's items (idea-207 M1).
   * Returns `lastSeq` so the handle can move its floor past the turn it just reported.
   */
  const waitForFinish = async (id, timeoutMs, floor = -1) => {
    const start = Date.now();
    const deadline = start + (timeoutMs > 0 ? timeoutMs : Infinity);
    let sawRunning = false;
    for (;;) {
      const agent = await backend.getAgent(id);
      if (agent.status === "running") sawRunning = true;
      if (agent.status === "closed") return { status: "error", error: "agent exited", agent };
      if (agent.status === "idle" || agent.status === "error") {
        // A turn that came and went between two polls still counts: the timeline has something after the floor besides prompts.
        const turn = await turnAfter(id, floor);
        if (turn.any || sawRunning || Date.now() - start > NOT_FINISHED_AFTER_MS) {
          return turn.error ? { status: "error", error: turn.error, agent, lastSeq: turn.lastSeq } : { status: "idle", agent, lastSeq: turn.lastSeq };
        }
      }
      if (Date.now() >= deadline) return { status: "timeout", agent };
      await sleep(pollMs);
    }
  };

  return {
    agents: {
      ref(id) {
        return {
          refresh: async () => ({ agent: await backend.getAgent(id) }),
          // raw send: no sender, so the retired-lead redirect never re-enters itself
          send: (text) => backend.sendAgentPrompt(id, text),
          archive: () => backend.archiveAgent(id),
          detach: async () => {}, // runner agents are independent processes, not children of the spawner
          timeline: { refetch: (opts) => tl(id, opts) },
        };
      },
      async list() {
        return { entries: (await backend.listAgents()).map((agent) => ({ agent })) };
      },
      async create({ config = {}, cwd, title, prompt, labels, env, autoArchive } = {}) {
        const pm = plugin.splitProviderModel(config.provider, config.model);
        const { provider: _p, model: _m, ...rest } = config;
        const agent = await backend.createAgent({
          config: { ...rest, provider: pm.provider, ...(pm.model ? { model: pm.model } : {}), cwd: cwd ?? config.cwd, title },
          prompt,
          labels,
          env,
        });
        let floor = -1; // timeline seq of the last turn a wait already reported
        return {
          id: agent.id,
          agent,
          async waitForFinish(ms) {
            let res = null;
            try {
              res = await waitForFinish(agent.id, ms, floor);
              if (res.status !== "timeout" && Number.isFinite(res.lastSeq)) floor = res.lastSeq; // the next wait is for the next turn
              return res;
            } finally {
              // A "timeout" means still queued/running (idea-189): archiving it here killed a digest queued past one wait window,
              // so the caller's backstop logged UNVERIFIED (digest failed). The caller re-waits; archive only when finished/failed.
              // A caller that may resend after a failed turn (the worker digest's A4 retry) must not pass autoArchive: it archives itself.
              if (autoArchive && res?.status !== "timeout") await backend.archiveAgent(agent.id).catch(() => {});
            }
          },
        };
      },
    },
    schedules: { deleteHeartbeat: (id) => backend.deleteHeartbeat(id) },
  };
}

/**
 * Build a host. `startWatcher` turns on the log.jsonl wakeup watcher: exactly one host per machine should (the VS server's).
 * Returns { before(name, payload), emit(name, payload), scanLogs, dispose, plugin }.
 */
export async function createRunnerHookHost(backend, { startWatcher = false, deps = {}, pollMs } = {}) {
  const plugin = await loadPlugin();
  plugin.setLogStream?.("stderr"); // hooks may run inside an MCP stdio server: stdout belongs to the protocol (a module sink, not process.env: env leaks to the runner and agents)
  const befores = new Map();
  const ons = new Map();
  const add = (map, name, fn) => {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(fn);
    return () => {
      const list = map.get(name) ?? [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  };
  // No `handle`: the vs.http remote RPC is a Paseo-daemon feature.
  const server = { before: (name, fn) => add(befores, name, fn), on: (name, fn) => add(ons, name, fn) };
  const paseo = runnerPaseoFacade(backend, plugin, pollMs ? { pollMs } : {});
  const dispose = plugin.createPlugin({
    setLabels: (id, labels, name) => backend.updateAgent(id, { labels, ...(name ? { name } : {}) }),
    archiveAgent: (id) => backend.archiveAgent(id),
    refuseAgent: async (id) => {
      await backend.cancelAgent(id).catch(() => {});
      await backend.archiveAgent(id);
    },
    deleteHeartbeat: (id) => backend.deleteHeartbeat(id),
    // Watch sets (server/watch-sets.mjs) run only in the watcher host (one per machine) and read the runner's lifecycle stream.
    ...(startWatcher ? { subscribeRunnerEvents: (fn) => backend.subscribeEvents(fn) } : {}),
    startWatcher,
    ...deps,
  })(server);
  dispose.setPaseo(paseo);

  return {
    plugin,
    scanLogs: dispose.scanLogs,
    sweepDoneWorkersReport: dispose.sweepDoneWorkersReport,
    dispose,
    /** Run the `before` handlers for `name` in order. For `agent.create` payload is `{ request }` and the result is the rewritten request (or undefined). */
    async before(name, payload) {
      if (!GENERIC.has(name)) return undefined;
      let result;
      let cur = payload;
      for (const fn of [...(befores.get(name) ?? [])]) {
        const out = await fn(cur, { paseo });
        if (out === undefined) continue;
        result = out;
        if (name === "agent.create") cur = { ...cur, request: out };
      }
      return result;
    },
    /** Deliver a lifecycle event: handlers run concurrently, failures are swallowed (a hook must never break the runner path). */
    async emit(name, payload) {
      await Promise.all(
        [...(ons.get(name) ?? [])].map(async (fn) => {
          try {
            await fn(payload, { paseo });
          } catch (err) {
            console.warn(`[vibesquad] runner hook ${name} failed: ${err}`);
          }
        }),
      );
    },
  };
}
