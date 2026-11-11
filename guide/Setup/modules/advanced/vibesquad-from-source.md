---
id: vibesquad-from-source
group: advanced
level: 2
method: git
winget_id: n/a
verified: UNVERIFIED (steps copied from the VibeSquad README "Quickstart (from source)"; not run; updated for the v0.2.8 built-in runner on 2026-11-07)
licence: free
size: large
---

# Advanced: run from source

## When you want this
Only if you want to change VibeSquad itself or run a build that has no installer. Everyone else should use the
installer in `core/vibesquad.md`. This route needs Node and git (no Paseo: the runner is built in), and you keep a server window open yourself.
It is not part of the normal setup run: the agent only plans it if the person asks for it.

## Install (Windows)
The order matters: Node.js 22 or newer, then VibeSquad.

**1. Node.js 22+.** Install the `node` module first (core). Check: `node --version` prints v22 or higher (the VibeSquad
README says "Node.js 22+").

**2. VibeSquad, from source.** Needs `git` and `node`. Steps from the VibeSquad README
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
`macOS: the same git steps` (UNVERIFIED: not tested on a Mac)

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
```powershell
node --version
```
Expected: v22 or higher.
```powershell
node cli/vs.mjs --help
```
Expected: the `vs` usage text prints without an error (run it from the VibeSquad folder).

Then **human check**: http://127.0.0.1:4180 opens and shows the VibeSquad main screen. The person says "done".

## First run (the human's steps)
Same as `core/vibesquad.md`, from the provider step on. UNVERIFIED: whether the browser version shows the Setup
Checklist.

## Keeping a source checkout live (sync-runtime)
`npm run build` ends by running `server/sync-runtime.mjs`, which copies the new build into the runtime the app runs from. It never restarts anything. It prints what the merges since the last sync need to go live, read from the `Live-Needs:` trailer on each merge commit (`none`, `build`, `frontend-reload`, `runner-restart`, `server-restart`). If a merge has no trailer, it guesses from the changed files; if it cannot tell where it last synced, it assumes the server and runner need a restart. Typical outcomes:
- `frontend-reload`: reload open VibeSquad windows (Ctrl+R).
- `runner-restart`: the runner restarts itself once idle.
- `server-restart`: pick a quiet moment, run `vs restart --dry-run`, then `vs restart`.
Skipped or refused syncs (for example a dirty checkout) say why and leave the running copy unchanged; `--force` overrides.

## Worktree cleanup
Contributors working in many worktrees can run `vs worktree sweep` (dry run) and `vs worktree sweep --apply`. `--apply` removes every merged, clean worktree of the repo, including other lanes'.

## Gotchas
- In PowerShell use `npm.cmd`, not `npm` (a fresh PC blocks scripts). If a command you installed says "running scripts is disabled", run its `.cmd` form, for example `codex.cmd --version`.
- There is no daemon to install or keep in sync: the server starts and restarts the built-in runner itself.
- Do not run the installer and a from-source server at the same time: both use port `4180` (UNVERIFIED: not tested).
- VibeSquad listens on `127.0.0.1` (this computer only) by default. Do not open it to your network or connect to other people's machines.
