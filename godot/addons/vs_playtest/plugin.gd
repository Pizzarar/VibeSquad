@tool
extends EditorPlugin
## Registers the VSPlaytest autoload and the vs_playtest/* project settings.
## B3: export_plugin.gd drops the addon from presets without the `vs_playtest` feature tag.

const AUTOLOAD_NAME := "VSPlaytest"
const AUTOLOAD_PATH := "res://addons/vs_playtest/vs_playtest.gd"
const Settings := preload("res://addons/vs_playtest/settings.gd")
const ExportPlugin := preload("res://addons/vs_playtest/export_plugin.gd")

var _export_plugin: EditorExportPlugin


func _enter_tree() -> void:
	Settings.register_all()
	_export_plugin = ExportPlugin.new()
	add_export_plugin(_export_plugin)


func _exit_tree() -> void:
	if _export_plugin:
		_export_plugin.restore()
		remove_export_plugin(_export_plugin)
		_export_plugin = null


func _enable_plugin() -> void:
	Settings.register_all()
	add_autoload_singleton(AUTOLOAD_NAME, AUTOLOAD_PATH)
	ProjectSettings.save()


func _disable_plugin() -> void:
	remove_autoload_singleton(AUTOLOAD_NAME)
