# Probe the old server as a new CI runner host (admin task)

Asked by Aub on 2026-11-12 (via EFI Overlord Rif2 → VibeSquad Hub9). Run this in a Claude Code (or plain shell) session **on the old server itself**. If it has no Claude, open an SSH session from DEVPC and paste the commands in.

## Why
EFI's Linux GitHub Actions runners live in the `gh-runner` Hyper-V VM on DEVPC (12 GB RAM, 8 vCPU of an i9-13900H, Ubuntu 24.04). The plan is to move them onto this server, so DEVPC only does dev work (agents + local Godot). The server will be upgraded to 32 GB RAM, and its CPU stays as it is, so **the CPU decides go/no-go**. Target layout: 2 priority runners at 4-8 GB, 2 general runners at 2 GB, with headroom. This task only measures. Nothing gets registered or moved.

## Scope (do only this)
- Read-only checks, plus installing `sysbench` (and Docker only if Aub says yes).
- Add DEVPC's SSH public key so VibeSquad workers can reach this box.
- Do NOT register GitHub runners, change the network config, touch the `gh-runner` VM, or reboot without asking Aub.

## Steps
1. **Specs.** Paste the output of:
   ```bash
   hostname; hostname -I; ip route | head -3
   cat /etc/os-release | head -2; uname -r
   lscpu | grep -E 'Model name|^CPU\(s\)|Thread|Core|Socket|MHz'
   free -m; swapon --show
   lsblk -d -o NAME,SIZE,ROTA,MODEL; df -h / /var
   docker --version 2>/dev/null || echo "no docker"
   ```
   Also note: bare metal or a VM? Is the IP static or a DHCP reservation? Is it wired or Wi-Fi? What's the maximum RAM the board supports (for the 32 GB upgrade)?

2. **CPU benchmark** (the same commands run on the VM in step 4, so the numbers compare):
   ```bash
   sudo apt-get install -y sysbench
   sysbench cpu --threads=1 --time=30 run | grep -E 'events per second'
   sysbench cpu --threads=$(nproc) --time=30 run | grep -E 'events per second'
   sysbench cpu --threads=4 --time=30 run | grep -E 'events per second'
   ```
   The 4-thread run roughly matches one priority runner's share, which is what a single suite gets.

3. **SSH access from DEVPC.** Append the contents of `C:\Users\Fugma\.ssh\gh-runner.pub` (on DEVPC) to `~/.ssh/authorized_keys` for the user the runners will run as. Then on DEVPC add a `Host old-server` entry to `~/.ssh/config` (HostName = this box's IP, User = that user, IdentityFile `~/.ssh/gh-runner`) and check `ssh -o BatchMode=yes old-server hostname`. Never paste private keys anywhere.

4. **VM baseline (from DEVPC, only while the VM is idle).** Check it's idle: `ssh gh-runner "docker top gh-runner-priority | grep -c Runner.Worker"` (0 = idle). Then:
   ```bash
   ssh gh-runner "sudo apt-get install -y sysbench >/dev/null; for t in 1 4 8; do sysbench cpu --threads=\$t --time=30 run | grep 'events per second'; done"
   ```

## Report back
Paste all the output to Aub or into the VibeSquad hub chat (Hub9). Hub9 then:
- works out the suite-time estimate (server ÷ VM, at 4 threads, applied to recent EFI priority CI job durations), and whether 2 suites at once fit inside `--timeout 3600`,
- has a worker do a real timing run if the estimate is close,
- posts specs + go/no-go to EFI (Rif2) and drafts the no-gap cut-over: new runners registered under new names with the same labels → both pools live → drain and stop the VM's runners → watch for 1 day → retire the VM. The cut-over waits for Aub's OK.
