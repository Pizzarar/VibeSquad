---
id: python
group: core
level: 1
method: winget
winget_id: Python.Python.3.14
verified: 2026-10-30 (3.14.7; 3.13 fallback 3.13.16)
licence: free
size: medium
---

# Python

## When you want this
Python is the language agents most often use for small helper scripts, such as generating SVG shapes for a laser
cutter. Install it so those scripts can run.

## Install (Windows)
```powershell
winget install --id Python.Python.3.14 --exact --accept-package-agreements --accept-source-agreements
```
If that fails, use the fallback `Python.Python.3.13` with the same flags. Then run the PATH refresh (see `START_HERE.md`). If Verify still fails, restart your chat in VibeSquad (or open a **new** terminal window if you are doing this by hand).

## macOS line
`macOS: brew install python` (UNVERIFIED: not tested on a Mac)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
py --version
```
Expected: matches `^Python 3\.1[34]\.\d+`. This is the Verify. Use `py` for every script the kit runs on Windows.

Advisory check (not a failure if it differs):
```powershell
(Get-Command python -ErrorAction SilentlyContinue).Source
```
Expected: a path that does **not** contain `WindowsApps`. A `WindowsApps` path is the Microsoft Store shortcut, which
opens the Store instead of running Python. Tell the person; they fix it themselves in **Settings > Apps > Advanced app
settings > App execution aliases** by switching off the `python.exe` and `python3.exe` entries (this is the Windows 11 path). Then `python --version` should match `^Python 3\.1[34]\.\d+`.

## First run (the human's steps)
None.

## Gotchas
- If `python --version` opens the Microsoft Store or prints nothing useful, Windows' "app execution alias" is
  intercepting it. Turn off the `python.exe` and `python3.exe` aliases in Settings, then Apps, then Advanced app
  settings, then App execution aliases. `py` still works meanwhile.
