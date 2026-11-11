# E5 Outbound E2EE Relay · Threat Model (branch `unit-and-end-e5`)

Status: rev 4 (wiring, see §11; `unit-and-end-e5-wire`), after rev 3 (X1 walk fix round, §9/§10), the Fable 5.1 design pass (`~/.vibesquad/teams/vibesquad/E5_DESIGN_REVIEW.md`, PASS-with-changes), Review-Gemini R1 (`E5_REVIEW_R1.md`, FAIL 0C/2H/4M/2L) and R2 (`E5_REVIEW_R2.md`, PASS). Tier A. Core is **wired into the live server, off by default** (settings.json `relay.endpoint`).
Files: `server/relay-tunnel.mjs` (host core), `server/relay-wiring.mjs` (wiring), `src/remoteRelayTransport.ts` (client), `src/remoteSession.ts` (pin store), `test/relay-tunnel.test.mjs`, `test/relay-wiring.test.mjs`.
Plan: `docs/PLAN_ANDROID_END_STATE.md` Phase 1 item 1.

## 1. Assets
| Asset | Why it matters |
|---|---|
| Full owner control of the Home PC (agents, shells, git, files) | Anything reachable through `/__vibesquad/*`, `/api/*`, `/ws` once authenticated |
| Per-device token (`devices.json`, hash only on host) | Bearer credential; theft = owner access until revoked |
| Host X25519 private key (`~/.vibesquad/host-keypair.json`) | Proves host identity to pinned clients; theft lets an attacker impersonate the host and phish codes/tokens |
| 1-time 6-digit pairing code | Converts to a device token; short-lived |
| Session confidentiality (prompts, diffs, file contents) | Relay and network see only ciphertext |

## 2. Actors and trust boundaries
- **Relay operator / relay compromise: UNTRUSTED.** Can read, drop, delay, reorder, replay, inject frames, and refuse service. Never learns keys or plaintext. Sees metadata: `hostId`, timing, sizes, connection counts, client IPs.
- **Network attacker** (work/proxy/ISP, TLS-terminating corporate proxy): same powers as the relay on the wire. Corporate TLS interception breaks only the outer WSS; the E2EE inner channel is unaffected.
- **Static client origin: TRUSTED** (design review H3). For browser clients (Project PC) the page that serves the `/pair` JS runs inside the trust boundary: it sees the code, the pin and all plaintext. Therefore:
  1. it MUST be a VS-controlled origin **separate from the relay operator** (a relay that also serves the page is not zero-knowledge);
  2. the bundle MUST be loaded with Subresource Integrity (pipeline below);
  3. the client strips the pairing `#fragment` immediately on load (`takePairingFragment` / `pairingFragment` in `remoteRelayTransport.ts`: read `hostId/pub/relay/code` into memory, then `history.replaceState` to drop the fragment before any other code runs; tested). The fragment never reaches a server in any case, and stripping stops it living on in history, bookmarks, Referer or screenshots.
  4. **Android APK**: the page is bundled inside the APK, so there is no remote page origin to trust; H3 applies only to browser / static-host clients.
  - **SRI pipeline** (wiring/build phase, not in this unit's files): after `vite build --mode remote`, a build step computes `sha384` of every emitted JS/CSS asset and writes `integrity="sha384-…" crossorigin="anonymous"` into the emitted `index.html` (a small Vite plugin using `generateBundle`/`transformIndexHtml`); the same hashes are published in the release notes so a user can compare. The entry module must import `remoteRelayTransport.ts` first so the fragment is stripped before any other module runs. Hosting: VS-controlled static host (e.g. GitHub Pages under the project domain), CSP `default-src 'self'; connect-src wss:`; no third-party scripts.
- **Client device** (phone, Project PC browser): trusted once paired; holds the token and the pinned host pubkey.
- **Host process**: trusted. Boundary = the in-process dispatcher plus the allowlist; a relayed principal gets no more than a *remote* authenticated owner gets, never local-PC powers (H1).
- **Local users on the Home PC**: out of scope here (covered by the `~/.vibesquad` lockdown, S2).

Trust anchor: the host public key `pub` delivered **out of band** in the pairing link/QR (`#hostId=..&pub=..&relay=..&code=..`). The relay URL is NOT a trust anchor.

## 3. Threat table
| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T1 | **MITM / malicious relay impersonates host** | Client pins `pub`. Handshake derives keys from `DH(e_c, S)`; host proves possession of `s` via key-confirmation record. Wrong key -> confirmation fails, client aborts before sending any code/token. Transcript binds protocol, suite, version, `hostId`, `S`, both ephemerals | If the pairing link is intercepted the attacker gets the pin; show it only on trusted screens |
| T2 | **Relay reads traffic** | AEAD records; relay only forwards opaque base64 (tested with a recording fake relay) | Metadata visible |
| T3 | **Tamper / bit-flip** | AES-256-GCM tag, AAD = direction + counter; any failure closes the session | None |
| T4 | **Replay / reorder / drop-and-continue** | Strict counter; per-direction keys stop reflection; fresh ephemerals per session stop cross-session replay | Relay can truncate or kill a session (DoS) but not forge |
| T5 | **Relay compromise** | Equivalent to T1-T4; relay holds no secrets | Availability |
| T6 | **Stolen / lost phone** | Per-device token, revocable. Revocation is re-checked on **every** post-auth dispatch via injected `isRevoked` (CLI `vs devices revoke` runs out of process and never calls `revoke()`), plus `revoke(deviceId)` for immediate close. Cascade revoke is E4b | Window until owner revokes; token lives in phone storage |
| T7 | **Token theft in transit** | Redeem/auth only inside the E2EE channel | Token at rest on client |
| T8 | **Brute-force the 6-digit code** | Host-**wide** failed-redeem counter (not per session or per socket; survives reconnects, tested). A guess is counted **when issued**, synchronously before the await on `redeem()` (X1 H-1), so closing the session mid-flight or bursting 32x5 frames cannot skip it; at most `redeemFailLimit` guesses ever reach the callback; a success only clears the guesses that are not still in flight. Over-long codes (>16) and tokens (>128) are rejected without reaching `auth.mjs` and still count. At 10 failures: `burnCodes()`, `onNeedsYou` security event, redeem locked until `noteFreshMint()`. Chance an attacker succeeds in one code lifetime ≤ ~1e-5. Per-session cap (5) and 30 s unauth timeout stay as extra friction. Token auth failures are throttled host-wide (100/min) | The relay hides client IPs, so no per-IP lockout is possible host-side; the relay should cap connections per IP per `hostId`. Attacker can force the lock (DoS of pairing, never of already-paired devices) |
| T9 | **DoS (flood sessions, huge frames)** | `maxSessions` 32 **with eviction of the oldest unauthenticated session** so a half-open flood cannot lock the owner out; raw relay frame cap before JSON/base64 on both sides (~1.4 MiB), 1 MiB record cap, client response cap (64 MiB default), 16 HTTP + 8 WS per session (429 completes cleanly), backoff + jitter on the dial | Volumetric DoS is the relay's problem |
| T10 | **SSRF / path abuse via the mux** | Default-deny allowlist. The target is **canonicalized once** (`normalizeRelayTarget`): segments decoded, dot segments / encoded slashes / double-encoding / control chars rejected, re-encoded; the deny/allow decision is made on the decoded-lowercase form and the **canonical string is what handlers receive**, so validator and consumer cannot disagree. Denies `first-run`, `local-image`, `pair/redeem`, `enter`, `local-login`. Only 5 request headers are forwarded; `set-cookie` is stripped from every response | Allowed API surface is as powerful as an owner session: it IS owner access |
| T11 | **Host key theft** | File 0600 in a 0700 dir, in `HOME_SECRET_FILES` (S2 lockdown). Attacker with it can impersonate the host to pinned clients but cannot read recorded sessions (ephemeral `ee` gives forward secrecy). `vs host-key rotate` replaces the key atomically, the running host re-dials under the new id within 10 s, and every paired device is revoked unless `--keep-devices` (§11) | Relay clients need a new pairing link after rotation; the window between theft and rotation is the owner's to notice |
| T12 | **Downgrade** | One suite; version byte must be `0x01` and is hashed into the transcript, as is the suite label, so any future negotiation is bound | New versions need a new byte + label |
| T13 | **Revoked device keeps a session** | See T6: per-dispatch `isRevoked` + `revoke()` + 24 h session cap | Idle sockets without traffic live until the next frame or rekey |
| T14 | **Long-lived session key exposure** | Rekey: host closes a session after 24 h or 2^20 records (either direction) with a final encrypted `rekey` frame; the client re-handshakes and re-authenticates, which also re-checks revocation | None |
| T15 | **Relayed device treated as the PC itself (H1)** | Relayed traffic is **never proxied through a real loopback fetch**. It is dispatched in-process (`createInProcessDispatcher`) with a synthetic request carrying a frozen `req.relayDevice = {id}` and a non-loopback sentinel socket (`remoteAddress: "relay"`); `isRelayRequest(req)` lets `auth.mjs` classify it as remote; `auth.mjs` now does (§11: `authenticate` uses the channel identity and ignores cookies/token headers; `isLocal` / `isLocalBrowserSafe` / `hasLocalToken` are false) | A relayed owner device has owner powers (as designed); only the PC-only routes (`local-login`, `local-proof`, `pair/start` as the PC principal) stay out of reach |
| T16 | **hostId squatting at the relay (M1) / pairing link repoints a known host (X1 M-2)** | Self-certifying id, **default ON** `hostId = base64url(SHA-256(pub))` (`selfCertifyingHostId`, `connectRelay` rejects a `hostId` that is not base64url(SHA-256(pub)) unless `requireSelfCertifiedHostId: false`; `acceptPairingFragment` applies the same rule to links) so a squatter or a crafted link cannot present a valid pinned identity; clients never trust the relay's claim anyway because of the pin | Squatting still denies service and leaks client IPs/timing unless the **relay** authenticates `role=host` registration (proof of possession of `s`, e.g. relay ephemeral X25519 challenge + HMAC); one live host per `hostId`. Relay-side work, out of scope here |
| T17 | **Malicious/compromised static page (H3)** | See §2: separate VS-controlled origin, SRI, fragment stripped on load, APK bundles its own page | Whoever controls the origin controls the client; SRI only protects against tampering in transit/CDN |

## 4. Crypto choices and why
- **Pattern: Noise_NK-style** (client anonymous, host static key pinned). The design review judged this sound: it is Noise_NK with the MixHash/MixKey chain flattened into one HKDF, equivalent for a 2-message pattern. Hand-rolled on `node:crypto` / WebCrypto because no maintained Noise library runs identically in Node and an Android WebView (libp2p-noise is XX-only and heavy; others need sodium builds). The node reference client (`startClientHandshake`) cross-checks the browser client in tests; fixed transcript test vector included.
- **KEX: X25519** with two DHs: `es = DH(e_c, S)` (authenticates host) and `ee = DH(e_c, e_h)` (forward secrecy). All-zero DH output rejected on both sides.
- **Transcript**: `h = SHA256("vibesquad-relay-v1" || "Noise_NK_25519_AESGCM_SHA256" || version || len(hostId) || hostId || S || e_c || e_h)`.
- **KDF: HKDF-SHA-256**, ikm = `es || ee`, salt = `h`, info `"vs-relay-v1 keys"`, 64 bytes -> separate `c2h` and `h2c` keys.
- **AEAD: AES-256-GCM** (not ChaCha20-Poly1305 as the plan sketched): WebCrypto has no ChaCha, AES-GCM exists in both runtimes. Nonce = 32 zero bits || 64-bit counter, unique per key (keys are per session and per direction); counter cap 2^53, far under the deterministic-IV limit. The design review confirmed this choice.
- **Key confirmation**: the host's first record (`"vs-ok"`, ctr 0) is verified by the client before it sends anything.
- **X25519 on the client**: WebCrypto X25519 when the runtime has it (Chrome/WebView ≥ 133, Safari ≥ 17, Firefox ≥ 130), else **`@noble/curves` x25519** (audited, pure JS; new dependency approved by Hub5, `package.json` `@noble/curves 2.4.0`). `RelayUnsupportedError` no longer exists: "unsupported" would have meant "no access" for the Project PC. noble is used for X25519 only; AES-GCM/HKDF/SHA-256 stay on WebCrypto. Tests cover noble↔WebCrypto DH agreement, a noble-only client against the node host, and automatic fallback.
- **Rekey / no persisted keys (L4)**: channel keys and counters exist only in memory and are never written to disk or storage; any socket drop means a fresh handshake, never a resume. Sessions are capped at 24 h / 2^20 records.
- No padding: record sizes leak to the relay (accepted metadata).
- All crypto sits behind small pure functions (`acceptHandshake`, `startClientHandshake`/`startHandshake`, `createChannel`, `deriveKeys`, `transcriptHash`, `newKex`) so the suite is cheap to swap without touching the mux. Version byte `0x02` is reserved for an optional encrypted client static key in msg1 (IK), deliberately not built now: a client static stored next to the bearer token adds nothing against phone theft.

## 5. Key storage
- Host: `~/.vibesquad/host-keypair.json`, `{v:1, alg:"x25519", pub, priv}` (base64url raw), created atomically (0600 temp file, hard-link into place, EEXIST -> read winner), directory 0700. On Windows the user-profile ACL is the boundary unless the wiring adds it to the S2 lockdown list (below). Never logged, never sent.
- Host never writes `devices.json`; `redeem`/`authenticate`/`isRevoked` are injected callbacks.
- Client: pins `pub` per host in its own session store (E4a `hosts[]`, unwired); the token is stored like today's Meshnet session token. No channel keys are persisted.

## 6. Allowlist (S4/R2)
No shared constant existed (`isGatedRead` in `vibesquad-api.mjs` is a read-only loopback gate). The relay owns `normalizeRelayTarget` / `isRelayPathAllowed` plus exported `RELAY_DENIED_PREFIXES`. The wiring unit should also reject anything `isGatedRead` flags for non-owner relay principals.

## 7. Wiring design (rewritten for H1) and what the wiring phase must do

### Design: in-process dispatch, not loopback fetch
`auth.mjs` `isLocalBrowserSafe` treats a loopback request with Node's UA, no Origin and no Sec-Fetch-Site as the PC itself. A relay that forwards decrypted requests with a real `fetch("http://127.0.0.1:…")` would therefore make every relayed device look like the local owner (including `/__vibesquad/pair/start`). So:

```
createRelayHost({
  endpoint, hostId, hostKey,
  redeem:       ({code,label}) => auth.redeemPairCode(...)  -> {deviceId, token} | null   // writes devices.json in auth.mjs
  authenticate: (token)        => auth.deviceForToken(token) -> {deviceId} | null
  isRevoked:    (deviceId)     => !auth.deviceActive(deviceId)                              // re-reads devices.json, covers CLI revoke
  handleHttp:   createInProcessDispatcher(serverRequestListener),                           // synthetic req.relayDevice, no socket
  openWs:       (info) => <in-process ws handler using createSyntheticRequest(...)>,
  burnCodes:    () => auth.burnAllPairCodes(),
  onNeedsYou:   (e) => log needs-you security event,
})
```
and `auth.mjs` mints call `host.noteFreshMint()` after a new code exists.

### Wiring phase must do (needs `auth.mjs` / `serve.mjs`, not touched by this unit)
1. **`auth.mjs`**: `authenticate(req)` must honour `req.relayDevice` (device id established inside the channel; ignore cookies/Authorization on relay requests); `isLocal()` / `isLocalBrowserSafe()` must return **false** whenever `isRelayRequest(req)`; a relay request is never "local owner".
2. **`auth.mjs`**: expose `redeemPairCode`, `deviceForToken`, `deviceActive` (fresh read or mtime-checked reload of `devices.json`), `burnAllPairCodes`; call `relayHost.revoke(id)` from `revokeDevice` and cascade revoke; global per-code lockout belongs here too.
3. **L1**: add `host-keypair.json` to `HOME_SECRET_FILES` (`auth.mjs:150`) so the Windows icacls lockdown covers it; add a `vs host-key rotate` CLI that deletes the file and marks all devices for re-pair.
4. **L2**: add `/__vibesquad/local-login` and `/__vibesquad/local-login/nonce` as explicit server-side denies for relay principals (already in `RELAY_DENIED_PREFIXES`; this is defense in depth in `auth.mjs`).
5. **`serve.mjs`**: construct the tunnel from `settings.json relay.endpoint`; supply the in-process dispatcher and an in-process WS bridge; surface `status()` in the Host pill.
6. **H3**: SRI build step + VS-controlled static origin + CSP; entry module imports `remoteRelayTransport.ts` first.
7. **M1**: decide self-certifying `hostId` format with E4a; relay must authenticate `role=host` registration (proof of possession) and cap client connections per IP per `hostId`.
8. **Pairing link / `PairDeviceModal.tsx`**: generate `#hostId=&pub=&relay=&code=` links; call `noteFreshMint()` after each mint.
9. Request bodies must fit in one 1 MiB record; larger uploads need chunking (not built).
10. No relay server exists in this unit; the framing in the `relay-tunnel.mjs` header is the contract.

### Pin-store rule (X1 M-2; wiring contract for the E4a `hosts[]` store)
1. A stored pin (`hostId` -> `pub`) is **never overwritten by a pairing link**. A link whose `hostId` is already stored with a different `pub` is an error shown to the user, not a silent re-pair. (With self-certifying ids a crafted link can only name a *new* host.)
2. A stored token is **never sent to a host whose pin differs** from the one it was issued for: `authenticate` happens only after the handshake succeeded against the stored pin for that exact `hostId`.
3. Run `acceptPairingFragment` on every link before using it.

### E4b two-step confirm wording (L3)
The "approve on the minting phone or another owner device" step protects against **link or code leakage** (someone else redeems a code you minted). It does **not** protect against a stolen *unlocked* phone, which can approve itself. Stolen-phone defense is revocation (from another owner device, or `vs devices revoke` on the host) plus cascade revoke of every device it minted.

## 8. Resolved review questions
(a) hand-rolled NK: kept (design review). (b) AES-GCM + WebCrypto, `@noble/curves` for X25519 only. (c) No IK now; reserve version `0x02`. (d) Both: validate at session start **and** `isRevoked` on every dispatch.

## 9. X1 walk fix round (Fable high, `594d29e`: FAIL 1H/3M/6L)
| Finding | Fix | Where |
|---|---|---|
| H-1 guess counted after the await | counted synchronously when issued (redeem and auth), independent of `s.dead`; lock/burn at the limit; callbacks never exceed the limit | `server/relay-tunnel.mjs` `dispatch` |
| M-1 client ctr/wire order race | seal + send in one queued step | `src/remoteRelayTransport.ts` `sendFrame` |
| M-2 pin override via link | self-certifying hostId default ON; `acceptPairingFragment`; pin-store rule above | `remoteRelayTransport.ts`, §7 |
| M-3 ws slots / ordering | slot reserved synchronously (pending placeholder), per-session ordered dispatch queue; http/ws-open work started, not awaited | `relay-tunnel.mjs` `dispatch`, `runHttp`, `runWsOpen` |
| L-1 host seal cap | `seal` refuses >1 MiB; oversize `ws-data` closes only that stream (1009), oversize head becomes 502 | `relay-tunnel.mjs` |
| L-2 `headersSent` | real getter via `defineProperty` | `createSyntheticResponse` |
| L-3 code/token length | reject codes >16 and tokens >128 before callbacks | `dispatch` |
| L-4 `ws://` | `connectRelay` requires `wss:` | `remoteRelayTransport.ts` |
| L-5 keypair rename | no rename fallback: exclusive create, EEXIST reads the winner; directory chmod 0700 best effort | `loadOrCreateHostKeypair` |
| L-6 host header | synthetic requests carry `host: relay.invalid` | `createSyntheticRequest` |

## 10. X1 R2 walk fix round (`2aeec63`: new 1M/2L)
| Finding | Fix | Where |
|---|---|---|
| M: per-session dispatch queue retained decrypted frames with no depth cap while a callback was slow (PoC E: 150 x 1 MiB frames, +143 MiB heap behind one pending `redeem()`) | **Pre-decrypt frame budget.** `onRelayMessage` counts frames queued per session and checks the budget synchronously *before* base64-decoding or decrypting: exactly 1 in-flight frame before auth, `maxPendingFrames` (default 16) after auth. Overflow emits `backpressure-overflow` and closes the session. The count is released when each frame's dispatch finishes. Memory held behind a slow callback is therefore bounded to ~1 record pre-auth and ~16 post-auth per session | `server/relay-tunnel.mjs` `onRelayMessage`, `s.pending` |
| L: `openWs` errors swallowed | emits `ws-open-error` (reason capped at 200 chars) and answers `ws-open-res ok:false` for that stream only | `runWsOpen` |
| L: body streamed after an oversize head became a 502 | stream id recorded in `skipBody`; `runHttp` stops after the finished 502 | `send`, `runHttp` |

Residual: a legitimate client that fires more than 16 concurrent post-auth frames while the host is slow (e.g. a very slow `isRevoked`) is disconnected and must reconnect; the client already re-handshakes on any drop.

## 11. Wiring (`unit-and-end-e5-wire`, rev 4)
The core is now live in the server. Files: `server/relay-wiring.mjs` (new), `server/auth.mjs`, `server/serve.mjs`, `server/vibesquad-api.mjs`, `server/user-settings.mjs`, `server/relay-tunnel.mjs` (three additions), `src/remoteRelayTransport.ts`, `src/remoteSession.ts`, `cli/vs.mjs`; tests `test/relay-wiring.test.mjs` (new), `test/relay-tunnel.test.mjs`, `test/android-pair.test.mjs`, `test/helpers/fake-relay.mjs` (the in-memory untrusted relay, shared).

**Off by default.** `serve.mjs` calls `startRelayFromSettings` after the listeners are up; it returns null unless `~/.vibesquad/settings.json` has `relay.endpoint` and it is a `wss://` URL (`normalizeRelaySettings`). The key is hand-edited only: `saveUserSettings` carries it over but never takes it from an HTTP patch, like `remote`, so no paired device can point the host at a relay.

| §7 item | Done how | Where |
|---|---|---|
| 1 `authenticate` honours `relayDevice`; never local | `authenticate(req)` branches first on `isRelayRequest(req)` and looks the channel's device id up in `devices.json` (fresh stamp check); the cookie and every token header on such a request are ignored. `isLocal`, `isLocalBrowserSafe`, `hasLocalToken`, `hasLocalTokenHeader` are false for a relayed request whatever its synthetic socket or `Host`/`Origin` say, so `isLocalOwner` / `ownerProof`'s loopback half can never be true for it. The middleware then sees the relayed device exactly as a Meshnet device: `isTrusted` via `authenticate`, owner via `ownerProof`, agent headers never forwarded (5-header allowlist), gated reads and writes owner-only | `server/auth.mjs` `authenticate`, `authenticateRelayDevice`, `isLocal`, `isLocalBrowserSafe`, `hasLocalToken`, `hasLocalTokenHeader` |
| 2 callbacks | `redeem` → `redeemPairCode({ rawCode, ip: "relay", name })`: `paired` → `{deviceId, token}`, `pending` (device-minted code, E4b) → `{deviceId: pendingId, token, pending: true}`, else null. `authenticate` → `deviceForToken` (`{deviceId}` / `{pending: true}` / null, constant-time hash compare). `isRevoked` → `!deviceActive(id)`: one `statSync` per dispatch unless the file changed; unreadable = inactive. `burnCodes` → `burnAllPairCodes`. `onDeviceDropped` fires from `dropDeviceSockets`, the one place every revoke path reaches (UI/CLI `revokeDevice` incl. cascade, `revokeAllDevices`, `adoptDevices` after an external edit, the unreadable-file fail-close), and the wiring maps it to `relayHost.revoke(id)`. `onPairCodeMinted` fires from `createPairCode` and maps to `noteFreshMint()` | `server/auth.mjs` exports; `server/relay-wiring.mjs` `callbacks` |
| 3 L1 key file + rotation | `host-keypair.json` was already in `HOME_SECRET_FILES` (E4b MUST 6; verified, `auth.mjs:154`). `vs host-key show [--json]` prints the self-certifying id, fingerprint and public key only; `vs host-key rotate [--keep-devices]` calls `rotateHostKeypair` (new key created exclusively at a temp path, then renamed over the file: never a partial or missing file) and, unless `--keep-devices`, `revokeAllDevices()` (T11: a leaked host key may have phished tokens). The running wiring polls the file stamp every 10 s (`keypairFileStamp`, stat only): on a change it builds a new host under the new id, `revokeAll()`s the old one so every pinned client gets a relay close, stops it and re-dials. No restart needed; a deleted file is a rotation too | `server/relay-tunnel.mjs` `rotateHostKeypair`, `keypairFileStamp`; `server/relay-wiring.mjs` `checkKeyFile`; `cli/vs.mjs` `commandHostKey` |
| 4 L2 explicit denies | `/__vibesquad/local-login` and `/nonce` stay in `RELAY_DENIED_PREFIXES` (403 before the server sees them); should a future allowlist change let them through, `handleLocalLogin` / `handleLocalLoginNonce` / `handleLocalProof` all require `isLocalBrowserSafe`, which is false for a relayed request (tested: `/local-proof` reaches the handler and gets 403) | `auth.mjs`, `test/relay-wiring.test.mjs` |
| 5 `serve.mjs` tunnel + `openWs` + Host pill | `startRelayFromSettings({ requestListener: guardHandler(handle) })`: the SAME guarded listener the loopback server runs, so relayed HTTP (via `createInProcessDispatcher`) and relayed streams (via the new `createInProcessStreamBridge`) hit the identical middleware. The server has no WebSocket endpoint (the old `/ws` proxy is gone; the app streams over SSE), so `openWs` bridges a relayed `ws-open` to an in-process GET: each chunk the handler writes becomes a `ws-data` frame as it is written, the handler ending closes the stream with 1000, a non-2xx closes it with `4000+status` and sends no body, and a client close or a revoke destroys the synthetic request/response so the handler's own `close` listeners run (SSE cleanup). `set-cookie` never survives either path. `GET /api/auth/status` for a trusted caller now carries `relay: status()` (endpoint, hostId, pub, fingerprint, connected, sessions, redeemLocked; never key material) for the Host pill | `server/serve.mjs`, `server/relay-tunnel.mjs` `createInProcessStreamBridge`, `server/vibesquad-api.mjs` `setRelayStatus` |
| Pin-store rule | `src/remoteSession.ts` `saveRelayPin(hostId, {endpoint, pubKey})`: adds a relay host, or refreshes the endpoint of a host whose stored key is the same (base64/base64url compared as bytes), and throws `RelayPinMismatchError` when the stored key differs, leaving the store byte-identical. `relayPinFor(hostId)` is what the connect path must read: `connectRelay({ hostId, hostPubKey: stored.pubKey })` then `authenticate(token)`, so a token is only ever sent after a handshake pinned to the stored key for that exact id (rule 2). `acceptPairingFragment` stays the gate on every link (rule 3) | `src/remoteSession.ts`, `test/android-pair.test.mjs` |
| E4b pending over the relay | Protocol addition: `redeem-res { ok: true, pending: true, deviceId, token }` leaves the session unauthenticated; `auth-res { ok: false, pending: true }` for a token that is still a pending ticket. A pending auth is not a guess (the token is host-minted, 256-bit) so it costs neither the per-session nor the host-wide attempt budget; the 30 s unauthenticated-session timer and the 1-frame pre-auth backpressure still bound a poller. The TS client surfaces `pending: true` from `redeem` and throws `RelayPendingError` from `authenticate`. Approval happens over the relay too (`/pair/pending`, `/pair/approve` as the minting device), tested end to end incl. cascade revoke | `server/relay-tunnel.mjs` `dispatch`, `src/remoteRelayTransport.ts`, `test/relay-wiring.test.mjs` |

**Not in this unit (unchanged from §7):** 6 (SRI static origin + CSP), 7 (relay-side `role=host` proof + per-IP caps), 8 (`PairDeviceModal` relay links `#hostId=&pub=&relay=&code=` and the UI connect path that reads `relayPinFor`), 9 (upload chunking), 10 (no relay server). Until 8 lands the relay is reachable only by a client built against `remoteRelayTransport.ts` (the tests); the host side is complete.

**Threat-table deltas.** T6/T13: a revoke now closes relay sessions synchronously from every revoke path, not only on the next dispatch. T11 residual "no CLI yet" → `vs host-key rotate`, live rotation, devices revoked by default. T15 residual "depends on the wiring honouring `relayDevice`" → done and tested from both sides (in-process trust claims with a forged loopback socket, real local token header and a victim's cookie; and through the middleware: 401 unpaired, never the loopback 403 branch, never 200).

**Residual / open risks.** (a) The E4a `host-id` (public, `/api/auth/status`) and the E5 self-certifying relay id are different ids for the same PC, so a phone that paired over LAN and later adds the same PC's relay link holds two `hosts[]` entries until item 8 folds them (the trusted `/api/auth/status` now reports `relay.hostId` + `relay.pub`, which is what the fold needs). (b) The stream bridge forwards chunks as fast as the handler writes; a chatty SSE route to a slow relay buffers in the WebSocket send queue (same class as `http-body` chunks today). (c) `vs host-key rotate` on a Windows box while the server has the file open for reading can hit a transient `EPERM` on the rename; the CLI reports it and nothing changed (the temp key is removed). (d) Rotation revokes LAN devices as well by default; `--keep-devices` is the documented opt-out.
