// Request-path crash guard: a throw (sync or async) inside an HTTP handler answers 500 instead of
// taking the whole server down (11-06: a stale readBuildStamp ReferenceError killed :4180).
export function guardHandler(fn, log = (...a) => console.error(...a)) {
  const fail = (req, res, err) => {
    try {
      log(`[serve] request handler failed ${req?.method ?? ""} ${String(req?.url ?? "").split("?")[0]}:`, err?.stack ?? err);
      if (res.headersSent || res.writableEnded) return res.destroy?.();
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ error: "internal error" }));
    } catch {}
  };
  return (req, res) => {
    try {
      const r = fn(req, res);
      if (r && typeof r.catch === "function") r.catch((err) => fail(req, res, err));
    } catch (err) {
      fail(req, res, err);
    }
  };
}

// process-level net for request paths whose error escaped every handler (timers, streams): log and keep serving.
export function installUncaughtGuard(proc = process, log = (...a) => console.error(...a)) {
  const onUncaught = (err) => log("[serve] uncaughtException (continuing):", err?.stack ?? err);
  proc.on("uncaughtException", onUncaught);
  return onUncaught;
}
