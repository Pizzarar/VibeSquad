// Hosts the Paseo plugin's hook closure (server/hooks/agent-duties.ts) for runner agents (docs/lanes/runner-pilot/B11-hook-inventory.md).
// The plugin is written against a tiny duck-typed server (`before` / `on`) and a `paseo` facade; this module provides both,
// backed by a RunnerBackend, so prompt layering, labelling, digests, wakeups and lead handoff run the SAME code for rn-* agents.
// Paseo agents keep getting the plugin from the Paseo daemon only; this host is only ever fed runner events, so nothing double-fires.

const GENERIC = new Set(["agent.create", "agent.created", "agent.turn_started", "agent.turn_ended", "send_agent_prompt", "agent.send"]);

let pluginModule;
const loadPlugin = () => (pluginModule ??= import("../hooks/agent-duties.ts"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NOT_FINISHED_AFTER_MS = 60_000;

/** The `paseo.agents` / `paseo.schedules` surface the plugin calls, answered by the runner. */
export function runnerPaseoFacade(backend, plugin) {
  const tl = async (id, opts = {}) => ({ entries: (await backend.fetchAgentTimeline(id, { limit: opts.limit })).entries });

  /** Resolves like DaemonClient.waitForFinish, but an agent that has not started its first turn is not "finished". */
  const waitForFinish = async (id, timeoutMs) => {
    const start = Date.now();
    const deadline = start + (timeoutMs > 0 ? timeoutMs : Infinity);
    let sawRunning = false;
    for (;;) {
      const agent = await backend.getAgent(id);
      if (agent.status === "running") sawRunning = true;
      if (agent.status === "closed") return { status: "error", error: "agent exited", agent };
      if (agent.status === "idle") {
        // A turn that came and went between two polls still counts: the timeline has something other than the user's prompt.
        if (!sawRunning) sawRunning = (await tl(id, { limit: 50 }).catch(() => ({ entries: [] }))).entries.some((e) => e.item.type !== "user_message");
        if (sawRunning || Date.now() - start > NOT_FINISHED_AFTER_MS) return { status: "idle", agent };
      }
      if (Date.now() >= deadline) return { status: "timeout", agent };
      await sleep(1000);
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
        return {
          id: agent.id,
          agent,
          async waitForFinish(ms) {
            try {
              return await waitForFinish(agent.id, ms);
            } finally {
              if (autoArchive) await backend.archiveAgent(agent.id).catch(() => {});
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
export async function createRunnerHookHost(backend, { startWatcher = false, deps = {} } = {}) {
  process.env.VS_PLUGIN_LOG = "stderr"; // hooks may run inside an MCP stdio server: stdout belongs to the protocol
  const plugin = await loadPlugin();
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
  const paseo = runnerPaseoFacade(backend, plugin);
  const dispose = plugin.createPlugin({
    setLabels: (id, labels, name) => backend.updateAgent(id, { labels, ...(name ? { name } : {}) }),
    archiveAgent: (id) => backend.archiveAgent(id),
    refuseAgent: async (id) => {
      await backend.cancelAgent(id).catch(() => {});
      await backend.archiveAgent(id);
    },
    deleteHeartbeat: (id) => backend.deleteHeartbeat(id),
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
