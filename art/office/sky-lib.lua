-- C2 phase 2: the shared cloud painter for the sky band (sky-build.lua) and the sky-CRT base
-- (sky-crt-build.lua), so both read as the same clouds. H0 hand: chunky hand-placed puffs, flat
-- MARBLE fill, a CORAL underside lit by the sunset, PINK bottom row, VIOLET outline + VIOLET seams
-- where one puff overlaps the next. Only slots that keep their role in both P0 palettes.
local S = {}

-- Paint one cloud. puffs = {{cx, cy, rx, ry}, ...} (first puff = back), opt:
--   base  flat bottom row (pixels below are cut), default = lowest puff edge
--   und   underside rows coloured CORAL above the base (default 3)
--   wrap  image width: x wraps (tileable band)
--   clip  {x0, x1}: only pixels inside this column range are painted (periodic edge tiles)
--   body  {y, x0, x1}: every pixel at row >= y in columns x0..x1 is cloud too (a solid bank)
--   flat  true: a straight CORAL underside line (no 5px wave), for edges that must be constant along x
--   belly false: no CORAL/PINK underside (a bank that runs off the bottom edge)
--   seams false: no VIOLET seam lines between overlapping puffs
-- L = the hypno lib (slot names).
function S.cloud(C, L, puffs, opt)
  opt = opt or {}
  local W = opt.wrap
  local function nx(x) if W then return x % W end return x end
  local mask, owner = {}, {}
  local function key(x, y) return y * 4096 + nx(x) end
  local base = opt.base or -1e9
  if not opt.base then for _, p in ipairs(puffs) do base = math.max(base, math.floor(p[2] + p[4])) end end
  local und = opt.und or 3
  local left = {}   -- per puff: row -> left edge x
  for i, p in ipairs(puffs) do
    local cx, cy, rx, ry = p[1], p[2], p[3], p[4]
    left[i] = {}
    for y = math.ceil(cy - ry), math.min(base, math.floor(cy + ry)) do
      local d = 1 - ((y - cy) / ry) ^ 2
      if d >= 0 then
        local hw = rx * math.sqrt(d)
        local xl, xr = math.floor(cx - hw + 0.5), math.floor(cx + hw - 0.5)
        left[i][y] = xl
        for x = xl, xr do
          local k = key(x, y)
          if not mask[k] then mask[k] = { x = x, y = y }; owner[k] = i end
        end
      end
    end
  end
  if opt.body then
    for y = opt.body[1], base do for x = opt.body[2], opt.body[3] do
      local k = key(x, y)
      if not mask[k] then mask[k] = { x = x, y = y }; owner[k] = 0 end
    end end
  end
  local function inside(x, y) return mask[key(x, y)] ~= nil end
  local function ok(x)
    if not opt.clip then return true end
    local xx = nx(x)
    return xx >= opt.clip[1] and xx <= opt.clip[2]
  end
  local function put(x, y, c) if ok(x) then C.px(nx(x), y, c) end end
  -- outline first (outside the mask), then the fill on top
  for _, m in pairs(mask) do
    for _, d in ipairs({ { -1, 0 }, { 1, 0 }, { 0, -1 }, { 0, 1 } }) do
      local x, y = m.x + d[1], m.y + d[2]
      if not inside(x, y) and y <= base + 1 then put(x, y, L.VIOLET) end
    end
  end
  for _, m in pairs(mask) do
    local x, y = m.x, m.y
    local c = L.MARBLE
    local wav = opt.flat and 0 or (nx(x) // 5) % 2
    if opt.belly ~= false then
      if y >= base - und + 1 + wav then c = L.CORAL end
      if y == base then c = L.PINK end
    end
    put(x, y, c)
  end
  -- seams: a puff's left edge where it overlaps an earlier puff (upper-middle part of the edge only)
  for i = 2, (opt.seams == false and 1 or #puffs) do
    local p = puffs[i]
    for y, xl in pairs(left[i]) do
      if y > p[2] - p[4] * 0.55 and y < p[2] + p[4] * 0.35 and y < base - und and inside(xl - 1, y) and owner[key(xl - 1, y)] ~= i then
        put(xl, y, L.VIOLET)
      end
    end
  end
end

return S
