---
id: godot
group: game
level: 1
method: winget
winget_id: GodotEngine.GodotEngine
verified: 2026-10-30 (winget show: 4.7.2; GodotEngine.GodotEngine.Mono also 4.7.2)
licence: free
size: small   # ~150 MB (UNVERIFIED)
---

# Godot

## When you want this
You want to make a 2D or 3D game with a small, free, open-source engine (MIT licence). Good for pixel-art games. Agents work well with it because scenes and scripts are plain text files.

## Install (Windows)
```powershell
winget install --id GodotEngine.GodotEngine --exact --accept-package-agreements --accept-source-agreements
```
winget says it can't make a command-line shortcut without admin rights, so there may be no `godot` command (see Verify).
Pick `GodotEngine.GodotEngine.Mono` instead only if you want to write C#. GDScript (the default language) works with the normal build.

## macOS line
`macOS: brew install --cask godot` (UNVERIFIED: not checkable from Windows)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
Godot installs as a portable zip, and winget can't create a `godot` command without admin rights, so `godot --version`
usually fails. Find the exe instead:
```powershell
Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages","$env:ProgramFiles\WinGet\Packages" -Recurse -Filter "Godot*.exe" -ErrorAction SilentlyContinue | Select-Object FullName
```
Expected: at least one `Godot*.exe`. Prefer the one whose name ends `_console.exe`, and run it by its full path:
```powershell
& "<full path of the console exe>" --version
```
Expected: a line like `4.7.2.stable.official.<hash>`. UNVERIFIED: the exact exe names inside the zip. If no exe is
found, stop and show the output (rule 2). If `godot --version` works on its own, that is fine too. In the proof line,
replace the Windows username in the path with `<user>`.

## First run (the human's steps)
1. Launch Godot. The Project Manager opens.
2. Click **Create**, name the project, pick a folder inside `~/projects`, choose the Compatibility renderer (fine for 2D), and click **Create & Edit**.
3. Press F5 to run. Godot asks for a main scene: make a new one first.

## Gotchas
- Godot is one portable exe, so there is no big installed folder to browse.
- A Godot project folder holds a `project.godot` file. Open that folder with your agent to work on the game.
- Pixel art tip: in Project Settings set the default texture filter to **Nearest** so sprites stay sharp. See the pixel modules for tools to draw them.
