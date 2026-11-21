# vs_playtest

A Godot 4 addon for the owner's playtesting. It docks a side chat to the game, and a 🐞 button captures a bug report: screenshot, the node under the cursor, scene, state, seed, logs and build hash. The report goes to the VibeSquad Squad you pick. Replies show up in the dock.

It is owner-only and local-only. It talks to a VibeSquad server on the same machine, with the owner's local token (`~/.vibesquad/local-token`, or `$VIBESQUAD_HOME/local-token`).

## Install
1. Copy this folder to `res://addons/vs_playtest/` in your game.
2. Open Project Settings, Plugins, and enable `VS Playtest`. This registers the `VSPlaytest` autoload and the settings below.
3. Set `vs_playtest/team_id` to the Squad that should receive reports. It is required.
4. Optional: set `vs_playtest/server_url` (default `http://127.0.0.1:<VIBESQUAD_PORT>`, else port 4180).
5. Optional: set `vs_playtest/adapter_dir` (default `res://vs_playtest_adapter/`).
6. Optional: set `vs_playtest/hotkey_dock` (default `F8`) and `vs_playtest/hotkey_bug` (default `F9`).

The env var `VS_PLAYTEST_UI_SCALE` sets the dock scale. Without it the addon uses the screen DPI.

## Use
- `F8` opens and closes the dock. While it is open, it polls for replies every 3 seconds.
- `F9` starts a bug capture. Click the node you mean, write a note, and send.
- Reports retry with one `clientReportId`, so a retry never makes a second card.

## Export gate
The dock and the bridge hooks run only in the editor, or in a build whose preset carries the feature tag `vs_playtest`. In any other build `VSPlaytest.enabled` is `false`, and the autoload does nothing and makes no network calls.

An `EditorExportPlugin` (`export_plugin.gd`) enforces this for every preset without the `vs_playtest` tag:
- **Script Export Mode = Text:** it drops `addons/vs_playtest/**`, your adapter dir (`vs_playtest/adapter_dir`) and the `VSPlaytest` autoload entry. Nothing to configure.
- **Compiled modes (binary tokens, compressed):** Godot's own script exporter takes the `.gd` files before the plugin sees them, so the plugin cannot drop them. You MUST put `addons/vs_playtest/*` and the adapter dir (for example `vs_playtest_adapter/*`) in the preset's Exclude filter. If you don't, the export logs an error and ships the addon.
- **McpBridge:** the `McpBridge` autoload (a godot-mcp-runtime attach session) is removed from every export automatically, with an error logged. Still detach (`stop_project`) before you export and before you commit.

Use a preset with the tag `vs_playtest` (custom features) for builds you playtest. Release presets must not carry it. `godot/export_presets.cfg` has examples: `Release` (Text), `Playtest` (tagged), `ReleaseCompiled` (compiled, with the exclude filter) and `ReleaseCompiledUnsafe` (compiled, no filter: logs the error).

## Game adapter
Keep your adapter script in the adapter dir, setting `vs_playtest/adapter_dir` (default `res://vs_playtest_adapter/`). It extends `VSPlaytestAdapter`, so release exports drop it with the addon. Never mention `VSPlaytestAdapter` or `VSPlaytest` types in scripts that always ship. Register with a guarded `load()`, only when the autoload exists and is enabled (pattern from `godot/sample/main.gd`):

```gdscript
const ADAPTER_PATH := "res://vs_playtest_adapter/my_adapter.gd"

func _ready() -> void:
	var vsp := get_node_or_null("/root/VSPlaytest")
	if vsp == null or not vsp.enabled:
		return
	vsp.register_adapter(load(ADAPTER_PATH).new())
```

## Adapter API
Autoload: `VSPlaytest` (only in the editor or `vs_playtest` builds; otherwise `VSPlaytest.enabled == false`).

- `VSPlaytest.register_adapter(adapter: VSPlaytestAdapter)`: the game calls this once from its own autoload.
- `class_name VSPlaytestAdapter extends RefCounted`. Every method is optional with a safe default:
  - `get_info() -> Dictionary` returns `{name, version}`, which goes into `telemetry.adapter`
  - `get_state() -> Dictionary`: JSON-safe, up to 64 KB (truncated with a marker), goes into `telemetry.state`
  - `get_seed() -> String`, goes into `telemetry.seed`
  - `get_build_hash() -> String`; the default is `ProjectSettings application/config/version`
  - `describe_node(node: Node) -> String`; the default is `node.get_path()`, goes into `telemetry.cursorNode`
  - `get_cheats() -> Array[Dictionary]`, each `{id, label, args?: Array}`
  - `run_cheat(id: String, args: Array) -> Variant`
- Project settings: `vs_playtest/team_id` (required), `vs_playtest/server_url`, `vs_playtest/adapter_dir`, `vs_playtest/hotkey_dock` (default F8), `vs_playtest/hotkey_bug` (default F9).
- Signals: `report_sent(card_id)`, `reply_received(message)`.
- Capture payload: `{teamId, text, screenshotBase64, screenshotMime, clientReportId, telemetry:{clickedPoint, viewport, cursorNode, scene, state, seed, adapter, buildHash, engine, platform, logLines(last 200 lines, each clipped to 300 chars)}}`.
- Agent helpers on the autoload, reached through the bridge: `VSPlaytest.state()`, `.seed()`, `.cheats()`, `.cheat(id, args)`. They are safe no-ops when disabled or without an adapter.
- Other helpers: `has_adapter()`, `open_dock()`, `close_dock()`, `toggle_dock()`, `set_ui_scale(s)`.

Example adapter:

```gdscript
class_name MyAdapter
extends VSPlaytestAdapter

func get_info() -> Dictionary:
	return {"name": "my-game", "version": "1.0"}

func get_state() -> Dictionary:
	return {"hp": 42}

func get_cheats() -> Array[Dictionary]:
	return [{"id": "god_mode", "label": "God mode", "args": [true]}]

func run_cheat(id: String, args: Array) -> Variant:
	return "ok" if id == "god_mode" else null
```

Register it with the guarded `load()` shown under Game adapter.

## For agents
How an agent inspects and drives the running game (attach recipe, `run_script` snippets, rules): `docs/lanes/playtest-overlay/README.md` in the VibeSquad repo.
