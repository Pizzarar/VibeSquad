---
id: libresprite
group: pixel
level: 1
method: web
winget_id: n/a
verified: 2026-10-30 (GitHub release v1.3 asset list read through the GitHub API; the project site page was fetched)
licence: free
size: small   # UNVERIFIED
---

# LibreSprite

## When you want this
You want a free desktop pixel-art and animation editor with a familiar layout (layers, frames, palettes, sprite sheets). It is a community fork of an older Aseprite release, under the GPL-2.0 licence. It is not as polished or as fast-moving as Aseprite, but it costs nothing.

## Install (Windows)
Download from the project's official GitHub releases page: https://github.com/LibreSprite/LibreSprite/releases . The project site is https://libresprite.github.io/ .

The latest release seen on 2026-10-30 was `v1.3`, with these Windows files:
- `libresprite-v1.3-windows-x86_64.zip` (portable: unzip and run)
- `libresprite-v1.3-windows-x86_64-installer.exe` (installer)

Recommended: the portable zip. The human downloads it (it lands in `~/Downloads`), then the agent unzips it into its own new, empty folder. Do not run anything from the Downloads folder.
```powershell
Expand-Archive -LiteralPath "$env:USERPROFILE\Downloads\libresprite-v1.3-windows-x86_64.zip" -DestinationPath "$env:USERPROFILE\tools\libresprite"
Get-ChildItem "$env:USERPROFILE\tools\libresprite" -Recurse -Filter *.exe | Select-Object FullName
```
Expected: no error, and at least one `.exe` listed. UNVERIFIED: the folder layout inside the zip, so use the path the listing shows (not a guessed one) for the Verify step. If the zip has a different name, use the name that is really in `~/Downloads`.

## macOS line
macOS: The release also has `libresprite-v1.3-macos-arm64.dmg` and `libresprite-v1.3-macos-x86_64.dmg`. UNVERIFIED: not tested.

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
Get-ChildItem "$env:USERPROFILE\tools\libresprite" -Recurse -Filter *.exe | Select-Object FullName, Length
```
Expected: at least one `.exe` with a size above 0 (UNVERIFIED: the exe name inside the zip; show the output either way). Then open the app once (human check).

## First run (the human's steps)
1. Double-click the exe. If Windows SmartScreen warns you, check the file came from the official releases page above before you continue.
2. **File > New**, 32x32, RGB. Draw a few pixels.
3. **File > Export** a PNG.

## Gotchas
- Free does not mean maintained quickly. Check the releases page now and then.
- Files made here open in Aseprite and the other way around (the `.aseprite` format), but features can differ.
- The [piskel-mcp](piskel-mcp.md) module hands you PNG or GIF files to refine in this app.
