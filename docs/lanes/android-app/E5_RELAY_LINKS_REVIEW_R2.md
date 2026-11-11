# E5 Relay Pairing Links & Pinned Connect Path · Tier A Security Review R2 (`unit-and-e5-relay-links` @ `663cb8d` / `6082985`)

VERDICT: PASS 0H/0M/0L

- **Branch / Commits**: `unit-and-e5-relay-links` (`0c28094` + R1 fixes `663cb8d` + docs `6082985`, `git diff 0e05c85..6082985`)
- **Prior Review**: `docs/lanes/android-app/E5_RELAY_LINKS_REVIEW_R1.md` (`FAIL 0H/2M/3L`)
- **Cause-vs-symptom gate**: **Fixes the cause** across all five R1 findings and X1 walk items. Stale relay pins are evicted when a LAN address changes PC identity (`hostId` or `caFp`), `foldRelayHost` enforces E4a's two-factor `samePc(id, caFp)` invariant in both pairing orders (LAN→Relay and Relay→LAN) while keeping `relayEntryIndex` isolated from LAN `hostId` claims, device-minted `pending` tickets are stored in `pendingToken` beside any working `token` until approved, relay-only pairings can be forgotten via `forgetHost` and `RemotePairScreen`, and `diagOverlay` strips the entire `#fragment` before logging boot URLs.

---

## R1 Finding Verification

| R1 ID | Finding | R2 Status | Root-Cause Evidence |
|---|---|---|---|
| **Gemini M1** | `saveSession` and `setSessionHostId` carried a previous PC's `relay` pin and bearer token onto a different PC at the same LAN address | **FIXED (PASS)** | `src/remoteSession.ts:314` deletes `entry.relay` whenever `same` has a conflicting `hostId` (`id && same.hostId && same.hostId !== id`) or conflicting `caFp` (`fp && same.caFp && same.caFp !== fp`). `src/remoteSession.ts:333` deletes `merged.relay` in `setSessionHostId` when replacing a non-empty `s.hosts[i].hostId`. Verified in `test/relay-links-r1.test.mjs:71-114`. |
| **Gemini M2 / X1 M1 / X1 P4 / X1 I4** | `foldRelayHost` matched on public `e4aHostId` alone (ignoring `caFp` on cloned `~/.vibesquad` or spoofed `hostId`), Relay→LAN order failed to fold, and `relayEntryIndex` matched LAN entries by `hostId` | **FIXED (PASS)** | `src/remoteSession.ts:408-411` (`relayEntryIndex`) matches `h.relay?.hostId === relayId` first, then `h.hostId === relayId && !h.meshnetHost` (never a LAN entry by `hostId`, fixing X1 P4). `src/remoteRelayConnect.ts:190-202` reads `caFingerprint.full` from `/api/auth/status` over the pinned, authenticated relay channel and passes `caFp` to `foldRelayHost`. `src/remoteSession.ts:497-533` checks `ri < 0 || !s.hosts[ri].relay` (X1 I4), uses `samePc(h, me)` (`hostId` + `caFp`) to find a LAN entry (`:508`), refuses to change or merge LAN-proven entries (`:510, :518`), and records `hostId` + `caFp` on relay-only entries (`:513`) so a subsequent LAN `saveSession` folds via `samePc` (`:301`). Verified in `test/relay-links-r1.test.mjs:116-219`. |
| **Gemini L1 / X1 I1** | `diagOverlay.ts` logged `location.href` at boot before `takePairingFragment` stripped `#fragment` | **FIXED (PASS)** | `src/diagOverlay.ts:49-51` (`redactHref`) strips the entire `#.*$` fragment to `#…` before redacting query secrets, and `installDiagOverlay` logs `redactHref(win.location.href)` (`:56`). Verified in `test/relay-links-r1.test.mjs:221-230`. |
| **Gemini L2** | Relay-only pairings had no Forget UI in `RemotePairScreen` and could not be removed by `forgetHost` | **FIXED (PASS)** | `src/remoteSession.ts:360-369` (`forgetHost`) removes entries matching `meshnetHost`, `hostId`, or `relay.hostId`. `src/RemotePairScreen.tsx:88, 424-436` computes `relayOnly = !saved ? activeHost(session) : null` and renders `data-testid="forget-relay-pc"` calling `forgetHost(relayOnly.relay?.hostId || relayOnly.hostId)`. Verified in `test/relay-links-r1.test.mjs:232-257`. |
| **Gemini L3 / X1 L1** | Opening a relay link with a device-minted (`pending`) code on an already-paired phone overwrote its live `token` with an unapproved ticket | **FIXED (PASS)** | `src/remoteSession.ts:19, 220, 465-471` stores `pendingToken` separately from `token` on `StoredRelayPin`. `src/remoteRelayConnect.ts:146-176` parks `r.token` in `pendingToken` when `r.pending === true` while preserving `token = d.pin.token ?? ""`, clears `pendingToken` on a non-pending redeem, and on code-less reconnect tries `token` first and promotes `pendingToken` to `token` only after `auth(pendingToken)` succeeds (`"ok"`). Verified in `test/relay-links-r1.test.mjs:259-316`. |

---

## Verification Output

- `node --test test/relay-pair-link.test.mjs test/relay-connect.test.mjs test/relay-links-r1.test.mjs test/android-pair.test.mjs`: **87/87 pass** (23 suites, 0 fail).
- `npm run typecheck`: **exit 0** (`tsc --noEmit && tsc --noEmit -p tsconfig.server.json`).
