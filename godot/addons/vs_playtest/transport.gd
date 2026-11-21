extends Node
## The only file that knows the wire shape. request(method, path, body) -> {ok, status, data, error}.
## status: HTTP code; 0 = network failure (retryable); -1 = refused locally (no token / egress rule / redirect; not retryable).
## Two auth modes, picked from server_url (Token.auth_mode): loopback -> the local token (x-vibesquad-token), as in B2;
## anything else -> the E6a owner device token (x-vs-device-token), only where Token.is_device_egress_allowed says so.
## No cookie is ever sent, redirects are never followed, and no token is ever put in an error, a print or a log line.

const Token := preload("res://addons/vs_playtest/token.gd")

const PAIR_PATH := "/pair"
const PAIR_STATUS_PATH := "/pair/status"
const PAIR_CLIENT_NAME := "Godot playtest"

var server_url: String = ""
var timeout_sec: float = 20.0
## The vs_playtest/device_token_path setting as typed ("" = the default file). Resolved by Token.device_token_path(),
## so a refused override (res://, user://, relative) resolves to "" and is reported, never swapped for the default.
var device_token_path: String = ""
## "" = Token.token_path(). Test seam.
var local_token_path: String = ""
## Test seam: Callable(url: String, headers: PackedStringArray, method: int, body: String) -> {result: int, code: int, text: String}
## (may be a coroutine). Default: a real HTTPRequest with max_redirects = 0.
var http_fn: Callable = Callable()
## Callable(seconds: float), may be a coroutine; used while a pairing waits for approval. Default: a SceneTree timer.
var sleep_fn: Callable = Callable()
var pair_poll_sec: float = 2.0
var pair_timeout_sec: float = 75.0 # server PENDING_TTL_MS is 60 s


func auth_mode() -> String:
	return Token.auth_mode(server_url)


func resolved_device_token_path() -> String:
	return Token.device_token_path(device_token_path)


## Why the device token may not go to server_url, or "" when it may (and in local mode).
func device_refusal() -> String:
	if auth_mode() == Token.MODE_LOCAL or Token.is_device_egress_allowed(server_url):
		return ""
	return "refusing to send the device token to %s: only loopback, Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48, *.ts.net) or https:// servers get it" % Token.redact_url(server_url)


func request(method: String, path: String, body: Variant = null) -> Dictionary:
	var headers := PackedStringArray(["Content-Type: application/json"])
	if auth_mode() == Token.MODE_LOCAL:
		var lpath := local_token_path if local_token_path != "" else Token.token_path()
		var token := Token.read_token(lpath)
		if token == "":
			return _fail(-1, "no VibeSquad local token at %s (is VibeSquad installed and started?)" % lpath)
		headers.append("%s: %s" % [Token.HEADER, token])
	else:
		var refusal := device_refusal()
		if refusal != "":
			return _fail(-1, refusal)
		var dpath := resolved_device_token_path()
		if dpath == "":
			return _fail(-1, "vs_playtest/device_token_path must be an absolute file path outside the project (not res:// or user://)")
		var dtoken := Token.read_device_token(dpath)
		if dtoken == "":
			return _fail(-1, "not paired with VibeSquad: use Pair with VS in the dock (device token file: %s)" % dpath)
		headers.append("%s: %s" % [Token.DEVICE_HEADER, dtoken])
	var m := HTTPClient.METHOD_POST if method == "POST" else HTTPClient.METHOD_GET
	var payload := "" if body == null else JSON.stringify(body)
	var raw: Dictionary = await _send(server_url + path, headers, m, payload)
	var res := _response(raw)
	if not bool(res["ok"]) and int(res["status"]) == 401 and auth_mode() == Token.MODE_DEVICE:
		res["error"] = "VibeSquad no longer accepts this device (revoked?): Unpair, then Pair with VS again"
	return res


## E6a JSON pair redeem (server/auth.mjs handlePairRedeem): GET /pair?code=…&format=json -> {ok, state: paired|pending,
## token, role}. A pending device polls GET /pair/status with the token header until approved / denied / gone.
## Only an owner-role token is kept. The token goes straight to the token file; the result never carries it.
## -> {ok, state, error}
func pair(code: String) -> Dictionary:
	if auth_mode() == Token.MODE_LOCAL:
		return _pair_fail("", "server_url is this PC (loopback): the local token is used, no pairing needed")
	var refusal := device_refusal()
	if refusal != "":
		return _pair_fail("", refusal.replace("the device token", "a pairing code"))
	var dpath := resolved_device_token_path()
	if dpath == "":
		return _pair_fail("", "vs_playtest/device_token_path must be an absolute file path outside the project (not res:// or user://)")
	var digits := code.strip_edges().replace("-", "").replace(" ", "")
	var re := RegEx.new()
	re.compile(r"^\d{6}$")
	if re.search(digits) == null:
		return _pair_fail("invalid", "enter the 6-digit pairing code from VibeSquad")
	var q := "?code=%s&format=json&name=%s" % [digits, PAIR_CLIENT_NAME.uri_encode()]
	var raw: Dictionary = await _send(server_url + PAIR_PATH + q, PackedStringArray(["Accept: application/json"]), HTTPClient.METHOD_GET, "")
	var res := _response(raw)
	var data: Dictionary = res["data"]
	if not bool(res["ok"]):
		var why := str(data.get("error", res["error"]))
		if int(res["status"]) == 429:
			why += " (try again in %d s)" % int(data.get("retryAfterSecs", 60))
		return _pair_fail(str(data.get("state", "error")), "pairing failed: %s" % why)
	var token := str(data.get("token", ""))
	var state := str(data.get("state", ""))
	if not Token.is_valid_device_token(token) or not (state in ["paired", "pending"]):
		return _pair_fail("error", "pairing failed: unexpected answer from the server")
	if str(data.get("role", "owner")) != "owner":
		return _pair_fail("wrong-role", "that code pairs a %s device; mint an owner pairing code in VibeSquad (Pair Device / vs pair)" % str(data.get("role")))
	if state == "pending":
		var final := "timeout"
		var waited := 0.0
		while waited < pair_timeout_sec:
			await _sleep(pair_poll_sec)
			waited += pair_poll_sec
			var sraw: Dictionary = await _send(server_url + PAIR_STATUS_PATH, PackedStringArray(["Accept: application/json", "%s: %s" % [Token.DEVICE_HEADER, token]]), HTTPClient.METHOD_GET, "")
			var sres := _response(sraw)
			if not bool(sres["ok"]):
				continue # transient: keep polling until the window closes
			var s := str(sres["data"].get("state", "gone"))
			if s == "pending":
				continue
			if s == "approved" and str(sres["data"].get("role", "owner")) != "owner":
				return _pair_fail("wrong-role", "the approved device is not an owner device; mint an owner pairing code")
			final = s
			break
		if final != "approved":
			var msg := "was denied on the device that minted the code" if final == "denied" else "was not approved in time"
			return _pair_fail(final, "pairing %s; ask VibeSquad for a new code" % msg)
	var err := Token.write_device_token(dpath, token)
	token = ""
	if err != OK:
		return _pair_fail("error", "paired, but the token file %s could not be written (%s); revoke this device in VibeSquad and pair again" % [dpath, error_string(err)])
	return {"ok": true, "state": "paired", "error": ""}


## Deletes the device token file. true when no token file is left.
func unpair() -> bool:
	return Token.remove_device_token(resolved_device_token_path())


func is_paired() -> bool:
	return Token.read_device_token(resolved_device_token_path()) != ""


# ---------------------------------------------------------------- internals

func _send(url: String, headers: PackedStringArray, method: int, payload: String) -> Dictionary:
	if http_fn.is_valid():
		return await http_fn.call(url, headers, method, payload)
	var http := HTTPRequest.new()
	http.timeout = timeout_sec
	http.max_redirects = 0 # never follow a redirect with a token or a pairing code attached
	add_child(http)
	var err := http.request(url, headers, method, payload)
	if err != OK:
		http.queue_free()
		return {"result": -1, "code": 0, "text": "", "start_error": err}
	var res: Array = await http.request_completed
	http.queue_free()
	return {"result": int(res[0]), "code": int(res[1]), "text": (res[3] as PackedByteArray).get_string_from_utf8()}


func _response(raw: Dictionary) -> Dictionary:
	if raw.has("start_error"):
		return _fail(0, "request failed to start (%s)" % error_string(int(raw["start_error"])))
	var result := int(raw.get("result", HTTPRequest.RESULT_SUCCESS))
	if result == HTTPRequest.RESULT_REDIRECT_LIMIT_REACHED:
		return _fail(-1, "the server answered with a redirect, which is never followed with a token (if it is the VS https listener, set vs_playtest/server_url to its https:// address)")
	if result == HTTPRequest.RESULT_TLS_HANDSHAKE_ERROR:
		return _fail(-1, "TLS handshake with %s failed (does this PC trust the VibeSquad CA from /ca.crt, and does the name match?)" % Token.redact_url(server_url))
	if result != HTTPRequest.RESULT_SUCCESS:
		return _fail(0, "network error %d" % result)
	var code := int(raw.get("code", 0))
	if code >= 300 and code < 400:
		return _fail(-1, "the server answered with a redirect (HTTP %d), which is never followed with a token" % code)
	var json := JSON.new() # not parse_string: an empty/HTML body must not print an engine error
	var data: Dictionary = {}
	if json.parse(str(raw.get("text", ""))) == OK and json.data is Dictionary:
		data = json.data
	var ok := code >= 200 and code < 300
	return {"ok": ok, "status": code, "data": data, "error": "" if ok else str(data.get("error", "HTTP %d" % code))}


func _sleep(sec: float) -> void:
	if sleep_fn.is_valid():
		await sleep_fn.call(sec)
	elif is_inside_tree():
		await get_tree().create_timer(sec).timeout


func _pair_fail(state: String, msg: String) -> Dictionary:
	return {"ok": false, "state": state, "error": msg}


func _fail(status: int, msg: String) -> Dictionary:
	return {"ok": false, "status": status, "data": {}, "error": msg}
