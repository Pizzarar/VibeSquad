-- A0 Squad-header quick-chips (docs/PLAN_PROJECT_CHIPS_WORKFLOWS.md A0). Same cell + rules as
-- the S2b-2 icons (art/ui/icons-s2b/icons-big.lua): 16 native shown at calc(var(--u3-px) * 16)
-- = 32 device px (1 icon px = 1 kit px), 32 master = @2x, 1:1 on device px at 4K@120%.
-- build.lua adds the 1px INK outline + INK hard shadow (+1 at 16 / +2 at 32).
-- Key = lib.lua L.KEY: k INK, v VIOLET, p PINK, c CORAL, a AMBER, m MARBLE, t TEAL, g MINT
-- Entry = ASCII string (centred in the cell) or { art, x, y } (fill origin, 0-based).
local C = {}

-- ============================================================ Bugs � Hypnospace cockroach
-- ONE bug icon app-wide (docs/PLAN_BUG_CHIP.md BC-art): the chip is the .bug-btn roach's idle
-- frame, drawn in art/ui/bug-roach/roach.lua. Its stalk-eyes stay at x<=8 (16) / x<=18 (32), so
-- the top-right badge dot (outline from x9 / x19) never covers an eye (Director R1 #1).
local R = dofile(app.params.root.."/art/ui/bug-roach/roach.lua")
C.bugs = R.idle

-- ============================================================ Workflows · experiment flask
-- Erlenmeyer flask (the Workflows lane = hypotheses + experiments): CORAL cork, MARBLE glass,
-- MINT brew with a TEAL surface, MARBLE bubbles, one bubble escaping above the cork.
C.workflows = {
[16] = [[
......m....
...........
...ccccc...
....mmm....
....mmm....
...mmmmm...
..mmmmmmm..
..ttttttt..
.ggmggggmg.
.gggggmggg.
ggmgggggggg
ggggggggmgg
]],
[32] = [[
...............mm........
...............mm........
.........................
.......cccccccccc........
.......cccccccccc........
.........mmmmmm..........
.........mmmmmm..........
.........mtmmmm..........
.........mtmmmm..........
.........mtmmmm..........
........mmmmmmmm.........
.......mmmmmmmmmm........
......mmmmmmmmmmmm.......
.....mmmmmmmmmmmmmm......
....tttttttttttttttt.....
...tttttttttttttttttt....
...ggggggggggggggggggg...
..ggggggmmgggggggggggg...
..ggggggmmggggggggggggg..
.ggggggggggggggmmgggggg..
.ggggggggggggggmmggggggg.
gggggmmggggggggggggggggg.
gggggmmggggggggggmmgggggg
gggggggggggmmggggmmgggggg
gggggggggggmmgggggggggggg
]],
}

-- ============================================================ Badge · lead running dot
-- One solid MINT dot in the cell's top-right corner: same 16/32 box as the chips, so the
-- UI stacks it on the chip <img> with no extra layout.
C.dot = {
[16] = { [[
.gg.
gggg
gggg
.gg.
]], 10, 1 },
[32] = { [[
..gggg..
.gggggg.
gggggggg
gggggggg
gggggggg
gggggggg
.gggggg.
..gggg..
]], 20, 2 },
}

C.ORDER = { "bugs", "workflows", "dot" }
return C
