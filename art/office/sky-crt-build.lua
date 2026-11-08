-- H1e: the thin sky-CRT bezel, one per theme, built as a 9-slice for CSS border-image:
-- art/office/sky-crt.aseprite, 10x12, INDEXED (P0). Supersedes the C2 phase 2 56x52 chunky case (owner: "waaaay thinner
-- tv/monitor bezels for the gods ... the screen must be the star").
--   slice top 3 / right 3 / bottom 5 / left 3 (public/office/sky-crt.json), drawn at scale 3 -> 9 CSS px on the top and
--   sides, a 15 CSS px chin. Corners are fixed; every edge row/column is constant along its run, so round/stretch tile
--   identically. The centre (x 3..6, y 3..6) is transparent: the face stage is the screen.
-- Per side, outside in: 1px INK outline, 1px MARBLE case (LINE on the right side and the chin's lower row = shade),
-- 1px INK glass edge. Outer corners are cut 1px (rounded). Chin corners: a 2px PINK/AMBER badge bottom-left and a
-- MINT power LED bottom-right. No feet, no stand, no clouds.
-- Layers: case, glass, details.
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/sky-crt-build.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local W, H = 10, 12
local ST, SR, SB, SL = 3, 3, 5, 3
local HX0, HX1, HY0, HY1 = SL, W - SR - 1, ST, H - SB - 1      -- transparent hole 3..6 x 3..6

local spr = L.new(W, H, pal)
local C = {}
for _, n in ipairs({ "case", "glass", "details" }) do C[n] = L.canvas(spr, L.layer(spr, n), spr.frames[1]) end

-- ======================= case: MARBLE face, LINE shade (right + chin underside), INK outline =======================
C.case.stamp(0, 0, [[
|.kkkkkkkk.|
|kmmmmmmmlk|
|kmmmmmmmlk|
|kmm....mlk|
|kmm....mlk|
|kmm....mlk|
|kmm....mlk|
|kmmmmmmmlk|
|kmmmmmmmlk|
|kmmmmmmmlk|
|kllllllllk|
|.kkkkkkkk.|
]], { k = L.INK, m = L.MARBLE, l = L.LINE })
C.case.commit()

-- ======================= glass: the INK edge round the screen hole =======================
do
  local c = C.glass
  c.hline(HX0 - 1, HY0 - 1, HX1 - HX0 + 3, L.INK); c.hline(HX0 - 1, HY1 + 1, HX1 - HX0 + 3, L.INK)
  c.vline(HX0 - 1, HY0 - 1, HY1 - HY0 + 3, L.INK); c.vline(HX1 + 1, HY0 - 1, HY1 - HY0 + 3, L.INK)
  c.commit()
end

-- ======================= details: chin badge (bottom-left corner), power LED (bottom-right corner) =======================
do
  local c = C.details
  c.px(1, 9, L.PINK); c.px(2, 9, L.AMBER)
  c.px(W - 3, 9, L.MINT)
  c.commit()
end

spr:saveAs(root.."/art/office/sky-crt.aseprite")
local flat = Image(W, H, ColorMode.INDEXED); flat:clear(0); flat:drawSprite(spr, spr.frames[1])
spr:close()
for y = HY0, HY1 do for x = HX0, HX1 do flat:drawPixel(x, y, 0) end end   -- centre stays transparent
for _, mode in ipairs({ "dark", "light" }) do
  local out = Sprite(W, H, ColorMode.INDEXED)
  out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
  out.transparentColor = 0
  out.cels[1].image = flat
  out:saveAs(root.."/public/office/sky-crt-"..mode..".png"); out:close()
end
print("wrote sky-crt "..W.."x"..H.." slice "..ST.."/"..SR.."/"..SB.."/"..SL)

-- ======================= wall: the shared seam between the two butted TVs (G8b) =======================
-- "Two gods in the sky always fighting for control, awful roommates": a thin brick wall, 4x20, INDEXED (P0),
-- public/office/sky-wall-{dark,light}.png, sky-crt.json wall = width 4, scale 3 (12 CSS px), slice top 3 / bottom 5.
-- The caps line up with the bezel's top band and chin (same 3/5 rows): row 0 and the last row are INK so the TVs'
-- outer outline runs straight across the wall. Rows 3..14 are a 12-row brick tile (three CORAL courses, 3 rows each
-- over a LINE mortar row, one MARBLE shine) that repeats round; one INK crack lives in the bottom cap so it shows once.
-- The TVs drop their bezel side at the seam: the wall's INK columns are the screens' glass edges there.
do
  local WW, WH = 4, 20
  local wspr = L.new(WW, WH, pal)
  local c = L.canvas(wspr, L.layer(wspr, "wall"), wspr.frames[1])
  c.stamp(0, 0, [[
|kkkk|
|kcck|
|kllk|
|kmck|
|kcck|
|kcck|
|kllk|
|kcck|
|kcck|
|kcck|
|kllk|
|kcck|
|kcck|
|kcck|
|kllk|
|kcck|
|kckk|
|kkck|
|kclk|
|kkkk|
]], { k = L.INK, c = L.CORAL, l = L.LINE, m = L.MARBLE })
  c.commit()
  wspr:saveAs(root.."/art/office/sky-wall.aseprite")
  local wflat = Image(WW, WH, ColorMode.INDEXED); wflat:clear(0); wflat:drawSprite(wspr, wspr.frames[1])
  wspr:close()
  for _, mode in ipairs({ "dark", "light" }) do
    local out = Sprite(WW, WH, ColorMode.INDEXED)
    out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
    out.transparentColor = 0
    out.cels[1].image = wflat
    out:saveAs(root.."/public/office/sky-wall-"..mode..".png"); out:close()
  end
  print("wrote sky-wall "..WW.."x"..WH.." slice 3/5")
end
