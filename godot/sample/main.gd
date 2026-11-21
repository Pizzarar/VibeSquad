extends Control
## Sample scene. `-- --vs-shot=<png>` (used for the review screenshot) opens the dock + capture overlay, saves the window, quits.

const SampleAdapter := preload("res://sample/sample_adapter.gd")


func _ready() -> void:
	var vsp := get_node_or_null("/root/VSPlaytest")
	if vsp == null:
		return
	vsp.register_adapter(SampleAdapter.new())
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--vs-shot="):
			_shot(vsp, a.trim_prefix("--vs-shot="))


func _shot(vsp: Node, path: String) -> void:
	await get_tree().create_timer(0.5).timeout
	var win := get_window()
	win.mode = Window.MODE_WINDOWED
	win.size = Vector2i(3840, 2160) # the OS may clamp a window to the screen; the shot then uses the clamped size
	win.position = Vector2i.ZERO
	await get_tree().create_timer(0.5).timeout
	vsp.set_ui_scale(1.2)
	vsp.open_dock()
	var dock: Control = vsp._dock
	dock.clear_messages()
	dock.set_status("")
	dock.append_message({"role": "user", "text": "[report idea-501] The coin counter overlaps the button at the top."})
	dock.append_message({"role": "assistant", "text": "Got it. I can see the Label overlapping the Button in your screenshot; checking the anchors now."})
	dock.append_message({"role": "user", "text": "Thanks. It only happens at 4K."})
	vsp._overlay.begin_pick()
	await get_tree().create_timer(0.3).timeout
	await RenderingServer.frame_post_draw
	get_viewport().get_texture().get_image().save_png(path)
	get_tree().quit()
