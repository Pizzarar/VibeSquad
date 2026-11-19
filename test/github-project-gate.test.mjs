// idea-343: gh-repos / gh-clone are PC-owner only (vibesquad-api isGhProjectPath + isLocalOwner gate).
// No test below reaches `gh` or the network: the handler-reached case sends a bad repo spec, which the handler rejects (400) before any runner.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "vs-gh-gate-"));
process.env.VIBESQUAD_HOME = home;
const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
after(() => rmSync(home, { recursive: true, force: true }));

const rootDir = join(import.meta.dirname, "..");

function call(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => ok({ status: res.statusCode, body: data }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

describe("gh-repos / gh-clone local-owner gate", () => {
  let srv;
  let port;
  let token;
  let relayed = false; // when true the listener marks the request as arriving over the relay tunnel
  before(async () => {
    token = auth.getLocalToken();
    const mw = api.createVibesquadMiddleware(rootDir);
    srv = createServer((req, res) => {
      if (relayed) req.relayDevice = { id: "dev-relay-test" };
      mw(req, res, () => {
        res.statusCode = 404;
        res.end("next");
      });
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    port = srv.address().port;
  });
  after(() => new Promise((ok) => srv.close(ok)));

  const clone = (headers, repo = "-bad") =>
    call(port, "/__vibesquad/git/gh-clone", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ repo }) });

  test("no token: 403 on both routes, handler not reached", async () => {
    const c = await clone({});
    assert.equal(c.status, 403);
    assert.doesNotMatch(c.body, /owner\/repo/, "the handler's validation error must not appear");
    const r = await call(port, "/__vibesquad/git/gh-repos");
    assert.equal(r.status, 403, r.body);
  });

  test("relay / non-local caller: refused even with the local token header", async () => {
    relayed = true;
    try {
      // An unpaired relay device is stopped by the trust gate (401) before the route gate (403); either way the handler is not reached.
      const c = await clone({ "x-vibesquad-token": token });
      assert.equal(c.status, 401, c.body);
      assert.doesNotMatch(c.body, /owner\/repo/);
      const r = await call(port, "/__vibesquad/git/gh-repos", { headers: { "x-vibesquad-token": token } });
      assert.equal(r.status, 401, r.body);
    } finally {
      relayed = false;
    }
  });

  test("local owner token reaches the handler (bad repo -> its 400, no gh run)", async () => {
    const c = await clone({ "x-vibesquad-token": token });
    assert.equal(c.status, 400, c.body);
    assert.match(JSON.parse(c.body).error, /owner\/repo/);
  });
});
