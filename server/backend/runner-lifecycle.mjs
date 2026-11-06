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
 */
export async function startRunnerLifecycle({ runner = sharedRunnerBackend(), startWatcher = true, deps } = {}) {
  if (active?.runner === runner) return active;
  await stopRunnerLifecycle();
  const host = await runner.attachHooks({ startWatcher, deps });
  const off = runner.subscribeEvents((ev) => {
    const hook = HOOK_FOR[ev.kind];
    if (!hook || !isRunnerId(ev.agentId)) return;
    const payload = { agent: ev.agent };
    if (ev.kind === "turn_ended") Object.assign(payload, { turnId: ev.turnId, outcome: ev.outcome });
    void host.emit(hook, payload);
  });
  active = { runner, host, stop: () => { off(); runner.detachHooks(); } };
  return active;
}

export async function stopRunnerLifecycle() {
  const cur = active;
  active = null;
  cur?.stop();
}
