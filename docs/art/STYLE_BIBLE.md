# VibeSquad Style Bible (H1)

One hand for everything: cast, variants, RiffBot/Overlord faces, office, floor, tower and sky.
That hand is **PC-98 caricature**: goofy, wobbly, Hypnospace-style weirdos drawn with chunky
shapes, a 1px ink outline and the P0 palettes. If a new piece could not sit on the H0 sheet
without looking like a different artist drew it, it fails.

**Every Director compares against H0, never against the last iteration.**

## The reference (canon)

| What | Path | Source |
|---|---|---|
| H0 cast sheet (dark / light) | `scratch/shots/cast-h0-dark.png`, `scratch/shots/cast-h0-light.png` | 65d1858, `art/cast/hypno/{lib,bust,floor,front,sheet}.lua` |
| S2 app-icon busts, 10 roles | `scratch/shots/h1-ref-s2-busts.png` (= `public/cast.png` at 99a3ec8; column 1 of today's file) | 0b2eaa8, 99a3ec8, `art/cast/hypno/{bust,bust_extra}.lua` |
| Palettes P0 | `art/palette/pc98-{dark,light}.gpl`, slot map `art/palette/slots.md` | f0e6fc7 |
| H1 gallery (gate sheet, H0 beside it) | `scratch/shots/h1-gallery-{dark,light}{,-3x}.png` | `art/h1/gallery.lua` |

## What makes the hand

- **Proportions.** Busts: head is about half the 64px cell, shoulders cut by the bottom edge.
  Floor sprites (32px): head about 15px wide, as tall as the torso. Heads are big, bodies are
  boxes with one loud costume idea (shoulder pads, windbreaker, cardigan).
- **Silhouette first.** Every character has one absurd shape you can read at 16px: pompadour +
  brick phone, headphone arc, TV cabinet, eyeball on a stalk. Variants change *that shape*.
- **Wobble.** Ellipses get per-row wobble tables (`WOB_L` / `WOB_R` in `bust.lua`), polys are
  lopsided, no two sides mirror. Nothing is ruler-straight except desks and screens.
- **Line.** Every object gets its own **1px INK (slot 15) outline**, drawn outside the shape
  (`C.outline`), per layer, so overlapping parts stay separated. Interior detail is INK lines
  (lapels, seams, creases). No anti-aliasing, no coloured outlines, no sel-out.
- **Shading.** Flat fills. Light comes from a few hand-placed MARBLE shine pixels (pads, cups,
  bald heads) and the occasional VIOLET rim on dark hair. Bayer 4x4 dither **only** on big
  gradients (sky, haze), never on faces, bodies or props.
- **Eyes.** Googly, MARBLE, lopsided: left smaller, right bigger and 1px higher; 2x3 INK pupil
  with a 1px MARBLE catch-light; uneven raised INK brows. Non-humans keep googly eyes (on the
  TV screen, on the stalk, sewn on the sock).
- **Mouth.** INK line mouths: lopsided smile with 2 PINK px, wide grin with a PINK tongue band,
  or a small "o". Blush = two CORAL blocks of different sizes; nose = 2 CORAL px off-centre.
- **Expressions.** *Rest* = lids half down (lid filled with the head/screen colour, INK lid
  line), pupils low, small smile. *Yo!* (needs-you) = eyes wide, pupils up, brows high, mouth
  open, a hand up and a MARBLE "YO!" balloon with PINK letters (floor: pink "!" sign).
- **Palette use.** Only P0 slots, indexed. Figure pixels use slots that keep their role in both
  modes: INK, VIOLET, PINK, CORAL, AMBER, SKIN, MARBLE, TEAL, MINT. SKY (13) only for screens
  and sky. PANEL / PANEL_HI / LINE are for rooms, wells and wallpaper. Max 4-5 slots per figure
  besides INK; one loud accent (PINK jacket, AMBER cabinet). Dark and light are a pure palette
  swap of the same indexed file (no repaint).
- **Props are characters too.** Phones, TVs, mugs, plants, clocks: chunky, outlined, slightly
  crooked. One object per scene may get googly eyes; most do not.

## Do / don't

| Do | Don't (real drift) |
|---|---|
| Variants are different **weirdos**: new head shape, species or oddity (3-eye pear, sock puppet, cone head), keeping the role's costume cue (review = violet cardigan + bow tie, lead = pink pads + brick phone) | cast v2 (e150f28): v1-v3 = the same v0 face with slot recolours plus a party hat / crown / bow. That is a recolour, not a variant |
| Big googly eyes and INK line mouths on everything with a face, including TVs | RiffBot (C2a R4, `public/office/face-riffbot-*`): smooth anime eyes and thin brows on a flat screen, no googly eyes, reads as a different game |
| One solid object per face with an outline | Overlord (`public/office/face-overlord-*`): brain, eyes and teeth floating as separate parts on the background, no body, no outline around the whole |
| Chunky furniture, 1px INK outline, few big shapes, a crooked plant, a wonky clock | Floor F4 (`public/office/floor-*`): dense 1px-detail iso furniture and thin lines, no outlines, too small to read at 1x next to the cast |
| Generic chibi is out: no tiny-body/huge-shiny-eye anime proportions, no smooth gradients on skin | Chibi pixel portraits / anime ladder tiers (R0) and AI-generated plates: rejected |
| Dither the sky only | Dithered skin, dithered jackets |
| Goofy, friendly, a bit gross-cute | Drips, slime, liquids, horror |

## Contract

Art passes never change sprite contract shapes: cell sizes (32px floor, 64px bust, 48px face),
frame lists and JSON keys (`cast.json`, `faces.json`, `floor.json`) stay as they are. Only pixels
change.

## Review rule

1. Review at **3840x2160, 120% app zoom first** (the owner's real setup), then 1x and 3x sheets.
2. The Director always puts the piece **side by side with the H0 sheet** (`cast-h0-{dark,light}.png`)
   and asks one question: same hand? Earlier rounds are not the reference.
3. Check both palettes (dark and light) every round.
4. Aseprite only, hand-placed pixels, no AI art. Inspiration-only refs need no CREDITS entry.
