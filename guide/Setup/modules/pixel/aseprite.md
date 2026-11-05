---
id: aseprite
group: pixel
level: 1
method: licence-pointer
winget_id: n/a
verified: 2026-10-30 (Steam store page fetched; aseprite.org could not be fetched, so UNVERIFIED)
licence: paid
size: small   # UNVERIFIED
---

# Aseprite

## When you want this
You want the pixel-art and sprite-animation tool that many game artists use: layers, frames, tags, palettes, onion skinning, sprite-sheet export and a command line. It is paid software, so this module only points you to the official sources.

## Install (Windows)
No install command. Buy or get it from the official sources:
- Steam: https://store.steampowered.com/app/431730/Aseprite/ (the page says it is by Igara Studio; it was listed at $19.99 on 2026-10-30, but prices change).
- The developer's own site, https://www.aseprite.org : what it offers (direct download, trial, building from source) is UNVERIFIED, so read it yourself.

The agent waits for you to say "done". It never downloads Aseprite from anywhere else.

## macOS line
macOS: Available on the same Steam page and the developer's site. UNVERIFIED: platform list.

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
**human check.** After installing, you confirm the app opens and shows its welcome screen, then say "done". The agent has no command for this.

## First run (the human's steps)
1. Launch Aseprite. Choose **File > New**, set a 32x32 canvas, and Color Mode **RGB**.
2. Draw a few pixels with the pencil (`B`). Add a frame (**Frame > New Frame**) to animate.
3. **File > Export** and pick PNG or GIF.

## Gotchas
- Steam updates it for you. Other installs update manually.
- The [piskel-mcp](piskel-mcp.md) module can hand you a PNG or GIF that you open in Aseprite to refine.
- If you do not want to pay, use [Piskel](piskel.md) (free, in the browser) or [LibreSprite](libresprite.md) (free, desktop).
