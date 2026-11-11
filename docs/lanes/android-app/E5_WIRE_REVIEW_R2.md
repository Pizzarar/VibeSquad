# E5 Outbound E2EE Relay Wiring · Tier A Review R2 (`05a0b9c` + `1e8a635`)

**Verdict:** PASS (`0H / 0M / 0L`)
**Branch:** `unit-and-end-e5-wire` (commits `05a0b9c` and `1e8a635`)
**Diffs Reviewed:** `git diff 224291b..05a0b9c` (X1 wire M1 + L1) and `git show 1e8a635` (R1 #1 fix)
**Tests:** 139/139 pass across 48 suites (`4700.2ms`, `node --test --import ./test/setup/hermetic.mjs test/relay-tunnel.test.mjs test/relay-wiring.test.mjs test/sec-s2-http.test.mjs test/android-pair.test.mjs`), `npm run typecheck` clean (`0`).

---

## (a) Verification of Fix Commits

| Item | Commit | Status | Evidence (`file:line`) |
|---|---|---|---|
| **X1 Wire M1:** Out-of-process `devices.json` revoke and unreadable fail-close reach open relay streams & idle sessions without waiting for a new client dispatch | `05a0b9c` | **FIXED** | `server/relay-tunnel.mjs:545-546,602-606,750-752,779-781`: `createRelayHost` fires `onAuthenticated(s.deviceId, s.cid)` on successful `redeem` (non-pending) and `auth`, and `onSessionClosed(cid, s.deviceId)` in `closeSession`. `server/relay-wiring.mjs:68,89-106`: `onAuthenticated` creates an `EventEmitter` shim with `shim.destroy = () => { if (shim.destroyed) return; shim.destroyed = true; host.revoke(deviceId); }` and registers it via `auth.mjs` `trackSocket(deviceId, shim)`; `onSessionClosed` deletes the shim from `shims`, marks `shim.destroyed = true`, and emits `"close"` so `wsByDevice` removes it. Tested at `test/relay-wiring.test.mjs:306-399`. |
| **X1 Wire L1:** `publicRelayEndpoint` strips userinfo, query, and fragment from `status()` and startup logs | `05a0b9c` | **FIXED** | `server/relay-wiring.mjs:65,170,203,212-215`: `publicRelayEndpoint(endpoint)` returns `${u.origin}${u.pathname}` while `createRelayHost` dials the full `cfg.endpoint` (`:136`). `api.endpoint` and `api.status().endpoint` expose only `publicEndpoint`. Tested at `test/relay-wiring.test.mjs:401-430`. |
| **Review-Gemini R1 #1:** `createInProcessStreamBridge` attaches `res.on("close", () => finish(1000))` so a handler calling `res.destroy()` directly still runs `finish()` and destroys `req` | `1e8a635` | **FIXED** | `server/relay-tunnel.mjs:495-498`: `res.on("close", () => finish(1000))` triggers idempotent `finish()`, which closes the relay stream and calls `req.destroy()` so `req.on("close")` listeners always fire. Tested at `test/relay-tunnel.test.mjs:1247-1272`. |

---

## (b) Deep-Dive Check: Out-of-Process Revoke & Unreadable `devices.json` Path

Note on R1: I was wrong in R1 to state that out-of-process revokes cut open relay streams without a request in flight. In `224291b`, `authenticateRelayDevice` (`server/auth.mjs:647`) intentionally omitted `trackSocket`, so when no LAN socket was open, `wsByDevice.size` was `0` and the 1 s `ensureDeviceWatch()` timer (`server/auth.mjs:410-421`) was not running; even if a LAN socket kept the watch running, an unreadable `devices.json` (`server/auth.mjs:467`) iterated only `wsByDevice.keys()` and never called `dropDeviceSockets(relayDeviceId)`. Thus an idle relay session or a one-way SSE stream (`/__vibesquad/runner/events`) with no client-to-host frame in flight stayed open until the next client frame triggered `dispatch` -> `isRevoked`.

**Verification of the `05a0b9c` fix across all lifecycle transitions:**
1. **Registration & Watch Startup (`server/relay-wiring.mjs:89-99`, `server/relay-tunnel.mjs:750-752,779-781`):**
   - As soon as a relay session authenticates (via `redeem` at `:751` or `auth` at `:780`), `onAuthenticated(s.deviceId, s.cid)` creates a socket-shaped `EventEmitter` (`typeof shim.once === "function"` and `typeof shim.destroy === "function"`) and passes it to `trackSocket(deviceId, shim)` (`server/auth.mjs:423-434`).
   - `trackSocket` adds `shim` to `wsByDevice.get(deviceId)` and starts the 1 s `ensureDeviceWatch()` interval (`server/auth.mjs:410-421`).
2. **Out-of-Process Revoke (`vs devices revoke` or external file edit):**
   - Within 1 s, `deviceWatch` calls `loadDevices()` (`server/auth.mjs:418,457-472`), which sees the new `devicesFileStamp()`, calls `adoptDevices(fresh, stamp)` (`:441-454`), and invokes `dropDeviceSockets(d.id)` for every removed device.
   - `dropDeviceSockets` calls `s.destroy()` on each shim in `wsByDevice` (`:400`) and invokes `deviceDroppedListeners` (`:402-406`), both of which call `host.revoke(deviceId)` -> `closeSession(s.cid)` (`server/relay-tunnel.mjs:935-943`).
3. **Unreadable / Corrupt `devices.json` Fail-Close (`server/auth.mjs:463-468`):**
   - Because `wsByDevice` now holds the shim for every authenticated relay session, `for (const id of [...wsByDevice.keys()]) dropDeviceSockets(id)` includes every relay-connected `deviceId`, destroying its shim and revoking its relay sessions within 1 s even with zero client frames in flight.
4. **Termination, Re-entrancy, and Key Rotation Cleanup (`server/relay-tunnel.mjs:589-607`, `server/relay-wiring.mjs:100-106,139-149`):**
   - `closeSession(cid)` deletes `cid` from `sessions` *first* (`:592`), closes all `s.ws` streams (`:594-599`), and then calls `onSessionClosed(cid, s.deviceId)` (`:602-606`).
   - If `shim.destroy()` triggered `host.revoke(deviceId)` -> `closeSession(s.cid)`, `onSessionClosed` deletes `cid` from `shims`, sets `shim.destroyed = true`, and emits `"close"`, which removes `shim` from `wsByDevice` and allows `deviceWatch` to stop once `wsByDevice` is empty.
   - If the session closes for any other reason (client disconnect, relay socket drop in `down()`, `stop()`, or key rotation `old.revokeAll()` in `adoptKey`), `closeSession` fires `onSessionClosed(cid)`, which emits `"close"` on the shim and removes it from both `shims` and `wsByDevice` — no leaked shims or dangling `host` references across rotations.

---

## (c) Cause-vs-Symptom Gate

- **PASS:** Both X1 findings and the R1 low finding were fixed at their root causes (unifying relay session tracking with `auth.mjs`'s `trackSocket` watch lifecycle, stripping credentials/queries from public endpoint strings via URL parsing, and routing direct `res` close events through `finish()`).

PASS — 0H / 0M / 0L
