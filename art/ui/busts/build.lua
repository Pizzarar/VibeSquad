-- B13e Normal-mode mascot busts: permanent canon 64x64 icons, one per role, transparent outside
-- the character so they sit in Normal mode's rounded avatar tiles (22/42/48/68px).
-- Hand: H0 (docs/art/STYLE_BIBLE.md, art/cast/hypno/lib.lua): 1px INK outline per layer, flat P0
-- fills, googly lopsided MARBLE eyes, hand-placed shapes, no dither, no generated imagery.
--   overlord : canon outlined brain-jar TV (art/h1/gallery.lua overlord(), art/office/faces/faces-h1c.lua
--              OVER): lumpy PINK brain with VIOLET C-folds filling the top of a SKY glass jar, 2
--              lopsided googly eyeballs hanging on short CORAL nerve tails, floating teeth with the
--              AMBER gold tooth, AMBER jar collar on a VIOLET TV cabinet cut by the bottom edge.
--   riffbot  : canon headshot (faces-h1c.lua riff(), idle frame) re-cut to 64x64: boxy CRT head with
--              bent rabbit ears, TEAL screen + MINT scanlines, googly eyes, stock-arrow grin mouth,
--              VIOLET suit shoulders with PINK tie flush to row 63.
--   bugs     : canon Hypnospace roach (art/ui/bug-roach/roach.lua) as a bust: CORAL wing carapace,
--              AMBER pronotum + TEAL tie, VIOLET head and too many VIOLET legs, googly MARBLE eyes
--              on CORAL antenna stalks (big one high-left, as in the chip).
--   buddy / lead / worker : flattened from the canon H0/S2 busts (art/cast/hypno/*-bust.aseprite)
--              with the floating `fx` twinkle layer hidden. mech = alias of worker.
-- Writes art/ui/busts/<role>.aseprite (INDEXED, layered) and public/ui/busts/<role>.png (dark) +
-- <role>-light.png (pure P0 palette swap), both 64x64 RGBA. busts.json is written by
-- art/ui/busts/manifest.mjs (node).
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/ui/busts/build.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local dir = root.."/art/ui/busts/"
local out = root.."/public/ui/busts/"
local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }
local K, V, P, CO, A, S, M, T, G, Y, LN = 15, 8, 9, 10, 11, 14, 4, 7, 12, 13, 3
local N = 64

local function mk(names)
  local spr = L.new(N, N, pal.dark)
  local t = {}
  for _, n in ipairs(names) do t[n] = L.canvas(spr, L.layer(spr, n), spr.frames[1]) end
  return spr, t
end
local function flat(spr)
  local img = Image(N, N, ColorMode.INDEXED); img:clear(0); img:drawSprite(spr, 1)
  return img
end
-- export a flat indexed image as 64x64 RGBA PNG, dark + light palette
local function export(img, role)
  for _, mode in ipairs({ "dark", "light" }) do
    local s = Sprite(N, N, ColorMode.INDEXED)
    s:setPalette(pal[mode]); s.transparentColor = 0
    s.cels[1].image = img
    app.activeSprite = s
    app.command.ChangePixelFormat{ format = "rgb" }
    s:saveCopyAs(out..role..(mode == "light" and "-light" or "")..".png")
    s:close()
  end
end
local function finish(spr, t, role)
  for _, c in pairs(t) do c.commit() end
  spr:saveAs(dir..role..".aseprite")
  local img = flat(spr)
  spr:close()
  export(img, role)
  print("wrote "..role)
end

-- shared face language (same as faces-h1c.lua / gallery.lua)
local function eyes(C, list) for _, e in ipairs(list) do C.ellipse(e[1], e[2], e[3], e[4], M) end; C.outline(K) end
local function pupil(C, x, y, w, h) C.rect(x, y, w or 2, h or 3, K); C.px(x, y, M) end
local function shift(C, dx, dy)                    -- draw canon coordinates into a re-cut cell
  local px = C.px
  C.px = function(x, y, c) px(x + dx, y + dy, c) end
  return function() C.px = px end
end

-- ---------------------------------------------------------------- Overlord
local JX0, JX1, JY0, JY1, JR = 5, 58, 2, 50, 12    -- glass jar interior box, top corner radius
local function inJar(x, y)
  if x < JX0 or x > JX1 or y < JY0 or y > JY1 then return false end
  local r = (y < JY0 + JR) and JR or ((y > JY1 - 3) and 3 or 0)
  if r == 0 then return true end
  local cy = (y < JY0 + JR) and (JY0 + r) or (JY1 - r)
  local cx = (x < (JX0 + JX1) / 2) and (JX0 + r) or (JX1 - r)
  if (x < JX0 + r or x > JX1 - r) then return (x - cx)^2 + (y - cy)^2 <= r * r + r end
  return true
end
-- lumpy brain = union of lobes {cx, cy, r, fold arc start angle}; C-shaped VIOLET gyri ring each
local LOBES = {
  {13, 12, 8, 0.6}, {22, 7, 9, 2.2}, {33, 6, 9, 4.0}, {43, 8, 9, 1.0}, {52, 13, 8, 3.1},
  {17, 15, 5.4, 5.0}, {27, 14, 5.4, 1.6}, {38, 14, 5.4, 3.6}, {48, 15, 5.4, 0.2},
}
local function overlord()
  local spr, C = mk({ "cabinet", "jar", "bubbles", "brain", "eyeL", "eyeR", "teeth", "collar", "glass" })
  -- VIOLET TV cabinet under the jar, cut by the bottom edge
  local cb = C.cabinet
  cb.poly({1,64, 2,56, 6,53, 57,53, 61,55, 63,64}, V)
  cb.outline(K)
  for y=57,61,2 do cb.hline(6, y, 8, K) end                                    -- speaker slots
  cb.ellipse(49, 58.5, 2.2, 2.2, A); cb.ellipse(56, 58.5, 2.2, 2.2, P)          -- dials
  cb.px(49, 56, K); cb.px(56, 57, K)
  cb.px(30, 60, M); cb.px(31, 60, M); cb.px(33, 60, A)                          -- power light
  -- glass jar: SKY water, 1px INK rim
  local j = C.jar
  for y=0,N-1 do for x=0,N-1 do if inJar(x, y) then j.px(x, y, Y) end end end
  j.outline(K)
  -- bubbles rising in the clear water (LINE rings, light surreal touch)
  local bu = C.bubbles
  bu.px(9, 38, LN); bu.px(8, 39, LN); bu.px(10, 39, LN); bu.px(9, 40, LN)
  bu.px(54, 42, LN); bu.px(11, 46, LN); bu.px(51, 35, LN)
  -- brain
  local br = C.brain
  for _, l in ipairs(LOBES) do br.ellipse(l[1], l[2], l[3], l[3] - 0.4, P) end
  br.outline(K)
  for _, l in ipairs(LOBES) do                     -- C-shaped fold inside each lobe
    local rr = l[3] * 0.5
    for i=0,40 do
      local a = l[4] + i / 40 * 3.9
      local x, y = math.floor(l[1] + rr * math.cos(a) + 0.5), math.floor(l[2] + rr * 0.9 * math.sin(a) + 0.5)
      if br.get(x, y) == P then br.px(x, y, V) end
    end
  end
  br.line(32, 2, 33, 7, K); br.line(33, 7, 32, 12, K); br.line(32, 12, 33, 16, K)  -- crooked cleft
  for y=0,N-1 do for x=0,N-1 do if not inJar(x, y) then br.img:drawPixel(x, y, 0) end end end -- the glass crops it
  -- googly eyeballs hanging on short CORAL nerve tails (left smaller, right bigger + higher)
  local function eyeball(Cc, cx, cy, r, hook, top, look, veins)
    local ty = math.ceil(cy - r)
    for _, o in ipairs({0, 1}) do
      Cc.line(cx + o, ty + 1, cx + hook + o, ty - 2, CO); Cc.line(cx + hook + o, ty - 2, cx + o, top, CO)
    end
    Cc.ellipse(cx, cy, r, r, M)
    for _, v in ipairs(veins) do Cc.line(cx + v[1], cy + v[2], cx + v[3], cy + v[4], P) end
    local ix, iy = cx + look[1], cy + look[2]
    Cc.ellipse(ix, iy, r * 0.48, r * 0.48, T)
    Cc.rect(ix - 1, iy - 1, 3, 3, K); Cc.px(ix - 1, iy - 1, M)
    Cc.outline(K)
  end
  eyeball(C.eyeL, 19, 32, 5.8, 1, 19, {2, 1}, {{-6,-1,-4,0}, {5,3,3,2}})
  eyeball(C.eyeR, 43, 30, 7.2, -1, 19, {-2, 0}, {{-7,-2,-5,-1}, {6,-3,4,-2}, {5,4,3,3}})
  -- floating chunky teeth, AMBER gold tooth
  local te = C.teeth
  te.rect(25, 40, 15, 1, P); te.rect(23, 41, 19, 1, P)                          -- upper gum
  te.rect(24, 42, 17, 2, M); te.rect(34, 42, 3, 2, A)                           -- upper teeth + gold
  te.rect(24, 45, 17, 2, M)                                                     -- lower teeth
  te.rect(24, 47, 17, 1, P)                                                     -- lower gum
  te.outline(K)
  for i=0,3 do te.vline(26 + i*4, 42, 1, K) end
  for i=0,3 do te.vline(27 + i*4, 46, 1, K) end
  te.px(34, 42, M)                                                              -- gold glint
  -- AMBER jar collar / bezel on the cabinet, INK rivets
  local co = C.collar
  co.rect(4, 50, 56, 3, A); co.outline(K)
  for _, x in ipairs({8, 22, 41, 55}) do co.px(x, 51, K) end
  co.hline(6, 50, 6, M)
  -- glass glints (on top of everything inside the jar)
  local gl = C.glass
  gl.vline(7, 15, 12, M); gl.vline(8, 11, 3, M); gl.px(9, 9, M)
  gl.px(55, 26, M); gl.vline(56, 28, 4, M)
  finish(spr, C, "overlord")
end

-- ---------------------------------------------------------------- RiffBot
-- canon 80x48 headshot, shifted dx -8 / dy +10, shoulders extended to row 63
local function riffbot()
  local spr, C = mk({ "suit", "tie", "body", "screen", "face", "mouth", "prop" })
  local DX, DY = -8, 10
  local su = C.suit
  su.poly({0,64, 0,58, 1,53, 7,49, 22,47, 42,47, 57,49, 63,53, 64,58, 64,64}, V)
  su.outline(K)
  su.poly({24,47, 40,47, 35,64, 29,64}, M)                                      -- shirt V
  su.line(24, 47, 29, 53, K); su.line(40, 47, 35, 53, K)                        -- collar points
  su.line(23, 47, 29, 63, K); su.line(41, 47, 35, 63, K)                        -- lapels
  su.line(10, 51, 11, 63, K); su.line(54, 51, 53, 63, K)                        -- sleeve seams
  su.hline(47, 53, 4, M); su.px(48, 52, P); su.px(49, 52, P)                    -- pocket square
  local ti = C.tie
  ti.rect(30, 47, 4, 3, P); ti.poly({30,51, 34,51, 35,64, 29,64}, P)
  ti.outline(K)
  for y=0,N-1 do for x=0,N-1 do                    -- outline must not frame the bottom edge cut
    if ti.get(x, y) == K and y >= 62 and ti.get(x, y-1) ~= K and x > 28 and x < 36 then ti.px(x, y, P) end
  end end
  -- cabinet (canon coordinates)
  local b = C.body; local r = shift(b, DX, DY)
  b.poly({22,8, 39,6, 58,7, 60,21, 59,34, 41,35, 21,34, 20,20}, M)
  b.poly({21,31, 59,31, 59,34, 41,35, 21,34}, CO)
  r(); b.outline(K); r = shift(b, DX, DY)
  b.hline(21, 30, 39, K)
  for x=24,57,4 do b.px(x, 33, A) end
  r()
  local sc = C.screen; r = shift(sc, DX, DY)
  sc.rect(24, 9, 26, 20, K); sc.rect(25, 10, 24, 18, T)
  for y=11,27,4 do sc.hline(26, y, 22, G) end
  sc.ellipse(54, 12, 2.2, 2.2, P); sc.ellipse(54, 18, 2.2, 2.2, A)
  for y=22,26,2 do sc.hline(52, y, 5, K) end
  sc.px(54, 10, K); sc.px(54, 16, K)
  r()
  local f = C.face; r = shift(f, DX, DY)
  eyes(f, {{31, 15, 3.1, 3.6}, {41, 14, 3.6, 4.6}})
  pupil(f, 30, 15); pupil(f, 42, 13)
  r()
  -- stock-arrow grin (GRIN): 2px MARBLE zig-zag up-arrow, 1px INK outline
  local m = C.mouth; r = shift(m, DX, DY)
  local pts = {27,23, 30,26, 34,23, 37,25, 41,23}
  for i=1,#pts-2,2 do m.line(pts[i], pts[i+1], pts[i+2], pts[i+3], M); m.line(pts[i], pts[i+1]+1, pts[i+2], pts[i+3]+1, M) end
  m.poly({39,21, 47,19, 44,26}, M)
  r(); m.outline(K)
  -- bent rabbit ears with PINK tips (taller in the square cell)
  local p = C.prop
  p.rect(28, 15, 9, 2, K)
  p.line(28, 15, 19, 5, K); p.line(36, 15, 40, 10, K); p.line(40, 10, 47, 4, K)
  p.rect(18, 4, 2, 2, P); p.rect(47, 3, 2, 2, P)
  finish(spr, C, "riffbot")
end

-- ---------------------------------------------------------------- Bugs (roach)
local function bugs()
  local spr, C = mk({ "legs", "wings", "pronotum", "head", "stalks", "eyes" })
  -- too many VIOLET legs, bent, 2px, flanking the torso
  local lg = C.legs
  local LEGS = { {14,36, 7,33, 3,37}, {12,46, 5,43, 1,48}, {14,56, 6,55, 2,61},
                 {50,36, 57,32, 61,36}, {52,46, 59,44, 63,49}, {50,56, 58,54, 62,60} }
  for _, l in ipairs(LEGS) do
    for o=0,1 do lg.line(l[1], l[2]+o, l[3], l[4]+o, V); lg.line(l[3], l[4]+o, l[5], l[6]+o, V) end
  end
  lg.outline(K)
  -- glossy CORAL wing carapace, INK seam, AMBER sheen streak, MARBLE glint
  local w = C.wings
  w.poly({15,40, 49,40, 52,52, 51,64, 13,64, 12,52}, CO)
  w.outline(K)
  w.vline(32, 40, 24, K); w.px(31, 62, K); w.px(33, 63, K)
  w.line(18, 44, 20, 60, A); w.line(19, 44, 21, 60, A)                          -- sheen
  w.line(44, 45, 45, 52, A)
  w.rect(18, 43, 2, 2, M); w.px(44, 44, M)                                      -- glints
  -- AMBER pronotum shield with a crisp TEAL tie
  local pr = C.pronotum
  pr.ellipse(32, 36, 17, 5.6, A, {0,0,-1,0,0,0,0,0,0,0,0,0}, {0,1,0,0,0,0,0,0,0,0,0,0})
  pr.outline(K)
  pr.rect(30, 32, 4, 3, T); pr.poly({30,35, 34,35, 35,44, 32,47, 29,44}, T)      -- tie (runs onto the wings)
  pr.px(31, 32, M)
  pr.hline(19, 35, 3, M); pr.px(45, 36, M)                                      -- shoulder shine
  for y=0,N-1 do for x=0,N-1 do                   -- re-outline the tie tip over the wing seam
    if pr.get(x, y) == T and y > 40 then
      for _, d in ipairs({{-1,0},{1,0},{0,1}}) do if pr.get(x+d[1], y+d[2]) == 0 then pr.px(x+d[1], y+d[2], K) end end
    end
  end end
  -- VIOLET head with a small lopsided smile + mandibles
  local h = C.head
  h.ellipse(32, 27, 9.2, 5.8, V, {0,-1,0,0,0,0,0,0,1,0,0,0}, {0,0,1,0,0,0,0,0,0,-1,0,0})
  h.outline(K)
  h.line(28, 28, 29, 29, K); h.hline(30, 30, 4, K); h.line(34, 30, 36, 28, K)
  h.px(31, 31, P); h.px(32, 31, P)
  h.px(26, 26, CO); h.px(27, 26, CO); h.px(38, 26, CO)                          -- blush
  h.px(29, 33, K); h.px(30, 34, K); h.px(35, 33, K); h.px(34, 34, K)            -- mandibles
  -- CORAL antenna stalks rising to the eyes
  local st = C.stalks
  for o=0,1 do st.line(28 + o, 22, 19 + o, 13, CO); st.line(36 + o, 22, 43 + o, 12, CO) end
  st.outline(K)
  -- googly MARBLE eyes: big one high-left, smaller one right (as in the chip)
  local e = C.eyes
  eyes(e, {{16, 9, 7.2, 7.6}, {45, 10, 5.2, 5.6}})
  e.ellipse(18, 10, 3.2, 3.2, T); e.rect(17, 9, 3, 3, K); e.px(17, 9, M)
  e.ellipse(44, 11, 2.2, 2.2, T); e.rect(43, 10, 2, 2, K); e.px(43, 10, M)
  e.line(10, 5, 12, 6, P); e.line(21, 13, 22, 15, P)                            -- veins
  finish(spr, C, "bugs")
end

-- ---------------------------------------------------------------- canon cast busts (fx hidden)
local function canon(src, role)
  local s = app.open(root.."/art/cast/hypno/"..src.."-bust.aseprite")
  for _, l in ipairs(s.layers) do if l.name == "fx" then l.isVisible = false end end
  local img = flat(s)
  s:saveAs(dir..role..".aseprite")                -- layered copy, fx hidden (canon file untouched)
  s:close()
  export(img, role)
  print("wrote "..role.." from "..src)
  return img
end

overlord()
riffbot()
bugs()
canon("buddy", "buddy")
canon("lead", "lead")
local wk = canon("mechanical", "worker")
export(wk, "mech")
