# X1-E4b L4 · Cookie Write Same-Origin Proof · Tier A Review R2 (`4750a14`)

**Verdict:** PASS (`0H / 0M / 0L`)
**Branch:** `unit-and-origin-check` (commit `4750a14` on `616ab96`, base `4996b66`)
**Diff Reviewed:** `git show 4750a14` (`docs/lanes/android-app/ORIGIN_CHECK_REVIEW_R1.md`, `server/auth.mjs`, `test/sec-origin-check.test.mjs`)
**Tests:** 121/121 pass across 29 suites (`5815.8ms`, `node --test --import ./test/setup/hermetic.mjs test/sec-origin-check.test.mjs test/sec-s2-http.test.mjs test/relay-wiring.test.mjs test/android-pair.test.mjs test/sec-prove-local.test.mjs`), `npm run typecheck` clean (`0`).

---

## (a) Root Verification of R2 Fixes (`4750a14`)

| Item | Status | Evidence (`file:line`) |
|---|---|---|
| **(1) X1 L1:** `isLocalBrowserSafe` requires `Origin === ownOrigin(req)` (lowercased) or a `TAURI_ORIGINS` shell origin instead of any loopback port (`isLoopbackOrigin`), preserving the `Sec-Fetch-Site` check | **VERIFIED** | `server/auth.mjs:681-684`: `if (origin !== undefined && String(origin).toLowerCase() !== ownOrigin(req) && !TAURI_ORIGINS.has(origin)) return false;` followed by `if (site !== undefined && site !== "same-origin" && site !== "none") return false;`. A legacy browser (no `Sec-Fetch-*`) sending `vs_local` from another loopback port (`http://127.0.0.1:3000` -> `127.0.0.1:4180`) or alternate loopback hostname (`http://localhost:4180` -> `127.0.0.1:4180`) now fails `isLocalBrowserSafe` with `403 { error: "forbidden" }`. Tested over real HTTP sockets at `test/sec-origin-check.test.mjs:323-345`. |
| **(2) R1 L1:** `originRefusal` is a pure function; `ORIGIN_REFUSED` symbol removed; `ownerProof` checks `isLocalOwner(req)` before `authenticate(req)` | **VERIFIED** | `server/auth.mjs:620`: `if (cookieWriteRefusal(req)) return null;` (no symbol mutation on `req`). `server/auth.mjs:744-747`: `originRefusal(req)` returns `null` when `!req || isRelayRequest(req)`, else `parseCookies(req.headers?.cookie)[DEVICE_COOKIE] ? cookieWriteRefusal(req) : null`. `server/auth.mjs:831-836`: `ownerProof(req)` evaluates `isLocalOwner(req) || Boolean(authenticate(req))` after `!hasAgentHeaders(req)`, matching `handlePairStart` (`:1288-1289`), so proven PC owners never invoke `authenticate(req)`, read `devices.json`, update `lastSeenAt`, or call `trackSocket`. Tested at `test/sec-origin-check.test.mjs:163-186,356-360`. |
| **(3) X1 I1:** `SAFE_METHODS` is `new Set(["GET", "HEAD"])` | **VERIFIED** | `server/auth.mjs:705,725`: `SAFE_METHODS = new Set(["GET", "HEAD"])`, matching `vibesquad-api.mjs:1657` (`const write = req.method !== "GET" && req.method !== "HEAD"`). Tested at `test/sec-origin-check.test.mjs:98-105`. |

---

## (b) Regression Check Across Client Shapes

| Client / Path | Result | Evidence |
|---|---|---|
| **Desktop proxy -> local upstream** (`Host: 127.0.0.1:<port>`, `Origin: http://127.0.0.1:<port>`, `x-vibesquad-token`, optional `vs_device`) | **No regression** | `String(origin).toLowerCase() === ownOrigin(req)` (`http://127.0.0.1:<port>`) passes `isLocalBrowserSafe` (`server/auth.mjs:682`) and `cookieWriteRefusal` (`:730`); `ownerProof` short-circuits on `isLocalOwner(req)` (`:835`). Tested at `test/sec-origin-check.test.mjs:307-315`. |
| **Desktop proxy -> remote upstream** (`Origin` stripped, `Sec-Fetch-Site: same-origin` or omitted, `vs_device` injected) | **No regression** | Hits `authenticate(req)` on TLS listener; `origin === undefined` and `site` is `"same-origin"` or `undefined` -> `cookieWriteRefusal` returns `null` (`server/auth.mjs:733-735`). Tested at `test/sec-origin-check.test.mjs:273-281`. |
| **`vs open` / launcher (`vs_local` cookie)** | **No regression** | Browser lands on `http://127.0.0.1:<port>/` after `/__vibesquad/local-login`, so same-origin writes send `Origin: http://127.0.0.1:<port>`, matching `ownOrigin(req)`. Tested at `test/sec-origin-check.test.mjs:337-344`. |
| **Tauri shell on loopback (`http://tauri.localhost`, `https://tauri.localhost`, `tauri://localhost`)** | **No regression** | Allowed in `isLocalBrowserSafe` via `TAURI_ORIGINS.has(origin)` (`server/auth.mjs:662,682`). Tested with `vs_local` and `x-vibesquad-token` at `test/sec-origin-check.test.mjs:175-185,340-341`. |
| **Tauri Android APK** | **No regression** | Navigates to the PC's HTTPS origin via `/__vibesquad/enter` (`GET`, safe method) and then runs at `https://<host>:<port>`, sending `Origin === ownOrigin(req)`. Tested in `test/android-pair.test.mjs` and `test/sec-origin-check.test.mjs:139-143,267-271`. |
| **E5 Relay (`req.relayDevice`)** | **No regression** | `authenticate(req)` branches on `isRelayRequest(req)` at line 614 before `cookieWriteRefusal`, and `originRefusal(req)` returns `null` on `isRelayRequest(req)` at line 745. Tested in `test/relay-wiring.test.mjs` and `test/sec-origin-check.test.mjs:206-219`. |
| **`x-vibesquad-token` CLI / MCP callers** | **No regression** | Send no `Origin` or `Sec-Fetch-Site` (`isBrowserRequest(h)` is `false`); `isLocalBrowserSafe` returns `true` (`server/auth.mjs:676-686`) and `isLocalOwner` authenticates before `authenticate(req)`. Tested in `test/sec-prove-local.test.mjs` and `test/sec-origin-check.test.mjs:301-305`. |

---

## (c) Rating of Worker's Open Note

- **Open note:** In `gated()` (`server/vibesquad-api.mjs:1659-1661`), the unknown-caller branch checks `if (caller.kind !== "agent" && originRefusal(req)) return sendCrossSiteRefused(req, res);` before returning `READ_ONLY_ERROR`. For a loopback request that passes `isLocalBrowserSafe(req)` (specifically `Origin: http://tauri.localhost`, since any other `Origin` passing `isLocalBrowserSafe` already equals `ownOrigin(req)`), holds **no** local token (`x-vibesquad-token` / `vs_local`), and carries a `vs_device` cookie (which fails `cookieWriteRefusal` because `http://tauri.localhost !== http://127.0.0.1:<port>`), `gated()` returns `403 { error: CROSS_SITE_ERROR }` instead of `403 { error: READ_ONLY_ERROR, readOnly: true }`.
- **Rating:** **Info (`0L` — not a finding, accurate diagnostic behavior).**
  1. Both branches return HTTP `403` and refuse the write before any handler runs.
  2. The only request shape that reaches line 1660 with `isLocalBrowserSafe(req) === true` and `originRefusal(req) !== null` is a request from a `TAURI_ORIGINS` origin (`http://tauri.localhost`, `https://tauri.localhost`, or `tauri://localhost`) hitting loopback directly without `x-vibesquad-token` or `vs_local`, while carrying a `vs_device` cookie. For that caller, its only credential on the request *is* `vs_device`, and that cookie write *was* refused because `tauri.localhost` is not the listener's `ownOrigin` (`http://127.0.0.1:<port>`). Reporting `CROSS_SITE_ERROR` rather than `READ_ONLY_ERROR` states the exact reason the supplied credential did not authenticate the write.

---

## (d) Cause-vs-Symptom Gate

- **PASS:** Every R1 and X1 finding is resolved at the root cause: `isLocalBrowserSafe` enforces exact `ownOrigin(req)` (plus `TAURI_ORIGINS`) instead of port-wildcard loopback matching, `originRefusal` is stateless, `ownerProof` checks local owner first, and `SAFE_METHODS` is unified to `GET`/`HEAD`.

PASS — 0H / 0M / 0L
