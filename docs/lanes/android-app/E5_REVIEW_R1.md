# E5 Outbound E2EE Relay · Tier A Review R1 (`573d99f`)

**Verdict:** FAIL (`0C / 2H / 4M / 2L`)
**Branch:** `unit-and-end-e5` (`9343e71` + `573d99f`)
**Tests:** 17/17 pass (`node --test --import ./test/setup/hermetic.mjs test/relay-tunnel.test.mjs`), `npm run typecheck` clean.

---

## Findings

### 1. [HIGH] Unbounded brute-force of 1-time 6-digit pairing codes across sessions
- **Location:** `server/relay-tunnel.mjs:330`, `server/relay-tunnel.mjs:340`, `server/relay-tunnel.mjs:413-420`, `docs/lanes/android-app/E5_THREAT_MODEL.md:35`
- **Failure scenario:** `maxRedeemAttempts = 5` is enforced only per session (`s.redeems`), and `onRelayMessage` allows an attacker or untrusted relay to open new `{t: "open", cid}` sessions indefinitely as old ones close. Because the relay hides client IPs, an attacker can cycle ephemeral sessions and brute-force thousands of 6-digit codes per second against `redeem()`.
- **Suggested fix:** Enforce a host-wide failed-redeem/auth sliding-window rate limiter and exponential lockout across all sessions inside `createRelayHost` (e.g., lock out `redeem`/`auth` host-wide after N failed attempts within a window).

### 2. [HIGH] Validator/consumer path mismatch (`m.path` forwarded raw after decoded validation)
- **Location:** `server/relay-tunnel.mjs:218-241`, `server/relay-tunnel.mjs:352-359`, `server/relay-tunnel.mjs:375-379`
- **Failure scenario:** `isRelayPathAllowed` URL-decodes and lowercases segments to check `RELAY_DENIED_PREFIXES` and `RELAY_ALLOWED_ROOTS`, but `dispatch` forwards the raw un-normalized `m.path` to `handleHttp` and `openWs`. Downstream routers (such as `vibesquad-api.mjs` splitting `req.url` on `?` without `decodeURIComponent`) see a different path string than what `isRelayPathAllowed` validated, or valid API paths with URL-encoded parameters fail if they contain `%2F`.
- **Suggested fix:** Return the canonicalized path (plus original query string) from the path validator and pass that canonical path to `handleHttp` and `openWs` so the security check and handler operate on the exact same string.

### 3. [MEDIUM] Missing raw frame / record size cap on client `open()` and before base64 decode on both sides
- **Location:** `src/remoteRelayTransport.ts:113-126`, `src/remoteRelayTransport.ts:262-272`, `server/relay-tunnel.mjs:403-431`
- **Failure scenario:** `src/remoteRelayTransport.ts` `createChannel.open` has no `MAX_RECORD_BYTES` check at all, and both host `onRelayMessage` and client `sock.addEventListener("message")` run `JSON.parse` and `Buffer.from(f.b, "base64")` / `fromB64(m.b)` before checking length. A malicious relay can send a huge frame to trigger OOM/DoS during JSON parsing and base64 decoding before `open()` ever runs.
- **Suggested fix:** Reject raw WebSocket messages exceeding a strict byte ceiling before `JSON.parse`/`fromB64`, and enforce `MAX_RECORD_BYTES + 8 + TAG_LEN` inside client `createChannel.open()`.

### 4. [MEDIUM] Unbounded response body buffering in client `fetch()`
- **Location:** `src/remoteRelayTransport.ts:313-334`
- **Failure scenario:** `client.fetch` pushes every incoming `http-body` chunk into `chunks: Bytes[]` without a total byte cap or stream count cap until `f.fin` arrives. A misbehaving or compromised stream can push unbounded chunks and exhaust browser/WebView memory.
- **Suggested fix:** Track accumulated byte length across `chunks` in `client.fetch` and abort the request (and remove the stream) if total response bytes exceed a configured maximum (e.g., `MAX_RESPONSE_BYTES`).

### 5. [MEDIUM] HTTP 429 response omits `fin: true`, permanently hanging `client.fetch()` and leaking `streams`
- **Location:** `server/relay-tunnel.mjs:350`, `src/remoteRelayTransport.ts:325-332`
- **Failure scenario:** When `s.http >= maxHttpPerSession`, the host sends `{ t: "http-res", id, status: 429, headers: {} }` without `fin: true` and returns immediately without sending an `http-body` frame with `fin: true`. On the client, `head` resolves, `if (head.fin) done()` is false, and `await finished` hangs forever while `streams.get(id)` leaks. Similarly, if `handleHttp` throws after line 362 already sent `http-res`, line 368 sends a duplicate `http-res`.
- **Suggested fix:** Include `fin: true` on the 429 `http-res` at `server/relay-tunnel.mjs:350`, and if an error occurs after the initial `http-res` was already sent, send `{ t: "http-body", id, b: "", fin: true }` (or close the session) instead of a second `http-res`.

### 6. [MEDIUM] Socket leak on connect timeout and `pending`/`streams` map leaks when `sendFrame` rejects
- **Location:** `src/remoteRelayTransport.ts:233-242`, `src/remoteRelayTransport.ts:276-286`, `src/remoteRelayTransport.ts:325-328`, `src/remoteRelayTransport.ts:363-366`
- **Failure scenario:** (a) In `connectRelay`, if the initial connection timer (`relay connect timed out`) fires, `rej(...)` is called without calling `shutdown()` or `sock.close()`, leaving the underlying WebSocket alive if it connects late. (b) In `rpc`, `client.fetch`, and `client.openWebSocket`, if `sendFrame` rejects, the `.catch(reject)` handler rejects the outer promise without deleting `id` from `pending` or `streams`.
- **Suggested fix:** Call `shutdown(new Error("relay connect timed out"))` in the open timeout handler, and clean up `pending.delete(id)` / `streams.delete(id)` whenever `sendFrame` rejects.

### 7. [LOW] Redundant `down()` invocation and silent schedule on synchronous WebSocket constructor throw
- **Location:** `server/relay-tunnel.mjs:441-472`
- **Failure scenario:** When `new WebSocketImpl(url())` throws synchronously, `connect()` calls `schedule()` without emitting an error event. When `ws` emits `"error"`, the handler calls `ws.close()` and then `down()`, while `"close"` also calls `down()` (guarded only by `if (sock !== ws) return`).
- **Suggested fix:** Emit an `onEvent({ type: "connect-error", ... })` when `new WebSocketImpl` throws, and let `down()` be the single teardown entry point.

### 8. [LOW] Missing test coverage for `maxHttpPerSession` (429), `maxSessions`, `authTimeoutMs`, and `RelayUnsupportedError`
- **Location:** `test/relay-tunnel.test.mjs:1-394`
- **Failure scenario:** None of the 17 tests exercise `maxHttpPerSession` (which would have caught the permanent client hang in Finding #5), `maxSessions` eviction/rejection, `authTimeoutMs` closing idle unauthenticated sessions, or `RelayUnsupportedError` when WebCrypto lacks X25519.
- **Suggested fix:** Add unit tests in `test/relay-tunnel.test.mjs` covering `maxHttpPerSession` (verifying 429 completes cleanly), `maxSessions`, `authTimeoutMs`, and `supportsRelayCrypto()` / `RelayUnsupportedError`.
