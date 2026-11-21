extends Node
## VSPlaytest autoload (registered by plugin.gd). Active only in the editor or in builds carrying the `vs_playtest`
## feature tag; otherwise it creates nothing and does no I/O (`enabled == false`).
## No class_name on purpose: the autoload singleton already owns the global name VSPlaytest.

signal report_sent(card_id: String)
signal reply_received(message: Dictionary)

const Settings := preload("res://addons/vs_playtest/settings.gd")
const Token := preload("res://addons/vs_playtest/token.gd")
const Payload := preload("res://addons/vs_playtest/payload.gd")
const Transport := preload("res://addons/vs_playtest/transport.gd")
const ReportClient := preload("res://addons/vs_playtest/report_client.gd")
const LogCapture := preload("res://addons/vs_playtest/log_capture.gd")
const Picker := preload("res://addons/vs_playtest/picker.gd")
const Dock := preload("res://addons/vs_playtest/dock.gd")
const Overlay := preload("res://addons/vs_playtest/overlay.gd")

const POLL_SEC := 3.0
const SCREENSHOT_PNG_MAX := 6 * 1024 * 1024 # server cap is 8 MB decoded; fall back to JPEG above this

var enabled: bool = false
## Test seam: replace before add_child() to simulate feature tags.
var feature_probe: Callable = Callable()
var ui_scale: float = 1.0

var _adapter: VSPlaytestAdapter = null
var _transport: Node
var _client: RefCounted
var _logs: RefCounted
var _dock: Control
var _overlay: Control
var _layer: CanvasLayer
var _layer_overlay: CanvasLayer
var _timer: Timer
var _team_id := ""
var _hotkey_dock: Key = KEY_F8
var _hotkey_bug: Key = KEY_F9
var _cursor := ""
var _seen: Dictionary = {}
var _first_poll_done := false
var _polling := false
var _capturing := false


static func gate(has_editor: bool, has_tag: bool) -> bool:
	return has_editor or has_tag


func _ready() -> void:
	var probe: Callable = feature_probe if feature_probe.is_valid() else Callable(OS, "has_feature")
	enabled = gate(bool(probe.call("editor")), bool(probe.call("vs_playtest")))
	if not enabled:
		set_process_input(false)
		return
	_team_id = Settings.get_str(Settings.TEAM_ID)
	_hotkey_dock = _key(Settings.get_str(Settings.HOTKEY_DOCK), KEY_F8)
	_hotkey_bug = _key(Settings.get_str(Settings.HOTKEY_BUG), KEY_F9)
	process_mode = Node.PROCESS_MODE_ALWAYS
	ui_scale = _detect_scale()

	_logs = LogCapture.new()
	_logs.install()
	_transport = Transport.new()
	_transport.server_url = Token.server_url(Settings.get_str(Settings.SERVER_URL))
	add_child(_transport)
	_client = ReportClient.new(_transport)
	_client.sleep_fn = func(sec: float) -> void: await get_tree().create_timer(sec).timeout

	_layer = CanvasLayer.new()
	_layer.layer = 100
	_layer.add_to_group(Picker.UI_GROUP)
	add_child(_layer)
	_dock = Dock.new()
	_dock.visible = false
	_layer.add_child(_dock)
	_dock.bug_pressed.connect(start_capture)
	_dock.close_pressed.connect(close_dock)
	_dock.reply_submitted.connect(_on_reply)
	_layer_overlay = CanvasLayer.new()
	_layer_overlay.layer = 110
	_layer_overlay.add_to_group(Picker.UI_GROUP)
	add_child(_layer_overlay)
	_overlay = Overlay.new()
	_layer_overlay.add_child(_overlay)
	_timer = Timer.new()
	_timer.wait_time = POLL_SEC
	_timer.one_shot = false
	_timer.timeout.connect(_poll)
	add_child(_timer)
	get_tree().root.size_changed.connect(_relayout)
	set_ui_scale(ui_scale)
	if _team_id == "":
		_dock.set_status("Set the project setting vs_playtest/team_id to the Squad that should get reports.")


# ---------------------------------------------------------------- public API

func register_adapter(adapter: VSPlaytestAdapter) -> void:
	_adapter = adapter


func has_adapter() -> bool:
	return _adapter != null


## Owner/agent helpers (reached through the bridge). Safe no-ops when disabled or without an adapter.
func state() -> Dictionary:
	return Payload.json_safe(_adapter.get_state()) if enabled and _adapter != null else {}


func seed() -> String:
	return _adapter.get_seed() if enabled and _adapter != null else ""


func cheats() -> Array:
	return _adapter.get_cheats() if enabled and _adapter != null else []


func cheat(id: String, args: Array = []) -> Variant:
	return _adapter.run_cheat(id, args) if enabled and _adapter != null else null


func open_dock() -> void:
	if not enabled or _dock == null:
		return
	_dock.visible = true
	_relayout()
	_dock.focus_input()
	_timer.start()
	_poll()


func close_dock() -> void:
	if not enabled or _dock == null:
		return
	_dock.visible = false
	_timer.stop()


func toggle_dock() -> void:
	if _dock != null and _dock.visible:
		close_dock()
	else:
		open_dock()


func set_ui_scale(s: float) -> void:
	ui_scale = clampf(s, 0.75, 4.0)
	if _dock != null:
		_dock.apply_scale(ui_scale)
		_overlay.apply_scale(ui_scale)
		_relayout()


## Click-to-point capture -> note -> screenshot already taken -> report (retried with one clientReportId).
func start_capture() -> void:
	if not enabled or _capturing:
		return
	_capturing = true
	var dock_was_open := _dock.visible
	_overlay.begin_pick()
	var pick: Array = await _overlay.pick_done
	if not bool(pick[0]):
		_overlay.hide_all()
		_capturing = false
		return
	var point: Vector2 = pick[1]
	var has_point := point.x >= 0.0
	var node: Node = Picker.pick(get_tree(), point) if has_point else null
	# clean screenshot: hide our UI for two frames
	_overlay.visible = false
	_dock.visible = false
	await get_tree().process_frame
	await RenderingServer.frame_post_draw
	var img: Image = get_tree().root.get_texture().get_image()
	var shot := _encode(img, point if has_point else null)
	_dock.visible = dock_was_open
	_overlay.begin_note(point if has_point else null)
	var note: Array = await _overlay.note_done
	_overlay.hide_all()
	if not bool(note[0]):
		_capturing = false
		return
	var body := Payload.build(_team_id, str(note[1]), Payload.new_uuid(), shot, _telemetry(node, point if has_point else null))
	_dock.set_status("Sending report…")
	var res: Dictionary = await _client.send_report(body)
	if bool(res.get("ok", false)):
		var card_id := str(res.get("data", {}).get("cardId", ""))
		_dock.set_status("Report sent (%s)." % card_id)
		_dock.append_message({"role": "user", "text": "[report %s] %s" % [card_id, body["text"]]})
		report_sent.emit(card_id)
		if _dock.visible:
			_poll()
	else:
		_dock.set_status("Report failed after %d tries: %s" % [int(res.get("attempts", 1)), str(res.get("error", "?"))])
	_capturing = false


# ---------------------------------------------------------------- internals

func _telemetry(node: Node, point: Variant) -> Dictionary:
	var vp := get_tree().root.get_visible_rect().size
	var scene := get_tree().current_scene
	var info: Dictionary = _adapter.get_info() if _adapter != null else {}
	var t := {
		"viewport": {"w": vp.x, "h": vp.y},
		"scene": scene.scene_file_path if scene != null and scene.scene_file_path != "" else (str(scene.name) if scene != null else ""),
		"state": _adapter.get_state() if _adapter != null else {},
		"seed": _adapter.get_seed() if _adapter != null else "",
		"adapter": info,
		"buildHash": _adapter.get_build_hash() if _adapter != null else str(ProjectSettings.get_setting("application/config/version", "")),
		"engine": Engine.get_version_info().get("string", ""),
		"platform": OS.get_name(),
		"logLines": _logs.last_lines(Payload.LOG_LINES_MAX),
	}
	if point is Vector2:
		t["clickedPoint"] = {"x": (point as Vector2).x, "y": (point as Vector2).y}
	if node != null:
		t["cursorNode"] = _adapter.describe_node(node) if _adapter != null else (str(node.get_path()) if node.is_inside_tree() else str(node.name))
	return t


## PNG (JPEG when PNG > 6 MB) of the viewport with a ring drawn at the clicked point.
func _encode(img: Image, point: Variant) -> Dictionary:
	if img == null or img.is_empty():
		return {}
	if point is Vector2:
		_mark(img, point as Vector2, int(18 * ui_scale))
	var png := img.save_png_to_buffer()
	if png.size() > 0 and png.size() <= SCREENSHOT_PNG_MAX:
		return {"bytes": png, "mime": "image/png"}
	var jpg := img.save_jpg_to_buffer(0.85)
	return {"bytes": jpg, "mime": "image/jpeg"} if jpg.size() > 0 else {}


func _mark(img: Image, p: Vector2, r: int) -> void:
	var col := Color("ff3b6b")
	var w := maxi(2, r / 5)
	for dy in range(-r - w, r + w + 1):
		for dx in range(-r - w, r + w + 1):
			var d := sqrt(float(dx * dx + dy * dy))
			if d >= r - w and d <= r + w:
				var x := int(p.x) + dx
				var y := int(p.y) + dy
				if x >= 0 and y >= 0 and x < img.get_width() and y < img.get_height():
					img.set_pixel(x, y, col)


func _input(event: InputEvent) -> void:
	if not enabled or not (event is InputEventKey):
		return
	var k := event as InputEventKey
	if not k.pressed or k.echo:
		return
	if k.keycode == _hotkey_dock:
		get_viewport().set_input_as_handled()
		toggle_dock()
	elif k.keycode == _hotkey_bug:
		get_viewport().set_input_as_handled()
		start_capture()


func _key(name_: String, fallback: Key) -> Key:
	var k := OS.find_keycode_from_string(name_)
	return k if k != KEY_NONE else fallback


func _detect_scale() -> float:
	var env := OS.get_environment("VS_PLAYTEST_UI_SCALE")
	if env.is_valid_float() and float(env) > 0.0:
		return float(env)
	return clampf(float(DisplayServer.screen_get_dpi()) / 96.0, 1.0, 3.0)


func _relayout() -> void:
	if _dock != null:
		_dock.layout(get_tree().root.get_visible_rect().size)


func _on_reply(text: String) -> void:
	if _team_id == "":
		_dock.set_status("Set vs_playtest/team_id first.")
		return
	_dock.append_message({"role": "user", "text": text})
	var res: Dictionary = await _client.post_reply(_team_id, text)
	if not bool(res.get("ok", false)):
		_dock.set_status("Reply not delivered: %s" % str(res.get("error", "?")))
	else:
		_dock.set_status("")
		_poll()


func _poll() -> void:
	if _polling or _team_id == "" or not _dock.visible:
		return
	_polling = true
	var res: Dictionary = await _client.fetch_thread(_team_id, _cursor)
	_polling = false
	if not bool(res.get("ok", false)):
		_dock.set_status("Can't reach VibeSquad: %s" % str(res.get("error", "?")))
		return
	var data: Dictionary = res.get("data", {})
	if data.get("agent") == null:
		_dock.set_status("No live intake agent for this Squad yet; reports are parked in the inbox.")
	elif _dock.visible:
		_dock.set_status("")
	var fresh: Array = []
	for m: Variant in data.get("messages", []):
		if m is Dictionary and not _seen.has(str((m as Dictionary).get("id", ""))):
			_seen[str((m as Dictionary).get("id", ""))] = true
			fresh.append(m)
	var cur: Variant = data.get("cursor")
	if cur is String and cur != "":
		_cursor = cur
	for m: Dictionary in fresh:
		# our own replies/reports were already echoed locally; show only the Squad's lines (and the owner's from elsewhere on first load)
		if str(m.get("role", "")) == "assistant" or not _first_poll_done:
			var shown: Dictionary = m.duplicate()
			shown["text"] = Payload.strip_owner_prefix(str(m.get("text", "")))
			_dock.append_message(shown)
		if str(m.get("role", "")) == "assistant" and _first_poll_done:
			reply_received.emit(m)
	_first_poll_done = true
