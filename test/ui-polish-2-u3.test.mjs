import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "vs-u3-"));
process.env.VIBESQUAD_HOME = home;
process.env.PASEO_DAEMON = "127.0.0.1:1";
process.env.PASEO_HOME = join(home, "paseo");

const push = await import("../server/push.mjs");
const api = await import("../server/vibesquad-api.mjs");
after(() => rmSync(home, { recursive: true, force: true }));

const keys = { p256dh: "B" + "A".repeat(86), auth: "A".repeat(22) };
const web = { endpoint: "https://fcm.googleapis.com/fcm/send/u3", keys };
const desktop = { type: "desktop", endpoint: "desktop://local", deviceName: "Windows · VibeSquad Desktop" };

describe("push-subs.json persistence", () => {
  test("desktop + webpush survive re-read and remove independently", () => {
    push.writePushSubscriptions([]);
    assert.equal(push.savePushSubscription(desktop).type, "desktop");
    assert.equal(push.savePushSubscription(web).type, "webpush");
    push.savePushSubscription(desktop); // idempotent
    const onDisk = JSON.parse(readFileSync(push.getPushSubsPath(), "utf8"));
    assert.equal(onDisk.length, 2);
    const subs = push.readPushSubscriptions();
    assert.ok(subs.some((s) => s.type === "desktop" && s.endpoint === "desktop://local"));
    assert.ok(subs.some((s) => s.endpoint === web.endpoint));
    push.removePushSubscription("desktop://local");
    assert.equal(push.readPushSubscriptions().length, 1);
  });
  test("rejects malformed desktop subscription", () => {
    assert.throws(() => push.savePushSubscription({ type: "desktop", endpoint: "https://x.example.com/a" }));
  });
});

function httpCall(port, path, method = "GET", body) {
  return new Promise((ok, fail) => {
    const r = request(
      { host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` } },
      (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => ok({ status: res.statusCode, json: t ? JSON.parse(t) : null }));
      },
    );
    r.on("error", fail);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

describe("push endpoints", () => {
  let srv;
  let port;
  before(async () => {
    srv = createServer(api.createVibesquadMiddleware(resolve(import.meta.dirname, "..")));
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    port = srv.address().port;
    push.writePushSubscriptions([]);
  });
  after(() => srv?.close());

  test("subscribe desktop + status + test", async () => {
    const sub = await httpCall(port, "/__vibesquad/push/subscribe", "POST", desktop);
    assert.equal(sub.status, 200);
    assert.equal(sub.json.type, "desktop");
    assert.equal(sub.json.count, 1);
    const st = await httpCall(port, "/__vibesquad/push/status");
    assert.equal(st.json.desktopCount, 1);
    assert.equal(st.json.webPushCount, 0);
    assert.equal(st.json.subscriptions[0].endpoint, "desktop://local");
    const t = await httpCall(port, "/__vibesquad/push/test", "POST", {});
    assert.equal(t.json.sent, 0);
    assert.equal(t.json.total, 1);
    assert.equal(t.json.desktopSubscribed, true);
    assert.equal(t.json.webPushCount, 0);
  });
  test("subscribe webpush returns type", async () => {
    const r = await httpCall(port, "/__vibesquad/push/subscribe", "POST", { ...web, deviceName: "Phone" });
    assert.equal(r.json.type, "webpush");
    assert.equal(r.json.count, 2);
    assert.equal(push.readPushSubscriptions().find((s) => s.endpoint === web.endpoint).deviceName, "Phone");
  });
});

describe("formatTestPushStatus", () => {
  const src = readFileSync(resolve(import.meta.dirname, "../src/notifications.tsx"), "utf8");
  const start = src.indexOf("export function formatTestPushStatus");
  const end = src.indexOf("const DESKTOP_SUB");
  const code = src
    .slice(start, end)
    .replace("export function", "function")
    .replace("(o: TestPushOutcome): string", "(o)");
  const fmt = new Function(`${code}; return formatTestPushStatus;`)();
  const base = { webPushSent: 0, desktopShown: false, browserShown: false, totalSubscribed: 0 };
  test("strings are truthful", () => {
    assert.equal(fmt({ ...base, webPushSent: 2 }), "Sent to 2 devices");
    assert.equal(fmt({ ...base, webPushSent: 1 }), "Sent to 1 device");
    assert.equal(fmt(base), "No devices subscribed");
    assert.equal(fmt({ ...base, desktopShown: true }), "Desktop toast shown");
    assert.equal(fmt({ ...base, desktopShown: true, webPushSent: 1 }), "Desktop toast shown · Sent to 1 device");
    assert.equal(fmt({ ...base, desktopError: "boom" }), "Desktop toast blocked (boom)");
    assert.equal(fmt({ ...base, browserShown: true }), "Browser notification shown");
    assert.equal(fmt({ ...base, permission: "denied" }), "Blocked (notification permission denied)");
    assert.ok(!/Test alert shown/.test(fmt(base)));
  });
});
