@tool
extends EditorExportPlugin
## Keeps the playtest addon out of release exports.
## Presets with the custom feature tag `vs_playtest` keep everything; every other preset drops
## res://addons/vs_playtest/**, the game's adapter dir (project setting vs_playtest/adapter_dir) and
## the `VSPlaytest` autoload entry.
##
## Autoloads are cleared in memory: Godot builds project.binary from the in-memory ProjectSettings at
## export time, so clearing the key in _export_begin (and restoring it in _export_end) removes it from
## the exported game without touching project.godot on disk.
##  - VSPlaytest: otherwise it would point at a skipped script and error at startup.
##  - McpBridge (godot-mcp-runtime attach session), for EVERY preset: its script is never packed
##    (.gdignore), so the entry is always a dangling reference. We also push_error so the dev detaches.
##
## Limit: with script_export_mode != Text Godot's built-in script exporter takes the .gd files before
## plugins see them (verified on 4.7.2), so skip() never runs. Such presets must exclude both paths via
## the preset exclude filter ('addons/vs_playtest/*,vs_playtest_adapter/*'); otherwise we push_error.

const TAG := "vs_playtest"
const ADDON_DIR := "res://addons/vs_playtest/"
const AUTOLOAD_KEY := "autoload/VSPlaytest"
const BRIDGE_KEY := "autoload/McpBridge"
const Settings := preload("res://addons/vs_playtest/settings.gd")

var _stripping := false
var _saved_autoload: Variant = null
var _saved_bridge: Variant = null
var _adapter_dir := ""


func _get_name() -> String:
	return "VSPlaytestExport"


func _export_begin(features: PackedStringArray, _is_debug: bool, _path: String, _flags: int) -> void:
	_stripping = not features.has(TAG)
	_saved_autoload = null
	_saved_bridge = null
	_adapter_dir = Settings.get_str(Settings.ADAPTER_DIR)
	if not _adapter_dir.is_empty() and not _adapter_dir.ends_with("/"):
		_adapter_dir += "/"
	if ProjectSettings.has_setting(BRIDGE_KEY):
		push_error("VS Playtest: project.godot has an McpBridge autoload (a godot-mcp-runtime session is attached). Its script is never exported, so it is removed from this export, but detach with stop_project before exporting and before committing.")
		_saved_bridge = ProjectSettings.get_setting(BRIDGE_KEY)
		ProjectSettings.set_setting(BRIDGE_KEY, null)
	if not _stripping:
		return
	var preset := get_export_preset()
	if preset.get_script_export_mode() != 0:
		var filter := preset.get_exclude_filter()
		var rel_adapter := _adapter_dir.trim_prefix("res://")
		if not filter.contains("addons/vs_playtest") or (not rel_adapter.is_empty() and not filter.contains(rel_adapter.trim_suffix("/"))):
			push_error("VS Playtest: this preset exports compiled scripts (script_export_mode != Text) and Godot's own script exporter consumes .gd files before export plugins see them, so the addon and adapter dir cannot be dropped automatically. Set Script Export Mode to Text, or put 'addons/vs_playtest/*,%s*' in the preset's Exclude filter." % rel_adapter)
	if ProjectSettings.has_setting(AUTOLOAD_KEY):
		_saved_autoload = ProjectSettings.get_setting(AUTOLOAD_KEY)
		ProjectSettings.set_setting(AUTOLOAD_KEY, null)


func _export_file(path: String, _type: String, _features: PackedStringArray) -> void:
	if _stripping and (path.begins_with(ADDON_DIR) or (not _adapter_dir.is_empty() and path.begins_with(_adapter_dir))):
		skip()


func _export_end() -> void:
	if _saved_autoload != null:
		ProjectSettings.set_setting(AUTOLOAD_KEY, _saved_autoload)
	if _saved_bridge != null:
		ProjectSettings.set_setting(BRIDGE_KEY, _saved_bridge)
	_saved_autoload = null
	_saved_bridge = null
	_stripping = false
