---
id: unity-hub
group: game
level: 1
method: winget
winget_id: Unity.UnityHub
verified: 2026-10-30 (winget show: 3.22.5)
licence: personal
size: small   # Hub ~200 MB; each editor version is several GB (UNVERIFIED)
---

# Unity Hub

## When you want this
You want to make a game in Unity. The Hub is the launcher: it installs Unity editor versions and opens your projects. If you are not sure which engine to use, [Godot](godot.md) is lighter and fully free.

## Install (Windows)
```powershell
winget install --id Unity.UnityHub --exact --accept-package-agreements --accept-source-agreements
```
The editor itself is not installed by winget. You install it from inside the Hub (see First run).

## macOS line
`macOS: brew install --cask unity-hub` (UNVERIFIED: not checkable from Windows)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
winget list --id Unity.UnityHub --exact
```
Expected: one row named `Unity Hub` with a version like `3.x`. Then a **human check**: open the Hub once, confirm it starts, and say "done".

## First run (the human's steps)
1. Open Unity Hub and sign in with a Unity account (the browser opens; you do this part).
2. Choose the free Personal licence when the Hub asks.
3. Go to **Installs > Install Editor** and pick the recommended LTS version. Add the modules you need (for example Windows Build Support).
4. Wait for the editor to finish. It is a big download.

## Gotchas
- The Personal licence has eligibility limits. Read them on the Hub's licence screen.
- Each Unity project pins an editor version. Opening an old project with a newer editor can offer to upgrade it. Say no unless you mean it.
- The editor takes a lot of disk space. Choose the install drive in the Hub settings if C: is tight.
