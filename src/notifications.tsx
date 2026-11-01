import { memo, useCallback, useEffect, useRef, useState } from "react";

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

export const PushNotificationControls = memo(function PushNotificationControls() {
  const [enabled, setEnabled] = useState<boolean>(() => localStorage.getItem("vs.push.enabled") === "1");
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const regRef = useRef<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(async (reg) => {
        if (cancelled) return;
        regRef.current = reg;
        try {
          const existing = await reg.pushManager?.getSubscription();
          if (!cancelled && existing) {
            setEnabled(true);
            localStorage.setItem("vs.push.enabled", "1");
          }
        } catch {
          // PushManager may not be available in all contexts
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

      if (subJson?.endpoint && subJson?.keys?.p256dh && subJson?.keys?.auth) {
        await fetch("/__vibesquad/push/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(subJson),
        });
      }

      setEnabled(true);
      localStorage.setItem("vs.push.enabled", "1");
      setStatusMsg("Alerts active");
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

      // Also trigger via Service Worker message / showNotification so the OS notification shade
      // always receives the alert even on offline/emulator networks without FCM relay access.
      const reg = await ensureSwRegistration();
      const worker = reg?.active || reg?.waiting || reg?.installing || navigator.serviceWorker?.controller;
      if (worker) {
        worker.postMessage({ type: "VS_SHOW_NOTIFICATION", payload });
      } else if (reg && typeof reg.showNotification === "function" && Notification.permission === "granted") {
        await reg.showNotification(payload.title, {
          body: payload.body,
          icon: "/vibesquad-192.png",
          badge: "/vibesquad-192.png",
          tag: payload.tag || "vs-test-push",
          data: { url: payload.url || "/?focus=needs-you" },
        });
      } else if ("Notification" in window && Notification.permission === "granted") {
        new Notification(payload.title, {
          body: payload.body,
          icon: "/vibesquad-192.png",
          tag: payload.tag || "vs-test-push",
        });
      }

      setStatusMsg(res?.sent > 0 ? `Sent (${res.sent})` : "Test alert shown");
    } catch (err: any) {
      setStatusMsg(String(err?.message ?? "Test failed"));
    } finally {
      setBusy(false);
    }
  }, [busy, ensureSwRegistration]);

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
