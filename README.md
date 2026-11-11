# VibeSquad

> **New here? Take the [interactive tour: how VibeSquad works](https://pizzarar.github.io/VibeSquad/how-it-works.html).**

Multi-agent coordination system for [Claude Code](https://claude.com/claude-code) and Gemini, running on VibeSquad's own agent runner. Use it as a Windows desktop app, in the browser, or from your phone (Android app or PWA).

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

The VibeSquad **agent runner** (`runner/`) manages agent sessions; the VS server (`server/`) hosts it. VibeSquad adds:

- `vs` CLI: team log, `vs who`, `vs whoami`, `vs handoff`, `vs inbox`, `vs profiles`, `vs restart`
- Agent duties hook module (`server/hooks/agent-duties.ts`, hosted by the VS server): prompt layering, auto-labelling, digest routing, lead handoff
- Web UI (`src/`): roster view, team settings, idea inbox, profile management, Pair a Device modal. Two looks, picked on first launch and switchable any time: **Normal** (a plain layout with a sidebar, chat and project cards) and **Psycho** (the pixel-art Vibespace office)
- Push server (`server/push.mjs`): Web Push notifications for agent attention events

## Where it runs

- **Desktop app (Windows):** a Tauri shell with an NSIS installer (`src-tauri/tauri.conf.json`).
- **Web:** the same UI served by the local server (`npm start`, default port 4180).
- **Android app / PWA:** open **Link / Pair a Device (QR & 6-Digit Code)** on the PC, then scan the QR (or type the 6-digit code) on the phone. The window shows the **CA SHA-256 FINGERPRINT** to compare against what the phone shows, and **PAIRED DEVICES** has a **Revoke** button that signs a device out at once. Other devices are off by default (loopback only) until you enable remote access. Details: [Settings reference](guide/Reference/Settings.md).
- **`vs restart`:** owner/Overlord only. It waits for agents to go idle (and for background work such as a test run), then restarts the runner and VS server and resumes the agents the restart lost. If background work is still running when the wait ends, the restart is put off and nothing is stopped.
- **Live-Needs:** merge commits carry a `Live-Needs:` trailer (`none`, `build`, `frontend-reload`, `runner-restart`, `server-restart`) saying what a merge needs to go live.

## Install (Windows, one-stop installer)

Run `VibeSquad-setup.exe`. It bundles everything VibeSquad itself needs: a pinned Node.js LTS (`node.exe` plus npm), the built web app, the server, the `vs` CLI and its production dependencies. No system-wide Node is required, and `vs` works from any terminal afterwards.

- **Your accounts:** you still install and log in to Claude Code and/or Gemini yourself; the first-launch **Setup Checklist** shows what it detects (Claude Code, Gemini / Antigravity, optional Git) and links to the installers; you need at least one of Claude Code or Gemini to continue.
- Quitting VibeSquad stops the server it started.

## Quickstart (from source)

**Requirements:** Node.js 22+, and Claude Code and/or Gemini installed and logged in.

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

The CLI and server find `teams.json` in this order:
1. `$VIBESQUAD_TEAMS_FILE` (if set and exists)
2. `~/.vibesquad/teams.json` (unless `$VIBESQUAD_IGNORE_HOME_TEAMS`)
3. `<repo>/teams.json`
4. `<repo>/teams.example.json` (tracked fallback — works on a fresh clone)

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

## Credits

VibeSquad was first built on [Paseo](https://getpaseo.com) by getpaseo and has since replaced it with its own runner; Paseo is not used or needed at runtime. Implemented VS agent runner adapters, native schedules and heartbeats, and MCP name aliases — Thanks to **Paseo** by `getpaseo`. See [CREDITS.md](./CREDITS.md) for the full list.

## Security

VibeSquad defaults to loopback-only (`127.0.0.1`). LAN and meshnet access require explicit configuration and token-paired devices. See [SECURITY.md](./SECURITY.md) for the threat model and vulnerability reporting.

## Privacy

No prompt or transcript content is logged. See [docs/PRIVACY.md](./docs/PRIVACY.md) for a full list of what VibeSquad stores locally.

## License

MIT — see [LICENSE](./LICENSE).
