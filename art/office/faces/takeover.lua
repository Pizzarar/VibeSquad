-- Overlord "takeover glitch" overlay (owner: tapping the Overlord makes him assimilate RiffBot
-- like a virus while Riff looks terrified). Drawn over RiffBot's 80x48 widescreen TV cell (H1c-v3, G8 50/50 TVs). A jagged glitch
-- front eats in from the right edge (the Overlord's side): rows step in hand-placed runs of
-- 1/2/3/5px, 1px scanline spikes shoot ahead into Riff's screen, 2-3px corruption bars
-- (ink/pink/coral/mint) hop in front, and the front itself burns pink/coral with an ink edge.
-- Behind the front the Overlord's real face (its needs[0] cell, H1c-v3 jar: murky water, floating
-- brain, 2 dangling googly eyeballs, floating teeth, zaps, "!" badge) spreads over Riff's TV, with thin CRT interference streaks and 1-2px
-- scanline jitter bands; the last frame is the complete Overlord face with a few static streaks.
-- H0 hand: every run, spike, bar and streak is hand-placed; flat P0 fills, no gradients.
-- Transparent (index 0) where uncovered.
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/faces/takeover.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local K, P, CO, G, Y, LN = 15, 9, 10, 12, 13, 3
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local CW, CH = 80, 48
local N = 8
local FPS = 13                                   -- 8 frames / 13 fps ~ 615 ms

-- the Overlord's needs[0] cell (public/office/faces.json overlord.needs[0] = x640), same P0 indices
local OVX = 640
local ov = Image{ fromFile = root.."/public/office/face-overlord-dark.png" }

-- front x per frame (covered where x >= front); frame 8 = full takeover
local FRONT = { 73, 62, 50, 38, 27, 15, 4, -99 }
-- row runs {height, offset}: asymmetric 1/2/3/5px steps, sums to 49 rows
local RUNS = { {3,0}, {1,-4}, {2,2}, {5,-1}, {1,3}, {3,-3}, {2,1}, {1,-6}, {5,2}, {3,-2},
               {2,0}, {1,4}, {3,-1}, {5,3}, {2,-2}, {1,1}, {3,0}, {2,-4}, {1,2}, {3,-1} }
-- per frame: 1px scanline spikes {row, length} and corruption bars {row, height, width, gap, colour}
local SPIKES = {
  { {6,11}, {29,15}, {40,8} },
  { {3,14}, {18,20}, {37,9} },
  { {11,18}, {24,11}, {40,21} },
  { {2,12}, {15,21}, {33,15}, {45,9} },
  { {8,17}, {21,9}, {30,20}, {43,14} },
  { {5,21}, {19,14}, {36,18} },
  { {13,15}, {27,12}, {41,17} },
}
local BARS = {
  { {20,2,5,4,K}, {35,2,3,6,P} },
  { {9,3,6,6,P}, {31,2,8,4,K} },
  { {4,2,6,8,CO}, {17,3,5,4,G}, {34,2,9,6,K} },
  { {10,3,8,6,P}, {26,2,5,9,K}, {39,3,6,4,CO} },
  { {3,2,9,8,K}, {16,3,6,4,P}, {37,2,8,6,G} },
  { {12,2,6,4,CO}, {25,3,8,8,K}, {44,2,5,4,P} },
  { {7,3,6,3,K}, {33,2,5,3,P} },
}
-- CRT interference streaks behind the front {x, y, width, colour}; odd frames shift 2px
local STREAKS = { {50,4,9,LN}, {63,10,6,P}, {55,17,12,LN}, {68,26,5,P}, {40,31,8,LN}, {60,38,11,LN},
                  {30,44,6,P}, {17,8,8,LN}, {7,22,9,P}, {20,35,5,LN}, {45,12,6,LN}, {10,41,11,LN},
                  {72,2,4,LN}, {34,24,5,P} }
-- scanline jitter bands in the revealed face {frame, y0, height, dx}
local JITTER = { {4,14,2,2}, {5,30,3,-3}, {6,8,2,3}, {6,36,2,-2}, {7,22,3,2} }

local function frontAt(y, f)
  if f == N then return -99 end
  local acc, i = 0, #RUNS
  for k, r in ipairs(RUNS) do
    acc = acc + r[1]
    if y < acc then i = k break end
  end
  return FRONT[f] + RUNS[i][2] + ((i + f) % 3 - 1)
end

local function draw(C, f)
  -- 1. revealed Overlord face behind the front
  for y = 0, CH - 1 do
    local fx = frontAt(y, f)
    local dx = 0
    for _, j in ipairs(JITTER) do if j[1] == f and y >= j[2] and y < j[2] + j[3] then dx = j[4] end end
    for x = math.max(fx, 0), CW - 1 do
      local sx = math.min(math.max(x - dx, 0), CW - 1)
      local c = ov:getPixel(OVX + sx, y)
      C.px(x, y, c ~= 0 and c or Y)
    end
  end
  -- 2. interference streaks (only on liquid, never over the face parts)
  for _, s in ipairs(STREAKS) do
    local sx = s[1] + ((f % 2 == 1) and 2 or 0)
    for x = sx, sx + s[3] - 1 do
      if x >= frontAt(s[2], f) + 3 and C.get(x, s[2]) == Y then C.px(x, s[2], s[4]) end
    end
  end
  if f < N then
    -- 3. burning front: 2px pink/coral just behind the edge, alternating per run
    for y = 0, CH - 1 do
      local fx = frontAt(y, f)
      local c = (math.floor((fx + y) / 3) % 2 == 0) and P or CO
      C.px(fx, y, c); C.px(fx + 1, y, c)
    end
    -- 4. spikes shoot ahead, bars hop in front
    for _, s in ipairs(SPIKES[f]) do
      local fx = frontAt(s[1], f)
      C.hline(fx - s[2], s[1], s[2], (s[2] % 2 == 0) and P or CO)
    end
    for _, b in ipairs(BARS[f]) do
      local fx = frontAt(b[1], f)
      C.rect(fx - b[4] - b[3], b[1], b[3], b[2], b[5])
    end
    C.outline(K)                                               -- ink edge on the creeping front
  end
  -- gutter contract: columns 0 and CW-1 are flat SKY wherever the overlay covers them
  for y = 0, CH - 1 do for _, x in ipairs({ 0, CW - 1 }) do
    if C.get(x, y) ~= 0 then C.px(x, y, Y) end
  end end
end

local spr = L.new(CW, CH, pal)
for i = 2, N do spr:newFrame() end
local lay = L.layer(spr, "glitch")
local strip = Image(CW * N, CH, ColorMode.INDEXED); strip:clear(0)
local js = {}
for f = 1, N do
  local C = L.canvas(spr, lay, spr.frames[f])
  draw(C, f)
  C.commit()
  strip:drawImage(C.img, Point((f - 1) * CW, 0))
  js[#js + 1] = '{"x":'..((f - 1) * CW)..',"y":0}'
end
spr:saveAs(root.."/art/office/faces/takeover.aseprite"); spr:close()
for _, mode in ipairs({ "dark", "light" }) do
  local out = Sprite(CW * N, CH, ColorMode.INDEXED)
  out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
  out.transparentColor = 0
  out.cels[1].image = strip
  out:saveAs(root.."/public/office/takeover-"..mode..".png"); out:close()
end
local fo = io.open(root.."/public/office/takeover.json", "wb")
fo:write('{"version":1,"cell":{"w":'..CW..',"h":'..CH..'},"fps":'..FPS..',\n "frames":['..table.concat(js, ",")..']}\n')
fo:close()
print("wrote takeover "..N.." frames @ "..FPS.." fps")
