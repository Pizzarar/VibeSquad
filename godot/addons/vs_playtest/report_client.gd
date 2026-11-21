extends RefCounted
## Report/thread calls over an injected transport (anything with `request(method, path, body)`; see transport.gd).
## A report is retried with backoff and the SAME body, so the same clientReportId, and the server dedupes it.

const REPORT_PATH := "/__vibesquad/tester/report"
const THREAD_PATH := "/__vibesquad/tester/thread"

var transport: Object
var max_attempts: int = 5
var backoff_sec: Array[float] = [1.0, 2.0, 4.0, 8.0]
## Callable(seconds: float): may be a coroutine. Tests replace it with a no-op.
var sleep_fn: Callable = Callable()


func _init(p_transport: Object = null) -> void:
	transport = p_transport


static func retryable(status: int) -> bool:
	return status == 0 or status == 408 or status == 429 or status >= 500


func send_report(body: Dictionary) -> Dictionary:
	var res: Dictionary = {}
	for attempt in max_attempts:
		res = await transport.request("POST", REPORT_PATH, body)
		res["attempts"] = attempt + 1
		if bool(res.get("ok", false)) or not retryable(int(res.get("status", 0))):
			return res
		if attempt < max_attempts - 1 and sleep_fn.is_valid():
			await sleep_fn.call(backoff_sec[mini(attempt, backoff_sec.size() - 1)])
	return res


func fetch_thread(team_id: String, after: String = "", limit: int = 50) -> Dictionary:
	var q := "?teamId=%s&limit=%d" % [team_id.uri_encode(), limit]
	if after != "":
		q += "&after=%s" % after.uri_encode()
	return await transport.request("GET", THREAD_PATH + q, null)


func post_reply(team_id: String, text: String, card_id: String = "") -> Dictionary:
	var body := {"teamId": team_id, "text": text}
	if card_id != "":
		body["cardId"] = card_id
	return await transport.request("POST", THREAD_PATH, body)
