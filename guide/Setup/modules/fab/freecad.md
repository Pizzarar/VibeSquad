---
id: freecad
group: fab
level: 1
method: winget
winget_id: FreeCAD.FreeCAD
verified: 2026-10-30 (winget show: 1.1.4)
licence: free
size: large   # ~1 GB (UNVERIFIED)
---

# FreeCAD

## When you want this
You want parametric 3D CAD that is free, open source (LGPL) and runs offline. It also has a CAM workbench for CNC toolpaths. The interface has a steeper learning curve than [Fusion](fusion.md). Its big plus for agents: it can be scripted with Python and its files can be built from scripts.

## Install (Windows)
```powershell
winget install --id FreeCAD.FreeCAD --exact --accept-package-agreements --accept-source-agreements
```

## macOS line
`macOS: brew install --cask freecad` (UNVERIFIED: not checkable from Windows)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
winget list --id FreeCAD.FreeCAD --exact
```
Expected: a row named `FreeCAD` with a version like `1.1`. Then open the app and check the start page shows.

## First run (the human's steps)
1. Open FreeCAD and choose the **Part Design** workbench from the dropdown.
2. Create a body, make a sketch on the XY plane, draw a rectangle, and close the sketch.
3. Use **Pad** to extrude it. Save the file.

## Gotchas
- FreeCAD is picky about the "right order" of operations. If something breaks after an edit, check the model tree for red icons.
- The CAM workbench was reworked in recent releases. Tutorials for older versions may not match. Check you are on the current docs.
- It exports STEP, STL, DXF and SVG. Use DXF for laser or 2D CNC work and STL/3MF for a [slicer](slicer.md).

## Try with your agent
Ask: "Write a FreeCAD Python macro that makes a parametric box with these three variables at the top: length, width, height, and 3 mm wall." Run it in FreeCAD (**Macro > Macros**), then change a variable and run it again. The model rebuilds from your script, so you can rerun it any time.
