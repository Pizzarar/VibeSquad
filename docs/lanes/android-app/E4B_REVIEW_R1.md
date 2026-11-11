# E4b Security Review (R1) · Phone-Minted Pairing & X1 Guards

- **Branch:** `unit-and-end-e4b` (`6fbd60d` + merge `ba79415`)
- **Spec & Threat Note:** `docs/lanes/android-app/SPEC.md`, `docs/lanes/android-app/E4B_THREAT_NOTE.md`
- **Verdict:** **PASS** (0 High / 0 Medium / 2 Low)
- **Cause-vs-Symptom Gate:** **PASS** — Every change addresses the underlying cause directly: phone-minted codes redeem into an in-memory `pendingDevices` map rather than `devices.json` until the minting device approves under lock; cascade revocation computes the transitive closure inside a single locked `mutateDevices` transaction; `vs pair` verifies server possession of `local-token` via a port-bound HMAC challenge before sending `x-vibesquad-token`; and `withFileLockSync` verifies `{ pid, startedAt }` ownership immediately prior to atomic rename.

---

## 1. Attack Surface Evaluation

### 1.1 Non-owner mint, approve, or privilege escalation
- **Loopback minting (`server/auth.mjs:996-1007`, `server/vibesquad-api.mjs:1531`):** `handlePairStart` enforces `if (!isLocalOwner(req) && !minter)` directly in the handler in addition to the router gate. A tokenless local process (browser or non-browser) receives `403`.
- **Device inventory & pending list (`server/vibesquad-api.mjs:313`, `server/auth.mjs:1159-1167, 1239-1250`):** `/__vibesquad/devices` and `/__vibesquad/pair/pending` are in `isGatedRead`, and `handleDevices` / `handlePairPending` enforce `isLocalOwner(req) || authenticate(req)` (`authenticate(req)` only for `handlePairPending`).
- **Pending token isolation (`server/auth.mjs:551-574, 1124-1132`):** Redeeming a phone-minted code (`entry.mintedBy !== null`) stores `{ id, tokenHash, name, ip, mintedBy, createdAt, expiresAt }` only in the in-memory `pendingDevices` map and never writes `devices.json`. Because `authenticate(req)` reads `loadDevices()` (`devices.json`), a pending `vs_device` cookie authenticates nothing on HTTP, SSE, or CLI device listing.
- **Approver binding (`server/auth.mjs:1174-1211`):** `handlePairApprove` requires `dev = authenticate(req)` and checks `p.mintedBy !== dev.id` before mutating state. Neither another paired device, nor the pending device itself, nor the loopback PC owner token (`local-token`) can approve or deny a phone-minted ticket. Inside `mutateDevices`, `if (!list.some((d) => d.id === dev.id))` re-verifies under `<devices.json>.lock` that the minting device is still present on disk before appending the new device.

### 1.2 Ticket replay and race conditions
- **One-shot pairing codes (`server/auth.mjs:1110-1117`):** `redeemPairCode` deletes both normalized and raw code keys synchronously before checking expiry or minting state.
- **Double approve / wrong-device DoS (`server/auth.mjs:1188-1192`):** `p.mintedBy !== dev.id` is checked before `pendingDevices.delete(pendingId)`, preventing a different paired device from burning or denying a pending ticket. Because `sweepPending()`, `pendingDevices.get(pendingId)`, and `pendingDevices.delete(pendingId)` run synchronously after `await readBody(req)`, concurrent approve requests cannot double-insert a device.
- **Expiry & minter revocation (`server/auth.mjs:744-747, 775-781, 1125-1128`):** `PENDING_TTL_MS` (60 s) is enforced by `sweepPending()` on every read/approve/status check. In-process `revokeDevice` calls `discardPendingMintedBy(rid)` for every revoked device in the cascade, and `redeemPairCode` verifies that `entry.mintedBy` is still in `loadDevices()` at redeem time.

### 1.3 Transitive cascade revocation and cycle safety
- **Transitive closure (`server/auth.mjs:519-532`, `src/phonePairLogic.ts:17-30`):** `cascadeIds(list, id)` and `descendantsOf(devices, id)` compute the fixed-point closure over `mintedByDeviceId` using a `Set`. Because the set can only grow by elements present in the finite `list`, cycles and self-references terminate in at most `list.length` iterations.
- **Single locked transaction (`server/auth.mjs:734-749`):** `revokeDevice(id)` computes `cascadeIds(list, id)` and splices all matching devices inside a single `mutateDevices` callback (one lock acquisition, one disk read, one atomic write), preventing concurrent CLI writes from interleaving mid-cascade.

### 1.4 Constant-time secret comparisons
- `authenticate` (`server/auth.mjs:559`), `pendingForToken` (`server/auth.mjs:790`), `sameSecret` (`server/auth.mjs:629`), and `proveLocalServer` (`server/local-token.mjs:68`) all check buffer byte lengths and compare via `crypto.timingSafeEqual`.

### 1.5 Loopback server proof (`vs pair` / X1 L3)
- **Oracle resistance (`server/auth.mjs:1215-1237`):** `handleLocalProof` is gated by `isLocalBrowserSafe(req)`, validates `c` against `/^[0-9a-f]{32}$/`, and computes `HMAC-SHA256(localToken, "vs-local-proof\0" + c + "\0" + port)`. With a 256-bit random `localToken` and domain prefix `"vs-local-proof\0"`, the endpoint is a PRF with no secret leakage or cross-protocol reuse.
- **Cross-port relay defense (`server/auth.mjs:1235`, `server/local-token.mjs:55-70`, `cli/vs.mjs:2032`):** The server binds the MAC to `req.socket.localPort` (the kernel-assigned listening port of the accepted socket, not the `Host` header), and `proveLocalServer` verifies the MAC against the target `port` before `requestPairStart` sends `x-vibesquad-token`. A rogue listener on port `X` relaying the challenge to a real server on port `Y` receives a proof for `Y`, which fails verification for `X`.

### 1.6 CSRF, Origin, SameSite, and framing posture
- `vs_device` remains `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000` (`server/auth.mjs:1080`).
- `GET /pair/status` (`server/auth.mjs:1146-1156`, `server/serve.mjs:427`, `server/vibesquad-api.mjs:1521`) is read-only, cookie-scoped (`SameSite=Strict`), sets `Cache-Control: no-store, no-cache, must-revalidate`, and returns only `{ state: "pending" | "approved" | "denied" | "gone" }`.
- All HTML responses in `handlePairRedeem` go through `sendHtml` -> `setNoFraming` (`X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`).

### 1.7 Lock budget, fail-closed streams, and ownership TOCTOU (X1 R2 Lows)
- **L1 (`server/auth.mjs:357, 472-496, 1134, 1204, 1283`):** Request-path `mutateDevices` calls pass `{ timeoutMs: REQUEST_LOCK_MS }` (`200` ms), while CLI callers keep the 5000 ms default.
- **L2 (`server/auth.mjs:442-448`):** When `readDevicesFromDisk()` throws in `loadDevices()`, all tracked sockets in `wsByDevice` are destroyed immediately via `dropDeviceSockets(id)`.
- **L3 (`server/auth.mjs:1281-1287`):** `handleRevoke` catches `mutateDevices` errors and returns a generic `503 { error: "device list busy or unreadable; retry", retryable: true }` with no filesystem path or holder PID.
- **L4 (`server/file-lock.mjs:74-88, 112`, `server/auth.mjs:458`, `runner/lock.mjs:70-72`):** `withFileLockSync` captures `mine = readLock(lockFile)` after lock creation and exposes `lock.assertOwned()`, which re-reads `<targetPath>.lock` and verifies `now.pid === process.pid` and `now.startedAt === mine.startedAt`. Both `writeDevicesFile` (right before `renameSync`) and `updateJsonFileSync` (right before `writeFileAtomic`) call `assertOwned()`.

### 1.8 Secret handling & UI escaping
- `HOME_SECRET_FILES` (`server/auth.mjs:154`) includes `"host-keypair.json"` for `0600` POSIX lockdown at startup.
- `handlePairRedeem` escapes `r.mintedByName` with `escapeHtml` (`server/auth.mjs:1085, 1095`) before interpolating it into the waiting page HTML.
- `PhonePairSheet.tsx` renders device names, IPs, and cascade warnings as React text nodes; `qr` SVG comes exclusively from server-generated `qrSvg()`.

---

## 2. Findings (0 High / 0 Medium / 2 Low)

### [L1] `handlePairApprove` deletes the pending ticket before `mutateDevices`, making a 503 lock-timeout non-retryable
- **Location:** `server/auth.mjs:1192` and `server/auth.mjs:1206-1209`
- **Detail:** In `handlePairApprove`, `pendingDevices.delete(pendingId)` runs at line 1192 before `mutateDevices(..., { timeoutMs: REQUEST_LOCK_MS })` at line 1199. If `mutateDevices` fails due to a transient 200 ms lock timeout (e.g., concurrent CLI `vs devices` command holding `<devices.json>.lock`), line 1208 responds with `503 { error: "device list busy or unreadable; retry", retryable: true }`, but the ticket has already been removed from `pendingDevices`. Any retry by the minting phone gets `404 ("no such pending device")`, and the waiting device's next `/pair/status` poll transitions to `"gone"`.
- **Recommendation:** Either keep `p` in `pendingDevices` when `mutateDevices` throws a transient lock/read error (deleting `pendingId` only on deny, success, or `"minter is no longer paired"`), or do not mark the 503 response `retryable: true`.

### [L2] External CLI device revocation (`adoptDevices`) does not purge in-memory `pendingDevices` minted by the removed device
- **Location:** `server/auth.mjs:424-433`
- **Detail:** In-process revocation (`revokeDevice`, line 746) calls both `dropDeviceSockets(rid)` and `discardPendingMintedBy(rid)`. When an external process (`vs devices revoke <id>`) removes a device from `devices.json` and the server reloads the file in `adoptDevices(fresh, stamp)`, it calls `dropDeviceSockets(d.id)` for vanished devices but does not call `discardPendingMintedBy(d.id)`. This is not exploitable—the revoked minter cannot pass `authenticate(req)` or the on-disk check in `handlePairApprove`, so the ticket can never be approved and expires within 60 s—but calling `discardPendingMintedBy(d.id)` in `adoptDevices` would let a waiting page polling `/pair/status` see `"gone"` immediately rather than waiting out the remaining TTL.

---

## 3. Verification Evidence

Command run:
```
node --test --import ./test/setup/hermetic.mjs test/sec-phone-mint-pair.test.mjs test/sec-s2-http.test.mjs test/file-lock.test.mjs test/android-pair.test.mjs test/cli-devices.test.mjs test/css-classes.test.mjs test/public-release.test.mjs && npm run typecheck
```
Result: **133 tests, 37 suites, 133 passed, 0 failed**; `tsc --noEmit && tsc --noEmit -p tsconfig.server.json` exited `0`.
