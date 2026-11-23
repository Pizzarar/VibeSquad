extends PanelContainer
## F8 side chat. Plain and readable first (18 px base font x ui_scale); the only flourish is the header gradient + bug button.
## The owner of this node (vs_playtest.gd) drives polling; the dock only renders and emits.

signal bug_pressed
signal reply_submitted(text: String)
signal close_pressed
## B2b: owner typed a pairing code / pressed Unpair (vs_playtest.gd does the I/O).
signal pair_submitted(code: String)
signal unpair_pressed
## B2b: owner checked the fetched VS CA fingerprint against the VS Pair Device dialog (true = matches, false = cancel).
signal ca_confirmed(matches: bool)

const PAIR_HIDDEN := "hidden" # loopback server: the local token is used, nothing to pair
const PAIR_UNPAIRED := "unpaired"
const PAIR_PAIRED := "paired"
const PAIR_CONFIRM := "confirm" # fetched VS CA shown, waiting for the owner to compare fingerprints

const ROLE_WARNING := "Full owner token: re-pair with a Playtest code"
const BASE_FONT := 18
const BASE_WIDTH := 460.0
const BG := Color("14121c")
const FG := Color("ece8f6")
const MUTED := Color("b3accb")
const ME := Color("8fd3c7")
const THEM := Color("f2c879")

var ui_scale: float = 1.0
var _log: RichTextLabel
var _input: LineEdit
var _status: Label
var _title: Label
var _bug: Button
var _close: Button
var _send: Button
var _header: PanelContainer
var _pair_row: HBoxContainer
var _pair_code: LineEdit
var _pair_btn: Button
var _unpair_btn: Button
var _role_warn: Label
var _ca_box: VBoxContainer
var _ca_label: Label
var _ca_yes: Button
var _ca_no: Button
var pair_state: String = PAIR_HIDDEN


func _init() -> void:
	name = "VSPlaytestDock"
	mouse_filter = Control.MOUSE_FILTER_STOP
	var root := VBoxContainer.new()
	add_child(root)

	_header = PanelContainer.new()
	root.add_child(_header)
	var hrow := HBoxContainer.new()
	_header.add_child(hrow)
	_title = Label.new()
	_title.text = "VibeSquad Playtest"
	_title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_title.add_theme_color_override("font_color", Color.WHITE)
	hrow.add_child(_title)
	_bug = Button.new()
	_bug.text = "🐞 Report"
	_bug.tooltip_text = "Click-to-point bug report"
	_bug.pressed.connect(func() -> void: bug_pressed.emit())
	hrow.add_child(_bug)
	_close = Button.new()
	_close.text = "✕"
	_close.tooltip_text = "Close"
	_close.pressed.connect(func() -> void: close_pressed.emit())
	hrow.add_child(_close)

	_status = Label.new()
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_status.add_theme_color_override("font_color", MUTED)
	root.add_child(_status)

	# B2b pairing (remote server_url only): "Pair with VS" + 6-digit code, or "Unpair" once a device token is stored.
	_pair_row = HBoxContainer.new()
	root.add_child(_pair_row)
	_pair_code = LineEdit.new()
	_pair_code.placeholder_text = "6-digit code"
	_pair_code.max_length = 7
	_pair_code.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_pair_code.text_submitted.connect(_on_pair)
	_pair_row.add_child(_pair_code)
	_pair_btn = Button.new()
	_pair_btn.text = "Pair with VS"
	_pair_btn.tooltip_text = "Playtest pairing code"
	_pair_btn.pressed.connect(func() -> void: _on_pair(_pair_code.text))
	_pair_row.add_child(_pair_btn)
	_unpair_btn = Button.new()
	_unpair_btn.text = "Unpair"
	_unpair_btn.tooltip_text = "Delete this PC's device token file (also revoke the device in VibeSquad)"
	_unpair_btn.pressed.connect(func() -> void: unpair_pressed.emit())
	_pair_row.add_child(_unpair_btn)
	_role_warn = Label.new()
	_role_warn.text = ROLE_WARNING
	_role_warn.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_role_warn.add_theme_color_override("font_color", THEM)
	_role_warn.visible = false
	root.add_child(_role_warn)
	# B2b CA confirm (PLAN_V1 "Remote is https only"): the owner compares the fetched CA fingerprint with VS's pair dialog.
	_ca_box = VBoxContainer.new()
	root.add_child(_ca_box)
	_ca_label = Label.new()
	_ca_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_ca_box.add_child(_ca_label)
	var ca_row := HBoxContainer.new()
	_ca_box.add_child(ca_row)
	_ca_yes = Button.new()
	_ca_yes.text = "It matches: pair"
	_ca_yes.tooltip_text = "Trust this CA for this server only, then redeem the pairing code over https"
	_ca_yes.pressed.connect(func() -> void: ca_confirmed.emit(true))
	ca_row.add_child(_ca_yes)
	_ca_no = Button.new()
	_ca_no.text = "Cancel"
	_ca_no.pressed.connect(func() -> void: ca_confirmed.emit(false))
	ca_row.add_child(_ca_no)

	_log = RichTextLabel.new()
	_log.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_log.scroll_following = true
	_log.selection_enabled = true
	_log.focus_mode = Control.FOCUS_CLICK
	root.add_child(_log)

	var row := HBoxContainer.new()
	root.add_child(row)
	_input = LineEdit.new()
	_input.placeholder_text = "Reply to the Squad…"
	_input.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_input.text_submitted.connect(_on_submit)
	row.add_child(_input)
	_send = Button.new()
	_send.text = "Send"
	_send.pressed.connect(func() -> void: _on_submit(_input.text))
	row.add_child(_send)
	set_pairing(PAIR_HIDDEN)
	apply_scale(1.0)


func apply_scale(s: float) -> void:
	ui_scale = maxf(s, 0.5)
	var fs := int(round(BASE_FONT * ui_scale))
	var theme := Theme.new()
	theme.default_font_size = fs
	theme.set_font_size("normal_font_size", "RichTextLabel", fs)
	theme.set_font_size("bold_font_size", "RichTextLabel", fs)
	theme.set_color("default_color", "RichTextLabel", FG)
	theme.set_color("font_color", "Label", FG)
	theme.set_color("font_color", "LineEdit", FG)
	theme.set_color("font_placeholder_color", "LineEdit", MUTED)
	theme.set_color("font_color", "Button", FG)
	theme.set_stylebox("normal", "Button", _box(Color("2c2840"), Color("5b5480"), 1))
	theme.set_stylebox("hover", "Button", _box(Color("3a3556"), Color("8fd3c7"), 1))
	theme.set_stylebox("pressed", "Button", _box(Color("1f1c30"), Color("8fd3c7"), 2))
	theme.set_stylebox("normal", "LineEdit", _box(Color("0d0b14"), Color("5b5480"), 1))
	theme.set_stylebox("focus", "LineEdit", _box(Color("0d0b14"), Color("8fd3c7"), 2))
	theme.set_stylebox("normal", "RichTextLabel", _box(Color("0d0b14"), Color("2c2840"), 1))
	theme.set_stylebox("panel", "PanelContainer", _box(BG, Color("5b5480"), 2))
	self.theme = theme
	# header: dreamy teal->violet wash, plus a candy bug button (the two sanctioned Hypnospace touches)
	var g := Gradient.new()
	g.set_color(0, Color("1f6f78"))
	g.set_color(1, Color("4a2f86"))
	var gt := GradientTexture2D.new()
	gt.gradient = g
	gt.width = 256
	gt.height = 8
	gt.fill_from = Vector2(0, 0)
	gt.fill_to = Vector2(1, 0)
	var hb := StyleBoxTexture.new()
	hb.texture = gt
	for side in [SIDE_LEFT, SIDE_RIGHT]:
		hb.set_content_margin(side, 10 * ui_scale)
	for side in [SIDE_TOP, SIDE_BOTTOM]:
		hb.set_content_margin(side, 6 * ui_scale)
	_header.add_theme_stylebox_override("panel", hb)
	var bug_n := _box(Color("ffb3c7"), Color("ffffff"), 2)
	var bug_h := _box(Color("ffc9d8"), Color("ffffff"), 2)
	for b: StyleBoxFlat in [bug_n, bug_h]:
		b.set_content_margin_all(6 * ui_scale)
	_bug.add_theme_stylebox_override("normal", bug_n)
	_bug.add_theme_stylebox_override("hover", bug_h)
	_bug.add_theme_stylebox_override("pressed", bug_n)
	for c in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color"]:
		_bug.add_theme_color_override(c, Color("1a1020"))
	_title.add_theme_font_size_override("font_size", int(round(fs * 1.15)))
	custom_minimum_size = Vector2(BASE_WIDTH * ui_scale, 0)


func _box(bg: Color, border: Color, bw: int) -> StyleBoxFlat:
	var b := StyleBoxFlat.new()
	b.bg_color = bg
	b.border_color = border
	b.set_border_width_all(bw)
	b.set_corner_radius_all(int(4 * ui_scale))
	b.set_content_margin_all(6 * ui_scale)
	return b


## Places the dock flush right, full height, inside a viewport of `vp` pixels.
func layout(vp: Vector2) -> void:
	var w := BASE_WIDTH * ui_scale
	size = Vector2(w, vp.y)
	position = Vector2(vp.x - w, 0)


func set_status(text: String) -> void:
	_status.text = text
	_status.visible = text != ""


func focus_input() -> void:
	_input.grab_focus()


func clear_messages() -> void:
	_log.clear()


## message: {role: "user"|"assistant", text, ...}; "user" lines are the owner's own.
func append_message(message: Dictionary) -> void:
	var mine := str(message.get("role", "assistant")) == "user"
	_log.push_color(ME if mine else THEM)
	_log.push_bold()
	_log.add_text("You" if mine else "Squad")
	_log.pop()
	_log.pop()
	_log.add_text("\n" + str(message.get("text", "")).strip_edges() + "\n\n")


func append_note(text: String) -> void:
	_log.push_color(MUTED)
	_log.add_text(text + "\n\n")
	_log.pop()


func _on_submit(text: String) -> void:
	var t := text.strip_edges()
	if t == "":
		return
	_input.clear()
	reply_submitted.emit(t)


## mode: PAIR_HIDDEN | PAIR_UNPAIRED (code box + Pair with VS) | PAIR_CONFIRM (CA fingerprint + It matches / Cancel)
## | PAIR_PAIRED (Unpair only).
func set_pairing(mode: String) -> void:
	pair_state = mode
	_ca_box.visible = mode == PAIR_CONFIRM
	_pair_row.visible = mode == PAIR_UNPAIRED or mode == PAIR_PAIRED
	_pair_code.visible = mode == PAIR_UNPAIRED
	_pair_btn.visible = mode == PAIR_UNPAIRED
	_unpair_btn.visible = mode == PAIR_PAIRED
	if mode != PAIR_PAIRED:
		_role_warn.visible = false


## One line under the pair row while this device holds a full-owner token (not the least-privilege owner-playtest one).
func set_owner_warning(show_it: bool) -> void:
	_role_warn.visible = show_it


## Shows the fetched CA's fingerprint ({full, short}, server/auth.mjs caFingerprint format) for the owner to compare.
func show_ca_fingerprint(fp: Dictionary) -> void:
	_ca_label.text = "\n".join(PackedStringArray([
		"VibeSquad CA fingerprint (SHA-256), fetched over plain http:",
		str(fp.get("short", "")),
		"Full: " + str(fp.get("full", "")),
		"Does it match the fingerprint in VibeSquad's Pair Device dialog? Press \"It matches\" only if every pair is the same.",
	]))
	set_pairing(PAIR_CONFIRM)


func set_pair_busy(busy: bool) -> void:
	_pair_btn.disabled = busy
	_ca_yes.disabled = busy
	_pair_code.editable = not busy


func _on_pair(code: String) -> void:
	var c := code.strip_edges()
	if c == "" or _pair_btn.disabled:
		return
	_pair_code.clear()
	pair_submitted.emit(c)
