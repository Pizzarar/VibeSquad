extends Control
## Full-viewport click-to-point layer for the 🐞 capture, then a small note prompt.
## begin_pick() -> emits pick_done(ok, point); begin_note() -> emits note_done(ok, text).

signal pick_done(ok: bool, point: Vector2)
signal note_done(ok: bool, text: String)

enum Mode { OFF, PICK, NOTE }

var ui_scale: float = 1.0
var mode: Mode = Mode.OFF
var _mouse := Vector2.ZERO
var _hint: Label
var _note_panel: PanelContainer
var _note: LineEdit
var _marker: Variant = null # Vector2 marked while the note prompt is up


func _init() -> void:
	name = "VSPlaytestOverlay"
	set_anchors_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	mouse_default_cursor_shape = Control.CURSOR_CROSS
	visible = false
	_hint = Label.new()
	_hint.text = "Click what looks wrong   ·   Enter: no pointing   ·   Esc: cancel"
	_hint.position = Vector2(24, 24)
	add_child(_hint)
	_note_panel = PanelContainer.new()
	_note_panel.visible = false
	add_child(_note_panel)
	var col := VBoxContainer.new()
	_note_panel.add_child(col)
	var l := Label.new()
	l.text = "What went wrong? (optional)   Enter: send   Esc: cancel"
	col.add_child(l)
	_note = LineEdit.new()
	_note.placeholder_text = "Note…"
	_note.text_submitted.connect(func(t: String) -> void: _finish_note(true, t))
	col.add_child(_note)
	apply_scale(1.0)


func apply_scale(s: float) -> void:
	ui_scale = maxf(s, 0.5)
	var fs := int(round(18 * ui_scale))
	var th := Theme.new()
	th.default_font_size = fs
	th.set_color("font_color", "Label", Color("ffffff"))
	th.set_color("font_color", "LineEdit", Color("ece8f6"))
	var box := StyleBoxFlat.new()
	box.bg_color = Color("14121c")
	box.border_color = Color("ffb3c7")
	box.set_border_width_all(2)
	box.set_content_margin_all(10 * ui_scale)
	th.set_stylebox("panel", "PanelContainer", box)
	var hint_box := box.duplicate() as StyleBoxFlat
	th.set_stylebox("normal", "LineEdit", hint_box)
	theme = th
	_hint.position = Vector2(24, 24) * ui_scale
	_hint.add_theme_stylebox_override("normal", box)
	_note_panel.custom_minimum_size = Vector2(620 * ui_scale, 0)


func begin_pick() -> void:
	mode = Mode.PICK
	_marker = null
	_note_panel.visible = false
	_hint.visible = true
	visible = true
	_mouse = get_viewport().get_mouse_position()
	queue_redraw()


## Called once the screenshot is done; keeps a marker on the clicked point.
func begin_note(point: Variant) -> void:
	mode = Mode.NOTE
	_marker = point
	_hint.visible = false
	_note.clear()
	_note_panel.visible = true
	var vp := get_viewport_rect().size
	_note_panel.reset_size()
	_note_panel.position = Vector2((vp.x - _note_panel.custom_minimum_size.x) / 2.0, vp.y - 140 * ui_scale)
	visible = true
	_note.grab_focus()
	queue_redraw()


func hide_all() -> void:
	mode = Mode.OFF
	visible = false
	_note_panel.visible = false


func _gui_input(event: InputEvent) -> void:
	if mode != Mode.PICK:
		return
	if event is InputEventMouseMotion:
		_mouse = (event as InputEventMouseMotion).position
		queue_redraw()
	elif event is InputEventMouseButton and (event as InputEventMouseButton).pressed and (event as InputEventMouseButton).button_index == MOUSE_BUTTON_LEFT:
		accept_event()
		mode = Mode.OFF
		pick_done.emit(true, (event as InputEventMouseButton).position)


func _input(event: InputEvent) -> void:
	if mode == Mode.OFF or not (event is InputEventKey) or not (event as InputEventKey).pressed:
		return
	var k := (event as InputEventKey).keycode
	if k == KEY_ESCAPE:
		get_viewport().set_input_as_handled()
		if mode == Mode.PICK:
			mode = Mode.OFF
			pick_done.emit(false, Vector2.ZERO)
		else:
			_finish_note(false, "")
	elif k == KEY_ENTER and mode == Mode.PICK:
		get_viewport().set_input_as_handled()
		mode = Mode.OFF
		pick_done.emit(true, Vector2(-1, -1)) # no point


func _finish_note(ok: bool, text: String) -> void:
	mode = Mode.OFF
	note_done.emit(ok, text)


func _draw() -> void:
	var s := get_viewport_rect().size
	draw_rect(Rect2(Vector2.ZERO, s), Color(0.05, 0.03, 0.1, 0.28))
	var c := Color("ffb3c7")
	if mode == Mode.PICK:
		draw_line(Vector2(_mouse.x, 0), Vector2(_mouse.x, s.y), c, 1.0 * ui_scale)
		draw_line(Vector2(0, _mouse.y), Vector2(s.x, _mouse.y), c, 1.0 * ui_scale)
		draw_arc(_mouse, 18 * ui_scale, 0, TAU, 40, c, 3.0 * ui_scale)
	elif _marker is Vector2 and (_marker as Vector2).x >= 0:
		draw_arc(_marker, 18 * ui_scale, 0, TAU, 40, c, 3.0 * ui_scale)
