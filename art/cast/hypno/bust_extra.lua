-- S1 stretch: 64px busts for the 6 extra roles (same method as bust.lua: hand-chosen shapes per
-- layer, 1px INK outline per layer, then features stamped pixel by pixel). P0 slots that hold in
-- both palettes only.
local B = {}
local K, V, P, CO, A, S, M, T, G = 15, 8, 9, 10, 11, 14, 4, 7, 12
local WOB_L = {0,0,-1,0,0,1,0,0,0,-1,0,0,1,0,0,0,0,-1,0}
local WOB_R = {0,1,0,0,0,0,1,1,0,0,0,-1,0,0,1,0,0,0,0}

local function layers(L, spr)
  local t = {}
  for _, n in ipairs({"body", "head", "hair", "face", "prop", "fx"}) do t[n] = L.canvas(spr, L.layer(spr, n), spr.frames[1]) end
  return t
end
-- googly eyes: small left, big right (H0 look)
local function eyes(C, cx, ey)
  C.ellipse(cx-7, ey, 3.6, 4.6, M); C.ellipse(cx+6, ey-1, 4.6, 5.6, M)
  C.outline(K)
  C.rect(cx-8, ey, 2, 3, K); C.rect(cx+4, ey-2, 2, 3, K)
  C.px(cx-8, ey, M); C.px(cx+4, ey-2, M)
end

local ROLE = {}

-- RETIRED-LEAD: sleepy walrus grandpa, mustard cardigan, reading glasses, cup of tea
ROLE["retired-lead"] = function(L, C)
  local b = C.body
  b.poly({4,64, 6,52, 16,47, 48,47, 58,52, 60,64}, A)
  b.poly({25,47, 39,47, 32,60}, M)
  b.outline(K)
  b.line(25,47, 32,60, K); b.line(39,47, 32,60, K); b.vline(32, 60, 4, K)
  for y=52,62,5 do b.rect(29, y, 2, 2, CO) end
  b.line(14,52, 14,63, K); b.line(50,52, 50,63, K)
  for x=6,58,4 do b.px(x, 56, CO) end                               -- cardigan rib
  local h = C.head
  h.ellipse(32, 28, 19, 17, CO, WOB_L, WOB_R)
  h.outline(K)
  h.rect(22, 14, 4, 2, M); h.px(21, 16, M)                          -- head shine
  local r = C.hair
  for _, s in ipairs({{12,22},{51,23}}) do r.ellipse(s[1], s[2], 3, 5, M) end   -- side tufts
  r.outline(K)
  local f = C.face
  -- tiny sleepy eyes behind round reading glasses
  for _, cx in ipairs({24, 40}) do
    f.ellipse(cx, 26, 5, 4.5, M); f.outline(K)
    f.hline(cx-2, 26, 4, K)
  end
  f.hline(29, 25, 6, K)                                             -- glasses bridge
  -- big bushy moustache + short tusks
  f.ellipse(32, 37, 15, 5, M)
  f.outline(K)
  for x=19,45,3 do f.px(x, 39, K) end
  f.ellipse(32, 33, 3, 2, P); f.px(31, 32, M)                       -- nose
  f.poly({24,41, 28,41, 26,48}, M); f.poly({36,41, 40,41, 38,48}, M)
  f.line(24,41, 26,48, K); f.line(28,41, 26,48, K); f.line(36,41, 38,48, K); f.line(40,41, 38,48, K)
  f.rect(10, 31, 3, 2, P); f.rect(52, 31, 3, 2, P)                  -- blush
  local p = C.prop
  -- teacup in the right hand, steam squiggle (wisp, not a drip)
  p.rect(48, 44, 11, 8, M); p.rect(48, 44, 11, 2, P)
  p.ellipse(60, 47, 2, 2, M)
  p.outline(K)
  p.px(60, 47, K)
  p.line(51, 41, 52, 38, M); p.line(52, 38, 51, 35, M); p.line(55, 41, 56, 38, M); p.line(56, 38, 55, 35, M)
end

-- MECHANICAL: boxy robot, pink cap on backwards, teal jumpsuit, wrench
ROLE.mechanical = function(L, C)
  local b = C.body
  b.poly({4,64, 6,52, 16,48, 48,48, 58,52, 60,64}, T)
  b.outline(K)
  b.vline(32, 48, 16, K)                                            -- zip
  b.rect(38, 53, 12, 6, A); b.hline(40, 55, 8, K)                   -- name patch
  b.rect(12, 54, 8, 7, T); b.hline(12, 54, 8, K); b.vline(12, 54, 7, K); b.vline(19, 54, 7, K)
  b.rect(28, 44, 8, 5, M); b.vline(28, 44, 4, K); b.vline(35, 44, 4, K)  -- neck
  local h = C.head
  h.rect(12, 12, 40, 32, M)
  h.outline(K)
  h.rect(13, 41, 38, 2, 3)
  for _, q in ipairs({{12,22},{12,34},{51,22},{51,34}}) do h.rect(q[1]-1, q[2], 2, 3, A) end   -- side bolts
  local r = C.hair
  -- cap on backwards: crown on top, strap + snap at the front, brim pokes out behind
  r.ellipse(32, 12, 17, 8, P)
  r.rect(15, 12, 34, 3, 0)
  r.rect(46, 6, 12, 4, P)
  r.outline(K)
  r.hline(26, 11, 12, K); r.rect(30, 9, 4, 2, M)                    -- strap + snap
  r.px(32, 1, P); r.vline(32, 2, 3, K)
  local f = C.face
  -- visor with two teal screen eyes and a grille mouth
  f.rect(16, 18, 32, 12, K)
  f.rect(19, 20, 8, 7, T); f.rect(37, 20, 8, 7, T)
  f.rect(21, 22, 3, 3, M); f.rect(39, 22, 3, 3, M)
  f.rect(22, 33, 20, 6, K)
  for x=24,40,4 do f.rect(x, 35, 2, 2, G) end
  f.rect(14, 31, 3, 2, P); f.rect(47, 31, 3, 2, P)
  local p = C.prop
  p.poly({52,62, 54,62, 58,44, 56,44}, M)
  p.ellipse(57, 41, 4, 4, M)
  p.outline(K)
  p.rect(56, 37, 3, 3, 0); p.px(57, 40, K)
end

-- AUDIT: owl night guard, violet cap with a badge, flashlight
ROLE.audit = function(L, C)
  local b = C.body
  b.poly({4,64, 6,52, 16,48, 48,48, 58,52, 60,64}, V)
  b.poly({26,48, 38,48, 32,58}, M)
  b.outline(K)
  b.line(26,48, 32,58, K); b.line(38,48, 32,58, K); b.vline(32, 58, 6, K)
  b.poly({16,53, 19,51, 22,53, 21,57, 17,57}, A); b.px(19, 54, K)   -- badge
  b.hline(6, 52, 8, A); b.hline(50, 52, 8, A)                        -- epaulettes
  local h = C.head
  h.ellipse(32, 31, 19, 17, A, WOB_L, WOB_R)
  h.poly({13,22, 12,8, 21,17}, A); h.poly({51,22, 52,8, 43,17}, A)  -- ear tufts
  h.outline(K)
  for _, d in ipairs({{18,40},{24,44},{40,44},{46,40},{32,46},{14,32},{50,32}}) do h.rect(d[1], d[2], 2, 1, CO) end
  local r = C.hair
  r.poly({17,16, 19,9, 32,6, 45,9, 47,16}, V)
  r.rect(15, 16, 34, 3, V)
  r.outline(K)
  r.hline(16, 16, 32, K)
  r.poly({30,9, 32,7, 34,9, 33,12, 31,12}, A)
  local f = C.face
  -- big face discs, round staring eyes, beak
  f.ellipse(24, 29, 8, 8, M); f.ellipse(40, 29, 8, 8, M)
  f.outline(K)
  f.ellipse(24, 29, 3.5, 3.5, K); f.ellipse(41, 28, 4.5, 4.5, K)
  f.px(23, 28, M); f.px(40, 26, M); f.px(41, 26, M)
  f.poly({29,35, 35,35, 32,41}, CO)
  f.line(29,35, 32,41, K); f.line(35,35, 32,41, K); f.hline(29, 35, 7, K)
  local p = C.prop
  -- flashlight with a short beam
  p.rect(50, 46, 6, 12, K); p.rect(49, 43, 8, 4, 3)
  p.poly({49,43, 57,43, 62,30, 44,30}, A)
  p.outline(K)
  p.rect(49, 43, 8, 2, M)
end

-- SPEC: cat in big round glasses, scrunchie tuft, clipboard
ROLE.spec = function(L, C)
  local b = C.body
  b.poly({4,64, 6,52, 16,48, 48,48, 58,52, 60,64}, G)
  b.poly({24,48, 32,54, 40,48, 40,51, 32,57, 24,51}, M)
  b.outline(K)
  b.line(24,48, 32,54, K); b.line(40,48, 32,54, K)
  for y=58,62,4 do b.rect(31, y, 2, 2, P) end
  local h = C.head
  h.ellipse(32, 32, 19, 15, M, WOB_L, WOB_R)
  h.poly({14,24, 15,8, 26,18}, M); h.poly({50,24, 49,8, 38,18}, M)
  h.outline(K)
  h.poly({17,20, 17,12, 23,18}, P); h.poly({47,20, 47,12, 41,18}, P)
  local r = C.hair
  r.ellipse(32, 14, 3, 4, M); r.outline(K)
  r.rect(29, 16, 7, 3, A); r.hline(29, 16, 7, K); r.hline(29, 18, 7, K)  -- scrunchie
  local f = C.face
  -- giant round glasses (teal-tinted rims), dot eyes, little mouth, whiskers
  for _, cx in ipairs({24, 41}) do
    f.ellipse(cx, 30, 7, 7, T); f.ellipse(cx, 30, 5, 5, M)
  end
  f.outline(K)
  f.hline(31, 29, 4, K)
  f.rect(23, 29, 3, 3, K); f.rect(40, 28, 3, 4, K); f.px(23, 29, M); f.px(40, 28, M)
  f.poly({30,37, 34,37, 32,39}, P)
  f.line(32, 39, 32, 41, K); f.line(32, 41, 29, 42, K); f.line(32, 41, 35, 42, K)
  f.line(8, 36, 17, 38, K); f.line(8, 41, 17, 40, K); f.line(47, 38, 56, 36, K); f.line(47, 40, 56, 41, K)
  f.rect(15, 41, 3, 2, CO); f.rect(46, 41, 3, 2, CO)
  local p = C.prop
  p.rect(44, 44, 16, 20, A); p.rect(46, 47, 12, 16, M)
  p.outline(K)
  p.rect(49, 42, 6, 4, K)
  for y=50,60,3 do p.hline(48, y, 8, K) end
  p.px(48, 50, G); p.px(48, 53, G)
end

-- ART: poodle with a pink beret, paint-dot smock, brush
ROLE.art = function(L, C)
  local b = C.body
  b.poly({4,64, 6,52, 16,48, 48,48, 58,52, 60,64}, T)
  b.outline(K)
  b.poly({26,48, 38,48, 32,55}, M); b.line(26,48, 32,55, K); b.line(38,48, 32,55, K)
  for _, d in ipairs({{12,56,P},{20,60,A},{44,57,G},{52,61,P},{38,61,A},{9,61,G}}) do b.rect(d[1], d[2], 3, 2, d[3]) end
  local h = C.head
  -- fluffy cloud head + dangling ear fluffs
  for _, e in ipairs({{32,30,16,15},{18,24,7,7},{46,24,7,7},{24,16,8,7},{40,16,8,7},{32,13,8,6}}) do
    h.ellipse(e[1], e[2], e[3], e[4], M)
  end
  h.ellipse(11, 38, 6, 9, M); h.ellipse(53, 38, 6, 9, M)
  h.outline(K)
  h.line(14, 32, 14, 46, K); h.line(50, 32, 50, 46, K)
  local r = C.hair
  -- beret, tilted, with a stalk
  r.ellipse(30, 10, 15, 5, P)
  r.outline(K)
  r.vline(30, 2, 3, K); r.px(29, 2, K)
  r.hline(18, 12, 22, 9)
  local f = C.face
  eyes(f, 32, 28)
  f.ellipse(32, 37, 4, 3, K); f.px(31, 36, M)
  f.line(25, 41, 29, 43, K); f.hline(29, 43, 6, K); f.line(35, 43, 39, 41, K)
  f.rect(18, 36, 3, 2, P); f.rect(44, 36, 3, 2, P)
  local p = C.prop
  p.line(52, 62, 60, 40, A); p.line(53, 62, 61, 40, A)
  p.ellipse(61, 37, 2, 4, P)
  p.outline(K)
end

-- UNKNOWN: paper bag over the head (eye holes + a big "?"), trench coat
ROLE.unknown = function(L, C)
  local b = C.body
  b.poly({4,64, 6,52, 16,48, 48,48, 58,52, 60,64}, CO)
  b.outline(K)
  b.poly({18,48, 30,48, 32,62}, CO); b.poly({46,48, 34,48, 32,62}, CO)
  b.line(18,48, 32,62, K); b.line(46,48, 32,62, K)                  -- lapels
  b.rect(27, 48, 10, 6, M)
  b.hline(6, 59, 52, K); b.rect(30, 58, 4, 3, A)                    -- belt + buckle
  local h = C.head
  h.poly({14,10, 50,10, 50,48, 14,48}, A)
  h.outline(K)
  -- crumpled top edge
  for x=14,50,4 do h.px(x+1, 9, K); h.px(x+2, 8, K); h.px(x+3, 9, K); h.px(x+2, 9, A) end
  for _, c in ipairs({{20,14,20,22},{44,36,46,46},{17,40,19,46},{36,12,37,18}}) do h.line(c[1], c[2], c[3], c[4], CO) end
  local f = C.face
  f.ellipse(24, 24, 3.5, 3, K); f.ellipse(40, 23, 4, 3.5, K)
  -- big "?"
  f.rect(28, 30, 8, 2, K); f.rect(34, 32, 2, 4, K); f.rect(31, 35, 4, 2, K); f.rect(31, 37, 2, 3, K)
  f.rect(31, 42, 2, 2, K)
  f.rect(17, 31, 3, 2, P); f.rect(44, 31, 3, 2, P)
end

function B.draw(L, spr, role)
  local C = layers(L, spr)
  ROLE[role](L, C)
  local fx = C.fx
  L.twinkle(fx, 4, 6, A, P, 2); L.twinkle(fx, 59, 40, P, nil, 1); L.twinkle(fx, 6, 38, T, nil, 1)
  for _, c in pairs(C) do c.commit() end
end

return B
