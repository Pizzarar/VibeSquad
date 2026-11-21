extends Node
## The only file that knows the wire shape. request(method, path, body) -> {ok, status, data, error}.
## status: HTTP code; 0 = network failure (retryable); -1 = refused locally (no token / non-loopback; not retryable).

const Token := preload("res://addons/vs_playtest/token.gd")

var server_url: String = ""
var timeout_sec: float = 20.0


func request(method: String, path: String, body: Variant = null) -> Dictionary:
	if not Token.is_loopback(server_url):
		return _fail(-1, "refusing to send the local token to a non-loopback server: %s" % server_url)
	var token := Token.read_token(Token.token_path())
	if token == "":
		return _fail(-1, "no VibeSquad local token at %s (is VibeSquad installed and started?)" % Token.token_path())
	var http := HTTPRequest.new()
	http.timeout = timeout_sec
	add_child(http)
	var headers := PackedStringArray(["Content-Type: application/json", "%s: %s" % [Token.HEADER, token]])
	var m := HTTPClient.METHOD_POST if method == "POST" else HTTPClient.METHOD_GET
	var payload := "" if body == null else JSON.stringify(body)
	var err := http.request(server_url + path, headers, m, payload)
	if err != OK:
		http.queue_free()
		return _fail(0, "request failed to start (%s)" % error_string(err))
	var res: Array = await http.request_completed
	http.queue_free()
	if int(res[0]) != HTTPRequest.RESULT_SUCCESS:
		return _fail(0, "network error %d" % int(res[0]))
	var code := int(res[1])
	var json := JSON.new() # not parse_string: an empty/HTML body must not print an engine error
	var data: Dictionary = {}
	if json.parse((res[3] as PackedByteArray).get_string_from_utf8()) == OK and json.data is Dictionary:
		data = json.data
	var ok := code >= 200 and code < 300
	return {"ok": ok, "status": code, "data": data, "error": "" if ok else str(data.get("error", "HTTP %d" % code))}


func _fail(status: int, msg: String) -> Dictionary:
	return {"ok": false, "status": status, "data": {}, "error": msg}
