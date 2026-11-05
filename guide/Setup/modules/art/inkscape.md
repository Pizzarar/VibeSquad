---
id: inkscape
group: art
level: 1
method: winget
winget_id: Inkscape.Inkscape
verified: 2026-10-30 (winget show: 1.4.4)
licence: free
size: medium   # ~250 MB (UNVERIFIED)
---

# Inkscape

## When you want this
You want vector art: logos, icons, line drawings, shapes that scale without going blurry. It is also the main design tool for laser and CNC work (see [inkscape-laser](../fab/inkscape-laser.md)). Free and open source (GPL).

## Install (Windows)
```powershell
winget install --id Inkscape.Inkscape --exact --accept-package-agreements --accept-source-agreements
```

## macOS line
`macOS: brew install --cask inkscape` (UNVERIFIED: not checkable from Windows)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
inkscape --version
```
Expected: a line starting `Inkscape 1.4`.
If the command is not found (the installer may not add it to PATH), find the exe and run it by its full path:
```powershell
Get-ChildItem "$env:ProgramFiles\Inkscape" -Recurse -Filter inkscape.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
```
Then `& "<that path>" --version`. UNVERIFIED: the install folder. If nothing is found, stop and show the output. In the
proof line, replace any username in a path with `<user>`.

## First run (the human's steps)
1. Open Inkscape. Draw a rectangle with the rectangle tool (`R`).
2. **File > Save As** and keep the default **Inkscape SVG**.
3. Type some text, then try **Path > Object to Path**. You will need that for laser cutting.

## Gotchas
- SVG is plain text, so your agent can read and write it. That is how scripts can generate shapes for you.
- Set the document units to **mm** (Document Properties) if you will cut anything physical.
- Old tutorials for Inkscape 0.9x use different menus.
