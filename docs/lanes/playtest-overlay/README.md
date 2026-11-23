# Playtest overlay: agent how-to (debug bridge)

This is for a VS lead or worker that must inspect or drive a running Godot game. The bridge is [godot-mcp-runtime](https://github.com/Erodenn/godot-mcp-runtime) by Erodenn (MIT), used as-is. Our `VSPlaytest` autoload has no bridge code. See `BRIDGE_SPIKE.md` for the evidence and `PLAN_V1.md` for the plan.

Implemented runtime debug bridge — Thanks to godot-mcp-runtime by Erodenn

## Rules
- Owner-only, localhost-only, dev machine only.
- The bridge token is an accident guard, not a security boundary. Any process of the same user can read it.
- Call `stop_project` (detach) before every commit in the game repo. Attach edits the tracked `project.godot`.
- Call `stop_project` before any export. The export plugin removes the `McpBridge` autoload from every export and logs an error, but detach anyway.
- Do not save in the Godot editor while attached. The edit of `project.godot` has no file lock.
- Never run attach on a project that already has its own `McpBridge` autoload. The server refuses.
- Attach-mode script errors are invisible. Have `VSPlaytestAdapter` methods return JSON-safe values or error dicts, not throw.

## Pinned server
- Repo: `Erodenn/godot-mcp-runtime`, commit `3b8a4f311d29f96af166632e710429d072a1f372` (v4.0.1). Never use a floating `npx @latest`.
- Install once into a VS-managed tools dir: clone, `git checkout 3b8a4f311d29f96af166632e710429d072a1f372`, `npm ci --ignore-scripts`, build (`tsc`, then `node scripts/copy-scripts.js`).
- MCP server entry (the shape a Godot-lane agent needs):

```json
{
  "godot-runtime": {
    "command": "node",
    "args": ["<tools-dir>/godot-mcp-runtime/dist/index.js"],
    "env": {
      "GODOT_PATH": "<real Godot console .exe, not a .cmd shim>",
      "GODOT_MCP_DISABLE_ELICITATION": "true"
    }
  }
}
```

Installed machine-wide in the VS-managed tools directory (`%LOCALAPPDATA%\VibeSquad\tools\godot-mcp-runtime`), pinned to `3b8a4f31`. It is registered in Claude user scope as `godot-runtime` (`claude mcp get godot-runtime`), with `GODOT_PATH` set to the real console `.exe`. Sessions started before the install need a restart to see it. To upgrade, re-clone at a new pinned commit, rebuild, and update this file and `CREDITS.md`.

VS does not inject this server per agent. The runner only knows the `playwright` extra (`runner/adapters/claude.mjs`). Runner agents run with `--strict-mcp-config`, so they only see it if a `godot-runtime` extra is added later.

On another machine, do the manual recipe: install as above, then `claude mcp add --scope user godot-runtime -e GODOT_PATH=<exe> -e GODOT_MCP_DISABLE_ELICITATION=true -- node <tools-dir>/godot-mcp-runtime/dist/index.js`.

## VS on a remote server (forge)

When the VS server runs on a remote host (forge) and the game runs on the dev PC:

- **Report URL.** Set `vs_playtest/server_url` to `https://<forge>.<tailnet>.ts.net:<VS port>` (Tailscale MagicDNS). The forge box needs `VIBESQUAD_MESHNET_HOST` set so VS serves and certifies the MagicDNS name.
- **Remote is https only.** Plain http is refused for a remote `server_url`; the token and the pairing code never ride on it. The one exception is the `GET /ca.crt` bootstrap fetch, which carries nothing secret. The device token is only sent over TLS pinned to the VS CA the owner confirmed, never the system trust store.
- **Owner pairing** (the game on the dev PC becomes a Playtest device; a Playtest code gives the least-privilege `owner-playtest` role, report/thread only):
  1. Set `vs_playtest/server_url` to the https URL above.
  2. In VibeSquad, open the Pair Device dialog and mint a **Playtest code** (6 digits). The dialog also shows the CA SHA-256 fingerprint.
  3. In the game's dock, type the code and click "Pair with VS". The addon fetches `/ca.crt` over plain http (nothing secret rides on it) and shows its SHA-256 fingerprint.
  4. Confirm the fingerprint in the dock matches the one in the VS pair dialog (press "It matches: pair" only if every pair is the same).
  5. The addon redeems the Playtest code over https, pinned to that CA. The device is now paired.
  6. "Unpair" removes both the device token file and the pinned CA file (also revoke the device in VS). The CA is written to disk only after pairing succeeds.
  A device that holds a full-owner token (paired with an old owner code) shows "Full owner token: re-pair with a Playtest code" in the dock.
  Token and CA override paths must be absolute, outside the project folder, and not a network share (UNC); anything else is refused.
  Settings and API: `godot/addons/vs_playtest/README.md`.
- **Bridge for agents on forge.** Agents reach the debug bridge as a stdio MCP server over SSH: `ssh devpc npx godot-mcp-runtime@4.0.1`. The bridge itself stays on loopback on the dev PC and no new port is opened. Set `GODOT_PATH` to the real console `.exe` in the dev PC's environment, as above.
- **Version pin.** npm `godot-mcp-runtime@4.0.1` is tag `v4.0.1` (`ad386b91`). Our pinned commit `3b8a4f31` is the next commit after it and only changes CI/docs files (`.github/workflows/publish.yml`, `CONTRIBUTING.md`, release-notes script and its test), so the npm 4.0.1 package has the same runtime code. Always pin the exact version; never `@latest`.
- **SSH setup** (OpenSSH server on the dev PC, forge key, the `devpc` host alias) is in `docs/PLAN_FORGE_CUTOVER.md` stage B (owned by `@forge-host`).

## Attach recipe
1. Make sure the Godot editor is closed or not saving the project.
2. Call `run_project` with `{"projectPath": "<project dir>", "attach": true}`. It injects the bridge and then waits.
3. Only now start the game yourself, for example `godot --path <project dir>`. A game started earlier can never attach. Restart it.
4. Use the tools below.
5. When done, call `stop_project`. The game keeps running. `project.godot` goes back byte for byte.

`get_debug_output` captures nothing in attach mode. Read the game's own stdout and stderr instead.

## Snippets
Pass each snippet as the script of the `run_script` tool. The return value comes back as JSON. A script is a GDScript class with `func execute(scene_tree)`.

State, seed, cheats:

```gdscript
extends RefCounted
func execute(t):
	var v = t.root.get_node("VSPlaytest")
	return {"enabled": v.enabled, "state": v.state(), "seed": v.seed(), "cheats": v.cheats()}
```

Run one cheat (change the id and args):

```gdscript
extends RefCounted
func execute(t):
	return t.root.get_node("VSPlaytest").cheat("god_mode", [true])
```

Scene tree (depth-limited):

```gdscript
extends RefCounted
func _walk(n, depth):
	var out = {"name": str(n.name), "class": n.get_class()}
	if depth > 0:
		out["children"] = n.get_children().map(func(c): return _walk(c, depth - 1))
	return out
func execute(t):
	return _walk(t.current_scene, 4)
```

Set a property on a live node (change the path):

```gdscript
extends RefCounted
func execute(t):
	var n = t.root.get_node("Main/Label")
	n.text = "changed by agent"
	return n.text
```

Pause and resume (there is no native step verb; frame step is v2):

```gdscript
extends RefCounted
func execute(t):
	t.paused = true
	return t.paused
```

Screenshot: call the `take_screenshot` tool. It writes a PNG to `<project>/.mcp/godot-runtime/screenshots/`. Other live tools: `simulate_input` (key, mouse, `click_element`), `get_ui_elements`.

The `get_scene_tree` and `set_node_properties` tools edit `.tscn` files on disk. They do not touch the running game. Use `run_script` for live nodes.

## Notes
- `run_script` asks for confirmation once per project unless `GODOT_MCP_DISABLE_ELICITATION=true` is set, as above.
- If `godot` on this PC is a `.cmd` shim, `GODOT_PATH` must point at the real `.exe`, or the server fails with ENOENT.
- Leftovers after detach, by design: `.mcp/.gdignore`, screenshots under `.mcp/godot-runtime/`, and a `.mcp/` line in `.gitignore`.
- Addon install and API: `godot/addons/vs_playtest/README.md`.
