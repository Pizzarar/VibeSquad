---
id: figma
group: art
level: 1
method: web
winget_id: Figma.Figma
verified: 2026-10-30 (winget show: 126.11.7; free Starter plan seen on the official pricing page)
licence: free
size: small   # web app; desktop app optional (size UNVERIFIED)
---

# Figma

## When you want this
You want to design app or web screens, UI mockups, or collaborative layouts. It runs in the browser. The desktop app is optional.

## Install (Windows)
No install needed: go to https://www.figma.com and sign in.
Optional desktop app:
```powershell
winget install --id Figma.Figma --exact --accept-package-agreements --accept-source-agreements
```

## macOS line
`macOS: brew install --cask figma` (UNVERIFIED: not checkable from Windows)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
Browser version: you sign in and see your files page. Desktop app:
```powershell
winget list --id Figma.Figma --exact
```
Expected: a row named `Figma` with a version number.

## First run (the human's steps)
1. Create a free Figma account in the browser (you do this part).
2. Click **New design file** and draw a frame with the Frame tool (`F`).
3. Share links only with people you trust.

## Gotchas
- The free Starter plan is limited. See what is included: https://www.figma.com/pricing/
- Figma is not the right tool for laser or CNC art. Use [Inkscape](inkscape.md).
