-- C2a-R2 sky-god faces at 48x48 in the H0 hand (art/cast/hypno/bust.lua): hand-picked shapes,
-- ASCII-stamped features, flat P0 fills, no gradients or shading ramps.
--   RiffBot R2 : sharp, smug TV head. Tilted beige CRT on rabbit-ear antennas, ink screen with a
--                lit face: half-lidded side-eye (mint pupils), one cocked brow, a cocky toothy
--                grin with one gold tooth; violet suit, mint tie. lookDown: pupils drop to the
--                bottom of the eyes, brows level. Ships to public/office/face-riffbot-* + faces.json
--                (the overlord entry in faces.json is kept as is).
--   Overlord O-A: a floating sinister mastermind head on a scanline screen (mint phosphor head,
--                teal slicked hair, ink features). Emotions are held stills: smug (lookDown/idle),
--                scheming (idle[1]), annoyed (talk[2]), needs = leans in (head scaled up). Between
--                stills: 1px jitter and a rolling teal scan bar on the glass. Written to
--                art/office/faces/overlord-a.aseprite + overlord-a-{dark,light}.png + overlord-a.json
--                only (Aub picks O-A or O-B).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/faces/build_r2.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local K, V, P, CO, A, S, M, T, G, Y = 15, 8, 9, 10, 11, 14, 4, 7, 12, 13
local KEY = { k=K, m=M, g=G, a=A, p=P, t=T, v=V, s=S }
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local CW, CH = 48, 48
local LAYERS = { "bg", "ant", "body", "head", "face", "fx" }

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

---------------------------------------------------------------- RiffBot R2
-- eye stamps (lit on the ink screen): m = white, g = mint pupil
local EYE = {
  -- sly: lids slant down toward the nose, ink pupil tucked in the right corner (side-eye),
  -- one solid white shape round it
  side  = { L = "|mmmmmm...|\n|mmmmmmmmm|\n|mmmmmmkkm|\n|mmmmmmkkm|\n|.mmmmmmm.|",
            R = "|...mmmmmmm|\n|.mmmmmmmmm|\n|mmmmmmmkkm|\n|mmmmmmmkkm|\n|.mmmmmmmm.|" },
  -- looking down at the tower: flat lids, three white rows, pupils on the bottom rim
  down  = { L = "|mmmmmmmmm|\n|mmmmmmmmm|\n|mmmmmmmmm|\n|mmmkkmmmm|\n|.mmkkmmm.|",
            R = "|mmmmmmmmmm|\n|mmmmmmmmmm|\n|mmmmmmmmmm|\n|mmmmkkmmmm|\n|.mmmkkmmm.|" },
  wide  = { L = "|.mmmmmmm.|\n|mmmmmmmmm|\n|mmmkkmmmm|\n|mmmkkmmmm|\n|mmmmmmmmm|\n|.mmmmmmm.|",
            R = "|.mmmmmmmm.|\n|mmmmmmmmmm|\n|mmmmkkmmmm|\n|mmmmkkmmmm|\n|mmmmmmmmmm|\n|.mmmmmmmm.|" },
  shut  = { L = "|.........|\n|.........|\n|.........|\n|mmmmmmmmm|\n|.m.....m.|",
            R = "|..........|\n|..........|\n|..........|\n|mmmmmmmmmm|\n|.m......m.|" },
}
-- s = { eyes = "side"|"down"|"wide"|"shut", brow = "cock"|"level"|"up", open = 0..3, needs, flash }
local function riff(C, s)
  local g = C.bg
  g.rect(0, 0, CW, CH, s.flash and P or Y)
  L.twinkle(g, 4, 5, s.flash and M or P, nil, 1); L.twinkle(g, 44, 40, s.flash and M or V, nil, 1)
  g.px(3, 31, s.flash and M or V)
  -- rabbit-ear antennas, leaning with the set
  local a = C.ant
  a.line(17, 11, 11, 3, V); a.line(18, 11, 12, 3, V)
  a.line(29, 9, 36, 2, V); a.line(30, 9, 37, 2, V)
  a.ellipse(10.5, 2.5, 1.8, 1.8, P); a.ellipse(37.5, 1.5, 1.8, 1.8, P)
  a.outline(K)
  -- violet suit, marble shirt, mint tie
  local b = C.body
  b.poly({2,49, 4,43, 13,40, 35,39, 44,42, 46,49}, V)
  b.rect(20, 36, 9, 5, V)
  b.outline(K)
  b.poly({18,40, 24,48, 31,39}, M)
  b.line(18,40, 24,48, K); b.line(31,39, 24,48, K)
  b.poly({23,41, 26,41, 27,47, 22,47}, G); b.hline(23, 41, 4, K); b.px(24, 43, K); b.px(25, 45, K)
  b.line(13,41, 17,47, K); b.line(36,40, 32,47, K)                -- lapels
  -- tilted beige CRT (top edge rises to the right)
  local h = C.head
  h.poly({5,15, 38,8, 44,33, 10,40}, S)
  h.outline(K)
  h.px(7, 16, M); h.px(8, 16, M); h.px(7, 17, M)                   -- shine tick
  h.rect(40, 30, 2, 2, s.needs and P or G)                         -- power LED
  -- ink screen + lit face
  local f = C.face
  f.poly({9,17, 37,11, 41,30, 13,36}, K)
  local e = EYE[s.eyes]
  local ly, ry = 21, 17
  if s.eyes == "wide" then ly, ry = 20, 16 end
  f.stamp(13, ly, e.L, KEY); f.stamp(26, ry, e.R, KEY)
  -- brows: 2px amber on the ink glass, 1px clear of the eyes
  local function brow(x0, y0, x1, y1) f.line(x0, y0, x1, y1, A); f.line(x0, y0+1, x1, y1+1, A) end
  if s.brow == "cock" then
    brow(13, ly-4, 21, ly-3)                                       -- left: angled down-in, scheming
    brow(26, ry-3, 29, ry-5); brow(30, ry-5, 35, ry-4)             -- right: cocked arch
  elseif s.brow == "level" then
    brow(13, ly-4, 21, ly-3); brow(26, ry-3, 35, ry-4)
  elseif s.brow == "up" then
    brow(13, ly-4, 21, ly-5); brow(26, ry-3, 29, ry-5); brow(30, ry-5, 35, ry-4)
  end
  -- cocky toothy crescent grin: upper and lower teeth, pink gap when open, ink seams every
  -- 3px, one gold tooth; per-column lift is hand-picked (right end curls higher: smirk)
  local LIFT = {2,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,2,3}
  local open = s.open or 0
  for i, lift in ipairs(LIFT) do
    local x, top = 14 + i, 28 - lift
    local seam = (i % 3 == 0) and i < #LIFT - 1
    f.rect(x, top, 1, 2, seam and K or M)                          -- upper teeth
    f.rect(x, top + 2, 1, math.max(open, 1), open > 0 and P or K)
    f.rect(x, top + 2 + math.max(open, 1), 1, 2, seam and K or M)  -- lower teeth
  end
  f.rect(25, 28, 2, 2, A)                                          -- gold tooth (upper row)
  f.px(39, 23, M)                                                  -- smirk hook
  if s.needs then C.fx.stamp(43, 0, BANG, KEY) end
end

---------------------------------------------------------------- Overlord O-A
-- s = { emo = "smug"|"scheme"|"annoyed"|"lean", look = "down"|"fwd"|"wide", blink, mouth, jx, roll, flash }
local function mastermind(C, s)
  -- solid ink glass; needs flash = 2px pink frame
  local g = C.bg
  g.rect(0, 0, CW, CH, K)
  if s.flash then
    g.rect(0, 0, CW, 2, P); g.rect(0, CH-2, CW, 2, P); g.rect(0, 0, 2, CH, P); g.rect(CW-2, 0, 2, CH, P)
  end
  local z = (s.emo == "lean") and 1.25 or 1
  local cx = 24 + (s.jx or 0)
  local cy = (s.emo == "lean") and 25 or 23
  if s.look == "down" then cy = cy + 1 end
  local function X(dx) return cx + math.floor(dx * z + 0.5) end
  local function Yy(dy) return cy + math.floor(dy * z + 0.5) end
  -- head: mint phosphor dome + long jaw, ears, teal slicked hair with a widow's peak
  local h = C.head
  h.ellipse(X(-12), Yy(1), 2.4*z, 4*z, G); h.ellipse(X(12), Yy(0), 2.4*z, 4*z, G)
  h.ellipse(cx, Yy(-2), 11.5*z, 13.5*z, G, {0,0,-1,0,0,0,1,0,0,0,0,-1,0}, {0,1,0,0,0,-1,0,0,0,1,0,0,0})
  h.poly({X(-9),Yy(6), X(9),Yy(6), X(6),Yy(14), X(1),Yy(17), X(-4),Yy(15)}, G)
  -- hologram scanlines live inside the head: every 3rd row, plus the rolling bar (2 rows)
  for y = 0, CH-1 do
    local roll = s.roll and (y == s.roll or y == s.roll + 1)
    if y % 3 == 0 or roll then
      for x = 0, CW-1 do if h.get(x, y) == G then h.px(x, y, T) end end
    end
  end
  h.outline(T)
  h.poly({X(-11),Yy(-6), X(-10),Yy(-12), X(-4),Yy(-16), X(4),Yy(-16), X(10),Yy(-12), X(11),Yy(-6),
          X(7),Yy(-10), X(1),Yy(-8), X(0),Yy(-6), X(-1),Yy(-8), X(-7),Yy(-10)}, T)
  h.line(X(-6), Yy(-13), X(-8), Yy(-9), K); h.line(X(4), Yy(-14), X(7), Yy(-10), K)  -- comb lines
  local f = C.face
  local emo = s.emo
  -- brows (2px ink)
  local function brow(x0, y0, x1, y1) f.line(x0, y0, x1, y1, K); f.line(x0, y0+1, x1, y1+1, K) end
  if emo == "smug" then
    brow(X(-9), Yy(-6), X(-3), Yy(-5)); brow(X(3), Yy(-6), X(9), Yy(-7))
  elseif emo == "scheme" or emo == "lean" then
    brow(X(-9), Yy(-7), X(-2), Yy(-4)); brow(X(2), Yy(-4), X(9), Yy(-7))
  elseif emo == "annoyed" then
    brow(X(-9), Yy(-5), X(-2), Yy(-5)); brow(X(2), Yy(-5), X(9), Yy(-5)); f.px(X(-1), Yy(-7), K); f.px(X(1), Yy(-7), K)
  end
  -- eyes: 5x4 marble whites, 2x2 ink pupils
  local ey = Yy(-3)
  local lx, rx = X(-8), X(3)
  if s.blink then
    f.hline(lx, ey+2, 5, K); f.hline(rx, ey+2, 5, K); f.px(lx-1, ey+1, K); f.px(rx+5, ey+1, K)
  elseif s.look == "wide" then          -- leaning in, staring: 5x5, pupils centred
    f.rect(lx, ey-1, 5, 5, M); f.rect(rx, ey-1, 5, 5, M)
    f.rect(lx+2, ey+1, 2, 2, K); f.rect(rx+1, ey+1, 2, 2, K)
  elseif s.look == "down" then          -- whites above, pupils on the bottom rim
    f.rect(lx, ey, 5, 4, M); f.rect(rx, ey, 5, 4, M)
    f.rect(lx+2, ey+2, 2, 2, K); f.rect(rx+1, ey+2, 2, 2, K)
  else                                  -- half-lidded: ink lid over the top row, pupils to the side
    f.rect(lx, ey, 5, 4, M); f.rect(rx, ey, 5, 4, M)
    f.hline(lx, ey, 5, K); f.hline(rx, ey, 5, K)
    local pd = (emo == "annoyed") and 0 or 2
    f.rect(lx+1+pd, ey+1, 2, 2, K); f.rect(rx+pd, ey+1, 2, 2, K)
  end
  -- long nose + nostril, cheek creases
  f.line(cx, Yy(0), X(1), Yy(5), K); f.px(X(2), Yy(5), K); f.px(X(-1), Yy(6), K)
  f.line(X(-5), Yy(4), X(-6), Yy(9), K); f.line(X(6), Yy(4), X(7), Yy(9), K)
  -- pencil moustache + pointed goatee
  f.hline(X(-4), Yy(8), 4, K); f.hline(X(1), Yy(8), 4, K); f.px(X(-5), Yy(9), K); f.px(X(5), Yy(9), K)
  f.poly({X(-2),Yy(13), X(3),Yy(13), X(1),Yy(17)}, K)
  -- mouth
  local my = Yy(10)
  local m = s.mouth or "smirk"
  if m == "smirk" then
    f.line(X(-4), my, X(3), my, K); f.line(X(3), my, X(5), my - 2, K)
  elseif m == "grin" then               -- wide suave grin: one clean row of teeth, no seams
    f.line(X(-5), my - 1, X(-3), my + 1, K); f.line(X(6), my - 2, X(5), my + 1, K)
    f.hline(X(-3), my, 9, M); f.hline(X(-3), my + 1, 9, K); f.hline(X(-4), my - 1, 10, K)
  elseif m == "o" then
    f.rect(X(-2), my - 1, 4, 3, K); f.hline(X(-1), my - 1, 2, M)
  elseif m == "talk" then
    f.rect(X(-4), my - 1, 9, 3, K); f.hline(X(-3), my - 1, 7, M)
  elseif m == "frown" then
    f.line(X(-4), my + 1, X(-2), my - 1, K); f.hline(X(-2), my - 1, 5, K); f.line(X(3), my - 1, X(5), my + 1, K)
  end
  if s.flash then C.fx.stamp(43, 2, BANG, KEY) end
end

---------------------------------------------------------------- build + export
local function flat(spr, frame)
  local img = Image(spr.width, spr.height, ColorMode.INDEXED)
  img:clear(0)
  img:drawSprite(spr, frame)
  return img
end

-- builds one layered .aseprite (a frame per face) + a one-row strip per mode; returns frame json
local function sheet(asePath, pngBase, draw, frames)
  local spr = L.new(CW, CH, pal)
  for i = 2, #frames do spr:newFrame() end
  local lay = {}
  for _, n in ipairs(LAYERS) do lay[n] = L.layer(spr, n) end
  local N = #frames
  local img = Image(CW*N, CH, ColorMode.INDEXED); img:clear(0)
  local js, order = {}, {}
  for i, fr in ipairs(frames) do
    local C = {}
    for _, n in ipairs(LAYERS) do C[n] = L.canvas(spr, lay[n], spr.frames[i]) end
    draw(C, fr.s)
    for _, n in ipairs(LAYERS) do C[n].commit() end
    img:drawImage(flat(spr, i), Point((i-1)*CW, 0))
    if not js[fr.tag] then js[fr.tag] = {}; order[#order+1] = fr.tag end
    table.insert(js[fr.tag], '{"x":'..((i-1)*CW)..',"y":0}')
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
  local parts = {}
  for _, tag in ipairs(order) do parts[#parts+1] = '"'..tag..'":['..table.concat(js[tag], ",")..']' end
  return '{'..table.concat(parts, ",")..'}'
end

local function F(tag, s) return { tag = tag, s = s } end
local fdir = root.."/art/office/faces/"
local rj = sheet(fdir.."riffbot.aseprite", root.."/public/office/face-riffbot", riff, {
  F("lookDown", { eyes = "down", brow = "level" }),
  F("idle",     { eyes = "side", brow = "cock" }),
  F("blink",    { eyes = "shut", brow = "cock" }),
  F("talk",     { eyes = "side", brow = "cock", open = 1 }),
  F("talk",     { eyes = "side", brow = "cock", open = 3 }),
  F("talk",     { eyes = "side", brow = "level", open = 2 }),
  F("needs",    { eyes = "wide", brow = "up", open = 2, needs = true }),
  F("needs",    { eyes = "wide", brow = "up", open = 2, needs = true, flash = true }) })
local oj = sheet(fdir.."overlord-a.aseprite", fdir.."overlord-a", mastermind, {
  F("lookDown", { emo = "smug", look = "down", roll = 8 }),
  F("lookDown", { emo = "smug", look = "down", jx = 1, roll = 31 }),
  F("idle",     { emo = "smug", look = "fwd", roll = 17 }),
  F("idle",     { emo = "scheme", look = "fwd", mouth = "grin", jx = -1, roll = 40 }),
  F("blink",    { emo = "smug", blink = true, roll = 24 }),
  F("talk",     { emo = "smug", look = "fwd", mouth = "o", roll = 5 }),
  F("talk",     { emo = "scheme", look = "fwd", mouth = "talk", jx = 1, roll = 28 }),
  F("talk",     { emo = "annoyed", look = "fwd", mouth = "frown", roll = 44 }),
  F("needs",    { emo = "lean", look = "wide", mouth = "grin", roll = 12 }),
  F("needs",    { emo = "lean", look = "wide", mouth = "grin", jx = 1, flash = true, roll = 36 }) })
local fo = io.open(fdir.."overlord-a.json", "wb")
fo:write('{"version":1,"cell":{"w":'..CW..',"h":'..CH..'},"fps":3,\n "overlord":'..oj..'}\n'); fo:close()
-- faces.json: new riffbot, keep the shipped overlord entry untouched
local fj = io.open(root.."/public/office/faces.json", "rb"); local old = fj:read("a"); fj:close()
local keep = old:match('"overlord":(%b{})')
local json = '{"version":1,"cell":{"w":'..CW..',"h":'..CH..'},"fps":3,\n "riffbot":'..rj..',\n "overlord":'..keep..'}\n'
fj = io.open(root.."/public/office/faces.json", "wb"); fj:write(json); fj:close()
print("wrote faces.json")
