@tool
extends RefCounted
## Project-setting names + defaults shared by the editor plugin and the runtime autoload.

const TEAM_ID := "vs_playtest/team_id"
const SERVER_URL := "vs_playtest/server_url"
const HOTKEY_DOCK := "vs_playtest/hotkey_dock"
const HOTKEY_BUG := "vs_playtest/hotkey_bug"
const ADAPTER_DIR := "vs_playtest/adapter_dir" # game adapter scripts; dropped from non-vs_playtest exports
## B2b: absolute path of the owner device token file (remote server_url). "" = $VIBESQUAD_HOME/playtest-device-token,
## else ~/.vibesquad/playtest-device-token. res:// and user:// paths are refused (the token never enters the project).
const DEVICE_TOKEN_PATH := "vs_playtest/device_token_path"
## B2b: absolute path of the pinned VibeSquad CA (remote https server_url). "" = $VIBESQUAD_HOME/playtest-ca.crt, else
## ~/.vibesquad/playtest-ca.crt. Same refusals as device_token_path.
const CA_CERT_PATH := "vs_playtest/ca_cert_path"

## [name, default, type, hint]. server_url "" = auto: http://127.0.0.1:$VIBESQUAD_PORT (else 4180).
const ALL: Array = [
	[TEAM_ID, "", TYPE_STRING],
	[SERVER_URL, "", TYPE_STRING],
	[DEVICE_TOKEN_PATH, "", TYPE_STRING],
	[CA_CERT_PATH, "", TYPE_STRING],
	[HOTKEY_DOCK, "F8", TYPE_STRING],
	[HOTKEY_BUG, "F9", TYPE_STRING],
	[ADAPTER_DIR, "res://vs_playtest_adapter/", TYPE_STRING],
]


static func get_str(setting: String) -> String:
	var def := ""
	for row: Array in ALL:
		if row[0] == setting:
			def = String(row[1])
	return String(ProjectSettings.get_setting(setting, def)).strip_edges()


## Registers the settings with the editor (plugin only); safe to call repeatedly.
static func register_all() -> void:
	for row: Array in ALL:
		var n: String = row[0]
		if not ProjectSettings.has_setting(n):
			ProjectSettings.set_setting(n, row[1])
		ProjectSettings.set_initial_value(n, row[1])
		ProjectSettings.add_property_info({"name": n, "type": row[2]})
