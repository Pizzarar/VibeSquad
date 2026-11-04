---
id: piskel
group: pixel
level: 1
method: web
winget_id: n/a
verified: 2026-10-30 (piskelapp.com home page fetched; no installer link listed there)
licence: free
size: small   # web app (nothing to install); desktop build size UNVERIFIED
---

# Piskel

## When you want this
You want to make pixel-art sprites and small animations, right now, with nothing to install. Piskel is a free browser-based editor with layers, frames, onion skinning and PNG/GIF export. It is the easiest first step into pixel art.

## Install (Windows)
Nothing to install. Open the editor in your browser:
https://www.piskelapp.com/p/create/sprite

Offline desktop app: the official site says there is a free desktop and offline application for Windows, macOS and Linux, linked from its download page: https://www.piskelapp.com/download . The individual installer links were not visible in the page text (UNVERIFIED), so the agent must not guess a URL. Open that page, let the human click the Windows download, and wait for "done".

The source code is public at https://github.com/piskelapp/piskel (licence not checked: UNVERIFIED).

## macOS line
macOS: Same web app and same download page. No brew line: UNVERIFIED.

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
**human check.** You open the editor, draw a 16x16 sprite, and export a PNG. Tell the agent the file name (and the folder, if the browser didn't save it in Downloads). The agent then confirms that exact file exists:
```powershell
Get-Item "$env:USERPROFILE\Downloads\<the file name>" | Select-Object Name, Length
```
Expected: the file is listed with a size above 0. Then say "done".

## First run (the human's steps)
1. Open https://www.piskelapp.com/p/create/sprite in a desktop browser.
2. Click the **Resize** tool and set a 16x16 canvas.
3. Pick the pen, draw a heart or a tiny character. Add a second frame (the **+** under the frame list) to animate.
4. Click **Export** and choose **PNG** (one frame or a sprite sheet) or **GIF** (animation).

## Gotchas
- Browser projects live in browser storage unless you save them. Use **Save** > download a `.piskel` file to keep your work.
- Piskel is a good partner for an agent: the [piskel-mcp](piskel-mcp.md) module lets Claude draw sprites and hand you a PNG or GIF to refine here.
- Want a one-time-purchase pro tool with more power? See [aseprite](aseprite.md). Want a free desktop app? See [libresprite](libresprite.md).
- For 3D low-poly and voxel art, Blockbench is mentioned in [blender](../game/blender.md).
