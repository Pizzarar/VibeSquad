class_name VSPlaytestAdapter
extends RefCounted
## Base class for a game's playtest adapter. Every method is optional: override only what you have.
## Register with: VSPlaytest.register_adapter(MyAdapter.new())


## {name, version}; goes into telemetry.adapter.
func get_info() -> Dictionary:
	return {"name": "", "version": ""}


## JSON-safe game state for bug reports. Anything over 64 KB is truncated with a marker by the addon.
func get_state() -> Dictionary:
	return {}


## The RNG seed / run id needed to reproduce this session.
func get_seed() -> String:
	return ""


## Defaults to the project's application/config/version.
func get_build_hash() -> String:
	return String(ProjectSettings.get_setting("application/config/version", ""))


## Describes the node under the cursor; goes into telemetry.cursorNode.
func describe_node(node: Node) -> String:
	if node == null:
		return ""
	return str(node.get_path()) if node.is_inside_tree() else str(node.name)


## Dev cheats, each {id: String, label: String, args?: Array}.
func get_cheats() -> Array[Dictionary]:
	return []


## Runs the cheat `id`; the return value is handed to the caller (a bridge agent).
func run_cheat(_id: String, _args: Array) -> Variant:
	return null
