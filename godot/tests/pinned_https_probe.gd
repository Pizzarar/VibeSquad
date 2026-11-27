extends SceneTree
## Real pinned HTTPS GET through the addon's own pin (Token.pinned_tls) and HTTPRequest. Driven by
## test/mesh-tls-chain.test.mjs against server/serve.mjs createMeshnetMux with a real ensureTls CA.
## Args (after --): <ca.crt path> <https url>. Prints "PROBE result=<HTTPRequest.Result> http=<code>".
const Token := preload("res://addons/vs_playtest/token.gd")


func _initialize() -> void:
	_go.call_deferred()


func _go() -> void:
	var args := OS.get_cmdline_user_args()
	var der := Token.pem_single_cert_der(FileAccess.get_file_as_string(args[0]))
	var tls := Token.pinned_tls(der)
	if tls == null:
		print("PROBE result=-1 http=0 (CA did not load)")
		quit(2)
		return
	var h := HTTPRequest.new()
	root.add_child(h)
	h.set_tls_options(tls)
	h.timeout = 10
	h.request(args[1])
	var r: Array = await h.request_completed
	print("PROBE result=%d http=%d" % [r[0], r[1]])
	quit(0)
