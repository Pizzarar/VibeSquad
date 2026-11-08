// Host-scoped CA pinning for the Android APK (PLAN_ANDROID_MESHNET.md A2). The WebView only reaches the paired PC over
// its own VS CA, so the native side (src-tauri/android/VsTrust.kt) pins that CA per `host:port` at pairing and the
// WebViewClient accepts a certificate error only for a pinned host whose leaf really chains to the pinned CA.
// This file is the web side of that bridge: a tiny request/reply protocol over WebViewCompat.addWebMessageListener
// (the listener is allowed from the app origin only, so a page served by the paired PC cannot call it). No imports.

/** The native object `window.VsTrust` (WebMessageListener JS proxy). Absent in browsers, desktop and node. */
export type NativeTrust = { postMessage(message: string): void; onmessage: ((event: { data: unknown }) => void) | null };
type Reply = { id: number; ok: boolean; error?: string; fp?: string };
type Op = { op: "pin"; host: string; fp: string } | { op: "probe" | "forget"; host: string };

const REPLY_TIMEOUT_MS = 20_000;

/** The bridge when running inside the APK, else null. */
export function nativeTrust(g: any = globalThis): NativeTrust | null {
  const n = g?.VsTrust;
  return n && typeof n.postMessage === "function" ? (n as NativeTrust) : null;
}

export type TrustClient = {
  /** Fetches the host's CA over TLS, requires its SHA-256 to start with `fp`, pins the whole CA to `host`. Resolves the full fingerprint. */
  pin(host: string, fp: string): Promise<string>;
  /** Reachability over TLS validated against the pinned CA (rejects when not pinned). */
  probe(host: string): Promise<void>;
  /** Drops the pin for `host`. */
  forget(host: string): Promise<void>;
};

export function createTrustClient(native: NativeTrust, timeoutMs = REPLY_TIMEOUT_MS): TrustClient {
  let seq = 0;
  const waiting = new Map<number, (r: Reply) => void>();
  native.onmessage = (e) => {
    let r: Reply | null = null;
    try {
      r = JSON.parse(String(e.data));
    } catch {
      /* not ours */
    }
    if (r && typeof r.id === "number") waiting.get(r.id)?.(r);
  };
  const call = (op: Op): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
      }, timeoutMs);
      waiting.set(id, (r) => {
        clearTimeout(timer);
        waiting.delete(id);
        if (r.ok) resolve(r);
        else reject(new Error(r.error || "failed"));
      });
      native.postMessage(JSON.stringify({ id, ...op }));
    });
  return {
    pin: async (host, fp) => (await call({ op: "pin", host, fp })).fp ?? "",
    probe: async (host) => void (await call({ op: "probe", host })),
    forget: async (host) => void (await call({ op: "forget", host })),
  };
}
