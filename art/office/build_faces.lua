-- C2a sky-god faces, drawn from scratch at 48x48 in the H0 hand (art/cast/hypno/bust.lua):
-- chunky lopsided shapes with hand-picked points, one INK outline per layer, flat P0 fills,
-- features placed pixel by pixel. No gradients, no shading ramps, no noise.
--   RiffBot : the friendly computer-helper bot. Lopsided beige-box monitor head (SKIN casing),
--             violet screen face with mismatched googly eyes and an amber text-cursor glint,
--             floppy-slot mouth, mouse-cable hair ending in a plug, pink keycap bowtie.
--   Overlord: a looming digital AI face built from separate flat plates (crown, brows, nose
--             ridge, cheeks, lip, jaw) with teal wireframe rims on dark glass, pink slit eyes,
--             2-3 hand-placed scanline bars and a clean row shear as its glitch.
--             idle = plates drift apart and reassemble, talk = jaw pulses with a pink glow,
--             needs = snaps into focus (marble rims, wide eyes),
--             lookDown = upper plates slide down, eyes low: the face tilts toward the tower.
-- Frames: RiffBot lookDown, idle, blink, talk x3, needs x2. Overlord lookDown x2, idle x2,
-- blink, talk x3, needs x2.
-- Writes art/office/face-{riffbot,overlord}.aseprite (one frame per face, layered),
-- public/office/face-*-{dark,light}.png (one row of 48x48 cells) and faces.json.
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/build_faces.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local K, V, P, CO, A, S, M, T, G, Y = 15, 8, 9, 10, 11, 14, 4, 7, 12, 13
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local CW, CH = 48, 48
local LAYERS = { "bg", "cables", "body", "head", "cheeks", "face", "fx" }

-- "!" with an INK rim, hand stamped
local BANG = [[
|kkkk|
|kaak|
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

-- short "!" that fits the sky corner above RiffBot's monitor
local BANG_SHORT = [[
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

---------------------------------------------------------------- RiffBot
-- s = { look = "down"|"fwd"|"wide", blink, cursor, mouth = "shut"|"o"|"wide"|"eh"|"eject", needs, flash }
local function riff(C, s)
  -- sky glass: flat SKY (PINK on the needs flash); pink/violet twinkles (amber washes out on light sky)
  local g = C.bg
  g.rect(0, 0, CW, CH, s.flash and P or Y)
  L.twinkle(g, 4, 5, s.flash and M or P, nil, 1); L.twinkle(g, 44, 41, s.flash and M or V, nil, 1)
  g.px(3, 30, s.flash and M or V)
  -- mouse-cable hair: three chunky violet cables curling out of the top, one ends in a plug
  local c = C.cables
  c.line(13, 10, 10, 5, V); c.line(14, 10, 11, 5, V); c.line(10, 5, 7, 4, V); c.line(11, 4, 8, 3, V)
  c.line(7, 4, 6, 6, V)
  c.line(23, 9, 22, 3, V); c.line(24, 9, 23, 3, V); c.line(22, 3, 25, 1, V); c.line(23, 2, 26, 1, V)
  c.line(33, 9, 36, 4, V); c.line(34, 9, 37, 5, V)
  c.rect(36, 1, 4, 3, M)                                            -- plug
  c.outline(K)
  c.px(37, 0, K); c.px(39, 0, K)                                    -- prongs
  -- teal shoulders on a short violet monitor stand, pink keycap bowtie
  local b = C.body
  b.poly({3,49, 5,44, 13,41, 35,41, 43,44, 45,49}, T)
  b.rect(20, 37, 8, 5, V)
  b.outline(K)
  b.hline(20, 39, 8, K)
  b.rect(16, 41, 6, 5, P); b.rect(26, 41, 6, 5, P)                  -- keycaps
  b.hline(16, 41, 6, M); b.hline(26, 41, 6, M)                      -- key tops
  b.hline(15, 40, 8, K); b.hline(25, 40, 8, K); b.hline(15, 46, 8, K); b.hline(25, 46, 8, K)
  b.vline(15, 40, 7, K); b.vline(22, 40, 7, K); b.vline(25, 40, 7, K); b.vline(32, 40, 7, K)
  b.rect(23, 42, 2, 3, K)                                           -- knot
  b.px(18, 43, K); b.px(19, 44, K); b.px(29, 43, K)                 -- key legends
  -- beige-box monitor casing, lopsided (left side taller, chin sags right)
  local h = C.head
  h.poly({7,10, 23,8, 40,9, 43,12, 43,33, 40,37, 24,36, 9,37, 5,34, 5,13}, S)
  h.outline(K)
  h.px(8, 12, M); h.px(9, 12, M); h.px(8, 13, M)                    -- one shine tick
  h.rect(38, 31, 2, 2, s.needs and A or G)                          -- power LED
  h.rect(6, 29, 3, 2, CO); h.rect(40, 27, 2, 2, CO)                -- blush on the casing
  -- screen face
  local f = C.face
  f.poly({9,12, 38,11, 40,27, 10,28}, K)
  f.poly({10,13, 38,12, 39,26, 11,27}, V)
  if s.blink then
    f.line(13, 20, 21, 21, K); f.line(26, 19, 35, 20, K); f.px(13, 19, K); f.px(35, 19, K)
  else
    local lx, ly, rx, ry = 17, 19, 30, 18
    f.ellipse(lx, ly, 4.6, 5.0, K); f.ellipse(rx, ry, 5.4, 5.6, K)
    f.ellipse(lx, ly, 3.4, 3.9, M); f.ellipse(rx, ry, 4.3, 4.5, M)
    if s.look == "down" then
      -- heavy lids: violet screen over the top of each eye + an INK lid line, pupils at the bottom
      f.rect(lx-4, ly-5, 9, 4, V); f.hline(lx-3, ly-1, 7, K)
      f.rect(rx-5, ry-6, 11, 4, V); f.hline(rx-4, ry-2, 9, K)
      f.rect(lx-1, ly+1, 2, 2, K); f.rect(rx, ry+1, 3, 2, K)
      if s.cursor then f.vline(lx+1, ly+1, 2, A) end
    elseif s.look == "wide" then
      f.rect(lx-1, ly-1, 2, 2, K); f.rect(rx-1, ry-1, 2, 2, K)
    else
      f.rect(lx, ly-1, 2, 3, K); f.rect(rx-2, ry-2, 3, 3, K)
      if s.cursor then f.vline(lx+2, ly-1, 2, A) end
    end
  end
  if s.needs then f.line(12, 13, 19, 13, K); f.line(26, 12, 34, 12, K) end   -- brows jump to the bezel
  -- floppy-slot mouth on the casing
  local m = s.mouth
  if m == "shut" then
    f.hline(14, 31, 19, K); f.hline(15, 32, 17, K); f.px(31, 30, K); f.px(32, 30, K)
  elseif m == "o" then
    f.rect(20, 30, 8, 4, K); f.rect(21, 31, 6, 2, P)
  elseif m == "wide" then
    f.rect(13, 30, 21, 5, K); f.rect(14, 31, 19, 3, P); f.hline(15, 31, 4, M)
  elseif m == "eh" then
    f.rect(14, 30, 19, 3, K); f.hline(15, 31, 17, P)
  elseif m == "eject" then
    f.rect(14, 30, 19, 3, K)
    -- an amber floppy pops out of the slot (marble label, ink shutter), clear of the bowtie
    f.rect(18, 31, 11, 7, K); f.rect(19, 32, 9, 5, A); f.rect(20, 34, 7, 2, M); f.rect(22, 32, 3, 1, K)
  end
  if s.needs then C.fx.stamp(43, 0, BANG_SHORT) end
end

---------------------------------------------------------------- Overlord
-- plates: hand-picked points; d = drift direction (outward from the face centre),
-- tilt = how far the plate slides down on lookDown (top plates most), jaw = moves with the jaw
local PLATES = {
  { pts = {13,6, 24,2, 35,6, 33,11, 24,9, 15,11},          d = {0,-1},  tilt = 4 },  -- crown
  { pts = {6,15, 14,12, 22,14, 21,17, 9,18},               d = {-1,-1}, tilt = 4 },  -- brow L
  { pts = {26,14, 34,12, 42,14, 40,18, 27,17},             d = {1,-1},  tilt = 4 },  -- brow R
  { pts = {24,14, 26,19, 25,30, 23,30, 22,19},             d = {0,0},   tilt = 3 },  -- nose ridge
  { pts = {5,23, 20,25, 20,32, 11,35, 6,30},               d = {-1,0},  tilt = 2, cheek = true },  -- cheek L
  { pts = {28,25, 43,23, 42,30, 37,35, 28,32},             d = {1,0},   tilt = 2, cheek = true },  -- cheek R
  { pts = {14,34, 24,33, 34,34, 32,36, 16,36},             d = {0,0},   tilt = 1 },  -- lip
  { pts = {13,39, 24,38, 35,39, 31,44, 24,46, 17,44},      d = {0,1},   tilt = 0, jaw = true },
}
local function moved(pts, dx, dy)
  local o = {}
  for i = 1, #pts, 2 do o[i] = pts[i] + dx; o[i+1] = pts[i+1] + dy end
  return o
end
-- s = { drift, tilt, jaw, eyes = "low"|"mid"|"wide"|"shut", focus, glow, bars = {{x,y,w,c}...}, slip = {[plate] = {dx,dy}}, flash }
local function lord(C, s)
  local g = C.bg
  g.rect(0, 0, CW, CH, K)
  if s.flash then   -- alert flash: a pink frame round the glass (a pink fill drowns the plates)
    g.rect(0, 0, CW, 2, P); g.rect(0, CH-2, CW, 2, P); g.rect(0, 0, 2, CH, P); g.rect(CW-2, 0, 2, CH, P)
  end
  for _, br in ipairs(s.bars or {}) do g.hline(br[1], br[2], br[3], br[4]) end
  -- plates on one layer; gaps stay open, then every plate gets a wireframe rim
  -- cheeks sit on their own layer so their top edge (right under the eyes) stays unlit
  local h, ch = C.head, C.cheeks
  local drift, tilt, jaw = s.drift or 0, s.tilt or 0, s.jaw or 0
  local rim = s.focus and M or T
  for i, pl in ipairs(PLATES) do
    local dx, dy = pl.d[1] * drift, pl.d[2] * drift
    dy = dy + (pl.tilt * tilt) // 2 + (pl.jaw and jaw or 0)
    local sl = s.slip and s.slip[i]                                  -- glitch: a whole plate jumps
    if sl then dx, dy = dx + sl[1], dy + sl[2] end
    ;(pl.cheek and ch or h).poly(moved(pl.pts, dx, dy), V)
  end
  h.edge(V, rim)
  local set = {}
  for y = 0, CH-1 do for x = 0, CW-1 do
    if ch.get(x, y) == V and (ch.get(x-1, y) == 0 or ch.get(x+1, y) == 0 or ch.get(x, y+1) == 0) then set[#set+1] = {x, y} end
  end end
  for _, q in ipairs(set) do ch.px(q[1], q[2], rim) end
  -- eyes: solid amber wedges, the brightest thing on the face (no pupil)
  local f = C.face
  local ey = 20 + 2 * tilt - drift
  if s.eyes == "shut" then
    f.hline(10, ey+2, 10, A); f.hline(28, ey+2, 10, A)
  elseif s.eyes == "low" then          -- slanted down toward the tower
    f.poly({9,ey, 21,ey+2, 19,ey+5, 12,ey+4}, A)
    f.poly({27,ey+2, 39,ey, 36,ey+4, 29,ey+5}, A)
  elseif s.eyes == "wide" then         -- snapped open, marble-hot core
    f.poly({9,ey-1, 21,ey, 20,ey+5, 11,ey+5}, A)
    f.poly({27,ey, 39,ey-1, 37,ey+5, 28,ey+5}, A)
    f.rect(14, ey+1, 3, 3, M); f.rect(31, ey+1, 3, 3, M)
  else
    f.poly({9,ey, 21,ey+1, 19,ey+4, 11,ey+4}, A)
    f.poly({27,ey+1, 39,ey, 37,ey+4, 29,ey+4}, A)
  end
  -- mouth glow between lip and jaw when it talks / yells
  if (s.glow or 0) > 0 then
    local my = 37 + tilt // 2
    f.rect(17, my, 14, s.glow, P); f.hline(20, my + s.glow // 2, 8, M)
  end
  if s.focus then C.fx.stamp(43, s.flash and 2 or 4, BANG) end
end

---------------------------------------------------------------- build + export
local function flat(spr, frame)
  local img = Image(spr.width, spr.height, ColorMode.INDEXED)
  img:clear(0)
  img:drawSprite(spr, frame)
  return img
end

local function sheet(name, draw, frames)
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
  spr:saveAs(root.."/art/office/face-"..name..".aseprite"); spr:close()
  for _, mode in ipairs({"dark", "light"}) do
    local out = Sprite(CW*N, CH, ColorMode.INDEXED)
    out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
    out.transparentColor = 0
    out.cels[1].image = img
    out:saveAs(root.."/public/office/face-"..name.."-"..mode..".png"); out:close()
  end
  print("wrote face-"..name.." "..N.." frames")
  local parts = {}
  for _, tag in ipairs(order) do parts[#parts+1] = '"'..tag..'":['..table.concat(js[tag], ",")..']' end
  return '{'..table.concat(parts, ",")..'}'
end

local function F(tag, s) return { tag = tag, s = s } end
local rj = sheet("riffbot", riff, {
  F("lookDown", { look = "down", mouth = "shut", cursor = true }),
  F("idle",     { look = "fwd",  mouth = "shut", cursor = true }),
  F("blink",    { blink = true,  mouth = "shut" }),
  F("talk",     { look = "fwd",  mouth = "o" }),
  F("talk",     { look = "fwd",  mouth = "wide", cursor = true }),
  F("talk",     { look = "fwd",  mouth = "eh" }),
  F("needs",    { look = "wide", mouth = "eject", needs = true }),
  F("needs",    { look = "wide", mouth = "eject", needs = true, flash = true }) })
local oj = sheet("overlord", lord, {
  F("lookDown", { tilt = 1, eyes = "low", bars = {{3,9,5,T},{38,41,4,V}} }),
  F("lookDown", { tilt = 1, eyes = "low", drift = 1, bars = {{40,6,4,T},{4,43,6,V}} }),
  F("idle",     { eyes = "mid", drift = 1, bars = {{3,8,5,T},{39,40,4,V}} }),
  F("idle",     { eyes = "mid", bars = {{41,5,3,V},{2,42,5,T}}, slip = {[1] = {1,0}, [8] = {-1,0}} }),
  F("blink",    { eyes = "shut", bars = {{3,8,5,T}} }),
  F("talk",     { eyes = "mid", jaw = 1, glow = 1, bars = {{3,8,5,T}} }),
  F("talk",     { eyes = "mid", jaw = 3, glow = 3, drift = 1, bars = {{40,6,4,V}}, slip = {[5] = {-1,0}, [6] = {1,0}, [8] = {-1,1}} }),
  F("talk",     { eyes = "mid", jaw = 2, glow = 2, bars = {{4,42,5,T}} }),
  F("needs",    { eyes = "wide", focus = true, jaw = 2, glow = 2 }),
  F("needs",    { eyes = "wide", focus = true, jaw = 2, glow = 2, flash = true }) })
local json = '{"version":1,"cell":{"w":'..CW..',"h":'..CH..'},"fps":3,\n "riffbot":'..rj..',\n "overlord":'..oj..'}\n'
local f = io.open(root.."/public/office/faces.json", "wb"); f:write(json); f:close()
print("wrote faces.json")
