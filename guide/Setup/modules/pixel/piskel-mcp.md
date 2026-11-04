---
id: piskel-mcp
group: pixel
level: 1
method: git
winget_id: n/a
verified: NOT AUDITED (2026-10-30: only the commit hash and the README and package.json file names were looked at; src/ and the lockfile were never reviewed)
licence: free
size: small   # small clone; npm packages add some tens of MB (UNVERIFIED)
---

# piskel-mcp (optional, opt-in only)

> **Third-party code, not audited.** This module builds and runs someone else's code, and nobody on this kit has read
> its `src/` or its lockfile. Read it first (or ask an agent to review `src/` and the `package.json` scripts) before
> installing. The agent must install this only if the person asks for it by name, never as a default.

## When you want this
You want your agent to draw pixel art for you. This is the best "agent meets my medium" demo: ask Claude for a 16x16 sword, and it hands back a real PNG. It is optional. Skip it if you just want to draw by hand.

**What it is.** A headless pixel-art engine, derived from Piskel's code (Apache-2.0). It is *not* a bridge to the Piskel app in your browser. Claude calls its tools, it makes sprites in its own project files, and it exports PNG, GIF or sprite sheets. You open those files in [Piskel](piskel.md), [Aseprite](aseprite.md) or [LibreSprite](libresprite.md) to refine them by hand.

Source: https://github.com/yafeiaa/piskel-mcp-server (a one-person third-party project). Its English docs are in `docs/README_en.md` inside the clone; the main README is in Chinese.

## Install (Windows)
Needs `git` and `node` (Node 18 or newer) from the core modules. Check commit `aa93d4388cf5bb3fee8f4848023c185d1347481f` still exists first (read-only):
```powershell
git ls-remote https://github.com/yafeiaa/piskel-mcp-server.git refs/heads/main
```
Expected: a hash starting `aa93d43` (the full hash was `aa93d4388cf5bb3fee8f4848023c185d1347481f` on 2026-10-30). If main has moved on that is fine, the commit below is still the one we pin to.

Clone and pin. The pin stops later changes from sneaking in, but it does not make the pinned code safe: that code has not been reviewed.
```powershell
git clone https://github.com/yafeiaa/piskel-mcp-server.git "$env:USERPROFILE\tools\piskel-mcp-server"
git -C "$env:USERPROFILE\tools\piskel-mcp-server" checkout aa93d4388cf5bb3fee8f4848023c185d1347481f
git -C "$env:USERPROFILE\tools\piskel-mcp-server" rev-parse HEAD
```
Expected from the last line: exactly `aa93d4388cf5bb3fee8f4848023c185d1347481f`.

Build with the lockfile (exact versions). `--ignore-scripts` stops dependencies from running their own install scripts, which matters because this is a one-person third-party project:
```powershell
Set-Location "$env:USERPROFILE\tools\piskel-mcp-server"
npm.cmd ci --ignore-scripts
npm.cmd run build
```
Expected: no errors, and a file `dist/index.js` now exists. If `npm.cmd ci --ignore-scripts` or the build fails, stop and show the output (rule 2). Never fall back to a plain `npm.cmd ci` without the person's say-so.

**Register (run this from Phase 5 of `START_HERE.md`, after `~/projects/hello-agent` exists).** The server is registered
for that one folder only, with the default **local** scope (stored per user outside the repo, so no `.mcp.json` and no
username in the project):
```powershell
Set-Location "$env:USERPROFILE\projects\hello-agent"
claude mcp add piskel -e PISKEL_DATA_DIR="$env:USERPROFILE\projects\hello-agent\.piskel-data" -- node "$env:USERPROFILE\tools\piskel-mcp-server\dist\index.js"
```
`PISKEL_DATA_DIR` is where its project files live. Add `.piskel-data/` to that folder's `.gitignore` unless you want
to commit the sprites.

## macOS line
macOS: Same git, npm and `claude mcp add` commands. UNVERIFIED: not tested on macOS.

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
**Phase 4 (install only):**
```powershell
git -C "$env:USERPROFILE\tools\piskel-mcp-server" rev-parse HEAD
Test-Path "$env:USERPROFILE\tools\piskel-mcp-server\dist\index.js"
```
Expected: the pinned full hash, then `True`.

**Phase 5 (after Register):** run from the `hello-agent` folder, because a local-scope server only shows for that folder:
```powershell
Set-Location "$env:USERPROFILE\projects\hello-agent"
claude mcp list
```
Expected: a line starting `piskel:` (UNVERIFIED: the exact wording and whether it says `Connected` before the person has
approved the server; show the raw line). Then a **human check** in a new `claude` session started in that folder:
the person approves the server and types: "make a 16x16 heart with piskel and export a PNG, then show me the file". The
agent then proves the file exists (replace the username in the path with `<user>` in the proof line):
```powershell
Get-ChildItem "$env:USERPROFILE\projects\hello-agent\.piskel-data" -Recurse -Filter *.png | Select-Object FullName, Length
```
Expected: at least one PNG with a size above 0.

## First run (the human's steps)
1. Start Claude Code in the project and ask for a small sprite (16x16 or 32x32).
2. Open the exported PNG in Piskel (File > import) or Aseprite or LibreSprite, and fix it by hand.
3. Ask for variations: batch recolors and sprite sheets are where the agent saves you the most time (see the tool list in the docs; availability of the recolor tools is UNVERIFIED for this commit).

## Gotchas
- **Why local scope, not user scope.** An MCP server's tool list is sent to the model in every session. This one has a lot of tools (the English README lists about 22, and other notes say about 46, so the exact number is UNVERIFIED), and that costs context and money in every chat, including chats about something else. Registered for one folder (the default local scope), only the pixel-art project pays that price.
- It is headless. There is no window to watch. You see results only as exported files.
- Do not run `npm install` instead of `npm.cmd ci --ignore-scripts`. `npm ci` follows the lockfile exactly.
- Do not update the clone without choosing a new commit on purpose and reading what changed.
- No account or key is needed, and none should ever be put in this setup.
