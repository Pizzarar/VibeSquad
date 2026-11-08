-- A1: the shared hub backdrop behind the Sky and Tower pages (docs/PLAN_NEON_OFFICE.md "A1", PLAN_HUB_PAGES A1).
-- art/office/hub-backdrop-{dark,light}.aseprite, 640x360, INDEXED (P0), tiles seamlessly on x (every shape wraps
-- at x=640, the Bayer seams are 4-periodic, the street dashes are 80-periodic like the floor plate).
-- Same native px as the floor/tower: 640 wide, and rows 332-359 are the floor plate's street rows 1:1
-- (INK, MARBLE, VIOLET curb, INK, LINE pavement, INK, PANEL road with 24px dashes every 80px), so with the
-- tile centred on the tower and bottom-aligned to the floor plate at the same integer scale, the kerb, pavement
-- and dashes run straight on into the neighbouring city.
-- Rows: H1d sky ramp (sky-build.lua: SKY_TOP > VIOLET > CORAL > AMBER; dark = night: SKY_TOP > LINE > VIOLET > PINK
-- glow), a few chunky outlined clouds, then a far skyline (PANEL_HI) and a near skyline of chunky front-view
-- buildings, tall at the tile edges (= the side zones beside the tower) and low shops in the middle (calm
-- band behind the TVs). Dark: stars, a moon, scattered lit AMBER windows. Light: pastel dusk, SKY glass.
-- One googly prop (2a): a small blimp up at the side.
-- Layers: sky, clouds, far, near, props, street.
-- Run: Aseprite.exe -b --script-param root=<repo> --script art/office/hub-backdrop-build.lua
local root = app.params.root
local L = dofile(root.."/art/cast/hypno/lib.lua")
local S = dofile(root.."/art/office/sky-lib.lua")
local W, H, GY = 640, 360, 332
local K = L.INK

-- fixed hash for the window pattern (deterministic, palette-free: it only picks lit vs unlit)
local function hash(x, y) local n = (x * 73856093 ~ y * 19349663) % 1000; return n end

local function build(mode)
  local night = mode == "dark"
  local pal = Palette{ fromFile = root.."/art/palette/pc98-"..mode..".gpl" }
  local spr = L.new(W, H, pal)
  local C = {}
  for _, n in ipairs({ "sky", "clouds", "far", "near", "props", "street" }) do
    local c = L.canvas(spr, L.layer(spr, n), spr.frames[1])
    local px, get = c.px, c.get
    c.px = function(x, y, col) px(x % W, y, col) end
    c.get = function(x, y) return get(x % W, y) end
    C[n] = c
  end

  -- ======================= sky: H1d flat bands with 4-row Bayer seams =======================
  do
    local c = C.sky
    local stops = night
      and { { 0, L.SKY }, { 214, L.LINE }, { 254, L.VIOLET }, { 290, L.PINK } }
      or  { { 0, L.SKY }, { 150, L.VIOLET }, { 222, L.CORAL }, { 268, L.AMBER } }
    for y = 0, GY - 1 do
      local col, nxt, t = stops[1][2], nil, 0
      for i = 1, #stops do if y >= stops[i][1] - 2 then col = stops[i][2] end end
      for i = 2, #stops do
        local s = stops[i][1]
        if y >= s - 2 and y < s + 2 then col, nxt, t = stops[i-1][2], stops[i][2], (y - (s - 2) + 0.5) / 4 end
      end
      for x = 0, W - 1 do c.px(x, y, nxt and L.dith(x, y, col, nxt, t) or col) end
    end
    if night then
      -- stars: mostly up top and at the sides, a few faint ones in the middle band
      for _, p in ipairs({ {12,8},{44,22},{71,5},{118,30},{152,12},{198,4},{236,26},{281,9},{334,18},{372,6},
                           {409,29},{447,11},{489,24},{523,7},{561,33},{607,15},{632,40},{26,58},{96,72},
                           {566,64},{611,88},{18,112},{604,128},{258,52},{402,60} }) do c.px(p[1], p[2], L.MARBLE) end
      L.twinkle(c, 172, 22, L.MARBLE, L.MARBLE, 2); L.twinkle(c, 462, 40, L.MARBLE, L.MARBLE, 1)
      L.twinkle(c, 590, 104, L.MARBLE, L.MARBLE, 1); L.twinkle(c, 54, 136, L.MARBLE, L.MARBLE, 1)
    end
    -- vaporwave lens streaks, low in the sky (one band brighter than the sky behind)
    local function lens(x, y, len, col) c.hline(x, y, len, col); c.hline(x + 4, y - 1, len - 10, col) end
    if night then
      lens(150, 236, 50, L.VIOLET); lens(380, 230, 64, L.VIOLET); lens(262, 272, 44, L.PINK); lens(470, 268, 36, L.PINK)
    else
      lens(40, 176, 56, L.PINK); lens(300, 168, 70, L.PINK); lens(500, 186, 44, L.PINK)
      lens(200, 240, 60, L.AMBER); lens(420, 246, 40, L.AMBER); lens(260, 290, 50, L.MARBLE)
    end
    c.commit()
  end

  -- ======================= clouds: chunky outlined cumulus, high and at the sides; two small soft ones mid =======================
  do
    local c = C.clouds
    S.cloud(c, L, { {20,52,13,7}, {36,46,13,10}, {52,53,11,6}, {64,56,7,4} }, { base = 58, und = 3, wrap = W })
    S.cloud(c, L, { {578,30,9,5}, {590,26,10,7}, {602,31,8,4} }, { base = 34, und = 2, wrap = W })
    S.cloud(c, L, { {626,116,11,6}, {640,110,12,9}, {654,117,9,5} }, { base = 121, und = 3, wrap = W })  -- straddles the seam
    S.cloud(c, L, { {230,96,7,4}, {239,93,7,5}, {247,97,5,3} }, { base = 99, und = 2, wrap = W })
    S.cloud(c, L, { {418,150,8,4}, {428,147,8,5}, {437,151,6,3} }, { base = 153, und = 2, wrap = W })
    if not night then
      S.cloud(c, L, { {120,196,10,5}, {132,192,10,7}, {144,197,8,4} }, { base = 200, und = 2, wrap = W })
      S.cloud(c, L, { {512,208,9,5}, {524,204,10,7}, {535,209,7,4} }, { base = 212, und = 2, wrap = W })
    end
    c.commit()
  end

  -- one box building: body, 1px INK outline on top and both sides (the street line covers the foot)
  local function box(c, x, top, w, fill)
    c.rect(x, top, w, GY - top, fill)
    c.hline(x - 1, top - 1, w + 2, K)
    c.vline(x - 1, top, GY - top, K); c.vline(x + w, top, GY - top, K)
  end

  -- ======================= far: hazy PANEL_HI skyline (no windows by day, a few lit pixels by night) =======================
  do
    local c = C.far
    local far = {
      {-8,26,170},{18,20,190},{38,28,156},{66,24,198},{90,36,212},{126,30,234},{156,42,250},{198,40,262},
      {238,52,268},{290,40,262},{330,48,256},{378,30,246},{408,38,230},{446,30,212},{476,34,196},{510,26,176},
      {536,30,160},{566,26,186},{592,40,166},
    }
    for _, b in ipairs(far) do box(c, b[1], b[3], b[2], L.PHI) end
    -- spire + mast on the two tallest far towers
    c.vline(51, 146, 10, K); c.vline(52, 146, 10, K); c.px(51, 145, K); c.px(52, 145, K)
    c.vline(550, 150, 10, K); c.px(549, 150, K); c.px(551, 150, K)
    if night then
      for _, b in ipairs(far) do
        for y = b[3] + 4, GY - 8, 6 do for x = b[1] + 3, b[1] + b[2] - 4, 5 do
          if hash(x, y) < 70 then c.px(x, y, L.AMBER) end
        end end
      end
    end
    c.commit()
  end

  -- ======================= near: chunky front-view buildings with window grids =======================
  do
    local c = C.near
    local unlit = night and L.PANEL or L.SKY
    local function windows(x, top, w, gx, gy, ww, wh, frame)
      local nx = math.max(1, (w - 2) // gx)
      local x0 = x + (w - (nx * gx - (gx - ww))) // 2
      for y = top + 4, GY - 10, gy do
        for i = 0, nx - 1 do
          local wx = x0 + i * gx
          local col = unlit
          local h = hash(wx % W, y)
          if night and h < 260 then col = L.AMBER elseif night and h < 285 then col = L.TEAL end
          c.rect(wx, y, ww, wh, col)
          if frame then c.hline(wx, y + wh, ww, frame) end
          if not night and h < 300 then c.px(wx, y, L.MARBLE) end      -- daylight glint
        end
      end
    end
    -- {x, w, top, fill, gx, gy, ww, wh}
    local near = {
      {606,40,198, L.LINE,   6,7,3,4},
      {  6,26,232, L.VIOLET, 6,7,3,4},
      { 34,34,208, L.LINE,   6,6,3,3},
      { 70,22,250, L.TEAL,   5,7,2,4},
      { 94,32,226, L.PHI,    6,7,3,4},
      {128,26,262, L.LINE,   6,7,3,4},
      {408,30,264, L.LINE,   6,7,3,4},
      {440,34,246, L.VIOLET, 6,7,3,4},
      {476,24,232, L.PHI,    6,7,3,4},
      {502,36,212, L.LINE,   6,6,3,3},
      {540,26,240, L.MARBLE, 6,7,3,4},
      {568,36,186, L.PHI,    6,7,3,4},
    }
    for _, b in ipairs(near) do
      box(c, b[1], b[3], b[2], b[4])
      windows(b[1], b[3], b[2], b[5], b[6], b[7], b[8])
    end
    -- low shops in the middle: one storey, striped awning, door + a shop window
    local shops = {
      {158,38,290, L.CORAL}, {198,30,298, L.PHI}, {230,54,302, L.LINE}, {286,40,294, L.VIOLET},
      {328,44,300, L.PHI}, {374,32,292, L.CORAL},
    }
    for _, s in ipairs(shops) do
      local x, w, top = s[1], s[2], s[3]
      box(c, x, top, w, s[4])
      -- awning: 3 rows, PINK/MARBLE stripes 3px wide, INK underline, scalloped bottom
      local ay = top + 5
      for xx = x - 1, x + w do
        local col = ((xx - x) // 3) % 2 == 0 and L.PINK or L.MARBLE
        c.px(xx, ay, K); c.px(xx, ay + 1, col); c.px(xx, ay + 2, col)
        if (xx - x) % 3 ~= 2 then c.px(xx, ay + 3, col) end
        c.px(xx, ay + 4 - ((xx - x) % 3 == 2 and 1 or 0), K)
      end
      -- shop window + door
      local wy = ay + 7
      c.rect(x + 3, wy, w - 14, GY - wy - 3, night and L.PANEL or L.SKY)
      if night then c.hline(x + 3, GY - 5, w - 14, L.AMBER); c.hline(x + 3, GY - 4, w - 14, L.AMBER) end   -- a low warm glow, not a lit slab
      c.hline(x + 2, wy - 1, w - 12, K); c.hline(x + 2, GY - 3, w - 12, K)
      c.vline(x + 2, wy, GY - wy - 3, K); c.vline(x + w - 11, wy, GY - wy - 3, K)
      if not night then c.px(x + 4, wy + 1, L.MARBLE); c.px(x + 5, wy + 1, L.MARBLE) end
      c.rect(x + w - 8, wy - 1, 6, GY - wy + 1, K)
      c.rect(x + w - 7, wy, 4, GY - wy, night and L.PANEL or L.PHI)
      c.px(x + w - 4, wy + 6, L.AMBER)
    end
    c.commit()
  end

  -- ======================= props: rooftop kit + the one googly blimp =======================
  do
    local c = C.props
    local key = { k = K, m = L.MARBLE, v = L.VIOLET, p = L.PINK, a = L.AMBER, t = L.TEAL, c = L.CORAL, l = L.LINE }
    -- water tower on the seam building (x 606..645)
    c.stamp(612, 180, [[
|..kkkkkkkk..|
|.kccccccccck|
|kcccccccccck|
|kckcckcckcck|
|kcccccccccck|
|kkkkkkkkkkkk|
|.k.k....k.k.|
|.k..k..k..k.|
|.k...kk...k.|
|.k..k..k..k.|
|.k.k....k.k.|
|kkkkkkkkkkkk|
]], key)
    -- radio mast with a PINK beacon on the tall left building
    c.vline(50, 190, 18, K); c.vline(51, 190, 18, K)
    c.hline(46, 198, 10, K); c.hline(47, 203, 8, K)
    c.stamp(48, 186, [[
|.kk.|
|kppk|
|kpmk|
|.kk.|
]], key)
    -- stepped art-deco crown + spire on the tall right tower (x 568..603)
    box(c, 574, 178, 24, L.PHI); box(c, 580, 170, 12, L.PHI)
    c.vline(585, 156, 14, K); c.vline(586, 156, 14, K)
    c.stamp(584, 152, [[
|.kk.|
|kppk|
|kpmk|
|.kk.|
]], key)
    for x = 576, 595, 4 do c.rect(x, 181, 2, 3, night and L.AMBER or L.SKY) end
    -- rooftop heart billboard on the violet tower (x 440..473): MARBLE board, PINK heart, INK frame + legs
    c.stamp(446, 226, [[
|kkkkkkkkkkkkkkkkkkkkkk|
|kmmmmmmmmmmmmmmmmmmmmk|
|kmmmmmmmppmmppmmmmmmmk|
|kmmmmmmppppppppmmmmmmk|
|kmmmmmmppppppppmmmmmmk|
|kmmmmmmmppppppmmmmmmmk|
|kmmmmmmmmppppmmmmmmmmk|
|kmmmmmmmmmppmmmmmmmmmk|
|kkkkkkkkkkkkkkkkkkkkkk|
|..k................k..|
|..k................k..|
|..k................k..|
]], key)
    -- AC boxes on the low left buildings
    c.stamp(132, 256, [[
|kkkkkkk|
|kllllmk|
|kltltlk|
|kkkkkkk|
]], key)
    c.stamp(506, 206, [[
|kkkkkkk|
|kllllmk|
|kltltlk|
|kkkkkkk|
]], key)
    -- the blimp (2a: the one googly prop), up at the right side: MARBLE envelope, VIOLET band, CORAL fins, googly eye
    c.stamp(520, 70, [[
|........kkkkkkkkkkkk.........|
|.....kkkmmmmmmmmmmmmkkk......|
|...kkmmmmmmmmmmmmmmmmmmkk..kk|
|..kmmmmmmmmmmmmmmmmkkkkmmkkck|
|.kmmmmmmmmmmmmmmmmkmmmmkmmkck|
|kmmmmmvvvvvvvvvvvvkmkkmkvkcck|
|kmmmmmvvvvvvvvvvvvkmkkmkvkcck|
|.kmmmmmmmmmmmmmmmmkmmmmkmmkck|
|..kmmmmmmmmmmmmmmmmkkkkmmkkck|
|...kkmmmmmmmmmmmmmmmmmmkk..kk|
|.....kkkmmmmmmmmmmmmkkk......|
|........kkkkkkkkkkkk.........|
|...........kkkkkk............|
|...........kaaaak............|
|...........kkkkkk............|
]], key)
    if night then
      -- the moon (no face): MARBLE crescent, INK outline, top-left
      c.stamp(90, 30, [[
|....kkkk..|
|..kkmmmk..|
|.kmmmkk...|
|kmmmk.....|
|kmmk......|
|kmmk......|
|kmmmk.....|
|.kmmmkk...|
|..kkmmmk..|
|....kkkk..|
]], key)
    end
    c.commit()
  end

  -- ======================= street: the floor plate's bottom rows 332-359, 1:1 =======================
  do
    local c = C.street
    c.hline(0, 332, W, K); c.hline(0, 333, W, L.MARBLE)
    c.hline(0, 334, W, L.VIOLET); c.hline(0, 335, W, L.VIOLET); c.hline(0, 336, W, K)
    c.rect(0, 337, W, 6, L.LINE); c.hline(0, 343, W, K)
    c.rect(0, 344, W, 16, L.PANEL)
    for x0 = 24, W - 1, 80 do
      c.hline(x0, 346, 24, K); c.hline(x0, 351, 24, K)
      c.vline(x0, 347, 4, K); c.vline(x0 + 23, 347, 4, K)
      c.rect(x0 + 1, 347, 22, 3, L.MARBLE); c.hline(x0 + 1, 350, 22, L.LINE)
    end
    -- street lamps on the pavement at the sides (AMBER lamp lit at night)
    for _, lx in ipairs({ 64, 584 }) do
      c.vline(lx, 312, 22, K); c.vline(lx + 1, 312, 22, K)
      c.stamp(lx - 2, 307, [[
|.kkkk.|
|kaaaak|
|kmaaak|
|.kkkk.|
]], { k = K, a = night and L.AMBER or L.MARBLE, m = L.MARBLE })
    end
    c.commit()
  end

  spr:saveAs(root.."/art/office/hub-backdrop-"..mode..".aseprite")
  local flat = Image(W, H, ColorMode.INDEXED); flat:clear(0); flat:drawSprite(spr, spr.frames[1])
  spr:close()
  local out = Sprite(W, H, ColorMode.INDEXED)
  out:setPalette(pal)
  out.transparentColor = 0
  out.cels[1].image = flat
  out:saveAs(root.."/public/office/hub-backdrop-"..mode..".png"); out:close()
end

build("dark"); build("light")
print("wrote hub backdrop "..W.."x"..H)
