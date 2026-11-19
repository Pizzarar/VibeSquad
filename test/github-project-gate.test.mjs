// idea-343: gh-repos / gh-clone use the generic owner gate (vibesquad-api gated(): GET gh-repos is an isGatedRead git path,
// POST gh-clone a write), the same gate runner spawn and every other git route sit behind. An owner on any listener
// (loopback local token, paired LAN device, relay owner device) reaches the handler; read-only, unpaired, revoked, agent
// and cross-site cookie callers do not.
// No test below reaches `gh` or the network: gh-clone sends a bad repo spec, which the handler rejects (400) before any
// runner; gh-repos runs against a middleware whose projects folder does not exist, so the handler answers 500 before `gh`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
// A root with no .git and a home with no projects/ folder: primaryProjectsDir() -> <fakeHome>/projects, which is missing.
const noProjectsRoot = join(home, "no-git-root");
const fakeHome = join(home, "fake-home");
mkdirSync(noProjectsRoot, { recursive: true });
mkdirSync(fakeHome, { recursive: true });

const LAN_HOST = "192.168.1.50:4180";
const AGENT = { id: "agent-gh-test", token: "agent-token-gh-test" };

function call(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    // agent: false = one socket per call, so the "lan" socket address override never leaks into a later request.
    const req = request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => ok({ status: res.statusCode, body: data }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return this.headers[k.toLowerCase()];
    },
    end(b) {
      this.body += b ?? "";
    },
  };
}

/** PC-minted pairing (same fixture as sec-origin-check): the new device's vs_device token and its devices.json id. */
async function pairDevice(name) {
  const before = new Set(auth.listDevices().map((d) => d.id));
  const res = fakeRes();
  const code = auth.createPairCode();
  await auth.handlePairRedeem({ url: `/pair?code=${code}&name=${encodeURIComponent(name)}`, method: "GET", headers: { host: LAN_HOST }, socket: { remoteAddress: "192.168.1.77" }, on() {} }, res);
  assert.equal(res.statusCode, 302, res.body);
  const m = /vs_device=([^;]+)/.exec(String(res.headers["set-cookie"] ?? ""));
  assert.ok(m, "set-cookie carries the device token");
  const id = auth.listDevices().find((d) => !before.has(d.id))?.id;
  assert.ok(id, "the paired device is in devices.json");
  return { token: m[1], id };
}

describe("gh-repos / gh-clone owner gate", () => {
  let srv;
  let port;
  let localToken;
  let device;
  // How the listener presents the next request: "loopback" (as is), "lan" (non-loopback listener + peer, like the
  // TLS LAN/Meshnet listener) or "relay" (req.relayDevice, set by the in-process relay dispatcher in production).
  let mode = "loopback";
  let relayId = null;
  let useNoProjects = false;
  const savedHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };

  before(async () => {
    localToken = auth.getLocalToken();
    device = await pairDevice("Owner Phone");
    const verifyAgent = async ({ id, token }) => {
      if (id === AGENT.id && token === AGENT.token) return { id, role: "worker", lane: "desk", team: "vibesquad" };
      throw Object.assign(new Error("bad agent"), { status: 403 });
    };
    const mw = api.createVibesquadMiddleware(rootDir, { verifyAgent });
    const mwNoProjects = api.createVibesquadMiddleware(noProjectsRoot, { verifyAgent });
    srv = createServer((req, res) => {
      if (mode === "lan") {
        Object.defineProperty(req.socket, "localAddress", { value: "192.168.1.50", configurable: true });
        Object.defineProperty(req.socket, "remoteAddress", { value: "192.168.1.77", configurable: true });
      }
      if (mode === "relay") req.relayDevice = { id: relayId };
      (useNoProjects ? mwNoProjects : mw)(req, res, () => {
        res.statusCode = 404;
        res.end("next");
      });
    });
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    port = srv.address().port;
  });
  after(() => new Promise((ok) => srv.close(ok)));

  async function as(m, fn, id = null) {
    mode = m;
    relayId = id;
    try {
      return await fn();
    } finally {
      mode = "loopback";
      relayId = null;
    }
  }

  const clone = (headers, repo = "-bad") =>
    call(port, "/__vibesquad/git/gh-clone", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ repo }) });

  /** GET gh-repos against the projects-folder-less middleware: reaching the handler is its 500, never a `gh` run. */
  async function repos(headers) {
    useNoProjects = true;
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
    try {
      return await call(port, "/__vibesquad/git/gh-repos", { headers });
    } finally {
      useNoProjects = false;
      for (const [k, v] of Object.entries(savedHome)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  const reachedClone = (r) => {
    assert.equal(r.status, 400, r.body);
    assert.match(JSON.parse(r.body).error, /owner\/repo/, "the handler's own validation error");
  };
  const reachedRepos = (r) => {
    assert.equal(r.status, 500, r.body);
    assert.equal(JSON.parse(r.body).error, "the projects folder was not found");
  };
  const notReached = (r, status) => {
    assert.equal(r.status, status, r.body);
    assert.doesNotMatch(r.body, /owner\/repo|projects folder/, "the handler must not run");
  };

  // ---- (a) owners reach the handler ----
  test("local owner token reaches both handlers", async () => {
    reachedClone(await clone({ "x-vibesquad-token": localToken }));
    reachedRepos(await repos({ "x-vibesquad-token": localToken }));
  });

  test("paired LAN device (vs_device cookie, same-origin) reaches both handlers", async () => {
    const cookie = `vs_device=${device.token}`;
    await as("lan", async () => {
      reachedClone(await clone({ host: LAN_HOST, cookie, origin: `http://${LAN_HOST}` }));
      reachedRepos(await repos({ host: LAN_HOST, cookie }));
    });
  });

  test("relay owner device (req.relayDevice of a paired device) reaches both handlers", async () => {
    await as(
      "relay",
      async () => {
        reachedClone(await clone({}));
        reachedRepos(await repos({}));
      },
      device.id,
    );
  });

  // ---- (b) non-owner remote: there is no paired-guest role (auth.mjs ownerProof: every paired device is the owner), so a
  // non-owner remote caller is an unpaired or revoked device, refused by the trust gate before the route ----
  test("unpaired LAN caller: 401 on both, even with the local token header", async () => {
    await as("lan", async () => {
      notReached(await clone({ host: LAN_HOST, "x-vibesquad-token": localToken }), 401);
      notReached(await repos({ host: LAN_HOST, "x-vibesquad-token": localToken }), 401);
    });
  });

  test("relay device not in devices.json (unpaired / revoked): 401 on both, the local token header is ignored", async () => {
    await as(
      "relay",
      async () => {
        notReached(await clone({ "x-vibesquad-token": localToken }), 401);
        notReached(await repos({ "x-vibesquad-token": localToken }), 401);
      },
      "dev-revoked-or-unknown",
    );
  });

  // ---- (c) no credential ----
  test("loopback without the local token (read-only caller): 403 readOnly on both", async () => {
    const c = await clone({});
    notReached(c, 403);
    assert.equal(JSON.parse(c.body).readOnly, true);
    const r = await repos({});
    notReached(r, 403);
    assert.equal(JSON.parse(r.body).readOnly, true);
  });

  test("bad local token / bad device cookie: 403 on loopback, 401 on LAN", async () => {
    notReached(await clone({ "x-vibesquad-token": "0".repeat(64) }), 403);
    notReached(await repos({ "x-vibesquad-token": "0".repeat(64) }), 403);
    await as("lan", async () => {
      notReached(await clone({ host: LAN_HOST, cookie: "vs_device=not-a-device", origin: `http://${LAN_HOST}` }), 401);
      notReached(await repos({ host: LAN_HOST, cookie: "vs_device=not-a-device" }), 401);
    });
  });

  // ---- (d) agent callers ----
  test("verified agent: 403 on both (not in AGENT_WRITE_ALLOWLIST; gated reads are owner-only), even carrying owner credentials", async () => {
    assert.equal(api.agentWriteAllowed("/__vibesquad/git/gh-clone"), false);
    assert.equal(api.agentWriteAllowed("/__vibesquad/git/gh-repos"), false);
    const agent = { "x-vs-agent-id": AGENT.id, "x-vs-agent-token": AGENT.token };
    for (const extra of [{}, { "x-vibesquad-token": localToken }]) {
      const c = await clone({ ...agent, ...extra });
      notReached(c, 403);
      assert.match(JSON.parse(c.body).error, /agent agent-gh-test may not POST .*owner-only route/);
      const r = await repos({ ...agent, ...extra });
      notReached(r, 403);
      assert.match(JSON.parse(r.body).error, /agent agent-gh-test may not GET .*owner-only route/);
    }
    await as("lan", async () => {
      notReached(await clone({ host: LAN_HOST, cookie: `vs_device=${device.token}`, origin: `http://${LAN_HOST}`, ...agent }), 403);
    });
  });

  test("agent with a wrong token: 403 on both", async () => {
    const bad = { "x-vs-agent-id": AGENT.id, "x-vs-agent-token": "wrong", "x-vibesquad-token": localToken };
    notReached(await clone(bad), 403);
    notReached(await repos(bad), 403);
  });

  // ---- CSRF: the device cookie only authenticates a same-origin write (auth.mjs authenticate -> cookieWriteRefusal) ----
  test("attacker: paired device cookie on a cross-site gh-clone POST is refused before the handler", async () => {
    await as("lan", async () => {
      for (const h of [{ origin: "https://evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }]) {
        const r = await clone({ host: LAN_HOST, cookie: `vs_device=${device.token}`, ...h });
        notReached(r, 403);
        assert.match(JSON.parse(r.body).error, /cross-site request refused/, JSON.stringify(h));
      }
    });
  });

  test("attacker: loopback cross-site POST carrying the real vs_local cookie is not the owner (isLocalBrowserSafe)", async () => {
    const cookie = `vs_local=${createHash("sha256").update(`vs_local-cookie:${localToken}`).digest("hex")}`; // auth.mjs localCookieValue
    const host = `127.0.0.1:${port}`;
    reachedClone(await clone({ host, cookie, origin: `http://${host}`, "user-agent": "Mozilla/5.0" })); // control: same-origin is the owner
    notReached(await clone({ host, cookie, origin: "https://evil.example", "user-agent": "Mozilla/5.0" }), 403);
    notReached(await clone({ host, cookie, "sec-fetch-site": "cross-site", "user-agent": "Mozilla/5.0" }), 403);
  });
});
