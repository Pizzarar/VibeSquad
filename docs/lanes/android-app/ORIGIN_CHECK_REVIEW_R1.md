# X1-E4b L4 · Cookie Write Same-Origin Proof · Tier A Review R1 (`616ab96`)

**Verdict:** PASS (`0H / 0M / 1L`)
**Branch:** `unit-and-origin-check` (commit `616ab96` on `4996b66`)
**Diff Reviewed:** `git diff 4996b66..616ab96` (`SECURITY.md`, `server/auth.d.mts`, `server/auth.mjs`, `server/serve.mjs`, `server/vibesquad-api.mjs`, `test/sec-origin-check.test.mjs`)
**Tests:** 124/124 pass across 34 suites (`5144.9ms`, `node --test --import ./test/setup/hermetic.mjs test/sec-origin-check.test.mjs test/sec-s2-http.test.mjs test/relay-wiring.test.mjs test/android-pair.test.mjs test/sec-phone-mint-pair.test.mjs`), `npm run typecheck` clean (`0`).

---

## (a) Verification of Chokepoint & Decision Table

| Claim | Status | Evidence (`file:line`) |
|---|---|---|
| Single chokepoint in `server/auth.mjs`: `authenticate(req)` calls `cookieWriteRefusal(req)` before token hash lookup | **VERIFIED** | `server/auth.mjs:613-624`: `authenticate(req)` checks `isRelayRequest(req)` first (`:614`), reads `parseCookies(req.headers.cookie)[DEVICE_COOKIE]` (`:615`), and calls `cookieWriteRefusal(req)` (`:619`) before `deviceByTokenHash(sha256Hex(token))` (`:624`). On refusal, it sets `req[ORIGIN_REFUSED] = refused` and returns `null` without reading `devices.json`, updating `lastSeenAt`, or registering a socket with `trackSocket`. |
| Safe methods (`GET`, `HEAD`, `OPTIONS`) always pass | **VERIFIED** | `server/auth.mjs:701,722`: `SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])`; `if (SAFE_METHODS.has(String(req.method ?? "GET").toUpperCase())) return null;`. Cross-site `GET`s (including SSE and WS upgrades) are unaffected. |
| `Origin` present -> must equal listener's own `scheme://Host` (lowercase); `"null"`, empty, wrong scheme/port/host, or multiple `Origin` headers refused | **VERIFIED** | `server/auth.mjs:705-715,724-729`: `ownOrigin(req)` returns `${req.socket?.encrypted ? "https" : "http"}://${host}` where `host = singleHeader(req.headers, "host")?.toLowerCase()`, or `null` if `Host` is missing/empty. `cookieWriteRefusal` requires `own && origin.toLowerCase() === own`. `Origin: null`, `Origin: ""`, wrong port/scheme, suffix host, and array-joined multiple headers all fail closed. Tested at `test/sec-origin-check.test.mjs:104-125,142-147`. |
| `Origin` absent -> `Sec-Fetch-Site` absent, `"none"`, or `"same-origin"` passes; `"cross-site"` and `"same-site"` refused | **VERIFIED** | `server/auth.mjs:730-732`: `const site = singleHeader(h, "sec-fetch-site"); if (site === undefined || site === "none" || site === "same-origin") return null;`. Both `"cross-site"` and `"same-site"` (e.g., a sibling subdomain or another port on the same site when `Origin` is omitted) are refused. Tested at `test/sec-origin-check.test.mjs:127-134,224-230`. |
| Both listeners return `403` with plain JSON/text (`CROSS_SITE_ERROR`), never the HTML unpaired page | **VERIFIED** | `server/serve.mjs:434`: `if (!dev) return originRefusal(req) ? sendCrossSiteRefused(req, res) : sendUnpaired(req, res);`. `server/vibesquad-api.mjs:1641,1660`: returns `sendCrossSiteRefused(req, res)` when `originRefusal(req)` is set. `sendCrossSiteRefused` (`server/auth.mjs:739-748`) sends `403` JSON `{ error: CROSS_SITE_ERROR }` on `/__vibesquad/*`, `/api/*`, or `Accept: application/json`, and `403 text/plain` otherwise. Tested at `test/sec-origin-check.test.mjs:211-237,289-293`. |
| Relay, `x-vibesquad-token`, agent headers, Tauri APK, desktop proxy, and loopback browser unaffected | **VERIFIED** | Relay requests branch at `server/auth.mjs:614` (`if (isRelayRequest(req)) return authenticateRelayDevice(req);`) before line 619. `x-vibesquad-token` without `vs_device` has `!token` at `:616` and authenticates via `isLocalOwner(req)` (`:787,822`). Agent-header requests short-circuit in `ownerProof` (`:821`) and `gated()` (`server/vibesquad-api.mjs:1660` checks `caller.kind !== "agent"`). The Android APK navigates to the PC's own `https://<host>:<port>` origin after `/__vibesquad/enter` (`src/remoteSession.ts:147-151`). The desktop Rust proxy (`src-tauri/src/main.rs:2280-2302`) strips `Origin` and forwards `Sec-Fetch-Site: same-origin` to remote hosts, and sets `Host: <host>` + `Origin: http://<host>` + `x-vibesquad-token` to local hosts. |

---

## (b) Threat Hunt Results

1. **Are any cookie-authenticated write routes mounted before the chokepoint in `serve.mjs` or `vibesquad-api.mjs`?**
   - **No.**
   - In `server/serve.mjs:408-436` (`handleMeshnetHttps`), every route mounted before `const dev = authenticate(req)` (`:433`) is restricted to `GET`/`HEAD` (`/ca.crt`, `/VibeSquad-setup.exe`, APK, `/__vibesquad/desktop/update.json`, `/api/health`, `/api/auth/status`, `GET /pair`, `GET /pair/status`), except `/__vibesquad/enter` (`:432`), where `handleEnter` (`server/auth.mjs:1218-1221`) immediately rejects anything other than `GET`/`HEAD` with `405`. In `handleMeshnetHttp` (`server/serve.mjs:364-406`), all non-`GET`/`HEAD` requests receive `426 Upgrade Required`.
   - In `server/vibesquad-api.mjs:1629-1653`, the pre-gate routes are `/api/health` (`GET`/`HEAD` only, `405` otherwise), `/ca.crt` (`GET`/`HEAD` only), `/pair` (`GET` only), `/pair/status` (`GET` only), `/__vibesquad/enter` (`GET`/`HEAD` only), `/__vibesquad/local-login` (`GET` only), `/__vibesquad/local-login/nonce` (`POST`, requires `isLocalBrowserSafe(req) && hasLocalTokenHeader(req)`, never `vs_device`), and `/__vibesquad/local-proof` (`GET` only). Every other `/__vibesquad/*` and `/api/*` route passes through `isTrusted(req)` (`:1640`) and `resolveNonAgentCaller(req)` -> `ownerProof(req)` -> `authenticate(req)`.
   - All self-gated handlers (`handlePairStart` at `server/auth.mjs:1276`, `handlePairApprove` at `:1458`, `handleRevoke` at `:1580`), file mutations (`/__vibesquad/fs/*`), inbox attachment uploads (`/__vibesquad/inbox/attachment`), and runner/terminal POSTs depend on `authenticate(req)` or `ownerProof(req)`.
2. **`Origin: "null"` handling:**
   - **Refused.** `singleHeader(h, "origin")` returns `"null"`, which is `!== undefined`, and `"null" === ownOrigin(req)` is `false` (`ownOrigin` always starts with `http://` or `https://`). Tested at `test/sec-origin-check.test.mjs:111,218-222`.
3. **`Host` header spoofing / port or case mismatch:**
   - **Safe.** In browsers, `Host` is a forbidden request header (Fetch spec) derived strictly from the request URL's authority, and `Origin` is serialized by the browser from the initiator's origin (`scheme://host[:port]`). A cross-site attacker at `https://evil.example` targeting `https://100.64.0.7:4180` causes the browser to send `Host: 100.64.0.7:4180` and `Origin: https://evil.example`; the page cannot forge `Host: evil.example` to match its `Origin`. Both `ownOrigin` and `cookieWriteRefusal` lowercase before comparing (`server/auth.mjs:711,727`).
4. **`Sec-Fetch-Site: same-site`:**
   - **Refused.** When `Origin` is absent, only `undefined`, `"none"`, and `"same-origin"` pass (`server/auth.mjs:731`). `"same-site"` is rejected with `403`, preventing a sibling subdomain or another port on the same site (where `SameSite=Strict` cookies ARE sent by browsers) from authenticating a write without a matching `Origin`.
5. **Missing-both-headers decision (`Origin` absent AND `Sec-Fetch-Site` absent):**
   - **Sound.** All modern browsers and Android WebView send `Origin` on every state-changing method (`POST`, `PUT`, `PATCH`, `DELETE`) and `Sec-Fetch-Site` on all requests to HTTPS origins (and loopback HTTP). Allowing requests that omit *both* headers preserves non-browser clients (curl/CLI tooling and the Tauri desktop proxy on remote upstreams when an older WebView omits `Sec-Fetch-Site`) without opening a browser CSRF vector.
6. **Method override / `OPTIONS` / `HEAD` handling:**
   - **Safe.** Neither `serve.mjs` nor `vibesquad-api.mjs` honors `X-HTTP-Method-Override` or `_method` query/body parameters; routing branches strictly on `req.method`. In `vibesquad-api.mjs:1657`, `const write = req.method !== "GET" && req.method !== "HEAD"`, so an `OPTIONS` request to `/__vibesquad/*` has `write = true` and still requires `owner` (`:1658`), where `authenticate(req)` allows `OPTIONS` as a safe method only if the caller holds a valid credential, and the downstream route switch returns `405` or `404`.
7. **Relay requests:**
   - **Unaffected and never accidentally trusted.** `authenticate(req)` checks `if (isRelayRequest(req)) return authenticateRelayDevice(req);` on its first line (`server/auth.mjs:614`), so relayed requests never enter `cookieWriteRefusal`.

---

## (c) Findings

### 1. [LOW] Loopback request carrying both a cross-site `vs_device` cookie and a valid local credential (`x-vibesquad-token` or `vs_local`) leaves a stale `req[ORIGIN_REFUSED]` symbol when `isTrusted` evaluates `authenticate(req)` (`server/vibesquad-api.mjs:301,1640,1652`, `server/auth.mjs:820-823`)
- **Location:** `server/auth.mjs:619-623,820-823`, `server/vibesquad-api.mjs:301,1640-1642,1652,1659-1661`
- **Failure scenario:** On the loopback listener, suppose a caller sends a `POST` with `cookie: vs_device=<token>` AND `x-vibesquad-token: <localToken>` (for example, a test or local script that has a `vs_device` cookie in its jar and sends a mismatched `Origin` or `Sec-Fetch-Site`, or a loopback browser where `isLocalBrowserSafe` is false).
  - In `vibesquad-api.mjs:301`, `isTrusted(req)` evaluates `isLocalBrowserSafe(req) || Boolean(authenticate(req))`.
  - When `isLocalBrowserSafe(req)` is `true` (e.g., `Host: 127.0.0.1:4180`, no `Origin`, `Sec-Fetch-Site: none`), `isTrusted(req)` short-circuits to `true`, and then `resolveNonAgentCaller(req)` calls `ownerProof(req)` (`server/auth.mjs:822`: `Boolean(authenticate(req)) || isLocalOwner(req)`), which calls `authenticate(req)` *first*.
  - If `cookieWriteRefusal(req)` refuses the `vs_device` cookie (for example, if `Origin: http://tauri.localhost` was sent on loopback, which `isLocalBrowserSafe` allows via `TAURI_ORIGINS` at `server/auth.mjs:665-667`, but `cookieWriteRefusal` refuses because `ownOrigin` is `http://127.0.0.1:4180`), `authenticate(req)` sets `req[ORIGIN_REFUSED]` and returns `null`.
  - If the caller *also* has `hasLocalToken(req) === true`, `ownerProof(req)` falls back to `isLocalOwner(req) === true`, so `owner` is `true` and the request succeeds — EXCEPT in `handlePairStart` (`server/auth.mjs:1275-1276`), which checks `isLocalOwner(req)` before `authenticate(req)`.
  - Conversely, if `hasLocalToken(req)` is `false` (a read-only local browser at `tauri://localhost` or `http://127.0.0.1:4180` that also happens to carry an old `vs_device` cookie with a port mismatch), `gated()` at `server/vibesquad-api.mjs:1660` checks `if (caller.kind !== "agent" && originRefusal(req)) return sendCrossSiteRefused(req, res);`, returning `CROSS_SITE_ERROR` instead of `READ_ONLY_ERROR`.
  - More importantly, for `TAURI_ORIGINS` (`tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`): if a Tauri WebView ever hits the loopback listener directly with a `vs_device` cookie and `Origin: http://tauri.localhost` (without `x-vibesquad-token`), `isLocalBrowserSafe` treats `TAURI_ORIGINS` as loopback-safe (`server/auth.mjs:665-667`), whereas `cookieWriteRefusal` rejects `Origin: http://tauri.localhost` because `ownOrigin(req)` is `http://127.0.0.1:<port>` (and as tested at `test/sec-origin-check.test.mjs:136-140`, this is intentional because the APK navigates to the host's own origin and the desktop app uses the Rust proxy which rewrites `Origin: http://<host>`).
- **Suggested fix:** No functional bug for any live client shape (`test/sec-origin-check.test.mjs:136-140,279-287` explicitly tests both the APK and desktop-proxy shapes). As optional hygiene in `ownerProof(req)` (`server/auth.mjs:822`), checking `isLocalOwner(req) || Boolean(authenticate(req))` (matching the order in `handlePairStart` at `:1275-1276`) avoids running `authenticate(req)` (and touching `devices.json` / `lastSeenAt` / `ORIGIN_REFUSED`) when the request is already proven as the local PC owner.

---

## (d) Cause-vs-Symptom Gate

- **PASS:** The change fixes the root cause of X1-E4b L4 at the single cookie authentication chokepoint (`authenticate()` in `server/auth.mjs`), enforcing a strict `Origin === ownOrigin(req)` / `Sec-Fetch-Site` check before any token hash lookup or state mutation on both the TLS Meshnet/LAN listener and the loopback listener.

PASS — 0H / 0M / 1L
