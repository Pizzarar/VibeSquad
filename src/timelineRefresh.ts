// Refetch scheduling for runner timelines. A runner event carries no item (it is only "something changed"), so the
// transcript lives on refetches. A trailing debounce that restarts on every event never fires while tokens stream; this
// one fetches at once (leading edge), then at most once per `gapMs` while events keep coming, and a stale (inactive)
// timeline refetches the moment it becomes active.

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

export function createRefreshScheduler(opts: {
  load: () => void;
  isActive: () => boolean;
  gapMs?: number;
  clock?: RefreshClock;
}) {
  const { load, isActive, gapMs = RUNNER_REFRESH_GAP_MS, clock = realClock } = opts;
  let last = -Infinity;
  let timer: unknown = null;
  let stale = false;

  const run = () => {
    timer = null;
    last = clock.now();
    load();
  };

  return {
    /** A runner event arrived. */
    request() {
      if (!isActive()) {
        stale = true;
        return;
      }
      if (timer) return; // a trailing fetch is already due; it is never pushed back
      const wait = last + gapMs - clock.now();
      if (wait <= 0) run();
      else timer = clock.setTimeout(run, wait);
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
