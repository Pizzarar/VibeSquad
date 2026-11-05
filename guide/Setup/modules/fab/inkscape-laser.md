---
id: inkscape-laser
group: fab
level: 1
method: doc-only
winget_id: n/a
verified: 2026-10-30 (reuses the inkscape module; winget show: 1.4.4)
licence: free
size: small   # no extra install (uses the inkscape module)
---

# Inkscape for laser and CNC art

## When you want this
You want to draw or prepare shapes that a laser cutter, engraver or CNC will follow. This is a how-to module: it adds no new software. It reuses [Inkscape](../art/inkscape.md) and explains the three habits that make files work in [LightBurn](lightburn.md), a CNC CAM tool, or any other laser software.

## Install (Windows)
Install the [inkscape](../art/inkscape.md) module first. Nothing else is needed.

## macOS line
macOS: Same as the inkscape module. UNVERIFIED on macOS.

## Verify
Run the PATH refresh first (see `START_HERE.md`, "PATH refresh").
Use the Verify of the [inkscape](../art/inkscape.md) module (`inkscape --version`, expected `Inkscape 1.4`, with its
full-path fallback). Then a **human check**: the real test is the First run below, an SVG or DXF that opens in your
laser software with the shapes at the right size. Say "done" when it does.

## First run (the human's steps)
**1. Work in millimetres.** In **File > Document Properties**, set the display units and the page size to `mm`. Draw a 50 mm square and check the size in the toolbar. If your laser software shows a different size after import, scale is the first suspect.

**2. Use hairline strokes for cut lines.** Laser software cuts along a path, not around a fat line. For every cut or score line:
- No fill (the X in the fill swatch), only a stroke.
- Stroke width very thin, for example 0.01 mm, or whatever your software treats as "line only". A thick stroke may be read as a filled shape and get engraved or cut twice.
- Use **Path > Object to Path** on text and **Path > Stroke to Path** only for shapes you want engraved as solid areas.

**3. One colour per operation.** LightBurn and most laser software turn each stroke colour into a layer with its own power and speed. A common scheme, so you can keep it the same on every project:
- Red `#FF0000`: cut all the way through.
- Blue `#0000FF`: score (light line, no cut-through).
- Black fill: engrave (raster).
Keep colours exact (use the Fill and Stroke panel's RGBA field). Slightly different reds become different layers.

**4. Export.**
- **SVG**: **File > Save As > Plain SVG** is the safest for other software. Check **Edit > Select All in All Layers** first so nothing is hidden or locked.
- **DXF**: **File > Save a Copy > Desktop Cutting Plotter (AutoCAD DXF R14)**. DXF drops colours in some setups, so put each operation on its own Inkscape layer and name the layers `CUT`, `SCORE`, `ENGRAVE`, and check the layers arrived in your software. UNVERIFIED: how each laser program maps DXF layers, so test with a small piece.

**5. Prepare for the cut.**
- Join open paths (**Path > Combine** or **Ctrl+K**), and delete duplicates, since a duplicate line cuts twice and burns the edge.
- Put inner cuts (holes) before outer cuts in your laser software so the part does not shift. This is set in the software, not in Inkscape.
- Add kerf allowance (the width the laser burns away) for press fits. Test with a small slot first.

## Gotchas
- Inkscape can save a mixed file with text still as text. Convert text to paths first or the laser reads nothing.
- Do not use images you do not own. Trace your own drawings (**Path > Trace Bitmap**) and clean up the paths.
- Never leave a running laser alone, and test on scrap first.

## Try with your agent
Ask: "Write a Python script (no libraries) that writes an SVG finger-jointed box with parameters at the top: width, depth, height, material thickness, kerf. Red hairline for the cut, units in mm." Run it, open the SVG in Inkscape, and check the size with the rectangle tool. Then change the thickness to match your sheet, rerun, and import into LightBurn. The script is your rerunnable design: keep it in git, and change numbers instead of redrawing.

For a **living-hinge coaster** ask for a script that draws a circle (cut) and rows of staggered short slots inside it (cut) with a second ring in blue (engrave). Print or cut one in cardboard first.
