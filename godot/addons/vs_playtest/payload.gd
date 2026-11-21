extends RefCounted
## Builds the E6a report body (server/vibesquad-api.mjs handleTesterReport):
## {teamId, text, clientReportId, screenshotBase64?, screenshotMime?, telemetry:{...}}

const STATE_MAX_BYTES := 65536
const LOG_LINES_MAX := 200
const LOG_LINE_MAX_CHARS := 300 # server clips at 500; stay small so telemetry stays under its 64 KB cap
const TRUNC_MARKER := " ...[vs_playtest: truncated]"
const DEFAULT_TEXT := "(playtest capture, no note)"
const TELEMETRY_KEYS: Array[String] = ["clickedPoint", "viewport", "cursorNode", "scene", "state", "seed", "adapter", "buildHash", "engine", "platform", "logLines"]


## RFC 4122 v4 uuid.
static func new_uuid() -> String:
	var b := Crypto.new().generate_random_bytes(16)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	var h := b.hex_encode()
	return "%s-%s-%s-%s-%s" % [h.substr(0, 8), h.substr(8, 4), h.substr(12, 4), h.substr(16, 4), h.substr(20, 12)]


## Any Variant -> something JSON.stringify round-trips (Godot types become dicts/arrays/strings).
static func json_safe(v: Variant, depth: int = 0) -> Variant:
	if depth > 12:
		return "<max depth>"
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING:
			return v
		TYPE_FLOAT:
			return v if is_finite(v) else str(v)
		TYPE_STRING_NAME, TYPE_NODE_PATH:
			return str(v)
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return {"x": v.x, "y": v.y}
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return {"x": v.x, "y": v.y, "z": v.z}
		TYPE_COLOR:
			return v.to_html()
		TYPE_DICTIONARY:
			var d := {}
			for k: Variant in v:
				d[str(k)] = json_safe(v[k], depth + 1)
			return d
		TYPE_ARRAY, TYPE_PACKED_STRING_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY:
			var a := []
			for x: Variant in v:
				a.append(json_safe(x, depth + 1))
			return a
		TYPE_OBJECT:
			if v == null:
				return null
			if v is Node and (v as Node).is_inside_tree():
				return str((v as Node).get_path())
			return str(v)
		_:
			return str(v)


## JSON-safe state, <= 64 KB of UTF-8 JSON. Over the cap it becomes a truncated JSON *string* ending in a marker.
static func cap_state(state: Variant) -> Variant:
	var safe: Variant = json_safe(state)
	var text := JSON.stringify(safe)
	var bytes := text.to_utf8_buffer()
	if bytes.size() <= STATE_MAX_BYTES:
		return safe
	var keep := STATE_MAX_BYTES - TRUNC_MARKER.to_utf8_buffer().size()
	while keep > 0 and (bytes[keep] & 0xC0) == 0x80: # don't cut inside a multibyte char
		keep -= 1
	return bytes.slice(0, keep).get_string_from_utf8() + TRUNC_MARKER


static func clip_log_lines(lines: Array) -> Array:
	var out: Array = []
	for l: Variant in lines.slice(maxi(0, lines.size() - LOG_LINES_MAX)):
		var s := str(l)
		out.append(s if s.length() <= LOG_LINE_MAX_CHARS else s.substr(0, LOG_LINE_MAX_CHARS) + "...")
	return out


## Keeps only the documented telemetry keys; drops empties; applies the state / log caps.
static func clean_telemetry(t: Dictionary) -> Dictionary:
	var out := {}
	for k in TELEMETRY_KEYS:
		if not t.has(k):
			continue
		var v: Variant = t[k]
		match k:
			"state":
				v = cap_state(v)
			"logLines":
				v = clip_log_lines(v if v is Array else [])
				if (v as Array).is_empty():
					continue
			"adapter":
				var a := {}
				for ak in ["name", "version"]:
					if v is Dictionary and str(v.get(ak, "")).strip_edges() != "":
						a[ak] = str(v[ak])
				if a.is_empty():
					continue
				v = a
			"clickedPoint", "viewport":
				if not (v is Dictionary):
					continue
				v = json_safe(v)
			_:
				v = str(v)
				if v == "":
					continue
		out[k] = v
	return out


## screenshot: {bytes: PackedByteArray, mime: String} or {} for none.
static func build(team_id: String, text: String, client_report_id: String, screenshot: Dictionary, telemetry: Dictionary) -> Dictionary:
	var note := text.strip_edges()
	var body := {
		"teamId": team_id,
		"text": note if note != "" else DEFAULT_TEXT,
		"clientReportId": client_report_id,
	}
	var bytes: PackedByteArray = screenshot.get("bytes", PackedByteArray())
	if not bytes.is_empty():
		body["screenshotBase64"] = Marshalls.raw_to_base64(bytes)
		body["screenshotMime"] = str(screenshot.get("mime", "image/png"))
	body["telemetry"] = clean_telemetry(telemetry)
	return body


## Thread lines the owner sent come back as "[Owner playtest( · card:<id>)] text" (B1); show just the text.
static func strip_owner_prefix(text: String) -> String:
	var re := RegEx.new()
	re.compile(r"^\[Owner playtest(?: · card:idea-\d{1,12})?\] ")
	var m := re.search(text)
	return text.substr(m.get_end()) if m else text
