# BRIDGE_SPIKE · PTO-B0 (playtest-overlay)

**Verdict: AS-IS.** Use Erodenn/godot-mcp-runtime's MCP server and its `McpBridge` autoload unchanged. Our `VSPlaytest` autoload needs no bridge code: the agent reaches `VSPlaytest.state()` / `.cheat(id,args)` through the server's `run_script` verb (verified below). Option (b), "our autoload speaks its wire", is not needed for v1.

- Repo: https://github.com/Erodenn/godot-mcp-runtime, commit `3b8a4f311d29f96af166632e710429d072a1f372` (v4.0.1, MIT, "Copyright (c) 2025-2026 Owen Sterling").
- Spike date 2026-11-21, Godot 4.7.2 on Windows 11, Node 24. Everything ran in `C:\Users\Fugma\AppData\Local\Temp\pto-b0\` (clone, scratch project, client scripts). Nothing from the clone was run before reading `bridge-protocol.ts` and `mcp_bridge.gd`; `npm ci --ignore-scripts` + `tsc` + `scripts/copy-scripts.js` only inside the clone.
- Drive method: a ~30-line node client (`client/drive.mjs`, newline-delimited JSON-RPC over the server's stdio) called `run_project {attach:true}`, launched Godot itself (`godot --path <scratch>`), then called the runtime tools.

## Wire protocol (bridge, game side)

| Item | Finding | Source |
|---|---|---|
| Transport | TCP, Godot `TCPServer` | `src/scripts/mcp_bridge.gd:267-268` |
| Bind | `127.0.0.1` only (hard-coded) | `mcp_bridge.gd:268`, `bridge-protocol.ts` (`net.connect(port,'127.0.0.1')`) |
| Port | Auto-picked free port per session (`findFreePort`); default 9900. Attach mode bakes it into the script copy (`const PORT := 55529  # MCP_BRIDGE_PORT_BAKED`); spawned mode uses env `MCP_BRIDGE_PORT` | `mcp_bridge.gd:54,262-266`; `bridge-protocol.ts:8` |
| Framing | 4-byte big-endian length + UTF-8 JSON, max 16 MiB; oversize closes the peer | `bridge-protocol.ts:1-2`; `mcp_bridge.gd:46-47,66` |
| Message | Request `{"command": "...", "token": "...", ...args}`; reply is one JSON object, `{"error": "..."}` on failure | `mcp_bridge.gd:452-490` |
| Auth | Per-session random token (32 hex), baked into the injected script (attach) or env `MCP_SESSION_TOKEN` (spawn). Wrong/missing token gets `Unauthorized`. Their own comment: "an accident guard, not a sandbox" (a same-user process can read the token from the script file). Fail-open if no token is configured | `mcp_bridge.gd:55,258-260,452-457` |
| Commands | `input`, `get_ui_elements`, `run_script`, `screenshot`, `shutdown`, `track_start`, `track_stop`, a frame-cap command, `ping` | `mcp_bridge.gd:464-490` |

Raw evidence (own node client speaking the wire to the attached game):

```
bridgePort 55529
baked token length 32 | PORT line: const PORT := 55529  # MCP_BRIDGE_PORT_BAKED
NO TOKEN ping   -> {"hdr":"0000003a","body":"{\"error\":\"Unauthorized: invalid or missing session token\"}"}
WITH TOKEN ping -> {"hdr":"00000087","body":"{\"project_path\":\".../scratch/\",\"session_token\":\"507ee...\",\"status\":\"pong\"}"}
run_script raw  -> {"hdr":"0000001b","body":"{\"result\":2,\"success\":true}"}
  TCP    127.0.0.1:55529        0.0.0.0:0              LISTENING       20124
```

Localhost-only confirmed (`LISTENING` on `127.0.0.1` only). Note the token is a local-process guard, not a security boundary; fine for owner-only v1 (same trust level as `~/.vibesquad/local-token`).

## Verbs (MCP server, 43 tools; runtime-relevant ones)

Server tool list from `tools/list`: `launch_editor, run_project, switch_project, get_debug_output, stop_project, take_screenshot, simulate_input, get_ui_elements, run_script, render_movie, ...` plus headless scene/node/resource editing (`get_scene_tree`, `set_node_properties`, ... operate on `.tscn` files, **not** the live game), profiler and `validate` tools.

Live-game verbs against our needs:

| Need | Verb | Verified |
|---|---|---|
| Screenshot | `take_screenshot` (PNG to `<project>/.mcp/godot-runtime/screenshots/`, returns path + preview) | yes, 1152x648 PNG |
| Input | `simulate_input` (key, mouse, `click_element`, batches) | yes, `{type:'key',key:'F9'}` -> `ok:true, frame:2` |
| UI elements | `get_ui_elements` (visible Controls with rects/text) | yes: `Label` rect + live text `changed by bridge` |
| Live tree / node get / node set / call / eval | **No dedicated verbs.** All done with `run_script` (GDScript `extends RefCounted` + `func execute(scene_tree)`; arbitrary code, return value JSON-serialized, Node -> `{class,name,path}`) | yes (below) |
| Pause / step | **No dedicated verb.** Pause works through `run_script` (`scene_tree.paused = true`, verified true). No single-frame step primitive. The bridge itself is `PROCESS_MODE_ALWAYS` and its input waits run while paused (`mcp_bridge.gd:251,551`) | pause yes; step no |
| Logs | `get_debug_output` works for **spawned** sessions only. In attach mode nothing is captured (`output`/`errors` null); the game's own stderr/stdout are ours to read | as documented |

Answer to the plan's Open item: pause exists only as a `run_script` one-liner; there is no native freeze/step verb. Keep "pause" in v1 as a documented `run_script` snippet. True frame step is v2 (would be a `VSPlaytest.step()` helper on our side, no bridge change).

`run_script` caveats: confirmation prompt once per project unless `GODOT_MCP_DISABLE_ELICITATION=true` (set it in the Godot-lane MCP config; the owner already trusts these agents); in attach mode script runtime errors are unobservable (`Attached: errors are unobservable`, tool description), so VSPlaytest methods should return error strings/dicts instead of failing.

## Coexistence with a second autoload; reaching `VSPlaytest`

Scratch `project.godot` had `[autoload] VSPlaytest="*res://vs_playtest.gd"` (a node with `state()` and `cheat(id,args)`). While attached, the autoload order was `["VSPlaytest","McpBridge","Main"]`; both coexist. `run_script` reached our autoload:

```
run_script: var v := t.root.get_node("VSPlaytest"); return {"state": v.state(), "cheat": v.cheat("god",[1,2]), "autoloads": ...}
-> {"result":{"autoloads":["VSPlaytest","McpBridge","Main"],"cheat":"cheat:god:[1, 2]","state":{"hits":1,"hp":42}}}
```

Live node set + pause in the same session:

```
l.text = "changed by bridge"; t.paused = true ...
-> {"result":{"paused_works":true,"text":"changed by bridge","tree":["/root/Main/Label"]}}
```

So the plan's "adapter hooks reach the agent through the bridge (eval/call on `VSPlaytest`)" holds with zero protocol extension. `McpBridge` is injected **after** user autoloads, so `VSPlaytest` exists when scripts run.

## Attach flow and project.godot / file edits

Flow: `run_project {attach:true}` -> server injects, then waits (up to ~minutes) for a Godot you launch; "Godot reads autoloads only at startup", so launch Godot **after** the call starts (tool doc: `runtime-tools.ts:191`). My first attempt launched the game 2.5 s after the call, before the injection landed, and got `Project attached but the MCP bridge is not ready` (the failed attach cleaned up after itself). A client that polls until the autoload line exists (or simply launches Godot right after issuing the call) attached on the next run. **Gotcha for B4's how-to: start the Godot process only once the attach call is pending; a game started earlier can never attach and must be restarted.**

What the injection edits (project.godot snapshot DURING attach):

```
[autoload]
VSPlaytest="*res://vs_playtest.gd"
McpBridge="*res://.mcp/godot-runtime/bridge/mcp_bridge.gd"
```

Other changes: copies the template to `<project>/.mcp/godot-runtime/bridge/mcp_bridge.gd` (port + token baked in), creates `.mcp/.gdignore`, appends `.mcp/` to the project's `.gitignore`, writes an owner registry under `.mcp/godot-runtime/bridge/owners/`. Screenshots and run_script artifacts go in `.mcp/godot-runtime/`.

Undo: `stop_project` (detach; the attached game keeps running) removes the `McpBridge=` line and the bridge script. Verified byte-identical: `diff pre-project.godot scratch/project.godot` -> identical after a failed attach AND after a successful attach + `stop_project`. Left behind by design: `.mcp/.gdignore`, `.mcp/godot-runtime/screenshots/*`, and the `.mcp/` line in `.gitignore`. A hard-killed server leaves a stranded entry, repaired by the next headless op (`repairStrandedBridge`, `bridge-manager.ts:471`), or by hand (remove the `McpBridge=` line). The edit is a read-modify-write on `project.godot` with no file lock (their own noted gap, `bridge-manager.ts:227`), so do not run it while the editor has the project open and saving. Hard refusal if the project already registers its own `McpBridge` autoload name.

Implication for EFI: the attach edits a tracked file (`project.godot`) for the session's lifetime. Acceptable for a dev machine; the agent must `stop_project` before committing in the game repo (cheap rule for the how-to). The spike did not touch any repo project.

## Export leak check

`--export-pack "Release"` of the scratch project (a Windows preset, `export_filter="all_resources"`), then scanned the pack for names:

| Pack | `McpBridge` autoload | `.mcp/**` files | `VSPlaytest` |
|---|---|---|---|
| clean (no session) | absent | absent | present (ours) |
| exported **while attached** | `autoload/McpBridge` present in `project.binary` and `res://.mcp/godot-runtime/bridge/mcp_bridge.gd` referenced | **no `.mcp` files packed** (`.gdignore` keeps them out) | present |

So no bridge code leaks into an export (the `.gdignore` works), but exporting during an active attach session leaves a dangling `McpBridge` autoload reference in the pack's `project.binary` (the script is missing, so a release build would log a load error at startup). Clean pack = detach first. This is a procedural rule, not a blocker; B3's `EditorExportPlugin` cannot strip it (it is project settings, not a file), but a cheap B3/B5 check ("refuse/warn export if project.godot contains `McpBridge`") is worth adding. Also `mcp_bridge.gd:1702` only runs a block under `OS.has_feature("editor")`; the rest is not feature-gated, but as above it is not in the pack.

## License (files we would copy or adapt)

MIT, `LICENSE`: "Copyright (c) 2025-2026 Owen Sterling" (GitHub owner `Erodenn`). Requirement: keep the copyright + permission notice "in all copies or substantial portions". `mcp_bridge.gd` and `bridge-protocol.ts` have **no per-file header/SPDX line**, so under (a) as-is nothing is copied into our repo and only the CREDITS line is needed. If we ever vendor or adapt any of their files (fallback (b)), add their LICENSE text (or a `THIRD_PARTY/godot-mcp-runtime-LICENSE` copy) next to the adapted file and in CREDITS. No GPL/AGPL contamination (note the plan's yanhuifair/Godot-MCP rule stands: no code borrowed).

## Recommendation for B4

**(a) Config + how-to, no bridge code.**

1. Add godot-mcp-runtime to the MCP config of the Godot-lane lead/worker profiles: `command: node <clone-or-npm-install>/dist/index.js` (install into a VS-managed tools dir, pinned to a commit/tag, deps via `npm ci --ignore-scripts`), env `GODOT_PATH=<godot console exe>` and `GODOT_MCP_DISABLE_ELICITATION=true`. (Note `godot` on this PC is a `.cmd` shim: `GODOT_PATH` must point at the real `.exe`, or the server rejects it with ENOENT; seen in the spike.)
2. `docs/lanes/playtest-overlay/README.md` how-to: attach recipe (start the `run_project attach:true` call, then launch Godot), `run_script` snippets for `VSPlaytest.state()/seed()/cheats()/cheat(id,args)`, live tree, node set, pause, plus the rules: detach (`stop_project`) before commit and before any export; no editor save while attached.
3. Adapter hooks need nothing on the bridge side; keep `VSPlaytest` methods returning JSON-safe values and error dicts (attach-mode script errors are invisible).
4. Optional v2: thin `VSPlaytest.step()` helper for frame stepping; any wire-level re-implementation only if we later need to drop the Node MCP server (not needed now).
5. CREDITS.md line (B4 adds it): **"Implemented runtime debug bridge — Thanks to godot-mcp-runtime by Erodenn"**; also reference MIT / Owen Sterling copyright in the CREDITS entry.

Residual risks to carry (none blocks v1): (1) bridge token is an accident guard only (same trust as local-token; owner-only v1 is fine); (2) `project.godot` mutation + no file lock; (3) dangling `McpBridge` entry if exporting while attached; (4) upstream is a single-maintainer project at v4.0.1: pin the commit.
