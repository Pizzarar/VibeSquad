---
id: gcode-sender
group: fab
level: 1
method: web
winget_id: n/a
verified: 2026-10-30 (GitHub release lists for both tools read through the GitHub API; the UGS site page was fetched; the gSender page was blocked, so UNVERIFIED)
licence: free
size: small   # UNVERIFIED
---

# G-code sender (optional)

## When you want this
Your CNC needs a program on your PC to send G-code to it over USB. This is common for GRBL machines (many hobby routers and lasers). Skip this if your machine maker already gives you a sender (for example a Shapeoko uses Carbide 3D's own software), or if you use Easel or LightBurn to send jobs.

Two free choices:
- **gSender** by Sienci Labs. Made for hobby CNCs with GRBL. Latest release seen on 2026-10-30: `v1.6.4`. Site: https://sienci.com/gsender/ (description UNVERIFIED). Its releases: https://github.com/Sienci-Labs/gsender/releases . Licence shown by GitHub: not identified (NOASSERTION), so read its licence page.
- **Universal Gcode Sender (UGS)**. A Java app for GRBL, FluidNC, TinyG, g2core and Smoothieware. The official site says it is free and GPLv3: https://winder.github.io/ugs_website/ . Latest release seen on 2026-10-30: `v2.1.27`.

## Install (Windows)
Neither is on winget. Download from the official releases page only. The human clicks the download, then says "done".

- gSender: https://github.com/Sienci-Labs/gsender/releases . The Windows file name is not confirmed (UNVERIFIED). On the releases page, open the latest release, look under **Assets** for the file whose name says `win` and ends in `.exe` or `.msi`, read its exact name to the person, and let them click it.
- UGS: https://github.com/winder/Universal-G-Code-Sender/releases . Windows files seen for `v2.1.27`: `ugs-2.1.27-x64.exe` and `ugs-2.1.27-x64.msi`.

Downloaded installers are untrusted until you check where they came from. Do not run them from the Downloads folder in a script.

## macOS line
macOS: Both publish Mac builds on the same releases pages (`.dmg` files seen). UNVERIFIED: not tested.

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
**human check.** Open the app, plug in the machine over USB, pick the serial port and click **Connect**. Expected: the app shows the controller's welcome line (for GRBL, something like `Grbl 1.1`) and an `Idle` state. The agent cannot check this for you: say "done" once you see it. There is no reliable install command to run, because the installers' package names are UNVERIFIED.

## First run (the human's steps)
1. Connect the USB cable. Power the machine on with the **emergency stop within reach**.
2. In the app choose the port and baud rate (usually 115200 for GRBL), click **Connect**.
3. Jog the machine a small distance (1 mm) and check the axis directions.
4. Set zero, load a G-code file, and do an **air cut** (Z raised) before cutting.

## Gotchas
- If it will not connect: check the cable (some are power-only), close other apps using the port, and check the baud rate.
- Never let your agent stream G-code to a machine. You press Start, and you watch it.
- Machines differ. Use your machine maker's own guide for settings.
