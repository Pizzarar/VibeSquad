#!/usr/bin/env bash
# forge-bootstrap.sh: set up a Debian/Ubuntu box as the VibeSquad engine room (docs/lanes/forge-host/RUNBOOK.md).
# Idempotent: safe to re-run. System steps use sudo; the unit is a systemd *user* unit.
set -euo pipefail

DRY_RUN=0
REPO_DIR="${HOME}/projects/VibeSquad"
PORT=4180
LAN=1
MESHNET_IP=""
MESHNET_HOST=""
TMP_DIR="${HOME}/.vibesquad/tmp"
UNIT_NAME="vibesquad"
NODE_MAJOR=22
START_UNIT=0

usage() {
  cat <<USAGE
Usage: scripts/forge-bootstrap.sh [options]
  --repo DIR           VibeSquad checkout the unit runs from (default: \$HOME/projects/VibeSquad)
  --port N             server port (default 4180)
  --meshnet-ip IP      tailnet IPv4 (default: detected via 'tailscale ip -4')
  --meshnet-host NAME  MagicDNS name, e.g. forge.example.ts.net (default: detected via 'tailscale status --json')
  --no-lan             do not set VIBESQUAD_LAN=1 (loopback only)
  --tmpdir DIR         TMPDIR for the unit, on the real disk (default: \$HOME/.vibesquad/tmp)
  --node-major N       NodeSource LTS major to install when node is missing/old (default 22)
  --start              enable --now the unit after writing it
  --dry-run            print actions, change nothing
  -h, --help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --meshnet-ip) MESHNET_IP="$2"; shift 2 ;;
    --meshnet-host) MESHNET_HOST="$2"; shift 2 ;;
    --no-lan) LAN=0; shift ;;
    --tmpdir) TMP_DIR="$2"; shift 2 ;;
    --node-major) NODE_MAJOR="$2"; shift 2 ;;
    --start) START_UNIT=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

log() { echo "[forge-bootstrap] $*"; }
die() { echo "[forge-bootstrap] ERROR: $*" >&2; exit 1; }
run() { if [ "$DRY_RUN" = 1 ]; then echo "DRY-RUN: $*"; else "$@"; fi; }
sudo_run() {
  if [ "$DRY_RUN" = 1 ]; then echo "DRY-RUN: sudo $*"
  elif [ "$(id -u)" = 0 ]; then "$@"
  else sudo "$@"; fi
}
# write_file PATH CONTENT [use_sudo]: only rewrites when content differs
write_file() {
  local path="$1" content="$2" use_sudo="${3:-0}"
  if [ -f "$path" ] && [ "$(cat "$path")" = "$content" ]; then log "unchanged: $path"; return 0; fi
  if [ "$DRY_RUN" = 1 ]; then
    echo "DRY-RUN: write $path"
    printf '%s\n' "$content" | sed 's/^/    | /'
    return 0
  fi
  if [ "$use_sudo" = 1 ] && [ "$(id -u)" != 0 ]; then printf '%s\n' "$content" | sudo tee "$path" >/dev/null
  else printf '%s\n' "$content" > "$path"; fi
  log "wrote: $path"
}

[ "$(uname -s)" = Linux ] || die "Linux only (found $(uname -s))."
[ -r /etc/os-release ] || die "no /etc/os-release; Debian/Ubuntu with apt required."
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}:${ID_LIKE:-}" in
  debian:*|ubuntu:*|*:*debian*|*:*ubuntu*) ;;
  *) die "unsupported distro '${ID:-unknown}': this script assumes Debian/Ubuntu (apt)." ;;
esac
command -v apt-get >/dev/null 2>&1 || die "apt-get not found."
command -v systemctl >/dev/null 2>&1 || die "systemd (systemctl) not found."
if [ "$(id -u)" = 0 ] && [ "$DRY_RUN" != 1 ]; then die "run as the VS user, not root (the unit is a user unit; sudo is used for system steps)."; fi
if [ "$(id -u)" != 0 ] && ! command -v sudo >/dev/null 2>&1; then die "sudo not found."; fi

# 1. packages
CHROMIUM=chromium
if ! apt-cache show chromium >/dev/null 2>&1 && apt-cache show chromium-browser >/dev/null 2>&1; then
  CHROMIUM=chromium-browser
fi
PKGS=(git gh ripgrep openssl "$CHROMIUM" curl ca-certificates)
MISSING=()
for p in "${PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p"); done
if [ "${#MISSING[@]}" -gt 0 ]; then
  log "apt install: ${MISSING[*]}"
  sudo_run apt-get update
  sudo_run env DEBIAN_FRONTEND=noninteractive apt-get install -y "${MISSING[@]}"
else
  log "apt packages present"
fi

# node LTS (NodeSource) if missing or older than the requested major
node_ok=0
if command -v node >/dev/null 2>&1; then
  cur="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$cur" -ge "$NODE_MAJOR" ]; then node_ok=1; fi
fi
if [ "$node_ok" = 1 ]; then
  log "node $(node -v) ok"
elif [ "$DRY_RUN" = 1 ]; then
  echo "DRY-RUN: curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | sudo -E bash - && sudo apt-get install -y nodejs"
else
  log "installing node ${NODE_MAJOR}.x from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# 2. tailnet facts (flags win; otherwise detect)
# tailscaled must survive reboots (warn only; owner enables it)
if command -v systemctl >/dev/null 2>&1 && command -v tailscale >/dev/null 2>&1; then
  if [ "$(systemctl is-enabled tailscaled 2>/dev/null || true)" != "enabled" ]; then
    log "WARNING: tailscaled is not enabled at boot; run: sudo systemctl enable --now tailscaled"
  fi
fi
if [ -z "$MESHNET_IP" ] && command -v tailscale >/dev/null 2>&1; then
  MESHNET_IP="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
fi
if [ -z "$MESHNET_HOST" ] && command -v tailscale >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  MESHNET_HOST="$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(String(JSON.parse(s).Self.DNSName||"").replace(/\.$/,""))}catch{}})' || true)"
fi
if [ -z "$MESHNET_IP" ] || [ -z "$MESHNET_HOST" ]; then
  log "WARNING: tailnet ip/host not detected (run 'sudo tailscale up' then re-run, or pass --meshnet-ip/--meshnet-host)."
fi
log "meshnet ip='${MESHNET_IP}' host='${MESHNET_HOST}'"

# 3. TMPDIR on disk, excluded from systemd-tmpfiles cleanup (R15)
run mkdir -p "$TMP_DIR"
write_file /etc/tmpfiles.d/vibesquad.conf "x ${TMP_DIR} - - - - -
x ${TMP_DIR}/* - - - - -" 1

# 4. sysctl inotify (R13)
write_file /etc/sysctl.d/90-vibesquad-inotify.conf "fs.inotify.max_user_watches=524288" 1
sudo_run sysctl --system >/dev/null

# 5. never sleep (R12)
sudo_run systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

# 6. systemd user unit (R5, R6, R7, R15)
NODE_BIN="$(command -v node || echo /usr/bin/node)"
NODE_DIR="$(dirname "$NODE_BIN")"
NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo "${HOME}/.npm-global")"
UNIT_PATH="${HOME}/.config/systemd/user/${UNIT_NAME}.service"
LAN_LINE="# VIBESQUAD_LAN not set (--no-lan): loopback only"
if [ "$LAN" = 1 ]; then LAN_LINE="Environment=VIBESQUAD_LAN=1"; fi
UNIT="[Unit]
Description=VibeSquad server and runner
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
ExecStart=${NODE_BIN} server/serve.mjs
# VS starts detached restart scripts, runners and agents in this cgroup: do not kill them when the main process stops.
KillMode=process
Delegate=yes
Restart=on-failure
RestartSec=5
Environment=PATH=${HOME}/.local/bin:${NPM_PREFIX}/bin:${NODE_DIR}:/usr/local/bin:/usr/bin:/bin
Environment=TMPDIR=${TMP_DIR}
Environment=VIBESQUAD_PORT=${PORT}
Environment=VIBESQUAD_START_RUNNER=1
${LAN_LINE}
Environment=VIBESQUAD_MESHNET_IP=${MESHNET_IP}
Environment=VIBESQUAD_MESHNET_HOST=${MESHNET_HOST}

[Install]
WantedBy=default.target"
run mkdir -p "$(dirname "$UNIT_PATH")"
write_file "$UNIT_PATH" "$UNIT"

# 7. linger so the unit survives logout and starts at boot
sudo_run loginctl enable-linger "$(id -un)"
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY-RUN: systemctl --user daemon-reload"
else
  systemctl --user daemon-reload || log "WARNING: systemctl --user unavailable in this session (log in via ssh/console and re-run)."
fi
if [ "$START_UNIT" = 1 ]; then
  if [ "$DRY_RUN" != 1 ] && [ ! -d "$REPO_DIR" ]; then die "repo dir $REPO_DIR missing; clone VibeSquad and run 'npm ci' first."; fi
  run systemctl --user enable --now "${UNIT_NAME}.service"
fi

log "done. Next: sudo systemctl enable --now tailscaled; sudo tailscale up (and disable key expiry for this machine in the Tailscale admin console); provider logins; see docs/lanes/forge-host/RUNBOOK.md"
