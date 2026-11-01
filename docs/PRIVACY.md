# VibeSquad Privacy

VibeSquad is a local-first tool. All data stays on your machine unless you explicitly enable LAN/meshnet access or Web Push.

## What VibeSquad stores locally

All data is written under `~/.vibesquad/` (overridable via `VIBESQUAD_HOME`).

| Path | Contents |
|---|---|
| `~/.vibesquad/teams/<team>/log.jsonl` | Activity log entries: timestamps, agent IDs, role metadata, entry type (`done`, `decision`, `blocker`, etc.), and short text summaries. **No prompt or transcript content is logged.** |
| `~/.vibesquad/teams/<team>/inbox.json` | Parked idea cards (title, scope, lane, status). No chat history. |
| `~/.vibesquad/profiles.json` | Agent profile definitions (name, role, provider, model, notes). No secrets. |
| `~/.vibesquad/auth.json` | Paired device tokens (hashed). No passwords. |
| `~/.vibesquad/vapid.json` | Web Push VAPID key pair for this installation. |
| `~/.vibesquad/push-subs.json` | Push notification endpoint subscriptions. |
| `~/.vibesquad/tls/` | Local root CA certificate and server leaf certificate for LAN/meshnet HTTPS (if configured). The private key is in this directory and is locked down to your OS user only. |
| `~/.vibesquad/devices.json` | Paired device records (hashed tokens, device names). |
| `~/.vibesquad/backups/` | Automatic backups of `teams.json` and log files before `vs migrate identity` runs. |

## What is NOT logged

- Prompt or transcript content (Claude Code conversation text)
- Agent outputs or tool call results
- Personal files read or written by agents
- Any data uploaded to external servers

Metric entries (`type: "metric"`) contain only counts, role identifiers, and timing info — never prompt content.

## Network

VibeSquad makes **no outbound telemetry calls**. The only network activity is:

- **Paseo daemon**: connects to the local Paseo daemon over loopback (`127.0.0.1`) only. No traffic leaves the machine unless you have configured a remote Paseo host.
- **Web Push**: if you have enabled push notifications and paired a device, the server sends push messages to the push endpoint URL you subscribed from. No other data is sent.
- **LAN/meshnet HTTPS** (opt-in): if you configure `VIBESQUAD_LAN_IP` or `VIBESQUAD_MESHNET_HOST`, the server listens on those interfaces. Access is protected by a locally-generated root CA and per-device token pairing. This is disabled by default.

## Clearing local data

To remove all VibeSquad local data:

```sh
rm -rf ~/.vibesquad
```

This removes all logs, profiles, auth tokens, TLS certificates, and inbox cards. VibeSquad will re-seed default profiles on next start.
