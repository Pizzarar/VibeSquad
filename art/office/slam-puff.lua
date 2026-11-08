-- RS-a impact puff: the 4-frame burst at the edges of RiffBot's chat window when it slams into the
-- Overlord's TV (docs/PLAN_NEON_OFFICE.md "RS: Riff slam"). H0 hand: flat P0 fills, 1px INK outline,
-- MARBLE cloud puffs with a VIOLET underside, chunky AMBER stars. No googly prop (the Overlord's eyes are the 2a one).
--   f0 flash: hard 4-spike star + INK speed ticks   f1 burst: full cloud ring, 3 stars pop out
--   f2 break: ring splits into 5 drifting puffs      f3 wisps: 4 tiny puffs + 1 twinkle, then gone
-- Transparent (index 0) background, burst centred in each cell so the UI can anchor it on a window edge.
-- Writes public/office/slam-puff-{dark,light}.png + art/office/slam-puff.aseprite (json written by hand, node).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/slam-puff.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local K, V, P, A, M = 15, 8, 9, 11, 4
local FW, FH, N = 32, 32, 4
local CX, CY = 16, 16

local function starShape(C, x, y, c)
  C.rect(x - 2, y, 5, 1, c); C.rect(x - 1, y - 1, 3, 3, c); C.px(x, y - 2, c)
  C.px(x - 1, y + 2, c); C.px(x + 1, y + 2, c)
end
local function star(C, x, y)                       -- same 5px star as the Overlord's dizzy ring, own 1px INK ring
  for _, d in ipairs({{-1,0}, {1,0}, {0,-1}, {0,1}}) do starShape(C, x + d[1], y + d[2], K) end  -- (even over a puff)
  starShape(C, x, y, A); C.px(x, y, M)
end
local function shade(C)                           -- VIOLET underside: MARBLE pixels on the lower-right silhouette edge
  local set = {}
  for y = 0, FH - 1 do for x = 0, FW - 1 do
    if C.get(x, y) == M and (C.get(x + 1, y) == 0 or C.get(x, y + 1) == 0 or C.get(x + 1, y + 1) == 0
      or C.get(x + 1, y + 2) == 0 and C.get(x, y + 2) == 0) then set[#set + 1] = {x, y} end
  end end
  for _, p in ipairs(set) do C.px(p[1], p[2], V) end
end
local function puffs(C, list, core)                -- MARBLE blobs (+ optional core), shaded as one silhouette
  for _, p in ipairs(list) do C.ellipse(p[1], p[2], p[3], p[3], M) end
  if core then C.ellipse(CX, CY, core, core, M) end
  shade(C)
end
local function ring(n, rad, r, ph)
  local t = {}
  for i = 0, n - 1 do
    local a = ph + i / n * 2 * math.pi
    t[#t + 1] = { CX + rad * math.cos(a), CY + rad * math.sin(a), r }
  end
  return t
end

local FR = {
  function(C)                                      -- flash
    C.rect(CX - 1, CY - 9, 3, 19, A); C.rect(CX - 9, CY - 1, 19, 3, A)
    C.rect(CX - 3, CY - 3, 7, 7, A); C.rect(CX - 2, CY - 2, 5, 5, M)
    C.outline(K)
    for _, d in ipairs({{-1,-1}, {1,-1}, {-1,1}, {1,1}}) do
      C.line(CX + d[1] * 7, CY + d[2] * 7, CX + d[1] * 9, CY + d[2] * 9, K)
    end
  end,
  function(C)                                      -- burst
    puffs(C, ring(7, 8, 4.6, 0.3), 6)
    C.outline(K)
    for _, s in ipairs({{CX, 3}, {28, 21}, {4, 23}}) do star(C, s[1], s[2]) end
  end,
  function(C)                                      -- break
    puffs(C, ring(5, 11, 3.6, 0.9))
    star(C, 27, 5); star(C, 5, 9)
    C.outline(K)
  end,
  function(C)                                      -- wisps
    puffs(C, ring(4, 13, 2.1, 1.4))
    C.outline(K)
    L.twinkle(C, 28, 4, A, M, 1); C.outline(K)                          -- INK-ringed so it holds on light SKY
  end,
}

local spr = L.new(FW, FH, pal)
for i = 2, N do spr:newFrame() end
local lay = L.layer(spr, "puff")
local strip = Image(FW * N, FH, ColorMode.INDEXED); strip:clear(0)
for i = 1, N do
  local C = L.canvas(spr, lay, spr.frames[i])
  FR[i](C); C.commit()
  strip:drawImage(C.img, Point((i - 1) * FW, 0))
end
spr:saveAs(root.."/art/office/slam-puff.aseprite"); spr:close()
for _, mode in ipairs({"dark", "light"}) do
  local out = Sprite(FW * N, FH, ColorMode.INDEXED)
  out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
  out.transparentColor = 0
  out.cels[1].image = strip
  out:saveAs(root.."/public/office/slam-puff-"..mode..".png"); out:close()
end
print("wrote slam-puff "..N.." frames")
