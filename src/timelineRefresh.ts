// Refetch scheduling for runner timelines. A runner event carries no item (it is only "something changed"), so the
// transcript lives on refetches. A trailing debounce that restarts on every event never fires while tokens stream; this
// one fetches at once (leading edge), then at most once per `gapMs` while events keep coming, and a stale (inactive)
// timeline refetches at a slower gap while hidden and at once when it becomes active.

export type RefreshClock = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
};

const realClock: RefreshClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const RUNNER_REFRESH_GAP_MS = 800;
/** A mounted-but-hidden timeline (background tab, other pane) still refetches, just slower, so it is current when shown and its pending "Sending…" clears. */
export const RUNNER_HIDDEN_GAP_MS = 3000;
/** Catch-up requests this close to the last fetch are one connect burst. */
export const CATCHUP_COALESCE_MS = 1000;

export function createRefreshScheduler(opts: {
  load: () => void;
  isActive: () => boolean;
  gapMs?: number;
  hiddenGapMs?: number;
  clock?: RefreshClock;
}) {
  const { load, isActive, gapMs = RUNNER_REFRESH_GAP_MS, hiddenGapMs = RUNNER_HIDDEN_GAP_MS, clock = realClock } = opts;
  let last = -Infinity;
  let timer: unknown = null;
  let stale = false;

  const run = () => {
    timer = null;
    stale = false;
    last = clock.now();
    load();
  };

  return {
    /** A runner event arrived. */
    request() {
      const active = isActive();
      stale = !active; // hidden: owed a fetch until the throttled one below lands (or activation)
      if (timer) return; // a trailing fetch is already due; it is never pushed back
      const wait = last + (active ? gapMs : hiddenGapMs) - clock.now();
      if (wait <= 0) run();
      else timer = clock.setTimeout(run, wait);
    },
    /** The event stream (re)connected or the window came back: events may have been missed, so catch up. */
    catchUp() {
      if (timer || clock.now() - last < CATCHUP_COALESCE_MS) return; // a connect burst (open + connected + roster) fetches once
      run();
    },
    /** The timeline became active/visible: refetch now if events were missed while it was not. */
    activate() {
      if (!stale) return;
      stale = false;
      if (timer) clock.clearTimeout(timer);
      run();
    },
    dispose() {
      if (timer) clock.clearTimeout(timer);
      timer = null;
    },
    isStale: () => stale,
  };
}
