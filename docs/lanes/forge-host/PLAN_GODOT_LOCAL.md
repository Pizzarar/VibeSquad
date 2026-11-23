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
