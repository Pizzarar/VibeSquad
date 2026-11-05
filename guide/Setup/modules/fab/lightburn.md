---
id: lightburn
group: fab
level: 1
method: winget
winget_id: LightBurnSoftware.LightBurn
verified: 2026-10-30 (winget show: 2.1.01); docs home page fetched; trial length UNVERIFIED
licence: paid
size: small   # ~150 MB (UNVERIFIED)
---

# LightBurn

## When you want this
You own a laser cutter or engraver (diode or CO2) and want to design, set power and speed, and run jobs. LightBurn is the common control software for hobby lasers. It is paid. Use the free trial first so you know it works with your machine. Check LightBurn's supported-controller list in its docs first: a laser that only works with its maker's own software may not be supported.

## Install (Windows)
```powershell
winget install --id LightBurnSoftware.LightBurn --exact --accept-package-agreements --accept-source-agreements
```
Official site: https://lightburnsoftware.com (could not be fetched here). Docs: https://docs.lightburnsoftware.com/

## macOS line
macOS: LightBurn also has a Mac build from its site. No brew line checked: UNVERIFIED.

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
winget list --id LightBurnSoftware.LightBurn --exact
```
Expected: a row named `LightBurn` with a version like `2.1`. Then open the app once.

## First run (the human's steps)
1. Open LightBurn. It should offer a trial. Third-party guides say it is 30 days, but check the app or site: UNVERIFIED.
2. Go to **Devices** and add your machine, or use **Find My Laser** (USB connected, laser powered on). Pick the right controller type, usually GRBL for diode lasers.
3. Set your work area size, and the origin that matches your machine.
4. Draw a small square, put it on a scrap material and do a test cut at low power. Wear your laser glasses and never leave a running laser alone.

## Gotchas
- A licence key is tied to a controller type (G-code, DSP). A wrong key type will not unlock your machine. Ask the seller, or read the license FAQ in the docs.
- LightBurn uses **layers by colour**. Each colour is one operation (cut, engrave, score) with its own speed and power. See [inkscape-laser](inkscape-laser.md) for how to prepare art for this.
- Test settings on scrap first. Materials vary a lot, and some (PVC, vinyl) release toxic fumes. Do not cut them.
- Do not paste your licence key into chat or a file in the repo.

## Try with your agent
Ask: "Write a Python script that creates an SVG coaster, 90 mm across, with a living hinge pattern ring and a cut line, in two colours: red for the cut, blue for the engrave." Import the SVG in LightBurn, check that you see two layers, then run it on scrap.
