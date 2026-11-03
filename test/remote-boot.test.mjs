// Block R2-2: remote boot pure logic (src/remoteSession.ts) + wiring guards for paseo.ts / main.tsx / RemotePair.tsx.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import {
  REMOTE_AUTH_NOTE_KEY,
  REMOTE_PASSWORD_KEY,
  REMOTE_SESSION_KEY,
  REMOTE_TAB_PASSWORD_KEY,
  clearSession,
  detectRemote,
  hasOfferFragment,
  isLocalHost,
  isPasswordRemembered,
  mapRemoteError,
  needsPairing,
  normalizeOfferInput,
  noteAuthFailure,
  parseOfferInput,
  peekAuthNote,
  readPassword,
  readSession,
  relayParts,
  saveSession,
  takeAuthNote,
} from "../src/remoteSession.ts";
import { remoteInvoke, remoteShimInstalled, whenConnected } from "../src/remoteBoot.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function mem() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const OFFER = {
  v: 2,
  serverId: "srv_test123",
  daemonPublicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  relay: { endpoint: "relay.paseo.sh:443", useTls: true },
};
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const LINK = `https://app.paseo.sh/#offer=${b64url(OFFER)}`;

describe("remote mode detection", () => {
  const base = { search: "", hash: "", storage: mem(), buildFlag: false };
  test("desktop/local default is off", () => {
    assert.equal(detectRemote(base), false);
    assert.equal(detectRemote({ ...base, storage: null }), false);
    assert.equal(detectRemote({ ...base, search: "?demo&remote=0" }), false);
  });
  test("build flag, ?remote=1, #offer= fragment, stored session and R2-1 flag each turn it on", () => {
    assert.equal(detectRemote({ ...base, buildFlag: true }), true);
    assert.equal(detectRemote({ ...base, search: "?remote=1" }), true);
    assert.equal(detectRemote({ ...base, hash: "#offer=abc" }), true);
    const s1 = mem();
    s1.setItem(REMOTE_SESSION_KEY, "{}");
    assert.equal(detectRemote({ ...base, storage: s1 }), true);
    const s2 = mem();
    s2.setItem("vs.remote", "1");
    assert.equal(detectRemote({ ...base, storage: s2 }), true);
  });
  test("throwing storage reads as off", () => {
    const bad = { getItem: () => { throw new Error("denied"); } };
    assert.equal(detectRemote({ ...base, storage: bad }), false);
  });
  test("local origins ignore #offer=, stored session, and stored flag unless ?remote=1 or buildFlag", () => {
    for (const h of ["127.0.0.1", "localhost", "LOCALHOST", "::1", "[::1]", "tauri.localhost", "dev.localhost"]) {
      assert.equal(isLocalHost(h), true, h);
    }
    for (const h of ["", "app.paseo.sh", "192.168.1.20"]) {
      assert.equal(isLocalHost(h), false, h);
    }
    const sSession = mem();
    sSession.setItem(REMOTE_SESSION_KEY, "{}");
    const sFlag = mem();
    sFlag.setItem("vs.remote", "1");
    for (const hostname of ["127.0.0.1", "localhost", "tauri.localhost"]) {
      assert.equal(detectRemote({ ...base, hostname, hash: "#offer=abc" }), false, `${hostname} #offer`);
      assert.equal(detectRemote({ ...base, hostname, storage: sSession }), false, `${hostname} storedSession`);
      assert.equal(detectRemote({ ...base, hostname, storage: sFlag }), false, `${hostname} storedFlag`);
      assert.equal(detectRemote({ ...base, hostname, search: "?remote=1" }), true, `${hostname} ?remote=1`);
      assert.equal(detectRemote({ ...base, hostname, buildFlag: true }), true, `${hostname} buildFlag`);
    }
  });
  test("offer fragment matcher", () => {
    assert.equal(hasOfferFragment("#offer=x"), true);
    assert.equal(hasOfferFragment("#a=1&offer=x"), true);
    assert.equal(hasOfferFragment("#nooffer=x"), false);
    assert.equal(hasOfferFragment(""), false);
  });
});

describe("offer input parsing", () => {
  test("normalizes full link, fragment, bare offer=", () => {
    assert.equal(normalizeOfferInput(`  ${LINK}\n`), `#offer=${b64url(OFFER)}`);
    assert.equal(normalizeOfferInput("#offer=abc"), "#offer=abc");
    assert.equal(normalizeOfferInput("offer=abc"), "#offer=abc");
    assert.equal(normalizeOfferInput("https://x/?offer=abc"), "#offer=abc");
    assert.equal(normalizeOfferInput("https://app.paseo.sh/"), null);
    assert.equal(normalizeOfferInput("   "), null);
  });
  test("real parser accepts a valid link", () => {
    const r = parseOfferInput(LINK, parseConnectionOfferFromUrl);
    assert.equal(r.ok, true);
    assert.deepEqual(r.offer, OFFER);
  });
  test("bad links map to bad-link without throwing", () => {
    for (const input of ["", "hello", "#offer=!!!", `#offer=${b64url({ v: 1, serverId: "x" })}`, `#offer=${b64url({ ...OFFER, serverId: "" })}`]) {
      const r = parseOfferInput(input, parseConnectionOfferFromUrl);
      assert.equal(r.ok, false, input);
      assert.equal(r.error.kind, "bad-link");
    }
  });
  test("a parser returning a non-offer is rejected", () => {
    assert.equal(parseOfferInput("#offer=x", () => ({ v: 2 })).ok, false);
    assert.equal(parseOfferInput("#offer=x", () => null).ok, false);
  });
});

describe("stored session", () => {
  test("round trip keeps only offer fields", () => {
    const local = mem();
    const tab = mem();
    saveSession({ ...OFFER, extra: "drop", minimumSecurityMode: "protected" }, "", false, local, tab);
    const s = readSession(local);
    assert.equal(s.v, 1);
    assert.deepEqual(s.offer, { ...OFFER, minimumSecurityMode: "protected" });
    assert.ok(!Number.isNaN(Date.parse(s.savedAt)));
  });
  test("malformed or tampered sessions are not trusted", () => {
    const local = mem();
    for (const raw of ["not json", "{}", JSON.stringify({ v: 1, offer: { ...OFFER, v: 1 }, savedAt: "x" }), JSON.stringify({ v: 2, offer: OFFER, savedAt: "x" })]) {
      local.setItem(REMOTE_SESSION_KEY, raw);
      assert.equal(readSession(local), null, raw);
    }
    assert.equal(readSession(null), null);
  });
  test("password is persisted only with the remember opt-in", () => {
    const local = mem();
    const tab = mem();
    saveSession(OFFER, "pw1", false, local, tab);
    assert.equal(local.getItem(REMOTE_PASSWORD_KEY), null);
    assert.equal(tab.getItem(REMOTE_TAB_PASSWORD_KEY), "pw1");
    assert.equal(readPassword(local, tab), "pw1");
    assert.equal(isPasswordRemembered(local), false);
    assert.ok(!local.m.get(REMOTE_SESSION_KEY).includes("pw1"), "password never in the session blob");

    saveSession(OFFER, "pw2", true, local, tab);
    assert.equal(local.getItem(REMOTE_PASSWORD_KEY), "pw2");
    assert.equal(tab.getItem(REMOTE_TAB_PASSWORD_KEY), null);
    assert.equal(isPasswordRemembered(local), true);

    saveSession(OFFER, "pw3", false, local, tab); // un-remember wipes the stored one
    assert.equal(local.getItem(REMOTE_PASSWORD_KEY), null);
    assert.equal(readPassword(local, tab), "pw3");

    saveSession(OFFER, "", true, local, tab);
    assert.equal(readPassword(local, tab), "");
  });
  test("clearSession forgets everything", () => {
    const local = mem();
    const tab = mem();
    saveSession(OFFER, "pw", true, local, tab);
    clearSession(local, tab);
    assert.equal(readSession(local), null);
    assert.equal(readPassword(local, tab), "");
  });
  test("auth failure drops the password, keeps the offer, and routes back to pairing once", () => {
    const local = mem();
    const tab = mem();
    saveSession(OFFER, "pw", true, local, tab);
    assert.equal(needsPairing(true, "", local, tab), false);
    noteAuthFailure("wrong-password", local, tab);
    assert.ok(readSession(local));
    assert.equal(readPassword(local, tab), "");
    assert.equal(peekAuthNote(tab), "wrong-password");
    assert.equal(needsPairing(true, "", local, tab), true);
    assert.equal(takeAuthNote(tab), "wrong-password");
    assert.equal(tab.getItem(REMOTE_AUTH_NOTE_KEY), null);
    assert.equal(needsPairing(true, "", local, tab), false);
  });
  test("needsPairing: never when not remote; when unpaired or a new link is opened", () => {
    const local = mem();
    const tab = mem();
    assert.equal(needsPairing(false, "#offer=x", local, tab), false);
    assert.equal(needsPairing(true, "", local, tab), true);
    saveSession(OFFER, "", false, local, tab);
    assert.equal(needsPairing(true, "", local, tab), false);
    assert.equal(needsPairing(true, "#offer=new", local, tab), true);
  });
  test("saveSession without localStorage throws a clear error", () => {
    assert.throws(() => saveSession(OFFER, "", false, null, mem()), /localStorage/);
  });
});

describe("relay parts", () => {
  test("explicit useTls wins; default on for :443 and paseo.sh", () => {
    assert.deepEqual(relayParts(OFFER), { endpoint: "relay.paseo.sh:443", useTls: true, serverId: "srv_test123" });
    assert.equal(relayParts({ ...OFFER, relay: { endpoint: "relay.paseo.sh:443", useTls: false } }).useTls, false);
    assert.equal(relayParts({ ...OFFER, relay: { endpoint: "relay.paseo.sh" } }).useTls, true);
    assert.equal(relayParts({ ...OFFER, relay: { endpoint: "10.0.0.2:8080" } }).useTls, false);
  });
});

describe("error mapping", () => {
  const kind = (e) => mapRemoteError(e).kind;
  test("auth failures", () => {
    assert.equal(kind(Object.assign(new Error("Password required"), { name: "DaemonAuthenticationError", reason: "password_required" })), "password-required");
    assert.equal(kind(Object.assign(new Error("Incorrect password"), { reason: "incorrect_password" })), "wrong-password");
    assert.equal(kind("Password required"), "password-required");
  });
  test("vs.http gate off", () => {
    assert.equal(kind(new Error('vs.http: remote access is off (set "remote": { "enabled": true } in ~/.vibesquad/settings.json)')), "remote-off");
  });
  test("relay/transport failures and timeouts", () => {
    assert.equal(kind(new Error("Transport disconnected before connect")), "relay-unreachable");
    assert.equal(kind(new Error("WebSocket error")), "relay-unreachable");
    assert.equal(kind(Object.assign(new Error("x"), { name: "TimeoutError" })), "timeout");
    assert.equal(kind(new Error("Connection timed out")), "timeout");
  });
  test("unknown keeps the raw message for debugging", () => {
    const e = mapRemoteError(new Error("weird thing"));
    assert.equal(e.kind, "unknown");
    assert.match(e.message, /weird thing/);
    assert.equal(mapRemoteError(null).kind, "unknown");
  });
});

describe("wiring guards", () => {
  test("paseo.ts: only the client construction gains a remote branch; local config unchanged", () => {
    const src = read("src/paseo.ts");
    assert.match(src, /export const daemonClient =\s*remoteDaemonClient\(\) \?\?\s*new DaemonClient\(\{\s*url: WS_URL,\s*clientId: "vibesquad",/);
    assert.equal((src.match(/paseoRemote/g) ?? []).length, 2, "one import + one comment mention");
  });
  test("main.tsx: remoteBoot is the first import; pairing screen boots without start()", () => {
    const src = read("src/main.tsx");
    assert.match(src, /^import \{ remoteShimInstalled, bindRemoteClient \} from "\.\/remoteBoot";/);
    assert.match(src, /const pair = !cast && !five && needsRemotePairing\(\);/);
    assert.match(src, /if \(!cast && !five && !pair\) \{/);
    assert.match(src, /if \(remoteShimInstalled\) bindRemoteClient\(daemonClient\);/);
    assert.match(src, /pair \? <RemotePair \/>/);
  });
  test("remoteBoot.ts installs the shim only for a paired remote page", () => {
    const src = read("src/remoteBoot.ts");
    assert.match(src, /export const remoteShimInstalled = isRemote\(\) && !needsPairing\(true, location\.hash\);/);
    assert.match(src, /if \(remoteShimInstalled\) installRemoteTransport\(remoteInvoke\(bound\)\);/);
    assert.doesNotMatch(src, /from "\.\/paseo"/);
    assert.equal(remoteShimInstalled, false, "node/local: not installed");
  });
  test("RemotePair.tsx does not import paseo.ts (it builds the daemon client on load)", () => {
    const src = read("src/RemotePair.tsx");
    assert.doesNotMatch(src, /from "\.\/paseo"/);
    assert.match(src, /parseConnectionOfferFromUrl/);
    assert.match(src, /location\.replace\(location\.pathname \+ location\.search\)/, "fragment dropped after pairing");
    assert.match(src, /data-testid="remote-pair-forget"/, "forget button wired");
    assert.match(src, /clearSession\(\)/, "clearSession called on forget");
  });
  test("paseoRemote.ts: relay URL + e2ee from the offer", () => {
    const src = read("src/paseoRemote.ts");
    assert.match(src, /buildRelayWebSocketUrl\(\{ endpoint, useTls, serverId, role: "client", version: 2 \}\)/);
    assert.match(src, /e2ee: \{\s*enabled: true,\s*daemonPublicKeyB64: offer\.daemonPublicKeyB64/);
  });
});

describe("remote shim invoke waits for the relay connection", () => {
  function fakeClient(status = "connecting", extra = {}) {
    const ls = new Set();
    const calls = [];
    let state = { status, ...extra };
    return {
      calls,
      setStatus(st, details = {}) { state = { status: st, ...details }; for (const l of [...ls]) l(state); },
      getConnectionState: () => state,
      subscribeConnectionStatus: (l) => (ls.add(l), () => ls.delete(l)),
      invokePluginRpc: async (pluginId, method, input) => (calls.push({ pluginId, method, input }), { status: 200, headers: {}, body: "{}" }),
      listeners: ls,
    };
  }
  test("connected: resolves at once", async () => {
    await whenConnected(fakeClient("connected"), 50);
  });
  test("waits for connected across retryable disconnects, then unsubscribes", async () => {
    const c = fakeClient();
    const p = whenConnected(c, 1000);
    c.setStatus("disconnected", { nextRetryAt: "2026-01-01T00:00:00.000Z" });
    c.setStatus("connected");
    await p;
    assert.equal(c.listeners.size, 0);
  });
  test("rejects immediately when state transitions to disposed or terminal disconnected", async () => {
    const c1 = fakeClient();
    const p1 = whenConnected(c1, 10_000);
    c1.setStatus("disposed");
    await assert.rejects(p1, /Relay disconnected: disposed/);
    assert.equal(c1.listeners.size, 0);

    const c2 = fakeClient();
    const p2 = whenConnected(c2, 10_000);
    c2.setStatus("disconnected", { reason: "Password required" });
    await assert.rejects(p2, /Relay disconnected: Password required/);
    assert.equal(c2.listeners.size, 0);

    await assert.rejects(whenConnected(fakeClient("disposed"), 10_000), /Relay disconnected: disposed/);
  });
  test("times out and unsubscribes", async () => {
    const c = fakeClient();
    await assert.rejects(whenConnected(c, 20), /timed out/);
    assert.equal(c.listeners.size, 0);
  });
  test("invoke holds calls until the client is bound and connected, then calls vibesquad/vs.http", async () => {
    const c = fakeClient();
    let bindIt;
    const invoke = remoteInvoke(new Promise((r) => (bindIt = r)), 1000);
    const p = invoke({ method: "GET", path: "/api/teams" });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(c.calls.length, 0);
    bindIt(c);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(c.calls.length, 0);
    c.setStatus("connected");
    const out = await p;
    assert.equal(out.status, 200);
    assert.deepEqual(c.calls, [{ pluginId: "vibesquad", method: "vs.http", input: { method: "GET", path: "/api/teams" } }]);
  });
});
