-- C2 phase 2: the sky-CRT bezel, one per theme (docs/PLAN_NEON_OFFICE.md "C2: Sky gods" Art 2), built as a
-- 9-slice for CSS border-image: art/office/sky-crt.aseprite, 56x52, INDEXED (P0).
--   slice top 14 / right 20 / bottom 30 / left 20 (public/office/sky-crt.json), drawn at scale 3.
--   Corners are fixed. The top and side edges are constant along their run, so they repeat, round or
--   stretch identically. The bottom edge (x 20..35) is just the chin, transparent below (the TV floats);
--   the cloud clusters live in the two bottom corners. The centre (x 20..35, y 14..21) is transparent.
-- Case: beige/white plastic (MARBLE, LINE shade on the right + chin), INK outline, rounded outer corners,
-- a LINE recess on the top/left of the glass, INK + SKY_TOP glass lip round the hole. Bottom-left corner:
-- a little VIOLET/PINK/AMBER badge; bottom-right: a knob + MINT power LED. The case is inset 3px on the
-- sides so the base clouds can bulge past it; clouds use art/office/sky-lib.lua (same as the sky band).
-- Layers: case, glass, details, clouds.
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/sky-crt-build.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local S = dofile(root.."/art/office/sky-lib.lua")
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local W, H = 56, 52
local ST, SR, SB, SL = 14, 20, 30, 20
local HX0, HX1, HY0, HY1 = SL, W - SR - 1, ST, H - SB - 1      -- transparent hole 20..35 x 14..21
local CX0, CX1, CY0, CY1 = 3, W - 4, 0, 35                        -- case outline box

local spr = L.new(W, H, pal)
local C = {}
for _, n in ipairs({ "case", "glass", "details", "clouds" }) do C[n] = L.canvas(spr, L.layer(spr, n), spr.frames[1]) end

-- ======================= case: rounded box, MARBLE face, INK outline, LINE shade =======================
do
  local c = C.case
  local round = { 3, 1, 1 }                                     -- inset per row from a corner (face box)
  for y = CY0 + 1, CY1 - 1 do
    local r = math.min(y - (CY0 + 1), (CY1 - 1) - y)
    local ins = round[r + 1] or 0
    c.hline(CX0 + 1 + ins, y, (CX1 - 1 - ins) - (CX0 + 1 + ins) + 1, L.MARBLE)
  end
  for y = CY0 + 2, CY1 - 1 do                                   -- right-side shade
    for x = CX1 - 1, CX0 + 1, -1 do if c.get(x, y) == L.MARBLE then c.px(x, y, L.LINE); break end end
  end
  for x = CX0 + 2, CX1 - 1 do                                   -- chin bottom shade
    for y = CY1 - 1, CY0 + 1, -1 do if c.get(x, y) ~= 0 then c.px(x, y, L.LINE); break end end
  end
  c.outline(L.INK)
  c.commit()
end

-- ======================= glass: recess shade, INK ring, SKY_TOP lip, transparent hole =======================
do
  local c = C.glass
  local function ring(x0, y0, x1, y1, col)
    c.hline(x0, y0, x1 - x0 + 1, col); c.hline(x0, y1, x1 - x0 + 1, col)
    c.vline(x0, y0, y1 - y0 + 1, col); c.vline(x1, y0, y1 - y0 + 1, col)
  end
  c.hline(HX0 - 3, HY0 - 3, (HX1 + 2) - (HX0 - 3) + 1, L.LINE)  -- recess: bezel shadow on top + left
  c.vline(HX0 - 3, HY0 - 3, (HY1 + 2) - (HY0 - 3) + 1, L.LINE)
  ring(HX0 - 2, HY0 - 2, HX1 + 2, HY1 + 2, L.INK)
  ring(HX0 - 1, HY0 - 1, HX1 + 1, HY1 + 1, L.SKY)
  for _, p in ipairs({ { HX0 - 1, HY0 - 1 }, { HX1 + 1, HY0 - 1 }, { HX0 - 1, HY1 + 1 }, { HX1 + 1, HY1 + 1 } }) do
    c.px(p[1], p[2], L.INK)                                     -- rounded glass corners
  end
  c.commit()
end

-- ======================= details: badge (bottom-left), knob + LED (bottom-right) =======================
do
  local c = C.details
  c.stamp(8, 26, [[
|kkkkkkk|
|kvvvvvk|
|kpppppk|
|kaaaaak|
|kkkkkkk|
]], { k = L.INK, v = L.VIOLET, p = L.PINK, a = L.AMBER })
  c.stamp(W - 16, 26, [[
|.kk.....|
|kmlk.kk.|
|kllk.ggk|
|.kk..kk.|
]], { k = L.INK, m = L.MARBLE, l = L.LINE, g = L.MINT })
  c.commit()
end

-- ======================= clouds: a low, wide cushion hugging each bottom corner =======================
-- Wider than tall, stepped domes, MARBLE + PINK belly row + VIOLET outline (same as the sky cumulus),
-- bottom outline 4px under the chin (row 39). Inside x 0..18 / 37..55, so the bottom edge tile is untouched.
do
  local c = C.clouds
  local o = { base = 38, und = 1, flat = true, seams = false }
  S.cloud(c, L, { { 2, 34, 3, 3 }, { 7, 34, 6, 4 }, { 13, 36, 5, 3 } }, o)       -- left
  S.cloud(c, L, { { 53, 34, 3, 3 }, { 49, 34, 6, 4 }, { 42, 36, 5, 3 } }, o)     -- right
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
