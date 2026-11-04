---
id: krita
group: art
level: 1
method: winget
winget_id: KDE.Krita
verified: 2026-10-30 (winget show: 5.3.4.1)
licence: free
size: medium   # ~300 MB (UNVERIFIED)
---

# Krita

## When you want this
You want to paint or draw digitally, do illustration or comics, especially with a pen tablet. Free and open source (GPL). It has good brushes, layers and frame animation.

## Install (Windows)
```powershell
winget install --id KDE.Krita --exact --accept-package-agreements --accept-source-agreements
```

## macOS line
`macOS: brew install --cask krita` (UNVERIFIED: not checkable from Windows)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
winget list --id KDE.Krita --exact
```
Expected: a row named `Krita` with a version like `5.x`. Then open the app once and check it starts.

## First run (the human's steps)
1. Open Krita. Choose **File > New** and pick a size (for example 2000x2000 px, 300 DPI for print).
2. With a pen tablet, check **Settings > Configure Krita > Tablet Settings**.
3. Pick a brush from the right panel and draw a line.

## Gotchas
- Save as `.kra` to keep layers. Export PNG to share.
- For crisp pixel art use a pixel tool (see the pixel modules).
- Krita is raster (pixels). For clean shapes that you will laser or CNC cut, use [Inkscape](inkscape.md).
