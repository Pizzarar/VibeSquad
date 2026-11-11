// X1 F10: the Web Push SSRF guard checks only the subscribed endpoint (first hop). The send must not follow a redirect from
// that endpoint with the VAPID Authorization header + encrypted body attached: a 3xx is a failed send, nothing else is fetched.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "vs-push-redirect-"));
process.env.VIBESQUAD_HOME = home;
const { sendWebPushToSubscription, broadcastWebPush, writePushSubscriptions, getOrCreateVapidKeys } = await import("../server/push.mjs");

const b64u = (b) => Buffer.from(b).toString("base64url");
function fakeSubscription(endpoint) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) } };
}

/** `/push` answers 307 -> `/internal` (a stand-in for a loopback / LAN address the first-hop guard refused); `/internal` records what reaches it. */
function startRelay() {
  const hits = { push: [], internal: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rec = { method: req.method, authorization: req.headers.authorization ?? null, bodyLen: Buffer.concat(chunks).length };
      if (req.url === "/push") {
        hits.push.push(rec);
        res.writeHead(307, { location: `http://127.0.0.1:${server.address().port}/internal` });
        res.end();
        return;
      }
      hits.internal.push(rec);
      res.writeHead(201);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` })));
}

test("F10: a 3xx from the push endpoint is a failed send; the redirect target never sees the Authorization header or body", async () => {
  const relay = await startRelay();
  try {
    const sub = fakeSubscription(`${relay.base}/push`);
    const vapid = getOrCreateVapidKeys();
    await assert.rejects(sendWebPushToSubscription(sub, { title: "t", body: "b" }, vapid), /Push relay HTTP 307/);
    assert.equal(relay.hits.push.length, 1, "the subscribed endpoint itself is POSTed once");
    assert.match(relay.hits.push[0].authorization ?? "", /^vapid /);
    assert.deepEqual(relay.hits.internal, [], "the redirect target must not be contacted");

    // broadcastWebPush counts it as failed:1 and keeps the subscription (a 3xx is not a 404/410 expiry).
    writePushSubscriptions([sub]);
    const out = await broadcastWebPush({ title: "t", body: "b" });
    assert.equal(out.sent, 0);
    assert.equal(out.failed, 1);
    assert.equal(out.subCount, 1);
    assert.match(out.errors[0], /HTTP 307/);
    assert.deepEqual(relay.hits.internal, []);
  } finally {
    relay.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
