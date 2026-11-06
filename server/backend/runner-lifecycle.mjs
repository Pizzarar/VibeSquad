// The runner lifecycle event bus consumer (docs/lanes/runner-pilot/B11-hook-inventory.md): one subscription to the RunnerBackend's
// log-derived events (`created`, `turn_started`, `turn_ended`) that feeds the plugin hook host, so runner agents get the same
// agent.created / agent.turn_started / agent.turn_ended behaviour (labels, digest, handoff, A4 retry, lead wakeups) Paseo agents get
// from the Paseo daemon. Runs once, in the VS server process; Paseo agents never reach it (their events are not runner events).
import { sharedRunnerBackend } from "./index.mjs";
import { isRunnerId } from "./runner-backend.mjs";

const HOOK_FOR = { created: "agent.created", turn_started: "agent.turn_started", turn_ended: "agent.turn_ended" };

let active = null;

/**
 * Attach the watcher-enabled hook host to `runner` and forward its lifecycle events. Idempotent per backend.
 * `startWatcher:false` keeps the log.jsonl wakeup watcher off (tests).
 *
 * The baseline and the subscription happen synchronously (before the first await), so call this BEFORE anything else can open the
 * shared event stream (the push watcher): events that arrive while the plugin is still loading are buffered, then drained in order.
 * Hook emits run one at a time in event order, so a lead's `created` (ord, retire predecessor) finishes before the next agent's.
 */
export async function startRunnerLifecycle({ runner = sharedRunnerBackend(), startWatcher = true, deps } = {}) {
  if (active?.runner === runner) return active.ready;
  await stopRunnerLifecycle();
  runner.enableCatchUp();
  let host = null;
  let stopped = false;
  const buffer = [];
  let chain = Promise.resolve();
  const dispatch = ([hook, payload]) => {
    chain = chain.then(() => (stopped ? undefined : host.emit(hook, payload))).catch(() => {});
  };
  const off = runner.subscribeEvents((ev) => {
    const hook = HOOK_FOR[ev.kind];
    if (!hook || !isRunnerId(ev.agentId)) return;
    const payload = { agent: ev.agent };
    if (ev.kind === "turn_ended") Object.assign(payload, { turnId: ev.turnId, outcome: ev.outcome });
    if (host) dispatch([hook, payload]);
    else buffer.push([hook, payload]);
  });
  const cur = { runner, host: null, stop: () => { stopped = true; off(); runner.detachHooks(); }, ready: null };
  active = cur;
  cur.ready = (async () => {
    host = await runner.attachHooks({ startWatcher, deps });
    cur.host = host;
    for (const item of buffer.splice(0)) dispatch(item);
    return cur;
  })();
  return cur.ready;
}

export async function stopRunnerLifecycle() {
  const cur = active;
  active = null;
  cur?.stop();
}
