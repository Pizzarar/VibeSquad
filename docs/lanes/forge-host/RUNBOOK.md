# Forge runbook: VibeSquad engine room on a Linux box

Owner-facing setup for the forge (Linux, same specs as the dev pp, on Tailscale). Design source of truth:
`docs/PLAN_FORGE_CUTOVER.md` (Decided, A8, B1-B4). R-numbers refer to rows of `docs/lanes/forge-host/LINUX_AUDIT.md`.
Placeholders: `forge.example.ts.net` (MagicDNS name), `devpc` (the dev pp's SSH alias), `<port>` (default 4180).

## B1. Owner steps

### On the forge

1. Clone VibeSquad and install deps:
   `git clone <repo-url> ~/projects/VibeSquad && cd ~/projects/VibeSquad && npm ci`
2. Tailscale: install per the Tailscale docs, then `sudo tailscale up`. Enable MagicDNS in the tailnet admin console.
3. Bootstrap (idempotent, safe to re-run). Preview first with `scripts/forge-bootstrap.sh --dry-run`, then run
   `scripts/forge-bootstrap.sh`. It installs node LTS, git, gh, ripgrep, openssl and chromium; writes the systemd user unit;
   enables linger; sets `fs.inotify.max_user_watches=524288` (R13); masks sleep/suspend/hibernate (R12); puts `TMPDIR` on disk
   and out of systemd-tmpfiles cleanup (R15). The tailnet IP and MagicDNS name are detected from `tailscale`; override with
   `--meshnet-ip` / `--meshnet-host`. Run it after `tailscale up` so detection works.
4. Provider logins, as the VS user (credentials live in that user's home): `claude`, `agy`, `opencode`, `gh auth login`.
   The unit PATH includes `~/.local/bin` and the npm global prefix (R6); confirm each CLI resolves there.
5. Forge SSH key for the dev pp bridge: `ssh-keygen -t ed25519 -C forge`, keep `~/.ssh/id_ed25519.pub` for the dev pp step below.
6. Start: `scripts/forge-bootstrap.sh --start` (or `systemctl --user enable --now vibesquad`).
   Shadow VS (stage B) uses a **fresh** `VIBESQUAD_HOME` (`~/.vibesquad`); do not copy state from the dev pp until C2.

### On the dev pp (Windows)

1. Enable OpenSSH Server: Settings > System > Optional features > OpenSSH Server, then in an admin shell
   `Start-Service sshd; Set-Service -Name sshd -StartupType Automatic`.
2. Add the forge public key to `%ProgramData%\ssh\administrators_authorized_keys` (admin account) or
   `%USERPROFILE%\.ssh\authorized_keys`, with the ACLs sshd requires.
3. From the forge, check `ssh devpc hostname`.

## Daily operations

| Task | Command |
|---|---|
| Status | `systemctl --user status vibesquad` |
| Start / stop / restart | `systemctl --user start vibesquad` / `stop` / `restart` |
| Logs (follow) | `journalctl --user -u vibesquad -f` |
| Logs since boot | `journalctl --user -u vibesquad -b` |
| Edit unit | edit `~/.config/systemd/user/vibesquad.service`, `systemctl --user daemon-reload`, restart |
| Merge + reload code | `vs restart --needs build`, then check `build-stamp.json` was updated |

The unit uses `KillMode=process` and `Delegate=yes`: stopping the main server process must not kill the runner or the
resumable agents VS started detached in the same cgroup (R5); `vs restart` depends on this. To stop everything, drain through
VS first (park agents), then `systemctl --user stop vibesquad`, then check `ps -ef` for leftovers. Do not launch VS from tmux;
the unit is the only launch path.

## Clients: server_url (MagicDNS)

Owner clients (VS app, phone) use `http://forge.example.ts.net:<port>`. The unit sets `VIBESQUAD_LAN=1`,
`VIBESQUAD_MESHNET_IP` (tailnet IPv4) and `VIBESQUAD_MESHNET_HOST` (MagicDNS name) so the listener binds the tailnet address
and the Host check accepts the name (R7; the `tailscale0` interface match lands in A4). Pair a device via `/pair?format=json`
and check `/pair/status`. `tailscale serve` https is optional, not required.

## Godot and Windows-only jobs: SSH stdio bridge

Godot-lane agents run on the forge but drive the dev pp's loopback-only godot-mcp-runtime bridge over SSH stdio:

`ssh devpc npx godot-mcp-runtime@<pin>`

Register that command as the stdio MCP server command in the forge agent's MCP config. The same pattern runs Windows-only
jobs (desktop build/sign, Windows EFI exports by Release Desk): the forge agent executes them on the dev pp over SSH. There is
no second runner. Fallback only if SSH stdio is flaky in B3: a dev pp runner. Headless Godot on the forge (GNU `timeout`,
`--headless --path <proj>`) is EFI-side (R17).

## Rollback notes (C3)

- After cutover the dev pp VS stays installed but **stopped and not autostarting**; retire it after 2 weeks clean.
- Rollback: drain agents, `systemctl --user stop vibesquad` on the forge, copy the forge `~/.vibesquad` (minus `runtime/` and
  `worktrees/`) back to the dev pp, start dev pp VS, point clients' `server_url` back.
- One writer at a time: never run both servers against the same copy of `~/.vibesquad`.
- Push all branches from the forge before stopping it; worktrees are recreated from pushed branches.

## Removed

The interim workaround (`LOCALAPPDATA=$HOME/.local/share` and `apt install lsof`) is not needed once A1 (runtime dir) and A3
(listener lookup) are on master, and is not part of this setup.
