extends SceneTree
## Headless tests: godot --headless --path godot -s tests/run_tests.gd   (run `--import` once first on a fresh checkout)
## Exit code = number of failed checks.

const Token := preload("res://addons/vs_playtest/token.gd")
const Payload := preload("res://addons/vs_playtest/payload.gd")
const ReportClient := preload("res://addons/vs_playtest/report_client.gd")
const AutoloadScript := preload("res://addons/vs_playtest/vs_playtest.gd")
const Picker := preload("res://addons/vs_playtest/picker.gd")
const Export := preload("res://addons/vs_playtest/export_plugin.gd")

var _pass := 0
var _fail := 0


class MockTransport extends RefCounted:
	var queue: Array = []
	var calls: Array = []
	func request(method: String, path: String, body: Variant = null) -> Dictionary:
		calls.append({"method": method, "path": path, "body": body})
		return queue.pop_front() if not queue.is_empty() else {"ok": true, "status": 200, "data": {}, "error": ""}


class FullAdapter extends VSPlaytestAdapter:
	func get_info() -> Dictionary: return {"name": "t", "version": "1"}
	func get_state() -> Dictionary: return {"hp": 3}
	func get_seed() -> String: return "s1"
	func get_cheats() -> Array[Dictionary]: return [{"id": "god", "label": "God mode"}]
	func run_cheat(id: String, args: Array) -> Variant: return [id, args]


func _initialize() -> void:
	await _test_adapter_defaults()
	_test_json_safe_and_cap()
	_test_payload_shape()
	_test_token()
	_test_gate()
	await _test_retry()
	await _test_autoload_disabled_and_forwarding()
	_test_loopback_strict()
	_test_ring_math()
	await _test_picker()
	await _test_capture_flow()
	_test_export_helpers()
	print("---- vs_playtest tests: %d passed, %d failed" % [_pass, _fail])
	quit(_fail)


func check(cond: bool, label: String) -> void:
	if cond:
		_pass += 1
		print("ok   ", label)
	else:
		_fail += 1
		print("FAIL ", label)


func _test_adapter_defaults() -> void:
	var a := VSPlaytestAdapter.new()
	check(a.get_info() == {"name": "", "version": ""}, "adapter: default get_info")
	check(a.get_state() == {}, "adapter: default get_state")
	check(a.get_seed() == "", "adapter: default get_seed")
	check(a.get_build_hash() == String(ProjectSettings.get_setting("application/config/version", "")) and a.get_build_hash() == "sample-0.1.0", "adapter: build hash defaults to config/version")
	check(a.get_cheats().is_empty(), "adapter: default cheats empty")
	check(a.run_cheat("x", []) == null, "adapter: default run_cheat null")
	var n := Node.new()
	n.name = "Lonely"
	check(a.describe_node(n) == "Lonely", "adapter: describe_node off-tree uses name")
	root.add_child(n)
	await process_frame
	check(a.describe_node(n) == str(n.get_path()), "adapter: describe_node default = get_path()")
	n.queue_free()


func _test_json_safe_and_cap() -> void:
	var safe: Variant = Payload.json_safe({"v": Vector2(1, 2), "c": Color.RED, "p": NodePath("A/B"), 3: [Vector3(1, 2, 3)], "inf": INF})
	check(JSON.stringify(safe) != "", "payload: json_safe stringifies Godot types")
	check(safe["v"] == {"x": 1.0, "y": 2.0} and safe["3"][0]["z"] == 3.0 and safe["inf"] == "inf", "payload: json_safe maps vectors / int keys / non-finite floats")
	var small: Variant = Payload.cap_state({"a": 1})
	check(small is Dictionary and small["a"] == 1, "state: small state passes through untouched")
	var big := {"blob": "é".repeat(80000)}
	var capped: Variant = Payload.cap_state(big)
	check(capped is String, "state: oversize becomes a truncated string")
	check((capped as String).to_utf8_buffer().size() <= 65536, "state: truncated result <= 64 KB (%d bytes)" % (capped as String).to_utf8_buffer().size())
	check((capped as String).ends_with(Payload.TRUNC_MARKER), "state: truncation marker present")
	check((capped as String).find("\ufffd") == -1, "state: no split multibyte char")


func _test_payload_shape() -> void:
	var tel := {
		"clickedPoint": Vector2(10, 20), "viewport": {"w": 1280, "h": 720}, "cursorNode": "/root/Main/Btn", "scene": "res://sample/main.tscn",
		"state": {"coins": 1}, "seed": "abc", "adapter": {"name": "sample", "version": "0.1"}, "buildHash": "h", "engine": "4.7.2", "platform": "Windows",
		"logLines": range(250).map(func(i: int) -> String: return "line %d" % i), "junk": "dropped",
	}
	tel["clickedPoint"] = {"x": 10, "y": 20}
	var body := Payload.build("sample", "  it broke ", "cid-1", {"bytes": PackedByteArray([0x89, 0x50, 0x4e, 0x47]), "mime": "image/png"}, tel)
	var keys := body.keys()
	keys.sort()
	check(keys == ["clientReportId", "screenshotBase64", "screenshotMime", "teamId", "telemetry", "text"], "payload: exact top-level keys")
	check(body["teamId"] == "sample" and body["text"] == "it broke" and body["clientReportId"] == "cid-1", "payload: teamId/text/clientReportId")
	check(body["screenshotMime"] == "image/png" and body["screenshotBase64"] == "iVBORw==", "payload: screenshot base64 + mime")
	var tk: Array = body["telemetry"].keys()
	tk.sort()
	check(tk == ["adapter", "buildHash", "clickedPoint", "cursorNode", "engine", "logLines", "platform", "scene", "seed", "state", "viewport"], "payload: exact telemetry keys (junk dropped)")
	check(body["telemetry"]["logLines"].size() == 200 and body["telemetry"]["logLines"][199] == "line 249", "payload: logLines = last 200")
	var bare := Payload.build("t", "", "cid-2", {}, {})
	check(not bare.has("screenshotBase64") and bare["text"] == Payload.DEFAULT_TEXT and bare["telemetry"] == {}, "payload: no screenshot keys when none; default text when note empty")
	check(JSON.parse_string(JSON.stringify(body)) is Dictionary, "payload: round-trips as JSON")
	check(Payload.strip_owner_prefix("[Owner playtest · card:idea-12] hi there") == "hi there" and Payload.strip_owner_prefix("[Owner playtest] yo") == "yo" and Payload.strip_owner_prefix("plain") == "plain", "payload: owner chat prefix stripped for display")
	var id := Payload.new_uuid()
	var parts := id.split("-")
	check(parts.size() == 5 and id.length() == 36 and id[14] == "4" and id != Payload.new_uuid(), "payload: uuid v4 shape, unique")


func _test_token() -> void:
	var env := {"VIBESQUAD_HOME": "/tmp/vsh"}
	check(Token.token_path(func(k: String) -> String: return env.get(k, "")) == "/tmp/vsh/local-token", "token: $VIBESQUAD_HOME wins")
	var win := {"USERPROFILE": "C:/Users/x"}
	check(Token.token_path(func(k: String) -> String: return win.get(k, "")) == "C:/Users/x/.vibesquad/local-token", "token: Windows home fallback")
	var nix := {"HOME": "/home/x"}
	check(Token.token_path(func(k: String) -> String: return nix.get(k, "")) == "/home/x/.vibesquad/local-token", "token: HOME fallback")
	var dir := OS.get_temp_dir().path_join("vsp_token_test_%d" % Time.get_ticks_usec())
	DirAccess.make_dir_recursive_absolute(dir)
	var good := "0123456789abcdef".repeat(4)
	for case in [["good", good + "\n", good], ["short", "abc", ""], ["upper", good.to_upper(), ""], ["nonhex", "z".repeat(64), ""]]:
		var p: String = dir.path_join(case[0])
		var f := FileAccess.open(p, FileAccess.WRITE)
		f.store_string(case[1])
		f.close()
		check(Token.read_token(p) == case[2], "token: read_token %s" % case[0])
		DirAccess.remove_absolute(p)
	check(Token.read_token(dir.path_join("missing")) == "", "token: missing file -> empty")
	DirAccess.remove_absolute(dir)
	check(Token.server_url("", func(k: String) -> String: return "") == "http://127.0.0.1:4180", "server_url: default 4180")
	check(Token.server_url("", func(k: String) -> String: return "5555" if k == "VIBESQUAD_PORT" else "") == "http://127.0.0.1:5555", "server_url: $VIBESQUAD_PORT")
	check(Token.server_url("http://127.0.0.1:9/", func(k: String) -> String: return "5555") == "http://127.0.0.1:9", "server_url: explicit setting wins, slash trimmed")
	check(Token.is_loopback("http://127.0.0.1:4180") and Token.is_loopback("http://localhost") and not Token.is_loopback("http://127.0.0.1.evil.com") and not Token.is_loopback("https://example.com"), "token: loopback-only guard")


func _test_gate() -> void:
	check(AutoloadScript.gate(true, false) and AutoloadScript.gate(false, true) and AutoloadScript.gate(true, true) and not AutoloadScript.gate(false, false), "gate: editor or vs_playtest tag only")


func _test_retry() -> void:
	var m := MockTransport.new()
	m.queue = [
		{"ok": false, "status": 0, "data": {}, "error": "net"},
		{"ok": false, "status": 503, "data": {}, "error": "busy"},
		{"ok": true, "status": 200, "data": {"ok": true, "cardId": "idea-9"}, "error": ""},
	]
	var c := ReportClient.new(m)
	var sleeps: Array = []
	c.sleep_fn = func(s: float) -> void: sleeps.append(s)
	var body := Payload.build("sample", "x", Payload.new_uuid(), {}, {})
	var res: Dictionary = await c.send_report(body)
	check(res["ok"] and res["attempts"] == 3 and res["data"]["cardId"] == "idea-9", "retry: succeeds on 3rd attempt")
	check(m.calls.size() == 3 and m.calls[0]["body"]["clientReportId"] == m.calls[1]["body"]["clientReportId"] and m.calls[1]["body"]["clientReportId"] == m.calls[2]["body"]["clientReportId"] and m.calls[0]["body"]["clientReportId"] == body["clientReportId"], "retry: same clientReportId on every attempt")
	check(sleeps == [1.0, 2.0], "retry: backoff 1s, 2s")
	check(m.calls[0]["method"] == "POST" and m.calls[0]["path"] == "/__vibesquad/tester/report", "retry: POST /__vibesquad/tester/report")
	var m2 := MockTransport.new()
	m2.queue = [{"ok": false, "status": 400, "data": {}, "error": "bad"}]
	var c2 := ReportClient.new(m2)
	var r2: Dictionary = await c2.send_report(body)
	check(not r2["ok"] and m2.calls.size() == 1, "retry: 4xx is not retried")
	var m3 := MockTransport.new()
	m3.queue = [{"ok": false, "status": -1, "data": {}, "error": "no token"}]
	var r3: Dictionary = await ReportClient.new(m3).send_report(body)
	check(m3.calls.size() == 1 and not r3["ok"], "retry: local refusal (-1) is not retried")
	var m4 := MockTransport.new()
	for i in 10:
		m4.queue.append({"ok": false, "status": 500, "data": {}, "error": "x"})
	var c4 := ReportClient.new(m4)
	var r4: Dictionary = await c4.send_report(body)
	check(m4.calls.size() == c4.max_attempts and r4["attempts"] == 5, "retry: gives up after max_attempts")
	await c4.fetch_thread("sample", "agent:12", 25)
	await c4.post_reply("sample", "hi", "idea-9")
	check(m4.calls[-2]["path"] == "/__vibesquad/tester/thread?teamId=sample&limit=25&after=agent%3A12" and m4.calls[-2]["method"] == "GET", "thread: GET ?after= cursor")
	check(m4.calls[-1]["body"] == {"teamId": "sample", "text": "hi", "cardId": "idea-9"}, "thread: POST reply body")


func _test_autoload_disabled_and_forwarding() -> void:
	var off: Node = AutoloadScript.new()
	off.feature_probe = func(_f: String) -> bool: return false
	root.add_child(off)
	await process_frame
	check(off.enabled == false and off.get_child_count() == 0, "autoload: disabled -> enabled=false, zero child nodes")
	check(off.state() == {} and off.cheats() == [] and off.cheat("x") == null and off.seed() == "", "autoload: disabled helpers are inert")
	off.queue_free()
	var on: Node = AutoloadScript.new()
	on.feature_probe = func(f: String) -> bool: return f == "vs_playtest"
	root.add_child(on)
	await process_frame
	check(on.enabled == true and on.get_child_count() > 0, "autoload: vs_playtest tag -> enabled with nodes")
	on.register_adapter(FullAdapter.new())
	check(on.state() == {"hp": 3} and on.seed() == "s1" and on.cheats().size() == 1 and on.cheat("god", [1]) == ["god", [1]], "autoload: state/seed/cheats/cheat forward to adapter")
	var got: Array = []
	on.report_sent.connect(func(id: String) -> void: got.append(id))
	on.report_sent.emit("idea-1")
	check(got == ["idea-1"], "autoload: report_sent signal")
	on.queue_free()


func _test_loopback_strict() -> void:
	for u in ["http://127.0.0.1", "http://127.0.0.1:4180", "http://127.0.0.1:1/", "http://127.0.0.1:65535", "http://localhost:4180/x/y", "http://[::1]:4180", "http://LOCALHOST:4180", "HTTP://127.0.0.1:80"]:
		check(Token.is_loopback(u), "loopback: accepts %s" % u)
	for u in ["http://127.0.0.1:4180@evil.com", "http://127.0.0.1@evil.com", "http://localhost:80@evil.com/", "http://user:pw@127.0.0.1:4180", "http://127.0.0.1.evil.com", "http://localhost.evil.com",
			"http://localhost.", "http://127.0.0.1.", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:99999", "http://127.0.0.1:", "http://127.0.0.1:abc",
			"https://127.0.0.1:4180", "ftp://127.0.0.1", "file://127.0.0.1", "//127.0.0.1", "127.0.0.1", "", "http://127.0.0.1:4180?x=1", "http://127.0.0.1:4180#f", "http://127.0.0.1\\@evil.com",
			"http://127.0.0.1:4180/a@evil.com", "http://0.0.0.0:4180", "http://127.0.0.2", "http://[::1", "http://evil.com/http://127.0.0.1"]:
		check(not Token.is_loopback(u), "loopback: refuses '%s'" % u)


func _test_ring_math() -> void:
	check(Payload.point_to_image(Vector2(100, 50), Vector2(1280, 720), Vector2(3840, 2160)) == Vector2(300, 150), "ring: canvas_items 1280x720 -> 3840x2160 triples the point")
	check(Payload.point_to_image(Vector2(100, 50), Vector2(1920, 1080), Vector2(1920, 1080)) == Vector2(100, 50), "ring: identity when sizes match")
	check(Payload.point_to_image(Vector2(10, 10), Vector2.ZERO, Vector2(100, 100)) == Vector2(10, 10), "ring: zero viewport guarded")


func _add_control(parent: Node, pos: Vector2, sz: Vector2, filter: int = Control.MOUSE_FILTER_STOP) -> Control:
	var c := Control.new()
	c.position = pos
	c.size = sz
	c.mouse_filter = filter as Control.MouseFilter
	parent.add_child(c)
	return c


func _sprite(pos: Vector2, z: int) -> Sprite2D:
	var s := Sprite2D.new()
	s.texture = ImageTexture.create_from_image(Image.create_empty(40, 40, false, Image.FORMAT_RGBA8))
	s.position = pos
	s.z_index = z
	root.add_child(s)
	return s


func _test_picker() -> void:
	var holder := Node.new()
	root.add_child(holder)
	# Control: topmost wins, IGNORE skipped, outside -> not that control
	var a := _add_control(holder, Vector2(10, 10), Vector2(200, 100))
	var b := _add_control(holder, Vector2(10, 10), Vector2(200, 100))
	check(Picker.pick_in(root, Vector2(50, 50)) == b, "pick/control: later sibling (drawn on top) wins")
	b.mouse_filter = Control.MOUSE_FILTER_IGNORE
	check(Picker.pick_in(root, Vector2(50, 50)) == a, "pick/control: MOUSE_FILTER_IGNORE is skipped")
	b.mouse_filter = Control.MOUSE_FILTER_STOP
	b.visible = false
	check(Picker.pick_in(root, Vector2(50, 50)) == a, "pick/control: hidden control skipped")
	b.visible = true
	check(Picker.pick_in(root, Vector2(900, 900)) == null, "pick/control: miss returns null")
	# hidden CanvasLayer must not intercept
	var layer := CanvasLayer.new()
	holder.add_child(layer)
	var hud := _add_control(layer, Vector2(0, 0), Vector2(1000, 1000))
	check(Picker.pick_in(root, Vector2(50, 50)) == hud, "pick/layer: visible CanvasLayer control is on top")
	layer.visible = false
	check(Picker.pick_in(root, Vector2(50, 50)) == b, "pick/layer: hidden CanvasLayer is skipped")
	layer.visible = true
	# nested SubViewport content is another coordinate space: skipped
	hud.queue_free()
	layer.queue_free()
	await process_frame
	var sv := SubViewport.new()
	holder.add_child(sv)
	_add_control(sv, Vector2(0, 0), Vector2(1000, 1000))
	check(Picker.pick_in(root, Vector2(50, 50)) == b, "pick/viewport: controls inside a nested SubViewport are skipped")
	# our own UI group is skipped
	var ours := CanvasLayer.new()
	ours.add_to_group(Picker.UI_GROUP)
	holder.add_child(ours)
	_add_control(ours, Vector2(0, 0), Vector2(1000, 1000))
	check(Picker.pick_in(root, Vector2(50, 50)) == b, "pick/ui-group: vs_playtest layers are skipped")
	holder.queue_free()
	await process_frame
	check(Picker.pick_in(root, Vector2(50, 50)) == null, "pick/freed: freed controls are gone")

	# 2D physics
	var body := StaticBody2D.new()
	body.position = Vector2(500, 500)
	body.z_index = 1
	var cs := CollisionShape2D.new()
	var rect := RectangleShape2D.new()
	rect.size = Vector2(60, 60)
	cs.shape = rect
	body.add_child(cs)
	root.add_child(body)
	await physics_frame
	await physics_frame
	check(Picker.pick_in(root, Vector2(505, 495)) == body, "pick/2d-physics: point query hits the body")
	check(Picker.pick_in(root, Vector2(560, 560)) == null, "pick/2d-physics: miss returns null")
	body.queue_free()
	await physics_frame

	# 2D sprite fallback: topmost (higher z, else later in tree) wins
	var s1 := _sprite(Vector2(700, 700), 0)
	var s2 := _sprite(Vector2(700, 700), 0)
	check(Picker.pick_in(root, Vector2(705, 705)) == s2, "pick/2d-sprite: later sprite at equal z is on top")
	s1.z_index = 5
	check(Picker.pick_in(root, Vector2(705, 705)) == s1, "pick/2d-sprite: higher z_index wins over tree order")
	s1.queue_free()
	s2.queue_free()

	# 3D ray
	var cam := Camera3D.new()
	cam.position = Vector3(0, 0, 5)
	root.add_child(cam)
	cam.make_current()
	var b3 := StaticBody3D.new()
	var cs3 := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(2, 2, 2)
	cs3.shape = box
	b3.add_child(cs3)
	root.add_child(b3)
	await physics_frame
	await physics_frame
	var center := Vector2(root.get_visible_rect().size) / 2.0
	check(Picker.pick_in(root, center) == b3, "pick/3d: camera ray hits the body at screen center")
	check(Picker.pick_in(root, Vector2(1, 1)) == null, "pick/3d: ray that misses returns null")
	b3.queue_free()
	cam.queue_free()
	await process_frame


func _test_capture_flow() -> void:
	var on: Node = AutoloadScript.new()
	on.feature_probe = func(f: String) -> bool: return f == "vs_playtest"
	root.add_child(on)
	await process_frame
	on.register_adapter(FullAdapter.new())
	var mock := MockTransport.new()
	mock.queue = [{"ok": true, "status": 200, "data": {"ok": true, "cardId": "idea-77"}, "error": ""}]
	on._client = ReportClient.new(mock)
	on._team_id = "sample"
	on.grab_fn = func() -> Image: return null # headless dummy renderer has no viewport image
	# cancel path resets the guard
	on.start_capture()
	await process_frame
	check(on._capturing == true, "capture: guard set while picking")
	on._overlay.pick_done.emit(false, Vector2.ZERO)
	await process_frame
	check(on._capturing == false, "capture: cancel resets _capturing")
	# click on a transient node that is freed while the note is typed
	var victim := _add_control(root, Vector2(20, 20), Vector2(100, 100))
	victim.name = "Victim"
	on.start_capture()
	await process_frame
	on._overlay.pick_done.emit(true, Vector2(50, 50))
	for i in 4:
		await process_frame
	victim.free() # freed mid-note
	on._overlay.note_done.emit(true, "boom")
	await process_frame
	await process_frame
	check(mock.calls.size() == 1, "capture: report sent after the clicked node was freed")
	var tel: Dictionary = mock.calls[0]["body"]["telemetry"] if mock.calls.size() == 1 else {}
	check(str(tel.get("cursorNode", "")) == "/root/Victim" and tel.get("clickedPoint") == {"x": 50.0, "y": 50.0}, "capture: cursorNode snapshotted at click time (%s)" % str(tel.get("cursorNode", "")))
	check(tel.get("state") == {"hp": 3} and tel.get("seed") == "s1", "capture: telemetry snapshot includes state/seed")
	check(on._capturing == false, "capture: success resets _capturing")
	check(_describe_freed(on), "capture: _describe_node(null / non-Node) is safe and empty")
	on.queue_free()
	await process_frame


func _describe_freed(on: Node) -> bool:
	return on._describe_node(null) == "" and on._describe_node(RefCounted.new()) == ""


func _test_export_helpers() -> void:
	var BS := String.chr(92)
	var n := Export.normalize_adapter_dir
	check(n.call("") == "", "adapter_dir: empty disables")
	check(n.call("res://") == "", "adapter_dir: res:// disables")
	check(n.call("/") == "", "adapter_dir: / disables")
	check(n.call("  ") == "", "adapter_dir: blank disables")
	check(n.call("vs_playtest_adapter") == "res://vs_playtest_adapter/", "adapter_dir: no res:// works")
	check(n.call("res://vs_playtest_adapter") == "res://vs_playtest_adapter/", "adapter_dir: no trailing slash")
	check(n.call("res://vs_playtest_adapter/") == "res://vs_playtest_adapter/", "adapter_dir: canonical")
	check(n.call("a" + BS + "b" + BS) == "res://a/b/", "adapter_dir: backslashes")
	var c := Export.filter_covers_dir
	check(c.call("addons/vs_playtest/*", "addons/vs_playtest"), "filter: dir/*")
	check(c.call("addons/vs_playtest/**", "addons/vs_playtest"), "filter: dir/**")
	check(c.call("*", "addons/vs_playtest"), "filter: *")
	check(c.call("tests/*, addons/vs_playtest/* ,x", "addons/vs_playtest"), "filter: among entries, spaces")
	check(c.call("res://vs_playtest_adapter/*", "res://vs_playtest_adapter/"), "filter: res:// entry and dir")
	check(c.call("addons"+BS+"vs_playtest"+BS+"*", "addons/vs_playtest"), "filter: backslashes")
	check(not c.call("", "addons/vs_playtest"), "filter: empty rejected")
	check(not c.call("addons/vs_playtest/README.md,vs_playtest_adapter/foo.txt", "addons/vs_playtest"), "filter: file-only rejected")
	check(not c.call("addons/vs_playtest/dock.gd", "addons/vs_playtest"), "filter: single file rejected")
	check(not c.call("addons/vs_playtest,vs_playtest_adapter", "addons/vs_playtest"), "filter: missing wildcard rejected")
	check(not c.call("addons/vs_playtest/sub/*", "addons/vs_playtest"), "filter: partial subdir rejected")
	check(not c.call("other/addons/vs_playtest_extra/*", "addons/vs_playtest"), "filter: sibling prefix rejected")
	check(not c.call("addons/vs_playtest_extra/*", "addons/vs_playtest"), "filter: sibling prefix 2 rejected")
	check(not c.call("other/addons/vs_playtest/*", "addons/vs_playtest"), "filter: nested elsewhere rejected")
	check(not c.call("addons/*", "addons/vs_playtest"), "filter: parent wildcard rejected (strict; spec lists only dir/*, dir/**, *)")
