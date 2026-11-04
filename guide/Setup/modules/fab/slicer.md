---
id: slicer
group: fab
level: 1
method: winget
winget_id: Bambulab.Bambustudio
verified: 2026-10-30 (winget show: Bambu Studio 02.08.02.61, PrusaSlicer 2.9.6, OrcaSlicer 2.4.2, Cura 5.13.0, LycheeSlicer 7.6.7)
licence: free
size: medium   # ~300-500 MB each (UNVERIFIED)
---

# Slicer (pick by printer)

## When you want this
You have a 3D printer (or will use one). A slicer turns a 3D model (STL or 3MF) into the layer-by-layer instructions the printer follows. **Pick by printer brand**: the maker's own slicer already has your printer's profile.

| Your printer | Use | winget ID (verified 2026-10-30) |
|---|---|---|
| Bambu Lab | Bambu Studio | `Bambulab.Bambustudio` (02.08.02.61, AGPL-3.0) |
| Prusa | PrusaSlicer | `Prusa3D.PrusaSlicer` (2.9.6, AGPL-3.0) |
| Creality, Voron, Elegoo, most others | OrcaSlicer | `SoftFever.OrcaSlicer` (2.4.2, AGPL-3.0) |
| Ultimaker, or you prefer Cura | UltiMaker Cura | `Ultimaker.Cura` (5.13.0, LGPL-3.0) |
| Resin (SLA/MSLA) | LycheeSlicer | `Mango3D.LycheeSlicer` (7.6.7, proprietary; a free plan exists, UNVERIFIED) |

If you are not sure, OrcaSlicer covers the widest range.

## Install (Windows)
Install only the one that matches your printer. Example for a Bambu printer:
```powershell
winget install --id Bambulab.Bambustudio --exact --accept-package-agreements --accept-source-agreements
```
Other examples:
```powershell
winget install --id Prusa3D.PrusaSlicer --exact --accept-package-agreements --accept-source-agreements
winget install --id SoftFever.OrcaSlicer --exact --accept-package-agreements --accept-source-agreements
winget install --id Ultimaker.Cura --exact --accept-package-agreements --accept-source-agreements
winget install --id Mango3D.LycheeSlicer --exact --accept-package-agreements --accept-source-agreements
```

## macOS line
`macOS: brew install --cask orcaslicer` (and similar casks for the others). UNVERIFIED: not checkable from Windows.

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
winget list --id <the id you installed> --exact
```
Expected: one row with the slicer's name and a version matching the table above (or newer). Then open the app once and check your printer profile is added.

## First run (the human's steps)
1. Open the slicer. Run its setup wizard and **add your printer** by model.
2. Choose the filament type you really use (PLA is a good start).
3. Drag in a model (an STL). Click **Slice**, then check the preview layer by layer.
4. Export the file or send it to the printer with the maker's method.

## Gotchas
- Your printer's first-layer height and bed temperature matter most. Use the profile's defaults before you change anything.
- Wear nothing loose near the printer, and do not leave heated machines unattended for long.
- Models from [Blender](../game/blender.md) or [FreeCAD](freecad.md) export as STL or 3MF. Check the scale (mm) before slicing.
- Do not commit big model files to git without a plan. Use a `models/` folder and ignore build output.

## Try with your agent
Ask: "Write a Python script that generates an STL of a parametric cable clip: inner diameter, wall, width, with the numbers at the top." Open it in your slicer, check the dimensions, and print it. Change the numbers, rerun, print another. If you don't want to code STL, ask for an OpenSCAD file instead and open it in OpenSCAD (not in this kit: UNVERIFIED install).
