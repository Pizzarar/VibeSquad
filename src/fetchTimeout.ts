// A fetch that can never hang the UI: it aborts after `ms` and rejects with a readable error, so "Loading…" turns into data or a visible error.
export async function fetchJsonTimeout(url: string, ms: number, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, ms);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${url.split("/").pop()} ${res.status}`);
    return await res.json();
  } catch (e) {
    if (timedOut) throw new Error(`timed out after ${Math.round(ms / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Delay before re-probing art that failed to load (a busy runtime can drop or reset a request); null = give up. */
export function imageRetryDelay(attempt: number): number | null {
  const steps = [1500, 4000, 10000, 20000];
  return attempt < steps.length ? steps[attempt] : null;
}
