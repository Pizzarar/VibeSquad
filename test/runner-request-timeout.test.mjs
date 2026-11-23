// RunnerClient.request must never hang: a hung runner times out, a dead/moved one drops the stale conn, and an idempotent GET
// retries once against the re-discovered port.
import "./helpers/clean-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerClient } from "../server/backend/runner-client.mjs";
import "./helpers/keep-alive.mjs";

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

// idea-409: a pooled keep-alive socket the runner closed under load (verdict-gate 504 flake) is not a hung runner.
const reset = (code) => { throw new TypeError("fetch failed", { cause: { code } }); };

test("GET on the same port retries once after a keep-alive reset (ECONNRESET / UND_ERR_SOCKET); POST does not", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vs-rt-"));
  try {
    disco(home, 1111);
    for (const code of ["ECONNRESET", "UND_ERR_SOCKET"]) {
      let n = 0;
      const rc = new RunnerClient({ home, fetchImpl: async () => (++n === 1 ? reset(code) : ok({ ids: [code] })), requestTimeoutMs: 1000 });
      assert.deepEqual(await rc.request("GET", "/agents"), { ids: [code] });
      assert.equal(n, 2, `${code}: one retry on the same port`);
      assert.equal(rc.conn.port, 1111);
    }
    // Reset twice: the retry is single, the second error surfaces.
    let n = 0;
    const twice = new RunnerClient({ home, fetchImpl: async () => { n++; reset("ECONNRESET"); }, requestTimeoutMs: 1000 });
    await assert.rejects(twice.request("GET", "/agents"), (e) => e.status === 504 && e.transport && /ECONNRESET/.test(e.message));
    assert.equal(n, 2);
    // A write the reset may have reached is never resent.
    let posts = 0;
    const write = new RunnerClient({ home, fetchImpl: async () => { posts++; reset("ECONNRESET"); }, requestTimeoutMs: 1000 });
    await assert.rejects(write.request("POST", "/agents/a/input", {}), { status: 504 });
    assert.equal(posts, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("GET on the same port is not retried on a refused connect (the runner is down, not a dropped socket)", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vs-rt-"));
  try {
    disco(home, 1111);
    let n = 0;
    const rc = new RunnerClient({ home, fetchImpl: async () => { n++; reset("ECONNREFUSED"); }, requestTimeoutMs: 1000 });
    await assert.rejects(rc.request("GET", "/agents"), { status: 504 });
    assert.equal(n, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

const hangUnlessHealth = (healthOk) => (url, { signal } = {}) => {
  if (url.endsWith("/health")) return healthOk ? Promise.resolve(ok({ ok: true })) : Promise.reject(new Error("ECONNREFUSED"));
  return new Promise((res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
};

test("queued input on a healthy runner is not aborted at the base timeout", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vs-rt-"));
  try {
    disco(home, 1111);
    let settle;
    const fetchImpl = (url, o) => url.endsWith("/health") ? Promise.resolve(ok({ ok: true })) : new Promise((r) => { settle = () => r(ok({ ok: true })); o.signal.addEventListener("abort", () => r(Promise.reject(new Error("aborted")))); });
    const rc = new RunnerClient({ home, fetchImpl, requestTimeoutMs: 20, queueMs: 1000 });
    const p = rc.request("POST", "/agents/a1/input", { text: "hi" });
    await new Promise((r) => setTimeout(r, 120)); // several base timeouts later
    settle();
    assert.deepEqual(await p, { ok: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("queued create/input on an unhealthy runner aborts with 'runner not responding'", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vs-rt-"));
  try {
    disco(home, 1111);
    const rc = new RunnerClient({ home, fetchImpl: hangUnlessHealth(false), requestTimeoutMs: 20, queueMs: 1000 });
    await assert.rejects(rc.request("POST", "/agents", {}), (e) => e.status === 504 && /runner not responding/.test(e.message));
    assert.equal(rc.conn, null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("queued request is bounded by queueMs + base timeout even when healthy", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "vs-rt-"));
  try {
    disco(home, 1111);
    const rc = new RunnerClient({ home, fetchImpl: hangUnlessHealth(true), requestTimeoutMs: 20, queueMs: 60 });
    await assert.rejects(rc.request("POST", "/agents/a/input", {}), { status: 504 });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
