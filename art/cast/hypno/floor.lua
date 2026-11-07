-- H0 floor sprites (32x32): hand-placed ASCII part maps.
-- Key (lib.lua): k INK, v VIOLET, p PINK, c CORAL, a AMBER, s SKIN, m MARBLE, t TEAL, g MINT, y SKY
-- Each part = { x, y, map }. Layers: desk (CRT + desk), chair, body, head, fx.
local P = {}

-- ---------- shared props ----------
-- CRT sits left of centre so its glow shows over the left shoulder
-- CRT drawn at the left here; build.lua mirrors the desk so it sits right of the head
-- and its glow shows over the sitter's shoulder without crowding the head silhouette
P.desk = {
-- desk sits low (y 18-21) so its strip runs under the shoulders, not through heads
 {0, 7, [[
|.kkkkkkkkkk.....................|
|kmmmmmmmmmmk....................|
|kmkkkkkkkkmk....................|
|kmkttttttkmk....................|
|kmkmmtggtkmk....................|
|kmkttttttkmk....................|
|kmkgggmmtkmk....................|
|kmkttttttkmk....................|
|kmkmmtgggkmk....................|
|kmkkkkkkkkmk....................|
|kmmmmmmmgmmk....................|
|kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk|
|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|
|cccccccccccccccccccccccccccccccc|
|kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk|
]]},
}

P.chairBack = { 10, 24, [[
|.kkkkkkkkkkk.|
|kpppppppppppk|
|kpmmppppppppk|
|kpmpppppppppk|
|kpppppppppppk|
|kpppppppppppk|
|kpppppppppppk|
|.kkkkkkkkkkk.|
]]}
-- chair seen behind a turned-round sitter: just the top rim peeking out
P.chairFront = { 6, 22, [[
|.kkkkkkkkkkkkkkkkkkk.|
|kpmmppppppppppppppppk|
|kpmpppppppppppppppppk|
]]}

-- ---------- back-of-head heads (origin 8,8) ----------
P.headBack = {}
P.headBack.lead = { 8, 8, [[
|.....tkkkk.....|
|...ttkkkkkkk...|
|..tkkkkkkkkkk..|
|.tkkkkkkkkkkkk.|
|tkkkkkkkkkkkkkk|
|tkkkkkkkkkkkkkk|
|tkkkkkkkkkkkkkk|
|kkkkkkkkkkkkkkk|
|kkkkkkkkvkkkkkk|
|.kkkkkkvkkkkkk.|
|..kkkkvkkkkkk..|
|....kkkkkkk....|
|....ksssssk....|
]]}
P.headBack.buddy = { 8, 4, [[
|......k........|
|...k..kk...k...|
|...kk.kkk.kk...|
|..kkkkkkkkkkk..|
|.kkkkkkkkkkkkk.|
|kkkkkkkkkkkkkkk|
|kkkkkkkkkkkkkkk|
|kkkkkkkkkkkkkkk|
|kkkkkkkkkkkkkkk|
|kkkkkkkkkkkkkkk|
|kkkkkkkkkkkkkkk|
|kkkkkkkkkkkkkkk|
|.kkkkkkkkkkkkk.|
|.k.kkkkkkkkk.k.|
|...kkkkkkkkk...|
|....ksssssk....|
]]}
P.headBack.implement = { 8, 6, [[
|....k..k..k....|
|...kkkkkkkkk...|
|..kkkkkkkkkkk..|
|.kkkvkkkkkkkkk.|
|kkkkkkkkkvkkkkk|
|kkkkkkkkkkkkkkk|
|kkkkkkkkkkkkkkk|
|kkkkkkmmmkkkkkk|
|mmmmmmmkmmmmmmm|
|kkkkkkmmmkkkkkk|
|kkkkkkkkkkkkkkk|
|.kkkkkkkkkkkkk.|
|..kkkkkkkkkkk..|
|....kkkkkkk....|
|....ksssssk....|
]]}
P.headBack.review = { 3, 2, [[
|.........kkkkkkk.........|
|.......kkvvkkkkkkk.......|
|......kkvvkkkkkkkkk......|
|......kvvkkkkkkkkkk......|
|......kvkkkkkkkkkkk......|
|......kvkkkkkkkkkkk......|
|......kpppppppppppk......|
|..kkkkkpppppppppppkkkkk..|
|kkvvvvkkkkkkkkkkkkkvvvvkk|
|kkkkkkkkkkkkkkkkkkkkkkkkk|
|.kkkkkkkkkkkkkkkkkkkkkkk.|
|...kkkkkkkkkkkkkkkkkkk...|
|.......kkkkkkkkkkk.......|
|.......kkkkkkkkkkk.......|
|........kkkkkkkkk........|
|.........ksssssk.........|
]]}

-- ---------- back bodies (origin 3,20) ----------
P.bodyBack = {}
P.bodyBack.lead = { 3, 21, [[
|..kkkkkkkmmmmmmmkkkkkkkkk.|
|.kvvvvvvvvvvvvvvvvvvvvvvvk|
|.kvvvvkvvvvvvvvvvvvvkvvvvk|
|.kvvvvkvvvvvvvvvvvvvkvvvvk|
|.kvvvvvvvvvvvvvvvvvvvvvvvk|
|.kvvvvvvvvvvvvvvvvvvvvvvvk|
|.kvvvvvvvvvvvvvvvvvvvvvvvk|
|.kvvvvvvvvvvvvvvvvvvvvvvvk|
|.kvvvvvvvvvvvvvvvvvvvvvvvk|
|.kkkkkkkkkkkkkkkkkkkkkkkkk|
]]}
P.bodyBack.buddy = { 1, 20, [[
|........kkkttttttkkk..........|
|....kkkkpktttttttttkpkkkk.....|
|...kpppppkttttttttkpppppk.....|
|..kppppppkkkkkkkkkkppppppk....|
|.kpppppppppppppppppppppppk....|
|.kaaaaaaaaaaaaaaaaaaaaaaak....|
|.ktttttttttttttttttttttttk....|
|.ktttttttttttttttttttttttk....|
|.ktttttttttttttttttttttttk....|
|.ktttttttttttttttttttttttk....|
|.kkkkkkkkkkkkkkkkkkkkkkkkk....|
]]}
P.bodyBack.implement = { 2, 21, [[
|....kkkkkkkkkkkkkkkkkkk....|
|...kmmmmmmmmmmmmmmmmmmmk...|
|..kmmmmmmmmmmmmmmmmmmmmmk..|
|.kmmmmkmmmmmmmmmmmmmkmmmmk.|
|kmmmmkkmmmmmmmmmmmmmkkmmmmk|
|kaaaakkmmmmmmmmmmmmmkkaaaak|
|ksssskkmmmmmmmmmmmmmkkssssk|
|.kssk.kmmmmmmmmmmmmmk.kssk.|
|..kk..kmmmmmmmmmmmmmk..kk..|
|......kkkkkkkkkkkkkkk......|
]]}
P.bodyBack.review = { 2, 18, [[
|.........ka.....ak.........|
|........kaak...kaak........|
|........kaaak.kaaak........|
|....kkkkkaaakkkaaakkkkk....|
|...kaaaaaaaakkkaaaaaaaaak..|
|..kaaaaaaaaaaaaaaaaaaaaaak.|
|.kaaacaaaaaaaaaaaaaaaacaaak|
|.kaaacaaaaaaaaaaaaaaaacaaak|
|.kaaacaaaaaaaaaaaaaaaacaaak|
|.kaaacaaaaaaaaaaaaaaaacaaak|
|.kcccccccccccccccccccccccck|
|.kaaacaaaaaaaaaaaaaaaacaaak|
|.kaaacaaaaaaaaaaaaaaaacaaak|
|.kkkkkkkkkkkkkkkkkkkkkkkkkk|
]]}

-- ---------- back props ----------
P.propBack = {}
-- lead: brick phone at right ear, antenna up past the head, sleeve to shoulder
P.propBack.lead = { 21, 0, [[
|...p....|
|...k....|
|...k....|
|...k....|
|...k....|
|...k....|
|...k....|
|...k....|
|..kkkk..|
|..kaak..|
|..kkkk..|
|..kaak..|
|..kaak..|
|.ksaak..|
|.ksssk..|
|.kssskk.|
|..kvvk..|
|...kvvk.|
|...kvvk.|
|...kvvk.|
|...kvvk.|
]]}
P.earsBack = {
 lead = { 6, 13, "|.k|\n|ks|\n|ks|\n|.k|" },
 implement = { 6, 13, "|.k|\n|ks|\n|ks|\n|.k|" },
}
P.earsBackR = {
 implement = { 23, 13, "|k.|\n|sk|\n|sk|\n|k.|" },
}
-- buddy headphones: cups + band drawn as stamps (band traced on the hair by hand)
P.phonesBack = {
 { 5, 12, [[
|.kkk.............kkk.|
|kpppk...........kpppk|
|kpmpk...........kpmpk|
|kpppk...........kpppk|
|kpppk...........kpppk|
|kpppk...........kpppk|
|.kkk.............kkk.|
]]},
 { 6, 6, [[
|.....aaaaaaa.....|
|...aa.......aa...|
|..a...........a..|
|.a.............a.|
|.a.............a.|
|a...............a|
]]},
}
-- implement: headband tails flapping out to the right
P.tailsBack = { 12, 16, [[
|..kmkmk..|
|..kmkkmk.|
|.kmk..kmk|
|.kk....kk|
]]}

return P
