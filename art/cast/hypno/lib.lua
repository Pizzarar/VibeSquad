-- H0 Hypnospace Office cast: shared pixel helpers (Aseprite batch, INDEXED, P0 slots only).
-- Everything is placed by hand: ASCII maps for the 32px floor sprites, hand-picked
-- shapes + ASCII stamps for the 64px busts. No generated or traced imagery.
local L = {}

-- P0 slots (art/palette/slots.md). Sprites never use 0 (it is the transparent index).
L.BG,L.PANEL,L.PHI,L.LINE,L.MARBLE,L.TEXT,L.MUTED,L.TEAL,L.VIOLET,L.PINK,L.CORAL,L.AMBER,L.MINT,L.SKY,L.SKIN,L.INK =
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15

-- ASCII key. Only slots that keep their value (dark/light) in BOTH palettes are used for
-- figure pixels: INK, VIOLET, PINK, CORAL, AMBER, SKIN, MARBLE, TEAL, MINT. SKY (13) is
-- only used for CRT screens, where a dark-navy/light-blue flip is fine.
L.KEY = { k=15, v=8, p=9, c=10, a=11, s=14, m=4, t=7, g=12, y=13 }

function L.new(w, h, pal)
  local spr = Sprite(w, h, ColorMode.INDEXED)
  spr:setPalette(pal)
  spr.transparentColor = 0
  return spr
end

-- get (or create) a named layer; the first one reuses the default layer
function L.layer(spr, name)
  for _, l in ipairs(spr.layers) do if l.name == name then return l end end
  local l
  if #spr.layers == 1 and spr.layers[1].name == "Layer 1" then l = spr.layers[1]
  else l = spr:newLayer() end
  l.name = name
  return l
end

-- canvas wrapper around one cel image
function L.canvas(spr, layer, frame)
  local cel = spr:newCel(layer, frame)
  local img = Image(spr.width, spr.height, ColorMode.INDEXED)
  img:clear(0)
  local C = { img = img, w = spr.width, h = spr.height }
  function C.px(x, y, c)
    if c and x >= 0 and y >= 0 and x < C.w and y < C.h then img:drawPixel(x, y, c) end
  end
  function C.get(x, y)
    if x < 0 or y < 0 or x >= C.w or y >= C.h then return 0 end
    return img:getPixel(x, y)
  end
  function C.rect(x, y, w, h, c) for j=y,y+h-1 do for i=x,x+w-1 do C.px(i, j, c) end end end
  function C.hline(x, y, w, c) for i=x,x+w-1 do C.px(i, y, c) end end
  function C.vline(x, y, h, c) for j=y,y+h-1 do C.px(x, j, c) end end
  -- ASCII stamp: '.' and ' ' are skipped; any other char goes through key
  function C.stamp(x0, y0, art, key, warnW)
    key = key or L.KEY
    local r, w0 = 0, nil
    for row in art:gmatch("[^\n]+") do
      row = row:gsub("^%s*|", ""):gsub("|%s*$", "")
      w0 = w0 or #row
      if #row ~= w0 then print("WARN stamp@"..x0..","..y0.." row "..r.." width "..#row.." ~= "..w0) end
      for i=1,#row do
        local ch = row:sub(i, i)
        if ch ~= "." and ch ~= " " then
          local c = key[ch]
          if c == nil then print("WARN unknown key '"..ch.."'") else C.px(x0+i-1, y0+r, c) end
        end
      end
      r = r + 1
    end
  end
  -- filled shape from a per-row span table {{y, x0, x1}, ...}
  function C.spans(t, c) for _, s in ipairs(t) do C.hline(s[2], s[1], s[3]-s[2]+1, c) end end
  -- filled ellipse with optional per-row wobble (table of x offsets, indexed by row from top)
  function C.ellipse(cx, cy, rx, ry, c, wobL, wobR)
    local n = 0
    for y=math.ceil(cy-ry), math.floor(cy+ry) do
      n = n + 1
      local d = 1 - ((y-cy)/ry)^2
      if d >= 0 then
        local hw = rx*math.sqrt(d)
        local xl = math.floor(cx - hw + 0.5) + (wobL and wobL[(n-1) % #wobL + 1] or 0)
        local xr = math.floor(cx + hw - 0.5) + (wobR and wobR[(n-1) % #wobR + 1] or 0)
        C.hline(xl, y, xr-xl+1, c)
      end
    end
  end
  -- polygon fill (even-odd scanline), pts = {x1,y1,x2,y2,...}
  function C.poly(pts, c)
    local ys, ye = 1e9, -1e9
    for i=2,#pts,2 do ys = math.min(ys, pts[i]); ye = math.max(ye, pts[i]) end
    for y=math.floor(ys), math.ceil(ye) do
      local xs = {}
      local n = #pts//2
      for i=0,n-1 do
        local x1, y1 = pts[i*2+1], pts[i*2+2]
        local x2, y2 = pts[((i+1)%n)*2+1], pts[((i+1)%n)*2+2]
        local yy = y + 0.5
        if (y1 <= yy and y2 > yy) or (y2 <= yy and y1 > yy) then
          xs[#xs+1] = x1 + (yy-y1)*(x2-x1)/(y2-y1)
        end
      end
      table.sort(xs)
      for k=1,#xs-1,2 do
        for x=math.floor(xs[k]+0.5), math.floor(xs[k+1]-0.5) do C.px(x, y, c) end
      end
    end
  end
  function C.line(x0, y0, x1, y1, c)
    local n = math.max(math.abs(x1-x0), math.abs(y1-y0))
    if n == 0 then C.px(x0, y0, c) return end
    for t=0,n do C.px(x0 + math.floor((x1-x0)*t/n + 0.5), y0 + math.floor((y1-y0)*t/n + 0.5), c) end
  end
  -- 1px outline around every non-transparent pixel group (4-neighbour edge, drawn outside)
  function C.outline(c)
    local add = {}
    for y=0,C.h-1 do for x=0,C.w-1 do
      if img:getPixel(x, y) == 0 then
        if C.get(x-1,y) ~= 0 and C.get(x-1,y) ~= c or C.get(x+1,y) ~= 0 and C.get(x+1,y) ~= c
        or C.get(x,y-1) ~= 0 and C.get(x,y-1) ~= c or C.get(x,y+1) ~= 0 and C.get(x,y+1) ~= c then
          add[#add+1] = {x, y}
        end
      end
    end end
    for _, p in ipairs(add) do img:drawPixel(p[1], p[2], c) end
  end
  -- 1px inner edge: pixels of slot `of` that touch slot 0 or a slot in `stop` become c
  function C.edge(of, c)
    local set = {}
    for y=0,C.h-1 do for x=0,C.w-1 do
      if img:getPixel(x, y) == of then
        for _, d in ipairs({{-1,0},{1,0},{0,-1},{0,1}}) do
          local n = C.get(x+d[1], y+d[2])
          if n ~= of and n ~= c then set[#set+1] = {x, y}; break end
        end
      end
    end end
    for _, p in ipairs(set) do img:drawPixel(p[1], p[2], c) end
  end
  -- top-edge rim light: INK pixels with nothing above them (rows < ymax) become c
  function C.rim(c, ymax)
    local set = {}
    for y=0,(ymax or C.h)-1 do for x=0,C.w-1 do
      if img:getPixel(x, y) == L.INK and C.get(x, y-1) == 0 then set[#set+1] = {x, y} end
    end end
    for _, p in ipairs(set) do img:drawPixel(p[1], p[2], c) end
  end
  function C.flipH()
    local copy = img:clone()
    for y=0,C.h-1 do for x=0,C.w-1 do img:drawPixel(x, y, copy:getPixel(C.w-1-x, y)) end end
  end
  function C.commit() cel.image = img end
  return C
end

-- ordered 4x4 Bayer: gradients only
L.BAYER = {{0,8,2,10},{12,4,14,6},{3,11,1,9},{15,7,13,5}}
function L.dith(x, y, a, b, t)
  if (L.BAYER[y%4+1][x%4+1] + 0.5) < t*16 then return b end
  return a
end

-- 3x5 font (invented labels only)
L.F = {
 A="010101111101101",B="110101110101110",C="011100100100011",D="110101101101110",
 E="111100110100111",F="111100110100100",G="011100101101011",H="101101111101101",
 I="111010010010111",J="001001001101010",K="101101110101101",L="100100100100111",
 M="101111111101101",N="110101101101101",O="010101101101010",P="110101110100100",
 Q="010101101110011",R="110101110101101",S="011100010001110",T="111010010010010",
 U="101101101101111",V="101101101101010",W="101101111111101",X="101101010101101",
 Y="101101010010010",Z="111001010100111",
 ["0"]="111101101101111",["1"]="010110010010111",["2"]="110001010100111",
 ["3"]="110001010001110",["4"]="101101111001001",["5"]="111100110001110",
 ["6"]="011100111101111",["7"]="111001010010010",["8"]="111101111101111",
 ["9"]="111101111001110",["!"]="010010010000010",[":"]="000010000010000",
 ["("]="010100100100010",[")"]="010001001001010",["."]="000000000000010",
 ["-"]="000000111000000",["/"]="001001010100100",[" "]="000000000000000",
 ["x"]="000101010101000",["3"]="110001010001110",["+"]="000010111010000",
}
function L.text(C, x, y, s, c)
  for n=1,#s do
    local g = L.F[s:sub(n,n)] or L.F[" "]
    for r=0,4 do for q=0,2 do
      if g:sub(r*3+q+1, r*3+q+1) == "1" then C.px(x+(n-1)*4+q, y+r, c) end
    end end
  end
end
function L.textW(s) return #s*4 - 1 end

-- Win95-style bevelled plate: light top-left, dark bottom-right, INK rim
function L.plate(C, x, y, w, h, face, hi, lo)
  C.rect(x, y, w, h, face)
  C.hline(x, y, w, hi); C.vline(x, y, h, hi)
  C.hline(x, y+h-1, w, lo); C.vline(x+w-1, y, h, lo)
  C.hline(x-1, y-1, w+2, L.INK); C.hline(x-1, y+h, w+2, L.INK)
  C.vline(x-1, y, h, L.INK); C.vline(x+w, y, h, L.INK)
end

-- 4-point twinkle (+ 1px core), size 1 or 2
function L.twinkle(C, x, y, c, core, size)
  size = size or 1
  for d=1,size do C.px(x-d, y, c); C.px(x+d, y, c); C.px(x, y-d, c); C.px(x, y+d, c) end
  C.px(x, y, core or c)
end

return L
