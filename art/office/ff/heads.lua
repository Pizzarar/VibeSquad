-- FF floor heads: every floor variant's FRONT head (rest + "yo!") is its own 64px bust head re-drawn at
-- s = 0.7 into the 48px floor grid (FT: s = 0.933 into the 64px grid) (scale.lua), so the floor person wears the bust's face: the same eyes,
-- shades, googly glasses, grin, teeth, hair and hat. Only the head layers are taken (head, hair, face,
-- mouth, props above the collar); the bust body/arms/twinkles/"YO!" balloon are dropped.
--   v0 (H0 busts, bust.lua / bust_extra.lua) has one face: "yo" = that face as drawn; "rest" = the same
--      face with the H0 half-lids (lid in the head colour, INK lid line, pupils low) applied to its eyes.
--   v1-v3 (H1b, h1b.lua) draw their own rest / yo faces.
-- Back-of-head (work pose) = the variant's 32px H1b floor "back" head redrawn at s = 1.5 (v1-v3), or the
-- 64px bust head + hair with the face removed and the hair carried down the back (v0, see back0()).
return function(L, root, SC)
local hyp = root.."/art/cast/hypno/"
local H1B = dofile(hyp.."h1b.lua")(L)
local B0 = dofile(hyp.."bust.lua")
local BX = dofile(hyp.."bust_extra.lua")
local K, V, P, CO, A, S, M = 15, 8, 9, 10, 11, 14, 4
local N = 64          -- working canvas (head lands top-left; the cast builder crops by bbox)
local HS = 0.7 * 4 / 3   -- bust -> floor head scale (FT: cell 64, was 0.7 at cell 48)
local COLLAR = 44     -- bust rows >= this are body (props are clipped there)
local H = {}
-- v0 prop layers that belong to the head (phone at the ear, headphones, TV antennae, eye stalk); the other
-- roles' props are held objects (tea, wrench, flashlight, clipboard, brush), which the floor poses draw in hand
local HEADPROP = { lead = true, buddy = true, implement = true, review = true }

local function fakeL(s, store)
  return setmetatable({
    layer = function(_, name) return name end,
    canvas = function(_, name)
      local c = SC.wrap(SC.canvas(N, N), s); store[name] = c; return c
    end,
  }, { __index = L })
end
local function clip(c, rows)
  for y = rows, N - 1 do for x = 0, N - 1 do c.img:drawPixel(x, y, 0) end end
end
local function isEye(img, x0, y0)
  -- flood the MARBLE blob at x0,y0; returns its pixel list
  local seen, list, st = {}, {}, {{x0, y0}}
  while #st > 0 do
    local q = table.remove(st)
    local x, y = q[1], q[2]
    local k = y * N + x
    if x >= 0 and y >= 0 and x < N and y < N and not seen[k] and img:getPixel(x, y) == M then
      seen[k] = true; list[#list + 1] = q
      st[#st + 1] = {x + 1, y}; st[#st + 1] = {x - 1, y}; st[#st + 1] = {x, y + 1}; st[#st + 1] = {x, y - 1}
    end
  end
  return list, seen
end
-- H0 half-lids at floor size on a v0 face canvas: every MARBLE eye blob (>= 6 px) gets its top half
-- filled with the head colour, an INK lid line at the cut, and the pupil dropped to the bottom row.
local function restLids(face, head)
  local img = face.img
  local done = {}
  for y = 0, N - 1 do for x = 0, N - 1 do
    if img:getPixel(x, y) == M and not done[y * N + x] then
      local list, seen = isEye(img, x, y)
      for k in pairs(seen) do done[k] = true end
      if #list >= 6 then
        local x0, y0, x1, y1 = 99, 99, -1, -1
        for _, q in ipairs(list) do
          x0 = math.min(x0, q[1]); x1 = math.max(x1, q[1]); y0 = math.min(y0, q[2]); y1 = math.max(y1, q[2])
        end
        local cut = y0 + math.floor((y1 - y0 + 1) / 2)
        for yy = y0, cut do for xx = x0, x1 do
          local v = img:getPixel(xx, yy)
          local inside = seen[yy * N + xx] or (v == K and xx > x0 and xx < x1)
          if inside then
            local hc = head.img:getPixel(xx, yy)
            img:drawPixel(xx, yy, yy == cut and K or (hc ~= 0 and hc ~= K and hc or S))
          end
        end end
        -- pupils low: clear any pupil left under the lid, then a 2px INK pupil on the bottom row
        for yy = cut + 1, y1 do for xx = x0, x1 do
          if img:getPixel(xx, yy) == K then img:drawPixel(xx, yy, M) end
        end end
        local px = math.floor((x0 + x1) / 2)
        img:drawPixel(px, y1, K); if y1 - 1 > cut then img:drawPixel(px, y1 - 1, K) end
      end
    end
  end end
end

local function v0canvases(role, s)
  local store = {}
  local B = B0
  local ok = pcall(function() B0.draw(fakeL(s, store), { frames = {1} }, role) end)
  if not ok or not store.head then store = {}; BX.draw(fakeL(s, store), { frames = {1} }, role) end
  return store
end

-- front head image (N x N), mood = "rest" | "yo"
function H.front(role, v, mood)
  if v == 0 then
    local c = v0canvases(role, HS)
    if mood == "rest" then restLids(c.face, c.head) end
    local list = {c.head, c.hair, c.face}
    if HEADPROP[role] then clip(c.prop, math.floor(COLLAR * HS)); list[#list + 1] = c.prop end
    return SC.flatten(list, N, N)
  end
  local d = H1B[role][v]
  local base = v0canvases(role, HS)
  local C = {}
  for _, n in ipairs({"arm", "head", "hair", "face", "mouth", "prop", "fx", "bubble"}) do
    C[n] = SC.wrap(SC.canvas(N, N), HS)
  end
  d.bust(C, mood, role)
  local list = {C.head, C.hair, C.face, C.mouth}
  if role == "lead" then clip(base.prop, math.floor(COLLAR * HS)); list[#list + 1] = base.prop end
  clip(C.prop, math.floor(COLLAR * HS)); list[#list + 1] = C.prop
  return SC.flatten(list, N, N)
end

-- v1-v3 back of the head: the H1b 32px floor "back" head redrawn at 2x (FT; 1.5x at cell 48)
function H.back1(role, v)
  local d = H1B[role][v]
  local made = {}
  local function NC() local c = SC.wrap(SC.canvas(N, N), 2); made[#made + 1] = c; return c end
  local list = d.floor(NC, "back")
  return SC.flatten(list, N, N)
end

H.v0canvases = v0canvases
H.HS = HS
return H
end
