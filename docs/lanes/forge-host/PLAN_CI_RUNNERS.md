# PLAN: move the homelab GitHub Actions runners from the dev pp VM to the forge (idea-737)

Status: **PARKED 2026-11-24** (owner: move runners later, not soon; tracked as idea-738). Inventory + plan only; the security review was cancelled before it finished, so re-review §2-§4 before starting. Nothing was registered, installed, removed or changed. Evidence was gathered 2026-11-24 ~02:00-02:30Z
(9:00-9:30 PM ET on 11-23) from `gh api` / `gh run list`, the local repo checkouts, and read-only listing over `ssh devpc` → `ssh gh-runner`.

## 1. Inventory

### 1a. Runners today (all in the `gh-runner` Hyper-V VM on the dev pp)
Repo-level runners: `gh api repos/IdleMinds-Dev/{Escape-From-Idle,SportsBallBattles,Pillbille,ForgeWirk}/actions/runners` → `total_count 0` each.
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
Rollback any time before O10: `systemctl --user -M ghrunner@ stop 'forge-runner@*'` and re-enable the VM units.
