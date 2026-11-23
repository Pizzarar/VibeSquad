# Forge runbook: VibeSquad engine room on a Linux box

Owner-facing setup for the forge (Linux, same specs as the dev pp, on Tailscale). Design source of truth:
`docs/PLAN_FORGE_CUTOVER.md` (Decided, A8, B1-B4). R-numbers refer to rows of `docs/lanes/forge-host/LINUX_AUDIT.md`.
Placeholders: `forge.example.ts.net` (MagicDNS name), `devpc` (the dev pp's SSH alias), `<port>` (default 4180).

## B1. Owner steps

### On the forge

1. Clone VibeSquad and install deps:
   `git clone <repo-url> ~/projects/VibeSquad && cd ~/projects/VibeSquad && npm ci`
2. Tailscale: install per the Tailscale docs, then `sudo systemctl enable --now tailscaled` and `sudo tailscale up`. Enable MagicDNS in the tailnet admin console. Owner step: Machines -> the forge machine -> Disable key expiry, so a reboot/expiry does not log it out.
3. Bootstrap (idempotent, safe to re-run). Preview first with `scripts/forge-bootstrap.sh --dry-run`, then run
   `scripts/forge-bootstrap.sh`. It installs node 24 (`--node-major N` to change; an existing older node, e.g. a node-22 forge, is upgraded by re-running `scripts/forge-bootstrap.sh --node-major 24`, because it installs whenever the installed major is below the requested one), git, gh, ripgrep, openssl and chromium; writes the systemd user unit;
   enables linger; writes the unit but does **not** start it unless you pass `--start` (step 6 starts it); sets `fs.inotify.max_user_watches=524288` (R13); masks sleep/suspend/hibernate (R12); sets lid close to ignore via `/etc/systemd/logind.conf.d/forge-lid.conf` so the laptop forge runs lid-closed; puts `TMPDIR` on disk
   and out of systemd-tmpfiles cleanup (R15). The tailnet IP and MagicDNS name are detected from `tailscale`; override with
   `--meshnet-ip` / `--meshnet-host`. Run it after `tailscale up` so detection works.
4. Provider logins, as the VS user (credentials live in that user's home): `claude`, `agy`, `opencode`, `gh auth login`.
   The unit PATH includes `~/.local/bin` and the npm global prefix (R6); confirm each CLI resolves there.
   Linux installs (verified 2026-11-22): agy: `curl -fsSL https://antigravity.google/cli/install.sh | bash` (installs `~/.local/bin/agy`, read from https://antigravity.google/docs/getting-started?tab=cli); opencode: `npm install -g @opencode/cli` (read from https://opencode.ai/docs/).
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

Owner clients (VS app, phone, Playtest Overlay addon) use `https://forge.example.ts.net:<port>`. Off loopback VS is TLS-only (`server/serve.mjs:373-410`); plain http serves only `/ca.crt`, `/__vibesquad/desktop/update.json`, `/api/health` and `/api/auth/status`; `/pair` answers 302 to https and burns the code, other GET/HEAD get 301, non-GET gets 426 (`server/serve.mjs:381-396`). The unit sets `VIBESQUAD_LAN=1`,
`VIBESQUAD_MESHNET_IP` (tailnet IPv4) and `VIBESQUAD_MESHNET_HOST` (MagicDNS name) so the listener binds the tailnet address
and the Host check accepts the name (R7; the `tailscale0` interface match lands in A4). Pair a device via `/pair?format=json`
and check `/pair/status`. `tailscale serve` https is optional, not required.

### Trust the VS CA (every client, once per host)

The VS CA is self-signed, so each client pins it (E6/idea-384 flow; addon design in `docs/lanes/playtest-overlay/PLAN_V1.md:70-71`). Clients bootstrap by GETting `/ca.crt` (`http://forge.example.ts.net:<port>/ca.crt`), so the pin is only as safe as that first fetch. Compare the CA SHA-256 fingerprint against the one in the VS pair dialog (out-of-band) before trusting it. How each client behaves differs:

- **Desktop VS app:** trust-on-first-use. It GETs `http://<host>/ca.crt` over plain http, checks only that the body is PEM, writes `trusted-cas/<host>.crt` and reloads TLS (`src-tauri/src/main.rs:771-804`). It does NOT show or verify a fingerprint. Owner step: right after pairing, run `openssl x509 -in trusted-cas/<host>.crt -noout -fingerprint -sha256` on the pinned file and compare it by hand to the VS pair dialog. If it differs, delete the file and do not pair.
- **Phone (Android app):** it fetches `https://<host>:<port>/ca.crt` over a not-yet-trusted TLS socket and enforces that the CA's fingerprint starts with the fingerprint from the scanned pair QR (or typed on the pair screen); it refuses to pin on mismatch. No manual compare is needed when you scan the QR.
- **Playtest Overlay addon** (the `vs_playtest` Godot addon lives outside this repo; this is its design per PLAN_V1): it GETs `/ca.crt`, shows the fingerprint in its dock, and after you confirm pins the CA (`$VIBESQUAD_HOME/playtest-ca.crt`, override `vs_playtest/ca_cert_path`). No pin means no device token is sent; the system trust store is not a fallback for ts.net. Unpair deletes the pin.

## Godot and Windows-only jobs: SSH stdio bridge

Godot-lane agents run on the forge but drive the dev pp's loopback-only godot-mcp-runtime bridge over SSH stdio:

`ssh devpc npx godot-mcp-runtime@<pin>`

Register that command as the stdio MCP server command in the forge agent's MCP config. The same pattern runs Windows-only
jobs (desktop build/sign, Windows EFI exports by Release Desk): the forge agent executes them on the dev pp over SSH. There is
no second runner. Fallback only if SSH stdio is flaky in B3: a dev pp runner. Headless Godot on the forge (GNU `timeout`,
`--headless --path <proj>`) is EFI-side (R17).

## Rollback notes (C3)

- After cutover only the dev pp STANDBY copy (the stopped server instance + its ~/.vibesquad standby copy) is retired after 2 weeks clean; the Windows install/run/release path stays first-class (C3 retires only that standby copy).
- Rollback: drain agents, `systemctl --user stop vibesquad` on the forge, copy the forge `~/.vibesquad` (minus `runtime/` and
  `worktrees/`) back to the dev pp, start dev pp VS, point clients' `server_url` back.
- One writer at a time: never run both servers against the same copy of `~/.vibesquad`.
- Push all branches from the forge before stopping it; worktrees are recreated from pushed branches.

## Removed

The interim workaround (`LOCALAPPDATA=$HOME/.local/share` and `apt install lsof`) is not needed once A1 (runtime dir) and A3
(listener lookup) are on master, and is not part of this setup.
