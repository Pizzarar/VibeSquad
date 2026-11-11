// unit-and-prove-local (E4b follow-up, Tier A, X1 E4a L3 for every caller): no in-repo caller sends x-vibesquad-token to
// 127.0.0.1:port before the listener proves it holds the token. `vs open`, the worker sweep, `vs pair` and the two MCP
// posts (lead handoff, Buddy restart) all go through fetchWithLocalToken() in server/local-token.mjs, which wraps the
// E4b proveLocalServer(). Threat note: docs/lanes/android-app/E4B_THREAT_NOTE.md (P4, rogue loopback listener).
// Attacker cases are marked "attacker:".
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";

const rootDir = resolve(import.meta.dirname, "..");
// hermetic.mjs gives this process an empty VIBESQUAD_HOME; the token file lands there via auth.getLocalToken().
const home = process.env.VIBESQUAD_HOME;
assert.ok(home, "run with --import ./test/setup/hermetic.mjs");
process.env.PASEO_HOME = join(home, "paseo");
process.env.PASEO_DAEMON = "127.0.0.1:1";
const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
const cli = await import("../cli/vs.mjs");
const localTokenMod = await import("../server/local-token.mjs");
after(() => rmSync(join(home, "paseo"), { recursive: true, force: true }));

const tokenFile = join(home, "local-token");
const token = auth.getLocalToken();
const listen = (server, port = 0) => new Promise((ok) => server.listen(port, "127.0.0.1", () => ok(server.address().port)));
const close = (server) => new Promise((ok) => server.close(ok));

/** attacker: a process that bound the port and answers every request 200 JSON, with a made-up proof. */
function rogueServer(seen) {
  return createServer((req, res) => {
    seen.push({ url: req.url, token: req.headers["x-vibesquad-token"] ?? null });
    res.setHeader("content-type", "application/json");
    res.setHeader("connection", "close"); // no keep-alive pooling across the fake servers a test swaps on one port
    res.end(JSON.stringify({ ok: true, proof: "f".repeat(64), path: "/__vibesquad/local-login?t=" + "0".repeat(32), dryRun: true, count: 0, successorId: "rn-x", newAgentId: "rn-y" }));
  });
}

/** A stand-in that really holds the token: answers the proof correctly and records the order of what it saw. */
function honestServer(seen) {
  return createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    seen.push({ url: req.url, token: req.headers["x-vibesquad-token"] ?? null });
    res.setHeader("content-type", "application/json");
    res.setHeader("connection", "close"); // no keep-alive pooling across the fake servers a test swaps on one port
    if (u.pathname === "/__vibesquad/local-proof") {
      const port = req.socket.localPort;
      return res.end(JSON.stringify({ proof: auth.localProof(token, u.searchParams.get("c"), port), port }));
    }
    res.end(JSON.stringify({ ok: true, path: "/__vibesquad/local-login?t=" + "a".repeat(32), dryRun: true, count: 0, code: "123456", pairUrl: "https://127.0.0.1/pair?code=123456" }));
  });
}

/** The three CLI entry points that carry the token, each as a thunk over a port. */
const callers = {
  "vs open (requestLocalLoginUrl)": (port) => localTokenMod.requestLocalLoginUrl({ port, file: tokenFile }),
  "vs archive --sweep (requestWorkerSweep)": (port) => cli.requestWorkerSweep({ port, file: tokenFile }),
  "vs pair (requestPairStart)": (port) => cli.requestPairStart({ port, file: tokenFile }),
};

describe("every token-bearing caller proves the listener first", () => {
  for (const [name, call] of Object.entries(callers)) {
    test(`attacker: a rogue loopback listener never receives x-vibesquad-token from ${name}`, async () => {
      const seen = [];
      const rogue = rogueServer(seen);
      const port = await listen(rogue);
      try {
        await assert.rejects(call(port), /failed the local-token proof; the local token was not sent/);
      } finally {
        await close(rogue);
      }
      assert.equal(seen.length, 1, "exactly one request went out: the challenge");
      assert.equal(seen[0].token, null, "the challenge carried no token");
      assert.ok(seen[0].url.startsWith("/__vibesquad/local-proof?c="));
      assert.ok(!JSON.stringify(seen).includes(token));
    });

    test(`attacker: a rogue that answers the challenge with a non-JSON 200 / a 404 gets nothing from ${name}`, async () => {
      for (const [status, body] of [[200, "<html>not json</html>"], [404, JSON.stringify({ error: "no such route" })]]) {
        const seen = [];
        const rogue = createServer((req, res) => {
          seen.push(req.headers["x-vibesquad-token"] ?? null);
          res.statusCode = status;
          res.end(body);
        });
        const port = await listen(rogue);
        try {
          await assert.rejects(call(port), /did not prove it is this install's VibeSquad server/);
        } finally {
          await close(rogue);
        }
        assert.deepEqual(seen, [null], `status ${status}: one challenge, no token`);
      }
    });

    test(`${name}: an honest listener gets the challenge first, then exactly one request with the token`, async () => {
      const seen = [];
      const honest = honestServer(seen);
      const port = await listen(honest);
      try {
        await call(port);
      } finally {
        await close(honest);
      }
      assert.equal(seen.length, 2);
      assert.ok(seen[0].url.startsWith("/__vibesquad/local-proof?c="));
      assert.equal(seen[0].token, null, "the challenge never carries the token");
      assert.equal(seen[1].token, token, "the real request carries it");
      assert.ok(!seen[1].url.startsWith("/__vibesquad/local-proof"));
    });

    test(`${name}: nothing listening is a plain "no VibeSquad server" error`, async () => {
      const probe = createServer(() => {});
      const port = await listen(probe);
      await close(probe);
      await assert.rejects(call(port), new RegExp(`no VibeSquad server on 127\\.0\\.0\\.1:${port}`));
    });
  }

  test("attacker: a rogue that relays the challenge to the real server on another port fails for the sweep and vs open (proof is port-bound)", async () => {
    const real = createServer(api.createVibesquadMiddleware(rootDir));
    const realPort = await listen(real);
    const seen = [];
    const relay = createServer((req, res) => {
      seen.push(req.headers["x-vibesquad-token"] ?? null);
      const up = request({ host: "127.0.0.1", port: realPort, path: req.url, method: req.method, headers: { host: `127.0.0.1:${realPort}` } }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      req.pipe(up);
    });
    const relayPort = await listen(relay);
    try {
      await assert.rejects(cli.requestWorkerSweep({ port: relayPort, file: tokenFile }), /failed the local-token proof/);
      await assert.rejects(localTokenMod.requestLocalLoginUrl({ port: relayPort, file: tokenFile }), /failed the local-token proof/);
      assert.ok(seen.length >= 2 && seen.every((t) => t === null), "the relay never saw the token");
      // the real server, addressed directly, proves itself: vs open gets a nonce URL that never contains the token
      const url = await localTokenMod.requestLocalLoginUrl({ port: realPort, file: tokenFile });
      assert.match(url, new RegExp(`^http://localhost:${realPort}/__vibesquad/local-login\\?t=[0-9a-f]{32}$`));
      assert.ok(!url.includes(token));
      // ...and the sweep passes the auth gate (whatever the hook host answers in this process, it is never a 403 or a proof error)
      const sweep = await cli.requestWorkerSweep({ port: realPort, file: tokenFile }).then(() => "ok", (e) => e.message);
      assert.ok(sweep === "ok" || (/^sweep refused \(/.test(sweep) && !/\(403\)/.test(sweep)), sweep);
    } finally {
      await close(relay);
      await close(real);
    }
  });
});

describe("fetchWithLocalToken: the shared helper", () => {
  test("no proof cache: a rogue that takes the port over between two calls in one process never sees the token", async () => {
    const seenHonest = [];
    const honest = honestServer(seenHonest);
    const port = await listen(honest);
    await cli.requestWorkerSweep({ port, file: tokenFile });
    assert.equal(seenHonest.filter((s) => s.token === token).length, 1);
    await close(honest);
    const seenRogue = [];
    const rogue = rogueServer(seenRogue);
    assert.equal(await listen(rogue, port), port, "the rogue got the same port");
    try {
      await assert.rejects(cli.requestWorkerSweep({ port, file: tokenFile }), /failed the local-token proof/);
    } finally {
      await close(rogue);
    }
    assert.ok(seenRogue.every((s) => s.token === null), "the second call proved again and sent nothing to the rogue");
  });

  test("fails closed before any fetch when there is no token, unless tokenOptional (the MCP mode sends the bare request, no secret involved)", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => (calls.push({ url, headers: init.headers }), { ok: true, status: 200, json: async () => ({}) });
    const missing = join(home, "no-such-token");
    await assert.rejects(localTokenMod.fetchWithLocalToken("/__vibesquad/x", { port: 1, file: missing, fetchImpl }), /no local token at/);
    assert.equal(calls.length, 0);
    await localTokenMod.fetchWithLocalToken("/__vibesquad/x", { port: 1, file: missing, fetchImpl, tokenOptional: true });
    assert.equal(calls.length, 1, "no proof round trip without a token");
    assert.equal(calls[0].headers["x-vibesquad-token"], undefined);
    // a malformed token file counts as no token: nothing worth proving, nothing sent
    const bad = join(home, "bad-token");
    writeFileSync(bad, "not-a-token\n");
    await assert.rejects(localTokenMod.fetchWithLocalToken("/__vibesquad/x", { port: 1, file: bad, fetchImpl }), /no local token at/);
    assert.equal(calls.length, 1);
    await assert.rejects(localTokenMod.fetchWithLocalToken("__vibesquad/x", { port: 1, file: tokenFile, fetchImpl }), /path must start with/);
  });

  test("with tokenOptional and a token present, the proof is still mandatory (the MCP callers cannot skip it)", async () => {
    const seen = [];
    const rogue = rogueServer(seen);
    const port = await listen(rogue);
    try {
      const err = await localTokenMod.fetchWithLocalToken("/__vibesquad/lead-handoff", { method: "POST", port, file: tokenFile, tokenOptional: true }).catch((e) => e);
      assert.match(err.message, /failed the local-token proof/);
      assert.equal(err.proofFailed, true, "a failed proof is tagged so handoff never mistakes it for 'server down' and runs in-process");
      assert.equal(err.unreachable, undefined);
    } finally {
      await close(rogue);
    }
    assert.deepEqual(seen.map((s) => s.token), [null]);
    const probe = createServer(() => {});
    const dead = await listen(probe);
    await close(probe);
    const err = await localTokenMod.fetchWithLocalToken("/__vibesquad/lead-handoff", { method: "POST", port: dead, file: tokenFile, tokenOptional: true }).catch((e) => e);
    assert.equal(err.unreachable, true, "nothing listening is the in-process fallback case");
    assert.equal(err.proofFailed, undefined);
  });

  test("the fetch after the proof carries the token, the caller's headers, method and body, and connection failures are `unreachable`", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const u = new URL(url);
      calls.push({ url, init });
      if (u.pathname === "/__vibesquad/local-proof") return { ok: true, status: 200, json: async () => ({ proof: auth.localProof(token, u.searchParams.get("c"), 7), port: 7 }) };
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
    };
    const err = await localTokenMod.fetchWithLocalToken("/__vibesquad/runner/sweep", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", port: 7, file: tokenFile, fetchImpl }).catch((e) => e);
    assert.match(err.message, /no VibeSquad server on 127\.0\.0\.1:7 \(ECONNRESET\)/);
    assert.equal(err.unreachable, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].init.headers, undefined, "challenge: no headers at all");
    assert.equal(calls[1].url, "http://127.0.0.1:7/__vibesquad/runner/sweep");
    assert.equal(calls[1].init.method, "POST");
    assert.equal(calls[1].init.body, "{}");
    assert.deepEqual(calls[1].init.headers, { "content-type": "application/json", "x-vibesquad-token": token });
  });
});

describe("source guard: the header is minted in one place", () => {
  const walk = (dir) =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (n === "node_modules" || n === "dist") return [];
      return statSync(p).isDirectory() ? walk(p) : /\.(mjs|js|ts|tsx)$/.test(n) ? [p] : [];
    });
  const emits = /\[LOCAL_TOKEN_HEADER\]\s*:|localTokenHeaders\(|["']x-vibesquad-token["']\s*:/;

  test("cli/ and server/ emit x-vibesquad-token only inside server/local-token.mjs (fetchWithLocalToken + the exported out-of-repo helper)", () => {
    const offenders = [];
    for (const f of [...walk(join(rootDir, "cli")), ...walk(join(rootDir, "server"))]) {
      if (f.endsWith(join("server", "local-token.mjs"))) continue;
      const src = readFileSync(f, "utf8");
      src.split("\n").forEach((line, i) => {
        if (emits.test(line)) offenders.push(`${f.slice(rootDir.length + 1)}:${i + 1}`);
      });
    }
    assert.deepEqual(offenders, [], "send the token through fetchWithLocalToken() (server/local-token.mjs), never by hand");
  });

  test("the five known callers use the helper; the MCP posts keep a failed proof out of the in-process fallback", () => {
    const vs = readFileSync(join(rootDir, "cli", "vs.mjs"), "utf8");
    const tools = readFileSync(join(rootDir, "server", "mcp", "tools.mjs"), "utf8");
    const lt = readFileSync(join(rootDir, "server", "local-token.mjs"), "utf8");
    const fn = (src, start, end) => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));
    for (const [src, start, end] of [
      [vs, "export async function requestWorkerSweep(", "export async function commandAgentVerb("],
      [vs, "export async function requestPairStart(", "async function commandPair("],
      [lt, "export async function requestLocalLoginUrl(", "export async function proveLocalServer("],
      [tools, "async function postLeadHandoffToServer(", "\n}\n"],
      [tools, "async function postBuddyRestartToServer(", "\n}\n"],
    ]) {
      const body = fn(src, start, end);
      assert.ok(body.length > 0, start);
      assert.ok(body.includes("await fetchWithLocalToken("), `${start} goes through the helper`);
      assert.ok(!body.includes("readLocalToken(") && !body.includes("localTokenHeaders("), `${start} never reads the token itself`);
    }
    for (const start of ["async function postLeadHandoffToServer(", "async function postBuddyRestartToServer("]) {
      assert.ok(fn(tools, start, "\n}\n").includes("if (e?.proofFailed) throw e;"), `${start}: a failed proof is never 'unreachable'`);
    }
    assert.ok(/async function commandOpen\(flags\) \{\s*const url = await requestLocalLoginUrl\(/.test(vs), "vs open goes through requestLocalLoginUrl");
    assert.ok(vs.indexOf("export async function proveLocalServer") === -1 && !vs.includes("proveLocalServer("), "cli/vs.mjs no longer calls the proof by hand (one wrapper, not two patterns)");
  });
});
