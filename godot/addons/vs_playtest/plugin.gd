@tool
extends EditorPlugin
## Registers the VSPlaytest autoload and the vs_playtest/* project settings.
## B3 (export exclusion) will add an EditorExportPlugin here; leave the seam below.

const AUTOLOAD_NAME := "VSPlaytest"
const AUTOLOAD_PATH := "res://addons/vs_playtest/vs_playtest.gd"
const Settings := preload("res://addons/vs_playtest/settings.gd")


func _enter_tree() -> void:
	Settings.register_all()
	# B3 seam: add_export_plugin(...) goes here.


func _exit_tree() -> void:
	pass # B3 seam: remove_export_plugin(...)


func _enable_plugin() -> void:
	Settings.register_all()
	add_autoload_singleton(AUTOLOAD_NAME, AUTOLOAD_PATH)
	ProjectSettings.save()


func _disable_plugin() -> void:
	remove_autoload_singleton(AUTOLOAD_NAME)
