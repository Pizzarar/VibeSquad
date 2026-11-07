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
F.head.lead = head({hx, hy, [[
|....kkkkkkk....|
|..kkkvvvkkkkk..|
|.kkkkkkkkvvvkk.|
|kkkvkkkkkkkkkkk|
|kk.kkkk.....kkk|
|k............kk|
|k.............k|
]]})
F.head.buddy = head({hx, hy-3, [[
|......k........|
|..k...kk...k...|
|..kk.kkkk.kk...|
|.kkkkkkkkkkkkk.|
|kkkkvkkkkkkvkkk|
|kkkkkkkkkkkkkkk|
|kkk.kkk.kkkk.kk|
|kk...k.....k.kk|
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
F.head.implement = head({hx, hy-1, [[
|....k..k..k....|
|...kkkkkkkkk...|
|..kkkkkkkkkkk..|
|.kkkkkkkkkkkkk.|
|kmmmmmmpmmmmmmk|
|kmmmmmpppmmmmmk|
|kk..k.......kkk|
]]}, {
 -- hachimaki tails flapping out to the right
 {hx+14, hy+3, [[
|kk....|
|mmkk..|
|kmmmk.|
|.kkmmk|
|...kk.|
]]},
})
F.head.review = head({hx-5, hy-7, [[
|.........kkkkkkk.........|
|.......kkvvkkkkkkk.......|
|......kkvvkkkkkkkkk......|
|......kvvkkkkkkkkkk......|
|......kvkkkkkkkkkkk......|
|......kpppppppppppk......|
|..kkkkkpppppppppppkkkkk..|
|kkvvvvkkkkkkkkkkkkkvvvvkk|
|.kkkkkkkkkkkkkkkkkkkkkkk.|
|.....k.............k.....|
]]})

-- ---------- bodies (origin 3,20) ----------
F.body.lead = { 3, 20, [[
|....kkkkkkkkmmmmmkkkkkkkk..|
|...kvvvvvvvkmmpmmkvvvvvvvk.|
|..kvvvvvvvvvkmpmkvvvvvvvvvk|
|.kvvvvvvvvvvkmpmkvvvvvvvvvk|
|.kvvkvvvvvvvvkpkvvvvvvvvkvk|
|.kvvkvvvvvvvvkpkvvvvvvvvkvk|
|.kvvkvvvvvvvvvkvvvvvvvvvkvk|
|.kvvkvvvvvvvvvvvvvvvvvvvkvk|
|.kvvvkvvvvvvvvvvvvvvvvvkssk|
|.kkkkkkkkkkkkkkkkkkkkkkkkkk|
|....kvvvvvk.....kvvvvvk....|
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
F.body.review = { 2, 19, [[
|.......kak.....kak.........|
|......kaak.kkk.kaak........|
|....kkaaakmmmmmkaaakkkk....|
|...kaaaaaakmpmkaaaaaaaak...|
|..kaaaaaaaakpkaaaaaaaaaak..|
|.kaaacaaaaakpkaaaaaaacaaak.|
|.kaaacaaaaaakaaaaaaaacaaak.|
|.kaaacaaaaaaacaaaaaaacaaak.|
|.kcccccccccccccccccccccccck|
|.kaaacaaaaaaacaaaaaaacaaak.|
|.kaaacaaaaaaacaaaaaaacsssk.|
|.kkkkkkkkkkkkkkkkkkkkkkkkk.|
|.....kaaaak.....kaaaak.....|
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
|.kvvk...|
|..kvvk..|
|..kvvk..|
|..kvvk..|
|...kvvk.|
|...kvvk.|
|....kvk.|
|....kvk.|
|....kvk.|
]]},
}
F.fx.buddy = { bubble(0, 0), {0, 11, (ARM_R:gsub("v", "t"))} }
F.fx.implement = { bubble(0, 0), {0, 11, (ARM_R:gsub("kvvk", "kmmk"):gsub("kvk", "ksk"):gsub("v", "s"))} }
F.fx.review = { bubble(0, 0), {0, 11, (ARM_R:gsub("v", "a"))} }

return F
