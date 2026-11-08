-- S2b-2 shipping icons (owner picked candidate 1: mini tower + 2-CRT desk pod, "needs to be
-- bigger"). Redrawn to fill the cell: the 16 native is shown at calc(var(--u3-px) * 16) =
-- 32 device px on the 22-kit-px focus bar (both 1080 and 4K@120%), so 1 icon px = 1 kit px,
-- and the 32 master (@2x) lands 1:1 on device pixels at 4K. Same key/outline/shadow rules as
-- icons.lua (build-big.lua adds the 1px INK outline + INK hard shadow, +1 at 16 / +2 at 32).
-- Key = lib.lua L.KEY: k INK, p PINK, c CORAL, a AMBER, m MARBLE, t TEAL, g MINT
local I = {}

local function B(s) local t = {} for r in s:gmatch("[^\n]+") do t[#t+1] = r end return t end
local function place(parts)
  local W, H = 0, 0
  for _, p in ipairs(parts) do
    for _, row in ipairs(p[1]) do W = math.max(W, p[2] + #row) end
    H = math.max(H, p[3] + #p[1])
  end
  local g = {}
  for y=1,H do g[y] = {} for x=1,W do g[y][x] = "." end end
  for _, p in ipairs(parts) do
    for r, row in ipairs(p[1]) do for i=1,#row do
      local ch = row:sub(i, i)
      if ch ~= "." then g[p[3]+r][p[2]+i] = ch end
    end end
  end
  local out = {}
  for y=1,H do out[y] = table.concat(g[y]) end
  return table.concat(out, "\n")
end

-- ============================================================ Squads · mini tower
-- Narrow MARBLE tower (reads as a tower, not a house) with 3 floors of AMBER lit windows (one PINK "needs you", one dark), INK door,
-- PINK eaved roof, bent mast with an AMBER blinker, TEAL plinth.
I.squads = {
[16] = [[
......a....
.....m.....
...ppppp...
.ppppppppp.
..maamaam..
..mmmmmmm..
..maamppm..
..mmmmmmm..
..mkkmaam..
..mmmmmmm..
..mmmkmmm..
..mmmkmmm..
ttttttttttt
]],
[32] = place({
  { B[[
.a.
aaa
.a.
.m.
m..
]], 10, 0 },
  { B[[
....pppppppppp....
..pppppppppppppp..
pppppppppppppppppp
kkkkkkkkkkkkkkkkkk
]], 1, 5 },
  { B[[
mmmmmmmmmmmmmm
mmaaaammaaaamm
mmaaaammaaaamm
mmkkkkmmkkkkmm
mmmmmmmmmmmmmm
mmaaaammppppmm
mmaaaammppppmm
mmkkkkmmkkkkmm
mmmmmmmmmmmmmm
mmkkkkmmaaaamm
mmkkkkmmaaaamm
mmkkkkmmkkkkmm
mmmmmmmmmmmmmm
mmmmmkkkkmmmmm
mmmmmkkkkmmmmm
mmmmmkkkkmmmmm
mmmmmkkkkmmmmm
]], 3, 9 },
  { B[[
tttttttttttttttttttt
tttttttttttttttttttt
]], 0, 26 },
}),
}

-- ============================================================ Teams · 2-CRT desk pod
-- Two chunky MARBLE CRTs (TEAL text screen, PINK googly-face screen: left eye small, right
-- eye bigger and 1px higher) with AMBER power LEDs, on an AMBER desk.
local CRT_L = B[[
mmmmmmmmmmmmm
mtttttttttttm
mtggggggttttm
mtttttttttttm
mtgggggggggtm
mtttttttttttm
mtggggttttttm
mtttttttttttm
mtgggggggtttm
mtttttttttttm
mtggatttttttm
mtttttttttttm
mmmmmmmmmmmmm
mmmmmmmmmmamm
mmmmmmmmmmmmm
]]
local CRT_R = B[[
mmmmmmmmmmmmm
mpppppppppppm
mpppppppmmmpm
mppmmpppmmkpm
mppmkpppmkkpm
mpppppppppppm
mpppppppppppm
mpkpppppppkpm
mppkkkkkkkppm
mpppkkcckpppm
mpppppppppppm
mpppppppppppm
mmmmmmmmmmmmm
mmmmmmmmmmamm
mmmmmmmmmmmmm
]]
local NECK = B[[
....mmmmm....
...mmmmmmm...
]]
I.teams = {
[16] = [[
mmmmmm.mmmmmm
mttttm.mppmmm
mtggtm.mkpmkm
mttttm.mppppm
mtgttm.mpkkpm
mttttm.mppppm
mmmmam.mmmmam
..mm.....mm..
aaaaaaaaaaaaa
aaaaaaaaaaaaa
.a.........a.
.a.........a.
.a.........a.
]],
[32] = place({
  { CRT_L, 0, 0 }, { CRT_R, 14, 0 },
  { NECK, 0, 15 }, { NECK, 14, 15 },
  { B[[
aaaaaaaaaaaaaaaaaaaaaaaaaaa
aaaaaaaaaaaaaaaaaaaaaaaaaaa
.aa.....................aa.
.aa.....................aa.
.aa.....................aa.
.aa.....................aa.
.aa.....................aa.
.aa.....................aa.
]], 0, 17 },
}),
}

I.ORDER = { "squads", "teams" }
return I
