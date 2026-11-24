extends Node
## The only file that knows the wire shape. request(method, path, body) -> {ok, status, data, error}.
## status: HTTP code; 0 = network failure (retryable); -1 = refused locally (no token / egress rule / redirect; not retryable).
## Two auth modes, picked from server_url (Token.auth_mode): loopback -> the local token (x-vibesquad-token), as in B2;
## anything else -> the E6a owner device token (x-vs-device-token), only to an https:// server_url and only over TLS
## pinned to the owner-confirmed VS CA (Token.pinned_tls; no pin -> no token, the system trust store is never used).
## No cookie is ever sent, redirects are never followed, and no token is ever put in an error, a print or a log line.

const Token := preload("res://addons/vs_playtest/token.gd")

const PAIR_PATH := "/pair"
const PAIR_STATUS_PATH := "/pair/status"
const PAIR_CLIENT_NAME := "Godot playtest"
const AUTH_STATUS_PATH := "/__vibesquad/auth/status" # server/auth.mjs: {role, allowedTeams, deviceName}
const ROLE_OWNER := "owner" # full-owner device (re-pair with a Playtest code)
const ROLE_PLAYTEST := "owner-playtest" # least-privilege: report/thread only
const CA_MAX_BYTES := 65536 # the /ca.crt bootstrap answer is a few KB

var server_url: String = ""
var timeout_sec: float = 20.0
## The vs_playtest/device_token_path setting as typed ("" = the default file). Resolved by Token.device_token_path(),
## so a refused override (res://, user://, relative) resolves to "" and is reported, never swapped for the default.
var device_token_path: String = ""
## The vs_playtest/ca_cert_path setting as typed ("" = the default file); same refusals as device_token_path.
var ca_cert_path: String = ""
## "" = Token.token_path(). Test seam.
var local_token_path: String = ""
## Test seam: Callable(url: String, headers: PackedStringArray, method: int, body: String) -> {result: int, code: int, text: String}
## (may be a coroutine). Default: a real HTTPRequest with max_redirects = 0.
var http_fn: Callable = Callable()
## Callable(seconds: float), may be a coroutine; used while a pairing waits for approval. Default: a SceneTree timer.
var sleep_fn: Callable = Callable()
var pair_poll_sec: float = 2.0
var pair_timeout_sec: float = 75.0 # server PENDING_TTL_MS is 60 s

## The CA fetched by fetch_ca(), held in memory until the owner confirms its fingerprint (pair()); never trusted before.
var _pending_ca_der := PackedByteArray()


func auth_mode() -> String:
	return Token.auth_mode(server_url)


func resolved_device_token_path() -> String:
	return Token.device_token_path(device_token_path)


func resolved_ca_cert_path() -> String:
	return Token.ca_cert_path(ca_cert_path)


## The pinned CA read ONCE: {tls: TLSOptions|null, fingerprint: {full, short}|{}}. Both come from the same bytes, so the
## fingerprint the owner sees is always the cert the TLS pin uses (no second read for a file swap to slip between).
func pinned_state() -> Dictionary:
	var der := Token.read_ca_der(resolved_ca_cert_path())
	if der.is_empty():
		return {"tls": null, "fingerprint": {}}
	var tls := Token.pinned_tls(der)
	return {"tls": tls, "fingerprint": {} if tls == null else Token.ca_fingerprint(der)}


## TLS options trusting only the pinned VS CA, or null when there is no (valid) pin.
func pinned_tls() -> TLSOptions:
	return pinned_state()["tls"]


## Fingerprint of the pinned CA ({full, short}), or {} when there is no pin.
func pinned_fingerprint() -> Dictionary:
	return pinned_state()["fingerprint"]


## Why the device token may not go to server_url, or "" when it may (and in local mode).
func device_refusal() -> String:
	if auth_mode() == Token.MODE_LOCAL or Token.is_device_egress_allowed(server_url):
		return ""
	return "refusing to send the device token to %s: a remote vs_playtest/server_url must be the https:// address of VibeSquad (e.g. https://<forge>.<tailnet>.ts.net:<port>)" % Token.redact_url(server_url)


## Why device calls can't run yet because of a setting (refused path / no CA pin), or "".
func pin_refusal() -> String:
	return _pin_refusal(pinned_tls())


func _pin_refusal(tls: TLSOptions) -> String:
	if resolved_ca_cert_path() == "":
		return "vs_playtest/ca_cert_path must be an absolute file path outside the project (not res:// or user://, not a network share)"
	if tls == null:
		return "no pinned VibeSquad CA (%s), so the device token is not sent: Pair with VS fetches the CA and asks you to confirm its fingerprint" % resolved_ca_cert_path()
	return ""


func request(method: String, path: String, body: Variant = null) -> Dictionary:
	var headers := PackedStringArray(["Content-Type: application/json"])
	var tls: TLSOptions = null
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
			return _fail(-1, "vs_playtest/device_token_path must be an absolute file path outside the project (not res:// or user://, not inside the project, not a network share)")
		tls = pinned_tls() # one read of the CA file, used for the check and the call
		var pin_why := _pin_refusal(tls)
		if pin_why != "":
			return _fail(-1, pin_why)
		var dtoken := Token.read_device_token(dpath)
		if dtoken == "":
			return _fail(-1, "not paired with VibeSquad: use Pair with VS in the dock (device token file: %s)" % dpath)
		headers.append("%s: %s" % [Token.DEVICE_HEADER, dtoken])
	var m := HTTPClient.METHOD_POST if method == "POST" else HTTPClient.METHOD_GET
	var payload := "" if body == null else JSON.stringify(body)
	var raw: Dictionary = await _send(server_url + path, headers, m, payload, tls)
	var res := _response(raw)
	if not bool(res["ok"]) and int(res["status"]) == 401 and auth_mode() == Token.MODE_DEVICE:
		res["error"] = "VibeSquad no longer accepts this device (revoked?): Unpair, then Pair with VS again"
	return res


## The role the server gives this device token ("owner", "owner-playtest", ...), or "" when unknown (not paired, network
## error, odd answer): the caller shows nothing then. Never raises, never returns the token.
func fetch_role() -> String:
	if auth_mode() != Token.MODE_DEVICE or not is_paired():
		return ""
	var res: Dictionary = await request("GET", AUTH_STATUS_PATH, null)
	if not bool(res.get("ok", false)):
		return ""
	return str(res["data"].get("role", ""))


## Step 1 of pairing (PLAN_V1 "Remote is https only"): GET http://<host>:<port>/ca.crt, the one plain-http remote
## call, with no token, no code and no cookie. The CA is held in memory (not trusted, not saved) until the owner
## confirms its fingerprint against the VS Pair Device dialog and pair() runs. -> {ok, fingerprint: {full, short}, error}
func fetch_ca() -> Dictionary:
	_pending_ca_der = PackedByteArray()
	var why := _pair_precheck()
	if why != "":
		return {"ok": false, "fingerprint": {}, "error": why}
	var url := Token.ca_bootstrap_url(server_url)
	var raw: Dictionary = await _send(url, PackedStringArray(["Accept: application/x-x509-ca-cert"]), HTTPClient.METHOD_GET, "", null, CA_MAX_BYTES)
	var result := int(raw.get("result", HTTPRequest.RESULT_SUCCESS))
	var code := int(raw.get("code", 0))
	if raw.has("start_error") or result != HTTPRequest.RESULT_SUCCESS:
		return {"ok": false, "fingerprint": {}, "error": "could not fetch the VibeSquad CA from %s (network error %d): is VibeSquad running there with remote access on?" % [Token.redact_url(url), int(raw.get("start_error", result))]}
	if code != 200:
		return {"ok": false, "fingerprint": {}, "error": "could not fetch the VibeSquad CA from %s (HTTP %d)" % [Token.redact_url(url), code]}
	var der := Token.pem_single_cert_der(str(raw.get("text", "")))
	if der.is_empty():
		return {"ok": false, "fingerprint": {}, "error": "%s did not return a single PEM certificate" % Token.redact_url(url)}
	_pending_ca_der = der
	return {"ok": true, "fingerprint": Token.ca_fingerprint(der), "error": ""}


## Drops a fetched-but-unconfirmed CA.
func cancel_ca() -> void:
	_pending_ca_der = PackedByteArray()


## Step 2: the owner confirmed `confirmed_fp` (the full fingerprint fetch_ca() showed). Then the E6a JSON pair redeem
## (server/auth.mjs handlePairRedeem) runs over https pinned to that CA: GET /pair?code=…&format=json -> {ok, state:
## paired|pending, token, role}; a pending device polls GET /pair/status with the token header until approved / denied /
## gone. Only an owner / owner-playtest token is kept. On success the CA is saved, then the token; the result never carries it.
## -> {ok, state, error}
func pair(code: String, confirmed_fp: String = "") -> Dictionary:
	var why := _pair_precheck()
	if why != "":
		return _pair_fail("", why)
	var dpath := resolved_device_token_path()
	var cpath := resolved_ca_cert_path()
	var digits := normalize_code(code)
	if digits == "":
		return _pair_fail("invalid", "enter the 6-digit pairing code from VibeSquad")
	var der := _pending_ca_der
	if der.is_empty() or confirmed_fp == "" or str(Token.ca_fingerprint(der)["full"]) != confirmed_fp:
		return _pair_fail("unconfirmed", "confirm the VibeSquad CA fingerprint first (Pair with VS fetches it)")
	var tls := Token.pinned_tls(der)
	var q := "?code=%s&format=json&name=%s" % [digits, PAIR_CLIENT_NAME.uri_encode()]
	var raw: Dictionary = await _send(server_url + PAIR_PATH + q, PackedStringArray(["Accept: application/json"]), HTTPClient.METHOD_GET, "", tls)
	var res := _response(raw, true)
	var data: Dictionary = res["data"]
	if not bool(res["ok"]):
		var reason := str(data.get("error", res["error"]))
		if int(res["status"]) == 429:
			reason += " (try again in %d s)" % int(data.get("retryAfterSecs", 60))
		return _pair_fail(str(data.get("state", "error")), "pairing failed: %s" % reason)
	var token := str(data.get("token", ""))
	var state := str(data.get("state", ""))
	if not Token.is_valid_device_token(token) or not (state in ["paired", "pending"]):
		return _pair_fail("error", "pairing failed: unexpected answer from the server")
	if not (str(data.get("role", ROLE_OWNER)) in [ROLE_OWNER, ROLE_PLAYTEST]):
		return _pair_fail("wrong-role", "that code pairs a %s device; mint a Playtest code in VibeSquad (Pair Device dialog)" % str(data.get("role")))
	if state == "pending":
		var final := "timeout"
		var waited := 0.0
		while waited < pair_timeout_sec:
			await _sleep(pair_poll_sec)
			waited += pair_poll_sec
			var sraw: Dictionary = await _send(server_url + PAIR_STATUS_PATH, PackedStringArray(["Accept: application/json", "%s: %s" % [Token.DEVICE_HEADER, token]]), HTTPClient.METHOD_GET, "", tls)
			var sres := _response(sraw, true)
			if not bool(sres["ok"]):
				continue # transient: keep polling until the window closes
			var s := str(sres["data"].get("state", "gone"))
			if s == "pending":
				continue
			if s == "approved" and not (str(sres["data"].get("role", ROLE_OWNER)) in [ROLE_OWNER, ROLE_PLAYTEST]):
				return _pair_fail("wrong-role", "the approved device is not a Playtest device; mint a Playtest code")
			final = s
			break
		if final != "approved":
			var msg := "was denied on the device that minted the code" if final == "denied" else "was not approved in time"
			return _pair_fail(final, "pairing %s; ask VibeSquad for a new code" % msg)
	var cerr := Token.write_ca_cert(cpath, der)
	var err := cerr if cerr != OK else Token.write_device_token(dpath, token)
	token = ""
	if err != OK:
		Token.remove_file(dpath)
		Token.remove_file(cpath)
		var what := ("CA file " + cpath) if cerr != OK else ("token file " + dpath)
		return _pair_fail("error", "paired, but the %s could not be written (%s); revoke this device in VibeSquad and pair again" % [what, error_string(err)])
	_pending_ca_der = PackedByteArray()
	return {"ok": true, "state": "paired", "error": ""}


## 6 digits (spaces / dashes dropped), or "".
static func normalize_code(code: String) -> String:
	var digits := code.strip_edges().replace("-", "").replace(" ", "")
	var re := RegEx.new()
	re.compile(r"^\d{6}$")
	return digits if re.search(digits) != null else ""


## Why pairing can't start with the current settings, or "".
func _pair_precheck() -> String:
	if auth_mode() == Token.MODE_LOCAL:
		return "server_url is this PC (loopback): the local token is used, no pairing needed"
	var refusal := device_refusal()
	if refusal != "":
		return refusal.replace("the device token", "a pairing code")
	if resolved_device_token_path() == "":
		return "vs_playtest/device_token_path must be an absolute file path outside the project (not res:// or user://, not inside the project, not a network share)"
	if resolved_ca_cert_path() == "":
		return "vs_playtest/ca_cert_path must be an absolute file path outside the project (not res:// or user://, not inside the project, not a network share)"
	return ""


## Deletes the device token file and the pinned CA file. true when neither is left.
func unpair() -> bool:
	_pending_ca_der = PackedByteArray()
	var tok_gone := Token.remove_file(resolved_device_token_path())
	var ca_gone := Token.remove_file(resolved_ca_cert_path())
	return tok_gone and ca_gone


## A valid device token AND a valid pinned CA are stored (a token without a pin is never sent).
func is_paired() -> bool:
	return Token.read_device_token(resolved_device_token_path()) != "" and pinned_tls() != null


# ---------------------------------------------------------------- internals

## `tls`: the pinned-CA options for an https call. An https URL without them is refused here, so the system trust store
## is never used. `body_limit` > 0 caps the response size (the CA bootstrap).
func _send(url: String, headers: PackedStringArray, method: int, payload: String, tls: TLSOptions = null, body_limit: int = -1) -> Dictionary:
	if url.to_lower().begins_with("https://") and tls == null:
		return {"result": -1, "code": 0, "text": "", "start_error": ERR_UNAUTHORIZED}
	if http_fn.is_valid():
		return await http_fn.call(url, headers, method, payload, tls)
	var http := HTTPRequest.new()
	http.timeout = timeout_sec
	http.max_redirects = 0 # never follow a redirect with a token or a pairing code attached
	if body_limit > 0:
		http.body_size_limit = body_limit
	if tls != null:
		http.set_tls_options(tls)
	add_child(http)
	var err := http.request(url, headers, method, payload)
	if err != OK:
		http.queue_free()
		return {"result": -1, "code": 0, "text": "", "start_error": err}
	var res: Array = await http.request_completed
	http.queue_free()
	return {"result": int(res[0]), "code": int(res[1]), "text": (res[3] as PackedByteArray).get_string_from_utf8()}


## `pairing`: the TLS message points at the fingerprint just confirmed instead of the stored pin.
func _response(raw: Dictionary, pairing: bool = false) -> Dictionary:
	if raw.has("start_error"):
		return _fail(0, "request failed to start (%s)" % error_string(int(raw["start_error"])))
	var result := int(raw.get("result", HTTPRequest.RESULT_SUCCESS))
	if result == HTTPRequest.RESULT_REDIRECT_LIMIT_REACHED:
		return _fail(-1, "the server answered with a redirect, which is never followed with a token (if it is the VS https listener, set vs_playtest/server_url to its https:// address)")
	if result == HTTPRequest.RESULT_TLS_HANDSHAKE_ERROR:
		if pairing:
			return _fail(-1, "TLS/CA problem: %s did not present a certificate from the CA you just confirmed, or not for this host name (check server_url, and VIBESQUAD_MESHNET_HOST on the VS host for a MagicDNS name)" % Token.redact_url(server_url))
		return _fail(-1, "TLS/CA problem: %s did not present a certificate from the pinned VibeSquad CA, or not for this host name. If VibeSquad's CA changed, Unpair and Pair with VS again" % Token.redact_url(server_url))
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
