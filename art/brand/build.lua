-- S4 brand build (Aseprite batch). Paints every master from art/brand/marks.lua into an
-- INDEXED sprite on the P0 dark palette, saves the .aseprite sources, then exports the
-- dark and light variants as a pure palette swap (pc98-light.gpl, same indices).
-- Run via scripts/build-brand.mjs, or:
--   Aseprite.exe -b --script-param root=<repo> --script-param tmp=<dir> --script-param shots=<dir>
--                --script art/brand/build.lua
-- Writes:
--   art/brand/vs-mark.aseprite (64 master), art/brand/vs-mark-{16,22,24,32}.aseprite
--   public/vibesquad-mark-{dark,light}.png (22, sidebar), public/vibesquad-{192,512}.png
--   <tmp>/ico-{16,32,48}.png (packed into public/vibesquad.ico by build-brand.mjs)
--   <shots>/brand-s4-sheet.png, <shots>/brand-s4-maskable.png
local root = app.params.root
local tmp = app.params.tmp
local shots = app.params.shots
local L = dofile(root.."/art/cast/hypno/lib.lua")
local M = dofile(root.."/art/brand/marks.lua")
local pal = { dark = Palette{ fromFile = root.."/art/palette/pc98-dark.gpl" },
              light = Palette{ fromFile = root.."/art/palette/pc98-light.gpl" } }

-- ------------------------------------------------------------------ painting
local function paint(n)
  local s = M.sizes[n]
  local fr = s.frame
  local spr = L.new(n, n, pal.dark)
  local lay = {}
  for _, name in ipairs({ "frame", "title", "shadow", "glyphs", "twinkle" }) do lay[name] = L.layer(spr, name) end
  local f = spr.frames[1]
  local x0, y0 = fr.rim + fr.hi, fr.rim + fr.hi          -- interior top-left
  local x1, y1 = n-1-fr.rim-fr.lo, n-1-fr.rim-fr.lo      -- interior bottom-right
  local by0 = y0 + fr.title                              -- first body row

  -- frame: rim, bevel, title bar, body
  local C = L.canvas(spr, lay.frame, f)
  if fr.rim > 0 then C.rect(0, 0, n, n, L.INK) end
  local r = fr.rim
  for i=0,fr.hi-1 do C.hline(r+i, r+i, n-2*r-i, L.MARBLE); C.vline(r+i, r+i, n-2*r-i, L.MARBLE) end
  for i=0,fr.lo-1 do C.hline(r+i, n-1-r-i, n-2*r-i, L.INK); C.vline(n-1-r-i, r+i, n-2*r-i, L.INK) end
  C.rect(x0, y0, x1-x0+1, fr.title, L.VIOLET)
  C.rect(x0, by0, x1-x0+1, y1-by0+1, L.SKY)
  if s.glow then
    local g0, g1 = s.glow[1], s.glow[2]
    for y=g0,g1 do for x=x0,x1 do C.px(x, y, L.dith(x, y, L.SKY, L.VIOLET, (y-g0+1)/(g1-g0+2))) end end
  end
  C.commit()

  C = L.canvas(spr, lay.title, f)
  for _, t in ipairs(s.titleMark or {}) do C.rect(t[1], t[2], t[3], t[4], L.MARBLE) end
  if s.titleText then L.text(C, s.titleText[1], s.titleText[2], s.titleText[3], L.MARBLE) end
  C.commit()

  -- glyphs, then their INK drop shadow (body only, never on the bevel)
  local G = L.canvas(spr, lay.glyphs, f)
  for _, g in ipairs(s.glyphs or {}) do G.stamp(g[1], g[2], g[3], M.KEY) end
  for _, g in ipairs(s.spans or {}) do
    for _, sp in ipairs(g[3]) do G.hline(g[1]+sp[2], g[2]+sp[1], sp[3]-sp[2]+1, g[4]) end
  end
  G.commit()
  local S = L.canvas(spr, lay.shadow, f)
  for y=0,n-1 do for x=0,n-1 do
    if G.get(x, y) ~= 0 then
      for d=1,s.shadow do
        local sx, sy = x+d, y+d
        if sx >= x0 and sx <= x1 and sy >= by0 and sy <= y1 and G.get(sx, sy) == 0 then S.px(sx, sy, L.INK) end
      end
    end
  end end
  S.commit()

  C = L.canvas(spr, lay.twinkle, f)
  C.stamp(s.twinkle[1], s.twinkle[2], s.twinkle[3], M.KEY)
  C.commit()
  return spr
end

-- ------------------------------------------------------------------ raster helpers (RGBA)
local rgba = app.pixelColor.rgba
local function col(p, i) local c = p:getColor(i); return rgba(c.red, c.green, c.blue, 255) end
local function hexc(h) return rgba(tonumber(h:sub(2,3),16), tonumber(h:sub(4,5),16), tonumber(h:sub(6,7),16), 255) end

-- flattened indexed image -> RGBA image, nearest x`k`, on `bg` (nil = transparent)
local function toRGB(flat, p, k, bg)
  local w, h = flat.width, flat.height
  local out = Image(w*k, h*k, ColorMode.RGB)
  out:clear(bg or 0)
  for y=0,h-1 do for x=0,w-1 do
    local i = flat:getPixel(x, y)
    if i ~= 0 then
      local c = col(p, i)
      for j=0,k-1 do for q=0,k-1 do out:drawPixel(x*k+q, y*k+j, c) end end
    end
  end end
  return out
end
local function blit(dst, src, dx, dy)
  for y=0,src.height-1 do for x=0,src.width-1 do
    local c = src:getPixel(x, y)
    if app.pixelColor.rgbaA(c) > 0 then dst:drawPixel(dx+x, dy+y, c) end
  end end
end
local function fill(dst, x, y, w, h, c)
  for j=y,y+h-1 do for i=x,x+w-1 do dst:drawPixel(i, j, c) end end
end
local function text(dst, x, y, s, c, k)
  k = k or 2
  for n=1,#s do
    local g = L.F[s:sub(n,n):upper()] or L.F[" "]
    for r=0,4 do for q=0,2 do
      if g:sub(r*3+q+1, r*3+q+1) == "1" then fill(dst, x+((n-1)*4+q)*k, y+r*k, k, k, c) end
    end end
  end
end

-- ------------------------------------------------------------------ build masters
local flat = {}
for _, n in ipairs({ 16, 22, 24, 32, 64 }) do
  local spr = paint(n)
  local name = n == 64 and "vs-mark" or ("vs-mark-"..n)
  spr:saveAs(root.."/art/brand/"..name..".aseprite")
  flat[n] = Image(spr)
  spr:close()
end

-- ------------------------------------------------------------------ public exports
toRGB(flat[22], pal.dark, 1):saveAs(root.."/public/vibesquad-mark-dark.png")
toRGB(flat[22], pal.light, 1):saveAs(root.."/public/vibesquad-mark-light.png")
toRGB(flat[16], pal.dark, 1):saveAs(tmp.."/ico-16.png")
toRGB(flat[32], pal.dark, 1):saveAs(tmp.."/ico-32.png")
toRGB(flat[24], pal.dark, 2):saveAs(tmp.."/ico-48.png")

-- app icons: opaque P0 BG plate, 64 master upscaled x2 / x4 and centred
-- (512 is "any maskable": 256px mark, its corners sit inside the 80% safe circle)
local BGd = col(pal.dark, 0)
local function plate(size, k)
  local out = Image(size, size, ColorMode.RGB)
  out:clear(BGd)
  local m = toRGB(flat[64], pal.dark, k)
  blit(out, m, (size - m.width)//2, (size - m.height)//2)
  return out
end
local p192, p512 = plate(192, 2), plate(512, 4)
p192:saveAs(root.."/public/vibesquad-192.png")
p512:saveAs(root.."/public/vibesquad-512.png")

-- maskable check shot: 512 with the 80% safe circle drawn in MINT
do
  local chk = p512:clone()
  local mint = col(pal.dark, 12)
  for a=0,3599 do
    local t = a/3600*2*math.pi
    chk:drawPixel(math.floor(256 + 204.8*math.cos(t)), math.floor(256 + 204.8*math.sin(t)), mint)
  end
  chk:saveAs(shots.."/brand-s4-maskable.png")
end

-- ------------------------------------------------------------------ review sheet
-- Three panels: dark variant on dark UI, light variant on light UI, dark variant (the .ico)
-- on light chrome. Each row: label, 1x, 4x. Then a 16px-at-1x row on assorted surfaces.
local UI = {
  { name="DARK MARK / DARK UI",  p=pal.dark,  bg=col(pal.dark, 0),  panel=col(pal.dark, 1),  ink=col(pal.dark, 5) },
  { name="LIGHT MARK / LIGHT UI", p=pal.light, bg=col(pal.light, 0), panel=col(pal.light, 1), ink=col(pal.light, 5) },
  { name="ICO (DARK) / LIGHT UI", p=pal.dark,  bg=col(pal.light, 0), panel=col(pal.light, 1), ink=col(pal.light, 5) },
}
local ROWS = {
  { n=16, k=1, label="16 ICO" },
  { n=22, k=1, label="22 SIDEBAR" },
  { n=24, k=2, label="48 ICO (24X2)" },
  { n=32, k=1, label="32 ICO" },
  { n=64, k=1, label="64 MASTER" },
}
local PW = 24 + 176 + 64*4 + 24          -- panel width
local rowH = {}
local H = 40
for i, r in ipairs(ROWS) do rowH[i] = math.max(r.n*r.k*4, 40) + 30; H = H + rowH[i] end
local strip = 80
H = H + strip + 20
local W = PW*3
local sheet = Image(W, H, ColorMode.RGB)
for pi, u in ipairs(UI) do
  local px0 = (pi-1)*PW
  fill(sheet, px0, 0, PW, H, u.bg)
  text(sheet, px0+12, 12, u.name, u.ink, 2)
  local y = 40
  for i, r in ipairs(ROWS) do
    text(sheet, px0+12, y, r.label, u.ink, 2)
    text(sheet, px0+12, y+16, "1X        4X", u.ink, 1)
    local one = toRGB(flat[r.n], u.p, r.k)
    blit(sheet, one, px0+24, y+28)
    -- a 1x copy on PANEL too, next to the BG one
    fill(sheet, px0+24+one.width+8, y+24, one.width+8, one.height+8, u.panel)
    blit(sheet, one, px0+24+one.width+12, y+28)
    blit(sheet, toRGB(flat[r.n], u.p, r.k*4), px0+200, y+28)
    y = y + rowH[i]
  end
end
-- 16px at 1x on assorted surfaces (P0 BG/PANEL both modes, browser-tab grey, white, black)
do
  local y = H - strip - 10
  fill(sheet, 0, y, W, strip, col(pal.dark, 15))
  text(sheet, 12, y+8, "16PX AT 1X  (ICO TAB / TITLE BAR)", col(pal.dark, 5), 2)
  local surf = { col(pal.dark,0), col(pal.dark,1), col(pal.dark,2), col(pal.light,0), col(pal.light,1),
                 hexc("#dee1e6"), hexc("#ffffff"), hexc("#202124"), hexc("#000000") }
  local m16 = toRGB(flat[16], pal.dark, 1)
  for i, c in ipairs(surf) do
    local x = 12 + (i-1)*60
    fill(sheet, x, y+32, 44, 36, c)
    blit(sheet, m16, x+4, y+42)
    blit(sheet, toRGB(flat[22], (i>=4 and i<=7) and pal.light or pal.dark, 1), x+22, y+39)
  end
end
sheet:saveAs(shots.."/brand-s4-sheet.png")
print("brand: ok")
