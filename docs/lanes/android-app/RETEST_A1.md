# 0.3 A1 · Android on-device retest (Aub)

Build: sideload APK (~13 MB, debug-signed). The lead checks before you start that the served APK hash matches the build.
Screenshots of anything wrong go to `scratch/`. Note the step number and the exact on-screen text.

## Install + first pair
1. Uninstall the old VibeSquad app on the phone.
2. Phone browser: open `http://<PC LAN ip>:4180/vibesquad.apk` (lowercase is fine). Expected: about 13 MB downloads. Install it.
3. Open the **app** (not Firefox). Expected: the "Pair with your PC" form, no blank screen.
4. PC: Pair a device. App: Scan QR code, then Pair. Expected: "Connecting…", then your PC's VibeSquad UI. **No white "Continue" page.**
5. Open a chat, send a message, press Stop, check Needs-you shows.

## Cold start
6. Wait 5 s, swipe the app away, reopen. Expected: straight back into the PC UI, no new code.
7. Pair-and-quit test: later, after a fresh pair, swipe the app away within 2 s, then reopen. Expected: still paired.

## Back / Forget / re-pair
8. From the PC UI press Android Back until the app screen shows. Expected: pair form with "Reconnect to <host>" and "Forget". No bounce back to the PC.
9. Tap Reconnect. Expected: back in the PC UI.
10. Back again, tap Forget, close and reopen the app. Expected: empty pair form.
11. Pair by typing address + 6-digit code + fingerprint (no QR). Expected: same as step 4.

## Offline
12. Swipe the app away, turn phone Wi-Fi off (Meshnet off too), open the app. Expected: within ~10 s a plain "can't reach your PC" style message + Reconnect + Forget. Write down the text.
13. Turn the network back on, tap Reconnect. Expected: PC UI.
14. With the PC UI open, ask the lead to briefly stop the server. Expected: an error, not a white screen that keeps reloading. Press Back. Expected: pair form. Reconnect after the server is back.

## Meshnet (off Wi-Fi)
15. Wi-Fi off, Meshnet on, open the app (or Reconnect). Expected: PC UI works over Meshnet. Repeat step 5.

## Wrong host / revoked
16. Forget, then type a wrong address (change one digit) + a code. Expected: a clear "couldn't reach" message in ~10 s.
17. Pair normally. On the PC (Pair a device → Paired devices) revoke this phone. Reopen the app. Expected: "Your PC no longer recognizes this phone. Pair again…".
18. If you ever land on a PC "Unpaired device" page in the app: tap "Back to the app" (expected: pair form), then try "Pair again" and write down what it does (opens pair form / nothing / error).

## Download link
19. Phone browser: `…:4180/VibeSquad.apk` and `…:4180/VIBESQUAD.APK`. Expected: both download the same ~13 MB file.

## Pass
All steps behave as expected. Steps 14 and 18 are fact-finding: write down what happened. Neither one fails the retest.
