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
TMP_DIR="${HOME}/.cache/vibesquad-tmp"
RUNTIME_DIR=""
UNIT_NAME="vibesquad"
NODE_MAJOR=24
START_UNIT=0

usage() {
  cat <<USAGE
Usage: scripts/forge-bootstrap.sh [options]
  --repo DIR           VibeSquad checkout the unit runs from (default: \$HOME/projects/VibeSquad)
  --runtime-dir DIR    synced runtime copy the unit serves (default: \$VIBESQUAD_RUNTIME_DIR, else \$HOME/.vibesquad/runtime; falls back to --repo until it has server/serve.mjs)
  --port N             server port (default 4180)
  --meshnet-ip IP      NordVPN Meshnet IPv4 (default: the nordlynx interface, else this device's IP from 'nordvpn meshnet peer list')
  --meshnet-host NAME  Meshnet hostname as shown by the peer list (default: detected via 'nordvpn meshnet peer list')
  --no-lan             do not set VIBESQUAD_LAN=1 (loopback only)
  --tmpdir DIR         TMPDIR for the unit, on the real disk (default: \$HOME/.cache/vibesquad-tmp; must NOT be under ~/.vibesquad, see RUNBOOK)
  --node-major N       NodeSource LTS major to install when node is missing/old (default 24, matches the dev PC)
  --start              enable --now the unit after writing it
  --dry-run            print actions, change nothing
  -h, --help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_DIR="$2"; shift 2 ;;
    --runtime-dir) RUNTIME_DIR="$2"; shift 2 ;;
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

# 1b. deps + build: dist/ must exist or phone pairing shows "dist/index.html missing"
if [ "$DRY_RUN" != 1 ] && [ ! -f "$REPO_DIR/package.json" ]; then
  log "WARNING: $REPO_DIR has no package.json; skipping npm ci / npm run build (clone VibeSquad there first)."
else
  run npm --prefix "$REPO_DIR" ci
  run npm --prefix "$REPO_DIR" run build
fi

# 2. Meshnet facts (flags win; otherwise detect). Tailscale is not used: it claims 100.64/10, which clashes with Meshnet.
# Meshnet must be enabled and logged in at boot (warn only; the owner sets it up with the nordvpn CLI)
if command -v nordvpn >/dev/null 2>&1; then
  if ! nordvpn settings 2>/dev/null | grep -qiE '^[[:space:]]*meshnet:[[:space:]]*enabled'; then
    log "WARNING: NordVPN Meshnet is not enabled; run: nordvpn set meshnet on (and nordvpn login)"
  fi
else
  log "WARNING: nordvpn CLI not found; install NordVPN, log in and enable Meshnet."
fi
# 'nordvpn meshnet peer list' prints a "This device:" block (Nickname / Hostname / IP ...), then a blank line and
# peer sections ("Local Peers:", "External Peers:"). Read ONLY the This-device block: a peer's hostname must never be picked up.
# Labels match case-insensitively; $1 is an ERE of acceptable labels (the IP label is "IP:" or, on other CLI versions, "IP address:").
this_device_field() {
  nordvpn meshnet peer list 2>/dev/null | awk -v keys="$1" '
    BEGIN {keys = tolower(keys)}
    tolower($0) ~ /^[[:space:]]*this device:[[:space:]]*$/ {indev=1; next}
    indev && (/^[[:space:]]*$/ || tolower($0) ~ /^[[:space:]]*(local|external)[[:space:]]+peers?:/) {exit}
    indev {
      line = $0; sub(/^[[:space:]]+/, "", line)
      i = index(line, ":"); if (i == 0) next
      label = tolower(substr(line, 1, i - 1)); gsub(/[[:space:]]+$/, "", label)
      if (label ~ ("^(" keys ")$")) {
        v = substr(line, i + 1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
        if (v != "") {print v; exit}
      }
    }'
}
THIS_IP=""
NORDLYNX_IP=""
if command -v nordvpn >/dev/null 2>&1; then
  THIS_IP="$(this_device_field "ip|ip address" || true)"
fi
if command -v ip >/dev/null 2>&1; then
  # same interface the server falls back to (server/auth.mjs detectMeshnetIp)
  NORDLYNX_IP="$(ip -4 -o addr show dev nordlynx 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)"
fi
if [ -z "$MESHNET_IP" ]; then
  if [ -n "$THIS_IP" ] && [ -n "$NORDLYNX_IP" ] && [ "$THIS_IP" != "$NORDLYNX_IP" ]; then
    log "WARNING: Meshnet IP from 'nordvpn meshnet peer list' (This device) differs from the nordlynx interface; using nordlynx."
  fi
  MESHNET_IP="${NORDLYNX_IP:-$THIS_IP}"
fi
if [ -z "$MESHNET_HOST" ] && command -v nordvpn >/dev/null 2>&1; then
  MESHNET_HOST="$(this_device_field "hostname" || true)"
  [ -n "$MESHNET_HOST" ] || log "WARNING: no 'This device' Hostname in 'nordvpn meshnet peer list'; leaving the Meshnet host empty."
fi
if [ -z "$MESHNET_IP" ] || [ -z "$MESHNET_HOST" ]; then
  log "WARNING: Meshnet ip/host not detected (enable Meshnet and log in, then re-run, or pass --meshnet-ip/--meshnet-host)."
fi
log "meshnet ip='${MESHNET_IP}' host='${MESHNET_HOST}'"

# 3. TMPDIR on disk, excluded from systemd-tmpfiles cleanup (R15)
# NOT under ~/.vibesquad: server/test-guard.mjs treats every path under the real ~/.vibesquad as forbidden for tests, and the
# unit's TMPDIR is inherited by every agent (and its test runs).
case "$(realpath -m "$TMP_DIR")/" in
  "$(realpath -m "${HOME}/.vibesquad")"/*) die "--tmpdir $TMP_DIR is under ~/.vibesquad; pick a dir outside it (default \$HOME/.cache/vibesquad-tmp)." ;;
esac
run mkdir -p "$TMP_DIR"
# an older unit may still point TMPDIR at ~/.vibesquad/tmp: keep it excluded too so it survives until the unit is updated
write_file /etc/tmpfiles.d/vibesquad.conf "x ${TMP_DIR} - - - - -
x ${TMP_DIR}/* - - - - -
x ${HOME}/.vibesquad/tmp - - - - -
x ${HOME}/.vibesquad/tmp/* - - - - -" 1

# 4. sysctl inotify (R13)
write_file /etc/sysctl.d/90-vibesquad-inotify.conf "fs.inotify.max_user_watches=524288" 1
sudo_run sysctl --system >/dev/null

# 5. never sleep (R12)
sudo_run systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
# lid close must not suspend a laptop forge: logind ignores the lid switch
sudo_run mkdir -p /etc/systemd/logind.conf.d
write_file /etc/systemd/logind.conf.d/forge-lid.conf "[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore" 1
# reload logind config without restarting it (a restart can kill the desktop session); HUP is harmless when unchanged
sudo_run systemctl kill -s HUP systemd-logind

# 6. systemd user unit (R5, R6, R7, R15)
NODE_BIN="$(command -v node || echo /usr/bin/node)"
NODE_DIR="$(dirname "$NODE_BIN")"
NPM_PREFIX="$(npm config get prefix 2>/dev/null || echo "${HOME}/.npm-global")"
UNIT_PATH="${HOME}/.config/systemd/user/${UNIT_NAME}.service"
LAN_LINE="# VIBESQUAD_LAN not set (--no-lan): loopback only"
if [ "$LAN" = 1 ]; then LAN_LINE="Environment=VIBESQUAD_LAN=1"; fi
# WorkingDirectory: the synced runtime copy (what restart-runtime/sync-runtime populate), not the possibly dirty checkout.
# Before the first sync it does not exist: fall back to --repo (the unit's first start then serves the checkout).
[ -n "$RUNTIME_DIR" ] || RUNTIME_DIR="${VIBESQUAD_RUNTIME_DIR:-${VIBESQUAD_HOME:-${HOME}/.vibesquad}/runtime}"
WORK_DIR="$RUNTIME_DIR"
if [ ! -f "$RUNTIME_DIR/server/serve.mjs" ]; then
  WORK_DIR="$REPO_DIR"
  log "WARNING: $RUNTIME_DIR has no server/serve.mjs yet (first bootstrap); WorkingDirectory falls back to $REPO_DIR. After the first 'vs restart' (which syncs the runtime) re-run this script to switch the unit to the runtime copy."
fi
UNIT="[Unit]
Description=VibeSquad server and runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${WORK_DIR}
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

if [ "$START_UNIT" = 1 ]; then NEXT_START=""; else NEXT_START="systemctl --user enable --now vibesquad (or re-run with --start; the unit is written but NOT started without it); "; fi
log "done. Next: ${NEXT_START}confirm Meshnet is on, logged in at boot and allows incoming connections for the forge (nordvpn set meshnet on); provider logins; see docs/lanes/forge-host/RUNBOOK.md"
