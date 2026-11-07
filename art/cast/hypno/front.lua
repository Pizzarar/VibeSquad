-- H0 needs-you sprites (32x32 frame 2): turned round in the chair, hand up, pink "!" bubble.
-- Head = shared lopsided face (origin hx,hy) + role hair/hat + googly features.
local F = { head = {}, body = {}, fx = {} }
local hx, hy = 8, 7

local FACE = [[
|....kkkkkkk....|
|..kkssssssskk..|
|.ksssssssssssk.|
|ksssssssssssssk|
|ksssssssssssssk|
|ksssssssssssssk|
|ksssssssssssssk|
|ksssssssssssssk|
|ksssssssssssssk|
|ksssssssssssssk|
|ksssssssssssssk|
|.ksssssssssssk.|
|..kkssssssssskk|
|....kkkkkkkkk..|
]]
-- googly eyes (left small, right big = lopsided), raised brows, open D grin, blush
local FEAT = [[
|...............|
|...............|
|...............|
|..kk......kk...|
|...............|
|..kkk...kkkk...|
|..mkm...mmkm...|
|..mkm...mmkm...|
|........mmmm...|
|.cc........cc..|
|....kkkkkk.....|
|.....kpppk.....|
|......kkk......|
|...............|
]]

local function head(hair, extra)
  local t = { {hx, hy, FACE} }
  if hair then t[#t+1] = hair end
  t[#t+1] = {hx, hy, FEAT}
  if extra then for _, e in ipairs(extra) do t[#t+1] = e end end
  return t
end

-- ---------- hair / hats ----------
-- lead: big pompadour swoop, forehead open
F.head.lead = head({hx, hy-4, [[
|...kkkkkk......|
|.kkkvvvkkkk....|
|kkkkkkkkvvkk...|
|kkkkkkkkkkkkk..|
|kkkkkkkkkkkkkk.|
|kkkkkkkkkkkkkkk|
|kk.........kkkk|
|k.............k|
]]})
F.head.buddy = head({hx, hy-3, [[
|..k...k...k....|
|..kk.kkk.kk..k.|
|.kkkkkkkkkkkkk.|
|kkkkvkkkkkkvkkk|
|kkkkkkkkkkkkkkk|
|kk..........kkk|
|k.............k|
]]}, {
 -- headphones: band over the mop, cups over the ears
 {hx-2, hy-4, [[
|.....aaaaaaaaa.....|
|...aa.........aa...|
|..a.............a..|
|.a...............a.|
|.a...............a.|
|a.................a|
|kkkk...........kkkk|
|kppk...........kppk|
|kppk...........kppk|
|kppk...........kppk|
|kkkk...........kkkk|
]]},
})
-- implement: TV-head; the face lives on the screen
F.head.implement = { {6, 1, [[
|.....p.........p..|
|.....k........k...|
|......k......k....|
|......k.....k.....|
|.......k...k......|
|........kkk.......|
|..kkkkkkkkkkkkkk..|
|.kaaaaaaaaaaaaaak.|
|.kakkkkkkkkkkaaak.|
|.kakttttttttkacak.|
|.kaktmmttmmtkaaak.|
|.kaktmkttmktkaaak.|
|.kakttttttttkacak.|
|.kaktkttttktkaaak.|
|.kakttkkkkttkaaak.|
|.kakkkkkkkkkkaaak.|
|.kcccccccccccccck.|
|..kkkkkkkkkkkkkk..|
|........kk........|
|.......kkk........|
]]} }
-- review: stalk-eye alien; the giant eye swings round to stare at you
F.head.review = { {6, 0, [[
|.......kkkkk......|
|.....kkmmmmmkk....|
|....kmmmmmmmmmk...|
|....kmmmtttmmmk...|
|....kmmtkkktmmk...|
|....kmmtkkmtmmk...|
|....kmmmtttmmmk...|
|.....kkmmmmmkk....|
|.......kkgkk......|
|........kgk.......|
|...kkkkkkgkkkkk...|
|..kggggggggggggk..|
|.kggggggggggggggk.|
|.kgcggggggggggcgk.|
|kggkkkkkkkkkkkgggk|
|kgggkppppppppkgggk|
|kggggkkpppppkkgggk|
|.kgggggkkkkkggggk.|
|..kggggggggggggk..|
|....kkggggggkk....|
|......kggggk......|
]]} }

-- ---------- bodies (origin 3,20) ----------
F.body.lead = { 3, 20, [[
|....kkkkkkkkmmmmmkkkkkkkk..|
|...kpppppppkmmtmmkpppppppk.|
|..kpppppppppkmtmkpppppppppk|
|.kppppppppppkmtmkpppppppppk|
|.kppkppppppppktkppppppppkpk|
|.kppkppppppppktkppppppppkpk|
|.kppkpppppppppkpppppppppkpk|
|.kppkpppppppppppppppppppkpk|
|.kpppkpppppppppppppppppkssk|
|.kkkkkkkkkkkkkkkkkkkkkkkkkk|
|....kpppppk.....kpppppk....|
|....kkkkkkk.....kkkkkkk....|
]]}
F.body.buddy = { 1, 20, [[
|.......kkkttttttttkkk.........|
|....kkkpptttttttttppkkkk......|
|...kpppppkttttttttkppppppk....|
|..kppppppkttttttttkpppppppk...|
|.kaapppaakttktttttkaapppaaak..|
|.kttaaattktttttttttkaaattaak..|
|.kttttttkttttttttttktttttttk..|
|.kttttttkttttttttttktttttttk..|
|.kttttttkttttttttttktttttssk..|
|.kkkkkkkkkkkkkkkkkkkkkkkkkkk..|
|......kvvvvvk.....kvvvvvk.....|
|......kkkkkkk.....kkkkkkk.....|
]]}
F.body.implement = { 3, 20, [[
|....kkkkkkkkkkkkkkkkkk.....|
|...kmmmmmmmkmmmkmmmmmmk....|
|..kmmmmmmmmkmkmkmmmmmmmk...|
|.kmmmmmmmmmmkmkmmmmmmmmmk..|
|.kmmmkmmmmmmmmmmmmmmmkmmk..|
|.kaaakmmmmmmmmmmmmmmmkaak..|
|.ksssskmmmmmmmmmmmmmmkssk..|
|.ksssskmmmmmmmmmmmmmmkssk..|
|..kssskmmmmmmmmmmmmmmkssk..|
|...kkkkkkkkkkkkkkkkkkkkk...|
|.....kvvvvvk....kvvvvvk....|
|.....kkkkkkk....kkkkkkk....|
]]}
F.body.review = { 5, 20, [[
|....kkkkkkkkkkkkkk....|
|...kvvvvkpkkpkvvvvk...|
|..kvvvvvkmmmmkvvvvvk..|
|.kvvvvvvkmmmmkvvvvvvk.|
|.kvvvvvvvkakvvvvvvvvk.|
|.kvvkvvvvvkvvvvvvkvvk.|
|.kvvkvvvvvavvvvvvkvvk.|
|.kvvkvvvvvkvvvvvvkvvk.|
|.kvvkvvvvvavvvvvvkggk.|
|.kkkkkkkkkkkkkkkkkkkk.|
|....kvvvk....kvvvk....|
|....kkkkk....kkkkk....|
]]}

-- ---------- fx: raised arm + bubble ----------
-- bubble: pink, INK rim, MARBLE "!", tail pointing at the head; twinkles around it
local BUBBLE = [[
|.kkkkkkkk.|
|kppppmpppk|
|kpppmmmppk|
|kpppmmmppk|
|kppppmpppk|
|kppppmpppk|
|kppppppppk|
|kppppmpppk|
|.kkkkkpkk.|
|......pk..|
|.......k..|
]]
-- same bubble, tail pointing down-left (used when the bubble sits right of the head)
local BUBBLE_TAIL_L = [[
|.kkkkkkkk.|
|kppppmpppk|
|kpppmmmppk|
|kpppmmmppk|
|kppppmpppk|
|kppppmpppk|
|kppppppppk|
|kppppmpppk|
|.kkpkkkkk.|
|..kp......|
|..k.......|
]]
local function bubble(x, y) return {x, y, BUBBLE} end
-- arm raised on the viewer's right (noodle, hand open)
local ARM_R = [[
|.k.k.k.|
|kskskk.|
|kssssk.|
|kssssk.|
|.kssk..|
|.kvvk..|
|..kvvk.|
|..kvvk.|
|..kvvk.|
|...kvk.|
]]
-- lead: the raised hand IS the brick phone; bubble goes top-right over the CRT corner
F.fx.lead = {
 {22, 0, BUBBLE_TAIL_L},
 {0, 1, [[
|..p.....|
|..k.....|
|..k.....|
|.kkkk...|
|.kaak...|
|.kkkk...|
|.kaak...|
|.kaak...|
|kssak...|
|ksssk...|
|.kssk...|
|.kppk...|
|..kppk..|
|..kppk..|
|..kppk..|
|...kppk.|
|...kppk.|
|....kpk.|
|....kpk.|
|....kpk.|
]]},
}
F.fx.buddy = { bubble(0, 0), {0, 11, (ARM_R:gsub("v", "t"))} }
F.fx.implement = { bubble(0, 0), {0, 11, (ARM_R:gsub("kvvk", "kmmk"):gsub("kvk", "ksk"):gsub("v", "s"))} }
F.fx.review = { bubble(0, 0), {0, 11, (ARM_R:gsub("s", "g"))} }

return F
