# Plan: user-local Godot on forge (idea-638, follow-up to idea-633 / ENV_GAPS.md)

Ask (hub Overlord, verbatim card): "install Godot Linux headless 4.8-dev7 (EFI), 4.7 (ForgeWirk), 4.7.2 (SBB) user-local under ~/.local/opt/godot (no sudo, sha-verify from godotengine releases), export GODOT_BIN per Squad, smoke --version."

## Decided
- Two binaries, not three: ForgeWirk `project.godot` declares feature "4.7"; 4.7.2 is the same minor version, so ForgeWirk + SportsBallBattles share 4.7.2 (SBB CI pins 4.7.2-stable, `ci.yml:12`). EFI gets 4.8-dev7 (`tests.yml:19`).
- Layout: `~/.local/opt/godot/<ver>/` + versioned commands in `~/.local/bin`: `godot-4.7.2`, `godot-4.8-dev7`. No unversioned `godot` (a wrong-version silent run is worse than "not found").
- Checked existing primitives: VS has no per-team/per-Squad agent env (no `env` key in teams.json or server spawn code), so "GODOT_BIN per Squad" cannot be set by VS. Each repo's runner picks its own versioned command. Forge-side: add `GODOT_4_7=` / `GODOT_4_8=` paths to a systemd user drop-in for the vibesquad unit so spawned agents inherit them, and make sure `~/.local/bin` is on the unit's PATH.
- Repo-side runner changes belong to those Squads, not this lane: EFI = idea-635 (run_godot.sh GODOT_BIN + coreutils timeout); SBB `tools/balance_report.sh:15` already honours `GODOT=`; ForgeWirk TBD. Lead queues SBB/ForgeWirk cards via `vs inbox add --lane <lane>`.
- No sudo, no repo source edits in this lane. Forge restart of the vibesquad unit to pick up the drop-in needs a drain (`vs restart` is owner/Overlord): lead asks the hub Overlord rather than restarting.

## Blocks
| Block | Touches | Clashes with | Kind |
|---|---|---|---|
| G1 download + sha256-verify 4.7.2-stable and 4.8-dev7 linux.x86_64 (official godotengine GitHub releases + SHA512-SUMS) into ~/.local/opt/godot | forge ~/.local/opt | none | Root cause |
| G2 versioned symlinks in ~/.local/bin; drop-in `~/.config/systemd/user/vibesquad.service.d/godot.conf` (Environment=GODOT_4_7, GODOT_4_8, PATH incl ~/.local/bin); daemon-reload only | forge ~/.config/systemd | forge VS restart (deferred to Overlord) | Root cause |
| G3 smoke: `godot-4.7.2 --headless --version`, `godot-4.8-dev7 --headless --version`; then one headless import-only run per repo (`--headless --path <repo> --quit`) exit 0 | none (read-only on repos; `.godot/` cache is gitignored) | running Godot lanes on devpc (none on forge) | Root cause |
| G4 append results + paths to docs/lanes/forge-host/ENV_GAPS.md; queue SBB + ForgeWirk runner cards; note EFI covered by idea-635 | docs/lanes/forge-host | none | Root cause |

## Done-check
Both `--version` outputs match the pinned versions; sha verified; 3 repo `--headless --quit` runs exit 0; drop-in present (`systemctl --user cat vibesquad` shows it); ENV_GAPS.md updated.

## Out of scope
Repo runner edits (EFI/SBB/ForgeWirk lanes), Windows exports/signing (stay on dev pp), restarting forge VS.

Lead: new forge-host lead (Lead - Claude), spawned by Buddy since lane has none.

## Follow-up R: vs restart through systemd on forge (Buddy 11-23, Linux cutover fallout)
Found at G-done-check: restart 3d4f9a216335 left `vibesquad.service` inactive (MainPID 0) with serve.mjs pid 254660 + runner 254678 orphaned in its cgroup; env inherited from the old server, so godot.conf never applied and Restart=on-failure supervision is lost. Root: `scripts/restart-runtime.mjs` relaunches via `spawnDetached` (:291).

Decided: on POSIX when the server belongs to the enabled systemd user unit, the relaunch step runs `systemctl --user restart vibesquad` after the existing stop (no double server on 4180); Windows path unchanged. Checked primitives: no existing systemd path in restart-runtime.mjs (grep systemctl/INVOCATION_ID: none); `vs restart` stays the only entry point. Stakes tierA-invariant (restart path); Opus implement + review per Buddy; Overlord 11-23: built-in Implement - Opus exists (server-merged, not in profiles.json), no Review - Opus, so R2 = Review - Gemini gate + Opus second read.

| Block | Touches | Clashes with | Kind |
|---|---|---|---|
| R1 systemd branch + unit tests + re-adopt procedure (RUNBOOK) | scripts/restart-runtime.mjs, test/restart-runtime.test.mjs, docs/lanes/forge-host/RUNBOOK.md | other restart-path work (idea-604/402 @bug: check before merge) | Root cause |
| R2 Review - Gemini (routing gate, Claude work) ∥ Opus second read via Implement - Opus profile (Buddy ask) | none | none | Gate |
| R3 full suite --queue, merge, push; Overlord re-adopts in a drained window; verify is-active active, MainPID == serve pid, environ has GODOT_4_7/4_8 | master | other merges | Gate |
| R4 forge-bootstrap.sh unit TMPDIR default outside the VS home (`$HOME/.cache/vibesquad-tmp`, on disk, tmpfiles-excluded per R15) + name what in ~/.vibesquad touches tmp/; also unit WorkingDirectory = synced runtime (matches runtime.conf drop-in); live forge unit updated via drop-in, lands with R3 re-adopt restart | scripts/forge-bootstrap.sh (+ its test if any), docs/lanes/forge-host/RUNBOOK.md | R1 (RUNBOOK.md section only: R4 appends, merge after R1) | Root cause |
Bug card idea-649 points at this block (R1-R3). R4 replaces @bug idea-652 (Buddy 11-23: cause is ours, forge-bootstrap.sh:25/217 defaults TMPDIR=$HOME/.vibesquad/tmp). R3 suite runs with TMPDIR=/tmp as a workaround until R4 lands. R4 done-check: restart-resume-safe + runner-restart-wait pass on forge under the unit env with no TMPDIR override.
