# PLAN · Android App (`@and` / `android-app`)

Older Tauri plan: `docs/PLAN_ANDROID_APP.md` (A1-A6, all done). Prior 0.3 A1 plan: `docs/PLAN_ANDROID_MESHNET.md` (**ALL DONE & CLOSED 2026-11-10** at `7fb55ab` / APK `aac22b2d…`; Aub passed the full `docs/lanes/android-app/RETEST_A1.md` on-device checklist including edge cases). Current 0.3 end-state plan: `docs/PLAN_ANDROID_END_STATE.md` (approved by Aub 2026-11-10 for 0.3: `"proceed with plan implimentation. if we can finish the new app for .3 that would be coool"` — `E1`, `E2`, `E3`, `E4a`, and `E5` core merged at `e8380d3`; `E1b` top status-bar safe-area inset fix (`unit-and-end-e1b`), `E4b` Tier A phone-minted pairing guards, `E5` wiring, and `E-APK` sideload rebuild handed to Lead `And4` `rn-0f8d6e128eab`).
Lead: And7 rn-0c5479f72670 (took over from And6 rn-ff0443695f20, 2026-11-11). Keystore/signing stay with Aub + Release Desk. Never publish; hand to Release Desk.
Status 2026-11-11: `E1`–`E5` + `E1b` + `E1c` (`fafc5a7`) + `E4b` + `E5` wiring + `E5` relay links (`8ee794d`) + `prove-local-rust` (`1258e3d`) + `E-APK` landed on `master`. All 36 `@and` units complete.

## Units (older Tauri plan, done)
- `unit-and-a1` (`6e19c17`), `unit-and-a2` (`749c12a`), `unit-and-a3` (`6364ecb`), `unit-and-a4` (`42f4d67`), `unit-and-a5` (`684f1f6`), `unit-and-a6` (`3e5f581`)

## Units (Meshnet / 0.3 A1 plan, all done)
- `unit-and-a1-pair` (done, merge `86d8b85`, built by @rel Rele3): APK pairs over VS-native LAN/Meshnet /pair
- `unit-and-mesh-a2` (done, `b306836`): CA trust (pin VS CA fingerprint per paired host), camera/pair on device, chat list/live/send/Stop/Needs-you over remote proxy
- `unit-and-mesh-a3` (done, `8647863`): APK debug/unsigned build works end to end, GitHub updater finds APK on stable. No signing changes.
- `unit-and-mesh-a2b` (done, `1ddac72`): Same-site `/__vibesquad/enter` hop for `serverUrl()`.
- `unit-and-mesh-a2d` (done, `d3105e4`, `106c5d3`, `d6eb8a7`): Restore Android APK download card/link in `PairDeviceModal.tsx`, route `handlePairRedeem` 302 through `/__vibesquad/enter`, fix empty `meshnetHost` default QR, and stage a compact (~13 MB) debug-signed release APK at `dist-desktop/VibeSquad.apk`.
- `unit-and-03-a1` (done, `705b5f6`, `0fe90ce`, `7fb55ab`, on-device `RETEST_A1.md` passed by Aub 2026-11-10, edge cases included): same-site `/` enter hop, case-insensitive `/VibeSquad.apk` + sha256 sidecar/runtime sync, Reconnect + plain cert/offline errors + pin/cookie clear.
