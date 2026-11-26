# PLAN_SUDO_ALLOWLIST: narrow root allowlist for the forge VS login

Ask (owner, 11-25 ~11:58 PM ET, verbatim): "we should identify and apply permissions for common sense/genreally safe sudo things".
Goal: remove the sudo stalls agents really hit, while `sudo -n true` keeps failing for the VS login (precondition of
[PLAN_CI_RUNNERS.md §7](../forge-host/PLAN_CI_RUNNERS.md) Decided + 7a tail). Model: §7a S8/S10 `forge-runner-ctl`.

## Decided
- Installed 11-26 by the owner (rev 2); done-check PASS: `sudo -n true` rc=1, `sudo -l` NOPASSWD only forge-runner-ctl +
  vs-root-ctl, `disk-usage` rc=0 (40 lines), `apt-repair` rc=0 (unit collected), 5 refusals rc=64.
- Primitives checked: `vs --help` (no root/sudo verb; `vs restart` drives the VS **user** unit), `sudo -n -l` (11-26 05:00Z:
  `(ALL : ALL) ALL` with password, `(root) NOPASSWD: /usr/local/sbin/forge-runner-ctl`), `/etc/sudoers.d/forge-runner`
  (root 0440), `/usr/local/sbin/forge-runner-ctl` (root 0755), `~/.config/systemd/user/vibesquad.service.d/*` (VS-owned).
- Host: sudo is **sudo-rs 0.2.13** (`visudo` = `/usr/lib/cargo/bin/visudo`, supports `-c -f`; §7a's sudoers install worked
  with it). VS login groups: `adm` (reads all journals incl. kernel), `sudo`, `lxd` (LXD not installed). `dmesg_restrict=1`.
  `apt-daily.timer` enabled (last 11-26 03:05Z), so package lists are fresh without sudo.
- One wrapper `/usr/local/sbin/vs-root-ctl`, two fixed verbs, **no arguments at all**, one sudoers.d line; exact copy of
  the forge-runner-ctl pattern. Runner verbs stay in forge-runner-ctl (its domain); none are duplicated here.
- **No `apt-install` verb** (rev 2, review rn-9a9008f83617 M1/M3): all 22 requested packages are already installed, adding a
  new name to an allow file costs the owner the same sudo line as installing it, and apt-get falls back to regex matching
  for names with `.`/`+` that are not exact package names. Package installs stay owner-only (one `sudo apt-get install` line).
- `apt-repair` runs dpkg in a fixed transient unit `vs-root-apt` (systemd-run `--wait`, **no `--pipe`**, output to the
  journal): one at a time, and a killed agent shell cannot SIGPIPE or orphan dpkg (the 11-23 incident).

## 1. Inventory (docs/ + `~/.vibesquad/logs` + inbox, grep -i sudo)
| # | Command | Who / when (ET) | Freq | Touched |
|---|---|---|---|---|
| I1 | `sudo apt install python3-lupa` (+pip/venv) | core, survival, redfrontier, ui, Hub needs-you, 11-23 10:13 AM .. 11-24 | 6+ asks, 1 need | system packages |
| I2 | `sudo apt install -y <17 pkgs>` ENV_GAPS.md:12 | forge-host, owner ran 11-23 4:48 PM | 1 | system packages |
| I3 | `sudo apt-get install -y podman uidmap passt jq` | forge-host needs-you 11-25 5:09 PM (then in §7a) | 1 | system packages |
| I4 | dpkg lock held by dead pty after `sudo apt install` | owner terminal crash 11-23 ~4:47 PM (inbox) | 1 | dpkg state |
| I5 | `sudo lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv` | Hub needs-you 11-24 12:34 PM; done (/ 936G) | 1 | LVM, fs |
| I6 | disk 97%: find what fills `/` | Hub needs-you 11-24 (du on root-owned dirs) | 2 | read-only |
| I7 | §7a setup, `forge-runner-set-token` | forge-host 11-25; owner ran 7a 11-25 ~11:57 PM | 1 | /etc, users, PAT |
| I8 | `sudo nft delete table inet ghrunner_egress` (§7b A4 on failure) | forge-host plan, agent step | rare | nft |
| I9 | Docker on forge (sudo) | forge-host early plan; superseded by rootless podman | 0 | - |
| I10 | `xvfb-run`, `lsof` "sudo apt" | EFI runner card, LINUX_AUDIT #3 | covered by I2 / installed | packages |
| I11 | playwright `install-deps`; `sudo apt-get install sysbench` | another project's host; gh-runner VM (RUNNER_HOST_PROBE.md:27) | other hosts | - |
| I12 | restart/drop-ins for `vibesquad.service`; journals | RUNBOOK.md:43-44, PLAN_GODOT_LOCAL G2 | daily | user unit |
| I13 | sudo password in a file for agents | owner 11-25, deleted | 0 | all of root |

## 2. Classification
| Item | Class | Reason |
|---|---|---|
| I12 restart, drop-ins, `journalctl --user` | NO SUDO NEEDED | user unit `systemctl --user` / `vs restart`; drop-ins are VS-owned files |
| system/kernel journal, OOM, `dmesg` | NO SUDO NEEDED | `adm` group reads all journals: `journalctl -k`, `journalctl -u <unit>`; not `dmesg` (restricted) |
| `systemctl status <any unit>` | NO SUDO NEEDED | read-only for any user |
| `apt-get update` | NO SUDO NEEDED | `apt-daily.timer` refreshes lists daily; `apt-cache policy` reads them |
| Godot / pip / node tools | NO SUDO NEEDED | user-local (~/.local), per PLAN_GODOT_LOCAL |
| I4 interrupted dpkg | SAFE `apt-repair` | fixed `dpkg --configure -a`: finishes already-chosen packages only |
| I6 disk hunt | SAFE `disk-usage` | read-only `du`, fixed path/depth, prints sizes + dir names only |
| I1-I3, I10 any package install (incl. from an allow file) | NO | all already installed; allow-file edits need owner sudo anyway; apt regex fallback on `.`/`+` names |
| I5 lvextend | NO | one-off, storage layout, done |
| I7 setup / PAT tool | NO | owner-only by design (§7 Decided) |
| I8 nft table delete | NO here | belongs in forge-runner-ctl as `egress-off` that stops slots first (follow-up F1) |
| I9 docker / podman as root | NO | root-equivalent |
| `sudo -u ghrunner`, shells, editors, tee/cp/chmod, systemctl on arbitrary units | NO | free-form code or files as root |
| I11 | NO here | other hosts, out of scope |
| I13 password file / `NOPASSWD: ALL` | NO | agents become root; breaks §7 |

Counts: 2 SAFE verbs, 5 NO-SUDO-NEEDED, 9 rejected (package install folded into one NO row).

## 3. Owner paste block (forge, VS login; idempotent)
Run `sudo -v` alone first, then paste. Re-running replaces the wrapper and sudoers line atomically.
```bash
sudo install -m 0700 -o root -g root /dev/null /root/vs-root-setup.sh
sudo tee /root/vs-root-setup.sh >/dev/null <<'SETUP'
#!/bin/bash
# PLAN_SUDO_ALLOWLIST: vs-root-ctl + one sudoers line. Idempotent.
set -euo pipefail
VS_USER=${SUDO_USER:?run as: sudo bash /root/vs-root-setup.sh  from the VS login}
id "$VS_USER" >/dev/null; cd /
put() { local t; t=$(mktemp "$2.XXXXXX"); cat > "$t"; chown root:root "$t"; chmod "$1" "$t"; mv -f "$t" "$2"; }
put 0755 /usr/local/sbin/vs-root-ctl <<'CTL'
#!/bin/bash
# vs-root-ctl VERB: general sudo for the VS login (PLAN_SUDO_ALLOWLIST). Two fixed verbs, no arguments.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C HOME=/root
cd /
usage() { echo "usage: vs-root-ctl apt-repair | disk-usage" >&2; exit 64; }
[[ $# -eq 1 ]] || usage
case $1 in
  apt-repair)   # dpkg in its own unit: a killed caller cannot interrupt it; fixed name = one at a time
    t0=$(date +%s); rc=0
    systemd-run --quiet --wait --collect --unit=vs-root-apt --service-type=exec -p RuntimeMaxSec=30min \
      -p StandardInput=null -p StandardOutput=journal -p StandardError=journal \
      -E DEBIAN_FRONTEND=noninteractive -E NEEDRESTART_SUSPEND=1 -E APT_LISTCHANGES_FRONTEND=none \
      /usr/bin/dpkg --force-confdef --force-confold --configure -a || rc=$?
    journalctl -q --no-pager -o cat -u vs-root-apt --since "@$t0" || true
    exit "$rc" ;;
  disk-usage) (timeout 60 du -P -x -d 3 -h / 2>/dev/null || true) | sort -h | tail -40 ;;
  *) usage ;;
esac
CTL
t=$(mktemp /etc/sudoers.d/vs-root.XXXXXX)   # dotted name: sudo ignores it until renamed
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/vs-root-ctl\n' "$VS_USER" > "$t"; chmod 0440 "$t"
if visudo -cf "$t"; then mv -f "$t" /etc/sudoers.d/vs-root; else rm -f "$t"; exit 1; fi
visudo -c
stat -c '%n %a %U' /usr/local/sbin/vs-root-ctl /etc/sudoers.d/vs-root
echo "OK. Next: agents run the PLAN_SUDO_ALLOWLIST done-check."
SETUP
sudo bash /root/vs-root-setup.sh
```
Expected tail: `/usr/local/sbin/vs-root-ctl 755 root`, `/etc/sudoers.d/vs-root 440 root`, `OK. ...`.
Package needs stay an owner line: agents put `sudo apt-get install -y <names>` in a needs-you (run it outside the VS side
terminal, which crashed mid-apt on 11-23); if dpkg is left half-configured, agents run `apt-repair`.

## 4. Done-check (agent, VS login)
1. `sudo -k; sudo -n true; echo rc=$?` -> password-required error, `rc=1` (boundary intact).
2. `sudo -n -l` -> `(ALL : ALL) ALL` (password), `(root) NOPASSWD: /usr/local/sbin/forge-runner-ctl`, `(root) NOPASSWD: /usr/local/sbin/vs-root-ctl`; nothing else.
3. `sudo -n /usr/local/sbin/vs-root-ctl disk-usage; echo rc=$?` -> <= 40 lines, last ends in `/`, `rc=0`.
4. `sudo -n /usr/local/sbin/vs-root-ctl apt-repair; echo rc=$?` -> `rc=0`, no output (nothing pending); then
   `systemctl status vs-root-apt` -> `could not be found` (collected).
5. Refusals, each exit 64 with usage: `... vs-root-ctl`, `... vs-root-ctl bash`, `... vs-root-ctl disk-usage /etc`,
   `... vs-root-ctl apt-repair -a`, `... vs-root-ctl apt-install lsof`.

## 5. Rollback
Owner: `sudo rm -f /etc/sudoers.d/vs-root` (all access gone at once), then optionally
`sudo rm -f /usr/local/sbin/vs-root-ctl /root/vs-root-setup.sh`. Nothing else is changed.

## 6. Residual risks and unverified
- `apt-repair` runs maintainer scripts of packages the owner already chose to install; it cannot pick packages.
  needrestart is suspended for the run (no automatic daemon restarts).
- `disk-usage` shows directory names (not contents) under root-only dirs such as `/root`; `-x` skips `/srv/ghrunner` (own mount).
- The owner's `sudo -v` / password still goes over a VS-uid pty (PLAN_CI_RUNNERS 7e); unchanged by this plan.
- `lxd` group membership is root-equivalent if LXD is ever installed (F2).
- Unverified (no root here): `systemd-run --wait` returns the dpkg exit code and the unit keeps running if the caller is
  killed (intended; without `--pipe` the unit holds no caller fd); sudo-rs passing `SUDO_USER` (worked for §7a).

## 7. Follow-ups (queue, not in this block)
- F1 @forge-host: forge-runner-ctl `egress-off` (disable f1..f6, then delete the table) + `egress-reload`
  (`systemctl restart ghrunner-egress.service`); §7b A4 currently tells agents to run `sudo nft delete table`, which they cannot.
- F2 owner (needs-you, lean yes): `sudo gpasswd -d <vs-user> lxd`; LXD is not installed, so nothing uses it. Applies to new
  sessions; the VS user unit picks it up at the next `vs restart`.

| Block | Touches | Clashes with | Kind |
|---|---|---|---|
| P0 Security re-review (Gemini delta) of rev 2 | this file | none | Gate |
| P1 Owner paste §3 | /usr/local/sbin/vs-root-ctl, /etc/sudoers.d/vs-root | forge-runner sudoers (none: separate file) | Root cause |
| P2 Agent done-check §4 | none | none | Root cause |
