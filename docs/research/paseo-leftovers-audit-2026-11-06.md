# Paseo leftovers audit (B9 step 1, @bugc, 2026-11-06)

Audit only: no code changed, nothing removed. File:line refs are from master at `44ebee3`.

**Summary**
- Verdicts (41 rows): remove 12 · replace with runner-native 17 · keep 12 (rows marked "keep, reword" count as keep).
- Top user-visible: (1) Setup Checklist opens with "1. Paseo CLI & Daemon" + a Daemon password field; (2) Settings → Paseo tab (13 sub-tabs, "STOPPED" pill); (3) Settings → App banner "they live in the Paseo daemon"; (4) Pair-device "PASEO LINK PAIRING" card + Settings → Remote copy; (5) Drawer "Open in Paseo", About "pinned CLI v0.14.0", "Connecting to Paseo…".
- Agent prompts (R6/R9, lessons, Buddy note) still tell agents to run `paseo wait` / `paseo ls` / `paseo --help`; those fail with the daemon down.
- Diagnostics is already clean on the runner (the Paseo section hides itself, `src/DiagnosticsModal.tsx:322`); only dead code remains there.
- Screenshots (1280x800): [Setup Checklist](paseo-leftovers-2026-11-06/setup-checklist.png) · [Settings → App](paseo-leftovers-2026-11-06/settings-app.png) · [Settings → Paseo](paseo-leftovers-2026-11-06/settings-paseo-tab.png) · [Diagnostics](paseo-leftovers-2026-11-06/diagnostics.png)

Keep rows follow `docs/lanes/runner-pilot/SPEC.md:3,9,16` (remote link pairing stays; `VS_BACKEND=paseo` rollback stays). "Remove" means after step 2 agrees a plan with Aub.

## UI: Settings

| item | file:line | what the user sees | verdict |
|---|---|---|---|
| Settings nav "Paseo" entry | src/SettingsHome.tsx:39,45,133 | "Paseo" tab in the Settings sidebar ([shot](paseo-leftovers-2026-11-06/settings-paseo-tab.png)) | remove (or show only when VS_BACKEND=paseo) |
| App banner "live in the Paseo daemon" | src/SettingsHome.tsx:157 | Teal banner on Settings → App; false now ([shot](paseo-leftovers-2026-11-06/settings-app.png)) | replace: "they live in the VibeSquad runner" |
| Settings cog tooltip | src/App.tsx:524 | "Settings: app, chat, ..., Paseo, profiles" | replace (drop "Paseo") |
| Paseo settings section (13 tabs: daemon, network, providers, plugins, raw config, ops, MCP, skills, runner) | src/PaseoSettingsSection.tsx (167 hits), mounted at src/TeamSettingsModal.tsx:668 | "PASEO SETTINGS (HOST MODE · ~/.paseo/config.json)", STOPPED pill, Start/Reload/Restart/Stop | remove (tab 13 "Runner & Providers" is the live part: move it out first) |
| "Start Paseo with VibeSquad" / "Keep Paseo running" toggles | src/PaseoSettingsSection.tsx (daemon tab) | Two checkboxes, both off | remove |
| Remote-device notice | src/TeamSettingsModal.tsx:679-680 | "Paseo settings live on the host machine..." | remove with the section |
| Remote Control "PASEO RELAY & REMOTE ACCESS" | src/TeamSettingsModal.tsx:526-528,571 | Section label and body naming Paseo Relay | keep (relay pairing is retained), reword to "VibeSquad Relay" |
| Profiles import "…FROM PASEO" | src/TeamSettingsModal.tsx:62-63,94,120,162,688-707,742 | "SYNC / RE-IMPORT PROFILES FROM PASEO", "PASEO ONLY" badge, "Diff detected against Paseo config" | replace (profiles live in ~/.vibesquad/profiles.json; drop, or label as one-time migration) |
| Deep link "paseo-daemon" settings target | src/App.tsx:1923-1924 | Daemon banner button jumps into the Paseo tab | remove with the banner |
| Header usage chip | src/App.tsx:1081, src/PaseoSettingsSection.tsx:170-176 | Chip titled "Paseo provider account usage (click to open Settings)" | replace with runner usage (title and source) |

## UI: Diagnostics, status, onboarding

| item | file:line | what the user sees | verdict |
|---|---|---|---|
| Setup Checklist "1. Paseo CLI & Daemon (optional)" + Start Daemon + Daemon password + "Paseo is optional" | src/FirstRunModal.tsx:148-160 (also 69,79), server/first-run.mjs (54 hits) | First card in the checklist on launch ([shot](paseo-leftovers-2026-11-06/setup-checklist.png)) | remove (the runner needs Claude/Gemini only); keep the install code behind VS_BACKEND=paseo |
| Diagnostics PaseoConnectionSection | src/DiagnosticsModal.tsx:315-365 | "Paseo daemon locked/disconnected" + password box; hidden on runner ([shot](paseo-leftovers-2026-11-06/diagnostics.png)) | keep (rollback path, self-hides) |
| Daemon-lock banner/overlay copy | src/DiagnosticsModal.tsx:235-266,303-304 | "PASEO DAEMON LOCKED", "Enter Paseo daemon password…", link to Paseo settings | remove (Block 0 is already on the overlay; idea-11 tracks it) |
| Header status pill/dot | src/App.tsx:1416-1417, src/daemonOverlay.ts:10-46 | "Runner disconnected · reconnecting" | keep (runner-native already; the Paseo branch stays silent) |
| "Connecting to Paseo…" | src/App.tsx:2015 | Loading text | replace ("Connecting…") |
| About: "works with Paseo (pinned CLI v0.14.0)" | src/App.tsx:1402 | About dialog line | replace |
| About: Paseo Apache-2.0 credit | src/App.tsx:1341 | License notice | keep (licence obligation while @getpaseo/* is bundled) |
| "This folder isn't a Paseo workspace yet" | src/NoWorkspaceBanner.tsx:29 | Banner on an agent with no Paseo workspace | replace (runner workspaces) or remove |

## UI: pairing, drawer, pickers

| item | file:line | what the user sees | verdict |
|---|---|---|---|
| Pair-device "PASEO LINK PAIRING (#offer=…)" card, copy/QR/open buttons | src/PairDeviceModal.tsx:422-505 | Card with Paseo wording, "Copy Paseo Link" | keep (SPEC:3), reword to VibeSquad Relay |
| Pair-device error copy | src/PairDeviceModal.tsx:521-523 | "Enable Relay in Settings → Paseo → Network & Remote" (points at a tab that is going away) | replace (point at Settings → Remote Control) |
| Remote pairing screen | src/RemotePair.tsx:1-13,167,196 | "Paste the Paseo pairing link…", `https://app.paseo.sh/#offer=…` placeholder | keep (canonical link format required, SPEC:3) |
| Drawer "Open in Paseo" link | src/DrawerHeader.tsx:1154-1171,1465 | Link in the agent drawer header | remove (no Paseo UI to open) |
| "paseo.open-agent-tab" meta filter | src/DrawerHeader.tsx:1425,1543 | Hidden internal rows | remove with the link |
| daemonClient call sites | 37 files in src/ (e.g. src/CommandPalette.tsx:2, src/ProjectPanel.tsx:3) | Errors only if called for an rn- agent; invisible when it works | replace with runnerBridge equivalents (needs a per-call-site list in step 2) |
| Provider/model pickers | src/DrawerHeader.tsx:9,299-309 (src/paseoProviders.ts) | Model/mode pickers read through the Paseo provider API | replace once runnerBridge lists runner providers; verify first |
| Ops / Skills / Schedules / Worktrees panels | src/PaseoOpsPanel.tsx (43 hits), src/SkillsPanel.tsx (29), src/SchedulesPanel.tsx, src/WorktreesPanel.tsx (17) | Panels fed by the daemon; empty or erroring when it is down | replace (runner-native stand-ins per SPEC:9) |

## Server

| item | file:line | what the user sees | verdict |
|---|---|---|---|
| `/__vibesquad/paseo/*` routes (status, daemon, usage, providers, plugins, surface, hub, raw/open, raw/restore, daemon-auth) | server/vibesquad-api.mjs:412-421,1812-1956 | Backing for the Paseo tab | remove |
| `/__vibesquad/paseo/pair` | server/vibesquad-api.mjs:414,1942 | Backing for the pairing card | keep (SPEC:3) |
| paseo-control.mjs (config.json editor, `paseo reload`, daemon start/stop; 145 hits) | server/paseo-control.mjs:1-12; imported by brainstorm.mjs:9, daemon-password.mjs:5, serve.mjs:46 | Nothing directly; drives the Paseo tab | keep `checkDaemonListenExposure` and `readRawPaseoConfig` (their callers need them), remove the rest with the tab |
| First-run installer `install-paseo` | server/first-run.mjs; called at src/FirstRunModal.tsx:69 | "Installing @getpaseo/cli…" | remove |
| Paseo backend + lane routing | server/backend/paseo-backend.mjs, paseo-cli.mjs, lane-routing.mjs | Nothing | keep (VS_BACKEND=paseo rollback, SPEC:16) |
| MCP "Paseo-compatible alias of …" tools | server/mcp/tools.mjs:310-341 | Tool descriptions agents see | keep until the prompt rows below are fixed, then remove |

## CLI and plugin-screens

| item | file:line | what the user sees | verdict |
|---|---|---|---|
| `vs` reads the Paseo agent store | cli/vs.mjs:12-14,104,230-256 | `vs who` falls back to the ~/.paseo store | keep (legacy agents until retired) |
| `runPaseo(["inspect", …])` shell-outs | cli/vs.mjs:282-283,475,797,1182 | Up to 1.5s stall and an empty result for non-rn- ids with the daemon down | replace (skip when the daemon is down) |
| plugin-screens (Paseo plugin: Squads screen) | plugin-screens/ (14 files, e.g. client/agents.ts:1-15, OVERVIEW.md:1-3) | Only visible inside the Paseo app | keep (dead while the daemon is off; only matters for the Paseo rollback) |

## Agent prompts and profile notes

| item | file:line | what the user sees | verdict |
|---|---|---|---|
| R6 "Wait on agents with `paseo wait <id>`" | server/profiles.mjs:36, src/profiles.ts:72 | Rule injected into every agent; fails with the daemon down | replace (VS MCP `wait`) |
| R9 "`paseo la`→paseo ls" | server/profiles.mjs:39, src/profiles.ts:75 | Shorthand example | replace |
| "check `paseo --help`, Paseo MCP tool list" | server/profiles.mjs:44, server/brainstorm.mjs:306, src/profiles.ts:80 | Buddy prompt | replace (`vs --help`, VS MCP tools) |
| Art Director note "`send_agent_prompt` on the Paseo MCP" | server/profiles.mjs:80, src/profiles.ts:116 | Prompt hint | replace |
| Lessons "`paseo ls -g --json`", "`paseo wait <id>`" | server/lessons.mjs:158,161 | Lessons injected into agents | replace |
| Role notes naming `create_agent` / `send_agent_prompt` | server/mcp/tools.mjs:310 (aliases) | Work through the aliases | remove later (after the prompt pass, drop the aliases) |

## Not covered
Not audited line by line: src/demo.tsx, src/styles.css (19 hits), server/push.mjs copy (28 hits), SkillsPanel and WorktreesPanel internals; docs/ and test/ are out of scope. Counts come from grep (src 966 hits/106 files, server 702/45, cli 18, plugin-screens 44).
