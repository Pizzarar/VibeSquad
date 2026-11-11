# E4b Security Review (R2) · Fix Round `859ffeb` + Merge `087f8ec`

- **Branch:** `unit-and-end-e4b` (`859ffeb` + merge `087f8ec`, diff `6fbd60d..HEAD`)
- **Verdict:** **PASS** (0 High / 0 Medium / 0 Low)
- **Cause-vs-Symptom Gate:** **PASS** — All R1 and X1 walk findings are resolved at the root cause with no regressions.

---

## 1. R1 Findings Verification

- **Gemini-L1 (`server/auth.mjs:1309-1334`) — FIXED:** `handlePairApprove` now deletes `pendingId` before `mutateDevices` only on denial (`approve !== true`). On approval, `mutateDevices` runs first; if it fails with `"minter is no longer paired"`, `pendingId` is deleted and `403` is returned, whereas a transient 200 ms lock timeout or read error returns `503 { retryable: true }` while keeping `p` in `pendingDevices` so a subsequent retry within the 60 s TTL succeeds. Once `mutateDevices` succeeds, `pendingDevices.delete(pendingId)` executes synchronously before `await auditPairDecision(...)`.
- **Gemini-L2 (`server/auth.mjs:424-433`) — FIXED:** `adoptDevices(fresh, stamp)` now calls `discardPendingMintedBy(d.id)` alongside `dropDeviceSockets(d.id)` for every device removed by an out-of-process `vs devices revoke`.

---

## 2. Review of New R2 Changes & Merge Hunks

### 2.1 One live code per minter (`server/auth.mjs:939-953`)
- `createPairCode(ttlMs, mintedBy)` normalizes `minter = typeof mintedBy === "string" ? mintedBy : null` and deletes any existing entry in `codes` with `v.mintedBy === minter` before inserting the new code.
- Each paired device can hold at most one unredeemed code at a time (preventing code stacking), while minting on one device never invalidates the PC/CLI code (`minter === null`) or another device's code.

### 2.2 Pair decision audit entries (`server/auth.mjs:1338-1355`)
- `auditPairDecision({ approved, pending, minter })` appends a `needs-you` entry on approve and a `metric` entry on deny to `vibesquad` team log and `security` lane log via `appendVsLogEntry`.
- Contains only `pending.name`, `pending.ip`, `minter.name`, `device:<pending.id>`, and `mintedBy:<minter.id>`. No device token, token hash, or pairing code is written.
- Executed best-effort after `mutateDevices` and `pendingDevices.delete(pendingId)`, so a logging failure cannot break or roll back the approval decision.

### 2.3 "Already paired" guard on `/pair` redeem (`server/auth.mjs:1164-1170`)
- `handlePairRedeem` checks `if (parseCookies(req.headers.cookie)[DEVICE_COOKIE] && authenticate(req))` before the rate limiter and before `redeemPairCode`, returning `200` ("Already paired") with a link to `/__vibesquad/enter` and no `Set-Cookie` header.
- Prevents a paired-but-not-owner device (P1) from tricking an already-paired owner device into opening a P1-minted `/pair?code=` link, losing its live `vs_device` cookie, and becoming a child of P1. Also preserves the one-shot code if the minter accidentally opens its own pairing link. A revoked/stale `vs_device` cookie fails `authenticate(req)` and proceeds through normal redemption.

### 2.4 PC-owner mints & agent-caller exclusion (`server/auth.mjs:1113-1117, 1392`)
- `localOwner = !hasAgentHeaders(req) && isLocalOwner(req)` and `minter = localOwner || hasAgentHeaders(req) ? null : authenticate(req)`.
- Any request carrying `x-vs-agent-id` (`hasAgentHeaders(req)`) gets `localOwner = false` and `minter = null`, failing with `403` in `handlePairStart` (and `403` in `handleDevices` via `!ownerProof(req)`).
- A loopback owner request (`local-token` header or `vs_local` cookie, no agent headers) sets `localOwner = true` and `minter = null` even if the browser also carries a `vs_device` cookie, so PC-owner mints skip the two-step approval (`requiresApproval: false`, `mintedByDeviceId: null`).
- A remote paired browser (`localOwner = false`, `minter = authenticate(req)`) still sets `requiresApproval: true` and `mintedByDeviceId: minter.id`.

### 2.5 `PairDeviceModal` pending approval UI & CSS (`src/PairDeviceModal.tsx:234-264, 691-712`, `src/styles.css:6307-6318`)
- When `pair?.requiresApproval` is true, `PairDeviceModal` polls `/__vibesquad/pair/pending` every 2 s and renders Approve/Deny actions posting to `/__vibesquad/pair/approve`.
- Every class in the block (`preview`, `pair-pending`, `field-label`, `muted`, `small`, `pair-pending-item`, `btn`, `ghost`) has a corresponding CSS rule in `src/styles.css` (`.pair-pending` and `.pair-pending-item` added at lines 6307–6318, verified by `test/css-classes.test.mjs`).

### 2.6 `withFileLockSync` holder-turnover deadline reset (`server/file-lock.mjs:52-63`)
- Resets `deadline = Date.now() + timeoutMs` only when a non-null `key = "${info.pid}:${info.startedAt}"` changes between polls (lock actively turning over across writers), while still timing out after `timeoutMs` (`200` ms on request paths) when a single lock holder stalls.

---

## 3. Verification Evidence

Command run:
```
node --test --import ./test/setup/hermetic.mjs test/sec-phone-mint-pair.test.mjs test/sec-s2-http.test.mjs test/file-lock.test.mjs test/android-pair.test.mjs test/cli-devices.test.mjs test/css-classes.test.mjs test/public-release.test.mjs && npm run typecheck
```
Result: **139 tests, 38 suites, 139 passed, 0 failed**; `tsc --noEmit && tsc --noEmit -p tsconfig.server.json` exited `0`.
