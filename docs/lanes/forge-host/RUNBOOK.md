# Forge runbook: VibeSquad engine room on a Linux box

Owner-facing setup for the forge (Linux, same specs as the dev pp, on NordVPN Meshnet). Design source of truth:
`docs/PLAN_FORGE_CUTOVER.md` (Decided, A8, B1-B4). R-numbers refer to rows of `docs/lanes/forge-host/LINUX_AUDIT.md`.
Placeholders: `<forge mesh ip>` (the forge's Meshnet IPv4), `<forge mesh host>` (its Meshnet hostname, as `nordvpn meshnet peer list` shows it), `devpc` (the dev pp's SSH alias), `<port>` (default 4180).

## B1. Owner steps

### On the forge

1. Clone VibeSquad and install deps:
   `git clone <repo-url> ~/projects/VibeSquad && cd ~/projects/VibeSquad && npm ci`
2. NordVPN Meshnet: install NordVPN per its Linux docs, then `nordvpn login` and `nordvpn set meshnet on` (the daemon starts at boot). Owner steps: keep it logged in so a reboot does not drop Meshnet, and in the NordVPN app allow the forge to receive connections from your devices (peer permissions: incoming connections). Tailscale is not used: it claims `100.64.0.0/10`, which clashes with Meshnet, so keep `tailscaled` disabled on the forge (`sudo systemctl disable --now tailscaled`).
3. Bootstrap (idempotent, safe to re-run). Preview first with `scripts/forge-bootstrap.sh --dry-run`, then run
   `scripts/forge-bootstrap.sh`. It installs node 24 (`--node-major N` to change; an existing older node, e.g. a node-22 forge, is upgraded by re-running `scripts/forge-bootstrap.sh --node-major 24`, because it installs whenever the installed major is below the requested one), git, gh, ripgrep, openssl and chromium; writes the systemd user unit;
   enables linger; writes the unit but does **not** start it unless you pass `--start` (step 6 starts it); sets `fs.inotify.max_user_watches=524288` (R13); masks sleep/suspend/hibernate (R12); sets lid close to ignore via `/etc/systemd/logind.conf.d/forge-lid.conf` so the laptop forge runs lid-closed; puts `TMPDIR` on disk
   and out of systemd-tmpfiles cleanup (R15). It also runs `npm ci` and `npm run build` in the checkout so `dist/` exists (without it phone pairing shows "dist/index.html missing"). The Meshnet IP and hostname are detected from `nordvpn meshnet peer list` (Local Peer block), falling back to the `nordlynx` interface for the IP; override with
   `--meshnet-ip` / `--meshnet-host`. Run it after Meshnet is on so detection works; it only warns if Meshnet is off.
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

## Clients: server_url (Meshnet IP)

Owner clients (VS app, phone, Playtest Overlay addon) pair by IP at `https://<forge mesh ip>:<port>` (the `<forge mesh host>` name also works where the client resolves Meshnet names). Off loopback VS is TLS-only (`server/serve.mjs:373-410`); plain http serves only `/ca.crt`, `/__vibesquad/desktop/update.json`, `/api/health` and `/api/auth/status`; `/pair` answers 302 to https and burns the code, other GET/HEAD get 301, non-GET gets 426 (`server/serve.mjs:381-396`). The unit sets `VIBESQUAD_LAN=1`,
`VIBESQUAD_MESHNET_IP` (`<forge mesh ip>`) and `VIBESQUAD_MESHNET_HOST` (`<forge mesh host>`) so the listener binds the Meshnet address
and the Host check accepts the IP and name (R7; the server also falls back to the `nordlynx` interface when the env is empty). Pair a device via `/pair?format=json`
and check `/pair/status`.

### Trust the VS CA (every client, once per host)

The VS CA is self-signed, so each client pins it (E6/idea-384 flow; addon design in `docs/lanes/playtest-overlay/PLAN_V1.md:70-71`). Clients bootstrap by GETting `/ca.crt` (`http://<forge mesh ip>:<port>/ca.crt`), so the pin is only as safe as that first fetch. Compare the CA SHA-256 fingerprint against the one in the VS pair dialog (out-of-band) before trusting it. How each client behaves differs:

- **Desktop VS app:** trust-on-first-use. It GETs `http://<host>/ca.crt` over plain http, checks only that the body is PEM, writes `trusted-cas/<host>.crt` and reloads TLS (`src-tauri/src/main.rs:771-804`). It does NOT show or verify a fingerprint. Owner step: right after pairing, run `openssl x509 -in trusted-cas/<host>.crt -noout -fingerprint -sha256` on the pinned file and compare it by hand to the VS pair dialog. If it differs, delete the file and do not pair.
- **Phone (Android app):** it fetches `https://<host>:<port>/ca.crt` over a not-yet-trusted TLS socket and enforces that the CA's fingerprint starts with the fingerprint from the scanned pair QR (or typed on the pair screen); it refuses to pin on mismatch. No manual compare is needed when you scan the QR.
- **Playtest Overlay addon** (the `vs_playtest` Godot addon lives outside this repo; this is its design per PLAN_V1): it GETs `/ca.crt`, shows the fingerprint in its dock, and after you confirm pins the CA (`$VIBESQUAD_HOME/playtest-ca.crt`, override `vs_playtest/ca_cert_path`). No pin means no device token is sent; the system trust store is not a fallback for the Meshnet host. Unpair deletes the pin.

## Godot and Windows-only jobs: SSH stdio bridge

Godot-lane agents run on the forge but drive the dev pp's loopback-only godot-mcp-runtime bridge over SSH stdio:

`ssh devpc npx godot-mcp-runtime@<pin>`

Register that command as the stdio MCP server command in the forge agent's MCP config. The same pattern runs Windows-only
jobs (desktop build/sign, Windows EFI exports by Release Desk): the forge agent executes them on the dev pp over SSH. There is
no second runner. Fallback only if SSH stdio is flaky in B3: a dev pp runner. Headless Godot on the forge (GNU `timeout`,
`--headless --path <proj>`) is EFI-side (R17).

**The bridge is LAN-only.** Both machines must be on the home LAN. Do not point `devpc` at a Meshnet or Tailscale address of the dev pp: both use `100.64.0.0/10` and the routes clash, so forge -> dev pp SSH over them can hang. Use the LAN address. Working setup, in the forge's `~/.ssh/config`:

```
Host devpc
    HostName <devpc-lan-ip>
    User <devpc-user>
```

(`<devpc-lan-ip>` is the dev pp's LAN address, ideally a DHCP reservation; `<devpc-user>` is its Windows user.)

## C2 migrate (`scripts/forge-migrate.mjs`)

Run only after C1 (drained, dev pp VS stopped) and the owner's C go-signal. The script never deletes owner data in any
mode and only reads the source home (it stays the C3 rollback). The only things it removes are its own: a scratch dir in
the OS temp dir and the private temp refs under `refs/vs-migrate-wip/` it creates for a bundle and drops right after.
Placeholders: `<u>` = Windows user, `<forge-user>` = forge user, `<forge-host>` = the forge's ssh host alias.

1. **Unpushed report** (dev pp, read-only: no fetch, prune, gc or index refresh).
   `node scripts/forge-migrate.mjs --unpushed-report [--sanctuary <dir>] [--json]`
   Walks the worktree sanctuary (`%LOCALAPPDATA%\VibeSquad\worktrees`, `<root>/<repo>/<unit>`). Per git common dir:
   local branches with commits on no remote (`rev-list --branches --not --remotes`) and stash entries; per worktree:
   dirty files and a detached HEAD with commits on no branch. Folders there that are not git worktrees are listed.
   The last line is a JSON summary; `safeToDelete` is true only when all of those are 0.
   **"Pushed" means "on a remote-tracking ref as of the last fetch".** The script never fetches, so a branch deleted on
   the remote since then still counts as pushed. Fetch by hand first if that matters.
2. **Bundles** (dev pp): `--bundle --bundle-dir <dir>` (or `--bundle` with `--backup`, see 3) saves the flagged work so
   deleting the sanctuary loses nothing even if a lead never answers. Per worktree `<repo>__<worktree>.bundle`: its
   unpushed branches (checked out there or named after it), a detached HEAD, and a WIP commit of its dirty tree (tracked
   changes + untracked files, .gitignore respected, untracked files over 50 MB skipped and listed). Per repo
   `<repo>__repo.bundle`: unpushed branches no worktree owns, and every stash entry. Each bundle is `git bundle verify`'d;
   `manifest.json` lists worktree, branch, sha, counts, file and verified. The worktrees' files, index, HEAD and branch
   refs are not written. Bundles are thin: restore needs a clone of the remote.
   Restore:
   ```
   git clone <remote> restore && cd restore
   git fetch <dir>/<repo>__<worktree>.bundle 'refs/*:refs/restored/*'
   git fetch <dir>/<repo>__<worktree>.bundle HEAD:refs/restored/HEAD   # only if the manifest lists a detached HEAD
   ```
   Branches land in `refs/restored/heads/*`, the WIP commit in `refs/restored/vs-migrate-wip/<repo>/<unit>/<ts>/wip`
   (its parent is the worktree's HEAD), stashes in `.../_repo/<ts>/stash-<n>`.
   **Main checkouts** are covered too: every git dir directly under `--win-projects` (default `C:\Users\<u>\projects`)
   and each sanctuary repo's main worktree. Each gets `<repo>__main.bundle` (its checked-out unpushed branch + WIP of
   its dirty tree) and `<repo>__untracked.tar` with the untracked files INCLUDING ignored ones (that is where
   `docs/brainstorm/` and other ignored notes live), minus `node_modules`, `dist`, `.godot`, `.import`, `build`,
   `export(s)`, `.tmp*`, `*.pck`, `*.exe`, and files over 50 MB; `docs/**` always goes in unless a file is over 200 MB.
   `manifest.json` `checkouts[]` lists path, bundle, untrackedTar, fileCount, bytes and every skip. Restore a tar with
   `tar -xf <repo>__untracked.tar -C <checkout>`.
   **Owner-delete work:** `--skip-bundle <repo>` or `--skip-bundle <repo>:<branch>` (repeatable) leaves that repo or
   branch (and a worktree with that branch checked out) out; it is listed in `manifest.json` `skippedByOwner`.
   Run `--bundle --bundle-dir <dir> --dry-run` first to see the plan, tar file counts and sizes.
2b. **Dev pp inventory** (read-only, before the nuke): `node scripts/forge-migrate.mjs --devpc-inventory [--keep <name>]...
   [--json]` lists every folder under `C:\Users\<u>\projects` plus the VS data dirs (`~/.vibesquad`, each folder under
   `%LOCALAPPDATA%\VibeSquad`) with size, git or not, local-only branches, dirty count and untracked+ignored doc count,
   and proposes keep (VibeSquad source, `--keep` names: pass `--keep <Godot playtest repo>`, `.vibesquad` as the C3
   rollback), delete, or review. Proposals only: the script deletes nothing; the owner decides.
3. **Backup** (dev pp): `node scripts/forge-migrate.mjs --from C:\Users\<u>\.vibesquad --backup <dir> [--bundle]`
   writes `vibesquad-home-<timestamp>.zip` (Windows tar.exe; `.tar.gz` on POSIX) of the full home; with `--bundle` the
   bundles are staged in `<dir>/vibesquad-bundles-<timestamp>/` and go into the same archive. Lock files, sockets and
   links are skipped and listed. Add `--dry-run` to see the file count, skips and planned bundles first.
4. **Dry run**, then the copy. Allowlist only: `teams.json`, `teams/`, `inbox.json`, `lessons.jsonl`, `profiles.json`,
   `settings.json`, `stakes-ladder.json`, `schedules.json`, `capped-providers.json`, `brief-history/`, `reports/`.
   Everything else is printed as "left behind" with its size (runner/, logs, stamps, `*.bak*`, ...); the forge's own
   `tls/`, `devices.json`, `host-id`, `local-token`, `daemon-password`, `vapid.json` are never copied.
   ```
   node scripts/forge-migrate.mjs --from <copy of C:\Users\<u>\.vibesquad> --to <staging or ~/.vibesquad> \
     --win-user <u> --forge-home /home/<forge-user> --dry-run
   ```
   The dry run writes nothing and prints per-file rewrite counts plus UNMAPPED drive-letter paths (top 50 by count).
   Path map (case-insensitive, `\`, `/` and JSON-escaped `\\`): `C:\Users\<u>\projects\<P>` -> `<projects-root>/<P>`
   (`--projects-root`, default `<forge-home>/projects`); `%LOCALAPPDATA%\VibeSquad\worktrees` -> `--worktrees-root`
   (default `~/.vibesquad/worktrees`); `%LOCALAPPDATA%\VibeSquad\runtime` -> `~/.vibesquad/runtime`;
   `C:\Users\<u>\.vibesquad` -> `--vs-home-root` (default `<forge-home>/.vibesquad`). Other `C:` paths stay as they are
   and show in the UNMAPPED list, as do `file:///C:/` and `\\?\C:\` forms and any path that would only be half
   converted (a space or `(` inside it in free text). A JSON key whose rewrite collides with another key keeps its text
   and is listed as KEY CONFLICT. Drop `--dry-run` to copy. A non-empty `--to` is refused unless `--force`, which
   overwrites the allowlisted files only and keeps everything else there (the forge's identity and CA). A link or
   junction on `--to` or under its allowlisted entries is refused, and every write is checked (junctions resolved) to
   land outside `--from`. JSON that does not parse, JSONL lines that do not parse and non-UTF-8 text are copied
   verbatim and reported.
5. Start the forge unit; leads and Buddies restart fresh from their briefs (C2).

## Rollback notes (C3)

- After cutover only the dev pp STANDBY copy (the stopped server instance + its ~/.vibesquad standby copy) is retired after 2 weeks clean; the Windows install/run/release path stays first-class (C3 retires only that standby copy).
- Rollback: drain agents, `systemctl --user stop vibesquad` on the forge, copy the forge `~/.vibesquad` (minus `runtime/` and
  `worktrees/`) back to the dev pp, start dev pp VS, point clients' `server_url` back.
- One writer at a time: never run both servers against the same copy of `~/.vibesquad`.
- Push all branches from the forge before stopping it; worktrees are recreated from pushed branches.

## Removed

The interim workaround (`LOCALAPPDATA=$HOME/.local/share` and `apt install lsof`) is not needed once A1 (runtime dir) and A3
(listener lookup) are on master, and is not part of this setup.
