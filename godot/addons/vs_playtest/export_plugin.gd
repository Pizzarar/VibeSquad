@tool
extends EditorExportPlugin
## Keeps the playtest addon out of release exports.
## Presets with the custom feature tag `vs_playtest` keep everything; every other preset drops
## res://addons/vs_playtest/** and the `VSPlaytest` autoload entry.
##
## Limit: with script_export_mode != Text Godot's built-in script exporter takes the .gd files before
## plugins see them (verified on 4.7.2), so skip() never runs; we then error and tell the dev to use
## Text mode or the preset exclude filter 'addons/vs_playtest/*'.
##
## Why the autoload is cleared in memory: Godot builds project.binary from the in-memory
## ProjectSettings at export time, so clearing `autoload/VSPlaytest` in _export_begin (and restoring
## it in _export_end) removes it from the exported game without touching project.godot on disk.
## Otherwise the autoload would point at a skipped script and error at startup.

const TAG := "vs_playtest"
const ADDON_DIR := "res://addons/vs_playtest/"
const AUTOLOAD_KEY := "autoload/VSPlaytest"

var _stripping := false
var _saved_autoload: Variant = null


func _get_name() -> String:
	return "VSPlaytestExport"


func _export_begin(features: PackedStringArray, _is_debug: bool, _path: String, _flags: int) -> void:
	_stripping = not features.has(TAG)
	_saved_autoload = null
	if _has_bridge_autoload():
		push_error("VS Playtest: project.godot has an McpBridge autoload (a godot-mcp-runtime session is attached). The export will contain a dangling autoload and fail at startup. Detach with stop_project before exporting, then export again.")
	if _stripping:
		var preset := get_export_preset()
		if preset.get_script_export_mode() != 0 and not preset.get_exclude_filter().contains("addons/vs_playtest"):
			push_error("VS Playtest: this preset exports compiled scripts (script_export_mode != Text), and Godot's own script exporter consumes .gd files before export plugins see them, so addons/vs_playtest/** cannot be dropped automatically. Set the preset's Script Export Mode to Text, or add 'addons/vs_playtest/*' to its Exclude filter.")
	if _stripping and ProjectSettings.has_setting(AUTOLOAD_KEY):
		_saved_autoload = ProjectSettings.get_setting(AUTOLOAD_KEY)
		ProjectSettings.set_setting(AUTOLOAD_KEY, null)


func _export_file(path: String, _type: String, _features: PackedStringArray) -> void:
	if _stripping and path.begins_with(ADDON_DIR):
		skip()


func _export_end() -> void:
	if _saved_autoload != null:
		ProjectSettings.set_setting(AUTOLOAD_KEY, _saved_autoload)
	_saved_autoload = null
	_stripping = false


func _has_bridge_autoload() -> bool:
	return ProjectSettings.has_setting("autoload/McpBridge")
