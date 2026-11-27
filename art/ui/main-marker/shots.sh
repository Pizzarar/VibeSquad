#!/usr/bin/env bash
# Fills art/ui/main-marker/shoot.js with this worktree's strips as data URIs and the absolute shot
# dir; prints the path of the ready-to-run file (run it via Playwright MCP browser_run_code_unsafe).
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
u() { printf 'data:image/png;base64,%s' "$(base64 -w0 "$root/public/ui/main-marker-$1.png")"; }
uris="{dark:'$(u dark)',dark2x:'$(u dark@2x)',light:'$(u light)',light2x:'$(u light@2x)'}"
mkdir -p "$root/scratch/shots"
tmp=$(mktemp --suffix=.js)
sed -e "s|__URIS__|$uris|" -e "s|__OUT__|'$root/scratch/shots'|" -e "s|__BASE__|'${MM1_BASE:-http://127.0.0.1:4180}'|" "$root/art/ui/main-marker/shoot.js" > "$tmp"
echo "$tmp"
