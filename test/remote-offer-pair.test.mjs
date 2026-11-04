// Block 5a: `#offer=` pairing — never bake the build machine's server-id into dist/; the daemon password
// rides in a one-shot `?pw=` query param from /__desktop/setup and is consumed, saved and stripped.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  REMOTE_PASSWORD_KEY,
  REMOTE_TAB_PASSWORD_KEY,
  canonicalOfferUrl,
  consumeUrlOfferSession,
  detectRemote,
  hasOfferFragment,
  offerFromHash,
  readPassword,
  readSession,
  stripPwFromUrl,
  stripRemoteFromUrl,
} from "../src/remoteSession.ts";

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
  serverId: "srv_project123",
  daemonPublicKeyB64: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  relay: { endpoint: "relay.paseo.sh:443", useTls: true },
};
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const OFFER_HASH = `#offer=${b64url(OFFER)}`;

describe("build never bakes the build machine's server-id", () => {
  test("vite.config.ts defines __PASEO_SERVER_ID__ as the empty string", () => {
    const cfg = read("vite.config.ts");
    assert.match(cfg, /__PASEO_SERVER_ID__:\s*JSON\.stringify\(""\)/);
    assert.doesNotMatch(cfg, /JSON\.stringify\(isRemoteBuild\s*\?\s*""\s*:\s*paseo\.serverId\)/);
  });

  test("detectRemote on localhost with ?remote=1#offer=… is remote when localServerId is unset (BUILD_SERVER_ID is \"\")", () => {
    const base = { search: "?remote=1", hash: OFFER_HASH, storage: mem(), buildFlag: false };
    for (const hostname of ["localhost", "127.0.0.1", "tauri.localhost"]) {
      assert.equal(detectRemote({ ...base, hostname }), true, hostname);
    }
    // The inverse: if the build DID bake its own server-id and the offer matched it, it would be treated as local.
    assert.equal(detectRemote({ ...base, hostname: "localhost", localServerId: OFFER.serverId }), false);
  });
});

describe("URL helpers strip the remote/pw params correctly", () => {
  test("stripRemoteFromUrl strips both remote and pw query params", () => {
    assert.equal(stripRemoteFromUrl({ pathname: "/", search: "?remote=1&pw=secret&team=a", hash: "" }), "/?team=a");
    assert.equal(stripRemoteFromUrl({ pathname: "/", search: "?remote=1&pw=secret", hash: "#offer=x" }), "/");
    assert.equal(stripRemoteFromUrl({ pathname: "/", search: "?pw=secret", hash: "" }), "/");
  });

  test("stripPwFromUrl keeps ?remote=1 and the #offer= fragment", () => {
    assert.equal(stripPwFromUrl({ pathname: "/", search: "?remote=1&pw=secret", hash: OFFER_HASH }), `/?remote=1${OFFER_HASH}`);
    assert.equal(stripPwFromUrl({ pathname: "/", search: "?pw=secret", hash: "" }), "/");
  });
});

describe("consumeUrlOfferSession parks the inline password (never the session)", () => {
  test("with a valid #offer= it parks the password in the tab and does NOT save the session yet", () => {
    const local = mem();
    const tab = mem();
    consumeUrlOfferSession({ search: `?remote=1&pw=${encodeURIComponent("hunter2")}`, hash: OFFER_HASH }, local, tab);
    assert.equal(readPassword(local, tab), "hunter2");
    assert.equal(readSession(local), null, "offer must not be saved before a successful probe (avoids a second relay client)");
    assert.equal(local.getItem(REMOTE_PASSWORD_KEY), null, "not remembered");
    assert.equal(tab.getItem(REMOTE_TAB_PASSWORD_KEY), "hunter2");
  });

  test("without a valid offer it still parks the password in the tab key", () => {
    const local = mem();
    const tab = mem();
    consumeUrlOfferSession({ search: "?pw=hunter2", hash: "" }, local, tab);
    assert.equal(tab.getItem(REMOTE_TAB_PASSWORD_KEY), "hunter2");
    assert.equal(readPassword(local, tab), "hunter2");
  });

  test("empty pw is a no-op", () => {
    const local = mem();
    const tab = mem();
    consumeUrlOfferSession({ search: "?remote=1", hash: OFFER_HASH }, local, tab);
    assert.equal(readPassword(local, tab), "");
  });

  test("offerFromHash parses the setup fragment", () => {
    assert.equal(hasOfferFragment(OFFER_HASH), true);
    assert.equal(offerFromHash(OFFER_HASH).serverId, OFFER.serverId);
  });
});

describe("canonical pairing link display", () => {
  test("canonicalOfferUrl rebuilds the app.paseo.sh link from the fragment", () => {
    assert.equal(canonicalOfferUrl(OFFER_HASH), `https://app.paseo.sh/${OFFER_HASH}`);
  });

  test("RemotePair.tsx shows the canonical link, never location.href", () => {
    const src = read("src/RemotePair.tsx");
    assert.match(src, /return hasOfferFragment\(location\.hash\) \? canonicalOfferUrl\(location\.hash\) : "";/);
    assert.doesNotMatch(src, /hasOfferFragment\(location\.hash\) \? location\.href/);
  });
});

describe("single relay client per page (no clientId collision)", () => {
  test("probeRemote uses a unique clientId so it never fights remoteDaemonClient", () => {
    const src = read("src/paseoRemote.ts");
    assert.match(src, /relayConfig\(offer, password, "vibesquad-remote-probe"\)/);
    assert.match(src, /function relayConfig\(offer: RemoteOffer, password: string, clientId = "vibesquad-remote"\)/);
  });
});

describe("self-relay guard only fires when the local daemon is actually running", () => {
  test("remoteBoot.ts wipes the session only when /paseo/status reports running", () => {
    const src = read("src/remoteBoot.ts");
    assert.match(src, /j\.running && typeof j\.serverId === "string" && j\.serverId === target\.serverId/);
  });
});

describe("RemotePair.tsx prefills the password and always shows the field", () => {
  test("password initializes from ?pw= or readPassword(), and strips pw from the URL", () => {
    const src = read("src/RemotePair.tsx");
    assert.match(src, /new URLSearchParams\(location\.search\)/);
    assert.match(src, /get\("pw"\)/);
    assert.match(src, /pw \|\| readPassword\(\)/);
    assert.match(src, /history\.replaceState\(null, ""/);
  });

  test("always renders the password input alongside the pairing link input", () => {
    const src = read("src/RemotePair.tsx");
    assert.match(src, /data-testid="remote-pair-password"/);
    assert.match(src, /type="password"/);
    assert.match(src, /data-testid="remote-pair-paste"/);
  });

  test("auto-connects when an offer and an inline password arrive together", () => {
    const src = read("src/RemotePair.tsx");
    assert.match(src, /autoConnectRef/);
    assert.match(src, /hasOfferFragment\(location\.hash\)/);
    assert.match(src, /void doConnect\(\)/);
  });
});
