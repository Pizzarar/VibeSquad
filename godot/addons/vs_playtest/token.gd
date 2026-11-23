extends RefCounted
## Token + server-URL discovery and the token egress rules. Never logs or returns a token in an error.
## Local token (mirrors server/local-token.mjs): $VIBESQUAD_HOME/local-token else <home>/.vibesquad/local-token
## (64 lowercase hex chars), header x-vibesquad-token, loopback only.
## B2b device token (E6a owner device, PLAN_V1 "Remote owner path"): $VIBESQUAD_HOME/playtest-device-token else
## <home>/.vibesquad/playtest-device-token (setting vs_playtest/device_token_path overrides), header x-vs-device-token,
## only to an https:// server_url (is_device_egress_allowed) whose certificate chains to the pinned VS CA
## ($VIBESQUAD_HOME/playtest-ca.crt, same fallback, setting vs_playtest/ca_cert_path overrides; PLAN_V1 "Remote is
## https only"). Never under res:// or user://, never a cookie.

const HEADER := "x-vibesquad-token"
const DEVICE_HEADER := "x-vs-device-token" # server/auth.mjs DEVICE_TOKEN_HEADER (extractDeviceToken)
const DEVICE_TOKEN_FILE := "playtest-device-token"
const CA_CERT_FILE := "playtest-ca.crt"
const CA_BOOTSTRAP_PATH := "/ca.crt" # server/serve.mjs createMeshnetMux: served on its plain-http side (the bootstrap)
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


## B2b egress rule (PLAN_V1 "Remote is https only"): the device token (and a pairing code) only goes to an https://
## server_url. Off loopback VS serves only its mesh listener, whose plain-http side 301s GETs, 426s POSTs and burns a
## /pair code (server/serve.mjs createMeshnetMux), so plain http (Tailscale addresses included) is refused. https alone
## is not enough: transport.gd also requires the pinned VS CA (never the system trust store). Redirects never followed.
static func is_device_egress_allowed(url: String) -> bool:
	var u := parse_url(url)
	return not u.is_empty() and u["scheme"] == "https"


## The one plain-http remote call: GET http://<host>:<port>/ca.crt on the same host and port as the https server_url
## (the mesh listener serves http and https on one port; no port -> 443). No token or code ever rides on it.
## "" when server_url is not a valid https URL.
static func ca_bootstrap_url(url: String) -> String:
	var u := parse_url(url)
	if u.is_empty() or u["scheme"] != "https":
		return ""
	var port: int = int(u["port"]) if int(u["port"]) > 0 else 443
	return "http://%s:%d%s" % [u["host"], port, CA_BOOTSTRAP_PATH]


## server_url for messages: userinfo (if any) masked, so a typo'd `user:pw@` never lands in the dock.
static func redact_url(url: String) -> String:
	var re := RegEx.new()
	re.compile(r"//[^/]*@")
	return re.sub(url.strip_edges(), "//***@", true)


# ---------------------------------------------------------------- device token file (B2b)

## Explicit `override` (setting vs_playtest/device_token_path) wins when it is an absolute filesystem path outside the
## project; a res:// / user:// / other-scheme / relative override is refused (""), so the token never lands in the
## project or an export. Else $VIBESQUAD_HOME/playtest-device-token, else <home>/.vibesquad/playtest-device-token.
static func device_token_path(override: String = "", getenv: Callable = OS.get_environment, project_root: String = "") -> String:
	return _secret_path(override, DEVICE_TOKEN_FILE, getenv, project_root)


## The pinned VS CA file, same rules as device_token_path (setting vs_playtest/ca_cert_path, same refusals).
## Default $VIBESQUAD_HOME/playtest-ca.crt, else <home>/.vibesquad/playtest-ca.crt.
static func ca_cert_path(override: String = "", getenv: Callable = OS.get_environment, project_root: String = "") -> String:
	return _secret_path(override, CA_CERT_FILE, getenv, project_root)


## `project_root`: the globalized res:// folder ("" = ask ProjectSettings); injectable for tests.
static func _secret_path(override: String, file: String, getenv: Callable, project_root: String = "") -> String:
	var o := override.strip_edges()
	if o != "":
		return o if is_allowed_override_path(o, project_root) else ""
	var home := _vs_home(getenv)
	return "" if home == "" else home.path_join(file)


## Absolute filesystem path only: no res:// / user:// / other scheme, not relative, not a directory. Used for the
## device token file and the pinned CA file.
static func is_allowed_device_token_path(p: String) -> bool:
	if p == "" or p.contains("://") or p.ends_with("/") or p.ends_with("\\"):
		return false
	# absolute only: /x, C:/x or C:\x, \\server\share\x
	var re := RegEx.new()
	re.compile(r"^(/|[A-Za-z]:[/\\]|\\\\)")
	return re.search(p) != null


## An override (token / CA file setting) must be an allowed absolute path that is neither a UNC path (\\\\server\\share,
## //server/share: a network share is not owner-only storage) nor inside the project root (res:// globalized: the file
## would ride along in the repo or an export).
static func is_allowed_override_path(p: String, project_root: String = "") -> bool:
	if not is_allowed_device_token_path(p):
		return false
	# Normalise separators FIRST: on Windows `/\srv\share\x` and `/\?\C:\x` become `\\srv\share\x` / `\\?\C:\x`.
	if p.strip_edges().replace("\\", "/").begins_with("//"):
		return false
	var root := project_root if project_root != "" else ProjectSettings.globalize_path("res://")
	return not is_inside_dir(p, root)


## true when `p` is `dir` itself or below it (separator-normalised, dot segments collapsed, symlinks resolved, case-
## insensitive: refusing a same-named path on a case-sensitive filesystem is the safe side). "" dir -> false. A path
## whose symlinks cannot be resolved (loop / too deep) counts as inside (fail closed).
static func is_inside_dir(p: String, dir: String) -> bool:
	var d := _norm_path(dir)
	if d == "":
		return false
	var n := _norm_path(p)
	if n == d or n.begins_with(d + "/"):
		return true
	var rn := _resolve_links(p)
	var rd := _resolve_links(dir)
	if rn == "" or rd == "":
		return true
	return rn == rd or rn.begins_with(rd + "/")


## Lower-cased, normalised path with every existing symlink component replaced by its target (nearest existing
## ancestor resolved, the not-yet-existing tail appended). "" when resolution fails (more than 40 hops).
static func _resolve_links(p: String) -> String:
	var path := p.strip_edges().replace("\\", "/").simplify_path()
	for _hop in 40:
		var prefix := ""
		var rest := path
		if path.begins_with("/"):
			prefix = "/"
			rest = path.substr(1)
		elif path.length() >= 2 and path[1] == ":":
			prefix = path.left(2) + "/"
			rest = path.substr(3)
		var cur := prefix.left(prefix.length() - 1) if prefix.length() > 1 else prefix
		var parts := rest.split("/", false)
		var changed := false
		for i in parts.size():
			var next := cur.path_join(parts[i]) if cur != "" and cur != "/" else (cur + parts[i])
			if DirAccess.dir_exists_absolute(next) or FileAccess.file_exists(next) or _is_link(next):
				if _is_link(next):
					var target := _link_target(next)
					if not (target.begins_with("/") or (target.length() >= 2 and target[1] == ":")):
						target = cur.path_join(target) if cur != "" else target
					var tail := "/".join(parts.slice(i + 1))
					path = (target.path_join(tail) if tail != "" else target).replace("\\", "/").simplify_path()
					changed = true
					break
				cur = next
			else:
				break
		if not changed:
			return _norm_path(path)
	return ""


static func _is_link(p: String) -> bool:
	var d := DirAccess.open(p.get_base_dir())
	return d != null and d.is_link(p)


static func _link_target(p: String) -> String:
	var d := DirAccess.open(p.get_base_dir())
	return "" if d == null else d.read_link(p)


static func _norm_path(p: String) -> String:
	var n := p.strip_edges().replace("\\", "/").simplify_path().to_lower()
	while n.length() > 1 and n.ends_with("/"):
		n = n.left(n.length() - 1)
	return n


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
	if not is_valid_device_token(token):
		return ERR_INVALID_DATA if path != "" and is_allowed_device_token_path(path) else ERR_FILE_BAD_PATH
	return _write_private_file(path, token + "\n")


## Owner-only, temp file + rename; path must pass is_allowed_device_token_path.
static func _write_private_file(path: String, content: String) -> Error:
	if path == "" or not is_allowed_device_token_path(path):
		return ERR_FILE_BAD_PATH
	var dir := path.get_base_dir()
	if not DirAccess.dir_exists_absolute(dir):
		var mk := DirAccess.make_dir_recursive_absolute(dir)
		if mk != OK:
			return mk
		_owner_only(dir, 448) # 0700
	var tmp := "%s.tmp-%s" % [path, _random_suffix()]
	# Create it empty first and lock it down before the secret goes in.
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		return FileAccess.get_open_error()
	f.close()
	_owner_only(tmp, 384) # 0600
	f = FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		var oe := FileAccess.get_open_error()
		DirAccess.remove_absolute(tmp)
		return oe
	var stored := f.store_string(content)
	f.flush()
	var werr := f.get_error()
	f.close()
	if not stored or werr != OK:
		DirAccess.remove_absolute(tmp)
		return werr if werr != OK else ERR_FILE_CANT_WRITE
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
	return remove_file(path)


## Deletes `path` (the token or the CA file). true when no file is left there; false for "".
static func remove_file(path: String) -> bool:
	if path == "":
		return false
	if not FileAccess.file_exists(path):
		return true
	DirAccess.remove_absolute(path)
	return not FileAccess.file_exists(path)


# ---------------------------------------------------------------- pinned VS CA (B2b, PLAN_V1 "Remote is https only")

## DER bytes of a PEM that holds exactly one CERTIFICATE block and nothing else but whitespace, else []. A second
## block (an extra trust anchor riding along) or any other text is refused, so the pin is exactly the fingerprinted cert.
static func pem_single_cert_der(pem: String) -> PackedByteArray:
	var re := RegEx.new()
	re.compile(r"^\s*-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----\s*$")
	var m := re.search(pem)
	if m == null:
		return PackedByteArray()
	var ws := RegEx.new()
	ws.compile(r"\s+")
	var b64 := ws.sub(m.get_string(1), "", true)
	if b64 == "" or b64.length() % 4 != 0:
		return PackedByteArray()
	var der := Marshalls.base64_to_raw(b64)
	if der.is_empty() or Marshalls.raw_to_base64(der) != b64:
		return PackedByteArray()
	var cert := X509Certificate.new()
	if cert.load_from_string(der_to_pem(der)) != OK:
		return PackedByteArray()
	return der


## Canonical one-certificate PEM (64-char base64 lines) for `der`.
static func der_to_pem(der: PackedByteArray) -> String:
	var b64 := Marshalls.raw_to_base64(der)
	var lines := PackedStringArray()
	for i in range(0, b64.length(), 64):
		lines.append(b64.substr(i, 64))
	return "-----BEGIN CERTIFICATE-----\n%s\n-----END CERTIFICATE-----\n" % "\n".join(lines)


## The VS pair-dialog fingerprint (server/auth.mjs caFingerprint): SHA-256 of the CA's DER bytes as uppercase hex
## pairs joined by ":" (`full`, 32 pairs) and its first 8 pairs (`short`, what the dialog shows first).
static func ca_fingerprint(der: PackedByteArray) -> Dictionary:
	var ctx := HashingContext.new()
	ctx.start(HashingContext.HASH_SHA256)
	ctx.update(der)
	var hex := ctx.finish().hex_encode().to_upper()
	var pairs := PackedStringArray()
	for i in range(0, hex.length(), 2):
		pairs.append(hex.substr(i, 2))
	return {"full": ":".join(pairs), "short": ":".join(pairs.slice(0, 8))}


## Stores the CA as a canonical one-certificate PEM (owner-only, temp + rename). OK or an Error.
static func write_ca_cert(path: String, der: PackedByteArray) -> Error:
	if path == "" or not is_allowed_device_token_path(path):
		return ERR_FILE_BAD_PATH
	if der.is_empty() or pem_single_cert_der(der_to_pem(der)).is_empty():
		return ERR_INVALID_DATA
	return _write_private_file(path, der_to_pem(der))


## The pinned CA's DER bytes, or [] when the path is empty/refused or the file is missing/not exactly one certificate.
static func read_ca_der(path: String) -> PackedByteArray:
	if path == "" or not is_allowed_device_token_path(path):
		return PackedByteArray()
	var f := FileAccess.open(path, FileAccess.READ) # one open + one read: no exists-then-read gap
	if f == null:
		return PackedByteArray()
	return pem_single_cert_der(f.get_as_text())


## TLS client options that trust ONLY the CA in `der` (TLSOptions.client with a trusted chain replaces the system
## store) and verify the host name. null for an empty/invalid CA.
static func pinned_tls(der: PackedByteArray) -> TLSOptions:
	if der.is_empty():
		return null
	var cert := X509Certificate.new()
	if cert.load_from_string(der_to_pem(der)) != OK:
		return null
	return TLSOptions.client(cert)


## 128 random bits as hex (Crypto), so a temp file name cannot be predicted or pre-created by another local user.
static func _random_suffix() -> String:
	return Crypto.new().generate_random_bytes(16).hex_encode()


static func _owner_only(p: String, mode: int) -> void:
	if OS.get_name() in ["Windows", "Web"]:
		return
	FileAccess.set_unix_permissions(p, mode)
