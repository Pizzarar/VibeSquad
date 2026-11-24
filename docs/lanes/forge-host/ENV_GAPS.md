# Forge env-gap audit (post-C2, 2026-11-23, idea-633)

Method: `command -v` on forge for ~40 tools; scanned the 8 Squad repos for manifests, CI workflows, Python imports, spec runners; `apt-cache policy` on Ubuntu 26.04 for candidates.

## Present on forge
python3 3.14.4, node/npm, gh, jq, rg, git. Provider CLIs: claude, opencode, antigravity-cli `agy` 1.5.15 (`~/.local/bin/agy`, logged in).
Gemini/agy agents work after the 2026-11-23 21:47Z runner restart (e.g. Review-Gemini rn-322300fcfc9d ran to completion). Before
that they hung in `initializing`: the runner had started before the agy install+login at 15:02Z (idea-646). Login order: RUNBOOK B1 step 4.

## Owner: one apt line (sudo) — DONE 2026-11-23 ~21:48Z (all 17 packages `ii`, dpkg --audit clean)
```bash
sudo apt install -y python3-pip python3-venv pipx python3-lupa lua5.4 lua-busted python3-numpy python3-pil python3-pytest python3-jsonschema python3-yaml zip unzip build-essential sqlite3 libfontconfig1 xvfb
```

| Package | Needed by (evidence) |
|---|---|
| python3-lupa, lua5.4, lua-busted | RedFrontier `tools/run-specs.py:18` (`from lupa import lua54`), 22 `spec/*_spec.lua` |
| python3-pip, python3-venv, pipx | general; fallback if distro lupa lacks `lua54` |
| python3-numpy, python3-pil | SportsBallBattles `tools/pixel/*.py`, VibeSquad `art/**/render_*.py` (PIL 109 imports, numpy 70) |
| python3-pytest, python3-jsonschema, python3-yaml | SerbiseNow `triage_eval/tests/*`, `triage_eval/validate.py`, EFI data validators |
| libfontconfig1 | Godot prints `libfontconfig.so.1: cannot open shared object file` on every run (non-fatal, exit 0); headless runs work without it |
| xvfb | SportsBallBattles `tools/shots/run_shots.sh:11` (`xvfb-run` when no display) |
| zip, unzip, build-essential, sqlite3 | general build/packaging; not tied to one failing check |

Done-check after install: `python3 -c "from lupa import lua54"` and `cd ~/projects/RedFrontier && python3 tools/run-specs.py`.
If `lua54` import fails (Debian lupa may build against a different Lua): `python3 -m venv ~/.venvs/rf && ~/.venvs/rf/bin/pip install 'lupa>=2'`.

**2026-11-24 status (RedFrontier): DONE.** Ubuntu `python3-lupa` 2.4 is built against Lua 5.1 only (no `lupa.lua54`), so the apt package does NOT satisfy RF. The earlier hand-unpacked wheel was no longer present (plain `python3` imported the dist-packages 2.4 and failed). Fix: `python3 -m pip install --user --break-system-packages 'lupa>=2.8'` (user site only; on 26.04 the flag is required for any `--user` install; user site precedes dist-packages, so plain `python3` picks it up, pip-tracked). Done-check: `python3 -c "from lupa import lua54"` ok (lupa 2.8 from `~/.local/lib/python3.14/site-packages`); `cd ~/projects/RedFrontier && python3 tools/run-specs.py` exit 0, `TOTAL 74 specs, 1414 tests, 0 failures, 0 load errors`. `python3-lupa` from the apt line is now unused by RF (harmless; shadowed). Upgrade: same pip command with `--upgrade`.

## Non-apt gaps
- **Godot**: DONE 2026-11-23 (idea-638, see below).
- **Not gaps (stay on dev pp by decision 11-21):** dotnet, JDK/Android SDK, Rust/Tauri, signing, Windows exports, Blender, ComfyUI, RedFrontier `tools/*.ps1` server scripts (run on Windows / over SSH).
- None of the repos uses git-lfs (no `filter=lfs` in .gitattributes) or ffmpeg/ImageMagick in tools.
- Squadz: docs only, no tooling.
- **Blender / ComfyUI (idea-761, 2026-11-24)**: not lost. The dev pp `C:\Dev` moved to `%USERPROFILE%\Documents\Dev` on 11-24; Blender 5.2.3 (`Tools\blender-5.2.3-windows-x64`), ComfyUI and all 3 Godot engines are there. Forge has no NVIDIA GPU, so Blender/ComfyUI art stays on the dev pp (decision 11-21). Still dangling on the dev pp: user env `EFI_GODOT`, `GODOT`, PATH entry `C:\Dev\Tools\bin`, plus 11 EFI files with hard-coded `C:/Dev/...` (9 art pipeline scripts, `tools/run_godot.sh`, `tools/playtest_launch.py`). Fix = owner choice: a `mklink /J C:\Dev` junction to the new folder, or update the 3 env values plus the EFI defaults.
- **git identity**: DONE 2026-11-23. Global `user.name`/`user.email` set on forge to the same GitHub noreply identity the dev pp uses; drop the per-commit `-c` overrides.

## Godot user-local install (idea-638, 2026-11-23)
Two binaries: ForgeWirk (feature "4.7") and SportsBallBattles (CI pin 4.7.2-stable) share 4.7.2; EFI uses 4.8-dev7. No unversioned `godot`.

| Command (`~/.local/bin`) | Target | `--headless --version` | Env in vibesquad unit |
|---|---|---|---|
| `godot-4.7.2` | `~/.local/opt/godot/4.7.2-stable/Godot_v4.7.2-stable_linux.x86_64` | `4.7.2.stable.official.ed1daf0bf` | `GODOT_4_7` |
| `godot-4.8-dev7` | `~/.local/opt/godot/4.8-dev7/Godot_v4.8-dev7_linux.x86_64` | `4.8.dev7.official.c971f93e7` | `GODOT_4_8` |

Source: `github.com/godotengine/godot-builds/releases/download/<ver>/`, `sha512sum -c` against the release `SHA512-SUMS.txt`, both OK:
```
9aa00f7a605200940bce3027a567b782f49bd8e940dd06ae9e987bd65aee1b1467edd56ed84fcdcbdd44354bf613bdbb4e5d2913e925850368e150c59ed54c65  Godot_v4.7.2-stable_linux.x86_64.zip
6444078c4984699069e81f4c9fb83b88119a89d6f4dd39790acf9c2e2b1e4d0fb435a0c101aa48d24a81662d2ff50d648bd3475086d2d2ca37ce90374b97ef38  Godot_v4.8-dev7_linux.x86_64.zip
```
Drop-in `~/.config/systemd/user/vibesquad.service.d/godot.conf` (daemon-reload done; the running server picks it up only after a drained restart requested via the hub Overlord). `~/.local/bin` was already on the main unit's PATH, so the drop-in sets only:
```
[Service]
Environment=GODOT_4_7=%h/.local/bin/godot-4.7.2
Environment=GODOT_4_8=%h/.local/bin/godot-4.8-dev7
```
Smoke: `git archive HEAD` export of each repo into a temp dir (live checkouts have other Squads' dirty trees, and an import writes `.import`/`.uid` files), then `--headless --path <export> --import` and `--quit`:

| Repo @ HEAD | Binary | import | quit |
|---|---|---|---|
| EFI `ece4f74b` | godot-4.8-dev7 | 0 | 0 (only `*-VALIDATE errors=0` lines) |
| ForgeWirk `7bb1bfa` | godot-4.7.2 | 0 | 0 |
| SportsBallBattles `8235006` | godot-4.7.2 | 0 | 0 |

Runner follow-ups (repo-side, not this lane): EFI `run_godot.sh` GODOT_BIN + coreutils timeout = idea-635; SBB default `GODOT=godot` -> idea-639; ForgeWirk runner -> idea-640.

**2026-11-23 ~22:00Z (superseded 11-24, see the RedFrontier status above):** apt line installed. A `~/.venvs/rf` venv with lupa 2.8 was the first RF fix; on 11-24 plain `python3` failed again, so lupa 2.8 went into the user site via `pip --user --break-system-packages` and `python3 tools/run-specs.py` works without the venv (RF auto re-exec idea-699 no longer needed for forge).
