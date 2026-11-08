-- T1a takeover label scrawl (docs/PLAN_NEON_OFFICE.md T1): while the Overlord has taken over Riff's TV, the
-- "RiffBot" zone label chip (.sky-crt-name) gets a messy marker strike-through and "OVERLORD" scrawled after it.
-- H0 hand: every stroke is a hand-picked polyline, every letter a hand-stamped ASCII map with its own wobble.
-- One PINK marker pen, one INK outline pass. Transparent everywhere else, so the real label shows under the strike.
-- Sized to the measured chip (80x22 CSS px at 1080; 96x26 device px at 4K@120%): drawn at scale 2 (crispScale),
-- art (AX, AY) sits on the chip's left edge at its vertical middle.
-- Writes art/office/takeover-label.aseprite, public/office/takeover-label-{dark,light}.png.
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/takeover-label.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local P, K = L.PINK, L.INK
local W, H = 118, 16
local AX, AY = 2, 10 -- chip left-middle anchor, in art px

local spr = L.new(W, H, Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" })
local lay = { ink = L.layer(spr, "ink"), pen = L.layer(spr, "pen") }
local pen = L.canvas(spr, lay.pen, spr.frames[1])
local ink = L.canvas(spr, lay.ink, spr.frames[1])

-- 1px marker stroke through hand-picked points (Bresenham per segment)
local function stroke(pts)
  for i = 1, #pts - 1 do
    local x0, y0, x1, y1 = pts[i][1], pts[i][2], pts[i+1][1], pts[i+1][2]
    local dx, dy = math.abs(x1 - x0), -math.abs(y1 - y0)
    local sx, sy = x0 < x1 and 1 or -1, y0 < y1 and 1 or -1
    local err = dx + dy
    while true do
      pen.px(x0, y0, P)
      if x0 == x1 and y0 == y1 then break end
      local e2 = 2 * err
      if e2 >= dy then err = err + dy; x0 = x0 + sx end
      if e2 <= dx then err = err + dx; y0 = y0 + sy end
    end
  end
end

-- the strike: bare marker (no outline) so the real label shows between the strokes: out across the chip,
-- a sloppy return under it, then back over and off toward the word. Only the flick into the word gets INK.
stroke({ {AX+1, AY}, {AX+9, AY-1}, {AX+17, AY}, {AX+26, AY-2}, {AX+35, AY-1}, {AX+44, AY-2} })
stroke({ {AX+44, AY-2}, {AX+37, AY+2}, {AX+27, AY+1}, {AX+16, AY+3}, {AX+5, AY+2} })
stroke({ {AX+5, AY+2}, {AX+14, AY+1}, {AX+24, AY+1} })
local bare = {}
for y = 0, H - 1 do for x = 0, W - 1 do if pen.get(x, y) == P then bare[y * W + x] = true end end end
stroke({ {AX+44, AY-2}, {AX+48, AY-3}, {AX+51, AY-5} })

-- OVERLORD, hand lettered with 2px marker stems: each glyph its own lean and wobble (no font)
local G = {
O1 = [[
|.pppp.|
|pp..pp|
|pp..pp|
|pp..pp|
|pp..pp|
|pp..pp|
|pp.pp.|
|.ppp..|
]],
V = [[
|pp..pp|
|pp..pp|
|pp..pp|
|pp..pp|
|.pp.pp|
|.pp.p.|
|..ppp.|
|..pp..|
]],
E = [[
|.ppppp|
|pp....|
|pp....|
|pppp..|
|pp....|
|pp....|
|pp....|
|.ppppp|
]],
R1 = [[
|ppppp.|
|pp..pp|
|pp..pp|
|pp.pp.|
|pppp..|
|pp.pp.|
|pp..pp|
|pp..pp|
]],
L = [[
|pp....|
|pp....|
|pp....|
|pp....|
|.pp...|
|.pp...|
|.pp...|
|.ppppp|
]],
O2 = [[
|..ppp.|
|.pp.pp|
|pp..pp|
|pp..pp|
|pp..pp|
|pp..pp|
|pp.pp.|
|.ppp..|
]],
R2 = [[
|pppp..|
|pp.pp.|
|pp..pp|
|pp.pp.|
|pppp..|
|pp.pp.|
|pp..pp|
|pp...p|
]],
D = [[
|pppp..|
|pp.pp.|
|pp..pp|
|pp..pp|
|pp..pp|
|pp..pp|
|pp.pp.|
|pppp..|
]],
}
-- x step 8 (6 wide + 2 gap the outline fills), baseline climbs as the hand speeds up
local word = { {"O1",0,4}, {"V",8,3}, {"E",16,4}, {"R1",24,2}, {"L",32,2}, {"O2",39,1}, {"R2",47,0}, {"D",55,1} }
local WX, WY = AX + 52, AY - 8
for _, g in ipairs(word) do pen.stamp(WX + g[2], WY + g[3], G[g[1]], { p = P }) end

-- one INK outline pass round every pen pixel except the bare strike (8-neighbour: diagonals don't leak)
for y = 0, H - 1 do for x = 0, W - 1 do
  if pen.get(x, y) == 0 then
    local hit = false
    for j = -1, 1 do for i = -1, 1 do
      local xx, yy = x + i, y + j
      if pen.get(xx, yy) == P and not bare[yy * W + xx] then hit = true end
    end end
    if hit then ink.px(x, y, K) end
  end
end end

pen.commit(); ink.commit()
spr:saveAs(root.."/art/office/takeover-label.aseprite")
local flat = Image(W, H, ColorMode.INDEXED); flat:clear(0); flat:drawSprite(spr, 1)
spr:close()
for _, mode in ipairs({"dark", "light"}) do
  local out = Sprite(W, H, ColorMode.INDEXED)
  out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
  out.transparentColor = 0
  out.cels[1].image = flat
  out:saveAs(root.."/public/office/takeover-label-"..mode..".png"); out:close()
end
print("wrote takeover-label "..W.."x"..H.." anchor "..AX..","..AY)
