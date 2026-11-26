# UX Review R43: @bor idea-1062 (Normal-mode ui:overlap fixes)

- **Tip:** `07c544a6` on `bor-1062-overlap`. `20b5210b` on top adds worker screenshots only.
- **Base:** `b9809103`.
- **Previous round for this area:** `docs/UX_REVIEW_R42_BOR_B18_MERGE.md` (PASS, 3 minors, none touched here).
- **Scope:** a focused pass on three changes:
  - the collapsed context-panel rail badge (`--on-accent` text);
  - Trinity tile padding and name size (`8px 1px 6px`, 11px with -0.02em tracking, grid gap 6→4, card padding `6px 5px`);
  - the Normal timeline allowlist entry in `scripts/ui-overlap/allowlist.json`. This is test config only, with no UI effect.

## Method
- **Builds:** `npx vite build` of the tip into `/tmp/uxr43/dist`. For an A/B comparison I also built the base (`git archive b9809103`) into `/tmp/uxr43/distbase`. Both builds were served as static files.
- **App setup:** Playwright Chromium, `?demo=1`, Normal mode, with R42's multi-project registry (VibeSquad Main, Main Game, Plugins, Site).
- **Sizes and themes:** 1280x720, 1920x1080, 2560x1440 and 3200x1800 @1.2 DPR (4K@120%), each in dark and light. That is 8 combos per build, with a fresh context for each.
- **Per combo:**
  1. Measure the Trinity tiles: `scrollWidth`/`clientWidth` of the name, computed font, and padding.
  2. Measure sidebar geometry: pin, tree, Trinity, grid and footer rects.
  3. Open the `Audit - token scout` worker and collapse the context panel.
  4. Read the rail badge's computed colours (the demo's worst state is `st-err`, n=2).
  5. Swap the class to `st-attn` and read it again.
- **Scripts:** `/tmp/uxr43/probe.mjs` and `shot2.mjs`. Raw output is in `/tmp/uxr43/{tip,base}.p.json`. There were 0 page errors in both builds.
- **Shots:** `docs/shots/ux-r43-bor-1062/` (`BASE-*` = before).

## Status

| Check | Base `b9809103` | Tip `07c544a6` | Evidence |
|---|---|---|---|
| Rail badge, dark, `st-attn` | **#fff on #ffc15e = 1.61:1.** The digit is barely visible. | **#14111c on #ffc15e = 11.58:1** | `BASE-rail-attn-1280-dark.png` vs `rail-attn-1280-dark.png` |
| Rail badge, dark, `st-err` | #fff on #ff7f93 = 2.41:1 | **#14111c on #ff7f93 = 7.73:1** | `rail-1280-dark.png`, `rail-1920-dark.png` |
| Rail badge, light, err / attn | #fff on #b9264e / #8a5700 = 6.09 / 6.10 | Unchanged: `--on-accent` is #fff in light | `rail-1280-light.png`, `rail-3200-light.png`, `rail-attn-1920-light.png` |
| Badge alert feel | — | **Holds.** The badge keeps the saturated pink/amber fill at the top of the rail. Dark text on a warm fill reads like the other Normal badges (`.boring-badge` already uses `--on-accent` on `--st-attn`, `src/boring.css:752`), so the system is now consistent. | `rail-attn-3200-dark.png` |
| `★ Overlord` fits, 1280 | **Clipped:** scrollW 77 > clientW 65, shows "★ Over…" | **Fits:** 66 ≤ 66 | `BASE-trinity-1280-light.png` vs `trinity-1280-light.png` |
| `★ Overlord` fits, 1920 | Clipped: 77 > 71 | Fits: 66 ≤ 66 | `trinity-1920-dark.png` |
| `★ Overlord` fits, 2560 / 4K | Fit: 77 ≤ 77 at 12.5px | Fits at 11px | `trinity-2560-light.png`, `trinity-3200-*.png` |
| Tile symmetry | 69 / 74.7 / 99px tiles, padding `8px 2px 6px` | **3 equal tiles at every size:** 71.7 / 77.4 / 101.7px, all 114px tall, padding `8px 1px 6px`. Busts and names are centred, and the captions ("no agent", 49px) fit. | `trinity-*.png` |
| Name readable at 4K@120% (11px with -0.02em tracking = 13.2 device px) | — | **Readable** in dark and light, with no glyph collisions at -0.22px tracking. The name stays bold and `--text-1`, so it still outranks the caption. See m1 for the narrower size hierarchy. | `trinity-3200-dark.png`, `trinity-3200-light.png` |
| Sidebar layout shift / O2 floors | pin 60, tree 120 (1280) / 289 / 649 / 1009; footer 79 | **Identical** pin, tree, Trinity and footer rects at all 8 combos, before and after opening an agent. Only the grid width changes (+4px, from the gap and card padding). | `{tip,base}.p.json` `side` / `after` |
| Timeline allowlist | — | Selector is scoped to `^normal-lane` `div.drawer-shell > … > div.timeline`, with the same rationale as the existing `sky-riff` entry. Scrollback is not compactable, so I agree. | `scripts/ui-overlap/allowlist.json:85-90` |

## Findings

No critical or major findings.

| # | Sev | Finding | Job hurt | Evidence | Fix | Files | Effort |
|---|---|---|---|---|---|---|---|
| m1 | Minor | **The name/caption hierarchy is flattened at every width, but only narrow widths needed the shrink.** The tile name went from 12.5px to 11px globally. The caption is also 11px (`src/boring.css:1342`), so name and caption are now the same size and differ only by weight and colour. The base already fit `★ Overlord` at 2560 and at 4K@120% (77 ≤ 77). There the tiles are 101.7px wide and the name uses 66px, so the drop on the owner's main screen was not needed. It is still readable, so this is polish, not a blocker. | Scan the Desk at a glance on 4K: who is who vs what state | `trinity-3200-dark.png` vs `BASE` metrics in `base.p.json` (2560/3200 `n77/77`) | Keep 11px/-0.02em only where the tile is narrow. For example, make `.boring-desk-grid` a size container and use `@container (min-width: 280px) { .boring-mate-name { font-size: 12.5px; letter-spacing: 0 } }`. A simpler option is `font-size: clamp(11px, 3.6cqi, 12.5px)`. Extend the existing browser test to 2560 and 4K. | `src/boring.css`, `test/bor-b18-visual.test.mjs` | XS |

### Noted, not new (unchanged from base)
- **1280x720 sidebar:** the whole sidebar scrolls. The Needs-you list (5 cards) pushes the Projects section and the Desk tiles below the fold (`sidebar-1280-dark.png`). Base and tip are pixel-identical in geometry, so this unit did not cause it. It is already covered by the O2 floor work and is not re-raised here.
- **Rail badge font size:** it computes to 13px, not the declared 11px (`font: 600 11px/18px` is overridden by a later rule). The number still fits the 18x18 box at all sizes. This is cosmetic; I have not traced the cause.

## Owner decisions
None.

PASS 0/0/1 07c544a6
