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

## Remote owner path (added 11-21, Hub15 steer, owner OK)
VS server moves to a separate Linux box on Tailscale (@forge-host). The game and the Godot editor stay on the dev PC. So the owner can no longer be assumed to be on loopback. Loopback stays supported.

**Decided (Pto1):**
- **Reuse E6a device auth, no new primitive.** The game pairs once as a normal **owner** device through the existing JSON pair redeem (`GET /pair?code=…&format=json`, then `GET /pair/status` if pending; `docs/PLAN_E6_TESTER_ROLES.md:15,45`). It then sends `Authorization: Bearer <deviceToken>` (or `x-vs-device-token`). Checked: E6a already resolves header-authenticated owner devices and exempts them from cookie write refusal (`PLAN_E6_TESTER_ROLES.md:44`).
- **Server (B1b, Tier A):** `ownerPlaytestGated` accepts either today's local owner (loopback + local token) **or** a paired device with `role === "owner"` authenticated by a **header** token (not the cookie). Every other B1 rule is unchanged: explicit `teamId`, no agent headers, `[Owner playtest]` stamp, same handlers, payload, caps and dedupe (scope = owner device id or local owner + Squad). Testers are unchanged, and so is every non-owner denial. The B1 test "paired OWNER device (not local) is 403" flips to: header-token owner device → 200; cookie-only owner device → 403.
- **Addon (B2b):** two auth modes, picked automatically:
  1. `server_url` is loopback: local token (`x-vibesquad-token`), as today.
  2. Otherwise: device token from a file outside the project (`$VIBESQUAD_HOME/playtest-device-token`, else `~/.vibesquad/playtest-device-token`; never under `res://` or `user://`, never exported).
  - **Token egress rule:** the local token only ever goes to loopback (B2 H1 parser). The device token goes only to loopback, a Tailscale address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`, `*.ts.net`) or any `https://` host. Otherwise the request is refused and the dock says why. Redirects stay off.
  - **Pairing in the dock:** with no device token and a remote `server_url`, the dock shows "Pair with VS". The owner mints a normal owner pairing code in VS (existing Pair Device UI / `vs pair`), types the 6 digits, and the addon redeems it as JSON and stores the token (polling `/pair/status` while pending). There's an "Unpair" action that deletes the file. Revoking the device in VS cuts it off (existing E6a revoke).
- **Addon API additions** (noted to the Buddy for EFI): setting `vs_playtest/device_token_path` (optional override of the file above), and methods `is_paired()` and `unpair()`. Nothing existing changes.
- **Accepted risk:** the game process holds a full-owner device token. This is owner-only, on the owner's own dev PC, in editor/`vs_playtest` builds only, and the file sits outside the project. Follow-up (not v1): a least-privilege `owner-playtest` device role limited to report/thread.
- **Bridge:** unchanged. godot-mcp-runtime runs next to the game on the dev PC (localhost). An agent that runs on the forge box can't reach it; agents that drive the game must run on the dev PC. @forge-host to confirm where Godot-lane agents run.

| Block | Touches | Clashes with | Kind |
|---|---|---|---|
| **B1b Remote owner device on report/thread** (Tier A) | `server/vibesquad-api.mjs` (ownerPlaytestGated), `test/owner-playtest-report.test.mjs` | none in lane | Root cause |
| **B2b Addon device-token mode + pair UI** | `godot/addons/vs_playtest/{token,transport,report_client,dock,settings,vs_playtest}.gd`, `godot/tests/run_tests.gd`, the addon README | B3 r2 fix (`run_tests.gd`, README): runs after it lands | Root cause |

## Lead
New Claude lead (`Lead - Claude`, Opus 5.5), because B1 is Tier A (auth route table).

## Out of scope (v1)
Tester mode, pairing, meshnet/relay, the phone dock, the `vs playtest install` command, the EFI adapter itself (@pqs idea-498), Godot 3, and voice capture.

## Open
- Pause/step verbs: kept if the base server has them; otherwise v2.
