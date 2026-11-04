# VibeSquad

Multi-agent coordination system for [Claude Code](https://claude.com/claude-code) powered by [Paseo](https://getpaseo.com).

VibeSquad organizes Claude Code agents into **Squads** (product-level teams) and **Feature Lanes** (parallel workstreams), each with a **Buddy** (brainstorm partner), a **Lead** (implementation coordinator), and **Workers** (task agents). A lightweight `vs` CLI records decisions, reads team logs, and generates handoff packets — with no prompt or transcript content ever written to disk.

> **New here?** Install the latest release, then open `guide/` and read START_HERE.
> The installer does not put `guide/` on your PC: on this page click **Code → Download ZIP**, unzip it somewhere you will find it again (or `git clone`), then follow [guide/README.md](guide/README.md). It hands you to your Buddy, who reads [START_HERE](guide/START_HERE.md) for you.

## Architecture

```
Squad (team)
  └── Feature Lane (lane)
        ├── Buddy  — role=brainstorm  — plans, explores, parks ideas
        ├── Lead   — role=lead        — dispatches workers, manages context, hands off
        └── Workers — role=worker     — one task each, report via digest
```

The **Paseo daemon** manages agent sessions. VibeSquad adds:

- `vs` CLI: team log, `vs who`, `vs whoami`, `vs handoff`, `vs inbox`, `vs profiles`
- Server plugin (`plugin/index.server.ts`): prompt layering, auto-labelling, digest routing, lead handoff
- Web UI (`src/`): roster view, team settings, idea inbox, profile management, pair-device QR modal
- Push server (`server/push.mjs`): Web Push notifications for agent attention events

## Install (Windows, one-stop installer)

Run `VibeSquad-setup.exe`. It bundles everything VibeSquad itself needs: a pinned Node.js LTS (`node.exe` plus npm), the built web app, the server, the `vs` CLI and its production dependencies. No system-wide Node is required, and `vs` works from any terminal afterwards.

- **Paseo:** if you already have Paseo installed (or a daemon is already listening on its port), VibeSquad reuses it and never starts a second daemon.
- **No Paseo yet:** on first launch the Setup Checklist screen downloads `@getpaseo/cli@0.14.0` (~500 MB) from npm into `%LOCALAPPDATA%\com.vibesquad.desktop\paseo`, with live progress and a Retry button if you are offline.
- **Your accounts:** you still install and log in to Claude Code and/or Gemini yourself; the checklist shows what it detects and links to the installers.
- Quitting VibeSquad stops the server it started.

## Quickstart (from source)

**Requirements:** Node.js 22+, [Paseo](https://getpaseo.com) running locally.

```sh
# 1. Clone and install
git clone https://github.com/your-org/vibesquad
cd vibesquad
npm install

# 2. Configure your teams
cp teams.example.json teams.json
# Edit teams.json: set squad names, lane IDs, and project paths

# 3. Install the vs CLI globally
node cli/vs.mjs install-shim

# 4. Start the dev server
npm run dev

# 5. Build for production
npm run build
npm start
```

### teams.json

`teams.json` (gitignored) defines your Squads and their Teams (stored as `lanes`). Copy `teams.example.json` to start. Each entry maps a lane ID to the project paths on disk:

```json
{
  "teams": [
    {
      "id": "my-app",
      "name": "My App",
      "color": "#e8a33d",
      "lanes": [
        { "id": "backend", "name": "Backend", "paths": ["my-app-backend"] },
        { "id": "frontend", "name": "Frontend", "paths": ["my-app-frontend"] }
      ],
      "paths": ["my-app"]
    }
  ]
}
```

Each lane is a pinned **Team** in the UI. Optional pin fields:
- `state`: `"pinned"` (default when missing) or `"done"` (moves the Team to the squad's Done shelf).
- `doneAt`: ISO time the Team was marked complete.
- `order`: sort position inside the squad (defaults to the order in the file).
- `lastProfile`: profile of the last Brainstorm, reused when the Team quick-starts a new one.

The CLI and plugin find `teams.json` in this order:
1. `$VIBESQUAD_TEAMS_FILE` (if set and exists)
2. `~/.vibesquad/teams.json` (unless `$VIBESQUAD_IGNORE_HOME_TEAMS`)
3. `<repo>/teams.json`
4. `<repo>/teams.example.json` (tracked fallback — works on a fresh clone)

### Plugin installation

Install the server plugin in the Paseo daemon to enable prompt layering and agent auto-labelling:

```sh
# In the Paseo config, point the plugin path at plugin/index.server.ts
# (exact steps depend on your Paseo version — see paseo --help plugins)
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VIBESQUAD_HOME` | `~/.vibesquad` | Base directory for logs, profiles, and TLS |
| `VIBESQUAD_TEAMS_FILE` | — | Override path to `teams.json` |
| `VIBESQUAD_IGNORE_HOME_TEAMS` | — | Skip `~/.vibesquad/teams.json` if set |
| `VIBESQUAD_PORT` | `4180` | HTTP/HTTPS listen port |
| `VIBESQUAD_LAN_IP` | auto-detected | Bind to a specific LAN IP for HTTPS |
| `VIBESQUAD_MESHNET_HOST` | — | Meshnet hostname for HTTPS (e.g. a VPN host) |
| `VIBESQUAD_MESHNET_IP` | auto-detected | Meshnet IPv4 |
| `PASEO_HOME` | `~/.paseo` | Paseo daemon home directory |
| `PASEO_DAEMON` | `127.0.0.1:6767` | Paseo daemon address |

## Security

VibeSquad defaults to loopback-only (`127.0.0.1`). LAN and meshnet access require explicit configuration and token-paired devices. See [SECURITY.md](./SECURITY.md) for the threat model and vulnerability reporting.

## Privacy

No prompt or transcript content is logged. See [docs/PRIVACY.md](./docs/PRIVACY.md) for a full list of what VibeSquad stores locally.

## License

MIT — see [LICENSE](./LICENSE).
