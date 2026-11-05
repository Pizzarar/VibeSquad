---
id: cnc-cam
group: fab
level: 1
method: winget
winget_id: Carbide3D.CarbideCreate
verified: 2026-10-30 (winget show: Carbide Create 8.0); Carbide 3D Create page and Easel page fetched; others as noted
licence: free
size: small   # ~100 MB for Carbide Create (UNVERIFIED); Easel is web-only
---

# CNC CAM (pick by machine)

## When you want this
You have a CNC router or mill and want to turn a design into toolpaths and G-code (the file the machine reads). CAM means "computer-aided manufacturing": you tell it the bit, the depth and the cuts, and it makes the code. **The right tool depends on your machine brand**, so the agent picks from this table after the interview.

| Your machine | Use | Method |
|---|---|---|
| Shapeoko or Nomad (Carbide 3D) | **Carbide Create** | winget (below) |
| X-Carve or other Inventables | **Easel** | web, free to start |
| Onefinity, Sienci, Genmitsu and other GRBL machines | **Easel** (it lists these brands) or **Fusion** | web or [fusion](fusion.md) |
| Anything else, or you want one tool for CAD and CAM | **Fusion** (its Manufacture workspace) | see [fusion](fusion.md) |
| Free and open source only | FreeCAD CAM workbench | see [freecad](freecad.md) |

Also common among hobbyists, but paid and not in this kit: Vectric VCarve (popular for sign making and relief carving). Not recommended here for a first tool: MeshCAM (`GRZ.MeshCAM`).

## Install (Windows)
**Carbide Create** (Shapeoko, Nomad):
```powershell
winget install --id Carbide3D.CarbideCreate --exact --accept-package-agreements --accept-source-agreements
```
The official page says Carbide Create "Core" is free with Shapeoko and Nomad, and works only with Carbide 3D machines. Other machines need Pro. Pro adds 3D modelling, 3D machining and standard G-code output for any CNC machine, with a 14-day trial. Page: https://carbide3d.com/carbidecreate/ . The Pro price is on the buy page; check it there.

**Easel** (X-Carve and many others): nothing to install. Go to https://easel.inventables.com/ . The official page says it is browser-based, covers design, toolpaths and machine control, and supports 148 machines from 25 makers (Carbide 3D, Inventables, Onefinity, Maslow, Sienci Labs, SainSmart Genmitsu named). It starts at $0 with a Pro trial. UNVERIFIED: what exactly the free tier limits.

**Fusion**: see [fusion](fusion.md).

## macOS line
macOS: Carbide Create has a Mac version on the official page. No brew line checked: UNVERIFIED. Easel runs in any browser.

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
For Carbide Create:
```powershell
winget list --id Carbide3D.CarbideCreate --exact
```
Expected: a row named `Carbide Create` with version `8.x`. Then the real proof, a **human check** that works for Carbide Create, Easel or Fusion: you save a toolpath, export G-code, and tell the agent the file's full path (Easel saves to your Downloads folder unless you chose another). The agent checks that exact file:
```powershell
Get-Content "<the path you gave>" -TotalCount 10
```
Expected: G-code like `G21` or `G90`, in a file with a size above 0. For Easel, with nothing to install, that human check is the whole Verify.

## First run (the human's steps)
1. Set your **machine** and **stock** size (the material block) first. Wrong numbers here ruin a cut.
2. Set **zero** (the origin) to match how you will zero on the machine.
3. Draw or import a small test (a 40 mm square pocket, 3 mm deep).
4. Choose your bit (diameter, flutes). Start with the maker's suggested feeds and speeds.
5. Make the toolpath, preview it, and **export G-code**. Run an air cut (with the Z raised) before the first real one.

## Gotchas
- Wear eye and ear protection. Use clamps. Do not leave a running CNC alone.
- Do not trust speeds from random videos. Use your machine maker's tables and test on scrap.
- G-code files are text, so your agent can read them. Ask it to check the start and end lines and that the depth never goes below your stock.
- Your G-code goes to the machine through the maker's sender app, or through [gcode-sender](gcode-sender.md).
- Carbide 3D's own sender software is called Carbide Motion (not checked: UNVERIFIED).

## Try with your agent
Ask: "Write a Python script that creates an SVG of a 100x100 mm sign with a 5 mm rounded border and my name carved in text, with parameters at the top." Import it into Carbide Create or Easel (File > Import), set up a V-bit or end mill toolpath, and export G-code. Change the size in the script and rerun it when you want a different one.
