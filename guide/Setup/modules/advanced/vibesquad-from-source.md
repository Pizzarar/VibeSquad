---
id: vibesquad-from-source
group: advanced
level: 2
method: git
winget_id: n/a
verified: UNVERIFIED (steps copied from the VibeSquad README "Quickstart (from source)"; not run; Paseo winget 0.14.0 and npm @getpaseo/cli 0.14.0 were checked 2026-10-30)
licence: free
size: large
---

# Advanced: run from source

## When you want this
Only if you want to change VibeSquad itself or run a build that has no installer. Everyone else should use the
installer in `core/vibesquad.md`. This route needs Node, Paseo and git, and you keep a server window open yourself.
It is not part of the normal setup run: the agent only plans it if the person asks for it.

## Install (Windows)
The order matters: Node.js 22 or newer, then the Paseo daemon, then VibeSquad.

**1. Node.js 22+.** Install the `node` module first (core). Check: `node --version` prints v22 or higher (the VibeSquad
README says "Node.js 22+").

**2. The Paseo daemon.** Needs `node`.
```powershell
winget install --id Paseo.Paseo --exact --accept-package-agreements --accept-source-agreements
npm.cmd install -g @getpaseo/cli
```
Then run the PATH refresh (see `START_HERE.md`). Open the Paseo app once so the daemon is running.

**3. VibeSquad, from source.** Needs `git` and `node`. Steps from the VibeSquad README
(https://github.com/Pizzarar/VibeSquad). The README's clone address is still a placeholder (`your-org/vibesquad`), so
this kit uses the repo address above. UNVERIFIED: not run.
```powershell
git clone https://github.com/Pizzarar/VibeSquad.git "$env:USERPROFILE\tools\vibesquad"
cd "$env:USERPROFILE\tools\vibesquad"
npm.cmd install
Copy-Item teams.example.json teams.json
node cli/vs.mjs install-shim
npm.cmd run build
npm.cmd start
```
Why `build` then `start`: the README's quick start lists `npm run dev` for development and `npm run build` then
`npm start` for production. Use the second form unless you are changing VibeSquad. Keep that window open: it is the
VibeSquad server. Then open http://127.0.0.1:4180 in your browser (port from the README; it is the default
`VIBESQUAD_PORT`).

`teams.json` lists your squads and their project folders. Edit it, or add teams later in the app (**⚙ SETTINGS**,
**+ Add team**, **+ path**).

## macOS line
`macOS: npm install -g @getpaseo/cli`, then the same git steps (UNVERIFIED: not tested on a Mac)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
node --version
```
Expected: v22 or higher.
```powershell
paseo --version
```
Expected: matches `^\d+\.\d+\.\d+`.
```powershell
paseo ls
```
Expected: exits without an error (an empty list is fine on a fresh install). If it says it cannot reach the
daemon, open the Paseo app once, then retry (UNVERIFIED: first-run behaviour was not tested).

Then **human check**: http://127.0.0.1:4180 opens and shows the VibeSquad main screen. The person says "done".

## First run (the human's steps)
Same as `core/vibesquad.md`, from the provider step on. UNVERIFIED: whether the browser version shows the Setup
Checklist.

## Gotchas
- In PowerShell use `npm.cmd`, not `npm` (a fresh PC blocks scripts). If a command you installed says "running scripts is disabled", run its `.cmd` form, for example `codex.cmd --version`.
- The winget app and the npm CLI are two separate Paseo installs; keep them on matching versions.
- Do not run the installer and a from-source server at the same time: both use port `4180` (UNVERIFIED: not tested).
- VibeSquad listens on `127.0.0.1` (this computer only) by default. Do not open it to your network or connect to other people's machines or daemons.
