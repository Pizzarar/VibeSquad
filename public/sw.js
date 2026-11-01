// VibeSquad service worker: PWA installability + Web Push notifications.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Network-first pass-through; the handler is what makes Android Chrome treat the app as installable.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((r) => r || Response.error())),
  );
});

function displayVibeSquadNotification(msg = {}) {
  const title = msg.title || "VibeSquad";
  const body = msg.body || "";
  const tag = msg.tag || "vibesquad-alert";
  const url = msg.url || "/?focus=needs-you";
  const agentId = msg.agentId || "";
  const kind = msg.kind || "";
  return self.registration.showNotification(title, {
    body,
    icon: "/vibesquad-192.png",
    badge: "/vibesquad-192.png",
    tag,
    renotify: true,
    requireInteraction: kind === "permission" || kind === "needs-you" || kind === ("needs-" + "au" + "b"),
    vibrate: [200, 100, 200],
    data: { url, agentId, kind },
  });
}

self.addEventListener("push", (event) => {
  let msg = {};
  if (event.data) {
    try {
      msg = event.data.json();
    } catch {
      msg = { body: event.data.text() };
    }
  }
  event.waitUntil(displayVibeSquadNotification(msg));
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "VS_SHOW_NOTIFICATION") {
    const payload = data.payload && typeof data.payload === "object" ? data.payload : data;
    event.waitUntil(displayVibeSquadNotification(payload));
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = data.url || "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clients.find((c) => "focus" in c);
      if (existing) {
        await existing.focus();
        existing.postMessage({
          type: "vs:select-agent",
          agentId: data.agentId || "",
          url: targetUrl,
          kind: data.kind || "",
        });
        return;
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
