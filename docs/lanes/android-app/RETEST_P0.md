# RETEST P0: white screen after pairing (unit-and-p0-white)

This APK is a debug-signed sideload build. It differs from the last one in three ways, all there to show *why* the screen goes white:

- The enter-hop page (`/__vibesquad/enter`) is now dark with "Opening VibeSquad…". If the automatic redirect has not left the page after 2.5 s, the page prints what it sees (cookies enabled, user agent, referrer, hop target).
- On Android, a red text box at the bottom shows `window.onerror`, unhandled rejections, render errors and the last steps (boot URL with the code redacted, pinned, leaving for /pair).
- WebView remote debugging is on, so chrome://inspect works.

## 1. Install

1. Phone on the same Wi-Fi or Meshnet as the PC.
2. In the phone browser open `https://<host>:4180/VibeSquad.apk` (or `http://<host>:4180/VibeSquad.apk`; the lowercase `/vibesquad.apk` works too). Install over the old app (same debug key).
3. Check the file: `Get-FileHash dist-desktop\VibeSquad.apk -Algorithm SHA256` on the PC must equal `dist-desktop\VibeSquad.apk.sha256`. The live server serves the runtime copy, so compare the `x-vibesquad-apk-sha256` response header too.

## 2. Wireless debugging (USB adb saw no device)

On the phone: Settings → Developer options → **Wireless debugging** → on → **Pair device with pairing code**. Note the pairing IP:port and the 6-digit code, then on the PC:

```
adb pair <ip>:<pairing-port>          # enter the 6-digit code when asked
adb connect <ip>:<wireless-debugging-port>   # the port on the main Wireless debugging screen, not the pairing one
adb devices                            # must list the phone as "device"
adb logcat -c
adb logcat -v time chromium:V cr_*:V Tauri:V RustStdoutStderr:V AndroidRuntime:E *:S > p0-logcat.txt
```

## 3. Repro

1. Open the app, scan the QR (or enter address, code, fingerprint) and press Pair.
2. Note what you see and screenshot it:
   - Dark "Opening VibeSquad…" page with Continue: the hop did not fire. Wait 3 s and the page prints a trace line. Screenshot it.
   - Red box at the bottom: it names the error. Screenshot it.
   - Anything else white: go to step 4.
3. Save `p0-logcat.txt` (Ctrl+C the logcat).

## 4. Inspect the WebView

1. Phone connected over adb (step 2), Chrome on the PC: open `chrome://inspect/#devices`.
2. Under the phone, find the VibeSquad WebView and click **inspect**.
3. Console tab: look for red errors. Network tab: check `/pair?code=…`, `/__vibesquad/enter`, `/` (status, and whether `vs_device` was sent: Cookies column). Application → Cookies: `vs_device` for the PC host.
4. If the page is the enter hop, in the console run `location.replace('/')`. If that works but the automatic one did not, tell the lead that and paste the Network tab rows.

## What to send back

`p0-logcat.txt`, the screenshots, and the console/Network text from step 4.
