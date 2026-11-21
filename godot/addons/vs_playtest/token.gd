extends RefCounted
## Local-token + server-URL discovery. Mirrors server/local-token.mjs:
## token file = $VIBESQUAD_HOME/local-token else <home>/.vibesquad/local-token (64 lowercase hex chars), header x-vibesquad-token.

const HEADER := "x-vibesquad-token"
const DEFAULT_PORT := 4180 # server/serve.mjs:65 (VIBESQUAD_PORT || 4180)


## `getenv`: Callable(name: String) -> String; injectable for tests.
static func token_path(getenv: Callable = OS.get_environment) -> String:
	var home: String = String(getenv.call("VIBESQUAD_HOME")).strip_edges()
	if home == "":
		var user_home: String = String(getenv.call("USERPROFILE")).strip_edges() # Windows
		if user_home == "":
			user_home = String(getenv.call("HOME")).strip_edges()
		if user_home == "":
			return ""
		home = user_home.path_join(".vibesquad")
	return home.path_join("local-token")


## The token, or "" when the file is missing/malformed.
static func read_token(path: String) -> String:
	if path == "" or not FileAccess.file_exists(path):
		return ""
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ""
	var t := f.get_as_text().strip_edges()
	if t.length() != 64:
		return ""
	for c in t:
		if not ("0123456789abcdef".contains(c)):
			return ""
	return t


## Explicit setting wins; else http://127.0.0.1:$VIBESQUAD_PORT; else :4180.
static func server_url(setting: String, getenv: Callable = OS.get_environment) -> String:
	var s := setting.strip_edges().rstrip("/")
	if s != "":
		return s
	var port := int(String(getenv.call("VIBESQUAD_PORT")).strip_edges())
	return "http://127.0.0.1:%d" % (port if port > 0 else DEFAULT_PORT)


## The token is only ever sent to a loopback server.
static func is_loopback(url: String) -> bool:
	var u := url.to_lower()
	for pre in ["http://127.0.0.1", "http://localhost", "http://[::1]"]:
		if u.begins_with(pre) and (u.length() == pre.length() or u[pre.length()] in [":", "/"]):
			return true
	return false
