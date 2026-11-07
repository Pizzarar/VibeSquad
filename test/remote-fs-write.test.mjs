// N2: owner-only fs mutations + the watch long-poll through the remote proxy (rules + a real handler against the real routes).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { decideProxyRequest, checkRemoteBody, proxyTimeoutFor, REMOTE_FS_WRITE_CHARS } from "../server/hooks/remote-proxy-rules.ts";
import { handleFsMutation, handleFsWatch } from "../server/file-search.mjs";

const OPS = ["write", "create", "rename", "delete", "duplicate"];
const TOKEN = "d".repeat(64);

describe("rules", () => {
  test("mutations are POST-only, watch is GET-only, nothing else under fs/ opens", () => {
    for (const op of OPS) {
      const p = `/__vibesquad/fs/${op}`;
      assert.equal(decideProxyRequest("POST", p).ok, true, p);
      for (const m of ["GET", "PUT", "PATCH", "DELETE"]) assert.equal(decideProxyRequest(m, p).code, "method", `${m} ${p}`);
    }
    assert.equal(decideProxyRequest("GET", "/__vibesquad/fs/watch?cwd=C:/w&path=a&since=1").ok, true);
    assert.equal(decideProxyRequest("POST", "/__vibesquad/fs/watch").code, "method");
    assert.equal(decideProxyRequest("POST", "/__vibesquad/fs/format").code, "not-allowed");
    assert.equal(proxyTimeoutFor("/__vibesquad/fs/watch") > 25_000, true);
    assert.equal(proxyTimeoutFor("/__vibesquad/fs/read"), 10_000);
  });
  test("body policy: typed, capped, cwd allowed, other forbidden keys refused", () => {
    const ok = (op, o) => checkRemoteBody("POST", `/__vibesquad/fs/${op}`, JSON.stringify(o));
    assert.equal(ok("write", { cwd: "C:/w", path: "a.md", content: "hi", expectedModifiedAt: "2026-01-01T00:00:00.000Z" }).ok, true);
    assert.equal(ok("write", { cwd: "C:/w", path: "a.md", content: "x".repeat(REMOTE_FS_WRITE_CHARS + 1) }).status, 403);
    assert.equal(ok("write", { cwd: "C:/w", path: "a.md" }).status, 403, "content required");
    assert.equal(ok("write", { path: "a.md", content: "" }).status, 403, "cwd required");
    assert.equal(ok("write", { cwd: "C:/w", path: "a.md", content: "", provider: "x" }).status, 403);
    assert.equal(ok("write", { cwd: "C:/w", path: "a.md", content: "", extra: 1 }).status, 403);
    assert.equal(ok("create", { cwd: "C:/w", parentPath: "", name: "n.md", kind: "file" }).ok, true);
    assert.equal(ok("create", { cwd: "C:/w", name: "n.md", kind: "socket" }).status, 403);
    assert.equal(ok("rename", { cwd: "C:/w", path: "a", name: "b" }).ok, true);
    assert.equal(ok("delete", { cwd: "C:/w", path: "a" }).ok, true);
    assert.equal(ok("duplicate", { cwd: "C:/w", path: "a" }).ok, true);
    assert.equal(ok("delete", { cwd: "C:/w" }).status, 403);
  });
});

describe("contract: owner gate over the proxy", () => {
  let server, port, ws, home, bare;
  const seen = [];
  before(async () => {
    ws = mkdtempSync(join(tmpdir(), "vs-n2-ws-"));
    home = mkdtempSync(join(tmpdir(), "vs-n2-home-"));
    bare = mkdtempSync(join(tmpdir(), "vs-n2-bare-")); // a host with no loopback owner token
    writeFileSync(join(home, "local-token"), TOKEN);
    for (const h of [home, bare]) writeFileSync(join(h, "settings.json"), JSON.stringify({ userName: "Owner", remote: { enabled: true } }));
    writeFileSync(join(ws, "a.txt"), "one");
    const send = (res, status, obj) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
    const readBody = (req) => new Promise((ok) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => ok(JSON.parse(d || "{}"))); });
    server = createServer((req, res) => {
      const path = req.url.split("?")[0];
      seen.push([req.method, path, req.headers["x-vibesquad-token"]]);
      // Mirrors the middleware: non-GET and gated reads need the loopback owner token.
      if (req.headers["x-vibesquad-token"] !== TOKEN) return send(res, 403, { error: "read-only", readOnly: true });
      if (path === "/__vibesquad/fs/watch") return handleFsWatch(req, res, [ws], send);
      if (path.startsWith("/__vibesquad/fs/")) return handleFsMutation(path.slice("/__vibesquad/fs/".length), req, res, [ws], send, readBody);
      send(res, 404, {});
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  after(() => {
    server.closeAllConnections?.();
    server.close();
    for (const d of [ws, home, bare]) rmSync(d, { recursive: true, force: true });
  });
  const post = (h, op, body) => makeVsHttpHandler({ port, home: h })({ method: "POST", path: `/__vibesquad/fs/${op}`, body: JSON.stringify(body) });

});
