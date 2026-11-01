# Security Policy

## Threat Model

VibeSquad is a **local-first** tool. Its default attack surface is minimal:

- **Loopback only by default.** The web server binds to `127.0.0.1:4180`. No network traffic is accepted from other machines unless you explicitly enable LAN or meshnet access.
- **What is trusted:** any process on `localhost` (same machine). The Paseo daemon and Claude Code agents run on the same host and communicate over loopback.
- **What requires explicit opt-in (LAN/meshnet access):** set `VIBESQUAD_LAN_IP` and/or `VIBESQUAD_MESHNET_HOST`. When enabled, the server generates a local root CA with strict X.509 `nameConstraints` (only the configured hosts and private IP ranges), and all remote access requires a device token obtained by scanning a QR code from the local UI (single-use, 5-minute TTL).
- **Token pairing:** each device receives a per-device cookie (`vs_device`) after completing the pairing flow. The cookie is bound to the device's CA fingerprint.
- **Web Push:** push notifications are sent to endpoints the user subscribed to from their own browser. No message content other than agent status events is sent.
- **No outbound telemetry.** VibeSquad makes no calls to external analytics or telemetry services.

## Known Scope Limits

- The Paseo daemon runs on localhost with its own access controls (see Paseo documentation).
- Agent prompts and transcripts are handled by the AI provider (Anthropic, Google) under their own terms. VibeSquad never sends transcript content to any server.
- `teams.json` contains project paths and team names. It is gitignored; keep it out of public repositories.

## Reporting a Vulnerability

Please report security vulnerabilities **privately** using [GitHub Security Advisories](https://github.com/your-org/vibesquad/security/advisories/new).

Do **not** open a public issue for security vulnerabilities. We will acknowledge reports within 5 business days and aim to release a fix within 90 days depending on severity.

When reporting, please include:
- A description of the vulnerability and its impact
- Steps to reproduce or a proof-of-concept
- The version or commit hash you tested against
- Whether you believe this is exploitable remotely or only locally
