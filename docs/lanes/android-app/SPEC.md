# PLAN · Android App (`@and` / `android-app`)

Older Tauri plan: `docs/PLAN_ANDROID_APP.md` (A1-A6, all done). Current plan: `docs/PLAN_ANDROID_MESHNET.md` (Meshnet A1-A3).
Lead: And1 rn-4cc22ce7f145 (2026-11-08). Meshnet A2/A3 moved off @rel on Aub's OK. Keystore/signing stay with Aub + Release Desk. Never publish; hand to Release Desk.

## Units (older Tauri plan, done)
- `unit-and-a1` (`6e19c17`), `unit-and-a2` (`749c12a`), `unit-and-a3` (`6364ecb`), `unit-and-a4` (`42f4d67`), `unit-and-a5` (`684f1f6`), `unit-and-a6` (`3e5f581`)

## Units (Meshnet plan)
- `unit-and-a1-pair` (done, merge `86d8b85`, built by @rel Rele3): APK pairs over VS-native LAN/Meshnet /pair
- `unit-and-mesh-a2` (done, `b306836`): CA trust (pin VS CA fingerprint per paired host), camera/pair on device, chat list/live/send/Stop/Needs-you over remote proxy
- `unit-and-mesh-a3` (done, `8647863`): APK debug/unsigned build works end to end, GitHub updater finds APK on stable. No signing changes.
- `unit-and-mesh-a2b` (done, `1ddac72`): Same-site `/__vibesquad/enter` hop for `serverUrl()`.
- `unit-and-mesh-a2d` (handed off to And1 `rn-4cc22ce7f145`, folds `a2c`): Restore Android APK download card/link in `PairDeviceModal.tsx` (`http://<ip>:4180/VibeSquad.apk`), route `handlePairRedeem` 302 through `/__vibesquad/enter` (so `SameSite=Strict` cookie survives QR scan in browser and APK return doesn't 302-redirect into `http://tauri.localhost` `ERR_CONNECTION_REFUSED`), fix empty `meshnetHost` default QR (`https://:4180/...`), and stage a compact (~13 MB) debug-signed release APK at `dist-desktop/VibeSquad.apk`.
