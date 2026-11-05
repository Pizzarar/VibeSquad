# Modules

The flow: install your provider (`providers/`; `core/node` first for the npm-installed ones) and sign in, run the VibeSquad one-stop installer (`core/vibesquad`; it brings its own private Node and server), add the `guide` folder as a squad in
VibeSquad (**+ New squad**), and the Brainstorm chat (the Buddy) runs `START_HERE.md`.

One short page per tool. The setup agent reads the page for each tool the person chose, installs it, and runs the
page's Verify step.

## File format

Path: `Setup/modules/<group>/<id>.md`. Copy `_TEMPLATE.md` to start a new one.

**Frontmatter**

| Field | Values |
|---|---|
| `id` | the file name without `.md` |
| `group` | core, providers, game, art, pixel, fab, level2, advanced |
| `level` | 1 (everyone) or 2 (only if the person chose Level 2). A `providers` module is planned only for the provider the person chose |
| `method` | winget, web, licence-pointer, git, npm, doc-only |
| `winget_id` | exact ID, or `n/a` |
| `verified` | `YYYY-MM-DD (version)` after `winget show --id <id> --exact` resolved, else `UNVERIFIED` |
| `licence` | free, paid, personal, own |
| `size` | small (under about 200 MB), medium (200 MB to 1 GB), large (over 1 GB). Put the detail in a trailing `#` comment |

**Sections, in order:** When you want this / Install (Windows) / macOS line / Verify / First run (the human's steps) / Gotchas.
An optional "Try with your agent" section may follow Gotchas. Doc-only modules (`self-hosted-runners`) may leave out the
install, macOS, Verify and First run sections.

**Rules**
- Verify is an exact command plus the expected output pattern. Run the PATH refresh from `START_HERE.md` first. A
  step only a person can do is labelled **human check**: the person says "done" and that is the proof.
- Never guess a URL. Cite only official pages that were actually checked. Mark anything unchecked `UNVERIFIED`.
- macOS lines are best effort and `UNVERIFIED` unless tested.
- Never install by any route except the one written in the module.
- No personal data: no usernames, names, hostnames, IPs, emails or absolute paths. Use `~` or `%USERPROFILE%`.

## Index

| id | group | level | method | verified |
|---|---|---|---|---|
| git | core | 1 | winget | 2026-10-30 (2.56.0.4) |
| gh | core | 1 | winget | 2026-10-30 (2.103.3) |
| vibesquad | core | 1 | web (installer) | UNVERIFIED (derived from source 2026-11-01; installer not run) |
| vscode | core | 1 | winget | 2026-10-30 (1.143.1) |
| windows-terminal | core | 1 | winget | 2026-10-30 (1.25.2733.0) |
| powershell7 | core | 1 | winget | 2026-10-30 (7.6.9.0) |
| python | core | 1 | winget | 2026-10-30 (3.14.7) |
| node | core | 1 | winget | 2026-10-30 (26.13.0) |
| unity-hub | game | 1 | winget | 2026-10-30 (3.22.5) |
| godot | game | 1 | winget | 2026-10-30 (4.7.2) |
| blender | game | 1 | winget | 2026-10-30 (5.2.3) |
| krita | art | 1 | winget | 2026-10-30 (5.3.4.1) |
| inkscape | art | 1 | winget | 2026-10-30 (1.4.4) |
| gimp | art | 1 | winget | 2026-10-30 (3.2.6.0) |
| figma | art | 1 | web | 2026-10-30 (winget 126.11.7 for the optional desktop app) |
| affinity-adobe | art | 1 | licence-pointer | 2026-10-30 (Affinity 3.3.1.4940; Adobe UNVERIFIED) |
| piskel | pixel | 1 | web | 2026-10-30 (home page fetched; installer links UNVERIFIED) |
| aseprite | pixel | 1 | licence-pointer | 2026-10-30 (Steam page fetched; aseprite.org UNVERIFIED) |
| libresprite | pixel | 1 | web | 2026-10-30 (release v1.3) |
| piskel-mcp | pixel | 1 | git | 2026-10-30 (commit aa93d43) |
| fusion | fab | 1 | winget | 2026-10-30 (2706.1.14) |
| freecad | fab | 1 | winget | 2026-10-30 (1.1.4) |
| onshape | fab | 1 | web | 2026-10-30 (pricing page fetched) |
| lightburn | fab | 1 | winget | 2026-10-30 (2.1.01) |
| inkscape-laser | fab | 1 | doc-only (reuses inkscape) | 2026-10-30 (inkscape 1.4.4) |
| cnc-cam | fab | 1 | winget or web (by machine) | 2026-10-30 (Carbide Create 8.0) |
| gcode-sender | fab | 1 | web | 2026-10-30 (release lists read; gSender page UNVERIFIED) |
| slicer | fab | 1 | winget (by printer) | 2026-10-30 (Bambu Studio 02.08.02.61) |
| self-hosted-runners | level2 | 2 | doc-only | n/a |
| context-guard (Claude Code only) | level2 | 2 | git (copy template) | 2026-10-30 (hook test passed) |
| vibesquad-from-source | advanced | 2 | git | UNVERIFIED (README steps, not run) |
| claude-code | providers | 1 | web | 2026-10-30 (winget 2.1.302) |
| codex | providers | 1 | web | 2026-11-01 (install page read; not run) |
| gemini | providers | 1 | npm | 2026-11-01 (install page read; not run) |
| opencode | providers | 1 | npm | 2026-11-01 (install and free-model pages read; not run) |
