# PLAN: move the homelab GitHub Actions runners from the dev pp VM to the forge (idea-737)

Status 2026-11-25: **Phase 1 ACTIVE (§7, +2..6 forge `homelab-priority` slots, additive; the VM keeps its 4 `homelab-priority` + 2 `homelab`, per the 11-25 MediaPP check). §7 is the runbook; §4/§5 commands are superseded where §7 differs (O2, O4, O6, `-M` are unsafe or broken).** The full move (§5 O8-O10) stays parked as idea-738.
Earlier status: **PARKED 2026-11-24** (owner: move runners later, not soon; tracked as idea-738). Inventory + plan only; the security review was cancelled before it finished, so re-review §2-§4 before starting. Nothing was registered, installed, removed or changed. Evidence was gathered 2026-11-24 ~02:00-02:30Z
(9:00-9:30 PM ET on 11-23) from `gh api` / `gh run list`, the local repo checkouts, and read-only listing over `ssh devpc` → `ssh gh-runner`.

## 1. Inventory

### 1a. Runners today (all in the `gh-runner` Hyper-V VM on the dev pp)
Repo-level runners: `gh api repos/IdleMinds-Dev/{<efi-repo>,SportsBallBattles,Pillbille,ForgeWirk}/actions/runners` → `total_count 0` each.
Org-level list: `gh api orgs/IdleMinds-Dev/actions/runners` → 403 "must be an org admin" (the VS gh token has `gist, read:org, repo, workflow` only,
and it should stay that way). The runner identities below come from the job API (`.../runs/<id>/jobs` → `runner_name`, `runner_group_name`, `labels`)
plus `docker inspect` inside the VM.

| Slot (systemd unit in VM) | Container | Labels (`LABELS=`) | Name prefix | Mem cap (+swap) | CPU cap |
|---|---|---|---|---|---|
| `gh-runner@priority` | `gh-runner-priority` | `homelab-priority` | `homelab-priority-<rand>` | 4 GB (6 GB total) | none |
| `gh-runner@priority-2` | `gh-runner-priority-2` | `homelab-priority` | `homelab-priority-<rand>` | 4 GB (6 GB total) | none |
| `gh-runner@1` | `gh-runner-1` | `homelab,linux,x64` | `homelab-<rand>` | 2 GB (3 GB total) | none |
| `gh-runner@2` | `gh-runner-2` | `homelab,linux,x64` | `homelab-<rand>` | 2 GB (3 GB total) | none |

- All four: image `myoung34/github-runner:ubuntu-noble` (3.32 GB), runner 2.338.2, `RUNNER_SCOPE=org`, `ORG_NAME=IdleMinds-Dev`, `EPHEMERAL=true`,
  runner group `default` (pool "Default"), auth by `ACCESS_TOKEN` (a PAT, kept in `~runner/github-runners/.env` in the VM, mode 600).
- `/usr/local/bin/gh-runner-slot <slot>`: `docker rm -f`, wipe `/tmp/github-runner/slot-<slot>`, then `docker compose run --rm` one job container;
  systemd `Restart=always` makes a fresh container per job. Binds: `/opt/ci-toolcache` (ro, empty, 4 KB), **`/var/run/docker.sock` (rw)**, `/tmp/github-runner` (rw).
- `homelab-priority` = EFI's reserved pair (EFI AGENTS.md:73-75: "exactly that one label"); `homelab` = shared general pair (SBB, Pillbille).

### 1b. The VM (dev pp, `Get-VM` / `Get-VHD`, read-only)
`gh-runner`: Gen 2, Running, 8 vCPU, 12 GB static RAM (`DynamicMemoryEnabled False`), `AutomaticStartAction Start`. Inside: Ubuntu 24.04.5, `/` 76 GB, 11 GB used.
Disks: `C:\ProgramData\Microsoft\Windows\Virtual Hard Disks\gh-runner.vhdx` dynamic, max 80 GB, **file 70.7 GB** (what the owner gets back),
plus `gh-runner-seed.vhdx` 0.1 GB. Dev pp C: 402 GB free / 549 GB used.

### 1c. Repos
All three target repos: `private`, `allow_forking false`, Actions enabled `allowed_actions all`, no repo/org Actions secrets visible
(`.../actions/secrets` and `.../organization-secrets` both empty), no repo variables. Fork-PR approval does not apply to private repos (API 422).
Other ~/projects repos: no `homelab` label in any workflow. Public repos (`Pizzarar/VibeSquad`, `Squadz`, `RedFrontier`, `Roster`, `Pssst...`) are
personal-account repos, so they **cannot** reach the org runners; keep it that way (never register a runner to a public repo).
ForgeWirk (private, same org) uses no homelab job today but can, since the `default` group serves all org repos.

| Repo | Workflow (file:line of `runs-on`) | Trigger | Needs | Recent duration / frequency |
|---|---|---|---|---|
| EFI | tests.yml:406 `${{ vars.EFI_CI_RUNNER \|\| 'homelab-priority' }}` | push, PR, dispatch | Godot 4.8-dev7 zip (SHA-pinned, tests.yml:612) cached at `~/godot` (actions/cache, :593); `$SUDO apt-get install libfontconfig1` (:446-452); upload-artifact (:932); concurrency per ref, cancel | PR 15-20 min, push 5 min; 30 runs in ~2 h (00:04-02:02Z 11-24); queue waits up to 14 min (guard 45306953729 created 01:41:52Z, started 01:56:09Z) |
| EFI | release.yml:37 `homelab-priority` | push tag, dispatch | Godot + export templates (cached), libfontconfig1, export + boot check, artifact | rare |
| EFI | secret-scan.yml:32, automerge-guard.yml:23 | push/PR | gitleaks tarball (SHA-pinned); GITHUB_TOKEN only | <1 min |
| SBB | ci.yml:23,72,151,166 `[self-hosted, homelab]` | push, PR, dispatch | `sudo apt-get install curl unzip` (:35); Godot 4.7.2 cached; GUT suite; Web export + templates; **android job**: setup-java 17, android-actions/setup-android (SDK cached `~/.android/sdk`); upload-pages-artifact + deploy-pages | 30-38 min per run (test job ~31 min); several per day |
| SBB | balance-report.yml:40 | cron `37 6 * * *` (1:37 AM ET), dispatch | `sudo apt-get install git curl unzip`; Godot; artifact | 0-4 min nightly |
| SBB | shots.yml:31 | dispatch only | `sudo apt-get install xvfb xauth libgl1-mesa-dri libglx-mesa0` (:37-38) | on demand |
| SBB | automerge-guard.yml:20 | PR | GITHUB_TOKEN | <1 min |
| Pillbille | ci.yml:17, automerge-guard.yml:20 `[self-hosted, homelab]` | push, PR, dispatch | setup-java 17, setup-android (android-36), setup-gradle, `./gradlew assembleDebug test` | 4-9 min; rare (last run 2026-10-31) |

No workflow uses `docker run`, `container:` or `services:` (grep of all three `.github/workflows/`), so the docker.sock bind is unused.
Jobs DO need root-in-sandbox (`sudo apt-get`, SBB has no `$SUDO` fallback) and outbound HTTPS (github.com, godot-builds, dl.google.com, Maven).

## 2. Forge capacity (now)
`nproc` 20 (i9-13900H, same CPU as the dev pp), RAM 61 GB (13 used, 47 available), swap 7 GB, load avg 2.05/1.49/1.53 with ~10 node,
3 claude, 2 opencode and 1 `godot-4.8-dev7` (84% CPU) running. Disk: `/` LV 100 GB, 55 GB free; **the `ubuntu-vg` VG on the 954 GB NVMe has
~850 GB unallocated**. `/tmp` is tmpfs 31 GB. No docker/podman/lxc/virsh/qemu; `/dev/kvm` present. `podman` 5.7.0 and `docker.io` 29.1.3 are in apt.
cgroup v2 with `cpu memory pids` delegated to user managers. AppArmor `apparmor_restrict_unprivileged_userns=1`.

## 3. Risks
1. **Same-user runner = full VS compromise.** A job as `<vs-user>` reads `~/.vibesquad` (700), `~/.config/gh/hosts.yml`, `~/.ssh/id_ed25519` (the dev pp
   key) and provider logins. Never run the runner as `<vs-user>`, and never give it docker-group or sudo.
2. **docker.sock in the job container (today).** Any job (or a hijacked `@v4` action tag) can start a privileged sibling container = root on the VM,
   and `docker inspect` the runner containers to read `ACCESS_TOKEN` (env name confirmed, value not read). Contained by the VM today; on the forge the
   same design would be root on the forge. Do not port it.
3. **Org PAT lives on the runner host.** Whoever owns the runner user can register runners. Keep it out of the job container (JIT config, below)
   and scope it down (fine-grained, org "Self-hosted runners: read and write" only).
4. **Network reach.** VS listens on 127.0.0.1:4180, the LAN IP and the Meshnet IP; a job could probe the VS API, the dev pp over Meshnet, and the LAN.
5. **Starvation.** CI (Godot suites, Gradle) can eat all 20 threads; without a slice cap VS agents and local Godot suites slow down.
6. **Disk.** Image 3.3 GB + job workdirs + Gradle/SDK caches could fill `/` (55 GB free) and take VS down.
7. Cold caches after the move: the cache key hashes the workspace-relative `$HOME` path (e.g. EFI tests.yml:584-599), so the first runs re-download Godot/SDK.

## 4. Recommended design
> Superseded for execution by §7 (P0 review fixes: JIT via env not argv, no registration-token fallback, own nft table incl. IPv6, caps).

**Dedicated unprivileged user `ghrunner` + rootless Podman, same `myoung34/github-runner:ubuntu-noble` image, 4 ephemeral slots, inside a capped systemd slice,
on its own LV, with JIT registration and an egress block to local networks.** Why not the alternatives:
- *Rootless container, same user*: shares `<vs-user>`'s home. Rejected (risk 1).
- *KVM VM on the forge*: strongest boundary (own kernel) and a 1:1 copy of today, but needs libvirt/qemu, a static 12 GB RAM reservation, a VM to patch,
  and still carries risk 2 inside it. Keep it as the fallback if the owner wants kernel-level isolation.
- *Rootless Podman under its own user*: job root maps to a `ghrunner` subuid; no host root, no access to `<vs-user>`'s 750 home; cgroup caps via systemd;
  fresh container per job keeps today's semantics (`sudo apt-get`, clean FS). Host-kernel escape is the residual risk, acceptable for private repos run by org members.

Layout:
| Slot | Labels | Name prefix | Mem cap per container |
|---|---|---|---|
| `forge-runner@priority`, `@priority-2` | `homelab-priority` | `forge-priority` | 4 GB + 2 GB swap |
| `forge-runner@1`, `@2` | `homelab,linux,x64` | `forge` | 2 GB + 1 GB swap |

- Same labels, new name prefix so `runner_name` proves where a job ran. Four slots keeps today's throughput (EFI already queues up to 14 min with two).
- Whole `ghrunner` slice: `CPUQuota=800%` (the VM's 8 vCPU), `MemoryMax=14G`, `CPUWeight=20` and `IOWeight=20` (VS units default 100, so VS wins
  contention), `TasksMax=4096`. Containers also get `--cpus 4` and `nice 10` inside the slot script. 12 threads stay free for VS at worst.
- Slot script (`~ghrunner/bin/forge-runner-slot`, port of `gh-runner-slot`): call `POST /orgs/IdleMinds-Dev/actions/runners/generate-jitconfig`
  (labels, `runner_group_id` 1, name `<prefix>-<rand>`) with the host-side token, then `podman run --rm` the image with the entrypoint overridden to
  `/actions-runner/run.sh --jitconfig <cfg>`. No socket binds, no token in the container env. Verify in A3 that the image's run.sh accepts `--jitconfig`
  (runner 2.338 does upstream); if not, fall back to a 1-hour registration token (`RUNNER_TOKEN`) instead of the PAT.
- Egress: nftables `meta skuid ghrunner` drop to 127.0.0.0/8 (except DNS stub), 10/8, 172.16/12, 192.168/16, 100.64/10 (Meshnet). Public internet allowed.

## 5. Steps
> Do not run as written: O2 has no free extents, O3's `usermod --add-subuids` overlaps useradd's range, O4 exposes the PAT, O6 flushes ufw/NordVPN rules, `systemctl --user -M` needs the absent systemd-machined. Phase 1 runs §7. Rework from §7 before any full move.

### Owner steps (sudo / GitHub UI). Substitute `<vs-user>` with the VS login.
- O1 Packages: `sudo apt-get install -y podman uidmap passt fuse-overlayfs`
- O2 Disk: `sudo lvcreate -L 80G -n ghrunner ubuntu-vg && sudo mkfs.ext4 -L ghrunner /dev/ubuntu-vg/ghrunner && sudo mkdir -p /srv/ghrunner`
  then `echo 'LABEL=ghrunner /srv/ghrunner ext4 defaults,nodev,nosuid 0 2' | sudo tee -a /etc/fstab && sudo mount /srv/ghrunner`
- O3 User: `sudo useradd -d /srv/ghrunner -M -s /usr/sbin/nologin -U ghrunner && sudo chown ghrunner:ghrunner /srv/ghrunner && sudo chmod 700 /srv/ghrunner`
  `sudo usermod --add-subuids 200000-265535 --add-subgids 200000-265535 ghrunner && sudo loginctl enable-linger ghrunner`
- O4 Let agents act as ghrunner (never the reverse): `echo '<vs-user> ALL=(ghrunner) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/ghrunner && sudo chmod 440 /etc/sudoers.d/ghrunner && sudo visudo -c`
- O5 Slice cap: `sudo mkdir -p /etc/systemd/system/user-$(id -u ghrunner).slice.d` and write `caps.conf` there with
  `[Slice]` `CPUQuota=800%` `MemoryMax=14G` `MemorySwapMax=4G` `CPUWeight=20` `IOWeight=20` `TasksMax=4096`; then `sudo systemctl daemon-reload`.
- O6 Egress: `sudo install -m 644 <agent-drafted file from A2> /etc/nftables.d/ghrunner.nft`, include it from `/etc/nftables.conf`, `sudo systemctl enable --now nftables`.
- O7 GitHub token: create a fine-grained PAT, resource owner IdleMinds-Dev, org permission **Self-hosted runners: Read and write** only, 90-day expiry
  (or a GitHub App with that permission). Paste it with `sudo -u ghrunner sh -c 'umask 077; cat > /srv/ghrunner/.config/forge-runner/token'` (after A1 creates the dir).
- O8 Cut-over: when A5 says the forge pool is up, stop the VM pool (dev pp): `ssh gh-runner "sudo systemctl disable --now gh-runner@1 gh-runner@2 gh-runner@priority gh-runner@priority-2"`.
- O9 Pillbille has no regular traffic: approve one `workflow_dispatch` of Pillbille CI (owner or explicit OK for an agent).
- O10 VM retire (after V-all passes and 7 clean days): on the dev pp, admin PowerShell: `Stop-VM gh-runner`, `Set-VM gh-runner -AutomaticStartAction Nothing`;
  then `Remove-VM gh-runner -Force` and delete both `gh-runner*.vhdx` under `C:\ProgramData\Microsoft\Windows\Virtual Hard Disks\` (70.8 GB back).
  Revoke the VM's old `ACCESS_TOKEN` PAT on GitHub; check Org → Settings → Actions → Runners shows no offline `homelab-*` entries (remove any).

### Agent steps (as `sudo -u ghrunner`, after O1-O5; no workflow, repo setting or org change)
- A1 Create `/srv/ghrunner/{bin,.config/forge-runner}`, `podman pull docker.io/myoung34/github-runner:ubuntu-noble`, `podman info` shows rootless + cgroup v2.
- A2 Draft `ghrunner.nft` (owner installs in O6) and test it: `sudo -u ghrunner curl -m5 http://127.0.0.1:4180/` fails, `curl -m5 https://api.github.com` works.
- A3 Write `forge-runner-slot` + user unit `forge-runner@.service` (Restart=always, RestartSec=5, Nice=10). Dry-check the image: `podman run --rm --entrypoint /actions-runner/run.sh <image> --help` lists `--jitconfig`.
- A4 Start one general slot only: `systemctl --user -M ghrunner@ enable --now forge-runner@1`; the job API later shows `forge-*`. Then the other three.
- A5 Report "forge pool up" with `systemctl --user -M ghrunner@ status 'forge-runner@*'` and `podman ps`; owner does O8.
- A6 Watch load for 24 h: `systemd-cgtop -1 user.slice` and VS suite times stay in their normal range.

## 6. Done-check (per repo, read-only)
For the first run after O8: `gh api repos/IdleMinds-Dev/<repo>/actions/runs/<id>/jobs --jq '.jobs[]|[.name,.runner_name,.conclusion]|@tsv'`
- V-EFI: a `tests` run on a push or PR: every job `runner_name` starts `forge-priority-`, conclusion `success`.
- V-SBB: one `CI` run (test, web, android, ci jobs on `forge-`, success) and the nightly `Balance report` (1:37 AM ET).
- V-Pillbille: the O9 dispatch, `ci` job on `forge-`, success.
- V-all: no job in the 3 repos picked up by `homelab-*` after O8, `ghrunner` slice never hit `MemoryMax` (`systemctl show user-$(id -u ghrunner).slice -p MemoryPeak`).
Rollback any time before O10: stop the forge slots (§7 Rollback) and re-enable the VM units.

## 7. Phase 1 (2026-11-25): +2..6 forge `homelab-priority` runners, additive
Ask (owner, relayed Rif2 (EFI hub) -> Hub3 -> forge-host, verbatim): "add 2 more forge CI runners, homelab-priority, on top of the VM's existing 2, rootless Podman per PLAN_CI_RUNNERS.md. Security re-review first; the PAT step goes to the owner."
Urgency 11-25: the dev pp runner VM is unreachable (EFI CI fully down, ~100 jobs queued), so these 2 slots are EFI's only CI until the VM is back.
This section is the complete Phase-1 runbook. It replaces §4's slot/egress bullets and §5 O1-O7/A1-A6 for Phase 1; do not run those.

### Decided
- Additive: VM pool untouched (no O8/O9/O10). Six forge slots `forge-runner@f1`..`@f6` (renamed from `priority-3`/`-4`: the VM now also runs `gh-runner@priority-3`/`-4`; VM pool is now 4 `homelab-priority` + 2 `homelab` after the 11-25 MediaPP check). Start f1, f2; enable f3, f4 after >= 3 h with VS healthy (A6b), then f5, f6 after another >= 3 h healthy at 4 slots (A6c). Label `homelab-priority` only, name prefix `forge-priority-f<n>-<hex>`, org `IdleMinds-Dev`, runner group 1 (Default, as the VM).
- Own user `ghrunner` (home `/srv/ghrunner` 0700), rootless Podman 5.7 + pasta, image `myoung34/github-runner:ubuntu-noble` (runner 2.338.2), one fresh container per job, no socket binds.
- Disk: `/` owns the whole VG (no LV possible), so CI gets a 160 GB ext4 in a loop image, `/var/lib/ghrunner.img` **0600 root** (a 0644 image lets any local user read the PAT off the raw blocks).
- **Agents never get `(ghrunner) ALL`** (old O4 dropped, never created). Slot script, unit and egress rules are root-owned files the owner installs; the VS login gets one sudo rule for a root-owned wrapper `forge-runner-ctl` with fixed verbs (info, pull, smoke, probe, status, start/stop/restart, enable/disable, logs, envnames) and a slot allow-list. It cannot read the PAT or run free-form code as `ghrunner`.
  Reviewers split (Gemini: revoke O4 before the PAT, wrapper optional; Claude: revoke + root-owned files, status-only wrapper): took never-grant + a fixed-verb wrapper, because no window where agents own the PAT is safer than a revoke step, and agents can still run P2/P4 without the owner.
- PAT: fine-grained, resource owner IdleMinds-Dev, org permission **Self-hosted runners: Read and write** only, 90 days. Stored `/srv/ghrunner/.config/forge-runner/token` (ghrunner 0600). Read by a root process (`forge-runner-set-token`), never by a VS-uid shell.
- JIT config: the slot script calls `generate-jitconfig` with the PAT fed to curl on stdin (`--config -`), then passes the config as env `ACTIONS_RUNNER_INPUT_JITCONFIG` (podman `--env NAME`, no value in argv).
  Verified in actions/runner `src/Runner.Listener/CommandSettings.cs`: `run` accepts `jitconfig`; env `ACTIONS_RUNNER_INPUT_*` is read, masked as a secret, and removed from the Listener env.
  Reviewers split (Gemini: stdin into `run.sh --jitconfig "$cfg"`; Claude: env): took env, because the stdin wrapper still puts the config in run.sh's argv, which the host `/proc/*/cmdline` shows to every user (no `hidepid`). `/proc/<pid>/environ` is owner-only. No registration-token or PAT fallback, ever: if JIT fails, stop and re-plan.
- Egress: own nft table `inet ghrunner_egress` loaded by `ghrunner-egress.service`; the base chain only `jump`s on `meta skuid $U` (kernel-sent packets: RST, ICMP, IPv6 NDP, kernel-WireGuard `nordlynx` UDP have no socket uid and must never reach the rejects); never `flush ruleset`, never enable `nftables.service` (its `/etc/nftables.conf` flushes ufw + NordVPN rules). For uid ghrunner: allow DNS to 127.0.0.53, reject **all IPv6**, every local/broadcast/multicast address (`fib daddr type`), and 0/8, 10/8, 100.64/10 (Meshnet), 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/3. Public IPv4 allowed.
  `user@<ghrunner-uid>.service` `Requires=` the egress unit and the mount (fail closed), and the slot script refuses to start if `127.0.0.1:22` is reachable as ghrunner (canary for a wiped table). Containers run `--network=pasta:-4,--no-map-gw` (no IPv6, no gateway-to-host mapping); nft is the real control.
  Reviewers split (drop vs reject): took reject (same block, clients fail fast instead of hanging).
- Caps (slice `user-<uid>.slice`): `CPUQuota=1200%`, `CPUWeight=20`, `MemoryHigh=25G`, `MemoryMax=26G` (6 x 4 GB jobs + 2 GB), `MemorySwapMax=0`, `TasksMax=8192`, `IOWeight=20` + `IORead/WriteBandwidthMax` 600M/300M on the image's backing device. Per container `--cpus=4 --memory=4g --memory-swap=4g --pids-limit=2048`, `Nice=10`.
  Reviewers split on swap (Gemini 1G/0, Claude 2G): took 0, because host swap is already full and swapping CI would slow VS; 4 GB RAM per job (matches the VM, which has 4+2 with swap): six slots must fit under the 26G slice and there is no swap because host swap is full.
- Temp: `TMPDIR` and podman `image_copy_tmp_dir` = `/srv/ghrunner/tmp`; nothing of ghrunner's lands on the host's RAM-backed `/tmp`. Job workdirs live in the container (on `/srv`).
- Restart: `Restart=always`, `RestartSec=5`, no start limit (every finished job is a restart, so a limit would stop a healthy slot). The script backs off 60 s on API errors or a failed short run, and exits 64/70/78 (no restart) on bad slot, missing egress or a bad/missing PAT.
  Reviewers asked for `StartLimit*`; took script-side backoff for the reason above. On exit the script DELETEs its runner registration if no job consumed it.
- `systemctl --user -M ghrunner@` is not used: `systemd-machined` is not installed on the forge. The wrapper runs commands as ghrunner via `runuser` with `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `TMPDIR` set.
- Host facts 11-25 (read-only): Ubuntu 26.04, kernel 7.0, systemd 259, `apparmor_restrict_unprivileged_userns=1`, AppArmor ships `podman`/`crun` userns profiles; `/etc/subuid` has one range (VS login 100000:65536) and `login.defs` `SUB_UID_COUNT 65536`, so `useradd` adds ghrunner's range itself;
  no `/etc/nftables.d`, `nftables` inactive, `ufw` + `nordvpnd` active; resolv.conf stub 127.0.0.53; sshd/SMB/CUPS listen on `0.0.0.0` and `[::]`; `/tmp` tmpfs 31 GB; `jq` present; no `systemd-machined`.
- Reviewers: Claude + Gemini only (no DeepSeek, owner 11-26 rule). VS has no CI-runner primitive; this plan + `gh api` job `runner_name` is the done-check source.

### 7a. Owner block S (one paste; idempotent; safe before the PAT exists)
Run from the VS login. It installs packages, makes the image + user + egress + caps, installs the root-owned slot script, unit, wrapper and token tool, and writes the one sudo rule. Re-running is safe: it never re-formats an existing image, and it reloads the nft table atomically without restarting runners.
First run `sudo -v` on its own and enter the password; only then paste the block (otherwise the password prompt eats the next pasted line).
```bash
sudo install -m 0700 -o root -g root /dev/null /root/forge-runner-setup.sh
sudo tee /root/forge-runner-setup.sh >/dev/null <<'SETUP'
#!/bin/bash
# PLAN_CI_RUNNERS sec 7a: forge Phase-1 CI runners. Idempotent; safe before the PAT exists.
set -euo pipefail
VS_USER=${SUDO_USER:?run as: sudo bash /root/forge-runner-setup.sh  from the VS login}
id "$VS_USER" >/dev/null
cd /
RU=ghrunner; IMG=/var/lib/ghrunner.img; H=/srv/ghrunner
export DEBIAN_FRONTEND=noninteractive
put() { # put MODE DEST <content: atomic replace, root-owned (never rewrite a running script in place)
  local t; t=$(mktemp "$2.XXXXXX"); cat > "$t"; chown root:root "$t"; chmod "$1" "$t"; mv -f "$t" "$2"; }

# S1 packages (kernel 7.0 has native rootless overlay: no fuse-overlayfs)
apt-get update -q </dev/null
apt-get install -y -q podman uidmap passt jq </dev/null

# S2 own 160 GB ext4 in a root-only image; format only if it has no ext4 yet
if ! blkid -p -s TYPE -o value "$IMG" 2>/dev/null | grep -qx ext4; then
  install -m 0600 -o root -g root /dev/null "$IMG"
  fallocate -l 160G "$IMG"
  mkfs.ext4 -q -L ghrunner "$IMG" </dev/null
fi
chown root:root "$IMG"; chmod 0600 "$IMG"
mkdir -p "$H"
grep -q "^$IMG " /etc/fstab || echo "$IMG $H ext4 loop,nodev,nosuid,nofail 0 0" >> /etc/fstab
systemctl daemon-reload
mountpoint -q "$H" || mount "$H"

# S3 user; useradd adds exactly one 65536 subuid/subgid range (no usermod --add-subuids: it overlaps)
id "$RU" >/dev/null 2>&1 || useradd -d "$H" -M -s /usr/sbin/nologin -U "$RU"
for f in /etc/subuid /etc/subgid; do
  [[ $(grep -c "^$RU:" "$f") == 1 ]] || { echo "$f: need exactly one $RU range" >&2; exit 1; }
done
U=$(id -u "$RU")
chown "$RU:$RU" "$H"; chmod 0700 "$H"   # $H's parent /srv is root-owned: ghrunner cannot swap $H itself
# Root never writes or chowns inside ghrunner's home (ghrunner could plant symlinks there): ghrunner does it.
runuser -u "$RU" -- install -d -m 0700 "$H/tmp" "$H/.config" "$H/.config/forge-runner" "$H/.config/containers"
printf '[engine]\nimage_copy_tmp_dir = "%s/tmp"\n' "$H" \
  | runuser -u "$RU" -- /bin/sh -c 'umask 077; cat > "$1/.config/containers/containers.conf"' sh "$H"

# S4 egress: own table, never 'flush ruleset'; runners fail closed without it
install -d -m 0755 /etc/nftables.d
put 0644 /etc/nftables.d/ghrunner.nft <<NFT
#!/usr/sbin/nft -f
# Egress block for uid $U ($RU), PLAN_CI_RUNNERS sec 7. Own table: ufw + NordVPN rules live elsewhere.
table inet ghrunner_egress
delete table inet ghrunner_egress
table inet ghrunner_egress {
  # Positive uid match only: 'skuid != U accept' would NOT match socketless (kernel-sent) packets,
  # so host RSTs/ICMP/NDP/WireGuard would fall through to the rejects and break host networking.
  chain output {
    type filter hook output priority filter; policy accept;
    meta skuid $U jump ghrunner
  }
  chain ghrunner {
    ip daddr 127.0.0.53 meta l4proto { tcp, udp } th dport 53 return
    meta nfproto ipv6 reject with icmpx admin-prohibited
    fib daddr type { local, broadcast, multicast } reject with icmpx admin-prohibited
    ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3 } reject with icmpx admin-prohibited
  }
}
NFT
nft -c -f /etc/nftables.d/ghrunner.nft
put 0644 /etc/systemd/system/ghrunner-egress.service <<'UNIT'
[Unit]
Description=Egress block for the ghrunner CI user (own nft table; never flushes the ruleset)
After=nftables.service ufw.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/nftables.d/ghrunner.nft

[Install]
WantedBy=multi-user.target
UNIT
install -d -m 0755 "/etc/systemd/system/user@$U.service.d" "/etc/systemd/system/user-$U.slice.d"
put 0644 "/etc/systemd/system/user@$U.service.d/forge.conf" <<'UNIT'
[Unit]
# ghrunner's user manager (and so every runner) starts only with the egress table and /srv/ghrunner up.
Requires=ghrunner-egress.service
After=ghrunner-egress.service
RequiresMountsFor=/srv/ghrunner
UNIT

# S5 caps for the whole ghrunner slice (VS units keep weight 100)
put 0644 "/etc/systemd/system/user-$U.slice.d/caps.conf" <<'UNIT'
[Slice]
CPUQuota=1200%
CPUWeight=20
MemoryHigh=25G
MemoryMax=26G
MemorySwapMax=0
TasksMax=8192
IOWeight=20
IOReadBandwidthMax=/var/lib/ghrunner.img 600M
IOWriteBandwidthMax=/var/lib/ghrunner.img 300M
UNIT

# S6 slot script (runs as ghrunner from the user unit)
install -d -m 0755 /usr/local/libexec
put 0755 /usr/local/libexec/forge-runner-slot <<'SLOT'
#!/bin/bash
# forge-runner-slot SLOT: one ephemeral JIT runner container, then exit (forge-runner@.service restarts it).
# PLAN_CI_RUNNERS sec 7. Runs as ghrunner. Never prints the PAT or the JIT config; never puts either in argv.
set -euo pipefail
umask 077
export LC_ALL=C
slot=${1:-}
[[ $slot =~ ^f[1-6]$ ]] || { echo "bad slot '$slot'" >&2; exit 64; }
ORG=IdleMinds-Dev
GROUP_ID=1                     # Default group, as the VM runners
LABEL=homelab-priority
IMAGE=docker.io/myoung34/github-runner:ubuntu-noble
NET=pasta:-4,--no-map-gw       # keep in sync with forge-runner-ctl
TOKEN_FILE=/srv/ghrunner/.config/forge-runner/token
API=https://api.github.com/orgs/$ORG/actions/runners
ctr=forge-runner-$slot
name=forge-priority-${slot}-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
rid=

# Fail closed: with the egress table loaded, ghrunner cannot reach host sshd on loopback.
if timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/22' 2>/dev/null; then
  echo "egress block missing (127.0.0.1:22 reachable as ghrunner): not starting" >&2; exit 70
fi
[[ -s $TOKEN_FILE ]] || { echo "no PAT yet at $TOKEN_FILE (owner step O7)" >&2; exit 78; }

gh_api() { # METHOD URL [JSON] -> body, newline, HTTP code. The PAT reaches curl on stdin, never argv/env.
  local tok args=(-sS -m 30 --config - -X "$1" -H 'Accept: application/vnd.github+json'
                  -H 'X-GitHub-Api-Version: 2022-11-28' -w '\n%{http_code}')
  [[ $# -ge 3 ]] && args+=(--data "$3")
  tok=$(<"$TOKEN_FILE")
  printf 'header = "Authorization: Bearer %s"\n' "$tok" | curl "${args[@]}" "$2"
}
cleanup() { # drop the registration if no job consumed it (404 after a finished job is fine)
  podman rm -f -i -t 10 "$ctr" >/dev/null 2>&1 || true
  [[ -z $rid ]] || gh_api DELETE "$API/$rid" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 143' TERM INT

podman rm -f -i "$ctr" >/dev/null 2>&1 || true
body=$(jq -nc --arg n "$name" --arg l "$LABEL" --argjson g "$GROUP_ID" \
  '{name: $n, runner_group_id: $g, labels: [$l], work_folder: "_work"}')
out=$(gh_api POST "$API/generate-jitconfig" "$body") \
  || { echo "generate-jitconfig: network error, retry in 60 s" >&2; sleep 60; exit 75; }
code=${out##*$'\n'}
case $code in
  201) ;;
  401|403) echo "generate-jitconfig HTTP $code: PAT expired/revoked or lacks 'Self-hosted runners: write' (O7)" >&2; exit 78 ;;
  *) echo "generate-jitconfig HTTP $code: retry in 60 s" >&2; sleep 60; exit 75 ;;
esac
out=${out%$'\n'*}
rid=$(jq -r '.runner.id' <<<"$out")
ACTIONS_RUNNER_INPUT_JITCONFIG=$(jq -r '.encoded_jit_config' <<<"$out")
export ACTIONS_RUNNER_INPUT_JITCONFIG
unset out
echo "slot $slot: $name (runner id $rid) waiting for one job"

rc=0; t0=$SECONDS
podman run --rm --name "$ctr" --hostname "$name" --pull=never \
  --user runner --entrypoint /actions-runner/run.sh \
  --env ACTIONS_RUNNER_INPUT_JITCONFIG --env RUNNER_MANUALLY_TRAP_SIG=1 \
  --network="$NET" --cpus=4 --memory=4g --memory-swap=4g --pids-limit=2048 \
  --label forge-runner="$slot" "$IMAGE" || rc=$?
unset ACTIONS_RUNNER_INPUT_JITCONFIG
echo "slot $slot: $name exited rc=$rc after $((SECONDS - t0)) s"
if (( rc != 0 && SECONDS - t0 < 60 )); then echo "short failed run: back off 60 s" >&2; sleep 60; exit 75; fi
exit 0
SLOT

# S7 user unit, root-owned (ghrunner cannot edit it; ConditionUser keeps it inert for every other user)
put 0644 /etc/systemd/user/forge-runner@.service <<'UNIT'
[Unit]
Description=Forge CI runner slot %i (one ephemeral JIT runner per job, homelab-priority)
ConditionUser=ghrunner
# Every finished job is a restart, so no start limit (it would stop a healthy slot). The slot script
# backs off 60 s on API/start errors and exits 64/70/78 (no restart) on bad slot / no egress / bad PAT.
StartLimitIntervalSec=0

[Service]
Type=exec
WorkingDirectory=/srv/ghrunner
Environment=TMPDIR=/srv/ghrunner/tmp DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus
ExecStart=/usr/local/libexec/forge-runner-slot %i
ExecStopPost=-/usr/bin/podman rm -f -i -t 10 forge-runner-%i
Restart=always
RestartSec=5
RestartPreventExitStatus=64 70 78
SuccessExitStatus=143
Nice=10
UMask=0077
TimeoutStopSec=120

[Install]
WantedBy=default.target
UNIT

# S8 agent wrapper: the only sudo the VS login gets for the runners
put 0755 /usr/local/sbin/forge-runner-ctl <<'CTL'
#!/bin/bash
# forge-runner-ctl VERB [SLOT]: the only sudo the VS login has for the forge runners (PLAN_CI_RUNNERS sec 7).
# Fixed verbs, slot allow-list, no free-form arguments: it cannot read the PAT or run other code as ghrunner.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
cd /
RU=ghrunner; U=$(id -u "$RU")
IMAGE=docker.io/myoung34/github-runner:ubuntu-noble
NET=pasta:-4,--no-map-gw       # keep in sync with forge-runner-slot
as_ru() { runuser -u "$RU" -- env -i HOME=/srv/ghrunner USER="$RU" LOGNAME="$RU" PATH=/usr/bin:/bin \
  XDG_RUNTIME_DIR="/run/user/$U" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$U/bus" \
  TMPDIR=/srv/ghrunner/tmp "$@"; }
slot() { [[ ${1:-} =~ ^f[1-6]$ ]] || { echo "slot must be f1..f6" >&2; exit 64; }; }
targets() { # host loopback, every global host address (LAN, Meshnet, IPv6) on sshd/VS ports, LAN gateway
  printf '%s\n' 127.0.0.1:22 127.0.0.1:4180 '[::1]:22'
  ip -4 -o addr show scope global | awk '{sub(/\/.*/, "", $4); print $4 ":22"; print $4 ":4180"}'
  ip -6 -o addr show scope global | awk '{sub(/\/.*/, "", $4); print "[" $4 "]:22"}'
  ip -4 route show default | awk 'NR == 1 {print $3 ":80"}'
}
PROBE=$(cat <<'EOF'
fail=0
for t in "$@"; do
  h=${t%:*}; p=${t##*:}; h=${h#[}; h=${h%]}
  if timeout 4 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$h" "$p" 2>/dev/null; then echo "OPEN    $t"; fail=1
  else echo "blocked $t"; fi
done
if curl -fsS -m 15 -o /dev/null https://api.github.com/zen; then echo "ok      https://api.github.com"
else echo "FAIL    https://api.github.com"; fail=1; fi
exit $fail
EOF
)
SMOKE=$(cat <<'EOF'
echo "user=$(id -un) home=$HOME"
sudo -n true && echo "sudo: ok"
/actions-runner/bin/Runner.Listener --version
if test -w /actions-runner; then echo "runner dir: writable"; else echo "runner dir: NOT writable"; fi
if unshare -Ur true 2>/dev/null; then echo "nested userns: allowed (accepted residual, sec 7e)"
else echo "nested userns: blocked"; fi
EOF
)
ctr_run() { as_ru podman run --rm --pull=never --user runner --network="$NET" --memory=1g --pids-limit=256 \
  --entrypoint /bin/bash "$IMAGE" "$@"; }
rc=0
case ${1:-} in
  info) as_ru podman info --format 'rootless={{.Host.Security.Rootless}} cgroups={{.Host.CgroupsVersion}}/{{.Host.CgroupManager}} driver={{.Store.GraphDriverName}} graphroot={{.Store.GraphRoot}}' ;;
  pull) as_ru podman pull -q "$IMAGE" ;;
  smoke) ctr_run -c "$SMOKE" ;;
  probe)
    mapfile -t T < <(targets)
    echo "== host side, as $RU"; as_ru bash -c "$PROBE" probe "${T[@]}" || rc=1
    echo "== inside a job container"
    ctr_run -c "$PROBE" probe "${T[@]}" host.containers.internal:22 host.containers.internal:4180 169.254.1.2:22 || rc=1
    exit "$rc" ;;
  status) as_ru systemctl --user --no-pager --lines=0 status 'forge-runner@*' || true
          as_ru podman ps --format '{{.Names}}  {{.Status}}' ;;
  start|stop|restart) slot "${2:-}"; as_ru systemctl --user "$1" "forge-runner@$2.service" ;;
  enable|disable) slot "${2:-}"; as_ru systemctl --user "$1" --now "forge-runner@$2.service" ;;
  logs) slot "${2:-}"; journalctl --no-pager -q -n 100 _UID="$U" _SYSTEMD_USER_UNIT="forge-runner@$2.service" ;;
  envnames) slot "${2:-}"
    as_ru podman inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "forge-runner-$2" | sed 's/=.*//' ;;
  *) echo "usage: forge-runner-ctl info|pull|smoke|probe|status|start|stop|restart|enable|disable|logs|envnames [f1..f6]" >&2
     exit 64 ;;
esac
CTL

# S9 owner-only PAT tool (NOT in the VS sudoers rule)
put 0700 /usr/local/sbin/forge-runner-set-token <<'TOK'
#!/bin/bash
# forge-runner-set-token: OWNER ONLY. Store or rotate the org PAT for the forge runners (PLAN_CI_RUNNERS sec 7c).
set -euo pipefail
umask 077
cd /
IFS= read -rsp 'Paste the fine-grained PAT (input hidden): ' p </dev/tty; echo
[[ $p =~ ^github_pat_[A-Za-z0-9_]{20,}$ ]] || { echo "refused: not a fine-grained PAT (github_pat_...)" >&2; exit 1; }
# ghrunner owns that directory, so ghrunner does the write (root writing there would follow planted symlinks).
# printf is a builtin: the PAT goes to stdin, never argv.
printf '%s' "$p" | runuser -u ghrunner -- /bin/sh -c 'umask 077; d=/srv/ghrunner/.config/forge-runner
  cat > "$d/token.new" && mv -f "$d/token.new" "$d/token" && stat -c "saved %n (%U, mode %a, %s bytes)" "$d/token"'
p=
TOK

# S10 the one sudo rule for the VS login; the old O4 '(ghrunner) ALL' grant must not exist
t=$(mktemp /etc/sudoers.d/forge-runner.XXXXXX)   # name has a dot: sudo ignores it until renamed
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/forge-runner-ctl\n' "$VS_USER" > "$t"; chmod 0440 "$t"
if visudo -cqf "$t"; then mv -f "$t" /etc/sudoers.d/forge-runner; else rm -f "$t"; exit 1; fi
rm -f /etc/sudoers.d/ghrunner
visudo -cq

# S11 activate: load the table now (atomic, no runner restart), then the boot unit and linger
systemctl daemon-reload
nft -f /etc/nftables.d/ghrunner.nft
systemctl enable ghrunner-egress.service
systemctl start ghrunner-egress.service
loginctl enable-linger "$RU"
for _ in $(seq 30); do [[ -S /run/user/$U/bus ]] && break; sleep 1; done

echo "--- self-check"
stat -c '%n %a %U' "$IMG" "$H" /usr/local/libexec/forge-runner-slot /usr/local/sbin/forge-runner-ctl /etc/sudoers.d/forge-runner
nft list table inet ghrunner_egress >/dev/null && echo "nft table inet ghrunner_egress: loaded"
systemctl is-active ghrunner-egress.service "user@$U.service"
systemctl show "user-$U.slice" -p CPUQuotaPerSecUSec -p MemoryHigh -p MemoryMax -p MemorySwapMax -p TasksMax
echo "OK. Next: agents run A1-A4; O7 (sudo forge-runner-set-token) once the PAT exists."
SETUP
sudo bash /root/forge-runner-setup.sh
```
Expected tail: `/var/lib/ghrunner.img 600 root`, `/srv/ghrunner 700 ghrunner`, `nft table inet ghrunner_egress: loaded`, `active` twice, `MemoryMax=27917287424`, `OK. Next: ...`.
If `nft -c` fails, nothing is loaded yet and the script stops: send the error to forge-host. Owner precondition: the VS login needs a password for any other sudo (`sudo -k; sudo -n true` must fail), otherwise no agent boundary here holds.

### 7b. Agent steps before the PAT (VS login; this is the full sudo scope)
- A1 `sudo -n /usr/local/sbin/forge-runner-ctl info` -> `rootless=true cgroups=v2/systemd driver=overlay graphroot=/srv/ghrunner/.local/share/containers/storage`.
- A2 `sudo -n /usr/local/sbin/forge-runner-ctl pull` (3.3 GB into `/srv/ghrunner`).
- A3 `sudo -n /usr/local/sbin/forge-runner-ctl smoke` -> `user=runner home=/home/runner`, `sudo: ok`, `2.338.2` (JIT needs >= 2.304), `runner dir: writable`, and a `nested userns:` line (record it; see 7e).
  If podman rejects the pasta options, report it; the owner fallback is `sudo sed -i 's/^NET=.*/NET=pasta/' /usr/local/libexec/forge-runner-slot /usr/local/sbin/forge-runner-ctl` (nft still enforces everything).
- A4 `sudo -n /usr/local/sbin/forge-runner-ctl probe` -> every target line `blocked`, `ok https://api.github.com` in both sections, exit 0. Control (shows the probe is real): as the VS login `timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/22' && echo reachable` prints `reachable`.
  Host networking intact (VS login, table loaded): `time timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/9'` fails at once with `Connection refused` (not a 3 s timeout); `ping -c1 -w3 127.0.0.1` and `ping -6 -c1 -w3 2606:4700:4700::1111` reply; `ip -6 neigh show` lists the router `REACHABLE`/`STALE` (not `FAILED`); Meshnet peers still connect (VS UI over Meshnet loads). Any failure: `sudo nft delete table inet ghrunner_egress` (runners then refuse to start) and report.
  Plus: `stat -c '%a %U' /var/lib/ghrunner.img` -> `600 root`; `ls /srv/ghrunner` -> Permission denied; `sudo -n -u ghrunner true` -> fails (a password is required).

### 7c. Owner O7: the PAT (the only step that needs it)
1. Org Settings -> Personal access tokens: fine-grained tokens allowed (approve the request if the org requires approval).
2. Your Settings -> Developer settings -> Fine-grained tokens -> Generate: resource owner **IdleMinds-Dev**, repository access "Public repositories" (no repo permissions), Organization permissions -> **Self-hosted runners: Read and write**, nothing else, expiry 90 days. Set a reminder 7 days before expiry; rotate by re-running step 3.
3. On the forge: `sudo /usr/local/sbin/forge-runner-set-token` (hidden prompt, root process; the write to `/srv/ghrunner/.config/forge-runner/token` ghrunner 0600 runs as ghrunner via `runuser`; refuses anything not `github_pat_...`). Then tell forge-host "PAT in".

### 7d. Agent steps after the PAT
- A5 `sudo -n /usr/local/sbin/forge-runner-ctl enable f1`, then `... status` (active, one `forge-runner-f1` container) and `... logs f1` (`waiting for one job`, then the runner's `Listening for Jobs`).
  While it runs: `grep -a -l -e 'jitconfi[g]' -e 'Beare[r]' /proc/[0-9]*/cmdline 2>/dev/null` prints nothing; `... envnames f1` lists `ACTIONS_RUNNER_INPUT_JITCONFIG` and `RUNNER_MANUALLY_TRAP_SIG`, no `ACCESS_TOKEN`/`RUNNER_TOKEN`.
- A6 When an EFI job runs on f1 (done-check 2), `sudo -n /usr/local/sbin/forge-runner-ctl enable f2`.
- A6b After >= 3 h with VS healthy (load, `systemd-cgtop -1 user.slice`, VS suite time normal, `MemoryPeak` < `MemoryHigh`), enable f3, then f4 the same way (`enable f3`, `enable f4`).
- A6c After another >= 3 h healthy at 4 slots (same checks), enable f5, then f6 the same way. Any regression: disable back to the last healthy count.
- A7 24 h watch: `systemd-cgtop -1 user.slice`, `systemctl show user-$(id -u ghrunner).slice -p MemoryPeak -p MemoryHigh`, VS suite times in their normal range.

### Done-check
1. P0 re-review PASS (0 critical / 0 major open) on the committed plan.
2. `gh api repos/IdleMinds-Dev/<efi-repo>/actions/runs/<id>/jobs --jq '.jobs[]|[.name,.runner_name,.conclusion]|@tsv'`: a job on `forge-priority-f1-*` (later `-f2-*`..`-f6-*`), conclusion `success`.
3. Egress from inside a job container and on the host side as ghrunner: A4 `probe` all `blocked` (loopback, LAN, Meshnet, host global IPv6, gateway, `host.containers.internal`, 169.254.1.2) and GitHub `ok`.
4. Secrets: image `600 root`; no `jitconfig`/`Bearer` in any `/proc/*/cmdline`; `envnames` shows no PAT or registration token; the VS login has no `sudo -u ghrunner`.
5. Fail closed: `user@<uid>.service` shows `Requires=ghrunner-egress.service` (`systemctl show user@$(id -u ghrunner).service -p Requires`); the slot log never shows `egress block missing`.
6. 24 h: `MemoryPeak` < `MemoryMax`, no OOM kills in `logs`, VS suite time within normal range. EFI lane told via inbox that it now has VM 4 + forge 2..6 priority slots.

### 7e. Residual risks and unverified
- Accepted: host-kernel escape from a rootless container. Container uid 0 maps to ghrunner's **real** uid (rootless podman) and the image gives `runner` passwordless sudo, so a job is ghrunner-equivalent inside its userns and an escape gets ghrunner, so the PAT. It does not reach root through these files: root never writes inside ghrunner's home (S3 and S9 do those writes as ghrunner via `runuser`); ghrunner -> root needs a separate LPE. Org members only, private repos. If A3 shows `nested userns: allowed`, that widens the kernel surface; accepted for Phase 1 (a custom seccomp denying `CLONE_NEWUSER` is the follow-up if wanted).
- The owner types the sudo password and pastes the PAT on a pts/tty owned by the VS uid (mode 0600 to that uid), so a VS agent process could open the device and race-read the input. Pre-existing for any sudo on this login; accepted for Phase 1. To avoid it, run O7 from a login that is not the VS uid.
- The job can read its own JIT config from `/proc/1/environ` inside the container; it is single-use for that runner, which the job already runs on.
- The VS login is in `adm` (reads all journals): the scripts never log secrets, so this exposes nothing. It is also in `lxd`; LXD is not installed. If LXD is ever installed, that group is root and every boundary here falls.
- Optional (owner, GitHub UI): a runner group limited to `<efi-repo>`, then set `GROUP_ID` in the slot script; today group 1 lets any org repo target `homelab-priority`.
- Unverified (no root, no podman here): `nft -c` syntax (S4 checks it before loading), `fib daddr type` and `reject with icmpx` in an `inet` output chain on nft 1.1.6; pasta accepting `-4,--no-map-gw` from podman 5.7 (A3); `IO*BandwidthMax` on a loop image over LVM taking effect; `podman info --format` field names (A1). `runuser` + `XDG_RUNTIME_DIR` replaces `systemctl --user -M` because `systemd-machined` is absent (verified).

### Rollback
Agents: `sudo -n /usr/local/sbin/forge-runner-ctl disable f1`, `... disable f2`, `... disable f3`, `... disable f4`, `... disable f5` and `... disable f6` (or `for s in f1 f2 f3 f4 f5 f6; do sudo -n /usr/local/sbin/forge-runner-ctl disable $s; done`); delete any offline `forge-priority-*` runner in org settings. Owner, full removal: `sudo loginctl disable-linger ghrunner`, `sudo systemctl disable --now ghrunner-egress.service`, `sudo nft delete table inet ghrunner_egress`, `sudo rm /etc/sudoers.d/forge-runner`, revoke the PAT.

| Block | Touches | Clashes with | Kind |
|---|---|---|---|
| P0 Security re-review of §7 (Review - Gemini security focus + Claude second read): FAILs rn-54514084d60c (4/4/3) and rn-a479061cbc59 (0/7/7) on f7b59278 -> this revision; re-review | this file only | none | Gate |
| P1 Owner block S (7a), safe before the PAT | forge /etc, `/var/lib/ghrunner.img`, new user | none (own slice, own nft table) | Root cause |
| P2 A1-A4 via `forge-runner-ctl` | `/srv/ghrunner` | none | Root cause |
| P3 Owner O7 (7c) | token file | none | Root cause |
| P4 A5-A6: `@f1`, verify an EFI job, then `@f2`; A6b (>= 3 h, VS healthy) `@f3`, `@f4`; A6c (another >= 3 h healthy) `@f5`, `@f6` | ghrunner user units | EFI CI queue (benign: capacity) | Root cause |
| P5 A7 24 h watch + EFI inbox card (EFI AGENTS.md:73-75 says two slots) | none / EFI inbox | none | Root cause |

### Out of scope
Moving or retiring the VM pool, `homelab` general slots on the forge, any workflow/repo/org-setting change (EFI `vars.EFI_CI_RUNNER` stays), Windows runners.
