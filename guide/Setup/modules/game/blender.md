---
id: blender
group: game
level: 1
method: winget
winget_id: BlenderFoundation.Blender
verified: 2026-10-30 (winget show: 5.2.3)
licence: free
size: medium   # ~400 MB (UNVERIFIED)
---

# Blender

## When you want this
You want 3D modelling, sculpting, animation, rendering, or assets for a game. It is free (GPL) and can also make models for 3D printing. Agents can drive it with Python scripts.

## Install (Windows)
```powershell
winget install --id BlenderFoundation.Blender --exact --accept-package-agreements --accept-source-agreements
```

## macOS line
`macOS: brew install --cask blender` (UNVERIFIED: not checkable from Windows)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
blender --version
```
Expected: a line starting `Blender 5.`.
If `blender` is not on PATH, find the exe and run it by its full path:
```powershell
Get-ChildItem "$env:ProgramFiles\Blender Foundation" -Recurse -Filter blender.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
```
Then `& "<that path>" --version`. UNVERIFIED: the install folder. If nothing is found, stop and show the output.

## First run (the human's steps)
1. Open Blender and pick the **General** template.
2. Click the splash screen away. The default cube is your first object.
3. Press `Tab` to enter Edit Mode and drag a corner. Press `Tab` again to leave.

## Gotchas
- Blender uses a three-button mouse a lot. A pen tablet works, but turn on "Emulate 3 Button Mouse" in Preferences if you have no middle button.
- Blockbench is a lighter option for low-poly and voxel models, and pairs nicely with pixel art. It is a one-line mention here, not a module: `winget install --id JannisX11.Blockbench --exact --accept-package-agreements --accept-source-agreements` (verified 5.2.2 on 2026-10-30).
- For 3D printing, export an STL or 3MF and open it in your [slicer](../fab/slicer.md).
