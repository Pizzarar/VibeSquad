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
   Do every install + login **before** the VS start (step 6). A runner started before a CLI was installed or logged in keeps
   failing for that provider: after C2, Gemini (agy) agents hung in `initializing` until the next runner restart, while a manual
   `agy` ACP initialize worked (idea-646). If you install or log in a CLI later, ask the hub Overlord for a drained runner restart.
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

`vs restart` relaunches through the unit (follow-up R, idea-649): when the server belongs to `vibesquad.service` (its pid sits
in the unit's cgroup, or the unit is active or enabled, and the unit's `VIBESQUAD_PORT` is the restart's port) the stop is
`systemctl --user stop vibesquad` (only when the unit's MainPID is the server; an orphan gets SIGTERM) and the relaunch is
`systemctl --user start vibesquad`; the unit's `VIBESQUAD_START_RUNNER=1` server boots the runner. This needs
`KillMode=process` in the unit: with any other KillMode the restart never stops or starts through the unit, and if the server
is the unit's MainPID it refuses before touching anything (`relaunch.mode: refused`), since stopping it would kill the runner,
the agents and the restart itself. If `systemctl --user start` fails or the unit's server is not healthy in time, the restart
stops the unit, frees port 4180 (a `serve.mjs` still on it is stopped; anything else aborts the restart), then launches
detached with a `WARNING` (`detached-fallback`). `vs restart --dry-run` shows the detection (`detected.systemd`, including
`killMode`) and the plan line `start server: systemctl --user start vibesquad`. The result file
`~/.vibesquad/restart-<ts>.json` records `relaunch.mode` (`systemd`, `systemd-unadopted`, `detached`, `detached-fallback`,
`already-up`, `refused`), `relaunch.after` (ActiveState, MainPID, listener pid) and any `warnings` (systemctl unreachable,
KillMode, WorkingDirectory differing from the runtime dir, `EnvironmentFiles=`, MainPID not the listener). Another unit name:
`VIBESQUAD_SYSTEMD_UNIT=<name>`; `off` disables it.
The unit runs the code in its effective `WorkingDirectory`: on the forge that is `~/.vibesquad/runtime` (set by the
`vibesquad.service.d/runtime.conf` drop-in), not the checkout, so merged code goes live only after sync-runtime has copied it
there (`systemctl --user show -p WorkingDirectory vibesquad` prints the effective value).

### Re-adopt vibesquad.service

Symptom: `systemctl --user is-active vibesquad` says `inactive` (MainPID 0) while VS still answers on port 4180, and
`systemctl --user status vibesquad` lists the server under its CGroup: a server relaunched detached (an older `vs restart`,
or `relaunch.mode: detached-fallback` in the restart result) runs on the env it inherited, so unit `Environment=` lines and
drop-ins (`vibesquad.service.d/godot.conf`) do not apply, and `Restart=on-failure` no longer supervises it. A normal
`vs restart` re-adopts the unit by itself; do the steps below only when that path cannot be used. Hub Overlord, once, in a
drained window (every lead drained as for any restart: no running turns, no held background work):

1. Pids: `ss -ltnp 'sport = :4180'` (the server), `cat ~/.vibesquad/runner/runner.json` (the runner pid and port).
2. Stop the runner gracefully (keeps agents resumable):
   `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "authorization: Bearer $(cat ~/.vibesquad/runner/token)" http://127.0.0.1:<runner port>/shutdown`
   must print `202`; wait until `kill -0 <runner pid>` fails.
3. Stop the detached server: `kill -TERM <server pid>`; wait until `ss -ltn 'sport = :4180'` lists nothing.
4. `systemctl --user start vibesquad`
5. Verify: `systemctl --user is-active vibesquad` prints `active`; `systemctl --user show -p MainPID --value vibesquad`
   equals the pid in `ss -ltnp 'sport = :4180'`; `tr '\0' '\n' < /proc/<MainPID>/environ | grep '^GODOT_4_'` lists
   `GODOT_4_7` and `GODOT_4_8`; `runner.json` names a new live runner pid and `vs who lead` answers.
6. Agents the stop cut read `lost`: a `vs send` to each resumes it. If step 4 fails, read `journalctl --user -u vibesquad -b`;
   never leave the forge without a server (start it by hand only to bridge, then repeat from step 1).

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

Godot-lane agents run on the forge but drive the dev pp's loopback-only godot-mcp-runtime bridge over SSH stdio. The server
must be told which Godot to launch — it is not on the dev pp's PATH as a real exe (only a `.cmd` shim), so set `GODOT_PATH` to
a Godot console `.exe` in the remote command before `npx`, and `GODOT_MCP_DISABLE_ELICITATION=true` so the first-launch
confirmation never blocks the non-interactive stdio pipe:

```
ssh devpc 'set "GODOT_PATH=%USERPROFILE%\Documents\Dev\Engines\Godot_v4.7.2-stable_win64\Godot_v4.7.2-stable_win64_console.exe" && set "GODOT_MCP_DISABLE_ELICITATION=true" && npx -y godot-mcp-runtime@4.0.1'
```

`GODOT_PATH` is a single executable: godot-mcp-runtime has no per-project version, so the 4.x version is fixed per invocation
by which console exe you point it at. Always point it at the console `.exe`, never the `.cmd` shim (the server fails with
ENOENT). The dev pp's `C:\Dev` moved to `%USERPROFILE%\Documents\Dev` on 2026-11-24 (`C:\Dev` no longer exists; `%USERPROFILE%\projects` is unchanged). Console exes on the dev pp, by engine:

- 4.7.x (SBB, ForgeWirk): `%USERPROFILE%\Documents\Dev\Engines\Godot_v4.7.2-stable_win64\Godot_v4.7.2-stable_win64_console.exe`
- 4.8-dev7 mono (EFI): `%USERPROFILE%\Documents\Dev\Engines\Godot_v4.8-dev7_mono_win64\Godot_v4.8-dev7_mono_win64_console.exe`
- 4.8-dev3 mono: `%USERPROFILE%\Documents\Dev\Engines\Godot_v4.8-dev3_mono_win64\Godot_v4.8-dev3_mono_win64_console.exe`

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
   `docs/brainstorm/` and other ignored notes live), minus the heavy dirs (`HEAVY_DIRS` in the script: `node_modules`,
   `dist`, `dist-desktop`, `.godot`, `.import`, `build`, `export(s)`, `target` (Rust, e.g. `src-tauri/target`),
   `coverage`, `playwright-report`, `test-results`, `.tmp*`), `*.pck`, `*.exe`, and files over 50 MB; `docs/**` always
   goes in unless a file is over 200 MB.
   `manifest.json` `checkouts[]` lists path, bundle, untrackedTar, fileCount, bytes and every skip. Restore a tar with
   `tar -xf <repo>__untracked.tar -C <checkout>`.
   **Owner-delete work:** `--skip-bundle <repo>` or `--skip-bundle <repo>:<branch>` (repeatable) leaves that repo or
   branch (and the WIP of a worktree with that branch checked out) out; it is listed in `manifest.json`
   `skippedByOwner`. Nothing else is dropped: a main checkout with the skipped branch checked out still gets its
   `<repo>__untracked.tar`, and other unpushed branches that worktree owned go into `<repo>__repo.bundle`.
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
3a. **Transfer the backup to the forge** (step 3 writes it on the dev pp; C4 reviews it on the forge). Copy the whole
   backup dir, then check every file's sha256 on both sides. **Keep the dev pp copy: never delete it** (C4 decides
   about the forge copy only).
   ```
   ssh <user>@<forge mesh host> "mkdir -p ~/forge-backup"
   scp -r <dir>/* <user>@<forge mesh host>:~/forge-backup/
   # or: rsync -a --checksum <dir>/ <user>@<forge mesh host>:~/forge-backup/
   # dev pp (Git Bash) and forge must print the same lines:
   (cd <dir> && find . -type f -print0 | sort -z | xargs -0 sha256sum)
   ssh <user>@<forge mesh host> "cd ~/forge-backup && find . -type f -print0 | sort -z | xargs -0 sha256sum"
   ```
   Any difference: copy that file again and recheck before step 4. `<backup dir>` in C4 below is `~/forge-backup`.
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
5. **Clone the repos, then carry the untracked docs** (`scripts/forge-docs-sync.mjs`; `forge-migrate.mjs --sync-docs`
   and `--verify-briefs` dispatch to it). Lane briefs `docs/brainstorm/<lane>.md`, `docs/lanes/<lane>/{SPEC.md,TASKS.json}`
   and plans are gitignored or untracked, so a fresh clone has none and fresh Buddies and leads start without a brief.
   - Pre-check on the dev pp (read-only): `node scripts/forge-docs-sync.mjs --verify-briefs --teams C:\Users\<u>\.vibesquad\teams.json --projects-root C:\Users\<u>\projects`.
     A brief missing here is missing on the forge too: write it (lane Buddy) or accept the gap before going on.
   - Clone every project repo on the forge into `~/projects/<P>` under the folder name teams.json uses. Linux is
     case-sensitive: if the dev pp folder differs only in case from the teams.json name, clone under the teams.json name
     and add `--as <dev pp folder>=<teams.json name>` below.
   - From the dev pp, dry run, then the copy (over ssh to `<user>@<forge mesh host>`, BatchMode, key auth):
     ```
     node scripts/forge-docs-sync.mjs --sync-docs --from-projects C:\Users\<u>\projects --to <user>@<forge mesh host>:~/projects --dry-run
     node scripts/forge-docs-sync.mjs --sync-docs --from-projects C:\Users\<u>\projects --to <user>@<forge mesh host>:~/projects
     ```
     Per main checkout (`.git` is a folder) it takes `git ls-files --others -z -- docs` (untracked, ignored included),
     skips the same heavy dirs as the untracked tar (`HEAVY_DIRS`: `node_modules`, `.godot`, `dist`, `build`,
     `target`, ...) and files over 200 MB (listed), copies every eligible
     file into a local staging dir (printed; never deleted), then per repo over ssh: `git ls-files -s` (tracked paths),
     `sha256sum` of what already exists, one `tar -x -k` stream of the new files and a `sha256sum` check against the
     local hashes. A path the forge clone tracks is never written; an existing file that differs is kept and listed as
     CONFLICT; an identical one counts as `same`. A repo not cloned on the forge is listed and skipped. Re-running is
     safe (everything already there is `same`). The dev pp checkouts are only read. Exit 1 on any error.
   - **Done-check** on the forge (read-only): every lane in teams.json except `removed` ones and hidden helper lanes
     (Bug Runner / Perfection, warned only) has `<project dir>/docs/brainstorm/<lane>.md`, the project dir resolved as
     the server does (lane paths, then team paths, under `~/projects`; fallback `~/projects/VibeSquad`). Missing
     `docs/lanes/<lane>/` dirs are warnings. Must exit 0:
     ```
     node scripts/forge-docs-sync.mjs --verify-briefs --teams ~/.vibesquad/teams.json --projects-root ~/projects
     ```
6. Start the forge unit; leads and Buddies restart fresh from their briefs (C2).

## C4 backup review schedule (right after C2)

The dev pp backup zip and bundles live on the forge (copied in C2 step 3a; the dev pp copy is kept) until the owner says delete. Right after C2, on the forge,
create a **one-shot** VS schedule that reminds the owner about them in about 14 days. The agent it starts only reads
and reports; it never deletes. Loopback calls use the owner's local token (`x-vibesquad-token`, `~/.vibesquad/local-token`);
`POST /__vibesquad/schedules` goes to `server/schedules.mjs` `create()`. Do **not** add `runOnCreate`: it fires the
schedule at once (`server/schedules.mjs:344-345`) and, with `maxRuns: 1`, that would be its only run. The cron names a
fixed day and month, so it next fires about 14 days out; `maxRuns: 1` ends it after that run.

```
ssh <user>@<forge mesh host>
D=$(date -d '+14 days' +%-d); M=$(date -d '+14 days' +%-m); TZN=$(timedatectl show -p Timezone --value)
curl -fsS -X POST "http://127.0.0.1:<port>/__vibesquad/schedules" \
  -H "x-vibesquad-token: $(cat ~/.vibesquad/local-token)" -H 'content-type: application/json' --data-binary @- <<EOF
{
  "name": "Forge backup review (C4)",
  "cadence": { "type": "cron", "expression": "0 10 $D $M *", "timezone": "$TZN" },
  "maxRuns": 1,
  "target": { "type": "new-agent", "config": { "provider": "claude", "model": "claude-sonnet-5-5", "modeId": "auto", "thinkingOptionId": "low", "cwd": "/home/<user>/projects/VibeSquad" } },
  "prompt": "Forge backup review (C4). READ-ONLY: never delete, move, rename or modify any file. For every vibesquad-home-* archive and vibesquad-bundles-* folder under <backup dir>, report its full path, size (du -sh) and age in days (from its mtime). Then (1) run: vs log blocker 'needs-you: review forge backup: delete? <one line: paths, sizes, ages>'; (2) send the same line to the forge-host lane Buddy (vs who brainstorm --lane forge-host) and ask it to run: vs log needs-you \"review forge backup: delete?\". A schedule agent is a worker and the team log refuses needs-you from workers, so the Buddy logs it. Finish with the same report as your final message."
}
EOF
```

Check it (one entry, `maxRuns: 1`, `runCount: 0`, `nextRunAt` about 14 days out):
`curl -fsS "http://127.0.0.1:<port>/__vibesquad/schedules" -H "x-vibesquad-token: $(cat ~/.vibesquad/local-token)"`.
`<backup dir>` is where C2 step 3a put the zip and bundles on the forge (`~/forge-backup`); `<port>` defaults to 4180.

## Rollback notes (C3)

- After cutover only the dev pp STANDBY copy (the stopped server instance + its ~/.vibesquad standby copy) is retired after 2 weeks clean; the Windows install/run/release path stays first-class (C3 retires only that standby copy).
- Rollback: drain agents, `systemctl --user stop vibesquad` on the forge, copy the forge `~/.vibesquad` (minus `runtime/` and
  `worktrees/`) back to the dev pp, start dev pp VS, point clients' `server_url` back.
- One writer at a time: never run both servers against the same copy of `~/.vibesquad`.
- Push all branches from the forge before stopping it; worktrees are recreated from pushed branches.

## Removed

The interim workaround (`LOCALAPPDATA=$HOME/.local/share` and `apt install lsof`) is not needed once A1 (runtime dir) and A3
(listener lookup) are on master, and is not part of this setup.

## TMPDIR + WorkingDirectory (R4)

- The unit's `TMPDIR` defaults to `$HOME/.cache/vibesquad-tmp` (real disk, excluded from systemd-tmpfiles, R15), no longer
  `~/.vibesquad/tmp`. Every agent inherits it, and `server/test-guard.mjs` (`isForbiddenRealHome`) treats anything under
  the real `~/.vibesquad` as forbidden under a test runner, so test temp homes there made `restart-resume-safe` and
  `runner-restart-wait` fail. `forge-bootstrap.sh` refuses a `--tmpdir` under `~/.vibesquad`.
- `WorkingDirectory` is the synced runtime dir (`~/.vibesquad/runtime`, `--runtime-dir`), not `--repo`; before the first sync it
  falls back to `--repo` with a warning, so re-run the script after the first `vs restart`.
- Live unit (already bootstrapped): add a drop-in, then `systemctl --user daemon-reload` and restart on a quiet moment:
  `~/.config/systemd/user/vibesquad.service.d/tmpdir.conf` containing
  ```
  [Service]
  Environment=TMPDIR=%h/.cache/vibesquad-tmp
  ```
  (and `mkdir -p ~/.cache/vibesquad-tmp`). The old `~/.vibesquad/tmp` stays in the tmpfiles exclusion until the unit is switched.

### Live-agent ceiling (idea-896, 2026-11-25)
`runner/runner.mjs` caps live agent processes at `VS_RUNNER_MAX_LIVE` (default 16); over it, sends and spawns wait in the
admission queue (`vs status` shows them `queued`). On forge the cap, not RAM or CPU, was the limit (16/16 live, ~0.4 GB per agent
tree, 53 GB free). Drop-in `~/.config/systemd/user/vibesquad.service.d/runner.conf`:
```
[Service]
Environment=VS_RUNNER_MAX_LIVE=24
Environment=VS_RUNNER_TURN_CAP_ANTIGRAVITY=6
```
then `systemctl --user daemon-reload`; it takes effect at the next drained restart. Disk is the next limit (EFI worktrees
290-560 MB each, `/` at 83%): go to 28+ only after the disk is extended. Per-provider turn caps (`VS_RUNNER_TURN_CAP_<FAMILY>`,
defaults claude 12 / gemini 4 / antigravity 3 / other 4): forge sets `VS_RUNNER_TURN_CAP_ANTIGRAVITY=6` in the same drop-in (owner 11-25, Gemini quota mostly unused; 3 had no recorded reason).
