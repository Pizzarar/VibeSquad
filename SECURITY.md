# Security Policy

## Threat Model

VibeSquad is a **local-first** tool. Its default attack surface is minimal:

- **Loopback only by default.** The web server binds to `127.0.0.1:4180`. No network traffic is accepted from other machines unless you explicitly enable LAN or meshnet access.
- **What is trusted on loopback:** only callers that hold the per-install **local token**. The server creates `~/.vibesquad/local-token` (32 random bytes, hex) at startup, mode 0600, with `~/.vibesquad` ACL'd to the current Windows user. Owner access needs either the `x-vibesquad-token` header (the `vs` CLI, Paseo plugins, the desktop proxy) or the `vs_local` session cookie (HttpOnly, SameSite=Strict, no Max-Age) that the launcher-only bootstrap `GET /__vibesquad/local-login?t=<nonce>` sets. `t` is a single-use 128-bit nonce that expires after ~60 s and is held in server memory. While it sits on the browser's command line, anyone who reads it and redeems it first within those ~60 s gets the session (first redeemer wins). After that it's worthless. The master token is never accepted there, so it never appears on a browser command line or in history. The server's `--open` launcher mints the nonce in-process. `vs open` (and a second `--open` while the server runs) gets one from `POST /__vibesquad/local-login/nonce`, which needs the header token.
- **Loopback without the token is read-only:** GET/HEAD pass the usual Host/Origin/Fetch-Metadata checks. Every other method gets 403 `{readOnly: true}`, and so do a few GETs with side effects or secrets (Paseo pairing offer, Paseo config surface, local-image file contents, VAPID key creation, provider diagnostics/models, forced usage refresh). The loopback `/ws` upgrade to the daemon also needs the token or cookie. The web UI shows a one-line read-only banner in that state.
- **Desktop app:** its loopback proxy (default port 4189) requires a per-launch `vs_desktop` cookie that the app sets in its own window at startup (`/__desktop/boot`). It forwards the local token only to a local server (an exact `localhost`/`127.0.0.1`/`[::1]` host), and it never forwards `vs_desktop`/`vs_local` upstream. In `--headless-proxy` test mode the key check is off, so the proxy attaches no local token either.
- **UNC paths:** client-supplied paths (`local-image`, `workspace-package-scripts`, `attach`) that start with `\\` or `//` are refused before any filesystem call, so a request can't make Windows contact another host and send NTLM credentials. The allowlist is checked on the resolved path before `stat`/`realpath`, then again on the real path.
- The Paseo daemon and Claude Code agents run on the same host and communicate over loopback.
- **What requires explicit opt-in (LAN/meshnet access):** set `VIBESQUAD_LAN_IP` and/or `VIBESQUAD_MESHNET_HOST`. When enabled, the server generates a local root CA with strict X.509 `nameConstraints` (only the configured hosts and private IP ranges), and all remote access requires a device token obtained by scanning a QR code from the local UI (single-use, 5-minute TTL).
- **Token pairing:** each device receives a per-device cookie (`vs_device`) after completing the pairing flow. The cookie is bound to the device's CA fingerprint.
- **Web Push:** push notifications are sent to endpoints the user subscribed to from their own browser. No message content other than agent status events is sent.
- **No outbound telemetry.** VibeSquad makes no calls to external analytics or telemetry services.

## Known Scope Limits

- **Multi-user PCs:** the local token stops other Windows users and other local apps from changing VibeSquad, but they can still **read** through the loopback API (teams, logs, settings, inbox). Anyone who can read your `~/.vibesquad` (an administrator, or malware running as you) has full access. Browsers send cookies to every port on `127.0.0.1`/`localhost`, so a hostile server another user runs on a loopback port could capture your `vs_local` cookie if you browse to it. Delete `~/.vibesquad/local-token` and restart the server to rotate it.
- Rotating the token needs a server restart, and clients re-read the file on their next request.

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
