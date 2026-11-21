extends RefCounted
## Token + server-URL discovery and the token egress rules. Never logs or returns a token in an error.
## Local token (mirrors server/local-token.mjs): $VIBESQUAD_HOME/local-token else <home>/.vibesquad/local-token
## (64 lowercase hex chars), header x-vibesquad-token, loopback only.
## B2b device token (E6a owner device, PLAN_V1 "Remote owner path"): $VIBESQUAD_HOME/playtest-device-token else
## <home>/.vibesquad/playtest-device-token (setting vs_playtest/device_token_path overrides), header x-vs-device-token,
## only to loopback / Tailscale / https (is_device_egress_allowed). Never under res:// or user://, never a cookie.

const HEADER := "x-vibesquad-token"
const DEVICE_HEADER := "x-vs-device-token" # server/auth.mjs DEVICE_TOKEN_HEADER (extractDeviceToken)
const DEVICE_TOKEN_FILE := "playtest-device-token"
const DEFAULT_PORT := 4180 # server/serve.mjs:65 (VIBESQUAD_PORT || 4180)

const MODE_LOCAL := "local"
const MODE_DEVICE := "device"

## The same shape server/auth.mjs DEVICE_TOKEN_RE accepts (base64url, 16-256 chars). Also keeps CR/LF out of a header.
const DEVICE_TOKEN_PATTERN := "^[A-Za-z0-9_-]{16,256}$"


## `getenv`: Callable(name: String) -> String; injectable for tests.
static func token_path(getenv: Callable = OS.get_environment) -> String:
	var home := _vs_home(getenv)
	return "" if home == "" else home.path_join("local-token")


## $VIBESQUAD_HOME, else <USERPROFILE|HOME>/.vibesquad, else "".
static func _vs_home(getenv: Callable) -> String:
	var home: String = String(getenv.call("VIBESQUAD_HOME")).strip_edges()
	if home != "":
		return home
	var user_home: String = String(getenv.call("USERPROFILE")).strip_edges() # Windows
	if user_home == "":
		user_home = String(getenv.call("HOME")).strip_edges()
	return "" if user_home == "" else user_home.path_join(".vibesquad")


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


# ---------------------------------------------------------------- URL parsing (B2 H1 parser, shared by both modes)

## Strict parse of a whole server URL, lower-cased: scheme http|https, host = DNS name (letters/digits/hyphens, non-empty
## labels, no trailing dot) | dotted-quad IPv4 (decimal, no leading zeros) | [IPv6] (hex + colons only: no zone id,
## no embedded IPv4), optional port 1-65535, optional path. No userinfo (`@`), backslash, whitespace, query or fragment.
## Returns {scheme, host, port, path} (port 0 = none, host keeps IPv6 brackets) or {} when anything is off.
static func parse_url(url: String) -> Dictionary:
	var re := RegEx.new()
	re.compile(r"^(https?)://([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?(/[^\s?#@\\]*)?$")
	var m := re.search(url.strip_edges().to_lower())
	if m == null:
		return {}
	var host := m.get_string(2)
	var port_s := m.get_string(3)
	var port := 0
	if port_s != "":
		port = int(port_s)
		if port < 1 or port > 65535:
			return {}
	if host.begins_with("["):
		if ipv6_hextets(host.substr(1, host.length() - 2)).is_empty():
			return {}
	elif not _is_dns_name(host) and ipv4_octets(host).is_empty():
		return {}
	return {"scheme": m.get_string(1), "host": host, "port": port, "path": m.get_string(4)}


## Letters/digits/hyphens labels joined by dots; no empty label (so no leading/trailing/double dot), no edge hyphen,
## and a last label that is not numeric: a resolver reads 1681915905, 0x7f000001, 127.1 or 0177.0.0.1 as an IP
## address, so those are IP literals and only the strict dotted quad (ipv4_octets) may stand for one.
static func _is_dns_name(host: String) -> bool:
	if host == "" or host.length() > 253:
		return false
	var label_re := RegEx.new()
	label_re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
	var labels := host.split(".", true)
	for label in labels:
		if label_re.search(label) == null:
			return false
	var numeric := RegEx.new()
	numeric.compile(r"^(\d+|0x[0-9a-f]*)$")
	return numeric.search(labels[labels.size() - 1]) == null


## Four decimal octets 0-255 with no leading zeros (so octal 0177.0.0.1 / 010.x is refused), else [].
static func ipv4_octets(host: String) -> PackedInt32Array:
	var re := RegEx.new()
	re.compile(r"^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$")
	var m := re.search(host)
	if m == null:
		return PackedInt32Array()
	var out := PackedInt32Array()
	for i in range(1, 5):
		var v := int(m.get_string(i))
		if v > 255:
			return PackedInt32Array()
		out.append(v)
	return out


## Eight 16-bit groups of an IPv6 literal (no brackets; hex groups, at most one `::`), else [].
static func ipv6_hextets(s: String) -> PackedInt32Array:
	if s == "" or s.count("::") > 1 or s.contains(":::"):
		return PackedInt32Array()
	var head: PackedStringArray
	var tail: PackedStringArray
	var compressed := s.contains("::")
	if compressed:
		var halves := s.split("::", true)
		head = PackedStringArray() if halves[0] == "" else halves[0].split(":", true)
		tail = PackedStringArray() if halves[1] == "" else halves[1].split(":", true)
	else:
		head = s.split(":", true)
	var n := head.size() + tail.size()
	if (compressed and n > 7) or (not compressed and n != 8):
		return PackedInt32Array()
	var group_re := RegEx.new()
	group_re.compile(r"^[0-9a-f]{1,4}$")
	var out := PackedInt32Array()
	for g in head:
		if group_re.search(g) == null:
			return PackedInt32Array()
		out.append(g.hex_to_int())
	for i in 8 - n:
		out.append(0)
	for g in tail:
		if group_re.search(g) == null:
			return PackedInt32Array()
		out.append(g.hex_to_int())
	return out


## The local token is only ever sent to a loopback server: scheme http, host exactly 127.0.0.1 | localhost | [::1]
## (case-insensitive, no trailing dot), optional port 1-65535, optional path; no userinfo (`@`), query or fragment.
## Anything else (https, other schemes, `http://127.0.0.1:1@evil.com`) is refused.
static func is_loopback(url: String) -> bool:
	var u := parse_url(url)
	return not u.is_empty() and u["scheme"] == "http" and (u["host"] in ["127.0.0.1", "localhost", "[::1]"])


## Which credential a server URL gets: loopback -> the local token (today's behaviour), anything else -> the device token.
static func auth_mode(url: String) -> String:
	return MODE_LOCAL if is_loopback(url) else MODE_DEVICE


## B2b egress rule: the device token (and a pairing code) only goes to loopback, a Tailscale address (100.64.0.0/10,
## fd7a:115c:a1e0::/48, *.ts.net) or any https:// host. Everything else is refused. Redirects are never followed.
static func is_device_egress_allowed(url: String) -> bool:
	var u := parse_url(url)
	if u.is_empty():
		return false
	if u["scheme"] == "https":
		return true
	if is_loopback(url):
		return true
	var host: String = u["host"]
	if host.begins_with("["):
		var h := ipv6_hextets(host.substr(1, host.length() - 2))
		return h.size() == 8 and h[0] == 0xfd7a and h[1] == 0x115c and h[2] == 0xa1e0
	var v4 := ipv4_octets(host)
	if not v4.is_empty():
		return v4[0] == 100 and (v4[1] & 0xc0) == 64 # 100.64.0.0/10 = 100.64.0.0 - 100.127.255.255
	return host.ends_with(".ts.net") and host.length() > ".ts.net".length() and _is_dns_name(host)


## server_url for messages: userinfo (if any) masked, so a typo'd `user:pw@` never lands in the dock.
static func redact_url(url: String) -> String:
	var re := RegEx.new()
	re.compile(r"//[^/]*@")
	return re.sub(url.strip_edges(), "//***@", true)


# ---------------------------------------------------------------- device token file (B2b)

## Explicit `override` (setting vs_playtest/device_token_path) wins when it is an absolute filesystem path outside the
## project; a res:// / user:// / other-scheme / relative override is refused (""), so the token never lands in the
## project or an export. Else $VIBESQUAD_HOME/playtest-device-token, else <home>/.vibesquad/playtest-device-token.
static func device_token_path(override: String = "", getenv: Callable = OS.get_environment) -> String:
	var o := override.strip_edges()
	if o != "":
		return o if is_allowed_device_token_path(o) else ""
	var home := _vs_home(getenv)
	return "" if home == "" else home.path_join(DEVICE_TOKEN_FILE)


static func is_allowed_device_token_path(p: String) -> bool:
	if p == "" or p.contains("://") or p.ends_with("/") or p.ends_with("\\"):
		return false
	# absolute only: /x, C:/x or C:\x, \\server\share\x
	var re := RegEx.new()
	re.compile(r"^(/|[A-Za-z]:[/\\]|\\\\)")
	return re.search(p) != null


static func is_valid_device_token(t: String) -> bool:
	var re := RegEx.new()
	re.compile(DEVICE_TOKEN_PATTERN)
	return re.search(t) != null


## The device token, or "" when the path is empty/refused or the file is missing/malformed.
static func read_device_token(path: String) -> String:
	if path == "" or not FileAccess.file_exists(path):
		return ""
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ""
	var t := f.get_as_text().strip_edges()
	return t if is_valid_device_token(t) else ""


## Writes the token with owner-only permissions where the OS allows (0600 on Unix-likes; on Windows the file inherits
## the user-profile ACL, like server/local-token.mjs). Temp file + rename, so a reader never sees half a token.
## Returns OK or an Error; never prints the token.
static func write_device_token(path: String, token: String) -> Error:
	if path == "" or not is_allowed_device_token_path(path):
		return ERR_FILE_BAD_PATH
	if not is_valid_device_token(token):
		return ERR_INVALID_DATA
	var dir := path.get_base_dir()
	if not DirAccess.dir_exists_absolute(dir):
		var mk := DirAccess.make_dir_recursive_absolute(dir)
		if mk != OK:
			return mk
		_owner_only(dir, 448) # 0700
	var tmp := "%s.tmp-%d" % [path, Time.get_ticks_usec()]
	# Create it empty first and lock it down before the token goes in.
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		return FileAccess.get_open_error()
	f.close()
	_owner_only(tmp, 384) # 0600
	f = FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		DirAccess.remove_absolute(tmp)
		return FileAccess.get_open_error()
	f.store_string(token + "\n")
	f.close()
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(path)
	var mv := DirAccess.rename_absolute(tmp, path)
	if mv != OK:
		DirAccess.remove_absolute(tmp)
		return mv
	_owner_only(path, 384) # 0600
	return OK


## Deletes the device token file. true when no file is left at `path`.
static func remove_device_token(path: String) -> bool:
	if path == "":
		return false
	if not FileAccess.file_exists(path):
		return true
	DirAccess.remove_absolute(path)
	return not FileAccess.file_exists(path)


static func _owner_only(p: String, mode: int) -> void:
	if OS.get_name() in ["Windows", "Web"]:
		return
	FileAccess.set_unix_permissions(p, mode)
