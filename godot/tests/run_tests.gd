extends SceneTree
## Headless tests: godot --headless --path godot -s tests/run_tests.gd   (run `--import` once first on a fresh checkout)
## Exit code = number of failed checks.

const Token := preload("res://addons/vs_playtest/token.gd")
const Payload := preload("res://addons/vs_playtest/payload.gd")
const ReportClient := preload("res://addons/vs_playtest/report_client.gd")
const AutoloadScript := preload("res://addons/vs_playtest/vs_playtest.gd")

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
