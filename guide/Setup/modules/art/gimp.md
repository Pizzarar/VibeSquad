---
id: gimp
group: art
level: 1
method: winget
winget_id: GIMP.GIMP.3
verified: 2026-10-30 (winget show: 3.2.6.0; GIMP.GIMP resolves to the same version, this kit uses GIMP.GIMP.3)
licence: free
size: medium   # ~350 MB (UNVERIFIED)
---

# GIMP

## When you want this
You want photo editing, retouching, or general raster image work. Free and open source (GPL). If you mostly paint or draw, [Krita](krita.md) is the friendlier choice.

## Install (Windows)
```powershell
winget install --id GIMP.GIMP.3 --exact --accept-package-agreements --accept-source-agreements
```

## macOS line
`macOS: brew install --cask gimp` (UNVERIFIED: not checkable from Windows)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
winget list --id GIMP.GIMP.3 --exact
```
Expected: a row named `GIMP` with a version like `3.x`. Then open the app once.

## First run (the human's steps)
1. Open GIMP. The first launch can take a while (it builds a font cache).
2. **File > Open** any photo, then try **Colors > Curves**.
3. **File > Export As** to save a PNG or JPG.

## Gotchas
- **Save** writes GIMP's own `.xcf` format. Use **Export** to make PNG or JPG.
- The first launch can look frozen. Give it a minute.
