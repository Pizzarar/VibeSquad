// Block A2 (PLAN_ANDROID_MESHNET.md): the APK trusts the paired PC's VS CA, for that host only.
// - pairing links carry the CA SHA-256 (server/auth.mjs pairFpQuery) and the app parses it (src/remoteSession.ts)
// - the web side of the native pin bridge (src/vsTrust.ts), the Kotlin guards (src-tauri/android/VsTrust.kt),
//   and the build hooks (server/build-android.mjs) that wire it into the generated Android project
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "vs-trust-"));
process.env.VIBESQUAD_HOME = home;
process.env.VIBESQUAD_LAN_IP = "192.168.1.20";
process.env.VIBESQUAD_MESHNET_IP = "100.64.0.7";

const auth = await import("../server/auth.mjs");
const { normalizeFp, parsePairInput, toAndroidDeepLink } = await import("../src/remoteSession.ts");
const { createTrustClient, flushCookies, nativeTrust } = await import("../src/vsTrust.ts");
const { ensureAndroidTrustKotlin } = await import("../server/build-android.mjs");

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const FP = "ab".repeat(32);

describe("pairing links carry the CA fingerprint", () => {
  test("pairFpQuery is empty without a CA and is the DER sha256 (no colons) once the CA exists", () => {
    assert.equal(auth.pairFpQuery(), "");
    auth.getTls(); // creates the CA under VIBESQUAD_HOME
    const pem = readFileSync(join(home, "tls", "ca.crt"));
    const want = createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");
    assert.equal(auth.pairFpQuery(), `&fp=${want}`);
    assert.match(auth.pairFpQuery(), /^&fp=[0-9a-f]{64}$/);
  });

  test("parsePairInput reads fp from the QR link and the deep link, and the deep link keeps it", () => {
    const qr = `https://192.168.1.20:4180/pair?code=123456&fp=${FP}`;
    assert.deepEqual(parsePairInput(qr), { host: "192.168.1.20:4180", code: "123456", fp: FP });
    const dl = toAndroidDeepLink(qr);
    assert.equal(dl, `vibesquad://pair?host=192.168.1.20%3A4180&code=123456&fp=${FP}`);
    assert.deepEqual(parsePairInput(dl), parsePairInput(qr));
  });

  test("normalizeFp accepts colons/case and the 8-pair short form, rejects anything weaker or non-hex", () => {
    assert.equal(normalizeFp("AB:CD:EF:01:23:45:67:89"), "abcdef0123456789");
    assert.equal(normalizeFp(FP.toUpperCase().match(/../g).join(":")), FP);
    assert.equal(normalizeFp("abcdef012345"), null); // 6 bytes: too short to pin
    assert.equal(normalizeFp("zz".repeat(16)), null);
    assert.equal(normalizeFp("ab".repeat(33)), null);
    assert.equal(parsePairInput("https://pc.example:4180/pair?code=123456&fp=nope").fp, "");
  });
});

describe("native pin bridge (web side)", () => {
  const fakeNative = (answer) => {
    const sent = [];
    const n = { onmessage: null, postMessage: (m) => { const r = JSON.parse(m); sent.push(r); queueMicrotask(() => n.onmessage?.({ data: JSON.stringify({ id: r.id, ...answer(r) }) })); } };
    return { n, sent };
  };

  test("nativeTrust is null outside the APK", () => {
    assert.equal(nativeTrust({}), null);
    assert.equal(nativeTrust({ VsTrust: {} }), null);
  });

  test("pin / probe / forget send host-scoped requests and resolve the reply", async () => {
    const { n, sent } = fakeNative((r) => (r.op === "pin" ? { ok: true, fp: FP } : { ok: true }));
    const t = createTrustClient(n);
    assert.equal(await t.pin("pc.example:4180", "abcdef0123456789"), FP);
    await t.probe("pc.example:4180");
    await t.forget("pc.example:4180");
    assert.deepEqual(sent.map(({ id, ...r }) => r), [
      { op: "pin", host: "pc.example:4180", fp: "abcdef0123456789" },
      { op: "probe", host: "pc.example:4180" },
      { op: "forget", host: "pc.example:4180" },
    ]);
  });

  test("flushCookies sends the flush op, is a no-op outside the APK and never rejects", async () => {
    const { n, sent } = fakeNative(() => ({ ok: true }));
    await flushCookies({ VsTrust: n });
    assert.deepEqual(sent.map(({ id, ...r }) => r), [{ op: "flush" }]);
    await flushCookies({});
    const refuse = fakeNative(() => ({ ok: false, error: "unknown op" }));
    await flushCookies({ VsTrust: refuse.n });
    await flushCookies({ VsTrust: { postMessage() {}, onmessage: null } }, 10); // silent native: times out, still resolves
  });

  test("the APK /pair request carries vs_app; Back after pairing shows the form; the reopen probe drops an unpaired session", () => {
    const src = readFileSync(new URL("../src/RemotePairScreen.tsx", import.meta.url), "utf8");
    assert.ok(src.includes("pairRedeemUrl(hostN, codeN, undefined, location.origin)"));
    assert.match(src, /sessionStorage\.setItem\(OPENED_KEY, "1"\);[\s\S]*?location\.href = pairRedeemUrl/);
    assert.match(src, /\/unpaired\/i\.test\([^)]*\)[\s\S]*?clearSession\(\)/);
    assert.doesNotMatch(src, /#paired/);
  });

  test("native probe asks /api/auth/status with the WebView cookie, treats paired:false as unpaired, and flushes cookies on a timer", () => {
    const kt = readFileSync(new URL("../src-tauri/android/VsTrust.kt", import.meta.url), "utf8");
    assert.match(kt, /\/api\/auth\/status/);
    assert.match(kt, /CookieManager\.getInstance\(\)\.getCookie\(/);
    assert.match(kt, /paired == false\) throw SecurityException\("unpaired/);
    assert.match(kt, /CookieManager\.getInstance\(\)\.flush\(\)[\s\S]*postDelayed\(this, FLUSH_EVERY_MS\)/);
  });

  test("a native refusal (fingerprint mismatch) rejects with its message; silence times out", async () => {
    const { n } = fakeNative(() => ({ ok: false, error: "CA fingerprint mismatch: nope" }));
    await assert.rejects(createTrustClient(n).pin("pc.example:4180", FP), /fingerprint mismatch/);
    const silent = { onmessage: null, postMessage: () => {} };
    await assert.rejects(createTrustClient(silent, 20).probe("pc.example:4180"), { name: "TimeoutError" });
  });
});

describe("Kotlin trust guards and build wiring", () => {
  const kt = read("src-tauri/android/VsTrust.kt");

  test("the only proceed() is behind VsTrust.allow; no trust-all handler, user-CA or network-config override", () => {
    const cfg = read("src-tauri/.cargo/config.toml");
    const ext = JSON.parse(cfg.match(/^WRY_RUSTWEBVIEWCLIENT_CLASS_EXTENSION = (".*")$/m)[1]);
    assert.match(ext, /if \(VsTrust\.allow\(view\.context, error\)\) handler\.proceed\(\) else handler\.cancel\(\)/);
    assert.equal((ext.match(/proceed\(\)/g) ?? []).length, 1);
    assert.match(cfg, /^WRY_RUSTWEBVIEW_CLASS_INIT = "VsTrust\.install\(this\)"$/m);
    assert.doesNotMatch(kt, /handler\.proceed|HttpsURLConnection\.setDefault|setDefaultSSLSocketFactory|setDefaultHostnameVerifier/);
    assert.doesNotMatch(read("src-tauri/tauri.android.conf.json"), /cleartext|networkSecurity|trust/i);
  });

  test("allow() requires a pinned host, https, validity, non-CA leaf, pinned issuer signature and SAN host match", () => {
    const allow = kt.slice(kt.indexOf("fun allow("), kt.indexOf("// ---- JS bridge"));
    for (const need of ['uri.scheme != "https"', "loadCa(c, it)", "checkValidity()", "basicConstraints < 0", "issuerX500Principal == ca.subjectX500Principal", "leaf.verify(ca.publicKey)", "hostMatches(leaf, host)", "catch (_: Exception)"]) {
      assert.ok(allow.includes(need), `allow() lost: ${need}`);
    }
  });

  test("pinning checks the fetched CA's sha256 against the QR fingerprint before storing it", () => {
    const pin = kt.slice(kt.indexOf("fun pin("), kt.indexOf("fun forget("));
    assert.ok(pin.indexOf("got.startsWith(want)") > 0 && pin.indexOf("got.startsWith(want)") < pin.indexOf("putString"));
    assert.match(pin, /\[0-9a-f\]\{16,64\}/);
    assert.match(pin, /ca\.basicConstraints < 0/);
  });

  test("the JS bridge is limited to the app origin (never the paired PC's https origin)", () => {
    assert.match(kt, /APP_ORIGINS = setOf\("http:\/\/tauri\.localhost", "https:\/\/tauri\.localhost"\)/);
    assert.match(kt, /addWebMessageListener\(webView, BRIDGE, APP_ORIGINS\)/);
    assert.doesNotMatch(kt, /addJavascriptInterface/);
  });

  test("ensureAndroidTrustKotlin copies VsTrust.kt once, idempotently, and ignores a missing project", () => {
    const dir = join(home, "gen-java");
    assert.equal(ensureAndroidTrustKotlin(dir), false);
    mkdirSync(dir, { recursive: true });
    assert.equal(ensureAndroidTrustKotlin(dir), true);
    assert.equal(readFileSync(join(dir, "VsTrust.kt"), "utf8"), kt);
    assert.equal(ensureAndroidTrustKotlin(dir), false);
    writeFileSync(join(dir, "VsTrust.kt"), "stale");
    assert.equal(ensureAndroidTrustKotlin(dir), true);
  });

  test("the pair screen pins through the bridge before redeeming and forgets on Forget", () => {
    const src = read("src/RemotePairScreen.tsx");
    assert.match(src, /t\.pin\(hostN, fpN!\)/);
    assert.ok(src.indexOf("t.pin(hostN") < src.indexOf("saveSession(hostN)"));
    assert.equal((src.match(/trust\(\)\?\.forget\(/g) ?? []).length, 3);
  });

  test("B8: pairWith flushes cookies (500ms cap) before redeeming; B9: forget clears the host vs_device cookie", () => {
    const src = read("src/RemotePairScreen.tsx");
    assert.match(src, /Promise\.race\(\[trust\(\)\?\.flush\(\)[\s\S]*?500\)\)\]\);\s*location\.href = pairRedeemUrl/);
    assert.doesNotMatch(src, /flushCookies/);
    assert.match(src, /clearSession\(\);\s*setError\(remoteError\("unknown", "Your PC no longer/);
    assert.match(src, /trust\(\)\?\.forget\(h\)\.catch\(\(\) => \{\}\);\s*clearSession\(\);\s*setError/);
    const kt = read("src-tauri/android/VsTrust.kt");
    const forget = kt.slice(kt.indexOf("fun forget("), kt.indexOf("fun probe("));
    assert.match(forget, /remove\("ca:\$key"\)/);
    assert.match(forget, /setCookie\("\$base\/", "vs_device=; Max-Age=0/);
  });

  test("B3: a saved PC gets a Reconnect button that probes then opens the server and shows errors", () => {
    const src = read("src/RemotePairScreen.tsx");
    assert.match(src, /data-testid="reconnect-pc"/);
    assert.match(src, /Reconnect to \{saved\.host\}/);
    assert.match(src, /const reconnect = [\s\S]*?probe\(h\)\.then\(\s*\(\) => openServer\(h\),\s*\(e\) => \{\s*onReopenError\(e, h\)/);
  });
});
