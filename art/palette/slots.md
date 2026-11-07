# PC-98 Vaporwave palettes: slot map (P0)

Two index-matched 16-colour palettes. Slot N plays the same role in both, so any indexed
Aseprite file swaps between modes by loading the other `.gpl` (no repaint).

- Dark "Midnight Mall": `pc98-dark.gpl`
- Light "Pastel Morning": `pc98-light.gpl`
- Source of truth: `gen_palettes.py` (writes both `.gpl` files and prints the contrast table).
- Swatch sheet: `build_sheet.lua` (Aseprite batch) writes `scratch/shots/palette-p0.png`.

| Slot | Role | Dark hex | Light hex | CSS var(s) (src/styles.css:8-25) | Art use |
|---|---|---|---|---|---|
| 00 | BG | `#140c26` | `#fdf4ec` | `--bg`, `--navy` | page bg, inset wells; label colour on accent fills |
| 01 | PANEL | `#21163d` | `#f5e6ef` | `--panel` | windows, cards; floor base |
| 02 | PANEL_HI | `#33255c` | `#e9d5e8` | `--panel-hi`, `--panel-alt` | raised rows, secondary buttons, panel fade end; mall walls, desk front |
| 03 | LINE | `#54428a` | `#bba3cf` | `--line`, `--slate` | borders, dividers; marble/CRT shade |
| 04 | MARBLE | `#d9cde9` | `#fffdfa` | (new token, U1) | marble, CRT case, title-bar buttons, speech bubble fill |
| 05 | TEXT | `#f7f0ff` | `#2b1840` | `--text` | body text |
| 06 | MUTED | `#b5a5d8` | `#65507d` | `--muted` | secondary text, CRT text lines |
| 07 | TEAL | `#4fd6cf` | `#1a868a` | `--cyan`, `--cyan-dim` (= slot 07 @ 0x26 alpha) | primary accent / primary button; desk tops, shirts |
| 08 | VIOLET | `#9b72e8` | `#9a7fe0` | `--violet`, `--violet-dim` (= slot 08 @ 0x26) | title bars; sky ramp step 2, floor grid |
| 09 | PINK | `#ff68a8` | `#d63f88` | `--hot-pink`, `--hot-pink-dim` (= slot 09 @ 0x30) | **needs-you** badge, alerts; sky ramp step 3, horizon haze |
| 10 | CORAL | `#ff8e78` | `#f6967f` | `--coral` | sky ramp step 4; blush/skin shade |
| 11 | AMBER | `#ffc46c` | `#f7bf5c` | `--amber` | waiting state; sun, sky ramp step 5, lit windows |
| 12 | MINT | `#79dfa8` | `#2e9462` | `--emerald` | running/ok state; Memphis squiggles, LEDs |
| 13 | SKY_TOP | `#2a1b6b` | `#95d3f2` | (art only) | sky ramp step 1 (zenith), CRT screen bg |
| 14 | SKIN | `#f1c2a2` | `#f6cdb2` | (art only) | cast skin |
| 15 | INK | `#07040f` | `#35204c` | (art only; U1 may use for text on accent fills) | 1px outlines, hair, silhouettes (palm) |

Sky gradient (Bayer 4x4, gradients only): 13 SKY_TOP > 08 VIOLET > 09 PINK > 10 CORAL > 11 AMBER.
Horizon haze: 09 > 02 > 01. Panel fade: 01 > 02.

## Contrast (WCAG 2.x ratio, from `gen_palettes.py`)

| Pair | Dark | Light |
|---|---|---|
| TEXT on BG | 16.99 | 14.78 |
| TEXT on PANEL | 15.13 | 13.35 |
| TEXT on PANEL_HI | 12.09 | 11.59 |
| MUTED on BG | 8.41 | 6.45 |
| MUTED on PANEL | 7.49 | 5.82 |
| MUTED on PANEL_HI | 5.99 | 5.05 |
| TEAL on BG / PANEL | 10.67 / 9.51 | 4.01 / 3.62 |
| PINK on BG / PANEL | 7.02 / 6.25 | 3.92 / 3.54 |
| MINT on BG / PANEL | 11.65 / 10.37 | 3.50 / 3.16 |
| VIOLET on BG / PANEL | 5.37 / 4.78 | 2.98 / 2.69 |
| needs-you label: BG on PINK | 7.02 | 3.92 |

Body text (TEXT, MUTED) clears 4.5:1 on every surface in both modes. In light mode the accents
are UI-component colours (>= 3:1 for TEAL/PINK/MINT on BG and PANEL) for borders, fills, icons and
bold labels, not body copy. AMBER/CORAL/VIOLET are fills only in light mode (sun, sky, title bar);
text on them uses INK or BG.
