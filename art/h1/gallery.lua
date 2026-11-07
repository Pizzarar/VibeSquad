-- H1 gallery: style-bible gate sheet. Hand-placed shapes on the H0 helpers (lib.lua), P0 slots,
-- INDEXED, exported as a pure palette swap. Right half = H1 samples (3 cast busts rest + "yo!",
-- RiffBot + Overlord 48px faces, a floor crop); left half = the H0 sheet itself for comparison.
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/h1/gallery.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local dir = root.."/art/h1/"
local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }
local BGc, PANEL, PHI, LINE = 0, 1, 2, 3
local K, V, P, CO, A, S, M, T, G, Y = 15, 8, 9, 10, 11, 14, 4, 7, 12, 13

local WOB_L = {0,0,-1,0,0,1,0,0,0,-1,0,0,1,0,0,0,0,-1,0}
local WOB_R = {0,1,0,0,0,0,1,1,0,0,0,-1,0,0,1,0,0,0,0}

local function mk(w, h, names)
  local spr = L.new(w, h, pal.dark)
  local t = {}
  for _, n in ipairs(names) do t[n] = L.canvas(spr, L.layer(spr, n), spr.frames[1]) end
  return spr, t
end
local function done(spr, t, name)
  for _, c in pairs(t) do c.commit() end
  spr:saveAs(dir..name..".aseprite")
  local img = Image(spr.width, spr.height, ColorMode.INDEXED); img:clear(0)
  img:drawSprite(spr, 1)
  return img
end

-- ---------- shared face language (bible: googly, lopsided, INK line mouths) ----------
-- eyes: list of {x, y, rx, ry}; draws MARBLE balls, outlines them (caller's canvas = face only)
local function eyes(C, list) for _, e in ipairs(list) do C.ellipse(e[1], e[2], e[3], e[4], M) end; C.outline(K) end
-- rest lid: top `frac` of each eye becomes lidc, then an INK lid line
local function lids(C, list, lidc, frac)
  for _, e in ipairs(list) do
    local top = math.ceil(e[2] - e[4]); local cut = math.floor(e[2] - e[4] + 2*e[4]*frac + 0.5)
    for y=top, cut do for x=math.floor(e[1]-e[3])-1, math.ceil(e[1]+e[3])+1 do
      if C.get(x, y) == M then C.px(x, y, y == cut and K or lidc) end
    end end
  end
end
local function pupil(C, x, y, w, h) C.rect(x, y, w or 2, h or 3, K); C.px(x, y, M) end
local function smile(C, x, y, w)   -- lopsided smile, x = left end
  C.line(x, y, x+2, y+2, K); C.hline(x+2, y+2, w-5, K); C.line(x+w-3, y+2, x+w, y-1, K)
  C.px(x+w//2-1, y+3, P); C.px(x+w//2, y+3, P)
end
-- open shout mouth (on a canvas that is outlined afterwards)
local function shout(C, cx, cy, rx, ry) C.ellipse(cx, cy, rx, ry, P) end
local function tongue(C, cx, cy, rx) C.ellipse(cx, cy, rx, 1.6, CO) end
-- open palm waving, sleeve colour sc rising from the bottom edge (canvas outlined afterwards)
local function palm(C, x, y, sc, H)
  if sc then C.poly({x-5, H, x-4, y+4, x+4, y+4, x+5, H}, sc) end
  C.ellipse(x, y, 3.6, 3.6, S)
  C.rect(x-4, y-7, 2, 5, S); C.rect(x-1, y-8, 2, 6, S); C.rect(x+2, y-7, 2, 5, S)
  C.rect(x+4, y-2, 3, 2, S)
end
local function wiggle(C, x, y, side)   -- motion ticks beside a waving hand
  C.line(x, y, x+side, y-2, K); C.line(x, y+4, x+side*2, y+3, K)
end
-- "YO!" balloon: MARBLE, INK rim, PINK letters, tail towards (tx, ty)
local function yo(C, x, y, tx, ty)
  C.rect(x+1, y, 17, 11, M); C.rect(x, y+1, 19, 9, M)
  C.poly({x+12, y+9, x+16, y+9, tx, ty}, M)
  C.outline(K)
  L.text(C, x+4, y+3, "YO!", P)
end
local function bang(C, x, y)   -- small "!" balloon for 48px faces
  C.rect(x+1, y, 5, 9, M); C.rect(x, y+1, 7, 7, M)
  C.outline(K)
  C.vline(x+3, y+2, 3, P); C.px(x+3, y+6, P)
end

-- ---------- role costumes (copied from H0 bust.lua so the role cue never drifts) ----------
local function reviewBody(b)
  b.poly({6,64, 8,53, 18,49, 46,49, 56,53, 58,64}, V)
  b.poly({26,49, 38,49, 32,60}, M)
  b.outline(K)
  b.line(26,49, 32,60, K); b.line(38,49, 32,60, K); b.vline(32, 60, 4, K)
  for y=59,63,4 do b.rect(33, y, 2, 2, A) end
  b.poly({27,49, 32,51, 37,49, 37,54, 32,52, 27,54}, P)
  b.line(27,49, 27,54, K); b.line(37,49, 37,54, K); b.line(27,49, 32,51, K); b.line(37,49, 32,51, K)
  b.line(27,54, 32,52, K); b.line(37,54, 32,52, K); b.rect(31, 50, 3, 3, K)
  b.line(14,54, 14,63, K); b.line(50,54, 50,63, K)
end
local function leadBody(b)
  b.poly({2,64, 4,50, 12,45, 52,45, 60,50, 62,64}, P)
  for _, d in ipairs({{7,53},{16,58},{9,61},{47,55},{56,59},{51,62},{20,51},{44,50},{57,52}}) do b.rect(d[1], d[2], 2, 2, A) end
  b.poly({24,45, 40,45, 32,60}, M)
  b.poly({30,47, 34,47, 35,57, 32,61, 29,57}, T)
  b.outline(K)
  b.line(24,45, 31,60, K); b.line(40,45, 33,60, K)
  b.line(30,47, 34,47, K); b.line(29,57, 32,61, K); b.line(35,57, 32,61, K)
  b.line(12,46, 12,63, K); b.line(52,46, 52,63, K)
  b.hline(5, 50, 6, M); b.hline(54, 50, 5, M)
  b.rect(27, 41, 10, 5, S); b.vline(27, 41, 4, K); b.vline(36, 41, 4, K)
end
local function brickPhone(p)
  p.rect(47, 22, 7, 16, A); p.rect(48, 24, 5, 3, G); p.rect(48, 29, 5, 6, K)
  for y=29,33,2 do for x=48,52,2 do p.px(x, y, M) end end
  p.vline(52, 6, 16, K); p.rect(51, 4, 3, 3, P)
  p.ellipse(47, 36, 4, 4, S)
end
local function twinkles(fx) L.twinkle(fx, 4, 6, A, P, 2); L.twinkle(fx, 59, 40, P, nil, 1); L.twinkle(fx, 6, 38, T, nil, 1) end
local function twinklesYo(fx) L.twinkle(fx, 59, 40, P, nil, 1); L.twinkle(fx, 57, 6, A, P, 2) end

local BUST = {"body", "head", "hair", "face", "mouth", "prop", "fx", "bubble"}

-- REVIEW v1 "3-EYE PEAR": amber pear head, three lopsided eyes, leaf stem
local function pear(mood)
  local spr, C = mk(64, 64, BUST)
  reviewBody(C.body)
  local h = C.head
  h.ellipse(32, 38, 17, 10, A, WOB_L, WOB_R)
  h.ellipse(31, 21, 10, 11, A, {0,1,0,0,-1,0,0}, {0,0,1,0,0,-1,0})
  h.outline(K)
  h.hline(24, 14, 3, M); h.px(23, 15, M); h.px(19, 32, M); h.px(19, 33, M)   -- shine
  local r = C.hair
  r.poly({30,11, 31,4, 33,3, 33,11}, CO); r.ellipse(38, 5, 4.2, 2.1, G)       -- stem + leaf
  r.outline(K); r.line(35, 5, 41, 5, K)
  local f = C.face
  local E = {{24, 30, 3.1, 4.1}, {40, 29, 4.6, 5.6}, {31, 18, 2.6, 3.1}}
  eyes(f, E)
  f.rect(17, 37, 3, 2, CO); f.rect(45, 36, 4, 2, CO)                           -- blush
  f.px(25, 46, K); f.px(39, 46, K)                                              -- freckles
  local m = C.mouth
  if mood == "rest" then
    lids(f, E, A, 0.5)
    pupil(f, 23, 31); pupil(f, 39, 31); f.rect(31, 19, 1, 2, K)
    f.line(20, 24, 26, 24, K); f.line(36, 22, 43, 23, K)                       -- flat brows
    smile(f, 24, 39, 16)
  else
    pupil(f, 24, 27); pupil(f, 40, 25); f.rect(31, 16, 2, 2, K)
    f.line(20, 22, 26, 20, K); f.line(36, 19, 43, 17, K); f.px(44, 18, K)      -- brows up
    shout(m, 32, 41, 6.1, 4.1); m.outline(K); tongue(m, 32, 43, 3)
    local p = C.prop
    palm(p, 56, 40, V, 64); p.outline(K); wiggle(p, 49, 33, -1)
    yo(C.bubble, 2, 2, 20, 16)
  end
  if mood == "rest" then twinkles(C.fx) else twinklesYo(C.fx) end
  return done(spr, C, "review-pear-"..mood)
end

-- REVIEW v2 "SOCK PUPPET": teal sock with a floppy toe, sewn-on googly eyes, yarn tuft
local function sock(mood)
  local spr, C = mk(64, 64, BUST)
  reviewBody(C.body)
  local h = C.head
  h.ellipse(31, 32, 13, 19, T, WOB_L, WOB_R)
  h.ellipse(43, 15, 10, 6, T, {0,0,1,0,0}, {0,1,0,0,1})
  h.ellipse(51, 21, 4.1, 4.6, T)
  for y=42,50 do for x=0,63 do                                                   -- pink cuff stripes
    if h.get(x, y) == T and (y == 43 or y == 44 or y == 47 or y == 48) then h.px(x, y, P) end
  end end
  h.outline(K)
  h.vline(20, 22, 9, M); h.px(21, 20, M); h.hline(44, 11, 3, M)                -- felt shine
  for x=21,41,4 do h.vline(x, 45, 2, K) end                                    -- ribbing ticks
  local r = C.hair
  r.ellipse(26, 13, 2.6, 2.6, A); r.ellipse(31, 11, 3.1, 2.6, CO); r.ellipse(36, 13, 2.6, 2.6, A)
  r.outline(K)
  local f = C.face
  local E = {{24, 25, 4.1, 4.6}, {37, 24, 5.1, 5.6}}
  eyes(f, E)
  local m = C.mouth
  if mood == "rest" then
    f.rect(22, 27, 3, 3, K); f.rect(34, 27, 3, 3, K)                           -- pupils sagged (googly gravity)
    f.line(18, 36, 22, 38, K); f.hline(22, 38, 15, K); f.line(37, 38, 43, 35, K)  -- closed seam smile
    f.hline(28, 39, 4, P)
  else
    f.rect(24, 21, 3, 3, K); f.rect(37, 19, 3, 3, K)                           -- pupils jumped up
    f.line(19, 17, 25, 16, P); f.line(33, 15, 40, 14, P)                       -- felt brows up
    shout(m, 31, 40, 9.1, 5.1); m.outline(K); tongue(m, 31, 43, 4)
    local p = C.prop
    palm(p, 56, 42, V, 64); p.outline(K); wiggle(p, 49, 35, -1)
    p.line(55, 12, 58, 10, K); p.line(56, 16, 60, 16, K)                       -- toe boing
    yo(C.bubble, 2, 2, 19, 15)
  end
  if mood == "rest" then twinkles(C.fx) else twinklesYo(C.fx) end
  return done(spr, C, "review-sock-"..mood)
end

-- LEAD v1 "CONE HEAD": tall cone skull, comb-over curl, shades (rest) pushed up (yo)
local function cone(mood)
  local spr, C = mk(64, 64, BUST)
  leadBody(C.body)
  if mood == "yo" then                                                          -- raised arm is part of the jacket
    C.body.poly({2,64, 3,47, 8,45, 14,46, 15,64}, P); C.body.outline(K); C.body.line(14, 52, 14, 63, K)
  end
  local h = C.head
  h.ellipse(31, 32, 14, 11, S, WOB_L, WOB_R)
  h.poly({18,30, 23,16, 28,6, 32,1, 36,5, 40,16, 45,30}, S)
  h.ellipse(16, 33, 2.6, 3.6, S); h.ellipse(46, 34, 2.6, 3.6, S)
  h.outline(K)
  h.line(26, 15, 29, 7, M); h.px(25, 17, M)                                     -- dome shine
  local r = C.hair
  r.poly({16,30, 18,25, 21,30}, K); r.poly({46,30, 44,25, 41,30}, K)          -- side tufts
  r.outline(K)
  r.line(32, 2, 35, 0, K); r.px(36, 1, K); r.px(36, 2, K); r.px(35, 3, K)     -- comb-over curl
  local f = C.face
  f.rect(17, 36, 3, 2, CO); f.rect(43, 36, 4, 2, CO)
  f.px(31, 34, CO); f.px(32, 35, CO)
  local m = C.mouth
  local function shades(y, x0, x1)
    f.poly({x0, y, x0+10, y, x0+9, y+5, x0+1, y+5}, K)
    f.poly({x1, y-1, x1+12, y-1, x1+11, y+5, x1+1, y+5}, K)
    f.hline(x0+10, y+1, x1-x0-10, K)
    f.line(x0+2, y+1, x0+3, y+2, V); f.line(x1+2, y, x1+4, y+2, V); f.px(x1+9, y+1, M)
  end
  if mood == "rest" then
    shades(27, 18, 32)
    f.line(20, 24, 28, 25, K); f.line(33, 23, 43, 24, K)
    f.line(24, 40, 30, 41, K); f.line(30, 41, 38, 38, K); f.px(36, 40, P); f.px(35, 40, P)  -- smirk
  else
    local E = {{25, 29, 3.6, 4.6}, {38, 28, 4.6, 5.6}}
    eyes(f, E)
    pupil(f, 25, 26); pupil(f, 38, 24)
    shades(9, 21, 32)
    f.line(20, 21, 27, 19, K); f.line(34, 19, 42, 20, K)
    shout(m, 31, 40, 6.6, 3.6); m.outline(K); tongue(m, 31, 42, 3)
    m.hline(27, 37, 9, M)                                                       -- top teeth
  end
  local p = C.prop
  brickPhone(p)
  if mood == "yo" then palm(p, 9, 38); p.rect(4, 42, 10, 3, M) end   -- palm + shirt cuff
  p.outline(K)
  p.vline(52, 6, 16, K); p.line(44, 35, 47, 33, K); p.line(45, 37, 48, 35, K)
  if mood == "yo" then wiggle(p, 16, 31, 1); yo(C.bubble, 2, 2, 22, 18) end
  if mood == "rest" then twinkles(C.fx) else L.twinkle(C.fx, 59, 44, P, nil, 1) end
  return done(spr, C, "lead-cone-"..mood)
end

-- ---------- 48px faces ----------
local FACE = {"back", "body", "screen", "face", "mouth", "prop", "fx", "bubble"}

-- RiffBot: cream TV, googly eyes on the screen, the mouth is the stock ticker
local function riffbot(mood)
  local spr, C = mk(48, 48, FACE)
  C.back.rect(0, 0, 48, 48, Y)
  local b = C.body
  b.poly({6,11, 22,9, 41,10, 43,26, 42,41, 24,42, 5,41, 4,25}, M)
  b.poly({5,37, 42,37, 42,41, 24,42, 5,41}, CO)
  b.outline(K)
  b.hline(5, 36, 38, K)
  for x=8,40,4 do b.px(x, 39, A) end
  local s = C.screen
  s.rect(8, 13, 26, 22, K); s.rect(9, 14, 24, 20, T)
  for y=15,33,4 do s.hline(10, y, 22, G) end
  for _, k in ipairs({{38, 16}, {38, 23}}) do s.ellipse(k[1], k[2], 2.2, 2.2, P) end
  for y=28,32,2 do s.hline(36, y, 5, K) end
  s.px(38, 14, K); s.px(38, 21, K)
  local f = C.face
  local E = {{15, 20, 3.1, 3.6}, {25, 19, 3.6, 4.6}}
  if mood == "yo" then E = {{15, 19, 3.6, 4.1}, {25, 18, 4.1, 5.1}} end
  eyes(f, E)
  f.rect(10, 27, 22, 7, K)                                                       -- ticker band
  if mood == "rest" then
    lids(f, E, T, 0.45); pupil(f, 14, 21); pupil(f, 24, 20)
    L.text(f, 11, 28, "+4.20", A)
  else
    pupil(f, 15, 16, 2, 2); pupil(f, 25, 15, 2, 2)
    f.line(11, 13, 16, 12, K); f.line(22, 11, 28, 12, K)
    L.text(f, 13, 28, "YO!!", P)
  end
  local p = C.prop
  p.rect(19, 8, 9, 2, K)
  p.rect(11, 43, 6, 3, A); p.rect(30, 43, 6, 3, A)                              -- sneakers
  if mood == "yo" then
    p.poly({42,27, 45,22, 46,23, 43,29}, M); p.ellipse(46, 19, 2.6, 2.6, M)    -- arm up
  end
  p.outline(K)
  p.line(19, 9, 12, 2, K); p.line(27, 9, 31, 5, K); p.line(31, 5, 37, 3, K)    -- bent rabbit ears
  p.rect(11, 1, 2, 2, P); p.rect(37, 2, 2, 2, P)
  p.vline(14, 41, 2, K); p.vline(33, 41, 2, K)
  if mood == "yo" then
    L.twinkle(C.fx, 7, 4, A, M, 2); L.twinkle(C.fx, 42, 7, A, nil, 1)
  else
    L.twinkle(C.fx, 43, 4, M, nil, 1)
  end
  return done(spr, C, "riffbot-"..mood)
end

-- Overlord: violet TV with a glass jar on top holding its brain; one big eye + toothy grin on screen
local function overlord(mood)
  local spr, C = mk(48, 48, {"back", "brain", "jar", "body", "screen", "face", "mouth", "prop", "fx", "bubble"})
  C.back.rect(0, 0, 48, 48, Y)
  local br = C.brain
  br.ellipse(24, 12, 9.6, 6.1, P, {0,1,0,0,-1,0}, {0,0,1,0,0,1})
  br.outline(K)
  br.line(17, 10, 20, 8, CO); br.line(20, 8, 22, 11, CO); br.line(24, 7, 25, 12, CO)
  br.line(27, 9, 30, 8, CO); br.line(28, 13, 31, 12, CO); br.line(18, 14, 22, 14, CO)
  br.vline(24, 13, 4, K)
  local j = C.jar
  j.ellipse(24, 12, 15, 11, M); j.rect(9, 12, 31, 7, M)
  j.outline(K)
  for y=0,20 do for x=0,47 do if j.get(x, y) == M then j.px(x, y, 0) end end end -- glass: only the rim stays
  j.vline(12, 6, 9, M); j.vline(13, 4, 2, M); j.px(35, 5, M); j.px(36, 6, M)      -- glass glints
  local b = C.body
  b.poly({4,22, 24,21, 44,22, 45,34, 44,43, 24,44, 4,43, 3,33}, V)
  b.rect(8, 18, 32, 3, A)                                                         -- jar collar
  b.outline(K)
  for _, x in ipairs({10, 24, 37}) do b.px(x, 19, K) end
  b.hline(5, 21, 39, K)
  local s = C.screen
  s.rect(7, 24, 26, 18, K); s.rect(8, 25, 24, 16, G)
  for y=26,40,3 do s.hline(9, y, 22, T) end
  for _, k in ipairs({{38, 28}, {38, 35}}) do s.ellipse(k[1], k[2], 2.2, 2.2, A) end
  s.px(38, 26, K); s.px(38, 33, K)
  for y=39,41,2 do s.hline(36, y, 5, K) end
  local f = C.face
  local E = {{20, 30, 6.1, 4.6}}
  if mood == "yo" then E = {{20, 30, 6.6, 5.1}} end
  eyes(f, E)
  local m = C.mouth
  if mood == "rest" then
    lids(f, E, G, 0.5)
    f.ellipse(19, 32, 2.1, 1.6, P); pupil(f, 18, 32, 2, 2)
    f.line(13, 24, 27, 26, K)                                                     -- smug brow
    f.hline(11, 37, 18, K); f.hline(12, 39, 16, K)
    for x=12,27 do if (x % 3) ~= 0 then f.px(x, 38, M) else f.px(x, 38, K) end end
  else
    f.ellipse(20, 30, 2.6, 2.6, P); pupil(f, 19, 29, 2, 2)
    f.line(12, 23, 18, 25, K); f.line(22, 25, 28, 22, K)                          -- villain brows up
    m.rect(10, 36, 20, 5, P); m.outline(K)
    for x=11,28 do if (x % 3) ~= 1 then m.px(x, 36, M) end end
    m.hline(15, 40, 10, CO)
  end
  local p = C.prop
  p.rect(9, 45, 6, 2, A); p.rect(32, 45, 6, 2, A)
  p.outline(K)
  if mood == "yo" then
    local fx = C.fx
    fx.line(2, 4, 5, 7, A); fx.line(5, 7, 2, 10, A); fx.line(2, 10, 5, 13, A)    -- brain zaps
    fx.line(46, 12, 43, 15, A); fx.line(43, 15, 46, 18, A)
    bang(C.bubble, 41, 0)
  else
    L.twinkle(C.fx, 43, 6, M, nil, 1)
  end
  return done(spr, C, "overlord-"..mood)
end

-- ---------- floor crop ----------
local function floorSprite(role, frame)
  local s = app.open(root.."/art/cast/hypno/"..role.."-floor.aseprite")
  local img = Image(32, 32, ColorMode.INDEXED); img:clear(0); img:drawSprite(s, frame)
  s:close()
  return img
end

local function floorCrop()
  local FW, FH = 208, 100
  local spr, C = mk(FW, FH, {"room", "sky", "sun", "frame", "decor", "cast", "front"})
  local R = C.room
  R.rect(0, 0, FW, 60, PHI)
  for y=4,52,12 do for x=((y//12)%2)*8+4, FW-1, 16 do
    R.px(x, y, LINE); R.px(x-1, y, LINE); R.px(x+1, y, LINE); R.px(x, y-1, LINE); R.px(x, y+1, LINE)
  end end
  for y=60,FH-1 do for x=0,FW-1 do
    R.px(x, y, ((x//10 + (y-60)//6) % 2 == 0) and PANEL or PHI)
  end end
  R.hline(0, 55, FW, K); R.rect(0, 56, FW, 3, V); R.hline(0, 59, FW, K)
  -- window: Bayer sunset (gradient = the only dither), striped sun, crooked palm
  local sky = C.sky
  local ramp = {Y, V, P, CO, A}
  for y=7,35 do
    local t = (y-7)/28*4; local i = math.min(math.floor(t), 3)
    for x=10,77 do sky.px(x, y, L.dith(x, y, ramp[i+1], ramp[i+2], t-i)) end
  end
  for y=36,41 do for x=10,77 do sky.px(x, y, V) end end
  for _, d in ipairs({{30,38,6},{50,38,8},{38,40,10},{60,40,4}}) do sky.hline(d[1], d[2], d[3], P) end
  local sun = C.sun
  for y=22,35 do for x=30,58 do
    if ((x-44)^2 + ((y-36)*1.05)^2) <= 13.6^2 and not (y == 30 or y == 33 or y == 35) then sun.px(x, y, A) end
  end end
  sun.outline(K)
  for y=0,FH-1 do for x=0,FW-1 do
    if sun.get(x, y) ~= 0 and (x < 10 or x > 77 or y < 7 or y > 35) then sun.px(x, y, 0) end
  end end
  local fr = C.frame
  fr.rect(8, 5, 72, 2, M); fr.rect(8, 42, 72, 2, M); fr.rect(8, 5, 2, 39, M); fr.rect(78, 5, 2, 39, M)
  fr.rect(43, 7, 2, 35, M)
  fr.line(66, 41, 67, 30, K); fr.line(67, 30, 70, 20, K); fr.line(67, 41, 68, 30, K); fr.line(68, 30, 71, 20, K)
  fr.poly({70,19, 60,22, 58,26, 64,22}, K); fr.poly({71,19, 76,24, 77,28, 74,23}, K)
  fr.poly({70,19, 66,14, 60,14, 67,16}, K); fr.poly({71,19, 75,13, 77,12, 74,17}, K)
  fr.outline(K)
  fr.hline(10, 7, 68, K)
  -- decor: lopsided poster with a googly doodle, wonky clock, Memphis squiggle + triangle
  local d = C.decor
  d.poly({90,9, 116,7, 117,38, 91,39}, P)
  d.ellipse(134, 21, 8.1, 8.6, M, {0,0,1,0}, {0,1,0,0})
  d.poly({176,34, 188,24, 192,40}, T)
  d.outline(K)
  d.ellipse(99, 18, 3.1, 3.6, M); d.ellipse(108, 17, 4.1, 4.6, M)
  d.px(99, 19, K); d.px(99, 20, K); d.rect(108, 18, 2, 2, K)
  d.line(96, 25, 98, 27, K); d.hline(98, 27, 9, K); d.line(107, 27, 110, 24, K)
  L.text(d, 96, 31, "VIBE", M)
  d.px(91, 9, M); d.px(116, 8, M)
  d.line(134, 21, 134, 15, K); d.line(134, 21, 138, 23, K)
  for _, q in ipairs({{134,14},{141,21},{134,28},{127,21}}) do d.px(q[1], q[2], LINE) end
  for i=0,8 do local x = 150 + i*4; d.line(x, 12 + (i%2)*4, x+4, 12 + ((i+1)%2)*4, G); d.line(x, 13 + (i%2)*4, x+4, 13 + ((i+1)%2)*4, G) end
  for _, q in ipairs({{156,28},{166,34},{198,20},{150,40},{200,44}}) do d.rect(q[1], q[2], 2, 2, A) end
  -- cast at desks (H0 floor sprites), teal cubicle dividers, cactus in a pot
  local c = C.cast
  local function blit(img, x, y)
    for jj=0,31 do for ii=0,31 do local v = img:getPixel(ii, jj); if v ~= 0 then c.px(x+ii, y+jj, v) end end end
  end
  local fr2 = C.front
  for _, x in ipairs({38, 86, 134}) do
    fr2.poly({x, 92, x, 62, x+3, 60, x+10, 61, x+11, 92}, T)
  end
  fr2.poly({186,80, 202,80, 200,94, 188,94}, CO)
  fr2.ellipse(194, 68, 4.1, 12.1, G, {0,1,0,0,-1}, {0,0,1,0,0})
  fr2.ellipse(188, 70, 2.1, 4.1, G); fr2.ellipse(200, 64, 2.1, 4.1, G)
  fr2.outline(K)
  for _, x in ipairs({38, 86, 134}) do fr2.hline(x+1, 62, 9, M); fr2.vline(x+5, 66, 24, K) end
  for _, q in ipairs({{192,62},{196,70},{191,74},{197,60}}) do fr2.px(q[1], q[2], K) end
  fr2.hline(186, 84, 17, K)
  blit(floorSprite("lead", 1), 4, 64)
  blit(floorSprite("buddy", 2), 52, 64)
  blit(floorSprite("implement", 1), 100, 64)
  blit(floorSprite("review", 2), 148, 64)
  return done(spr, C, "floor-crop")
end

-- ---------- the sheet ----------
local busts = {
  { "REVIEW V1", "3-EYE PEAR", pear },
  { "REVIEW V2", "SOCK PUPPET", sock },
  { "LEAD V1", "CONE HEAD", cone },
}
for _, b in ipairs(busts) do b.rest = b[3]("rest"); b.yo = b[3]("yo") end
local faces = { riffbot("rest"), riffbot("yo"), overlord("rest"), overlord("yo") }
local crop = floorCrop()
local h0s = app.open(root.."/art/cast/hypno/sheet.aseprite")
local h0 = Image(h0s.width, h0s.height, ColorMode.INDEXED); h0:clear(0); h0:drawSprite(h0s, 1)
h0s:close()

local PAD, TOP = 6, 18
local LWc, BW = 50, 72
local RW = 232
local RX = PAD + h0.width + PAD + 4
local W = RX + RW + PAD
local H = TOP + 14 + 3*76 + 16 + 58 + 16 + 104 + PAD
H = math.max(H, TOP + 14 + h0.height + PAD)
local spr = L.new(W, H, pal.dark)
local C = L.canvas(spr, spr.layers[1], spr.frames[1])
C.rect(0, 0, W, H, PANEL)
for y=2,H-1,12 do for x=((y//12)%2)*8+2, W-1, 16 do
  C.px(x, y, PHI); C.px(x-1, y, PHI); C.px(x+1, y, PHI); C.px(x, y-1, PHI); C.px(x, y+1, PHI)
end end
C.rect(2, 2, W-4, 11, V)
C.hline(2, 2, W-4, M); C.hline(2, 12, W-4, K)
L.text(C, 6, 5, "H1 GALLERY.EXE - SAME HAND AS H0?", M)
for i=0,2 do L.plate(C, W-12-i*10, 4, 7, 7, M, M, LINE) end
C.hline(W-30, 9, 3, K)
C.rect(W-20, 6, 3, 3, K); C.rect(W-19, 7, 1, 1, M)
C.line(W-10, 6, W-8, 8, K); C.line(W-8, 6, W-10, 8, K)
local function blit(img, x, y)
  for j=0,img.height-1 do for i=0,img.width-1 do
    local v = img:getPixel(i, j); if v ~= 0 then C.px(x+i, y+j, v) end
  end end
end
local function well(x, y, w, h, fill)
  C.rect(x, y, w, h, fill or BGc)
  C.hline(x-1, y-1, w+1, K); C.vline(x-1, y-1, h+1, K)
  C.hline(x-1, y+h, w+2, M); C.vline(x+w, y-1, h+2, M)
end
local function head(x, y, w, s, c)
  L.plate(C, x, y, w, 11, LINE, M, K)
  L.text(C, x + (w - L.textW(s))//2, y+3, s, c or 5)
end
-- left: the canon itself
head(PAD, TOP, h0.width, "CANON: H0 CAST SHEET (THE GATE)", 5)
blit(h0, PAD, TOP + 14)
C.vline(RX - 5, TOP, H - TOP - 2, K); C.vline(RX - 4, TOP, H - TOP - 2, M)
-- right: H1 samples
local y = TOP
local cx1, cx2 = RX + LWc + PAD, RX + LWc + PAD + BW + PAD
head(RX, y, LWc, "H1 CAST")
head(cx1, y, BW, "REST")
head(cx2, y, BW, "NEEDS-YOU", P)
y = y + 16
for _, b in ipairs(busts) do
  L.plate(C, RX+1, y + 14, LWc-2, 26, LINE, M, K)
  L.text(C, RX + 4, y + 18, b[1], 5)
  C.hline(RX + 4, y + 24, L.textW(b[1]), P)
  L.text(C, RX + 4, y + 30, b[2], 6)
  well(cx1, y, BW, BW - 2); blit(b.rest, cx1 + 4, y + 2)
  well(cx2, y, BW, BW - 2); blit(b.yo, cx2 + 4, y + 2)
  y = y + 76
end
head(RX, y, RW, "FACES 48: RIFFBOT REST / YO   OVERLORD REST / YO")
y = y + 16
for i, f in ipairs(faces) do
  local x = RX + 2 + (i-1)*58 + (i > 2 and 2 or 0)
  well(x, y, 52, 52); blit(f, x + 2, y + 2)
end
y = y + 58
head(RX, y, RW, "FLOOR CROP 1X (H0 SPRITES AT DESKS)")
y = y + 16
well(RX + 12, y, 208, 100); blit(crop, RX + 12, y)
C.commit()
spr:saveAs(dir.."gallery.aseprite")

local function toRGB(img, p, Z)
  local r = Image(img.width*Z, img.height*Z, ColorMode.RGB)
  for j=0,img.height-1 do for i=0,img.width-1 do
    local c = p:getColor(img:getPixel(i, j))
    local v = app.pixelColor.rgba(c.red, c.green, c.blue, 255)
    for q=0,Z-1 do for o=0,Z-1 do r:drawPixel(i*Z+o, j*Z+q, v) end end
  end end
  return r
end
local sheet = Image(W, H, ColorMode.INDEXED); sheet:drawSprite(spr, 1)
for _, mode in ipairs({"dark", "light"}) do
  for _, z in ipairs({1, 3}) do
    local path = root.."/scratch/shots/h1-gallery-"..mode..(z == 3 and "-3x" or "")..".png"
    toRGB(sheet, pal[mode], z):saveAs(path)
    print("wrote "..path.." "..(W*z).."x"..(H*z))
  end
end
