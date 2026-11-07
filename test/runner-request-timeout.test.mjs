// RunnerClient.request must never hang: a hung runner times out, a dead/moved one drops the stale conn, and an idempotent GET
// retries once against the re-discovered port.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerClient } from "../server/backend/runner-client.mjs";

const disco = (home, port) => {
  writeFileSync(path.join(home, "runner.json"), JSON.stringify({ port, pid: 1 }));
  writeFileSync(path.join(home, "token"), "tok");
};
const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const hang = (_url, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));

test("request times out on a hung runner with 'runner not responding' and drops conn", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vs-rt-"));
  try {
    disco(home, 1111);
    const rc = new RunnerClient({ home, fetchImpl: hang, requestTimeoutMs: 30 });
    await assert.rejects(rc.request("POST", "/agents/x/input", {}), (e) => e.status === 504 && /runner not responding/.test(e.message));
    assert.equal(rc.conn, null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("connect error drops conn; next call re-reads discovery on the new port", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vs-rt-"));
  try {
    disco(home, 1111);
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      if (url.includes(":1111")) throw new Error("ECONNREFUSED");
      return ok({ ok: true });
    };
    const rc = new RunnerClient({ home, fetchImpl, requestTimeoutMs: 1000 });
    await assert.rejects(rc.request("POST", "/x", {}), { status: 504 });
    assert.equal(rc.conn, null);
    disco(home, 2222); // runner restarted on a new port
    assert.deepEqual(await rc.request("POST", "/x", {}), { ok: true });
    assert.equal(rc.conn.port, 2222);
    assert.deepEqual(urls, ["http://127.0.0.1:1111/x", "http://127.0.0.1:2222/x"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("GET retries once after re-discovery to a new port; POST does not", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vs-rt-"));
  try {
    disco(home, 1111);
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      if (url.includes(":1111")) { disco(home, 2222); throw new Error("ECONNREFUSED"); }
      return ok({ ids: [] });
    };
    const rc = new RunnerClient({ home, fetchImpl, requestTimeoutMs: 1000 });
    assert.deepEqual(await rc.request("GET", "/agents"), { ids: [] });
    assert.deepEqual(urls, ["http://127.0.0.1:1111/agents", "http://127.0.0.1:2222/agents"]);
    disco(home, 1111);
    rc.conn = null;
    urls.length = 0;
    await assert.rejects(rc.request("POST", "/agents", {}), { status: 504 });
    assert.equal(urls.length, 1, "non-idempotent request is never retried");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("GET on the same port after a timeout is not retried", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vs-rt-"));
  try {
    disco(home, 1111);
    let n = 0;
    const rc = new RunnerClient({ home, fetchImpl: (u, o) => (n++, hang(u, o)), requestTimeoutMs: 20 });
    await assert.rejects(rc.request("GET", "/agents"), { status: 504 });
    assert.equal(n, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
