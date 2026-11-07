-- Contract v2 CRT faces (C1): the two Squad bots on the big roof TVs. INDEXED (P0), hand-placed shapes.
-- One cell = the TV glass (screens.* in floor.json) = 128x96. Frames sit in one row per bot.
--   RiffBot  (Hypnospace cast vibe): goofy guy with a quiff + headphones, googly eyes, a big mouth.
--            idle, blink, talk x3 (o / wide / eh), needs x2 (brows up + "!" bounce, pink flash).
--   Overlord (glitchy TV static, vibe only): a robot head MADE of static on a dark tube, visor brow,
--            slit eyes, an oscilloscope mouth; scanlines on every odd row, horizontal glitch offsets on
--            talk. idle x2 (scan + roll bar), blink, talk x3, needs x2 (amber alert / pink inverted flash).
-- Static noise is a fixed hash of (x, y, frame) over P0 slots only, so it is reproducible.
-- Writes art/office/face-{riffbot,overlord}.aseprite, public/office/face-*-{dark,light}.png, faces.json.
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/build_faces.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local K = { k=15, v=8, p=9, c=10, a=11, s=14, m=4, t=7, g=12, y=13, l=3, h=2, n=1 }
local pal = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" }
local CW, CH = 128, 96

local function hash(x, y, s)
  local v = (x * 73856093) ~ (y * 19349663) ~ (s * 83492791)
  v = (v ~ (v >> 13)) * 1274126177
  return ((v ~ (v >> 16)) & 0xffff) / 65536
end

-- new 128x96 canvas on a scratch sprite
local function cell()
  local s = L.new(CW, CH, pal)
  return L.canvas(s, s.layers[1], s.frames[1]), s
end

-- shift rows y0..y1 by dx (wrap) as one clean slice; sparse 1px pink/teal tear lines on its top/bottom edge
local function glitch(c, y0, y1, dx)
  for y=y0, y1 do
    local row = {}
    for x=0, CW-1 do row[x] = c.get(x, y) end
    for x=0, CW-1 do c.px(x, y, row[(x - dx) % CW]) end
  end
  for x=0, CW-1, 2 do
    if hash(x, y0, dx) < 0.6 then c.px(x, y0, L.PINK) end
    if hash(x, y1, -dx) < 0.6 then c.px(x + 1, y1, L.TEAL) end
  end
end

-- =============================== RiffBot ===============================
local function riff(kind, n)
  local c, s = cell()
  local needs = kind == "needs"
  local dy = (needs and n == 2) and -3 or 0
  -- Hypnospace tiled background: violet with pink sparkles + mint squiggles (pink on the needs flash)
  local base, a1, a2 = L.VIOLET, L.PINK, L.MINT
  if needs and n == 2 then base, a1, a2 = L.PINK, L.AMBER, L.MARBLE end
  c.rect(0, 0, CW, CH, base)
  for ty=0, CH-1, 16 do for tx=0, CW-1, 16 do
    local ox = ((ty//16) % 2) * 8
    local x, y = tx + ox + 3, ty + 4
    L.twinkle(c, x, y, a1, L.MARBLE, 1)
    c.px(x+7, y+7, a2); c.px(x+8, y+6, a2); c.px(x+9, y+7, a2); c.px(x+10, y+6, a2)
  end end
  -- shoulders: loud aloha shirt
  c.ellipse(64, 106+dy, 47, 24, L.INK)
  c.ellipse(64, 106+dy, 45, 22, L.TEAL)
  for _, f in ipairs({{32,90},{50,94},{80,92},{98,89},{40,99},{90,99}}) do
    c.px(f[1], f[2]+dy, L.AMBER); L.twinkle(c, f[1], f[2]+dy, L.PINK, L.AMBER, 1)
  end
  c.poly({52, 84+dy, 76, 84+dy, 64, 96+dy}, L.INK); c.poly({54, 85+dy, 74, 85+dy, 64, 95+dy}, L.MARBLE)
  c.rect(58, 78+dy, 13, 10, L.INK); c.rect(59, 78+dy, 11, 9, L.SKIN); c.hline(59, 79+dy, 11, L.CORAL)
  c.poly({55, 85+dy, 73, 85+dy, 64, 92+dy}, L.SKIN)
  -- head
  c.ellipse(64, 50+dy, 32, 34, L.INK)
  c.ellipse(64, 50+dy, 30, 32, L.SKIN)
  for y=60, 82 do for x=86, 94 do if c.get(x, y+dy) == L.SKIN and (x + y) % 2 == 0 then c.px(x, y+dy, L.CORAL) end end end
  -- headphone band: an ink/mint/ink arc over the crown (upper half only; the quiff covers its middle)
  for y=0, 34+dy do for x=24, 104 do
    local o = ((x-64)/37)^2 + ((y-34-dy)/33)^2
    local i = ((x-64)/34)^2 + ((y-34-dy)/30)^2
    if o <= 1 and i > 1 then c.px(x, y, (((x-64)/35.5)^2 + ((y-34-dy)/31.5)^2 > 1) and L.INK or L.MINT) end
    if o <= 1 and i > 1 and (((x-64)/36.3)^2 + ((y-34-dy)/32.3)^2 > 1 or ((x-64)/34.7)^2 + ((y-34-dy)/30.7)^2 <= 1) then c.px(x, y, L.INK) end
  end end
  -- quiff: big amber swoop up and over to the right, coral shade, marble shine
  local Q = {34,34, 30,20, 40,6, 62,0, 88,2, 104,10, 96,18, 92,30, 80,22, 60,24, 44,30}
  local Qi = {36,32, 33,20, 42,8, 62,2, 86,4, 100,10, 93,17, 90,27, 80,20, 60,22, 44,28}
  local Qs = {44,26, 60,20, 80,18, 88,24, 86,14, 66,12, 50,16}
  local function off(t) local o = {} for k=1,#t do o[k] = t[k] + ((k % 2 == 0) and dy or 0) end return o end
  c.poly(off(Q), L.INK); c.poly(off(Qi), L.AMBER); c.poly(off(Qs), L.CORAL)
  c.line(48, 10+dy, 70, 5+dy, L.MARBLE); c.line(50, 11+dy, 66, 8+dy, L.MARBLE)
  for _, ex in ipairs({30, 98}) do
    c.ellipse(ex, 52+dy, 9, 12, L.INK); c.ellipse(ex, 52+dy, 7, 10, L.PINK)
    c.ellipse(ex + (ex < 64 and -2 or 2), 52+dy, 3, 7, L.CORAL)
    c.vline(ex + (ex < 64 and -4 or 4), 46+dy, 4, L.MARBLE)
  end
  c.rect(26, 24+dy, 4, 18, L.INK); c.rect(98, 24+dy, 4, 18, L.INK)
  c.vline(27, 25+dy, 16, L.MINT); c.vline(99, 25+dy, 16, L.MINT)
  -- brows (raised + arched on needs, bob up on the wide talk)
  local by = 34 + dy
  if needs then by = by - 5 elseif kind == "talk" and n == 2 then by = by - 2 end
  if needs then
    c.poly({41, by+3, 47, by-2, 60, by+1, 60, by+4, 47, by+1, 42, by+5}, L.INK)
    c.poly({68, by+1, 81, by-2, 88, by+3, 87, by+5, 81, by+1, 68, by+4}, L.INK)
  else
    c.poly({41, by+2, 58, by-1, 60, by+2, 43, by+5}, L.INK)
    c.poly({68, by+1, 86, by-1, 88, by+3, 69, by+4}, L.INK)
  end
  -- googly eyes (mismatched on purpose)
  local eyes = { {52, 47, 9, 10}, {77, 46, 10, 11} }
  for i, e in ipairs(eyes) do
    local ex, ey, rx, ry = e[1], e[2]+dy, e[3], e[4]
    if needs then ry = ry + 2; ey = ey - 1 end
    if kind == "blink" then
      c.line(ex-rx+1, ey+1, ex, ey+4, L.INK); c.line(ex, ey+4, ex+rx-1, ey+1, L.INK)
      c.line(ex-rx+1, ey+2, ex, ey+5, L.INK); c.line(ex, ey+5, ex+rx-1, ey+2, L.INK)
    else
      c.ellipse(ex, ey, rx+1, ry+1, L.INK); c.ellipse(ex, ey, rx, ry, L.MARBLE)
      c.hline(ex-rx+3, ey+ry-1, 2*rx-5, L.LINE)
      local px, py, pr = ex + (i == 1 and 3 or -3), ey + 2, 4
      if needs then px, py, pr = ex, ey, 3 end
      if kind == "talk" and n == 3 then px = px + 2 end
      c.ellipse(px, py, pr, pr, L.INK)
      c.px(px-1, py-2, L.MARBLE); c.px(px-2, py-1, L.MARBLE)
    end
  end
  -- nose + blush
  c.ellipse(64, 59+dy, 5, 4, L.INK); c.ellipse(64, 58+dy, 4, 3, L.CORAL); c.px(62, 57+dy, L.MARBLE)
  for _, bx in ipairs({42, 86}) do
    for y=-2, 2 do for x=-5, 5 do if (x + y) % 2 == 0 and x*x/25 + y*y/4 <= 1 then c.px(bx+x, 64+dy+y, L.PINK) end end end
  end
  -- the big mouth
  local my = 70 + dy
  local function teeth(x0, x1, y) c.hline(x0, y, x1-x0+1, L.MARBLE); c.hline(x0, y+1, x1-x0+1, L.MARBLE) end
  -- D-shaped open mouth: flat 1px top lip, half-ellipse bottom (rows y0..y0+ry), half width hw
  local function dmouth(y0, hw, ry)
    for y=y0, y0+ry do
      local w = math.floor(hw*math.sqrt(math.max(0, 1 - ((y-y0)/(ry+0.5))^2)) + 0.5)
      c.hline(64-w, y, 2*w+1, L.INK)
    end
  end
  if kind == "idle" or kind == "blink" then           -- friendly open grin, corners turned up
    dmouth(my-2, 16, 7)
    c.hline(52, my-1, 25, L.MARBLE)
    c.ellipse(64, my+3, 7, 2, L.PINK)
    c.px(47, my-3, L.INK); c.px(46, my-4, L.INK); c.px(81, my-3, L.INK); c.px(82, my-4, L.INK)
  elseif kind == "talk" and n == 1 then              -- "o"
    c.ellipse(64, my+1, 9, 8, L.INK); c.ellipse(64, my+5, 6, 3, L.PINK)
    c.hline(59, my-5, 11, L.MARBLE)
  elseif kind == "talk" and n == 2 then              -- WIDE
    dmouth(my-1, 20, 12)
    teeth(48, 80, my)
    c.ellipse(64, my+8, 11, 3, L.PINK); c.hline(61, my+6, 7, L.CORAL)
  elseif kind == "talk" then                         -- "eh"
    c.ellipse(64, my, 17, 6, L.INK)
    teeth(51, 77, my-4); c.ellipse(64, my+3, 8, 2, L.PINK)
  elseif needs then                                  -- "!?" o-mouth
    c.ellipse(64, my+2, 8, 9, L.INK); c.ellipse(64, my+6, 5, 3, L.PINK)
  end
  -- needs: a big "!" + shock ticks
  if needs then
    local bx = (n == 1) and 108 or 110
    local byy = (n == 1) and 8 or 4
    c.rect(bx-1, byy-1, 12, 29, L.INK); c.rect(bx-1, byy+31, 12, 12, L.INK)
    c.rect(bx, byy, 10, 27, L.AMBER); c.rect(bx, byy+32, 10, 10, L.AMBER)
    c.vline(bx+1, byy+1, 25, L.MARBLE); c.px(bx+1, byy+33, L.MARBLE)
    for _, t in ipairs({{24,10,18,4},{18,24,10,22},{20,40,12,40}}) do
      c.line(t[1], t[2]+dy, t[3], t[4]+dy, L.INK); c.line(t[1]+1, t[2]+dy, t[3]+1, t[4]+dy, L.MARBLE)
    end
  end
  return c, s
end

-- =============================== Overlord ===============================
local DIM = { [L.MARBLE]=L.MINT, [L.MINT]=L.TEAL, [L.TEAL]=L.VIOLET, [L.AMBER]=L.CORAL, [L.CORAL]=L.PINK,
              [L.PINK]=L.VIOLET, [L.LINE]=L.INK, [L.MUTED]=L.LINE }
local HEAD = {38,12, 90,12, 104,28, 102,70, 88,86, 40,86, 26,70, 24,28}
local function lord(kind, n, seed)
  local c, s = cell()
  local alert = kind == "needs"
  local inv = alert and n == 2
  local bg, rim, brow, eye, wave, fill = L.INK, L.TEAL, L.MARBLE, L.MINT, L.MINT, { L.LINE, L.MUTED, L.MARBLE }
  if alert then rim, brow, eye, wave = L.PINK, L.PINK, L.AMBER, L.AMBER; fill = { L.LINE, L.CORAL, L.AMBER } end
  if inv then bg, rim, brow, eye, wave = L.PINK, L.AMBER, L.AMBER, L.AMBER, L.AMBER; fill = { L.LINE, L.CORAL, L.AMBER } end
  local dense = (kind == "talk" and n == 3) and 1.6 or 1
  -- tube: sparse static
  c.rect(0, 0, CW, CH, bg)
  for y=0, CH-1, 1 do for x=0, CW-1 do
    local h = hash(x, y, seed)
    if h < 0.045*dense then c.px(x, y, inv and L.CORAL or L.LINE) end
    if h < 0.012*dense then c.px(x, y, inv and L.AMBER or L.MUTED) end
    if h < 0.003*dense then c.px(x, y, L.MARBLE) end
  end end
  -- the head is a hexagon of DENSE static, a 2px glowing rim
  c.poly({HEAD[1]-2,HEAD[2]-2, HEAD[3]+2,HEAD[4]-2, HEAD[5]+2,HEAD[6], HEAD[7]+2,HEAD[8]+1, HEAD[9]+1,HEAD[10]+2,
          HEAD[11]-1,HEAD[12]+2, HEAD[13]-2,HEAD[14]+1, HEAD[15]-2,HEAD[16]}, rim)
  c.poly(HEAD, L.INK)
  for y=0, CH-1 do for x=0, CW-1 do
    if c.get(x, y) == L.INK and x > 24 and x < 104 and y > 11 and y < 87 then
      local inside = true
      -- use the rim fill as the mask: a pixel is inside if a rim pixel exists both left and right on its row
      local l, r = false, false
      for k=x-1, 22, -1 do if c.get(k, y) == rim then l = true break end end
      for k=x+1, 106 do if c.get(k, y) == rim then r = true break end end
      if l and r then
        local h = hash(x, y, seed + 7)
        if h < 0.30 then c.px(x, y, fill[1]) end
        if h < 0.10 then c.px(x, y, fill[2]) end
        if h < 0.025 then c.px(x, y, fill[3]) end
      end
    end
  end end
  -- side bolts / antenna nubs
  for _, bx in ipairs({17, 105}) do
    c.rect(bx, 40, 6, 16, L.INK); c.rect(bx+1, 41, 4, 14, rim); c.vline(bx+2, 42, 12, brow)
    c.hline(bx-3+(bx < 64 and 0 or 6), 47, 3, rim)
  end
  -- stern visor brow (a V), solid
  c.poly({32, 30, 58, 38, 60, 43, 32, 36}, L.INK); c.poly({33, 31, 57, 38, 58, 41, 33, 35}, brow)
  c.poly({96, 30, 70, 38, 68, 43, 96, 36}, L.INK); c.poly({95, 31, 71, 38, 70, 41, 95, 35}, brow)
  -- slit eyes with a scanning pupil
  local look = (kind == "idle" and n == 2) and 5 or ((kind == "talk" and n == 2) and -4 or 0)
  for i, ex in ipairs({38, 70}) do
    local ey = 45
    if kind == "blink" then
      c.rect(ex-1, ey+3, 22, 3, L.INK); c.hline(ex, ey+4, 20, eye)
    else
      c.rect(ex-1, ey-1, 22, 10, L.INK)
      c.rect(ex, ey, 20, 8, eye)
      c.hline(ex+1, ey+3, 18, L.MARBLE); c.hline(ex+1, ey+4, 18, L.MARBLE)
      local px = ex + 8 + look
      c.rect(px, ey+1, 4, 6, L.INK)
    end
  end
  -- oscilloscope mouth in a recessed grille
  c.rect(40, 61, 48, 17, L.INK); c.rect(41, 62, 46, 15, L.INK)
  c.hline(40, 61, 48, rim); c.hline(40, 77, 48, rim); c.vline(40, 61, 17, rim); c.vline(87, 61, 17, rim)
  for gx=44, 84, 8 do for gy=63, 75, 2 do c.px(gx, gy, L.LINE) end end
  local amp = 0
  if kind == "talk" then amp = ({3, 6, 5})[n] end
  if alert then amp = 6 end
  local prev
  for x=42, 85 do
    local t = (x - 42) / 43
    local yv
    if alert then yv = 69 + (((x // 3) % 2 == 0) and -amp or amp)                         -- square alarm
    elseif kind == "talk" and n == 2 then yv = 69 + math.floor(amp*math.sin(t*14) * math.sin(t*3.1) + 0.5)
    elseif kind == "talk" and n == 3 then yv = 69 + math.floor(amp*math.sin(t*22 + 1) + 0.5) * ((x % 5 == 0) and -1 or 1)
    else yv = 69 + math.floor(amp*math.sin(t*9.4) + 0.5) end
    if prev then c.line(x-1, prev, x, yv, wave) else c.px(x, yv, wave) end
    c.px(x, yv+1, wave)
    prev = yv
  end
  -- jaw panel lines
  c.line(46, 82, 82, 82, rim); c.px(64, 84, rim)
  -- alert furniture: hazard bars top + bottom, warning triangles in the corners
  if alert then
    for y=0, 5 do for x=0, CW-1 do
      local band = ((x + y) // 6) % 2 == 0
      c.px(x, y, band and L.AMBER or L.INK); c.px(x, CH-1-y, band and L.AMBER or L.INK)
    end end
    for _, tx in ipairs({10, 117}) do
      c.poly({tx, 28, tx+10, 48, tx-10, 48}, L.INK)
      c.poly({tx, 31, tx+8, 46, tx-8, 46}, inv and L.AMBER or L.AMBER)
      c.rect(tx-1, 35, 2, 6, L.INK); c.rect(tx-1, 43, 2, 2, L.INK)
    end
  end
  -- rolling vertical-hold bar on idle 2
  if kind == "idle" and n == 2 then
    for y=56, 59 do for x=0, CW-1 do if hash(x, y, 99) < 0.5 then c.px(x, y, L.LINE) end end end
    glitch(c, 56, 59, 2)
  end
  -- scanlines: every odd row one step dimmer
  for y=1, CH-1, 2 do for x=0, CW-1 do
    local v = c.get(x, y)
    if DIM[v] and not (inv and v == L.PINK) and not (alert and (x < 22 or x > 105) and y > 26 and y < 50) then c.px(x, y, DIM[v]) end
  end end
  -- horizontal glitch tears on talk
  if kind == "talk" then
    local tears = ({ {{42,49,3}}, {{28,37,-5},{62,71,4}}, {{16,25,6},{44,51,-4},{64,73,5}} })[n]
    for _, t in ipairs(tears) do glitch(c, t[1], t[2], t[3]) end
  end
  return c, s
end

-- =============================== sheets ===============================
local function sheet(name, frames)
  local N = #frames
  local spr = L.new(CW*N, CH, pal)
  local layer = spr.layers[1]; layer.name = "faces"
  local img = Image(CW*N, CH, ColorMode.INDEXED); img:clear(0)
  local js = {}
  for i, f in ipairs(frames) do
    local c, s = f.draw()
    img:drawImage(c.img, Point((i-1)*CW, 0))
    s:close()
    js[f.tag] = js[f.tag] or {}
    table.insert(js[f.tag], '{"x":'..((i-1)*CW)..',"y":0}')
  end
  spr:newCel(layer, spr.frames[1], img, Point(0, 0))
  for i, f in ipairs(frames) do local sl = spr:newSlice(Rectangle((i-1)*CW, 0, CW, CH)); sl.name = f.tag.."."..i end
  spr:saveAs(root.."/art/office/face-"..name..".aseprite")
  for _, mode in ipairs({"dark", "light"}) do
    local out = Sprite(CW*N, CH, ColorMode.INDEXED)
    out:setPalette(Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" })
    out.transparentColor = 0
    out.cels[1].image = img
    out:saveAs(root.."/public/office/face-"..name.."-"..mode..".png"); out:close()
  end
  print("wrote face-"..name.." "..N.." frames")
  local parts = {}
  for _, tag in ipairs({"idle", "blink", "talk", "needs"}) do parts[#parts+1] = '"'..tag..'":['..table.concat(js[tag], ",")..']' end
  return '{'..table.concat(parts, ",")..'}'
end

local function F(tag, fn, ...) local a = {...}; return { tag = tag, draw = function() return fn(tag, table.unpack(a)) end } end
local rj = sheet("riffbot", {
  F("idle", riff, 1), F("blink", riff, 1), F("talk", riff, 1), F("talk", riff, 2), F("talk", riff, 3),
  F("needs", riff, 1), F("needs", riff, 2) })
local oj = sheet("overlord", {
  F("idle", lord, 1, 11), F("idle", lord, 2, 23), F("blink", lord, 1, 11),
  F("talk", lord, 1, 31), F("talk", lord, 2, 37), F("talk", lord, 3, 41),
  F("needs", lord, 1, 53), F("needs", lord, 2, 59) })
local json = '{"version":1,"cell":{"w":'..CW..',"h":'..CH..'},"fps":3,\n "riffbot":'..rj..',\n "overlord":'..oj..'}\n'
local f = io.open(root.."/public/office/faces.json", "wb"); f:write(json); f:close()
print("wrote faces.json")
