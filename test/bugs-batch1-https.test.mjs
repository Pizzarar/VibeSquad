// docs/PLAN_BUGS_BATCH1.md block 5: plain http on the meshnet port named no host ("https://:4180").
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "vs-https-target-"));
process.env.VIBESQUAD_HOME = home;
const auth = await import("../server/auth.mjs");
const { createMeshnetMux, httpsTargetHost } = await import("../server/serve.mjs");
after(() => rmSync(home, { recursive: true, force: true }));

test("target host: allowed Host header, else meshnet name, else meshnet IP, else localhost; never empty", () => {
  const allowed = (h) => /^(localhost|100\.64\.0\.7)(:\d+)?$/.test(h);
  assert.equal(httpsTargetHost("localhost:4180", { port: 4180, allowed }), "localhost:4180");
  assert.equal(httpsTargetHost("100.64.0.7", { port: 4180, allowed }), "100.64.0.7:4180");
  // Unknown or spoofed Host is never echoed into the redirect.
  assert.equal(httpsTargetHost("evil.example:4180", { port: 4180, meshnetIp: "100.64.0.7", allowed }), "100.64.0.7:4180");
  assert.equal(httpsTargetHost("my-pc.mesh.test:4180", { port: 4180, meshnetHost: "my-pc.mesh.test", meshnetIp: "100.64.0.7", allowed }), "my-pc.mesh.test:4180");
  assert.equal(httpsTargetHost("", { port: 4180, allowed }), "localhost:4180");
  assert.equal(httpsTargetHost(undefined, { port: 4180, meshnetHost: "", meshnetIp: "", allowed }), "localhost:4180");
});

function call({ port, method = "GET", path = "/", host }) {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: host ? { host } : {} }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => ok({ status: res.statusCode, location: res.headers.location, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

test("plain http GET is redirected to https on a real host; POST gets a 426 that names one", async () => {
  const tls = auth.getTls();
  const { mux } = createMeshnetMux({ port: 4180, meshnetHost: "", meshnetIp: "100.64.0.7", tls });
  await new Promise((ok) => mux.listen(0, "127.0.0.1", ok));
  const port = mux.address().port;
  try {
    const known = await call({ port, path: "/squads?x=1", host: "localhost:4180" });
    assert.equal(known.status, 301);
    assert.equal(known.location, "https://localhost:4180/squads?x=1");

    const spoofed = await call({ port, path: "/", host: "evil.example" });
    assert.equal(spoofed.status, 301);
    assert.equal(spoofed.location, "https://100.64.0.7:4180/");

    const post = await call({ port, method: "POST", path: "/api/x", host: "evil.example" });
    assert.equal(post.status, 426);
    assert.match(post.body, /use https:\/\/100\.64\.0\.7:4180 /);
    assert.doesNotMatch(post.body, /https:\/\/:/);
  } finally {
    await new Promise((ok) => mux.close(ok));
  }
});
