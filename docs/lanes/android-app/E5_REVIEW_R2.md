# E5 Outbound E2EE Relay · Tier A Review R2 (`ba6bb08`)

**Verdict:** PASS (`0C / 0H / 0M / 1L`)
**Branch:** `unit-and-end-e5` (commit `ba6bb08`)
**Tests:** 40/40 pass across 16 suites (`885.6ms`, `node --test --import ./test/setup/hermetic.mjs test/relay-tunnel.test.mjs`), `npm run typecheck` clean (`0`).

---

## (a) Verification of R1 Findings (#1–#8)

| # | R1 Finding | Status | Evidence (`file:line`) |
|---|---|---|---|
| 1 | [H] Unbounded brute-force of 6-digit pairing codes across sessions | **FIXED** | `server/relay-tunnel.mjs:410-412,422-424,478-523`: Host-wide `redeemFails` counter (`redeemFailLimit = 10`) persists across sessions and socket reconnects. On the 10th failure, `burnCodes()` is called, `onNeedsYou({ type: "relay-redeem-flood", ... })` fires, and `redeemLocked = true` blocks all subsequent `redeem` calls before invoking `redeem()` until `noteFreshMint()` (`server/relay-tunnel.mjs:707-710`) is called. Token auth failures are also throttled host-wide (`authFailLimit = 100` per `60_000ms` window). Tested at `test/relay-tunnel.test.mjs:476-521`. |
| 2 | [H] Validator/consumer path mismatch (`m.path` forwarded raw) | **FIXED** | `server/relay-tunnel.mjs:235-267,533-542,559-562`: `normalizeRelayTarget(method, target)` decodes each segment, rejects dot segments / encoded slashes / double-encoding / control chars / empty mid-segments, checks `RELAY_DENIED_PREFIXES` and `RELAY_ALLOWED_ROOTS` on the decoded lowercase path, and re-encodes segments into canonical `target.path`. Both `handleHttp` (`line 542`) and `openWs` (`line 562`) receive `target.path`. Tested at `test/relay-tunnel.test.mjs:458-474`. |
| 3 | [M] Missing raw frame / record size cap on client `open()` and before `JSON.parse`/`fromB64` | **FIXED** | `server/relay-tunnel.mjs:374-375,587` and `src/remoteRelayTransport.ts:15-16,129,141,353`: Both sides enforce `MAX_WIRE_CHARS` (~1.4 MiB) on the raw WebSocket message before `JSON.parse` and base64 decoding, and client `createChannel.seal`/`open` enforce `MAX_RECORD_BYTES` (`1 MiB`). Tested at `test/relay-tunnel.test.mjs:671-696`. |
| 4 | [M] Unbounded response body buffering in client `fetch()` | **FIXED** | `src/remoteRelayTransport.ts:17,269,413,421-428`: `client.fetch` tracks `total += c.length` against `maxResponseBytes` (default 64 MiB), deletes the stream and aborts with `"relay response too large"` when exceeded, and cleans up `streams.delete(id)` in `finally` (`lines 439-443`). Tested at `test/relay-tunnel.test.mjs:682-690`. |
| 5 | [M] HTTP 429 omits `fin: true`, hanging `client.fetch()`; duplicate `http-res` on post-head error | **FIXED** | `server/relay-tunnel.mjs:531,539-555`: Line 531 includes `fin: true` on the 429 response (`{ t: "http-res", id, status: 429, headers: {}, fin: true }`), `headSent` tracks whether `http-res` was already sent so the `catch` block sends `{ t: "http-body", id, b: "", fin: true }` when `headSent` is true (`line 552`), and `client.fetch` respects `head.fin === true` (`src/remoteRelayTransport.ts:438,444`). Tested at `test/relay-tunnel.test.mjs:639-668`. |
| 6 | [M] Socket leak on connect timeout and `pending`/`streams` leak on `sendFrame` failure | **FIXED** | `src/remoteRelayTransport.ts:318-323,370-393`: `sendTracked` deletes `id` from `pending` and `streams` on `sendFrame` rejection; `connectRelay` wraps the open + handshake phase in `try { ... } catch (e) { shutdown(e); throw e; }` so any connect timeout or handshake failure closes `sock`. Tested at `test/relay-tunnel.test.mjs:698-710`. |
| 7 | [L] Sync WebSocket throw schedules silently; `error` + `close` double-triggers | **FIXED** | `server/relay-tunnel.mjs:632-650`: `down(ws)` is the single idempotent teardown path (`if (sock !== ws) return;`), and synchronous `new WebSocketImpl(url())` throws emit `onEvent({ type: "connect-error", reason })` before calling `schedule()`. Tested at `test/relay-tunnel.test.mjs:712-723`. |
| 8 | [L] Missing test coverage for `maxHttpPerSession` (429), `maxSessions`, `authTimeoutMs` | **FIXED** | `test/relay-tunnel.test.mjs:601-758`: Added 23 new tests (40 total, up from 17) covering `maxSessions` + unauthenticated eviction, `authTimeoutMs`, `maxHttpPerSession` (429), throwing/hung handlers, frame/response size caps, connect timeout socket close, WebSocket constructor throw, `@noble/curves` X25519 fallback, H1–H3, and M1–M5. |

---

## (b) Verification of Fable Design Review Fixes (H1–H3, M1–M5, L1–L4)

| ID | Design Item | Status | Evidence (`file:line`) |
|---|---|---|---|
| **H1** | In-process dispatch (`req.relayDevice`, non-loopback sentinel socket, strip `set-cookie`) | **FIXED** | `server/relay-tunnel.mjs:277-370`: `createSyntheticRequest` sets `socket.remoteAddress = "relay"`, `socket.localAddress = "relay"`, and `relayDevice: Object.freeze({ id: String(deviceId) })`. `isRelayRequest(req)` checks `Boolean(req?.relayDevice?.id)`. `cleanResponseHeaders` strips `set-cookie` and `set-cookie2` in both `createSyntheticResponse` (`line 345`) and `dispatch` (`line 545`). Tested at `test/relay-tunnel.test.mjs:415-456`. |
| **H2** | Global per-host failure counter (10 failures -> burn codes, log `needs-you`, lock until fresh mint) | **FIXED** | `server/relay-tunnel.mjs:410,478-486,498-505,707-710`: Implemented and verified across reconnects at `test/relay-tunnel.test.mjs:476-521`. |
| **H3** | Static client origin trust boundary + strip `#fragment` on load via `history.replaceState` | **FIXED** | `docs/lanes/android-app/E5_THREAT_MODEL.md:19-24,50` documents the static client origin trust boundary and SRI pipeline; `src/remoteRelayTransport.ts:201-219` exports `takePairingFragment` and captures `pairingFragment` at module load, calling `w.history?.replaceState(null, "", loc.pathname + loc.search)` immediately and validating `wss://` and 32-byte `pub`. Tested at `test/relay-tunnel.test.mjs:760-784`. |
| **M1** | Self-certifying `hostId = base64url(SHA256(S))` | **FIXED** | `server/relay-tunnel.mjs:716` and `src/remoteRelayTransport.ts:180-183,277-279`: `selfCertifyingHostId` implemented in both Node and TS; `connectRelay` supports `requireSelfCertifiedHostId`. Relay-side `role=host` challenge is documented as out-of-scope relay server work in `E5_THREAT_MODEL.md:49,98`. Tested at `test/relay-tunnel.test.mjs:551-565`. |
| **M2** | Per-dispatch revocation re-check (`isRevoked(deviceId)`) | **FIXED** | `server/relay-tunnel.mjs:525-529`: Every post-auth dispatch (`http`, `ws-open`, `ws-data`, `ws-close`) awaits `isRevoked(s.deviceId)` and closes the session with `revoked-on-dispatch` if true. Tested at `test/relay-tunnel.test.mjs:523-538`. |
| **M3** | Evict oldest unauthenticated session when `maxSessions` is full | **FIXED** | `server/relay-tunnel.mjs:599-605`: On `{ t: "open" }` when `sessions.size >= maxSessions`, finds the oldest session with `!x.deviceId` (Map insertion order), emits `evicted-unauthenticated`, and closes it; if all 32 slots are authenticated, refuses the newcomer without evicting any authenticated session. Tested at `test/relay-tunnel.test.mjs:602-621`. |
| **M4** | Bind suite label and version byte in `transcriptHash` + fixed test vector | **FIXED** | `server/relay-tunnel.mjs:34,146-160` and `src/remoteRelayTransport.ts:10,91-97`: Both hash `PROTOCOL || SUITE ("Noise_NK_25519_AESGCM_SHA256") || version (0x01) || len(hostId) || hostId || S || e_c || e_h`. Fixed vector `974f295e706e84deaaf748b7ed639f7a521b50842aca35726340efdbc21582e9` verified at `test/relay-tunnel.test.mjs:540-549`. |
| **M5** | Session lifetime / rekey after 24 h or 2^20 records | **FIXED** | `server/relay-tunnel.mjs:415-416,462-466` and `src/remoteRelayTransport.ts:21-26,342`: Host checks `s.records >= maxSessionRecords || now() - s.createdAt > maxSessionMs` in `send()`, sends an encrypted `{ t: "rekey" }` record, and closes the session; client `onRecord` shuts down with `RelayRekeyError`. Tested at `test/relay-tunnel.test.mjs:568-599`. |
| **L1–L4** | Lockdown list, `/__vibesquad/local-login` deny, E4b wording, no persisted channel keys | **FIXED** | `/__vibesquad/local-login` added to `RELAY_DENIED_PREFIXES` (`server/relay-tunnel.mjs:225`); L1/L3/L4 documented in `docs/lanes/android-app/E5_THREAT_MODEL.md:60,94,103-104` and `src/remoteRelayTransport.ts:4-5`. |

---

## (c) Regression Check on New R2 Changes & Deferred Wiring Confirmation

### Checked Areas
1. **Close queued behind in-flight records (`src/remoteRelayTransport.ts:357-360,367`)**:
   - When the host triggers a rekey (`server/relay-tunnel.mjs:464-465`), it sends `{ t: "msg", cid, b: seal({ t: "rekey" }) }` immediately followed by `{ t: "close", cid }`.
   - Because WebCrypto `channel.open()` is async, queueing `{ t: "close" }` and the socket `"close"` event onto `chain` (`chain = chain.then(() => shutdown(...))`) ensures the preceding encrypted `{ t: "rekey" }` record finishes decrypting and calls `shutdown(new RelayRekeyError())` first, after which the queued close is a no-op (`if (closed) return;`).
   - If any earlier record in `chain` rejects (e.g., tampered ciphertext), `.catch((e) => shutdown(e))` resolves `chain` after calling `shutdown(e)`, so subsequent `.then(() => shutdown(...))` callbacks do not cause unhandled rejections.
2. **`@noble/curves` 2.4.0 X25519 fallback (`src/remoteRelayTransport.ts:7,67-87`)**:
   - Uses `x25519` from `@noble/curves/ed25519.js` (`package.json:28` pins `"@noble/curves": "2.4.0"`).
   - `x25519.getSharedSecret(sk, peer)` in `@noble/curves` 2.4.0 validates 32-byte lengths, rejects low-order points prior to the Montgomery ladder, and checks for all-zero output; `startHandshake.finish` (`src/remoteRelayTransport.ts:169`) additionally checks `allZero(es) || allZero(ee)` before deriving keys.

### Minor Low Finding (Non-blocking)
- **[LOW] `startHandshake.finish` does not wrap `k.dh()` errors into `RelayAuthError` when using the `@noble/curves` fallback (`src/remoteRelayTransport.ts:167-168`)**
  - **Failure scenario:** If a peer sends a low-order X25519 public key (e.g., all-zeros `eh`), WebCrypto's `deriveBits` returns all-zero bytes (which line 169 turns into `RelayAuthError("degenerate DH output")`) or throws `OperationError`, whereas `@noble/curves` `x25519.getSharedSecret` throws a plain `Error("invalid private or public key received")` before line 169. The session still fails closed and `connectRelay` still rejects and closes the socket, but the thrown error is a generic `Error` instead of `RelayAuthError`.
  - **Suggested fix (optional polish):** Wrap `k.dh(...)` in `try { ... } catch { throw new RelayAuthError("bad DH public key"); }` in `src/remoteRelayTransport.ts:167-168`.

### Confirmation of Explicitly Deferred Wiring Items (`docs/lanes/android-app/E5_THREAT_MODEL.md` §7)
Confirmed that all out-of-scope wiring items are explicitly cataloged in `docs/lanes/android-app/E5_THREAT_MODEL.md:72-102`:
- `auth.mjs` `relayDevice` handling in `authenticate()` and `isRelayRequest(req)` returning `false` in `isLocal()` / `isLocalBrowserSafe()` (§7 item 1)
- `auth.mjs` callbacks (`redeemPairCode`, `deviceForToken`, `deviceActive`, `burnAllPairCodes`, `relayHost.revoke(id)`) (§7 item 2)
- `HOME_SECRET_FILES` (`host-keypair.json` Windows icacls lockdown) and `vs host-key rotate` CLI (§7 item 3)
- `serve.mjs` tunnel construction, `createInProcessDispatcher`, and in-process `openWs` bridge (§7 item 5)
- Static client SRI build step + CSP (§7 item 6)
- Relay server `role=host` proof-of-possession registration auth and per-IP connection caps (§7 item 7)
- Upload chunking for request bodies > 1 MiB (§7 item 9)

### Cause-vs-Symptom Gate
- **PASS:** Every R1 and Fable design finding was fixed at the root cause (in-process synthetic request dispatch with frozen `relayDevice`, host-wide redeem failure lockout + code burn, single-pass path canonicalization shared by validator and handler, pre-parse wire frame size caps, bounded response buffering, unauthenticated session eviction, version/suite transcript binding, session rekey, and `@noble/curves` X25519 fallback).
