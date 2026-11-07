# U3 painted kit (U3b): airbrushed 90s vaporwave UI layer

These are hand-painted P0 pixel assets that replace the code-made surfaces of the U2 skin (`src/styles.css`, the U2 block starting at `/* U2: Hypno-vaporwave skin */`). They match the owner-approved U3a style frame (`scratch/shots/u3a-*.png`). `scratch/shots/u3b-recompose-*.png` is that frame rebuilt only from these pieces.

- **Files:** `<piece>-dark.png` / `<piece>-light.png`. Both files are the same indexed art exported with the dark and light P0 palettes, so a theme swap is a URL swap and the geometry never changes. Light uses the U2 swatch-A surfaces.
- **Scale:** every piece is 1x native and is shown at **2x** (`scale: 2` in every json). Always set `image-rendering: pixelated`. Each `border-image-width` and `background-size` is the native px × 2. Never use non-integer sizes.
- **Sources:** `art/ui/u3b/kit.lua` and `art/ui/u3b/airbrush.lua` (Aseprite batch). Rebuild with `Aseprite.exe -b --script-param root=<repo> --script art/ui/u3b/kit.lua`.
- **Manifest:** `kit.json` lists every piece with `w`, `h`, `kind`, `slice`, `repeat`, `anchor`, `below` and `next`. Each 9-slice piece also has its own `<piece>.json` in the `public/office/sky-crt.json` shape: `{slice:{top,right,bottom,left}, scale, repeat}`.
- **Theme hook (suggested):** define each URL as a custom property in `:root` and `:root[data-theme="light"]`, the same way `--bayer` is done today, e.g. `--u3-window: url("/ui/u3/window-frame-dark.png")`.

## 1. Frames: 9-slice, slice 8/8/8/8, repeat `repeat`, 32×32
The middles are uniform, so they repeat seamlessly. The corners hold the painted tapers. Use `border-image-source: var(--u3-…); border-image-slice: 8; border-image-width: 16px; border-image-repeat: repeat;`. Keep the existing `border` width for layout: `border-image-width` doesn't change layout, so the 16px paints over the padding edge. Centres are transparent (no `fill`), so the body background shows through.

| Piece | Look | Replaces (U2 selectors) |
|---|---|---|
| `window-frame` | INK rim with nipped corners, MARBLE highlight top-left tapering into the corners, INK recess, 1px hard drop (inside the image, bottom/right) | `border` + `box-shadow: var(--bevel), var(--hard)` on `.modal, .idea-inbox, .cmd-palette, .shortcut-modal, .daemon-disconnect-card, .pin-tile:not(.pin-plus)` |
| `panel-frame` | painted 2-tone bevel: VIOLET highlight top-left tapering before the corners, INK recess bottom-right, corners open | same props on `.card, .squad-home-tile, .ts-team, .ws-row, .handoff-panel, .pin-menu-list, .ctx-menu, .drawer-features-menu, .drawer-sandbox-panel, .drawer-config-popover, .pin-rail-active-buddy, .pin-rail-tile, .team-head` |
| `panel-frame-pink` | as above, PINK highlight | `.card.card-lead`, `.card.card-secondary-lead.card-lead-needs-you`, `.NeedsYouHighlight` (instead of the outline), avatar/portrait wells |
| `panel-frame-amber` | as above, AMBER highlight | waiting / warn cards (`.card` in a waiting state, `.lint-bar`-style boxes) |
| `well-frame` | sunken: a single INK recess line top-left (no dither, so text inside stays clean), MARBLE catch-light bottom-right tapering into the corners | `box-shadow: var(--bevel-in)` on `.toolbar .search, .you-flag input, .ws-controls select, .modal input/select/textarea, .attach-body textarea, .composer textarea, .meter-track, .brainstorm-ctx-track, .quota-bar, .seg` |

## 2. Backgrounds
These are structured spray only: ramps and banded pools, never uniform pepper noise. Wide 2D washes use the spray matrix. Every 1px band on a repeating edge, face, rule or meter uses an ordered 4×4 Bayer, so it stays even dots when tiled.

| Piece | Size | Use | Replaces |
|---|---|---|---|
| `bg-page` | 16×256, `repeat-x`, `background-color: var(--panel)` below | page wash | `body { background-image: var(--bayer), var(--page-grad) }` |
| `bg-sidebar` | 16×512, `repeat-x`, colour `var(--panel-hi)` below | sidebar wash | `.sidebar { background-image: var(--bayer), linear-gradient(…) }` |
| `bg-panel` | 16×128, `repeat-x`, colour `var(--panel-hi)` below | window/panel bodies | `--panel-grad` + `--bayer` layers in `--cap-imgs` and on `.handoff-panel, .pin-tile, .pin-rail-active-buddy` |
| `bg-well` | 16×48, `repeat-x`, colour `var(--panel-hi)` below | sunken cards (agent desks) | `.timeline`, `.team-head` bayer layer |
| `stars` | 128×128, `repeat` | sparse hand-placed stars over the page | new layer on `body` (top layer) |
| `tb-shade` | 16×4, `repeat-x`, top of body | banded shade the title bar casts onto the body | new layer directly under `.pin-tile-bar` / `.modal-head` (top of the body) |
| `cloud-corner` | 160×72, `no-repeat right bottom` | airbrush pool in window body / page corner | new layer on the bodies above + `body` |
| `cloud-foot` | 112×48, `no-repeat left bottom` | sidebar foot pool | new layer on `.sidebar` (above `bg-sidebar`) |
| `header-halo` | 232×32, `no-repeat left center` | spray cloud behind the chrome h1 | new layer on `.team-header h1` |
| `sel-teal` | 80×18, `no-repeat left center` | active squad tile: teal light from a stencil bar | `.team.active .team-head` gradient (`linear-gradient(90deg, var(--pastel-violet), var(--pastel-pink))`) |
| `sel-violet` | 85×9, `no-repeat left center` | selected / hovered row: violet spray from a pink stencil bar | `.pin-row:hover, .pin-row.sel` background + `border-left-color`; `.cmd-item.on, .cmd-item:hover, .ctx-menu button:hover` |
| `sunset-plate` | 68×68, `no-repeat` | airbrushed sunset behind cast busts | portrait/avatar wells (`.card` avatar box, `.pin-tile` avatar when shown large) |
| `rule-pink`, `rule-violet` | 48×5, 3-slice x (slice 0/16/0/16) | airbrush divider: feathered 16px caps + an even ordered-dither 16px centre (no lumps when repeated) | `border-top: 1px solid var(--line)` dividers (`.modal-foot`, section separators); use `border-image` on a 10px-tall `hr`/pseudo-element |
| `meter-teal`, `-amber`, `-pink`, `-mint` | 16×5, `repeat-x` | painted meter fill | `.meter-fill, .usage-bar-fill, .brainstorm-ctx-fill` (default teal, `.meter.warn` amber, `.meter.alert` pink, ok/mint) |
| `edge-sidebar` | 2×8, `repeat-y` | sidebar right edge (LINE + INK) | `.sidebar { box-shadow: 2px 0 0 var(--shadow-hard) }` |

## 3. Title bars: `repeat-x`, 14px native = **28px CSS**
U3c sets `--bar-h: 28px`, up from U2's 20px, so the caption, the `@code` chip and the window buttons get 2px of bar above and below. Row 0 is a crisp gloss line, row 1 is 50% ordered gloss, row 12 is the shade and row 13 is the INK floor. **Rows 2-11 are clean:** the caption sits there, as do the 20px `chip-marble` and the 18px `wbtn-*`.

| Piece | Use |
|---|---|
| `tb-ramp` (192×10) + `tb-peach` | the standard bar: `background: var(--u3-tb-ramp) 0 0 / 384px 28px no-repeat, var(--u3-tb-peach) 0 0 / 32px 28px repeat-x;`. The ramp's last 16px equal `tb-peach`, so the seam is invisible. `kit.json` records this as `next: "tb-peach"`. |
| `tb-violet`, `tb-pink`, `tb-peach`, `tb-teal` (16×10) | single-hue bars: violet = inactive/menus, pink = needs-you, teal = hub/RiffBot |

**Replaces:** `var(--titlebar)` on `.pin-tile-bar, .modal-head, .handoff-panel h2` and the `--cap-imgs` title layer on `.idea-inbox, .ts-team, .ws-row, .pin-menu-list, .ctx-menu, .cmd-palette, .shortcut-modal, .daemon-disconnect-card, .drawer-*, .card, .squad-home-tile, .drawer-head, .sidebar-legend, .pin-rail-tile, .brainstorm-ctx-bar`. For those caption-less boxes, either use the full 28px bar, or keep U2's slim 12px cap: draw the strip at `32px 28px` with `background-position: 0 -16px` in a 12px-tall layer, which shows bar rows 8-13 (face, shade, INK floor). Keep `--cap-pad`. Also the four app banners (`.exposed-network-banner` → `tb-pink`, `.read-only-banner, .config-warning-banner` → `tb-peach`, `.update-available-banner` → `tb-violet`), and `.banner, .you-bar, .hard-bar.hot` → `tb-pink`.

## 4. Buttons and chips: 9-slice
**Buttons:** 24×14, slice 4/4/4/4, repeat `repeat` (tiles at 1x, never stretch). `border-image-slice: 4 fill; border-image-width: 8px; border-image-repeat: repeat;`. Ideal height is **28px CSS**. The face is rows 1-11, with gloss on rows 1-2 and shade on rows 10-11. **Rows 3-9 are flat face:** centre the label there, a 10px cap height at 2x leaves 2px clean above and below. The 6px centre band repeats if taller. Compact 18-22px controls (`.pin-menu-btn`, row `…` menus) can use the same image: the 4px caps meet in the middle. The drop is in the image, so drop the `box-shadow`. `active` has no drop; keep `transform: translate(1px,1px)`.

| Variant | Face | Text colour | Replaces |
|---|---|---|---|
| `btn-ghost-{normal,hover,active}` | PANEL_HI | `var(--text)` | `.btn.ghost, .seg button, .tchip, .squads-pager-btn, .sidebar-cog-btn, .tl-jump-bottom, .sidebar-icon-btn, .pin-tile-bar .pin-menu-btn, .modal-head .btn`, `.update-available-banner .btn:not(.ghost)` |
| `btn-primary-*` | TEAL | MARBLE + INK keyline: `text-shadow: -1px 0 var(--ink), 1px 0 var(--ink), 0 -1px var(--ink), 0 1px var(--ink), 1px 1px var(--ink)` (use the INK slot `#07040f` dark / `#35204c` light) | `.btn`, `.btn.ok:not(.confirm)`, `.drawer-working-chip, .drawer-subagent-chip`, `.btn.confirm.cool:not(.armed)` |
| `btn-hot-*` | PINK | MARBLE + INK keyline | `.btn.hot, .btn.bad, .btn.confirm.danger:not(.armed), .bad-btn` |
| `btn-on-*` | VIOLET | MARBLE + INK keyline | `.seg button.on`, active nav (`SQUADS` tab), `.tchip.on` |
| `btn-warn-*` | AMBER | INK | `.btn.warn, .btn.confirm.warn:not(.armed), .btn.successor.warn` |
| `btn-marble-*` | MARBLE | INK | window caption buttons, `.pin-tile-bar .pin-lane-handle` when clickable |

`hover` = VIOLET rim + full gloss row (replaces `:hover` background/border-color swaps). `active` = pressed: INK at the top, catch-light at the bottom, no drop (replaces `box-shadow: var(--bevel-in)`). `:disabled` keeps `opacity: .55` on `normal`.

**Chips:** 16×10, slice 3/4/3/4, repeat `repeat`. `border-image-slice: 3 4 fill; border-image-width: 6px 8px;`. Ideal height is **20px CSS**. The corners are nipped (transparent). Row 0 is gloss and row 9 is shade. **Rows 1-8 are flat:** the text goes in rows 2-6.

| Piece | Text | Replaces |
|---|---|---|
| `chip-teal` | INK | `.badge, .unit-tag, .chip, .status-pill, .project-badge, .lane-tag, .quota-pill` (`--pastel-teal`) |
| `chip-pink` | BG slot | `.badge.alert`, `.sidebar-inbox-badge`, needs-you counts, `.chip.dirty, .warn-badge, .status-pill.error, .pill, .alert-pill.tone-error, .quota-pill.hot` |
| `chip-mint` | INK | `.chip.clean, .status-pill.running, .verdict.safe, .alert-pill.tone-finished, .changes-file-badge.new` |
| `chip-amber` | INK | `.verdict.check, .alert-pill.tone-permission, .changes-file-badge.mod, .pill.diag.warn, .quota-pill.warn` |
| `chip-violet` | INK | the default `--pastel-violet` chip group (`.label-pill`, `.def-badge`, `.inbox-*`, `.brainstorm-topic-badge`, `.sidebar-role-pill`, `.rail-role-tag`, `.role-tag`, `.idea-box-profile-chip`) |
| `chip-neutral` | `var(--muted)` | `@code` lane handles in the sidebar (`.pin-lane-handle` outside title bars), counts |
| `chip-marble` | INK | `.pin-tile-bar .pin-lane-handle` (`@code` on a title bar) |
| `chip-ring-teal` | TEAL | `.sidebar-riffbot-badge` (the `RIFFBOT` pill) |

## 5. Chrome lettering: both, a font sheet **and** a pre-rendered strip
- **`brand-vibesquad`** (80×16, pre-rendered): VIBESQUAD in small chrome over a sprayed sun. It replaces the text of `.brand-text` (App.tsx brand block), shown at 160×32. Keep `.brand-sub` as live text.
- **`font-chrome-big`** (14px glyphs = 28px CSS, 3px stems) and **`font-chrome-small`** (10px = 20px CSS, 2px stems): A-Z, 0-9 and `. , ! ? - ' : / & ( ) + _ # @` and space. They're for dynamic chrome text: the team name in `.team-header h1` (TeamNameEdit, display mode only; editing stays a normal input).
  - The json `glyphs[ch] = {x, y, w, h, advance}` are cell rects in the sheet.
  - Draw a cell at `(penX + originX, penY + originY)`, where `originX/Y = -1` because the cell includes the 1px outline, then `penX += advance`.
  - Draw **left to right**: neighbouring cells overlap by their INK outline, and a later glyph paints over the earlier one's drop.
  - Text is uppercased. Unknown chars use `?`.
  - DOM option: one `span` per glyph with `background: var(--u3-font-big) -x*2px -y*2px / (sheetW*2)px auto`, `width: w*2px`, `height: h*2px`, `margin-right: (advance-w)*2px`. The negative margin is the overlap.
  - Keep the real text in an `aria-label` / visually hidden span.
  - Put `header-halo` behind the h1, and add `sparkle-l` / `sparkle-s` sprites at its ends with `::before` / `::after`.

## 6. Sprites: `sprites-{dark,light}.png` + `sprites.json` (`sprites[name] = {x,y,w,h}`, scale 2)
| Sprite | Use / replaces |
|---|---|
| `sparkle-xs/s/m/l/xl`, `sparkle-l-pink`, `sparkle-l-violet` (halo) | decorative glints: h1 ends, window title bars, needs-you chip corner, portrait corner. `anims.twinkle` = an optional 4-frame step loop (xs > m > s > m, ~180ms per frame, `steps()`); respect `prefers-reduced-motion` |
| `star-dot`, `star-plus-line/pink/teal/amber` | `.sidebar-signals-dots` marks, scattered decor |
| `pip-mint/amber/line/pink/teal` (4×4 incl. drop) | `.signal`, `.conn`, `.sidebar-stale-dot` status dots (running = mint, waiting = amber, idle/closed = line, needs-you = pink, live hub = teal); replaces their `background` + `border` + `box-shadow` |
| `wbtn-min/max/close` (9×9 = 18px CSS, sits on bar rows 2-10) | window caption buttons in `.pin-tile-bar` / `.modal-head` (the `…` menu button can use `btn-marble-*` instead) |
| `bullet-teal` | list bullets in activity lines (`.timeline` tool rows) |
| `pool-floor-pink/amber` | floor glow under cast sprites in agent cards |
| `vs-tile` | optional 17×17 brand tile. The app already ships `/vibesquad-mark-*.png`; use this only if the brand block wants the sprayed tile |

## Not covered (stays CSS)
- Text, the font family and layout/spacing (`--sp-*`).
- TeamEmblem tiles. Recolour them with `btn-warn-normal` at any size if wanted.
- Focus rings (`:focus-visible` outline stays for accessibility).
- The needs-you badge glow (U2 decision 1).
- Charts in UsageDashboard (fills can use the `meter-*` strips).
