// idea-239: /usage is heavy server-side, and a reconnect storm (runner up/down flapping) refetched it every time.
// Single-flight + short TTL cache: concurrent callers share one request, and a fresh result is reused.
export function cachedLoader<T>(load: () => Promise<T>, ttlMs: number, now: () => number = Date.now) {
  let inflight: Promise<T> | null = null;
  let value: { v: T; at: number } | null = null;
  return (force = false): Promise<T> => {
    if (!force && value && now() - value.at < ttlMs) return Promise.resolve(value.v);
    if (inflight) return inflight;
    const p = load().then(
      (v) => { value = { v, at: now() }; inflight = null; return v; },
      (e) => { inflight = null; throw e; },
    );
    inflight = p;
    return p;
  };
}
