-- C2a-R4 Overlord "brain-jar TV" at 48x48 in the H0 hand (art/cast/hypno/lib.lua): the screen is
-- the jar glass, murky liquid with lots of empty space. Two loose bloodshot eyeballs on dangling
-- optic-nerve tails and a separate floating set of teeth (no lips, no face outline). The middle
-- R4 (Aub): a real floating brain sits in the open middle between the eyes, above the teeth:
-- pink lobes, violet folds, ink midline cleft; it bobs in idle and pulses (folds light up,
-- pink halo) in talk/needs. Shapes are kept clean for ~10x display. Flat P0 fills, hand-placed pixels, no gradients.
--   idle     : parts bob out of sync, tails sway
--   blink    : slow murky lid
--   talk     : teeth chatter, bubbles rise
--   lookDown : eyes roll down and press the bottom glass
--   needs    : eyes swing to the camera, teeth grin, glass flickers
-- Cells/offsets match public/office/faces.json (overlord entry unchanged).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/faces/overlord-r4.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local K, V, P, CO, A, M, T, G, Y, LN, MU = 15, 8, 9, 10, 11, 4, 7, 12, 13, 3, 6
local KEY = { k=K, m=M, g=G, a=A, p=P, t=T, v=V, c=CO, y=Y, l=LN }
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local CW, CH = 48, 48
local LAYERS = { "liquid", "brain", "tails", "teeth", "eyes", "fx" }

local BANG = [[
|kkkk|
|kaak|
|kaak|
|kaak|
|kaak|
|kkkk|
|....|
|kkkk|
|kaak|
|kkkk|
]]

-- the brain, side view (frontal lobe left): scalloped cortical bumps along the top, ink central +
-- lateral fissures and orthogonally connected violet creases (no lone diagonal dots), a rounded
-- violet/pink striped cerebellum under an ink transverse fissure, a blunt 2px coral brainstem
-- outlined on both sides; 3px marble wet glint on the front lobe. Reads as a brain at 48px and holds at ~10x.
local BRAIN = [[
|.....ppp..ppp..pp....|
|...pppppppkppvppppp..|
|..pmmpvppkkppvvvppp..|
|.ppmppvppkpppppvpppp.|
|.ppppvvpkkppvppvvppp.|
|ppvvppppkpppvvvpppvpp|
|pppvvppkkkkkpppppvvpp|
|.ppppkkkpppppppppvppp|
|.ppkkkppppppkkkkkkkpp|
|..pppppppp..vvvvvvv..|
|...ppppppp..ppppppp..|
|.....pppp.cc.vvvvv...|
|..........cc.........|
|..........cc.........|
]]

-- murky particles (hand-placed, fixed)
local SPECKS = { {7,27}, {40,24}, {30,6}, {17,44}, {44,44}, {4,40}, {22,3} }

---------------------------------------------------------------- parts
-- tail: optic nerve as a 2px coral line through pts, last segment 1px (taper)
local function tail(C, pts)
  for i = 1, #pts - 2, 2 do
    local x0, y0, x1, y1 = pts[i], pts[i+1], pts[i+2], pts[i+3]
    C.line(x0, y0, x1, y1, CO)
    if i < #pts - 3 then C.line(x0 + 1, y0, x1 + 1, y1, CO) end
  end
end

-- eyeball: marble ball, pink veins, teal iris, ink pupil, marble glint
--   e = { x, y, px, py (pupil offset), lid (0..1), press (flatten bottom), big (camera stare) }
local function eye(C, e, flip)
  local x, y = e.x, e.y
  C.ellipse(x, y, 5.6, 5.6, M)
  if e.press then C.rect(x - 5, y + 3, 11, 3, M); C.hline(x - 4, y + 6, 9, M) end
  -- bloodshot veins from the rim (mirrored on the right eye)
  local s = flip and -1 or 1
  local VEINS = { {-5,0}, {-4,0}, {-3,1}, {-4,-2}, {3,-4}, {2,-3}, {2,-4}, {-2,4}, {-1,3}, {4,3}, {5,2} }
  for _, v in ipairs(VEINS) do C.px(x + v[1]*s, y + v[2], P) end
  local ix, iy = x + (e.px or 0), y + (e.py or 0)
  if e.big then
    C.ellipse(ix, iy, 3.2, 3.2, T); C.rect(ix - 1, iy - 1, 3, 3, K)
    C.px(ix - 2, iy - 2, M)
  else
    C.ellipse(ix, iy, 2.6, 2.6, T); C.rect(ix - 1, iy - 1, 2, 2, K)
    C.px(ix - 2, iy - 2, M)
  end
  if e.lid and e.lid > 0 then
    -- murky lid: violet membrane sliding down from the top, ink lash edge
    local rows = math.floor(11 * e.lid + 0.5)
    for j = 0, rows - 1 do
      local yy = y - 5 + j
      for xx = x - 6, x + 6 do if C.get(xx, yy) ~= 0 then C.px(xx, yy, V) end end
    end
    local ly = y - 5 + rows
    for xx = x - 6, x + 6 do if C.get(xx, ly) ~= 0 then C.px(xx, ly, K) end end
  end
end

-- floating teeth: two rows of marble teeth, ink seams, no lips.
--   t = { x (left), y (top of upper row), gap (liquid between rows), grin, n }
local ARCH  = { 1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1 }
local LIFT  = { 4,3,2,1,1,0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,3,4 }
local function teeth(C, t)
  local n = #LIFT
  for i = 1, n do
    local x = t.x + i - 1
    local lift = t.grin and LIFT[i] or ARCH[i]
    local seam = (i % 3 == 0) and i < n
    local uh = (i == 4 or i == 5) and 4 or 3                   -- one long crooked tooth, top row
    local top = t.y - lift
    C.rect(x, top, 1, uh, seam and K or M)
    local ly = t.y + 3 + t.gap - lift
    if t.gap == 0 then C.px(x, t.y + 3 - lift, K); ly = ly + 1 end -- bite line
    local lh = (i == 15) and 2 or 3                            -- one short tooth, bottom row
    C.rect(x, ly, 1, lh, seam and K or M)
  end
end

local function bubble(C, x, y, big)
  if big then
    C.hline(x - 1, y - 2, 3, K); C.hline(x - 1, y + 2, 3, K)
    C.vline(x - 2, y - 1, 3, K); C.vline(x + 2, y - 1, 3, K)
    C.px(x - 1, y - 1, M)
  else
    C.px(x, y - 1, K); C.px(x - 1, y, K); C.px(x + 1, y, K); C.px(x, y + 1, K); C.px(x, y, M)
  end
end

-- pulse 0 = rest, 1 = extra wet glint + amber spark, 2 = glint + two bigger sparks
local function brain(C, x, y, pulse)
  pulse = pulse or 0
  C.stamp(x, y, BRAIN, { p=P, v=V, k=K, m=M, c=CO })
  if pulse > 0 then C.px(x + 4, y + 1, M); C.px(x + 4, y + 3, M) end
  C.outline(K)
  if pulse > 0 then L.twinkle(C, x + 5, y - 3, A, nil, 1) end
  if pulse > 1 then L.twinkle(C, x + 15, y - 3, A, nil, 1) end
end

---------------------------------------------------------------- one frame
-- s = { le, re (eyes), lt, rt (tail points), tx, ty, gap, grin, bubbles, flash, flick }
local function overlord(C, s)
  local g = C.liquid
  g.rect(0, 0, CW, CH, Y)
  -- glass: two curved highlight streaks (jar wall) left, one right
  g.vline(2, 7, 9, LN); g.vline(3, 5, 2, LN); g.vline(2, 18, 2, LN)
  g.vline(45, 30, 6, LN)
  g.spans({ {45,3,9}, {46,1,14}, {47,0,47}, {46,20,27}, {45,22,25}, {46,36,46}, {45,39,44}, {44,41,42} }, LN)
  for _, p in ipairs(SPECKS) do g.px(p[1], p[2], LN) end
  if s.flick then                                              -- glass flicker: hard scan bands
    for _, r in ipairs(s.flick) do g.hline(0, r, CW, LN); g.hline(0, r + 1, CW, LN) end
  end
  if s.flash then
    g.rect(0, 0, CW, 2, P); g.rect(0, CH-2, CW, 2, P); g.rect(0, 0, 2, CH, P); g.rect(CW-2, 0, 2, CH, P)
  end

  if s.bx then brain(C.brain, s.bx, s.bry, s.pulse) end

  tail(C.tails, s.lt); tail(C.tails, s.rt)
  C.tails.outline(K)

  teeth(C.teeth, { x = s.tx, y = s.ty, gap = s.gap or 0, grin = s.grin })
  C.teeth.outline(K)

  eye(C.eyes, s.le, false); eye(C.eyes, s.re, true)
  C.eyes.outline(K)

  for _, b in ipairs(s.bubbles or {}) do bubble(C.fx, b[1], b[2], b[3]) end
  if s.flash then C.fx.stamp(42, 3, BANG, KEY) end
end

---------------------------------------------------------------- poses
-- idle: eyes in the upper corners, tails curl down beside the teeth (Aub sketch)
local function tailsDown(lx, ly, rx, ry, sw, short)
  sw = sw or 0
  if short then                                                -- needs: tails curl up short, clear of the grin
    return { lx,ly+6, lx,ly+9, lx-1+sw,ly+12, lx-2+sw,ly+14, lx-4+sw,ly+14, lx-5+sw,ly+12 },
           { rx-1,ry+6, rx-1,ry+9, rx-sw,ry+12, rx+1-sw,ry+14, rx+3-sw,ry+14, rx+4-sw,ry+12 }
  end
  local lt = { lx,ly+6,  lx-1,ly+11, lx+sw,ly+17, lx+sw,ly+22, lx-2+sw,ly+24, lx-4+sw,ly+23, lx-4+sw,ly+21 }
  local rt = { rx-1,ry+6, rx,ry+11, rx-1-sw,ry+17, rx-1-sw,ry+22, rx+1-sw,ry+24, rx+3-sw,ry+23, rx+3-sw,ry+21 }
  return lt, rt
end
-- lookDown: eyes pressed on the bottom glass, nerves float up behind them
local function tailsUp(lx, ly, rx, ry, sw)
  sw = sw or 0
  local lt = { lx-3,ly-5,  lx-6,ly-7,  lx-8+sw,ly-10, lx-7+sw,ly-13, lx-5+sw,ly-13, lx-4+sw,ly-11 }
  local rt = { rx+2,ry-5,  rx+5,ry-7,  rx+7-sw,ry-10, rx+6-sw,ry-13, rx+4-sw,ry-13, rx+3-sw,ry-11 }
  return lt, rt
end

local function idle(o)
  local lx, ly, rx, ry = 8, 8 + o.l, 39, 8 + o.r
  local lt, rt = tailsDown(lx, ly, rx, ry, o.sw)
  return { le = { x=lx, y=ly, px=o.px or 1, py=o.py or 1, lid=o.lid }, re = { x=rx, y=ry, px=o.rpx or -1, py=o.py or 1, lid=o.lid },
           lt = lt, rt = rt, tx = 13, ty = 34 + o.t, gap = o.gap, bubbles = o.bubbles,
           bx = 13, bry = 13 + (o.b or 0), pulse = o.pulse }
end

local function down(o)
  local lx, ly, rx, ry = 12 + (o.lx or 0), 38, 35 + (o.rx or 0), 38
  local lt, rt = tailsUp(lx, ly, rx, ry, o.sw)
  return { le = { x=lx, y=ly, px=1, py=3, press=true }, re = { x=rx, y=ry, px=-1, py=3, press=true },
           lt = lt, rt = rt, tx = 13, ty = 22 + o.t, gap = 0, bx = 13, bry = 2 + (o.b or 0) }
end

local function needs(o)
  local lx, ly, rx, ry = 8, 8, 39, 8 + (o.r or 0)
  local lt, rt = tailsDown(lx, ly, rx, ry, o.sw, true)
  return { le = { x=lx, y=ly, px=0, py=0, big=true }, re = { x=rx, y=ry, px=0, py=0, big=true },
           lt = lt, rt = rt, tx = 13, ty = 36, gap = 0, grin = true, flash = o.flash, flick = o.flick,
           bx = 13, bry = 13, pulse = o.pulse }
end

---------------------------------------------------------------- build + export
local function flat(spr, frame)
  local img = Image(spr.width, spr.height, ColorMode.INDEXED)
  img:clear(0)
  img:drawSprite(spr, frame)
  return img
end

local function sheet(asePath, pngBase, frames)
  local spr = L.new(CW, CH, pal)
  for i = 2, #frames do spr:newFrame() end
  local lay = {}
  for _, n in ipairs(LAYERS) do lay[n] = L.layer(spr, n) end
  local N = #frames
  local img = Image(CW*N, CH, ColorMode.INDEXED); img:clear(0)
  for i, s in ipairs(frames) do
    local C = {}
    for _, n in ipairs(LAYERS) do C[n] = L.canvas(spr, lay[n], spr.frames[i]) end
    overlord(C, s)
    for _, n in ipairs(LAYERS) do C[n].commit() end
    img:drawImage(flat(spr, i), Point((i-1)*CW, 0))
  end
  spr:saveAs(asePath); spr:close()
  for _, mode in ipairs({"dark", "light"}) do
    local out = Sprite(CW*N, CH, ColorMode.INDEXED)
    out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
    out.transparentColor = 0
    out.cels[1].image = img
    out:saveAs(pngBase.."-"..mode..".png"); out:close()
  end
  print("wrote "..pngBase.." "..N.." frames")
end

-- order = faces.json overlord: lookDown x0/48, idle x96/144, blink x192, talk x240/288/336, needs x384/432
sheet(root.."/art/office/faces/overlord-r4.aseprite", root.."/public/office/face-overlord", {
  down  { t = 0, sw = 0, b = 0 },
  down  { t = 1, sw = 1, lx = 1, b = 1 },
  idle  { l = 0, r = 1, t = 0, sw = 0, b = 0 },
  idle  { l = 1, r = 0, t = -1, sw = 1, b = -1 },
  idle  { l = 0, r = 0, t = 0, sw = 0, b = 0, lid = 0.85, px = 1, py = 2, rpx = -1 },
  idle  { l = 0, r = 1, t = 0, gap = 4, sw = 1, b = 0, pulse = 1, bubbles = { {20, 7, true}, {24, 3} } },
  idle  { l = 1, r = 0, t = 1, gap = 0, sw = 0, b = -1, pulse = 2, bubbles = { {27, 4, true}, {22, 3}, {21, 9} } },
  idle  { l = 0, r = 0, t = 0, gap = 3, sw = 1, b = 0, pulse = 1, bubbles = { {23, 3, true}, {27, 9}, {19, 8} } },
  needs { sw = 0, flick = { 21 }, pulse = 1 },
  needs { sw = 1, r = 1, flash = true, flick = { 8, 40 }, pulse = 2 },
})
