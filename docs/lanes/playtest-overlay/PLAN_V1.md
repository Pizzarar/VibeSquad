# PLAN · Playtest Overlay v1 (`playtest-overlay`)

## Idea
This is a reusable Godot 4 addon owned by VibeSquad. It docks a side chat on any Godot project. A 🐞 button does click-to-point capture: screenshot, the node under the cursor, scene, state, seed, logs and build hash. The report goes to the Squad's bug intake, and replies show up in the dock. A local debug bridge lets a VS agent on Aub's PC inspect and drive the running game (scene tree, screenshots, input, dev cheats). The first consumer is the EFI adapter (idea-498, @pqs).

## Owner's words (verbatim, via Hub15)
> "it's a plugin for MY playtesting, of course the answer is the plugin that only works for me."

Hub15: "v1 is owner-only: no tester mode, no meshnet, no E6 dependency for v1. Keep the payload shape E6-compatible so testers can bolt on later, but don't build that now."

## Decided
- **Owner-only, local-only, dev builds only.** No tester mode, pairing, meshnet or relay in v1.
- **Auth:** the addon reads the per-install local token from `~/.vibesquad/local-token` (or `$VIBESQUAD_HOME/local-token`) and sends `x-vibesquad-token` to the loopback VS server. This is the existing owner primitive (`server/local-token.mjs:11-15`, `server/auth.mjs:909-919`). No new auth.
- **Report/thread transport:** reuse the E6a handlers, which are already on master (`d28351af`). They are `POST /__vibesquad/tester/report` and `GET/POST /__vibesquad/tester/thread?after=`, with the payload schema at `server/vibesquad-api.mjs:2022-2070`. Today only bug-tester devices can reach them (`testerGated`, `server/vibesquad-api.mjs:2573-2591`). Block B1 opens the same two routes to a local owner caller with an explicit `teamId`. That gives one payload shape, so testers bolt on later with zero addon changes. Checked first: the owner `/__vibesquad/inbox` + `/attachment` + `/send` path works but takes 3 calls and drops structured telemetry, so it was rejected.
- **Debug bridge base:** build on Erodenn/godot-mcp-runtime (MIT; localhost TCP `McpBridge` autoload; `attach: true` works on a game you launched yourself). Credit line: "Implemented runtime debug bridge — Thanks to godot-mcp-runtime by Erodenn". Other servers surveyed: mkdevkit/godot-mcp (MIT, user:// file IPC, needs editor Play mode) is a source of verb ideas only. yanhuifair/Godot-MCP is AGPL-3.0, so we borrow no code; it contributed only the freeze/step idea and the `OS.has_feature("editor")` gate.
- **Adapter hooks reach the agent through the bridge** (eval/call on the `VSPlaytest` autoload). We don't extend the bridge protocol unless the B0 spike shows we must.
- **Export exclusion:** the dock and bridge run only when `OS.has_feature("editor")` or the custom feature tag `vs_playtest` is set (a dev/alpha preset). An `EditorExportPlugin` drops `addons/vs_playtest/**` from every preset without that tag.
- **Home:** `godot/addons/vs_playtest/` in the VibeSquad repo. EFI copies it in. A `vs playtest install` command is out of scope for v1 (checked `vs --help`: no existing primitive, and none is needed yet).
- **Visual:** a plain readable dock first (4K at 120% is the review target, per memory "Design for 4K first"). A light Hypnospace touch is allowed only on the 🐞 button and the dock header.
- **Primitives checked:** `vs --help` (no playtest/godot command), the E6a tester routes, the local-token owner auth, and the owner inbox routes.

## Addon API (v1 name: `VSPlaytest`; this is what EFI @pqs builds against)
- Autoload `VSPlaytest` (only in editor or `vs_playtest` builds; otherwise it does nothing and `VSPlaytest.enabled == false`).
- `VSPlaytest.register_adapter(adapter: VSPlaytestAdapter)`: the game calls this once from its own autoload.
- `class_name VSPlaytestAdapter extends RefCounted`. Every method is optional with a safe default:
  - `get_info() -> Dictionary` returns `{name, version}`, which goes into `telemetry.adapter`
  - `get_state() -> Dictionary`: JSON-safe, ≤ 64 KB (truncated with a marker), goes into `telemetry.state`
  - `get_seed() -> String`, goes into `telemetry.seed`
  - `get_build_hash() -> String`; the default is `ProjectSettings application/config/version`
  - `describe_node(node: Node) -> String`; the default is `node.get_path()`, goes into `telemetry.cursorNode`
  - `get_cheats() -> Array[Dictionary]`, each `{id, label, args?: Array}`
  - `run_cheat(id: String, args: Array) -> Variant`
- Project settings: `vs_playtest/team_id` (the Squad that receives reports; required), `vs_playtest/server_url` (default `http://127.0.0.1:<VS port>`), `vs_playtest/hotkey_dock` (default F8), `vs_playtest/hotkey_bug` (default F9).
- Signals: `report_sent(card_id)`, `reply_received(message)`.
- Capture payload: exactly the E6a body `{teamId, text, screenshotBase64, screenshotMime, clientReportId, telemetry:{clickedPoint, viewport, cursorNode, scene, state, seed, adapter, buildHash, engine, platform, logLines(last 200)}}`.
- Agent-side (bridge): the community server's verbs (tree, node get/set, call, screenshot, input, eval), plus `VSPlaytest.state()`, `.seed()`, `.cheats()` and `.cheat(id, args)` reached through call/eval. Pause/step stays Open until B0 shows whether it exists.

## Plan
| Block | Touches | Clashes with | Kind |
|---|---|---|---|
| **B0 Bridge spike**: run godot-mcp-runtime `attach` against a sample Godot 4.5 project on Aub's PC. Record the wire protocol, verbs and attach flow, whether it edits `project.godot`, whether anything leaks into an export, and whether it coexists with our autoload. Output: `docs/lanes/playtest-overlay/BRIDGE_SPIKE.md` with a verdict of **as-is** or **our autoload speaks its wire**. | docs only, scratch project outside repo | none | Root cause |
| **B1 Owner access to report/thread**: a local owner caller (`isLocalOwner`) may call `POST /__vibesquad/tester/report` and `GET/POST /__vibesquad/tester/thread` with a required `teamId`, using the same handlers and payload. The card is stamped `[Owner playtest]`, not `[Alpha Tester]`. Tester gating is unchanged. Tier A review (it touches the auth route table). | `server/vibesquad-api.mjs`, `test/` (new `owner-playtest-report.test.mjs`) | E6b/E6c work by @and And8 in the same file; rebase on master first | Root cause |
| **B2 Addon core**: `godot/addons/vs_playtest/` with plugin.cfg, the `VSPlaytest` autoload, the `VSPlaytestAdapter` base, the dock (chat thread polling `after=` every 3 s while open, input box), the 🐞 click-to-point capture overlay, the payload builder, the local-token reader, the HTTP client, and `clientReportId` retry. | `godot/addons/vs_playtest/**`, `godot/sample/` (minimal test project) | none | Root cause |
| **B3 Export exclusion**: the feature-tag gate plus an `EditorExportPlugin`. | `godot/addons/vs_playtest/export_plugin.gd` | B2 (same folder, so do it after B2) | Root cause |
| **B4 Bridge wiring** per the B0 verdict: either (a) set up godot-mcp-runtime in the VS lead/worker MCP config for Godot lanes plus a short how-to, or (b) a `vs_playtest` bridge autoload that speaks its wire protocol. Expose the adapter hooks either way. Add the credit to `CREDITS.md`. | `godot/addons/vs_playtest/bridge*` or MCP profile config, `CREDITS.md`, `docs/lanes/playtest-overlay/README.md` | B2/B3 folder | Root cause |
| **B5 Docs**: `godot/addons/vs_playtest/README.md` covering install (copy the folder, enable the plugin, set `team_id`), the adapter API above and the agent how-to. | docs | B4 | Root cause |

No workarounds in v1.

**Order:** B0 and B1 run in parallel. B2 starts in parallel with them; its HTTP layer can stub until B1 merges. Then B3, B4 (after the B0 verdict), B5.

**Done-check (v1):** on Aub's PC, a sample Godot project with the addon:
1. F9, then click a node. A card appears in that Squad's bug lane with the screenshot, cursorNode, scene, state, seed and buildHash.
2. A reply from the intake agent shows up in the F8 dock within 5 s, and a dock reply reaches the agent.
3. A VS agent fetches the scene tree and a screenshot through the bridge and runs one adapter cheat.
4. Exporting with a release preset (no `vs_playtest` tag) yields a .pck with zero `vs_playtest` files (checked with `--export-pack` plus a file listing).
5. Headless Godot tests pass and the server test suite passes.

## Lead
New Claude lead (`Lead - Claude`, Opus 5.5), because B1 is Tier A (auth route table).

## Out of scope (v1)
Tester mode, pairing, meshnet/relay, the phone dock, the `vs playtest install` command, the EFI adapter itself (@pqs idea-498), Godot 3, and voice capture.

## Open
- Pause/step verbs: kept if the base server has them; otherwise v2.
