extends RefCounted
## Ring buffer of recent engine log lines, fed by an engine Logger (Godot 4.5+). add_line() is public for games that want more.

const CAP := 400

var _lines: Array[String] = []
var _mutex := Mutex.new()
var _logger: Logger = null


class _Sink extends Logger:
	var owner_ref: WeakRef

	func _log_message(message: String, error: bool) -> void:
		var o: Object = owner_ref.get_ref()
		if o:
			o.add_line(("[err] " if error else "") + message.strip_edges(false, true))

	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
		var o: Object = owner_ref.get_ref()
		if o:
			var kinds := ["ERROR", "WARNING", "SCRIPT ERROR", "SHADER ERROR"]
			o.add_line("%s: %s %s (%s:%d @ %s)" % [kinds[clampi(error_type, 0, 3)], code, rationale, file, line, function])


func install() -> bool:
	if _logger != null:
		return true
	var sink := _Sink.new()
	sink.owner_ref = weakref(self)
	_logger = sink
	OS.add_logger(_logger)
	return true


func uninstall() -> void:
	if _logger != null:
		OS.remove_logger(_logger)
		_logger = null


func add_line(line: String) -> void:
	_mutex.lock()
	_lines.append(line)
	if _lines.size() > CAP:
		_lines = _lines.slice(_lines.size() - CAP)
	_mutex.unlock()


func last_lines(n: int = 200) -> Array:
	_mutex.lock()
	var out: Array = _lines.slice(maxi(0, _lines.size() - n))
	_mutex.unlock()
	return out
