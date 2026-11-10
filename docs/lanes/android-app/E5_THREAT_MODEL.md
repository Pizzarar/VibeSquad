# E5 Outbound E2EE Relay · Threat Model (branch `unit-and-end-e5`)

Status: DRAFT for the 0.3 `X1` security walk and the Fable design pass. Tier A. Core is new files only and **unwired**.
Files: `server/relay-tunnel.mjs` (host), `src/remoteRelayTransport.ts` (client), `test/relay-tunnel.test.mjs`.
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
- **Client device** (phone, Project PC browser): trusted once paired; holds the token and the pinned host pubkey.
- **Host process**: trusted. Boundary = the injected `handleHttp`/`openWs` loopback handler plus the allowlist; relay clients get no more than an authenticated remote caller gets.
- **Local users on the Home PC**: out of scope here (covered by the `~/.vibesquad` lockdown, S2).

Trust anchor: the host public key `pub` delivered **out of band** in the pairing link/QR (`#hostId=..&pub=..&relay=..&code=..`; fragment never reaches a server). The relay URL is NOT a trust anchor.

## 3. Threat table
| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T1 | **MITM / malicious relay impersonates host** | Client pins `pub`. Handshake derives keys from `DH(e_c, S)`; host proves possession of `s` via key-confirmation record. Wrong key -> confirmation decrypt fails, client aborts before sending any code/token. Transcript hash binds `hostId`, `S`, both ephemerals. | If the pairing link itself is intercepted (shown over an insecure channel) the attacker gets the pin. Link is single-use-code gated; show only on trusted screens |
| T2 | **Relay reads traffic** | AEAD records; relay only forwards opaque base64 (tested with a recording fake relay) | Metadata visible |
| T3 | **Tamper / bit-flip** | AES-256-GCM tag, AAD = direction + counter; any failure closes the session | None |
| T4 | **Replay / reorder / drop-and-continue** | Strict counter: receiver accepts only `ctr == expected`; per-direction keys stop reflection; fresh ephemerals per session stop cross-session replay | Relay can truncate or kill a session (DoS) but not forge |
| T5 | **Relay compromise** | Equivalent to T1-T4; relay holds no secrets. Relay cannot mint codes or tokens | Availability |
| T6 | **Stolen / lost phone** | Per-device token, revocable. `revoke(deviceId)` immediately closes that device's relay sessions; revocation of the token itself is `auth.mjs` (unwired). Cascade revoke is E4b | Window until owner revokes; token lives in phone storage |
| T7 | **Token theft in transit** | Redeem/auth happen only inside the E2EE channel; token never in a URL/header to the relay | Token at rest on client |
| T8 | **Brute-force the 6-digit code** | Host caps redeem/auth attempts per session (5, then close) and unauth sessions time out (30s); global per-IP/code lockout stays in `auth.mjs` (S2). Code is one-time and TTL'd by auth.mjs | Relay hides client IPs from host, so **per-IP lockout is blind**; auth.mjs must lock out per code/hostId globally (open item) |
| T9 | **DoS (flood sessions, huge frames)** | `maxSessions` 32, 1 MiB record cap, 16 concurrent HTTP and 8 WS per session, unauth timeout, backoff+jitter on the outbound dial | Relay-level volumetric DoS is the relay's problem |
| T10 | **SSRF / path abuse via the mux** | Default-deny allowlist (`isRelayPathAllowed`): only `/__vibesquad/*`, `/api/*`, `/ws`; denies `first-run`, `local-image`, `pair/redeem`, `enter`; rejects `..`, encoded slashes/dots, double-encoding, `//`, backslash, control chars, absolute URLs. Only 5 request headers are forwarded (no cookie/authorization/host/x-forwarded-*) | Allowed API surface is as powerful as an owner session: it IS owner access. Per-route owner gating remains the server's |
| T11 | **Host key theft** | File 0600 in `~/.vibesquad` (0700 dir). Attacker with it can impersonate the host to pinned clients (but cannot read past traffic: ephemeral DH gives forward secrecy for recorded sessions) | Rotation = delete file + re-pair everything (no rotation UX yet) |
| T12 | **Downgrade** | One suite; version byte must be `0x01` else reject; no negotiation | Future versions need a new byte + new transcript label |
| T13 | **Revoked device keeps an open session** | `revoke()` closes it; unwired `auth.mjs` must call it on DELETE/cascade | Depends on wiring (see §7) |
| T14 | **Client key compromise (ephemeral)** | Fresh `e_c` per session; compromise of a token does not reveal past sessions | Client is anonymous at the handshake level (NK, not XX/IK); identity = token inside the channel |

## 4. Crypto choices and why
- **Pattern: Noise_NK-style** (client anonymous, host static key pinned). Fits "phone knows host pub from QR; host does not know the phone until it redeems". Hand-rolled using only `node:crypto` / WebCrypto, **not a Noise library**, so no new dependency. Deviations from textbook Noise are documented below; the Fable pass should decide whether to move to a vetted Noise implementation.
- **KEX: X25519** with two DHs: `es = DH(e_c, S)` (authenticates host) and `ee = DH(e_c, e_h)` (forward secrecy). All-zero DH output rejected.
- **KDF: HKDF-SHA-256**, ikm = `es || ee`, salt = transcript hash `h`, info `"vs-relay-v1 keys"`, 64 bytes -> separate `c2h` and `h2c` keys.
- **AEAD: AES-256-GCM** (not ChaCha20-Poly1305 as the plan sketched). Reason: the client must run in a browser/Android WebView and **WebCrypto has no ChaCha20-Poly1305**; AES-GCM exists in both runtimes with no extra dependency. Nonces are never random: 96-bit = 32 zero bits || 64-bit counter, unique per key because keys are per-session and per-direction. Counter cap 2^53.
- **Key confirmation**: host's first record (`"vs-ok"`, ctr 0) is verified by the client before it sends anything.
- **Transcript binding**: `h = SHA256("vibesquad-relay-v1" || len(hostId) || hostId || S || e_c || e_h)`.
- **Known limitation**: WebCrypto X25519 needs Chrome/WebView >= 133, Safari >= 17, Firefox >= 130. The client probes support and throws `RelayUnsupportedError` with a clear message rather than shipping a hand-written curve. A pure-JS fallback (audited lib such as `@noble/curves`) is a possible later addition; it would be a justified new dependency, not added now.
- No padding: record sizes leak to the relay (accepted, listed under metadata).
- All crypto sits behind small pure functions (`acceptHandshake`, `startClientHandshake`, `createChannel`, `deriveKeys`, `transcriptHash`) so the suite can be swapped without touching the mux.

## 5. Key storage
- Host: `~/.vibesquad/host-keypair.json`, `{v:1, alg:"x25519", pub, priv}` (base64url raw), created atomically (0600 temp file, hard-link into place, EEXIST -> read winner), directory 0700. On Windows the user-profile ACL is the boundary (no POSIX mode). Not logged, never sent anywhere.
- Host never writes `devices.json`; redeem/authenticate are injected callbacks.
- Client: pins `pub` per host in its own session store (E4a `hosts[]`, unwired); the token is stored like today's Meshnet session token.

## 6. Allowlist (S4/R2)
No shared constant existed (`isGatedRead` in `vibesquad-api.mjs` is a read-only loopback gate). The relay owns a pure default-deny function `isRelayPathAllowed(method, target)` plus exported `RELAY_DENIED_PREFIXES`. The wiring unit should decide whether to also reject anything `isGatedRead` flags for non-owner relay principals.

## 7. Still unwired / open
- `serve.mjs`: construct `createRelayHost` from `relay.endpoint`, supply `handleHttp` (loopback fetch that attaches the device credential server-side) and `openWs`.
- `auth.mjs`: `redeem` (code -> token), `authenticate` (token -> deviceId), call `relay.revoke(deviceId)` on revoke and cascade revoke, global per-code lockout (T8), `pending-approval` two-step confirm (E4b).
- No relay server exists in this unit; the framing in the header of `relay-tunnel.mjs` is the contract. The relay must authenticate host registration (`role=host`) itself, or anyone can squat a `hostId` and receive ciphertext (still can't decrypt; DoS only).
- No UI, no `PairDeviceModal` link generation, no APK integration.
- Open design questions for review: (a) hand-rolled NK vs a vetted Noise lib; (b) AES-GCM vs ChaCha with a JS fallback; (c) whether to send a client static key to give the host a stronger device identity at handshake time (IK); (d) per-request token re-validation vs relying on `revoke()` closing sessions.
