extends SceneTree
## Headless tests: godot --headless --path godot -s tests/run_tests.gd   (run `--import` once first on a fresh checkout)
## Exit code = number of failed checks.

const Token := preload("res://addons/vs_playtest/token.gd")
const Payload := preload("res://addons/vs_playtest/payload.gd")
const ReportClient := preload("res://addons/vs_playtest/report_client.gd")
const AutoloadScript := preload("res://addons/vs_playtest/vs_playtest.gd")
const Picker := preload("res://addons/vs_playtest/picker.gd")
const Export := preload("res://addons/vs_playtest/export_plugin.gd")
const Transport := preload("res://addons/vs_playtest/transport.gd")
const LogCapture := preload("res://addons/vs_playtest/log_capture.gd")
const Dock := preload("res://addons/vs_playtest/dock.gd")
const Settings := preload("res://addons/vs_playtest/settings.gd")

## B2b fixtures: never real tokens.
const DEV_TOKEN := "Tk3n_B2b-test0123456789abcdefGHIJKLmnopqrstu"
const DEV_TOKEN_2 := "Second_B2b-tok3n9876543210ZYXWVUTSrqponmlkj"
## B2b CA pin fixture: a throwaway self-signed P-256 CA (public cert only; its key was deleted). Expected fingerprints
## computed outside Godot, the way server/auth.mjs caFingerprint does it:
##   node: createHash("sha256").update(new X509Certificate(pem).raw).digest("hex").toUpperCase() -> pairs joined by ":"
##   openssl x509 -noout -fingerprint -sha256  ->  the same 32 pairs
const CA_PEM := """-----BEGIN CERTIFICATE-----
MIIBnzCCAUWgAwIBAgIUQC8zfKbmH0xQKwtnrtfAdKNezd0wCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZVmliZVNxdWFkIHRlc3QgZml4dHVyZSBDQTAgFw0yNjExMjEy
MzU0MzJaGA8yMTI2MTAyODIzNTQzMlowJDEiMCAGA1UEAwwZVmliZVNxdWFkIHRl
c3QgZml4dHVyZSBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABL+8voesZUXx
tMtUtur3EkUQ5CNBzq2Wa/e5w24MIPA8f6BCsDqgz6YRPjBVTf6Ti5s2L5FN9F8P
qMUbVeGosTGjUzBRMB0GA1UdDgQWBBQQmSDwgz09ZlM6z8KYGaQrvOvGbDAfBgNV
HSMEGDAWgBQQmSDwgz09ZlM6z8KYGaQrvOvGbDAPBgNVHRMBAf8EBTADAQH/MAoG
CCqGSM49BAMCA0gAMEUCIQC1+FPKXPJ4YVKE5wUfQynJ3lixPAdSLuL/D3xZEbuJ
DwIgMOSfC/VTjignJKv5JN8fPboxrEG7Mfuk0ijkIVTrcZQ=
-----END CERTIFICATE-----
"""
const CA_FP_FULL := "6A:17:46:3B:49:3B:2F:87:67:34:EF:4D:EE:B9:33:E0:67:8D:F0:BE:78:19:72:BC:A1:11:28:48:6C:4A:7D:F5"
const CA_FP_SHORT := "6A:17:46:3B:49:3B:2F:87"

var _pass := 0
var _fail := 0


class MockTransport extends RefCounted:
	var queue: Array = []
	var calls: Array = []
	func request(method: String, path: String, body: Variant = null) -> Dictionary:
		calls.append({"method": method, "path": path, "body": body})
		return queue.pop_front() if not queue.is_empty() else {"ok": true, "status": 200, "data": {}, "error": ""}


## Stands in for HTTPRequest (Transport.http_fn): records every call, answers from a queue.
class MockHttp extends RefCounted:
	var queue: Array = []
	var calls: Array = []
	func handle(url: String, headers: PackedStringArray, method: int, body: String, tls: Variant = null) -> Dictionary:
		calls.append({"url": url, "headers": headers, "method": method, "body": body, "tls": tls})
		return queue.pop_front() if not queue.is_empty() else {"result": HTTPRequest.RESULT_SUCCESS, "code": 200, "text": "{}"}
	static func json(code: int, data: Dictionary) -> Dictionary:
		return {"result": HTTPRequest.RESULT_SUCCESS, "code": code, "text": JSON.stringify(data)}
	static func text(code: int, body: String) -> Dictionary:
		return {"result": HTTPRequest.RESULT_SUCCESS, "code": code, "text": body}


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
	_test_device_egress_table()
	_test_auth_mode_selection()
	_test_device_token_path()
	_test_device_token_file()
	_test_ca_fingerprint_and_pem()
	await _test_device_transport()
	await _test_pairing()
	await _test_autoload_pairing_api()
	await _test_real_tls_pin()
	_test_override_path_refusals()
	_test_private_write_failures()
	_test_pinned_state_single_read()
	await _test_role_warning()
	await _test_hotkeys()
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


# ---------------------------------------------------------------- B2b device-token mode

func _tmp_dir(tag: String) -> String:
	var d := OS.get_temp_dir().path_join("vsp_%s_%d" % [tag, Time.get_ticks_usec()])
	DirAccess.make_dir_recursive_absolute(d)
	return d


func _test_device_egress_table() -> void:
	var BS := String.chr(92)
	var allow := [
		"https://example.com", "https://vs.example.com:8443/", "https://forge.tail1234.ts.net", "https://forge.tail1234.ts.net:4180",
		"HTTPS://FORGE.Tail1234.TS.NET:4180", "https://100.64.0.1:4180", "https://[fd7a:115c:a1e0::1]:4180",
		"https://192.168.1.5:4180", "https://[2001:db8::1]:443", "https://127.0.0.1:4180",
	]
	for u: String in allow:
		check(Token.is_device_egress_allowed(u), "egress: allows %s" % u)
	var deny := [
		# Remote is https only (PLAN_V1): plain http never carries the device token, tailnet and loopback included
		"http://127.0.0.1:4180", "http://localhost:4180", "http://[::1]:4180", "HTTP://LOCALHOST",
		"http://100.64.0.1:4180", "http://100.127.255.255", "http://100.100.100.100:4180/", "http://100.64.0.0",
		"http://[fd7a:115c:a1e0::1]:4180", "http://[FD7A:115C:A1E0:ab12::5]", "http://[fd7a:115c:a1e0:0:0:0:0:1]",
		"http://forge.tail1234.ts.net:4180", "http://FORGE.Tail1234.TS.NET:4180", "http://a.ts.net",
		"http://example.com", "http://192.168.1.5:4180", "http://10.0.0.1", "http://100.63.255.255", "http://100.128.0.1", "http://99.64.0.1",
		"http://127.0.0.2", "http://0.0.0.0:4180",
		# lookalike hosts
		"http://evil.ts.net.attacker.com", "http://100.64.0.1.nip.io", "http://ts.net", "http://.ts.net", "http://evilts.net", "http://ts.net.evil.com",
		"http://forge.ts.net.", "http://forge.tail.ts.net.:4180", "http://forge..ts.net", "http://-forge.ts.net", "https://example.com.",
		"http://forge.ts.net-evil.com", "http://forge_ts.net",
		# userinfo (the B2 R1 bypass)
		"http://user@forge.ts.net", "http://forge.ts.net@evil.com", "http://100.64.0.1@evil.com", "https://user:pw@example.com",
		"http://127.0.0.1:4180@evil.com", "https://evil.com@forge.ts.net", "http://user:pw@100.64.0.1:4180", "http://@forge.ts.net",
		# IPv6
		"http://[fd7a:115c:a1e1::1]", "http://[fd7a:115c::1]", "http://[fe80::1%25eth0]", "http://[::ffff:100.64.0.1]", "http://[fd7a:115c:a1e0::1",
		"http://fd7a:115c:a1e0::1", "http://[fd7a:115c:a1e0::1::2]", "http://[fd7a:115c:a1e0:1:2:3:4:5:6]", "http://[fd7a:115c:a1e0:12345::1]", "http://[]",
		"http://[fc00::1]", "http://[::1]:0",
		# decimal / octal / hex / short IPv4 forms
		"http://1681915905", "http://0144.0100.0.1", "http://100.064.0.1", "http://0x64.0x40.0.1", "http://0x64400001", "http://100.64.1", "http://100.64.0.256",
		"https://1681915905", "https://0x7f000001", "https://0177.0.0.1", "https://2130706433:4180", "https://127.1",
		# ports
		"http://100.64.0.1:0", "http://100.64.0.1:65536", "http://forge.ts.net:abc", "http://forge.ts.net:", "https://example.com:99999",
		# shape
		"ftp://forge.ts.net", "file:///etc/passwd", "", "forge.ts.net:4180", "//forge.ts.net", "http://forge.ts.net?x=1", "http://forge.ts.net#x",
		"http://forge.ts.net" + BS + "@evil.com", "http://forge.ts.net/a@evil.com", "http://exa mple.com", "javascript:alert(1)", "http://100.64.0.1 .evil.com",
		"wss://forge.ts.net", "http:/forge.ts.net", "http://forge.ts.net/x\r\nX-Evil: 1",
	]
	for u: String in deny:
		check(not Token.is_device_egress_allowed(u), "egress: refuses '%s'" % u.c_escape())
	# the one plain-http remote call: /ca.crt on the same host:port as the https server_url
	check(Token.ca_bootstrap_url("https://forge.tail1234.ts.net:4180") == "http://forge.tail1234.ts.net:4180/ca.crt", "bootstrap: same host and port, /ca.crt")
	check(Token.ca_bootstrap_url("https://Forge.Tail1234.ts.net:4180/vs/") == "http://forge.tail1234.ts.net:4180/ca.crt", "bootstrap: path dropped, host lower-cased")
	check(Token.ca_bootstrap_url("https://100.64.0.1") == "http://100.64.0.1:443/ca.crt", "bootstrap: no port -> the https port 443")
	check(Token.ca_bootstrap_url("https://[fd7a:115c:a1e0::1]:4180") == "http://[fd7a:115c:a1e0::1]:4180/ca.crt", "bootstrap: IPv6 keeps brackets")
	for u in ["http://forge.ts.net:4180", "https://user@forge.ts.net", "https://evil.com@forge.ts.net", "", "ftp://x.ts.net", "https://forge.ts.net?x=1"]:
		check(Token.ca_bootstrap_url(u) == "", "bootstrap: '%s' -> none" % u)


func _test_auth_mode_selection() -> void:
	for u in ["http://127.0.0.1:4180", "http://localhost", "http://[::1]:4180", "HTTP://LOCALHOST:4180/"]:
		check(Token.auth_mode(u) == Token.MODE_LOCAL, "mode: %s -> local token" % u)
	for u in ["http://forge.tail1234.ts.net:4180", "https://127.0.0.1:4180", "http://100.64.0.1:4180", "http://127.0.0.1.evil.com", "http://127.0.0.1@evil.com", "https://example.com"]:
		check(Token.auth_mode(u) == Token.MODE_DEVICE, "mode: %s -> device token" % u)
	check(Token.auth_mode(Token.server_url("", func(_k: String) -> String: return "")) == Token.MODE_LOCAL, "mode: default server_url (auto) is local")
	var t := Transport.new()
	t.server_url = "http://127.0.0.1:4180"
	check(t.auth_mode() == Token.MODE_LOCAL and t.device_refusal() == "", "mode: transport loopback -> local, no refusal")
	t.server_url = "http://evil.example.com:4180"
	check(t.auth_mode() == Token.MODE_DEVICE and t.device_refusal().begins_with("refusing to send the device token"), "mode: transport plain-http remote -> refused with a reason")
	t.server_url = "http://u:secretpw@evil.example.com"
	check(not t.device_refusal().contains("secretpw"), "mode: refusal message masks userinfo")
	t.free()


func _test_device_token_path() -> void:
	var BS := String.chr(92)
	var env := {"VIBESQUAD_HOME": "/tmp/vsh", "USERPROFILE": "C:/Users/x", "HOME": "/home/x"}
	var getenv := func(k: String) -> String: return env.get(k, "")
	check(Token.device_token_path("", getenv) == "/tmp/vsh/playtest-device-token", "device path: $VIBESQUAD_HOME wins")
	var win := {"USERPROFILE": "C:/Users/x", "HOME": "/home/x"}
	check(Token.device_token_path("", func(k: String) -> String: return win.get(k, "")) == "C:/Users/x/.vibesquad/playtest-device-token", "device path: Windows home fallback")
	var nix := {"HOME": "/home/x"}
	check(Token.device_token_path("", func(k: String) -> String: return nix.get(k, "")) == "/home/x/.vibesquad/playtest-device-token", "device path: HOME fallback")
	check(Token.device_token_path("", func(_k: String) -> String: return "") == "", "device path: no home -> empty")
	for o in ["/abs/dir/tok", "C:/t/tok", "C:" + BS + "t" + BS + "tok", "  /abs/tok  "]:
		check(Token.device_token_path(o, getenv) == o.strip_edges(), "device path: setting override '%s' wins" % o.c_escape())
	for o in ["res://tok", "user://tok", "uid://abc", "tok", "./tok", "~/.vibesquad/tok", "/dir/", "C:tok", "http://x/tok"]:
		check(Token.device_token_path(o, getenv) == "", "device path: override '%s' refused (not swapped for the default)" % o)
	check(Token.token_path(getenv) == "/tmp/vsh/local-token", "device path: local-token path unchanged")
	# pinned CA file: same defaults beside the token, same refusals
	check(Token.ca_cert_path("", getenv) == "/tmp/vsh/playtest-ca.crt", "ca path: $VIBESQUAD_HOME wins")
	check(Token.ca_cert_path("", func(k: String) -> String: return win.get(k, "")) == "C:/Users/x/.vibesquad/playtest-ca.crt", "ca path: Windows home fallback")
	check(Token.ca_cert_path("", func(k: String) -> String: return nix.get(k, "")) == "/home/x/.vibesquad/playtest-ca.crt", "ca path: HOME fallback")
	check(Token.ca_cert_path("", func(_k: String) -> String: return "") == "", "ca path: no home -> empty")
	for o in ["/abs/dir/ca.crt", "C:/t/ca.crt", "C:" + BS + "t" + BS + "ca.crt", "  /abs/ca.crt  "]:
		check(Token.ca_cert_path(o, getenv) == o.strip_edges(), "ca path: setting override '%s' wins" % o.c_escape())
	for o in ["res://playtest-ca.crt", "user://playtest-ca.crt", "uid://abc", "ca.crt", "./ca.crt", "../ca.crt", "~/.vibesquad/ca.crt", "/dir/", "C:ca.crt", "http://x/ca.crt"]:
		check(Token.ca_cert_path(o, getenv) == "", "ca path: override '%s' refused (not swapped for the default)" % o)
	var der := Token.pem_single_cert_der(CA_PEM)
	for o in ["res://playtest-ca.crt", "user://playtest-ca.crt", "ca.crt"]:
		check(Token.write_ca_cert(o, der) == ERR_FILE_BAD_PATH and not FileAccess.file_exists(o), "ca file: write to '%s' refused" % o)
		check(Token.read_ca_der(o).is_empty(), "ca file: read from '%s' refused" % o)


func _test_device_token_file() -> void:
	var dir := _tmp_dir("devtok")
	var p := dir.path_join("sub").path_join("playtest-device-token")
	check(Token.write_device_token(p, DEV_TOKEN) == OK, "token file: written (parent dir created)")
	check(Token.read_device_token(p) == DEV_TOKEN, "token file: reads back")
	check(FileAccess.get_file_as_string(p) == DEV_TOKEN + "\n", "token file: content is the token only")
	if not (OS.get_name() in ["Windows", "Web"]):
		check((FileAccess.get_unix_permissions(p) & 63) == 0, "token file: owner-only permissions (%o)" % FileAccess.get_unix_permissions(p))
	var leftovers := DirAccess.get_files_at(p.get_base_dir())
	check(leftovers.size() == 1, "token file: no temp file left behind (%s)" % ", ".join(leftovers))
	check(Token.write_device_token(p, DEV_TOKEN_2) == OK and Token.read_device_token(p) == DEV_TOKEN_2, "token file: overwrite replaces it")
	check(Token.write_device_token(p, "bad\ntoken-with-newline") == ERR_INVALID_DATA and Token.read_device_token(p) == DEV_TOKEN_2, "token file: malformed token refused, file untouched")
	check(Token.write_device_token("res://playtest-device-token", DEV_TOKEN) == ERR_FILE_BAD_PATH and not FileAccess.file_exists("res://playtest-device-token"), "token file: res:// path refused")
	check(Token.write_device_token("user://playtest-device-token", DEV_TOKEN) == ERR_FILE_BAD_PATH and not FileAccess.file_exists("user://playtest-device-token"), "token file: user:// path refused")
	for bad in ["short", "has space in it here", "abc\ndef0123456789xyz", "x".repeat(257), "a;b=c0123456789abcdef"]:
		var q := dir.path_join("bad")
		var f := FileAccess.open(q, FileAccess.WRITE)
		f.store_string(bad)
		f.close()
		check(Token.read_device_token(q) == "", "token file: malformed '%s' reads as unpaired" % bad.left(24).c_escape())
		DirAccess.remove_absolute(q)
	var t := Transport.new()
	t.device_token_path = p
	var cp := p.get_base_dir().path_join("playtest-ca.crt")
	t.ca_cert_path = cp
	check(not t.is_paired(), "unpair: a token without a pinned CA is not paired")
	check(Token.write_ca_cert(cp, Token.pem_single_cert_der(CA_PEM)) == OK, "ca file: written")
	check(Token.read_ca_der(cp) == Token.pem_single_cert_der(CA_PEM) and FileAccess.get_file_as_string(cp) == Token.der_to_pem(Token.pem_single_cert_der(CA_PEM)), "ca file: reads back as one canonical PEM cert")
	if not (OS.get_name() in ["Windows", "Web"]):
		check((FileAccess.get_unix_permissions(cp) & 63) == 0, "ca file: owner-only permissions")
	check(t.is_paired() and t.pinned_fingerprint().get("full") == CA_FP_FULL, "unpair: token + pin -> paired, pin fingerprint readable")
	check(t.unpair() and not FileAccess.file_exists(p) and not FileAccess.file_exists(cp) and not t.is_paired(), "unpair: removes BOTH the token and the CA file")
	check(t.unpair(), "unpair: idempotent when already gone")
	# a CA file alone (token deleted by hand) is removed too
	Token.write_ca_cert(cp, Token.pem_single_cert_der(CA_PEM))
	check(t.unpair() and not FileAccess.file_exists(cp), "unpair: removes a CA file left without a token")
	t.free()
	DirAccess.remove_absolute(p.get_base_dir())
	DirAccess.remove_absolute(dir)


func _test_ca_fingerprint_and_pem() -> void:
	var der := Token.pem_single_cert_der(CA_PEM)
	check(not der.is_empty(), "ca: fixture PEM parses to DER")
	var fp := Token.ca_fingerprint(der)
	check(fp.get("full") == CA_FP_FULL, "ca: full fingerprint matches server/auth.mjs caFingerprint (node) and openssl: %s" % fp.get("full"))
	check(fp.get("short") == CA_FP_SHORT, "ca: short fingerprint = first 8 pairs, as the VS pair dialog shows it")
	check(Token.pem_single_cert_der(CA_PEM.replace("\n", "\r\n")) == der, "ca: CRLF PEM gives the same DER")
	check(Token.pem_single_cert_der(Token.der_to_pem(der)) == der, "ca: canonical PEM round-trips")
	var tls := Token.pinned_tls(der)
	check(tls != null and not tls.is_server() and not tls.is_unsafe_client() and _chain_der(tls) == der, "ca: pinned TLS options trust exactly the fixture CA, with verification on")
	check(Token.pinned_tls(PackedByteArray()) == null, "ca: no DER -> no TLS options")
	var body := CA_PEM.split("-----BEGIN CERTIFICATE-----")[1].split("-----END CERTIFICATE-----")[0]
	var bad := {
		"two certificates (an extra anchor riding along)": CA_PEM + CA_PEM,
		"trailing text": CA_PEM + "hello",
		"leading text": "hello\n" + CA_PEM,
		"a private key block": "-----BEGIN PRIVATE KEY-----" + body + "-----END PRIVATE KEY-----\n",
		"broken base64": CA_PEM.replace("MIIBnz", "MIIB!z"),
		"truncated body": CA_PEM.replace("DwIgMOSfC/VTjignJKv5JN8fPboxrEG7Mfuk0ijkIVTrcZQ=", ""),
		"empty": "",
		"html error page": "<html>404</html>",
	}
	for k: String in bad:
		check(Token.pem_single_cert_der(str(bad[k])).is_empty(), "ca: refuses %s" % k)


func _has_header(headers: PackedStringArray, name: String) -> bool:
	for h in headers:
		if h.to_lower().begins_with(name.to_lower() + ":"):
			return true
	return false


func _test_device_transport() -> void:
	var dir := _tmp_dir("devtr")
	var dpath := dir.path_join("playtest-device-token")
	var cpath := dir.path_join("playtest-ca.crt")
	var lpath := dir.path_join("local-token")
	var local_tok := "0123456789abcdef".repeat(4)
	var lf := FileAccess.open(lpath, FileAccess.WRITE)
	lf.store_string(local_tok)
	lf.close()
	Token.write_device_token(dpath, DEV_TOKEN)
	var der := Token.pem_single_cert_der(CA_PEM)
	var t := Transport.new()
	var mock := MockHttp.new()
	t.http_fn = Callable(mock, "handle")
	t.device_token_path = dpath
	t.ca_cert_path = cpath
	t.local_token_path = lpath
	# loopback -> local token only, never the device token; loopback mode is unchanged (plain http, no pin)
	t.server_url = "http://127.0.0.1:4180"
	var r: Dictionary = await t.request("GET", "/__vibesquad/tester/thread?teamId=s", null)
	var h: PackedStringArray = mock.calls[-1]["headers"] if mock.calls.size() > 0 else PackedStringArray()
	check(r["ok"] and h.has("x-vibesquad-token: " + local_tok) and mock.calls[-1]["tls"] == null, "transport: loopback sends x-vibesquad-token over plain http, unchanged")
	check(not _has_header(h, "x-vs-device-token") and not _has_header(h, "authorization") and not _has_header(h, "cookie") and not ("|".join(h)).contains(DEV_TOKEN), "transport: loopback never sends the device token or a cookie")
	# remote https but NO pinned CA -> no token, no request, dock-ready reason
	for url in ["https://forge.tail1234.ts.net:4180", "https://vs.example.com"]:
		t.server_url = url
		var n0 := mock.calls.size()
		r = await t.request("POST", "/__vibesquad/tester/report", {"teamId": "s"})
		check(mock.calls.size() == n0 and r["status"] == -1 and str(r["error"]).contains("no pinned VibeSquad CA") and not str(r).contains(DEV_TOKEN), "transport: %s without a CA pin -> no request, no token" % url)
	t.ca_cert_path = "res://playtest-ca.crt"
	r = await t.request("GET", "/x", null)
	check(r["status"] == -1 and str(r["error"]).contains("ca_cert_path"), "transport: res:// ca_cert_path refused, no fallback to the default file")
	t.ca_cert_path = cpath
	var junk := FileAccess.open(cpath, FileAccess.WRITE)
	junk.store_string(CA_PEM + CA_PEM)
	junk.close()
	var n1 := mock.calls.size()
	r = await t.request("GET", "/x", null)
	check(mock.calls.size() == n1 and str(r["error"]).contains("no pinned VibeSquad CA"), "transport: a CA file with two certs is not a pin")
	# remote https + pin -> device token header only, over TLS options that trust only the pinned CA
	Token.write_ca_cert(cpath, der)
	for url in ["https://forge.tail1234.ts.net:4180", "https://vs.example.com", "https://100.64.0.7:4180", "https://[fd7a:115c:a1e0::9]:4180"]:
		t.server_url = url
		var n := mock.calls.size()
		r = await t.request("POST", "/__vibesquad/tester/report", {"teamId": "s"})
		var c: Dictionary = mock.calls[-1] if mock.calls.size() > n else {}
		var hh: PackedStringArray = c.get("headers", PackedStringArray())
		check(r["ok"] and str(c.get("url", "")) == url + "/__vibesquad/tester/report" and hh.has("x-vs-device-token: " + DEV_TOKEN), "transport: %s sends x-vs-device-token" % url)
		var tls: TLSOptions = c.get("tls")
		check(_chain_der(tls) == der, "transport: %s pinned to the stored CA (no system trust store)" % url)
		check(not _has_header(hh, "x-vibesquad-token") and not _has_header(hh, "cookie") and not ("|".join(hh)).contains(local_tok), "transport: %s never gets the local token or a cookie" % url)
	# egress refused -> no request at all (plain http to a remote, tailnet included, even with a pin)
	for url in ["http://forge.tail1234.ts.net:4180", "http://100.64.0.7:4180", "http://[fd7a:115c:a1e0::9]:4180", "http://evil.example.com:4180", "http://evil.ts.net.attacker.com", "http://user@forge.ts.net", "http://1681915905"]:
		t.server_url = url
		var n2 := mock.calls.size()
		r = await t.request("GET", "/x", null)
		check(mock.calls.size() == n2 and not r["ok"] and r["status"] == -1 and str(r["error"]).begins_with("refusing to send the device token") and str(r["error"]).contains("https://"), "transport: %s refused before any request" % url)
	# an https call can never go out without pin options, even from inside the transport
	var raw: Dictionary = await t._send("https://vs.example.com/x", PackedStringArray(), HTTPClient.METHOD_GET, "", null)
	check(raw.has("start_error") and mock.calls.size() == n1 + 4, "transport: _send refuses https without pinned TLS options")
	# unpaired -> refused locally with how-to
	t.server_url = "https://vs.example.com"
	t.device_token_path = dir.path_join("missing-token")
	var n3 := mock.calls.size()
	r = await t.request("GET", "/x", null)
	check(mock.calls.size() == n3 and r["status"] == -1 and str(r["error"]).contains("Pair with VS"), "transport: unpaired remote -> -1, says Pair with VS")
	t.device_token_path = "res://playtest-device-token"
	r = await t.request("GET", "/x", null)
	check(mock.calls.size() == n3 and r["status"] == -1 and str(r["error"]).contains("device_token_path"), "transport: res:// device_token_path refused, no fallback to the default file")
	t.device_token_path = dpath
	# redirect / TLS / 401 answers
	mock.queue = [{"result": HTTPRequest.RESULT_REDIRECT_LIMIT_REACHED, "code": 301, "text": ""}]
	r = await t.request("GET", "/x", null)
	check(r["status"] == -1 and str(r["error"]).contains("redirect"), "transport: redirect is refused, not followed, not retried")
	mock.queue = [MockHttp.json(302, {})]
	r = await t.request("GET", "/x", null)
	check(r["status"] == -1 and str(r["error"]).contains("redirect"), "transport: a raw 3xx is refused too")
	mock.queue = [{"result": HTTPRequest.RESULT_TLS_HANDSHAKE_ERROR, "code": 0, "text": ""}]
	r = await t.request("POST", "/__vibesquad/tester/report", {"teamId": "s"})
	check(r["status"] == -1 and str(r["error"]).begins_with("TLS/CA problem") and str(r["error"]).contains("pinned VibeSquad CA"), "transport: TLS failure on a report says TLS/CA problem, not retried")
	mock.queue = [MockHttp.json(401, {"error": "unauthorized"})]
	r = await t.request("GET", "/x", null)
	check(r["status"] == 401 and str(r["error"]).contains("Unpair"), "transport: 401 in device mode says re-pair")
	check(not str(r).contains(DEV_TOKEN), "transport: result never carries the token")
	t.free()
	for f in DirAccess.get_files_at(dir):
		DirAccess.remove_absolute(dir.path_join(f))
	DirAccess.remove_absolute(dir)


## Queues the /ca.crt bootstrap answer and runs fetch_ca(); returns its result.
func _fetch_ca(t: Node, mock: MockHttp, pem: String = CA_PEM) -> Dictionary:
	mock.queue.push_front(MockHttp.text(200, pem))
	return await t.fetch_ca()


func _test_pairing() -> void:
	var logs := LogCapture.new()
	logs.install()
	var outputs: Array = [] # every result / error string the flows produce
	var dir := _tmp_dir("pair")
	var dpath := dir.path_join("playtest-device-token")
	var cpath := dir.path_join("playtest-ca.crt")
	var der := Token.pem_single_cert_der(CA_PEM)
	var t := Transport.new()
	var mock := MockHttp.new()
	t.http_fn = Callable(mock, "handle")
	t.sleep_fn = func(_s: float) -> void: pass
	t.device_token_path = dpath
	t.ca_cert_path = cpath
	t.server_url = "https://forge.tail1234.ts.net:4180"
	# 0. bootstrap: plain GET /ca.crt, no token / code / cookie, nothing trusted or stored yet
	var f: Dictionary = await _fetch_ca(t, mock)
	outputs.append(f)
	var cb: Dictionary = mock.calls[0] if mock.calls.size() > 0 else {}
	var hb: PackedStringArray = cb.get("headers", PackedStringArray())
	check(f["ok"] and str(cb.get("url", "")) == "http://forge.tail1234.ts.net:4180/ca.crt" and cb.get("method") == HTTPClient.METHOD_GET and cb.get("body") == "" and cb.get("tls") == null, "bootstrap: plain GET http://<host>:<port>/ca.crt")
	check(not _has_header(hb, "x-vs-device-token") and not _has_header(hb, "x-vibesquad-token") and not _has_header(hb, "authorization") and not _has_header(hb, "cookie") and not str(cb.get("url")).contains("code="), "bootstrap: carries no token, no code, no cookie")
	check(f["fingerprint"].get("full") == CA_FP_FULL and f["fingerprint"].get("short") == CA_FP_SHORT, "bootstrap: returns the pair-dialog fingerprint to confirm")
	check(not FileAccess.file_exists(cpath) and not t.is_paired(), "bootstrap: the fetched CA is not stored or trusted before confirmation")
	# Even with a token file on disk, an unconfirmed fetched CA is not a pin
	Token.write_device_token(dpath, DEV_TOKEN)
	var n0 := mock.calls.size()
	var rq: Dictionary = await t.request("GET", "/x", null)
	check(mock.calls.size() == n0 and str(rq["error"]).contains("no pinned VibeSquad CA"), "bootstrap: no token is sent until the CA is confirmed and pinned")
	Token.remove_file(dpath)
	# bad bootstrap answers
	for bad: Array in [[MockHttp.text(200, CA_PEM + CA_PEM), "single PEM"], [MockHttp.text(200, "<html></html>"), "single PEM"], [MockHttp.text(404, "{\"error\":\"no CA yet\"}"), "HTTP 404"], [{"result": HTTPRequest.RESULT_REDIRECT_LIMIT_REACHED, "code": 301, "text": ""}, "network error"], [{"result": HTTPRequest.RESULT_CANT_CONNECT, "code": 0, "text": ""}, "network error"]]:
		mock.queue = [bad[0]]
		var fb: Dictionary = await t.fetch_ca()
		check(not fb["ok"] and str(fb["error"]).contains(bad[1]) and fb["fingerprint"].is_empty(), "bootstrap: bad answer refused (%s)" % bad[1])
	var r: Dictionary = await t.pair("123456", CA_FP_FULL)
	check(not r["ok"] and r["state"] == "unconfirmed", "pair: a failed fetch leaves nothing to confirm")
	# 1. confirmation gate: no pair request without the confirmed fingerprint of THIS fetched CA
	await _fetch_ca(t, mock)
	var n1 := mock.calls.size()
	for wrong in ["", CA_FP_SHORT, CA_FP_FULL.replace("6A:17", "6A:18"), CA_FP_FULL.to_lower()]:
		r = await t.pair("123456", wrong)
		check(not r["ok"] and r["state"] == "unconfirmed" and mock.calls.size() == n1, "pair: fingerprint '%s' not confirmed -> no request" % wrong.left(11))
	t.cancel_ca()
	r = await t.pair("123456", CA_FP_FULL)
	check(not r["ok"] and r["state"] == "unconfirmed" and mock.calls.size() == n1, "pair: cancelled CA -> no request")
	# 2. PC-minted code: paired at once, redeemed over https pinned to the confirmed CA
	mock.calls.clear()
	await _fetch_ca(t, mock)
	mock.queue = [MockHttp.json(200, {"ok": true, "state": "paired", "token": DEV_TOKEN, "role": "owner", "allowedTeams": null, "hostId": "h"})]
	r = await t.pair(" 123-456 ", CA_FP_FULL)
	outputs.append(r)
	var c0: Dictionary = mock.calls[1] if mock.calls.size() > 1 else {}
	check(str(c0.get("url", "")) == "https://forge.tail1234.ts.net:4180/pair?code=123456&format=json&name=Godot%20playtest" and c0.get("method") == HTTPClient.METHOD_GET, "pair: GET https …/pair?code=…&format=json (code normalized)")
	var tls0: TLSOptions = c0.get("tls")
	check(_chain_der(tls0) == der, "pair: redeem pinned to the confirmed CA")
	var h0: PackedStringArray = c0.get("headers", PackedStringArray())
	check(not _has_header(h0, "x-vs-device-token") and not _has_header(h0, "x-vibesquad-token") and not _has_header(h0, "cookie"), "pair: redeem carries no token and no cookie")
	check(r["ok"] and r["state"] == "paired" and t.is_paired() and Token.read_device_token(dpath) == DEV_TOKEN and Token.read_ca_der(cpath) == der, "pair: paired -> token AND CA stored")
	check(not r.has("token") and not str(r).contains(DEV_TOKEN), "pair: result never carries the token")
	check(t.unpair() and not t.is_paired() and not FileAccess.file_exists(dpath) and not FileAccess.file_exists(cpath), "pair: unpair after pairing removes both files")
	# 3. phone-minted code: pending -> pending -> blip -> approved, polled over the pin with the token header
	mock.calls.clear()
	await _fetch_ca(t, mock)
	mock.queue = [
		MockHttp.json(200, {"ok": true, "state": "pending", "token": DEV_TOKEN_2, "role": "owner"}),
		MockHttp.json(200, {"state": "pending", "role": "owner"}),
		MockHttp.json(503, {"error": "blip"}),
		MockHttp.json(200, {"state": "approved", "role": "owner"}),
	]
	r = await t.pair("654321", CA_FP_FULL)
	outputs.append(r)
	check(r["ok"] and mock.calls.size() == 5 and str(mock.calls[2]["url"]).begins_with("https://") and str(mock.calls[2]["url"]).ends_with("/pair/status") and (mock.calls[2]["headers"] as PackedStringArray).has("x-vs-device-token: " + DEV_TOKEN_2) and mock.calls[2]["tls"] != null, "pair: pending polls https /pair/status with the header token, pinned")
	check(Token.read_device_token(dpath) == DEV_TOKEN_2 and Token.read_ca_der(cpath) == der, "pair: approved -> token and CA stored")
	t.unpair()
	# 4. denied / never approved
	await _fetch_ca(t, mock)
	mock.queue = [MockHttp.json(200, {"ok": true, "state": "pending", "token": DEV_TOKEN, "role": "owner"}), MockHttp.json(200, {"state": "denied"})]
	r = await t.pair("111111", CA_FP_FULL)
	outputs.append(r)
	check(not r["ok"] and r["state"] == "denied" and str(r["error"]).contains("denied") and not FileAccess.file_exists(dpath) and not FileAccess.file_exists(cpath), "pair: denied -> nothing stored")
	t.pair_timeout_sec = 6.0
	await _fetch_ca(t, mock)
	mock.queue = [MockHttp.json(200, {"ok": true, "state": "pending", "token": DEV_TOKEN, "role": "owner"})]
	for i in 5:
		mock.queue.append(MockHttp.json(200, {"state": "pending"}))
	r = await t.pair("111112", CA_FP_FULL)
	outputs.append(r)
	check(not r["ok"] and r["state"] == "timeout" and not FileAccess.file_exists(dpath) and not FileAccess.file_exists(cpath), "pair: never approved -> times out, nothing stored")
	# 5. a tester code is not an owner device
	await _fetch_ca(t, mock)
	mock.queue = [MockHttp.json(200, {"ok": true, "state": "paired", "token": DEV_TOKEN, "role": "bug-tester", "allowedTeams": ["x"]})]
	r = await t.pair("222222", CA_FP_FULL)
	outputs.append(r)
	check(not r["ok"] and r["state"] == "wrong-role" and not FileAccess.file_exists(dpath), "pair: non-owner role refused, nothing stored")
	# 6. server refusals / TLS
	await _fetch_ca(t, mock)
	mock.queue = [MockHttp.json(401, {"ok": false, "state": "invalid", "error": "pairing code invalid, already used, or expired"})]
	r = await t.pair("333333", CA_FP_FULL)
	outputs.append(r)
	check(not r["ok"] and str(r["error"]).contains("invalid, already used"), "pair: invalid code -> server reason shown")
	await _fetch_ca(t, mock)
	mock.queue = [MockHttp.json(429, {"ok": false, "state": "rate-limited", "error": "too many pairing attempts", "retryAfterSecs": 90})]
	r = await t.pair("333334", CA_FP_FULL)
	outputs.append(r)
	check(not r["ok"] and str(r["error"]).contains("90 s"), "pair: rate limit -> retry hint")
	await _fetch_ca(t, mock)
	mock.queue = [{"result": HTTPRequest.RESULT_REDIRECT_LIMIT_REACHED, "code": 301, "text": ""}]
	r = await t.pair("333335", CA_FP_FULL)
	outputs.append(r)
	check(not r["ok"] and str(r["error"]).contains("redirect"), "pair: redirect refused")
	await _fetch_ca(t, mock)
	mock.queue = [{"result": HTTPRequest.RESULT_TLS_HANDSHAKE_ERROR, "code": 0, "text": ""}]
	r = await t.pair("333337", CA_FP_FULL)
	outputs.append(r)
	check(not r["ok"] and str(r["error"]).contains("TLS/CA problem") and not FileAccess.file_exists(cpath) and not FileAccess.file_exists(dpath), "pair: https redeem TLS failure says TLS/CA problem, nothing stored")
	await _fetch_ca(t, mock)
	mock.queue = [MockHttp.json(200, {"ok": true, "state": "paired", "token": "bad token\r\nX-Evil: 1", "role": "owner"})]
	r = await t.pair("333336", CA_FP_FULL)
	outputs.append(r)
	check(not r["ok"] and not FileAccess.file_exists(dpath), "pair: malformed token from the server refused")
	# 7. refused locally: no request goes out
	await _fetch_ca(t, mock)
	var n := mock.calls.size()
	for code in ["12345", "1234567", "abcdef", ""]:
		r = await t.pair(code, CA_FP_FULL)
		outputs.append(r)
		check(not r["ok"] and mock.calls.size() == n, "pair: bad code '%s' refused before any request" % code)
	for url in ["http://forge.tail1234.ts.net:4180", "http://100.64.0.1:4180", "http://evil.example.com", "http://evil.ts.net.attacker.com", "http://user@forge.ts.net"]:
		t.server_url = url
		r = await t.pair("123456", CA_FP_FULL)
		var fr: Dictionary = await t.fetch_ca()
		outputs.append(r)
		check(not r["ok"] and not fr["ok"] and mock.calls.size() == n and str(r["error"]).contains("pairing code") and str(r["error"]).contains("https://"), "pair: %s refused before any request (no bootstrap either)" % url)
	t.server_url = "http://127.0.0.1:4180"
	r = await t.pair("123456", CA_FP_FULL)
	check(not r["ok"] and mock.calls.size() == n and str(r["error"]).contains("no pairing needed"), "pair: loopback server needs no pairing")
	t.server_url = "https://forge.tail1234.ts.net:4180"
	t.ca_cert_path = "user://playtest-ca.crt"
	var fu: Dictionary = await t.fetch_ca()
	check(not fu["ok"] and str(fu["error"]).contains("ca_cert_path") and mock.calls.size() == n, "pair: user:// ca_cert_path refused before any request")
	t.ca_cert_path = cpath
	# 8. token never in any error, result or log line
	await process_frame
	logs.uninstall()
	var lines: Array = logs.last_lines(LogCapture.CAP)
	var blob := JSON.stringify(outputs) + "\n" + "\n".join(PackedStringArray(lines))
	check(not blob.contains(DEV_TOKEN) and not blob.contains(DEV_TOKEN_2), "pair: no token in any error/result/log line (%d log lines)" % lines.size())
	t.free()
	for file in DirAccess.get_files_at(dir):
		DirAccess.remove_absolute(dir.path_join(file))
	DirAccess.remove_absolute(dir)


func _test_autoload_pairing_api() -> void:
	var off: Node = AutoloadScript.new()
	off.feature_probe = func(_f: String) -> bool: return false
	root.add_child(off)
	await process_frame
	check(off.is_paired() == false and off.unpair() == false, "api: disabled is_paired()/unpair() are inert")
	off.queue_free()
	var logs := LogCapture.new()
	logs.install()
	var dir := _tmp_dir("api")
	var dpath := dir.path_join("playtest-device-token")
	var cpath := dir.path_join("playtest-ca.crt")
	var on: Node = AutoloadScript.new()
	on.feature_probe = func(f: String) -> bool: return f == "vs_playtest"
	root.add_child(on)
	await process_frame
	check(on._dock.pair_state == Dock.PAIR_HIDDEN, "api: loopback server -> no pair row")
	var mock := MockHttp.new()
	on._transport.http_fn = Callable(mock, "handle")
	on._transport.sleep_fn = func(_s: float) -> void: pass
	on._transport.device_token_path = dpath
	on._transport.ca_cert_path = cpath
	on._transport.server_url = "https://forge.tail1234.ts.net:4180"
	on._refresh_pairing()
	check(not on.is_paired() and on._dock.pair_state == Dock.PAIR_UNPAIRED and on._dock._pair_btn.text == "Pair with VS", "api: remote + no token -> Pair with VS shown")
	# step 1: code -> CA fetched, fingerprint shown, nothing paired or stored yet
	mock.queue = [MockHttp.text(200, CA_PEM)]
	on._dock.pair_submitted.emit("123456")
	for i in 3:
		await process_frame
	var shown: String = on._dock._ca_label.text
	check(on._dock.pair_state == Dock.PAIR_CONFIRM and shown.contains(CA_FP_SHORT) and shown.contains(CA_FP_FULL) and on._dock._ca_yes.visible, "api: dock shows the CA fingerprint (short + full) and asks to confirm")
	check(not on.is_paired() and not FileAccess.file_exists(cpath) and mock.calls.size() == 1, "api: nothing redeemed or stored before confirmation")
	# cancel -> back to Pair with VS, nothing trusted
	on._dock.ca_confirmed.emit(false)
	await process_frame
	check(on._dock.pair_state == Dock.PAIR_UNPAIRED and not FileAccess.file_exists(cpath) and mock.calls.size() == 1 and str(on._dock._status.text).contains("cancelled"), "api: Cancel -> no redeem, CA not trusted")
	# step 2: confirm -> redeemed over https with the pin, both files stored
	mock.queue = [MockHttp.text(200, CA_PEM), MockHttp.json(200, {"ok": true, "state": "paired", "token": DEV_TOKEN, "role": "owner"})]
	on._dock.pair_submitted.emit("123456")
	for i in 3:
		await process_frame
	on._dock.ca_confirmed.emit(true)
	for i in 3:
		await process_frame
	check(on.is_paired() and on._dock.pair_state == Dock.PAIR_PAIRED and on._dock._unpair_btn.visible and FileAccess.file_exists(cpath), "api: confirm -> paired, CA pinned, Unpair shown")
	check(mock.calls.size() >= 3 and str(mock.calls[2]["url"]).begins_with("https://") and mock.calls[2]["tls"] != null, "api: redeem went over https with the pin")
	var status_paired: String = on._dock._status.text
	# token without a pin -> not paired, dock explains
	DirAccess.remove_absolute(cpath)
	on._refresh_pairing()
	check(not on.is_paired() and on._dock.pair_state == Dock.PAIR_UNPAIRED and str(on._dock._status.text).contains("No pinned VibeSquad CA"), "api: token without a CA pin -> dock says why, no token sent")
	Token.write_ca_cert(cpath, Token.pem_single_cert_der(CA_PEM))
	check(on.unpair() and not FileAccess.file_exists(dpath) and not FileAccess.file_exists(cpath) and not on.is_paired() and on._dock.pair_state == Dock.PAIR_UNPAIRED, "api: unpair() deletes both files, Pair with VS back")
	var status_unpaired: String = on._dock._status.text
	on._transport.server_url = "http://forge.tail1234.ts.net:4180"
	on._refresh_pairing()
	check(on._dock.pair_state == Dock.PAIR_HIDDEN and str(on._dock._status.text).begins_with("refusing") and str(on._dock._status.text).contains("https://"), "api: plain-http remote server_url -> dock says use https, no pair row")
	on._transport.server_url = "https://forge.tail1234.ts.net:4180"
	on._transport.ca_cert_path = "res://playtest-ca.crt"
	on._refresh_pairing()
	check(on._dock.pair_state == Dock.PAIR_HIDDEN and str(on._dock._status.text).contains("ca_cert_path"), "api: res:// ca_cert_path -> dock says why")
	on.queue_free()
	await process_frame
	logs.uninstall()
	var lines: Array = logs.last_lines(LogCapture.CAP)
	var blob := status_paired + status_unpaired + "\n".join(PackedStringArray(lines))
	check(not blob.contains(DEV_TOKEN), "api: token never in dock status or log lines")
	for file in DirAccess.get_files_at(dir):
		DirAccess.remove_absolute(dir.path_join(file))
	DirAccess.remove_absolute(dir)


## DER of the one CA in pinned TLS options ([] if none or more than one). save_to_string() ends with a NUL, so cut
## at the END line.
func _chain_der(tls: Variant) -> PackedByteArray:
	if not (tls is TLSOptions) or (tls as TLSOptions).get_trusted_ca_chain() == null:
		return PackedByteArray()
	var s := (tls as TLSOptions).get_trusted_ca_chain().save_to_string()
	var end := s.find("-----END CERTIFICATE-----")
	if end < 0 or s.count("-----BEGIN CERTIFICATE-----") != 1:
		return PackedByteArray()
	return Token.pem_single_cert_der(s.substr(0, end + "-----END CERTIFICATE-----".length()))


## Minimal in-process HTTPS server for the real-TLS pin test: one canned JSON answer per request.
class TlsServer extends Node:
	var server := TCPServer.new()
	var opts: TLSOptions
	var peers: Array = []
	var bufs: Array = []
	var served := 0
	var port := 0
	func start(key: CryptoKey, cert: X509Certificate) -> bool:
		opts = TLSOptions.server(key, cert)
		for i in 20:
			port = 41000 + randi() % 8000
			if server.listen(port, "127.0.0.1") == OK:
				return true
		return false
	func _process(_d: float) -> void:
		while server.is_connection_available():
			var tls := StreamPeerTLS.new()
			if tls.accept_stream(server.take_connection(), opts) == OK:
				peers.append(tls)
				bufs.append("")
		for i in peers.size():
			var p: StreamPeerTLS = peers[i]
			if p == null:
				continue
			p.poll()
			if p.get_status() != StreamPeerTLS.STATUS_CONNECTED:
				if p.get_status() != StreamPeerTLS.STATUS_HANDSHAKING:
					peers[i] = null
				continue
			var n := p.get_available_bytes()
			if n > 0:
				bufs[i] += p.get_utf8_string(n)
			if str(bufs[i]).contains("\r\n\r\n"):
				var body := "{\"ok\":true,\"messages\":[]}"
				p.put_data(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s" % [body.length(), body]).to_utf8_buffer())
				p.poll()
				p.disconnect_from_stream()
				peers[i] = null
				served += 1
	func stop() -> void:
		server.stop()


## Real TLS through the real HTTPRequest path: the pin accepts the server whose cert it holds and refuses one it does not,
## so a public/system CA can never stand in for the pin.
func _test_real_tls_pin() -> void:
	var crypto := Crypto.new()
	var key := crypto.generate_rsa(2048)
	var cert := crypto.generate_self_signed_certificate(key, "CN=127.0.0.1,O=VS playtest test,C=US")
	var srv := TlsServer.new()
	if not srv.start(key, cert):
		check(false, "real tls: could not listen on a loopback port")
		return
	root.add_child(srv)
	var dir := _tmp_dir("realtls")
	var dpath := dir.path_join("playtest-device-token")
	var cpath := dir.path_join("playtest-ca.crt")
	Token.write_device_token(dpath, DEV_TOKEN)
	var t := Transport.new()
	t.timeout_sec = 5.0
	t.device_token_path = dpath
	t.ca_cert_path = cpath
	t.server_url = "https://127.0.0.1:%d" % srv.port
	root.add_child(t)
	# pinned to the server's own CA -> 200
	var der := _cert_der(cert)
	check(Token.write_ca_cert(cpath, der) == OK, "real tls: server cert pinned")
	var r: Dictionary = await t.request("GET", "/__vibesquad/tester/thread?teamId=s", null)
	check(r["ok"] and r["status"] == 200 and srv.served == 1, "real tls: request over the pinned CA succeeds (%s)" % str(r.get("error", "")))
	# pinned to a different CA (the fixture) -> handshake refused, nothing served, dock text says TLS/CA
	Token.write_ca_cert(cpath, Token.pem_single_cert_der(CA_PEM))
	r = await t.request("GET", "/__vibesquad/tester/thread?teamId=s", null)
	check(not r["ok"] and str(r["error"]).begins_with("TLS/CA problem") and srv.served == 1, "real tls: a server outside the pin is refused as a TLS/CA problem (%s)" % str(r.get("error", "")).left(40))
	srv.stop()
	srv.queue_free()
	# right (pinned) cert, wrong name -> refused too
	var cert2 := crypto.generate_self_signed_certificate(key, "CN=wrong.example,O=VS playtest test,C=US")
	var srv2 := TlsServer.new()
	srv2.start(key, cert2)
	root.add_child(srv2)
	Token.write_ca_cert(cpath, _cert_der(cert2))
	t.server_url = "https://127.0.0.1:%d" % srv2.port
	r = await t.request("GET", "/__vibesquad/tester/thread?teamId=s", null)
	check(not r["ok"] and str(r["error"]).begins_with("TLS/CA problem") and srv2.served == 0, "real tls: host name is verified against the pinned cert (%s)" % str(r.get("error", "")).left(40))
	srv2.stop()
	srv2.queue_free()
	t.queue_free()
	for file in DirAccess.get_files_at(dir):
		DirAccess.remove_absolute(dir.path_join(file))
	DirAccess.remove_absolute(dir)


func _cert_der(cert: X509Certificate) -> PackedByteArray:
	var s := cert.save_to_string()
	return Token.pem_single_cert_der(s.left(s.find("-----END CERTIFICATE-----") + "-----END CERTIFICATE-----".length()))


# ---------------------------------------------------------------- R2: owner-role warning + B2b lows

## L1: an override that lands inside the project root, or on a UNC share, is refused (never swapped for the default).
func _test_override_path_refusals() -> void:
	var BS := String.chr(92)
	var env := {"VIBESQUAD_HOME": "/tmp/vsh"}
	var getenv := func(k: String) -> String: return env.get(k, "")
	var root := "/work/game"
	for o in ["/work/game/tok", "/work/game/sub/dir/tok", "/work/game/sub/../tok", "/WORK/Game/tok", "/work/game/", "/work/game/x/../../game/tok"]:
		check(Token.device_token_path(o, getenv, root) == "", "L1 device path: inside project root '%s' refused" % o)
		check(Token.ca_cert_path(o, getenv, root) == "", "L1 ca path: inside project root '%s' refused" % o)
	for o in ["C:/work/game/tok", "C:" + BS + "work" + BS + "game" + BS + "tok"]:
		check(Token.device_token_path(o, getenv, "C:/Work/Game") == "", "L1 device path: Windows project-root path '%s' refused" % o.c_escape())
	for o in ["//srv/share/tok", BS + BS + "srv" + BS + "share" + BS + "tok", "//srv/share/ca.crt", BS + BS + "srv" + BS + "share" + BS + "ca.crt"]:
		check(Token.device_token_path(o, getenv, root) == "", "L1 device path: UNC '%s' refused" % o.c_escape())
		check(Token.ca_cert_path(o, getenv, root) == "", "L1 ca path: UNC '%s' refused" % o.c_escape())
	for o in ["/work/gamex/tok", "/work/other/tok", "/work/tok", "/tmp/elsewhere/tok", "C:/Users/x/tok"]:
		check(Token.device_token_path(o, getenv, root) == o, "L1 device path: outside the project '%s' still allowed" % o)
	for o in ["/" + BS + "srv" + BS + "share" + BS + "tok", "/" + BS + "?" + BS + "C:" + BS + "work" + BS + "game" + BS + "tok", BS + "/srv/share/tok", "/" + BS + "?" + BS + "UNC" + BS + "srv" + BS + "share" + BS + "tok"]:
		check(Token.device_token_path(o, getenv, root) == "" and Token.ca_cert_path(o, getenv, root) == "", "L1 mixed-slash UNC / \\\\?\\ '%s' refused" % o.c_escape())
	# symlink outside the project pointing into it (and a link to an outside dir stays allowed)
	if not (OS.get_name() in ["Windows", "Web"]):
		var ldir := _tmp_dir("symlink")
		var proj := ldir.path_join("proj")
		var outside := ldir.path_join("outside")
		DirAccess.make_dir_recursive_absolute(proj.path_join("secrets"))
		DirAccess.make_dir_recursive_absolute(outside)
		var lerr := OS.execute("ln", ["-s", proj, ldir.path_join("link_to_proj")])
		OS.execute("ln", ["-s", proj.path_join("secrets"), outside.path_join("sneaky")])
		OS.execute("ln", ["-s", outside, proj.path_join("to_outside")])
		if lerr == 0:
			check(Token.device_token_path(ldir.path_join("link_to_proj/tok"), getenv, proj) == "", "L1 symlink: link outside -> project dir is refused")
			check(Token.ca_cert_path(outside.path_join("sneaky/ca.crt"), getenv, proj) == "", "L1 symlink: link to a project subfolder is refused")
			check(Token.ca_cert_path(ldir.path_join("link_to_proj"), getenv, proj) == "", "L1 symlink: the link to the root itself is refused")
			check(Token.device_token_path(proj.path_join("to_outside/tok"), getenv, proj) == "", "L1 symlink: textually inside the project still refused")
			check(Token.device_token_path(outside.path_join("tok"), getenv, proj) == outside.path_join("tok"), "L1 symlink: a plain outside path is still allowed")
			# link loop -> fail closed
			OS.execute("ln", ["-s", ldir.path_join("loop_b"), ldir.path_join("loop_a")])
			OS.execute("ln", ["-s", ldir.path_join("loop_a"), ldir.path_join("loop_b")])
			check(Token.device_token_path(ldir.path_join("loop_a/tok"), getenv, proj) == "", "L1 symlink: an unresolvable link loop fails closed")
		else:
			check(false, "L1 symlink: could not create a symlink (ln exit %d)" % lerr)
		OS.execute("rm", ["-rf", ldir])
	var real_root := ProjectSettings.globalize_path("res://")
	check(real_root != "" and Token.device_token_path(real_root.path_join("tok"), getenv) == "", "L1 device path: the real globalized res:// root is used by default")
	check(Token.ca_cert_path(real_root.path_join("addons/ca.crt"), getenv) == "", "L1 ca path: the real res:// root covers subfolders")
	check(Token.ca_cert_path(OS.get_temp_dir().path_join("outside-ca.crt"), getenv) != "", "L1 ca path: a temp-dir path is allowed")
	# the transport resolves through the same rules
	var t := Transport.new()
	t.device_token_path = real_root.path_join("tok")
	t.ca_cert_path = "//srv/share/ca.crt"
	check(t.resolved_device_token_path() == "" and t.resolved_ca_cert_path() == "", "L1 transport: refused overrides resolve to empty")
	t.server_url = "https://forge.tail1234.ts.net:4180"
	check(t._pair_precheck().contains("absolute file path"), "L1 transport: pairing is refused with a path message")
	t.free()


## L3: temp-file write errors are surfaced, the temp is removed, and the temp name is random.
func _test_private_write_failures() -> void:
	var dir := _tmp_dir("wfail")
	check(Token._random_suffix().length() == 32 and Token._random_suffix() != Token._random_suffix(), "L3: temp suffix is 128 random bits (32 hex), different every call")
	# rename onto a directory fails -> error returned, temp cleaned up, no half file
	var target := dir.path_join("playtest-device-token")
	DirAccess.make_dir_recursive_absolute(target)
	var err := Token.write_device_token(target, DEV_TOKEN)
	check(err != OK, "L3: rename failure is returned (%s)" % error_string(err))
	check(DirAccess.get_files_at(dir).is_empty(), "L3: temp file removed after a failed rename (%s)" % ", ".join(DirAccess.get_files_at(dir)))
	# unwritable directory -> open error returned, nothing left, no token in the error
	if not (OS.get_name() in ["Windows", "Web"]) and OS.get_environment("USER") != "root":
		var ro := dir.path_join("ro")
		DirAccess.make_dir_recursive_absolute(ro)
		FileAccess.set_unix_permissions(ro, 320) # 0500
		var rp := ro.path_join("playtest-ca.crt")
		var cerr := Token.write_ca_cert(rp, Token.pem_single_cert_der(CA_PEM))
		check(cerr != OK and not str(error_string(cerr)).contains(DEV_TOKEN), "L3: open failure in an unwritable dir is returned (%s)" % error_string(cerr))
		FileAccess.set_unix_permissions(ro, 448)
		check(DirAccess.get_files_at(ro).is_empty(), "L3: nothing left behind in the unwritable dir")
	# success path leaves only the target
	var ok_path := dir.path_join("good").path_join("playtest-device-token")
	check(Token.write_device_token(ok_path, DEV_TOKEN) == OK and DirAccess.get_files_at(ok_path.get_base_dir()).size() == 1, "L3: a good write leaves exactly the target file")
	for d in [dir.path_join("good"), target, dir.path_join("ro")]:
		for f in DirAccess.get_files_at(d):
			DirAccess.remove_absolute(d.path_join(f))
		DirAccess.remove_absolute(d)
	DirAccess.remove_absolute(dir)


## L2: the pinned CA is read once; the fingerprint and the TLS pin come from the same bytes.
func _test_pinned_state_single_read() -> void:
	var dir := _tmp_dir("pinstate")
	var cpath := dir.path_join("playtest-ca.crt")
	var t := Transport.new()
	t.ca_cert_path = cpath
	var none: Dictionary = t.pinned_state()
	check(none["tls"] == null and none["fingerprint"].is_empty(), "L2: no CA file -> no pin, no fingerprint")
	Token.write_ca_cert(cpath, Token.pem_single_cert_der(CA_PEM))
	var st: Dictionary = t.pinned_state()
	check(st["tls"] != null and st["fingerprint"].get("full") == CA_FP_FULL, "L2: one read gives the pin and its fingerprint")
	check(_chain_der(st["tls"]) == Token.pem_single_cert_der(CA_PEM) and Token.ca_fingerprint(_chain_der(st["tls"]))["full"] == st["fingerprint"]["full"], "L2: fingerprint is computed from the very cert the pin trusts")
	# swapping the file afterwards cannot split a result already taken
	Token.remove_file(cpath)
	check(st["fingerprint"]["full"] == CA_FP_FULL and t.pinned_tls() == null and t.pinned_fingerprint().is_empty(), "L2: a later swap/removal is seen by the next read as a whole, never half")
	t.free()
	DirAccess.remove_absolute(dir)


## R2: a full-owner token shows a one-line dock warning; owner-playtest shows nothing; errors stay quiet.
func _test_role_warning() -> void:
	var logs := LogCapture.new()
	logs.install()
	var dock := Dock.new()
	check(not dock._role_warn.visible and dock._role_warn.text == "Full owner token: re-pair with a Playtest code", "role: dock warning text, hidden by default")
	check(dock._pair_btn.tooltip_text == "Playtest pairing code", "role: pair button tooltip says Playtest pairing code")
	dock.set_pairing(Dock.PAIR_PAIRED)
	dock.set_owner_warning(true)
	check(dock._role_warn.visible, "role: set_owner_warning(true) shows it")
	dock.set_pairing(Dock.PAIR_UNPAIRED)
	check(not dock._role_warn.visible, "role: leaving the paired state hides it")
	dock.free()

	var dir := _tmp_dir("role")
	var dpath := dir.path_join("playtest-device-token")
	var cpath := dir.path_join("playtest-ca.crt")
	Token.write_device_token(dpath, DEV_TOKEN)
	Token.write_ca_cert(cpath, Token.pem_single_cert_der(CA_PEM))
	var cases := [
		["owner", MockHttp.json(200, {"role": "owner", "allowedTeams": null, "deviceName": "Godot playtest"}), true],
		["owner-playtest", MockHttp.json(200, {"role": "owner-playtest", "allowedTeams": null, "deviceName": "Godot playtest"}), false],
		["network error", {"result": HTTPRequest.RESULT_CANT_CONNECT, "code": 0, "text": ""}, false],
		["http 500", MockHttp.json(500, {"error": "boom"}), false],
		["old server (404)", MockHttp.json(404, {"error": "nope"}), false],
		["garbage body", MockHttp.text(200, "<html>"), false],
	]
	for c: Array in cases:
		var on: Node = AutoloadScript.new()
		on.feature_probe = func(f: String) -> bool: return f == "vs_playtest"
		root.add_child(on)
		await process_frame
		var mock := MockHttp.new()
		on._transport.http_fn = Callable(mock, "handle")
		on._transport.device_token_path = dpath
		on._transport.ca_cert_path = cpath
		on._transport.server_url = "https://forge.tail1234.ts.net:4180"
		mock.queue = [c[1]]
		on._refresh_pairing()
		for i in 3:
			await process_frame
		check(_auth_calls(mock) == 0, "role[%s]: no auth/status call before the dock opens" % c[0])
		on.open_dock()
		for i in 3:
			await process_frame
		check(_auth_calls(mock) == 1, "role[%s]: first dock open makes exactly one auth/status call" % c[0])
		on.close_dock()
		on.open_dock()
		on.start_capture()
		for i in 3:
			await process_frame
		check(_auth_calls(mock) == 1, "role[%s]: reopen / capture does not repeat the call" % c[0])
		var rc: Dictionary = {}
		for mc: Dictionary in mock.calls:
			if str(mc.get("url", "")).ends_with("/__vibesquad/auth/status"):
				rc = mc
				break
		check(on._dock.pair_state == Dock.PAIR_PAIRED and str(rc.get("url", "")) == "https://forge.tail1234.ts.net:4180/__vibesquad/auth/status" and _has_header(rc.get("headers", PackedStringArray()), "x-vs-device-token"), "role[%s]: GET auth/status over https with the device token" % c[0])
		check(on._dock._role_warn.visible == c[2], "role[%s]: warning visible == %s" % [c[0], str(c[2])])
		on.queue_free()
	await _test_role_deferral(dpath, cpath)
	# a fresh transport accepts an owner-playtest pairing redeem
	var t := Transport.new()
	var mock2 := MockHttp.new()
	t.http_fn = Callable(mock2, "handle")
	t.server_url = "https://forge.tail1234.ts.net:4180"
	var dir2 := _tmp_dir("role2")
	t.device_token_path = dir2.path_join("playtest-device-token")
	t.ca_cert_path = dir2.path_join("playtest-ca.crt")
	root.add_child(t)
	await _fetch_ca(t, mock2)
	mock2.queue = [MockHttp.json(200, {"ok": true, "state": "paired", "token": DEV_TOKEN_2, "role": "owner-playtest"})]
	var r: Dictionary = await t.pair("123456", CA_FP_FULL)
	check(r["ok"] and r["state"] == "paired" and t.is_paired(), "role: pairing with an owner-playtest code is accepted")
	check(not str(logs.last_lines(1000)).contains(DEV_TOKEN) and not str(logs.last_lines(1000)).contains(DEV_TOKEN_2), "role: no token in any log line")
	t.unpair()
	t.queue_free()
	logs.uninstall()
	for d in [dir, dir2]:
		for f in DirAccess.get_files_at(d):
			DirAccess.remove_absolute(d.path_join(f))
		DirAccess.remove_absolute(d)


## idea-878 review: F3 capture as the first trigger, and a re-pair in the open dock re-checks the role at once.
func _test_role_deferral(dpath: String, cpath: String) -> void:
	var on: Node = AutoloadScript.new()
	on.feature_probe = func(f: String) -> bool: return f == "vs_playtest"
	root.add_child(on)
	await process_frame
	var mock := MockHttp.new()
	on._transport.http_fn = Callable(mock, "handle")
	on._transport.sleep_fn = func(_s: float) -> void: pass
	on._transport.device_token_path = dpath
	on._transport.ca_cert_path = cpath
	on._transport.server_url = "https://forge.tail1234.ts.net:4180"
	mock.queue = [MockHttp.json(200, {"role": "owner-playtest"})]
	on._refresh_pairing()
	await process_frame
	check(_auth_calls(mock) == 0, "role-defer(a): no call before the first capture")
	on.start_capture()
	for i in 3:
		await process_frame
	check(_auth_calls(mock) == 1, "role-defer(a): F3 capture as first trigger makes exactly one call")
	on.start_capture()
	on.open_dock()
	for i in 3:
		await process_frame
	check(_auth_calls(mock) == 1, "role-defer(a): repeat capture / dock open makes no further call")
	# (b) dock open + checked; unpair; pair a different device with the dock still open
	mock.calls.clear()
	on.unpair()
	check(on._dock.pair_state == Dock.PAIR_UNPAIRED, "role-defer(b): unpaired")
	await _fetch_ca(on._transport, mock)
	on._pending_code = "123456"
	on._pending_fp = CA_FP_FULL
	mock.queue = [MockHttp.json(200, {"ok": true, "state": "paired", "token": DEV_TOKEN_2, "role": "owner", "allowedTeams": null, "hostId": "h"}), MockHttp.json(200, {"role": "owner"})]
	var before := _auth_calls(mock)
	on.open_dock()
	await on._on_ca_confirmed(true)
	for i in 3:
		await process_frame
	check(on._dock.visible and on._dock.pair_state == Dock.PAIR_PAIRED and _auth_calls(mock) - before == 1, "role-defer(b): pairing in the open dock makes exactly one new auth/status call, no reopen")
	on.close_dock()
	on.queue_free()
	await process_frame


func _auth_calls(mock: MockHttp) -> int:
	var n := 0
	for mc: Dictionary in mock.calls:
		if str(mc.get("url", "")).ends_with("/__vibesquad/auth/status"):
			n += 1
	return n


func _key_event(code: Key, mods: Dictionary = {}) -> InputEventKey:
	var e := InputEventKey.new()
	e.keycode = code
	e.pressed = true
	e.shift_pressed = mods.get("shift", false)
	e.ctrl_pressed = mods.get("ctrl", false)
	e.alt_pressed = mods.get("alt", false)
	return e


func _test_hotkeys() -> void:
	var saved_dock: Variant = ProjectSettings.get_setting("vs_playtest/hotkey_dock") if ProjectSettings.has_setting("vs_playtest/hotkey_dock") else null
	var saved_bug: Variant = ProjectSettings.get_setting("vs_playtest/hotkey_bug") if ProjectSettings.has_setting("vs_playtest/hotkey_bug") else null
	ProjectSettings.set_setting("vs_playtest/hotkey_dock", null)
	ProjectSettings.set_setting("vs_playtest/hotkey_bug", null)
	# (1) defaults
	check(Settings.get_str(Settings.HOTKEY_DOCK) == "F4" and Settings.get_str(Settings.HOTKEY_BUG) == "F3", "hotkeys: unset settings resolve to F4/F3")
	var on: Node = AutoloadScript.new()
	on.feature_probe = func(f: String) -> bool: return f == "vs_playtest"
	root.add_child(on)
	await process_frame
	check(on._hotkey_dock == KEY_F4 and on._hotkey_bug == KEY_F3, "hotkeys: unset settings -> KEY_F4/KEY_F3")
	# (3) behaviour with the defaults
	on.grab_fn = func() -> Image: return null
	on.register_adapter(FullAdapter.new())
	on._input(_key_event(KEY_F4))
	check(on._dock.visible, "hotkeys: F4 opens the dock")
	on._input(_key_event(KEY_F4))
	check(not on._dock.visible, "hotkeys: F4 again closes the dock")
	on._input(_key_event(KEY_F8))
	on._input(_key_event(KEY_F9))
	check(not on._dock.visible and not on._capturing, "hotkeys: F8/F9 are ignored by default")
	# L1: modifiers are not swallowed
	for m in [{"shift": true}, {"ctrl": true}, {"alt": true}]:
		on._input(_key_event(KEY_F4, m))
		on._input(_key_event(KEY_F3, m))
	check(not on._dock.visible and not on._capturing, "hotkeys: Shift/Ctrl/Alt+F3/F4 are ignored")
	on._input(_key_event(KEY_F3))
	await process_frame
	check(on._capturing, "hotkeys: F3 starts a capture")
	on._overlay.pick_done.emit(false, Vector2.ZERO)
	await process_frame
	check(not on._capturing, "hotkeys: capture cancelled")
	on.queue_free()
	# (2) a saved override survives register_all() and is picked up by _ready()
	ProjectSettings.set_setting("vs_playtest/hotkey_dock", "F6")
	ProjectSettings.set_setting("vs_playtest/hotkey_bug", "F7")
	Settings.register_all()
	check(Settings.get_str(Settings.HOTKEY_DOCK) == "F6" and Settings.get_str(Settings.HOTKEY_BUG) == "F7", "hotkeys: saved override survives register_all()")
	var ov: Node = AutoloadScript.new()
	ov.feature_probe = func(f: String) -> bool: return f == "vs_playtest"
	root.add_child(ov)
	await process_frame
	check(ov._hotkey_dock == KEY_F6 and ov._hotkey_bug == KEY_F7, "hotkeys: _ready() uses the saved override")
	ov._input(_key_event(KEY_F6))
	check(ov._dock.visible, "hotkeys: overridden dock key works")
	ov._input(_key_event(KEY_F4))
	check(ov._dock.visible, "hotkeys: default key no longer toggles after override")
	ov.queue_free()
	ProjectSettings.set_setting("vs_playtest/hotkey_dock", saved_dock)
	ProjectSettings.set_setting("vs_playtest/hotkey_bug", saved_bug)
