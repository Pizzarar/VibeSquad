---
id: fusion
group: fab
level: 1
method: winget
winget_id: Autodesk.Fusion
verified: 2026-10-30 (winget show: 2706.1.14; note Autodesk.Fusion360 does not resolve)
licence: personal
size: large   # ~2 GB (UNVERIFIED)
---

# Fusion (Autodesk)

## When you want this
You want parametric 3D design (CAD) and also toolpaths for a CNC (CAM) in one app. It is the all-round pick for CNC carving, 3D printing parts and laser-cut boxes with exact dimensions. It also works for any CNC brand. If you want a fully free, open-source option, see [freecad](freecad.md); for a browser-only option, see [onshape](onshape.md).

## Install (Windows)
```powershell
winget install --id Autodesk.Fusion --exact --accept-package-agreements --accept-source-agreements
```
The ID is `Autodesk.Fusion`. The old name `Autodesk.Fusion360` does not resolve.

## macOS line
macOS: Autodesk ships a Mac version from its own site. No brew line checked: UNVERIFIED.

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
winget list --id Autodesk.Fusion --exact
```
Expected: a row named `Autodesk Fusion` with a version like `2706.x`. Then open Fusion and check you are signed in.

## First run (the human's steps)
1. Open Fusion. Sign in with an Autodesk account in the browser (you do this part).
2. When it asks about the licence, look for the **personal use** option. The terms and limits (eligibility, how long it lasts, which CAM features are included) are on Autodesk's own pages and change over time. The exact limits are UNVERIFIED here, so read Autodesk's pages before you rely on it. Commercial use needs a paid plan.
3. Make a sketch on a plane, draw a rectangle, and press `E` to extrude it.
4. The **Manufacture** workspace is the CAM part.

## Gotchas
- Fusion is cloud-linked. Your files are stored in your Autodesk account by default.
- Your agent cannot drive the Fusion window. It can write CAD parameters as a table, or generate DXF/SVG files you import. See "Try with your agent" in [inkscape-laser](inkscape-laser.md).
- For CNC output, pick a post-processor that matches your machine (Grbl, Carbide 3D, and so on). See [cnc-cam](cnc-cam.md).

## Try with your agent
Ask: "Write a Python script that makes a DXF of a 100x60 mm rectangle with four 5 mm corner holes, 8 mm from each edge." Import the DXF into a Fusion sketch (**Insert > Insert DXF**), extrude it, and compare the sizes with calipers or the Inspect tool.
