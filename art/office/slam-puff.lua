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

-- ---------- RS-c (docs/PLAN_RIFF_SWING.md): appended BELOW the puff row, so the 4 puff cells never move ----------
-- smack (2x 64x48 at y32): comic burst, AMBER spikes + MARBLE inner burst, chunky PINK "SMACK!" in INK.
--   f0 hit: tight burst, letters on a bouncy baseline   f1 ring-out: spikes rotate + grow, letters kick 1px, INK ticks
-- smear (1x 40x96 at y80): the swinging chat window's outer (right) edge mid-swing: the sky-CRT bevel (INK, MARBLE,
--   LINE) crisp on the right, the close-button corner up top and the MINT LED bezel below, smeared left along the arc
--   into a PANEL ghost, MARBLE streaks and LINE dashes. Rows 16..83 repeat every 4 rows (json slice) so the UI can
--   stretch it to the window height with border-image "round".
local SW, SH = 64, 48
local MW, MH = 40, 96
local PN, LN, T, G = 1, 3, 7, 12
local GLY = {
  S = {".####.", "##..##", "##....", ".####.", "....##", "##..##", ".####."},
  M = {"##...##", "###.###", "#######", "##.#.##", "##...##", "##...##", "##...##"},
  A = {".####.", "##..##", "##..##", "######", "##..##", "##..##", "##..##"},
  C = {".####.", "##..##", "##....", "##....", "##....", "##..##", ".####."},
  K = {"##..##", "##.##.", "####..", "###...", "####..", "##.##.", "##..##"},
  ["!"] = {"##", "##", "##", "##", "##", "..", "##"},
}
local WORD = {"S", "M", "A", "C", "K", "!"}
local function wordW() local w = -1; for _, g in ipairs(WORD) do w = w + #GLY[g][1] + 1 end; return w end
local function letters(C, x0, y0, bob)              -- bob: per-letter dy, a hand-set bouncy baseline
  local x = x0
  for n, g in ipairs(WORD) do
    for r, row in ipairs(GLY[g]) do for q = 1, #row do
      if row:sub(q, q) == "#" then C.px(x + q - 1, y0 + bob[n] + r - 1, P) end
    end end
    x = x + #GLY[g][1] + 1
  end
end
local function burst(C, cx, cy, n, ro, ri, ph, wob, c)  -- spiky star polygon, lopsided spike lengths
  local pts = {}
  for k = 0, 2 * n - 1 do
    local a = ph + k / (2 * n) * 2 * math.pi
    local r = (k % 2 == 0) and ro * wob[(k // 2) % #wob + 1] or ri
    pts[#pts + 1] = cx + r * math.cos(a); pts[#pts + 1] = cy + r * math.sin(a) * 0.72
  end
  C.poly(pts, c)
end
local SMACK = {
  function(C)
    burst(C, 32, 24, 11, 30, 21, 0.15, {1, 0.86, 0.97, 0.8, 1.04, 0.9, 0.95, 0.82, 1, 0.88, 0.93}, A)
    burst(C, 32, 24, 11, 24, 18.5, 0.43, {1, 0.92, 0.97, 0.9, 1}, M)
    C.outline(K)                                     -- one INK ring round the whole burst (MARBLE sits inside AMBER)
    local w = wordW()
    letters(C, 32 - w // 2, 20, {1, 0, -1, 0, 1, -1})
      end,
  function(C)
    burst(C, 32, 24, 11, 31.5, 22, 0.43, {0.9, 1, 0.84, 1.03, 0.92, 1, 0.86, 0.98, 0.9, 1.02, 0.88}, A)
    burst(C, 32, 24, 11, 25, 19.5, 0.15, {0.95, 1, 0.9, 1, 0.93}, M)
    C.outline(K)
    local w = wordW()
    letters(C, 32 - w // 2 + 1, 19, {0, 1, 0, -1, 0, 1})
  end,
}
local function inkLetters(C)                         -- 1px INK ring round each PINK letter pixel (inside the MARBLE)
  local add = {}
  for y = 0, C.h - 1 do for x = 0, C.w - 1 do
    if C.get(x, y) ~= P and C.get(x, y) ~= 0 then
      for _, d in ipairs({{-1,0}, {1,0}, {0,-1}, {0,1}, {-1,-1}, {1,1}, {-1,1}, {1,-1}}) do
        if C.get(x + d[1], y + d[2]) == P then add[#add + 1] = {x, y}; break end
      end
    end
  end end
  for _, p in ipairs(add) do C.px(p[1], p[2], K) end
end

local SAW = {16, 19, 23, 20}                           -- ghost's ragged left edge per row (mod 4): repeats in the middle
local function smear(C)
  -- one smeared silhouette: the bevel + body dragged left along the arc (LINE ghost, sawtooth tail),
  -- the top bevel and the bottom bezel trailing furthest as tapered MARBLE bands
  for y = 4, 91 do C.hline(SAW[y % 4 + 1], y, 34 - SAW[y % 4 + 1], LN) end
  C.poly({4,1, 34,1, 34,4, 12,4}, M)                  -- top bevel, tapering back
  C.poly({7,84, 34,84, 34,91, 14,91, 10,88}, M)       -- bottom bezel, tapering back
  C.outline(K)
  for y = 4, 91 do                                    -- MARBLE streak every 4 rows (rows 16..79 tile at 4)
    if y % 4 == 1 and y > 6 and y < 83 then C.hline(SAW[2] + 3, y, 31 - SAW[2] - 3, M) end
  end
  C.hline(13, 89, 21, LN)                             -- bezel underside
  -- crisp leading edge (sky-CRT bevel): INK screen border, MARBLE hit-light, LINE bevel, INK outer
  C.vline(32, 5, 79, K); C.vline(33, 1, 90, M); C.vline(34, 1, 90, LN); C.vline(35, 1, 90, LN); C.vline(36, 1, 90, K)
  C.hline(4, 0, 32, K); C.hline(8, 92, 28, K)
  -- title-bar corner: the close-button plate (.sky-chat-close), INK rule under the bar
  L.plate(C, 24, 7, 7, 6, M, M, LN); C.line(26, 9, 28, 11, K); C.line(28, 9, 26, 11, K)
  C.hline(19, 15, 13, K)
  -- bottom bezel: screen border, the CRT's MINT LED
  C.hline(18, 84, 14, K); C.rect(28, 86, 2, 2, G)
  -- far speed lines (INK, period 8 so the middle still tiles at 4x2)
  for y = 16, 79 do if y % 8 == 3 then C.hline(3, y, 7, K) elseif y % 8 == 7 then C.hline(7, y, 5, K) end end
end

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

-- RS-c rows: smack x2 at y FH, smear at y FH + SH (art/office/slam-fx.aseprite keeps the editable frames)
local fx = L.new(SW, MH, pal)
fx:newFrame(); fx:newFrame()
local fl = L.layer(fx, "fx")
local SHEET_W, SHEET_H = FW * N, FH + SH + MH
local sheet = Image(SHEET_W, SHEET_H, ColorMode.INDEXED); sheet:clear(0)
sheet:drawImage(strip, Point(0, 0))
for i = 1, 2 do
  local C = L.canvas(fx, fl, fx.frames[i]); C.w, C.h = SW, SH
  SMACK[i](C); inkLetters(C); C.commit()
  sheet:drawImage(C.img, Point((i - 1) * SW, FH))
end
do
  local C = L.canvas(fx, fl, fx.frames[3]); C.w, C.h = MW, MH
  smear(C); C.commit()
  sheet:drawImage(C.img, Point(0, FH + SH), Rectangle(0, 0, MW, MH))
end
fx:saveAs(root.."/art/office/slam-fx.aseprite"); fx:close()
strip = sheet

for _, mode in ipairs({"dark", "light"}) do
  local out = Sprite(SHEET_W, SHEET_H, ColorMode.INDEXED)
  out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
  out.transparentColor = 0
  out.cels[1].image = strip
  out:saveAs(root.."/public/office/slam-puff-"..mode..".png"); out:close()
end
print("wrote slam-puff "..N.." frames")
