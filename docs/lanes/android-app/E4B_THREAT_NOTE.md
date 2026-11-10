# E4b Phone-Minted Pairing · Threat Note (branch `unit-and-end-e4b`)

Status: rev 1, written before implementation (Tier A, 0.3 `X1`). Plan: `docs/PLAN_ANDROID_END_STATE.md` E4b. Prior walk: `X1_E4A_WALK.md` / `X1_E4A_WALK_R2.md` (M3, L3 and the four R2 Lows land here).
Files: `server/auth.mjs`, `server/file-lock.mjs`, `server/local-token.mjs`, `server/vibesquad-api.mjs`, `server/serve.mjs`, `cli/vs.mjs`, `src/PhonePairSheet.tsx`, `src/phonePairLogic.ts`, `src/PhoneCockpit.tsx` (slot only), `src/App.tsx`, `test/sec-phone-mint-pair.test.mjs`.

## 1. Assets
| Asset | Why it matters |
|---|---|
| Full owner control of the Home PC | Every `/__vibesquad/*`, `/api/*` route once a request authenticates as a paired device |
| Per-device token (`devices.json` holds only its SHA-256) | Bearer credential; a token in `devices.json` is owner access until revoked |
| Master local token (`~/.vibesquad/local-token`) | Owner access from loopback; `vs pair` used to send it blind (X1 L3) |
| 6-digit pairing code | Converts to a device token; 5 min TTL, one shot |
| Pending-approval ticket (token minted at redeem, not yet in `devices.json`) | Becomes owner access the moment the minting device taps Approve |
| `devices.json` integrity | A lost update can resurrect a revoked device (X1 M1) or wipe the list (X1 M2) |
| Host X25519 key (`~/.vibesquad/host-keypair.json`, E5) | Host identity for the relay; must be in the home lockdown list |
| Device inventory (ids, names, last-seen, IPs) | Reconnaissance for a local non-owner process (X1 M3) |

## 2. Attacker positions
- **P1 Paired-but-not-owner device.** A device paired earlier (a friend's phone, a lost phone before revoke, a work PC browser) that is still in `devices.json`. Today every paired device has owner authority, so P1 can mint codes. E4b must stop P1 from turning one paired device into an unbounded fan-out of new devices, and must let the owner remove the whole tree at once.
- **P2 Holder of a minted code / link.** Someone who sees the code or QR on the phone screen, in a screenshot, over a shoulder, or in a shared link. Codes are one shot and 5 min, but a phone-minted code is shown on a mobile screen in public places.
- **P3 Local non-owner process or OS user on the Home PC.** Can open TCP to `127.0.0.1:4180` with any headers, but has no `local-token` (home dir is locked down). X1 M3: it could read the device list. Hub5 MUST: it must not mint.
- **P4 Rogue loopback listener.** The VS server is down and another local process bound the port. `vs pair` would send the master token to it (X1 L3).
- **P5 Suspended or stale writer.** A `vs devices` process that holds `<devices.json>.lock` and stalls (debugger, suspended SSH job, pid reuse). R2 L1/L4.
- **P6 Filesystem fault.** `devices.json` unreadable or malformed (AV, hand edit, half rename). R2 L2.
- **P7 Network observer of the LAN/Meshnet.** Already handled by TLS + CA pin (0.3 A1); E4b adds no plaintext path.

## 3. MUSTs and how each closes a position
| MUST | Mechanism | Closes |
|---|---|---|
| 1 Phone-minted pairing | `POST /__vibesquad/pair/start` keeps accepting an authenticated paired device. The code entry now records `mintedBy = <device id>` (null when the PC or CLI minted it). The phone `⋯` sheet shows code, QR and link. | Feature; the guards below bound it |
| 2 Two-step confirm | Redeeming a code with `mintedBy` set does **not** write `devices.json`. The new device gets a token cookie whose hash lives only in an in-memory `pending` map `{ hash, name, ip, mintedBy, expiresAt }` with a 60 s TTL. `authenticate()` reads `devices.json` only, so a pending token authenticates nothing anywhere (HTTP, SSE, E5 relay `isRevoked`, CLI list). The redeem response is a "waiting for approval" page that polls public `GET /pair/status` (cookie-scoped, returns only `pending / approved / denied`). `POST /__vibesquad/pair/approve { pendingId, approve }` is accepted only when `authenticate(req).id === pending.mintedBy`; under the lock it re-checks that the minting device is still on disk, then appends the device with `mintedByDeviceId`. Deny, expiry, a server restart, or revoking the minter discards the pending entry. | P1 (a paired device cannot add devices without the minting phone's second tap), P2 (a stolen code yields a pending ticket, visible as "Approve X from <ip>?" on the minting phone, which the owner denies) |
| 3 `mintedByDeviceId` + cascade revoke | Every approved device records `mintedByDeviceId` (null for PC/CLI-minted). `revokeDevice(id)` computes the closure over `mintedByDeviceId` inside **one** `mutateDevices` callback (one lock, one read, one atomic write), splices every member, drops their sockets and their pending tickets, and returns the removed ids. UI and CLI show the cascade. | P1 (revoking the root removes every device it minted, recursively; no orphaned descendants keep access), X1 M1 (one locked write, so a concurrent CLI write cannot interleave halfway through the cascade) |
| 4 `pair/start` loopback gate + M3 | `handlePairStart` requires `isLocalOwner(req) || authenticate(req)` itself, not only via the router. `/__vibesquad/devices` and `/__vibesquad/pair/pending` are added to `isGatedRead`, and `handleDevices` also checks `isLocalOwner || authenticate` in the handler. | P3 (no mint, no inventory without the local token or a paired cookie) |
| 5 `vs pair` never sends the master token blind | New public loopback route `GET /__vibesquad/local-proof?c=<32 hex>` answers `HMAC-SHA256(localToken, "vs-local-proof\0" + c + "\0" + req.socket.localPort)`. `proveLocalServer()` in `server/local-token.mjs` sends a fresh random nonce, verifies the HMAC with the token it holds, and only then does `requestPairStart` send `x-vibesquad-token`. Rationale: the server proves knowledge of the token first; HMAC is a PRF so the public oracle leaks nothing; the fresh nonce defeats replay; binding the accepted socket's local port stops a rogue listener on port X from relaying the challenge to a real server on port Y. This is the simplest design that keeps the existing header auth unchanged for every other caller. | P4 |
| 6 `host-keypair.json` in `HOME_SECRET_FILES` | POSIX lockdown chmods it 0600 at startup (Windows: the home ACL already covers it). | Local readers of the E5 host key |
| 7 R2 Lows | L1: `mutateDevices` takes `timeoutMs`; request paths (last-seen persist, pair redeem, approve, UI revoke) pass 200 ms, the CLI keeps 5 s. L2: a failed `loadDevices` read destroys every tracked socket. L3: `handleRevoke` maps mutate failures to a generic retryable 503 with no path or pid; only a bad body is 400. L4: `withFileLockSync` hands `fn` a `lock.assertOwned()` that re-reads `<file>.lock` and throws if its `{pid, startedAt}` is no longer ours; `writeDevicesFile` calls it right before the rename, `updateJsonFileSync` right before its atomic write. | P5 (a stalled holder can no longer freeze the event loop for 5 s per request, and a reaped holder that resumes cannot overwrite a newer list), P6 (fail closed includes live streams; no path/pid leaks to a paired caller) |
| 8 Devices + revoke in `⋯` | The sheet lists devices (name, last seen, this-device badge, minted-by) with Revoke. `descendantsOf(devices, id)` from the public `mintedByDeviceId` field drives a cascade warning ("also revokes N devices it paired") that needs a second tap. | Owner usability for MUST 3; no new attack surface (same routes as the desktop modal) |

## 4. Residual risks
- A pending ticket is in memory only: a server restart during the 60 s window drops it and the new device re-pairs. Chosen on purpose so `devices.json` never contains anything that is not an approved device.
- The minting device is the only approver (not any owner device, not the PC). If that phone is lost between mint and approve, the ticket expires in 60 s.
- `vs open` / `requestLocalLoginUrl` and `requestWorkerSweep` still send the header first (older pattern, X1 L3 "shared"). `proveLocalServer()` is written so they can adopt it; wiring them is a follow-up, not in this unit.
- E5 relay wiring (`redeem()` for relay clients) is out of scope. `redeemPairCode()` is factored so the relay can reuse it and will see `state: "pending"` for phone-minted codes.
