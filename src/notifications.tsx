import { memo, useCallback, useEffect, useRef, useState } from "react";
import { DEMO } from "./demoFlag";
import { getPrefs, pushEventsFromPrefs, subscribePrefs } from "./prefs";
import { isRemote } from "./remoteSession";

export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const buffer = new ArrayBuffer(rawData.length);
  const outputArray = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export interface TestPushOutcome {
  webPushSent: number;
  desktopShown: boolean;
  desktopError?: string | null;
  browserShown: boolean;
  totalSubscribed: number;
  permission?: string;
}

/** Truthful test-push status: never claims a toast that nothing displayed. */
export function formatTestPushStatus(o: TestPushOutcome): string {
  const devices = `${o.webPushSent} device${o.webPushSent === 1 ? "" : "s"}`;
  if (o.desktopShown) {
    return o.webPushSent > 0 ? `Desktop toast shown · Sent to ${devices}` : "Desktop toast shown";
  }
  if (o.desktopError) return `Desktop toast blocked (${o.desktopError})`;
  if (o.webPushSent > 0) return `Sent to ${devices}`;
  if (o.browserShown) return "Browser notification shown";
  if (o.permission && o.permission !== "granted" && o.permission !== "unsupported") {
    return `Blocked (notification permission ${o.permission})`;
  }
  return "No devices subscribed";
}

const DESKTOP_SUB = { type: "desktop", endpoint: "desktop://local", deviceName: "Windows · VibeSquad Desktop" };

async function postSubscription(body: unknown): Promise<boolean> {
  try {
    const r = await fetch("/__vibesquad/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function desktopAvailable(): Promise<boolean> {
  if ((window as any).__VIBESQUAD_DESKTOP__) return true;
  try {
    const r = await fetch("/__desktop/status");
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    return j?.ok === true;
  } catch {
    return false;
  }
}

// Push filter: the server's watcher skips any event turned off in Settings › Notifications. Synced through the
// existing /__vibesquad/settings endpoint on load and whenever a toggle changes (the last device to change wins).
const PUSH_SYNC_DELAYS_MS = [500, 1000, 2000];

export interface PushEventsSyncerOpts {
  getPushEvents?: () => Record<string, boolean>;
  fetchFn?: typeof fetch;
  scheduleRetry?: (fn: () => void, ms: number) => unknown;
  cancelRetry?: (handle: unknown) => void;
  isDisabled?: () => boolean;
  delaysMs?: readonly number[];
}

export function createPushEventsSyncer(opts?: PushEventsSyncerOpts): () => void {
  const getEvents = opts?.getPushEvents ?? (() => pushEventsFromPrefs(getPrefs()));
  const schedule = opts?.scheduleRetry ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts?.cancelRetry ?? ((h) => clearTimeout(h as any));
  const disabled = opts?.isDisabled ?? (() => isRemote() || DEMO);
  const delays = opts?.delaysMs ?? PUSH_SYNC_DELAYS_MS;

  let lastPushEvents = "";
  let syncSeq = 0;
  let retryTimer: unknown = null;

  const clearRetry = () => {
    if (retryTimer !== null) {
      cancel(retryTimer);
      retryTimer = null;
    }
  };

  const attempt = (seq: number, pushEvents: Record<string, boolean>, key: string, retryIndex: number) => {
    void Promise.resolve()
      .then(() => (opts?.fetchFn ?? fetch)("/__vibesquad/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pushEvents }) }))
      .then((r) => {
        if (!r || !r.ok) throw new Error(`HTTP ${r?.status ?? "error"}`);
      })
      .catch(() => {
        if (seq !== syncSeq) return;
        lastPushEvents = "";
        if (retryIndex < delays.length) {
          retryTimer = schedule(() => {
            retryTimer = null;
            if (seq !== syncSeq) return;
            lastPushEvents = key;
            attempt(seq, pushEvents, key, retryIndex + 1);
          }, delays[retryIndex]);
        }
      });
  };

  return function sync(): void {
    if (disabled()) return;
    const pushEvents = getEvents();
    const key = JSON.stringify(pushEvents);
    if (key === lastPushEvents) return;
    clearRetry();
    const seq = ++syncSeq;
    lastPushEvents = key;
    attempt(seq, pushEvents, key, 0);
  };
}

const syncPushEventsImpl = createPushEventsSyncer();
function syncPushEvents(): void {
  if (isRemote()) return;
  syncPushEventsImpl();
}
if (typeof window !== "undefined") {
  syncPushEvents();
  subscribePrefs(syncPushEvents);
}

/** Short two-note chime for in-app alerts (Settings › Notifications › Alert sound). */
export function playAlertChime(): void {
  try {
    const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx: AudioContext = new Ctx();
    const at = ctx.currentTime;
    [880, 1320].forEach((hz, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "square";
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, at + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.06, at + i * 0.12 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + i * 0.12 + 0.11);
      o.connect(g).connect(ctx.destination);
      o.start(at + i * 0.12);
      o.stop(at + i * 0.12 + 0.12);
    });
    setTimeout(() => void ctx.close().catch(() => {}), 500);
  } catch {
    /* audio unavailable */
  }
}

export const PushNotificationControls = memo(function PushNotificationControls() {
  const [enabled, setEnabled] = useState<boolean>(() => localStorage.getItem("vs.push.enabled") === "1");
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const regRef = useRef<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (isRemote() || typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(async (reg) => {
        if (cancelled) return;
        regRef.current = reg;
        try {
          let existing = await reg.pushManager?.getSubscription();
          if (!cancelled && existing) {
            // The VAPID key may have rotated; a stale subscription can never receive pushes.
            const keyRes = await fetch("/__vibesquad/push/vapid-public-key").then((r) => r.json()).catch(() => null);
            const publicKey: string = keyRes?.publicKey ?? "";
            const storedKey = localStorage.getItem("vs.push.vapidKey");
            if (publicKey && storedKey && storedKey !== publicKey) {
              await existing.unsubscribe().catch(() => {});
              existing = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey),
              });
            }
            if (publicKey) localStorage.setItem("vs.push.vapidKey", publicKey);
            // Always re-register so push-subs.json recovers even if the file was lost.
            await postSubscription(existing.toJSON());
            if (!cancelled) {
              setEnabled(true);
              localStorage.setItem("vs.push.enabled", "1");
            }
          }
        } catch {
          // PushManager may not be available in all contexts
        }
        if (!cancelled && localStorage.getItem("vs.push.enabled") === "1" && (await desktopAvailable())) {
          await postSubscription(DESKTOP_SUB);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const ensureSwRegistration = useCallback(async (): Promise<ServiceWorkerRegistration | null> => {
    if (regRef.current) return regRef.current;
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready.catch(() => {});
      regRef.current = reg;
      return reg;
    } catch {
      return null;
    }
  }, []);

  const togglePush = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      const reg = await ensureSwRegistration();
      if (enabled) {
        const sub = await reg?.pushManager?.getSubscription().catch(() => null);
        const endpoint = sub?.endpoint ?? "";
        if (sub) await sub.unsubscribe().catch(() => {});
        await fetch("/__vibesquad/push/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint }),
        }).catch(() => {});
        setEnabled(false);
        localStorage.setItem("vs.push.enabled", "0");
        setStatusMsg("Alerts off");
        return;
      }

      if ("Notification" in window && Notification.permission !== "granted") {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") {
          setStatusMsg("Permission denied");
          return;
        }
      }

      const keyRes = await fetch("/__vibesquad/push/vapid-public-key").then((r) => r.json());
      const publicKey: string = keyRes?.publicKey ?? "";
      let subJson: any = null;

      if (reg?.pushManager && publicKey) {
        try {
          const existing = await reg.pushManager.getSubscription();
          const sub =
            existing ??
            (await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(publicKey),
            }));
          subJson = sub.toJSON();
        } catch {
          // Browser or headless/emulator environment without FCM push service:
          // fall back to local service-worker notification mode.
        }
      }

      let webPushOk = false;
      if (subJson?.endpoint && subJson?.keys?.p256dh && subJson?.keys?.auth) {
        webPushOk = await postSubscription(subJson);
        if (webPushOk && publicKey) localStorage.setItem("vs.push.vapidKey", publicKey);
      }

      let desktopOk = false;
      if (await desktopAvailable()) desktopOk = await postSubscription(DESKTOP_SUB);

      const browserOk = "Notification" in window && Notification.permission === "granted";
      if (!webPushOk && !desktopOk && !browserOk) {
        setStatusMsg("Alerts unavailable: no Web Push service, desktop shell, or notification permission");
        return;
      }

      setEnabled(true);
      localStorage.setItem("vs.push.enabled", "1");
      setStatusMsg(
        webPushOk && desktopOk
          ? "Alerts active (phone + desktop)"
          : desktopOk
            ? "Alerts active (desktop toasts)"
            : webPushOk
              ? "Alerts active (Web Push)"
              : "Alerts active (this browser only)",
      );
    } catch (err: any) {
      setStatusMsg(String(err?.message ?? "Failed"));
    } finally {
      setBusy(false);
    }
  }, [busy, enabled, ensureSwRegistration]);

  const handleTestPush = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      if ("Notification" in window && Notification.permission === "default") {
        await Notification.requestPermission().catch(() => {});
      }

      const res = await fetch("/__vibesquad/push/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }).then((r) => r.json());

      const payload = res?.payload ?? {
        title: "VibeSquad · Test Alert",
        body: "Lock-screen Web Push is active.",
        url: "/?focus=needs-you",
        tag: "vs-test-push",
        kind: "permission",
      };

      let desktopShown = false;
      let desktopError: string | null = null;
      let browserShown = false;

      // Desktop shell: ask the Tauri host to fire a real Windows toast.
      try {
        const dr = await fetch("/__desktop/notify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: payload.title, body: payload.body }),
        });
        if (dr.ok) {
          const dj = await dr.json().catch(() => null);
          if (dj?.ok === true && dj?.shown === true) desktopShown = true;
          else if (dj) desktopError = String(dj.error ?? "unknown error");
        }
      } catch {
        // Not running inside the desktop shell.
      }

      if (!desktopShown && !desktopError && "Notification" in window && Notification.permission === "granted") {
        try {
          const reg = await ensureSwRegistration();
          if (reg && typeof reg.showNotification === "function") {
            await reg.showNotification(payload.title, {
              body: payload.body,
              icon: "/vibesquad-192.png",
              badge: "/vibesquad-192.png",
              tag: payload.tag || "vs-test-push",
              data: { url: payload.url || "/?focus=needs-you" },
            });
            browserShown = true;
          }
        } catch {
          browserShown = false;
        }
      }

      setStatusMsg(
        formatTestPushStatus({
          webPushSent: Number(res?.sent ?? 0),
          desktopShown,
          desktopError,
          browserShown,
          totalSubscribed: Number(res?.total ?? res?.subCount ?? 0),
          permission: "Notification" in window ? Notification.permission : "unsupported",
        }),
      );
    } catch (err: any) {
      setStatusMsg(String(err?.message ?? "Test failed"));
    } finally {
      setBusy(false);
    }
  }, [busy, ensureSwRegistration]);

  if (isRemote()) {
    return (
      <span className="muted small" data-testid="push-remote-disabled">
        Managed on host PC
      </span>
    );
  }

  return (
    <div className="push-controls" data-testid="push-controls">
      <div className="push-controls-row">
        <button
          type="button"
          className={`btn ghost small push-toggle-btn ${enabled ? "on" : ""}`}
          onClick={togglePush}
          disabled={busy}
          data-testid="btn-toggle-push"
          title={enabled ? "Web Push alerts enabled (click to disable)" : "Enable Web Push lock-screen notifications"}
        >
          {enabled ? "🔔 Alerts ON" : "🔔 Enable alerts"}
        </button>
        <button
          type="button"
          className="btn ghost small push-test-btn"
          onClick={handleTestPush}
          disabled={busy}
          data-testid="btn-test-push"
          title="Send a test Web Push notification"
        >
          📨 Test push
        </button>
      </div>
      {statusMsg && (
        <div className="push-status muted small" data-testid="push-status">
          {statusMsg}
        </div>
      )}
    </div>
  );
});
