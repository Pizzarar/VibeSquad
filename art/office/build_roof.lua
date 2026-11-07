-- Contract v2 roof band (C1): art/office/roof.aseprite, 640x200, INDEXED (P0), stacks ABOVE the floor plates.
-- [big CRT: RiffBot | lift top | big CRT: Overlord] on the tower roof, 3/4 top-down (above + in front of
-- the sets: we see each TV's top face and rear hump receding up the screen).
-- Bands: sky 0..141 (far city 104..145), parapet 142..151, roof deck from above 152..191, slab 192..199.
-- The two screen glasses are left EMPTY (dark glass): the UI draws face-{riffbot,overlord}-*.png in them.
-- Layers: bg, building, furniture, signs, light, front. "front" = what covers sprites/faces: the lift car
-- jambs/sill (elevatorTop rider) + the rounded glass corners of both CRTs (they clip the face cells).
-- Slices (roof-plate px): screens.riffbot, screens.overlord (glass = one 128x96 face cell),
-- screens.elevatorTop (32x32 sprite cell, bottom-centre anchor).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/build_roof.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local KIT = dofile(root.."/art/office/kit34.lua")(L)
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local W, H = 640, 200
local K = KIT.K
local CAP0, DECK0, SLAB = 142, 152, 192

local spr = L.new(W, H, pal)
local C = {}
for _, n in ipairs({ "bg", "building", "furniture", "signs", "light", "front" }) do C[n] = L.canvas(spr, L.layer(spr, n), spr.frames[1]) end

-- TV front faces: left set x 62..249, right set mirrored (x 390..577), both y 40..161.
-- Glass = 128x96 (4:3), one face cell. Controls sit on the outer side of each set.
local TV = { y = 40, w = 188, h = 122 }
local S = {
  riff = {74, 52, 128, 96}, lord = {438, 52, 128, 96},
  top = {304, 146, 32, 32},
}

local function textBig(c, x, y, s, col, sh)
  for pass=1,2 do
    for n=1,#s do
      local g = L.F[s:sub(n,n)] or L.F[" "]
      for r=0,4 do for q=0,2 do
        if g:sub(r*3+q+1, r*3+q+1) == "1" then
          local px0, py0 = x + (n-1)*8 + q*2, y + r*2
          if pass == 1 and sh then c.rect(px0+1, py0+1, 2, 2, sh) elseif pass == 2 then c.rect(px0, py0, 2, 2, col) end
        end
      end end
    end
  end
end
local function bigW(s) return #s*8 - 2 end

-- ======================= bg: dusk sky + far city below the roof line =======================
do
  local c = C.bg
  local ramp = { L.SKY, L.VIOLET, L.PINK, L.CORAL }
  for y=0,CAP0-1 do
    local t = math.min(2.999, math.max(0, (y-8)/112) * 3)
    local s = math.floor(t)
    for x=0,W-1 do c.px(x, y, L.dith(x, y, ramp[s+1], ramp[math.min(s+2, 4)], t - s)) end
  end
  for _, p in ipairs({{20,6},{48,14},{110,4},{150,18},{200,9},{262,24},{410,7},{450,16},{500,5},
                      {590,11},{620,3},{12,40},{626,46},{372,30}}) do c.px(p[1], p[2], L.MARBLE) end
  L.twinkle(c, 132, 10, L.MARBLE, L.MARBLE, 2); L.twinkle(c, 470, 12, L.MARBLE, L.MARBLE, 2)
  L.twinkle(c, 30, 26, L.MARBLE, L.MARBLE, 1); L.twinkle(c, 612, 30, L.MARBLE, L.MARBLE, 1)
  for _, cl in ipairs({{36,64},{604,72},{262,52},{378,90},{520,14},{24,16}}) do
    c.ellipse(cl[1], cl[2], 9, 3, L.MARBLE); c.ellipse(cl[1]+8, cl[2]-2, 6, 3, L.MARBLE); c.ellipse(cl[1]-7, cl[2]+1, 5, 2, L.MARBLE)
  end
  -- far city skyline (only peeks out round the sets and the lift core)
  local x = 0
  local hs = {14, 22, 9, 30, 18, 26, 12, 34, 20, 16, 28, 10, 24}
  local n = 0
  while x < W do
    n = n + 1
    local bw, bh = 7 + (n*5) % 8, hs[n % #hs + 1]
    c.rect(x, 146-bh, bw, bh, L.INK)
    if n % 3 == 0 then c.vline(x + bw//2, 146-bh-5, 5, L.INK) end
    for wy=146-bh+2, 143, 3 do for wx=x+2, x+bw-3, 3 do
      if (wx*7 + wy*3 + n) % 5 == 0 then c.px(wx, wy, L.AMBER) end
    end end
    x = x + bw + 1
  end
  c.commit()
end

-- ======================= building: parapet, roof deck, slab, lift core =======================
do
  local c = C.building
  -- parapet: cap seen from above, then its inner face
  c.hline(0, CAP0, W, L.INK); c.rect(0, CAP0+1, W, 2, L.MARBLE); c.hline(0, CAP0+3, W, L.INK)
  c.rect(0, CAP0+4, W, DECK0-CAP0-5, L.LINE); c.hline(0, DECK0-1, W, L.INK)
  for x=8,W-1,32 do c.vline(x, CAP0+4, DECK0-CAP0-5, L.PHI) end
  -- roof deck from above: gravel PHI with LINE flecks + a tile seam grid (foreshortened)
  c.rect(0, DECK0, W, SLAB-DECK0, L.PHI)
  for y=DECK0, SLAB-1 do for x=0, W-1 do
    if (x*5 + y*11) % 17 == 0 then c.px(x, y, L.LINE) end
  end end
  for _, y in ipairs({DECK0+9, DECK0+21}) do c.hline(0, y, W, L.LINE) end
  for x=0,W-1,40 do c.vline(x, DECK0, SLAB-DECK0, L.LINE) end
  c.hline(0, SLAB, W, L.INK); c.hline(0, SLAB+1, W, L.MARBLE); c.rect(0, SLAB+2, W, 5, L.LINE); c.hline(0, H-1, W, L.INK)
  for x=6,W-1,24 do c.rect(x, SLAB+3, 12, 3, L.PHI) end

  -- lift core: marble column up through the roof; machine room cap at the top
  c.rect(288, 18, 64, H-18, L.MARBLE)
  c.vline(288, 18, H-18, L.INK); c.vline(351, 18, H-18, L.INK)
  c.vline(289, 19, H-19, L.LINE); c.vline(350, 19, H-19, L.LINE)
  c.hline(288, 18, 64, L.INK); c.rect(289, 19, 62, 4, L.MARBLE); c.hline(289, 22, 62, L.LINE); c.hline(288, 23, 64, L.INK)
  for _, v in ipairs({{292,40,1},{346,90,-1},{293,160,1}}) do
    for i=0,9 do if i % 3 ~= 2 then c.px(v[1] + (v[3] > 0 and i//3 or -(i//3)), v[2]+i, L.LINE) end end
  end
  -- shaft window down to the car; pulley wheel at the top
  c.rect(299, 54, 42, 74, L.INK)
  for y=55,126 do for x=300,339 do c.px(x, y, L.dith(x, y, L.SKY, L.VIOLET, math.max(0, (y-80)/50))) end end
  c.ellipse(320, 66, 8, 8, L.INK); c.ellipse(320, 66, 6, 6, L.LINE); c.ellipse(320, 66, 2, 2, L.AMBER)
  for a=0,315,45 do c.line(320, 66, 320 + math.floor(5*math.cos(math.rad(a)) + 0.5), 66 + math.floor(5*math.sin(math.rad(a)) + 0.5), L.INK) end
  c.vline(312, 74, 52, L.INK); c.vline(328, 74, 52, L.INK)
  c.commit()
end

-- ======================= furniture: the two big CRT sets, stands, roof clutter, lift =======================
-- st: case face/hi/lo, recess, knob colours, LED. ctl = "R" (controls right of the glass) or "L".
local function tvSet(c, g, ctl, st)
  local gx, gy, gw, gh = g[1], g[2], g[3], g[4]
  local x0 = (ctl == "R") and gx - 12 or gx - 48
  local y0, w, h = TV.y, TV.w, TV.h
  local x1 = x0 + w - 1
  -- rear hump (the deep CRT tube housing), seen from above, behind the top face
  c.poly({x0+34, y0-9, x1-33, y0-9, x1-46, y0-21, x0+47, y0-21}, L.INK)
  c.poly({x0+36, y0-10, x1-35, y0-10, x1-47, y0-20, x0+48, y0-20}, st.lo)
  for vx=x0+56, x1-56, 6 do c.line(vx, y0-18, vx-1, y0-12, L.INK) end
  -- top face (recedes up-screen), light far edge
  c.poly({x0, y0, x1+1, y0, x1-8, y0-10, x0+9, y0-10}, L.INK)
  c.poly({x0+2, y0, x1-1, y0, x1-9, y0-9, x0+10, y0-9}, st.hi)
  c.hline(x0+11, y0-8, w-21, L.MARBLE)
  -- front face: chunky bevelled case
  c.rect(x0, y0, w, h, L.INK)
  c.rect(x0+1, y0+1, w-2, h-2, st.face)
  c.hline(x0+1, y0+1, w-2, st.hi); c.vline(x0+1, y0+1, h-2, st.hi)
  c.rect(x0+1, y0+h-5, w-2, 4, st.lo); c.vline(x1-1, y0+1, h-2, st.lo)
  c.hline(x0+1, y0+h-6, w-2, L.INK)
  -- screen recess (dark top-left shadow, lit bottom-right lip), then the glass
  c.rect(gx-6, gy-6, gw+12, gh+12, L.INK)
  c.rect(gx-5, gy-5, gw+10, gh+10, st.recess)
  c.hline(gx-5, gy+gh+4, gw+10, st.hi); c.vline(gx+gw+4, gy-5, gh+10, st.hi)
  c.hline(gx-5, gy-5, gw+10, L.INK); c.vline(gx-5, gy-5, gh+10, L.INK)
  c.rect(gx-1, gy-1, gw+2, gh+2, L.INK)
  -- empty glass: dark tube with a faint raster + a curved glare, UI draws the face over it
  c.rect(gx, gy, gw, gh, L.INK)
  for y=gy+1, gy+gh-1, 3 do for x=gx+2, gx+gw-3, 4 do c.px(x + (y % 2), y, L.LINE) end end
  for i=0,9 do c.px(gx+4+i, gy+3 + (i < 3 and 3-i or 0), L.MUTED) end
  -- control column: two chunky dials, speaker slots, power button + LED
  local cx = (ctl == "R") and gx + gw + 24 or gx - 25
  for k, ky in ipairs({gy+10, gy+38}) do
    c.ellipse(cx, ky, 11, 11, L.INK)
    for a=0,330,30 do c.px(cx + math.floor(10*math.cos(math.rad(a)) + 0.5), ky + math.floor(10*math.sin(math.rad(a)) + 0.5), st.lo) end
    c.ellipse(cx, ky, 8, 8, L.INK); c.ellipse(cx, ky, 7, 7, st.knob[k])
    c.ellipse(cx-1, ky-1, 4, 4, st.knobHi)
    local a = math.rad(k == 1 and -60 or 200)
    c.line(cx, ky, cx + math.floor(6*math.cos(a) + 0.5), ky + math.floor(6*math.sin(a) + 0.5), L.INK)
  end
  L.text(c, cx-3, gy+22, "CH", L.INK)
  L.text(c, cx-5, gy+50, "VOL", L.INK)
  for sy=gy+60, gy+80, 3 do c.hline(cx-12, sy, 25, L.INK); c.hline(cx-12, sy+1, 25, st.lo) end
  L.plate(c, cx-12, gy+86, 12, 6, st.hi, L.MARBLE, st.lo)
  c.rect(cx+5, gy+87, 4, 4, L.INK); c.rect(cx+6, gy+88, 2, 2, st.led)
  return x0, x1
end

do
  local c = C.furniture
  -- ---- RiffBot set: toy-beige case, violet recess, pink + amber knobs, mint LED ----
  local rx0, rx1 = tvSet(c, S.riff, "R", { face = L.MARBLE, hi = L.MARBLE, lo = L.LINE, recess = L.VIOLET,
    knob = { L.PINK, L.AMBER }, knobHi = L.CORAL, led = L.MINT })
  -- a second shade on the beige case so it does not read as flat white
  for y=TV.y+3, TV.y+TV.h-8 do for x=rx0+3, rx1-3 do
    if C.furniture.get(x, y) == L.MARBLE and (x + y) % 2 == 0 and (x > rx1-8 or y > TV.y+TV.h-12) then c.px(x, y, L.LINE) end
  end end
  -- rabbit-ear antenna on the top face
  local ax = (rx0 + rx1)//2
  c.rect(ax-7, TV.y-26, 15, 6, L.INK); c.rect(ax-6, TV.y-25, 13, 4, L.VIOLET); c.hline(ax-6, TV.y-25, 13, L.PINK)
  c.line(ax-3, TV.y-26, ax-30, TV.y-38, L.INK); c.line(ax-3, TV.y-27, ax-30, TV.y-39, L.MARBLE)
  c.line(ax+3, TV.y-26, ax+34, TV.y-36, L.INK); c.line(ax+3, TV.y-27, ax+34, TV.y-37, L.MARBLE)
  c.ellipse(ax-31, TV.y-39, 2, 2, L.PINK); c.ellipse(ax+35, TV.y-37, 2, 2, L.MINT)
  -- Memphis stickers on the case
  c.stamp(rx0+5, TV.y+4, "|.a.|\n|aaa|\n|.a.|", K)
  c.stamp(rx1-20, TV.y+TV.h-15, "|g..g..g|\n|.g..g..|", K)
  -- wooden TV cabinet: top face from above, front with two doors + brass knobs, stubby legs
  KIT.slab(c, rx0+12, TV.y+TV.h+1, TV.w-24, 4, L.AMBER, L.CORAL, 16)
  for _, dx in ipairs({rx0+16, rx0+TV.w//2+2}) do
    c.rect(dx, TV.y+TV.h+8, TV.w//2-20, 11, L.INK); c.rect(dx+1, TV.y+TV.h+9, TV.w//2-22, 9, L.CORAL)
    c.hline(dx+1, TV.y+TV.h+9, TV.w//2-22, L.AMBER)
  end
  c.px(rx0+TV.w//2-6, TV.y+TV.h+13, L.AMBER); c.px(rx0+TV.w//2+6, TV.y+TV.h+13, L.AMBER)
  for _, lx in ipairs({rx0+16, rx1-19}) do c.rect(lx, TV.y+TV.h+22, 4, 5, L.INK); c.vline(lx+1, TV.y+TV.h+22, 4, L.CORAL) end

  -- ---- Overlord set: gunmetal case, ink recess, amber + pink knobs, pink LED ----
  local ox0, ox1 = tvSet(c, S.lord, "L", { face = L.LINE, hi = L.MUTED, lo = L.PHI, recess = L.INK,
    knob = { L.AMBER, L.PINK }, knobHi = L.MARBLE, led = L.PINK })
  -- rivets on the bezel
  for _, p in ipairs({{ox0+4,TV.y+4},{ox1-4,TV.y+4},{ox0+4,TV.y+TV.h-10},{ox1-4,TV.y+TV.h-10}}) do
    c.px(p[1], p[2], L.MARBLE); c.px(p[1]+1, p[2]+1, L.INK)
  end
  -- ON AIR lamp + whip antenna on the top face
  local lx = (ox0 + ox1)//2
  c.rect(lx-15, TV.y-30, 31, 10, L.INK); c.rect(lx-14, TV.y-29, 29, 8, L.PINK)
  c.hline(lx-14, TV.y-29, 29, L.CORAL)
  c.vline(ox1-30, TV.y-46, 34, L.INK); c.vline(ox1-29, TV.y-46, 34, L.MUTED)
  c.ellipse(ox1-29, TV.y-47, 2, 2, L.PINK); c.px(ox1-29, TV.y-48, L.MARBLE)
  -- black rack stand with two VCR decks (12:00 blinking, naturally)
  KIT.slab(c, ox0+12, TV.y+TV.h+1, TV.w-24, 4, L.LINE, L.INK, 16)
  for i, dy in ipairs({TV.y+TV.h+8, TV.y+TV.h+15}) do
    c.rect(ox0+18, dy, TV.w-36, 6, L.INK); c.rect(ox0+19, dy+1, TV.w-38, 4, L.PHI)
    c.rect(ox0+30, dy+2, 50, 2, L.INK)
    c.rect(ox1-46, dy+1, 20, 4, L.INK)
    for bx=ox1-24, ox1-18, 3 do c.px(bx, dy+2, L.MARBLE) end
  end
  c.rect(ox1-46, TV.y+TV.h+8, 20, 6, L.INK); L.text(c, ox1-45, TV.y+TV.h+8, "1200", L.AMBER)
  for _, lx2 in ipairs({ox0+16, ox1-19}) do c.rect(lx2, TV.y+TV.h+22, 4, 5, L.INK); c.vline(lx2+1, TV.y+TV.h+22, 4, L.LINE) end

  -- ---- cables from both sets snaking across the deck to the lift core ----
  for _, cb in ipairs({{rx1-30, 252, 286}, {ox0+30, 388, 353}}) do
    local sx, mx, ex = cb[1], cb[2], cb[3]
    local y = 188
    c.line(sx, TV.y+TV.h+27, sx + (mx > sx and 6 or -6), y, L.INK)
    c.hline(math.min(sx + (mx > sx and 6 or -6), ex), y, math.abs(ex - sx) - 5, L.INK)
    c.hline(math.min(sx + (mx > sx and 6 or -6), ex), y+1, math.abs(ex - sx) - 5, L.INK)
  end

  -- ---- roof clutter at the edges: water tank (left), satellite dish (right) ----
  c.stamp(18, 120, [[
|....kkkkkkkkkkkkkkkk....|
|..kkmmmmmmmmmmmmmmmmkk..|
|.kmmmmmmmmmmmmmmmmmmmlk.|
|kkkkkkkkkkkkkkkkkkkkkkkk|
|kmmmmmmmmmmmmmmmmmmmmmlk|
|kmmmmmmmmmmmmmmmmmmmmmlk|
|kkkkkkkkkkkkkkkkkkkkkkkk|
|kmmmmmmmmmmmmmmmmmmmmmlk|
|kmmmmmmmmmmmmmmmmmmmmmlk|
|kkkkkkkkkkkkkkkkkkkkkkkk|
|kmmmmmmmmmmmmmmmmmmmmmlk|
|kmmmmmmmmmmmmmmmmmmmmmlk|
|kkkkkkkkkkkkkkkkkkkkkkkk|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|..kk....kk....kk....kk..|
|.kkkk..kkkk..kkkk..kkkk.|
]], K)
  c.stamp(604, 150, [[
|.........kkk...|
|.......kkmmmk..|
|.....kkmmmmmlk.|
|...kkmmmmmmmlk.|
|..kmmmmmmmmmlk.|
|.kmmmmkmmmmlk..|
|.kmmmmmkmmlk...|
|kmmmmmmmkkk....|
|kmmmmmmlk.ka...|
|.kmmmllk.......|
|..kkkkk........|
|....kk.........|
|....kk.........|
|....kk.........|
|....kk.........|
|....kk.........|
|....kk.........|
|....kk.........|
|....kk.........|
|...kkkk........|
|..kkkkkk.......|
]], K)
  for _, x in ipairs({284, 354}) do c.rect(x, 26, 3, 22, L.INK); c.px(x+1, 27, L.LINE) end
  c.hline(284, 38, 73, L.INK)
  c.vline(338, 0, 18, L.INK); c.px(338, 0, L.PINK); c.hline(335, 6, 7, L.INK)

  -- ---- lift top: car + doors + call panels (same kit as the floors) ----
  local cx, cy = 302, S.top[2] - 20
  c.rect(cx, cy, 36, 56, L.INK)
  c.rect(cx+1, cy+1, 34, 16, L.PHI)
  c.rect(cx+1, cy+1, 34, 3, L.LINE); c.hline(cx+10, cy+2, 16, L.AMBER)
  c.hline(cx+1, cy+13, 34, L.MARBLE); c.hline(cx+1, cy+14, 34, L.LINE)
  for _, sx in ipairs({cx+9, cx+18, cx+27}) do c.vline(sx, cy+4, 9, L.LINE) end
  c.rect(cx+29, cy+4, 5, 9, L.INK); for by=cy+5, cy+11, 2 do c.px(cx+31, by, L.AMBER) end
  c.hline(cx+1, cy+17, 34, L.INK)
  for y=cy+18, cy+54 do for x=cx+1, cx+34 do c.px(x, y, ((x//4 + y//3) % 2 == 0) and L.LINE or L.PHI) end end
  for _, x in ipairs({290, 339}) do
    local y, w, h = cy+6, 11, 48
    c.rect(x, y, w, h, L.INK)
    c.rect(x+1, y+1, w-2, h-1, L.TEAL)
    c.vline(x+1, y+1, h-1, L.MARBLE)
    c.vline(x + w//2, y+1, h-1, L.INK)
    c.rect(x+2, y+8, 3, 10, L.SKY); c.rect(x+w-5, y+8, 3, 10, L.SKY)
    c.rect(x+1, y-10, w-2, 8, L.INK)
    c.hline(x + w//2 - 1, y-5, 3, L.PINK); c.px(x + w//2, y-4, L.PINK)
  end
  c.commit()
end

-- ======================= signs =======================
do
  local c = C.signs
  local function board(cx, y, label, face, h)
    local w = bigW(label) + 12
    local x = cx - w//2
    L.plate(c, x, y, w, h or 17, face, L.MARBLE, L.CORAL)
    c.hline(x+2, y+2, w-4, L.PINK); c.hline(x+2, y+(h or 17)-3, w-4, L.PINK)
    textBig(c, x+6, y+4, label, L.INK, L.CORAL)
    return x, w
  end
  local bx, bw = board(320, 6, "VIBE TOWER", L.AMBER, 19)
  for x=bx+4, bx+bw-5, 6 do c.px(x, 7, L.MARBLE) end
  L.twinkle(c, bx-5, 10, L.MARBLE, L.MARBLE, 2); L.twinkle(c, bx+bw+4, 20, L.AMBER, L.MARBLE, 1)
  -- name plates under each glass (invented labels)
  local function nameplate(g, label, face, ink)
    local w = L.textW(label) + 8
    local x = g[1] + g[3]//2 - w//2
    L.plate(c, x, g[2]+g[4]+8, w, 9, face, L.MARBLE, L.INK)
    L.text(c, x+4, g[2]+g[4]+10, label, ink)
  end
  nameplate(S.riff, "RIFFBOT", L.PINK, L.MARBLE)
  nameplate(S.lord, "OVERLORD", L.INK, L.AMBER)
  L.text(c, (390 + 577)//2 - 11, TV.y-27, "ON AIR", L.MARBLE)
  c.rect(305, 110, 30, 11, L.INK)
  L.text(c, 316, 113, "TV", L.AMBER)
  c.stamp(308, 113, "|.g.|\n|ggg|", K)
  L.plate(c, 300, 28, 40, 9, L.VIOLET, L.MARBLE, L.LINE)
  L.text(c, 306, 30, "LIFT M", L.MARBLE)
  c.commit()
end

-- ======================= front overlay: lift car front + rounded CRT glass corners =======================
do
  local c = C.front
  local cx, cy = 302, S.top[2] - 20
  c.rect(cx-2, cy-3, 40, 4, L.INK); c.rect(cx-1, cy-2, 38, 2, L.MARBLE)
  for _, jx in ipairs({cx-2, cx+34}) do
    c.rect(jx, cy, 4, 57, L.INK); c.rect(jx+1, cy, 2, 56, L.MARBLE); c.vline(jx+2, cy, 56, L.LINE)
  end
  c.rect(cx-2, cy+49, 40, 8, L.INK); c.rect(cx+2, cy+50, 32, 2, L.MARBLE); c.rect(cx+2, cy+52, 32, 3, L.LINE)
  c.hline(cx+4, cy+53, 28, L.AMBER)
  for _, x in ipairs({290, 339}) do
    local y, w, h = cy+6, 11, 48
    c.vline(x-1, y-1, h+1, L.INK); c.vline(x+w, y-1, h+1, L.INK)
    c.hline(x-1, y-1, w+2, L.INK); c.hline(x, y+h-1, w, L.MARBLE)
  end
  -- rounded tube corners: these sit over the face cell's corners so the face looks like it is ON the glass
  for _, g in ipairs({S.riff, S.lord}) do
    local x0, y0, x1, y1 = g[1], g[2], g[1]+g[3]-1, g[2]+g[4]-1
    for _, cn in ipairs({{x0,y0,1,1},{x1,y0,-1,1},{x0,y1,1,-1},{x1,y1,-1,-1}}) do
      local x, y, dx, dy = cn[1], cn[2], cn[3], cn[4]
      for _, p in ipairs({{0,0},{1,0},{2,0},{3,0},{4,0},{0,1},{1,1},{2,1},{0,2},{1,2},{0,3},{0,4}}) do c.px(x + p[1]*dx, y + p[2]*dy, L.INK) end
    end
  end
  c.commit()
end

-- ======================= light: screen glow spilling onto the deck =======================
do
  local c = C.light
  local fur, fr = C.furniture, C.front
  local function pool(cx, cy, rx, ry, col, maxT)
    for y=cy-ry, cy+ry do for x=cx-rx, cx+rx do
      local d = math.sqrt(((x-cx)/rx)^2 + ((y-cy)/ry)^2)
      if d < 1 and y >= DECK0+1 and y < SLAB and fur.get(x, y) == 0 and fr.get(x, y) == 0 then
        if (L.BAYER[y%4+1][x%4+1] + 0.5) < maxT*(1-d)*16 then c.px(x, y, col) end
      end
    end end
  end
  pool(S.riff[1] + 64, 186, 120, 10, L.TEAL, 0.55)
  pool(S.lord[1] + 64, 186, 120, 10, L.PINK, 0.55)
  L.twinkle(c, 296, 100, L.TEAL, L.MARBLE, 2)
  c.commit()
end

local function slice(name, r) local s = spr:newSlice(Rectangle(r[1], r[2], r[3], r[4])); s.name = name end
slice("screens.riffbot", S.riff); slice("screens.overlord", S.lord)
slice("screens.elevatorTop", S.top)
spr:saveAs(root.."/art/office/roof.aseprite")
print("wrote roof.aseprite")
