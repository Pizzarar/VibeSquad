// N2: owner-only fs mutations + the watch long-poll through the remote proxy (rules only; the vs.http handler is gone).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decideProxyRequest, checkRemoteBody, proxyTimeoutFor, REMOTE_FS_WRITE_CHARS } from "../server/hooks/remote-proxy-rules.ts";

const OPS = ["write", "create", "rename", "delete", "duplicate"];

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
