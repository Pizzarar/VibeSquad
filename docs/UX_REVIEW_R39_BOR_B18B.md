# UX Review R39: @bor B18b composer bar (container-aware, ≤2 rows, no orphaned Mode)

Scope: `e476f89e..1b62f86b`, which changes `src/BoringComposerBar.tsx` (adds the `.boring-composer-pair` Think+Mode wrapper and moves `providerSwitchBtn` out of the cfg group) and `src/boring.css:1562-1574` (the `boring-composer` size container, 172/112/108px caps, and a `@container (max-width: 680px)` reflow). This round checks the origin findings in `docs/UX_REVIEW_R30_BOR_B16.md` (L2, L5).

Evidence: I ran `vite build` at `1b62f86b` into a separate outDir (the bundle has the nested `@container boring-composer (width<=680px)` flattened correctly) and served it as static files. I drove it with Playwright on Chromium at `?demo=1`, opening `demo-aud` (a running Gemini worker with a pending permission card and a pinned todo). Each scenario used a fresh context:
- 1280x720 with the ctx panel open and collapsed
- 1920x1080 with the ctx panel open
- 3200x1800@1.2 (4K at 120%) with the ctx panel open and collapsed
- splits at 1280x720 (447px panes), 1400x800 (507px), 1920x1080 (758px), 2560x1440 (981px) and 3200x1800@1.2 (1269px)

I ran all of these in dark and light: 20 runs and 30 composer bars, with 0 page errors. Shots are in `artifacts/boring-b18/ux-r39/` (untracked, like the lane shots): `<theme>-<scenario>.png`, the per-bar crops `-bar0/1.png`, the longest-option renders `longest-*.png`, and the keyboard runs `kb-*.png`. `node --test test/bor-b16-composer.test.mjs` gives 11 pass, 0 fail.

## Status vs R30

| R30 | Now | Evidence |
|---|---|---|
| L2: 3 rows at 1280x720 with the ctx panel open | **Fixed** | 482px card: 2 rows (row 1 = Provider, Model, Think, Mode; row 2 = 📎 🔒 ⇄Switch, then ■ / Interrupt & send / Queue on the right). The bar is 79px tall. `dark-1280x720-ctxopen-bar0.png` |
| L5: Mode wraps alone at ~550px, even at 4K | **Fixed** | Think and Mode share a row in all 30 bars, and Mode is never alone on a row. At 4K (1680px card, ctx open and collapsed) and in the 1269px split the bar is 1 row, 41px. At 507px and 981px it is ≤2 rows. |

## Row counts (same in dark and light)

| Composer width | Rows | Layout |
|---|---|---|
| 482 (1280 ctx open) | 2 | cfg / actions + send |
| 880 (1280 ctx collapsed) | 2 | actions + cfg + switch / send group |
| 1038 (1920 ctx open), 1680 (4K) | 1 | — |
| 447 (1280x720 split) | **4** left (running), **3** right | provider+model / Think+Mode / 📎🔒⇄ / ■ Interrupt Queue (see L2) |
| 507 (1400x800 split) | 2 | cfg / actions + send |
| 758 (1920 split) | 2 | actions + cfg / ⇄Switch … send |
| 981 (2560 split) | 2 left (running), 1 right | cfg + switch / send group |
| 1269 (4K split) | 1 | — |

## Findings

No critical or major findings.

| # | Sev | Finding | Job hurt | Evidence | Fix | Files | Effort |
|---|---|---|---|---|---|---|---|
| L1 | Minor | **The new caps clip the values that matter, even on a wide bar, and no tooltip gives the full value.** The 108px Mode cap applies at every width. At 4K, with ~780 CSS px of empty bar, `Bypass Perms` renders as `Bypass Perm`. At 1280 ctx-open it renders as `Bypass Per`, and `Accept Edits` also clips. At narrow widths the Model select is the shrinkable item (`flex: 1 1 80px`), so it gives up width while Think keeps slack: `low` sits in a 96px box. At the 482 and 507px widths the model reads `gemini-4-ne` / `claude-son…`, so `claude-sonnet-5-5` and `claude-sonnet-4-6` render identically. The Model `title` is `Model (claude)` and the Mode `title` is `Mode (Shift+Tab cycles)`; neither shows the value. Before B18b, the 240px cap let the 4K bar show full values. | Seeing which model and permission mode an agent runs on without opening the dropdown | `longest-dark-3200.png` (`Bypass Perm` at 4K), `longest-dark-1280.png` (`claude-son…`, `Bypass Per`), `dark-1280x720-ctxopen-bar0.png`; measured text vs box: `claude-sonnet-5-5` 109 > 70px, `Bypass Perms` 83 > 80px at 4K | (a) Move the 172/112/108 caps inside the `@container (max-width: 680px)` block so wide bars size to content. (b) In the narrow block, make Think/Mode `width: auto; max-width: none` (their values are short) and give Model `flex: 1 0 auto; min-width: min(17ch, 100%)` so Think and the labels shrink first. (c) Add the current value to the titles: `Model: ${modelValue} (${provider})` and `Mode: ${label} (Shift+Tab cycles)`. | `src/boring.css:1567-1569,1574`; `src/useAgentConfig.tsx` (model/mode `title`) | XS |
| L2 | Minor | **At 1280x720 in split (447px panes) the bar is 4 rows (3 in the idle pane), not ≤2.** The plan targets ≤2 rows for any width ≤620. Provider + Model + Think + Mode needs about 450px, so the Think/Mode pair wraps (it stays paired, which is the L5 intent). The ⇄Switch pill then pushes the send group onto a 4th row. The bar is 155px tall in a 720px window. | Chatting in two panes on a laptop-size window | `dark-1280x720-split-bar0.png`, `light-1280x720-split-bar1.png` | Below about 480px: render ⇄Switch icon-only (keep `title`/`aria-label`), and/or hide the visible `Think`/`Mode` text labels (keep the a11y names) so the cfg fits one row. Or accept 3 rows at this rare size. | `src/boring.css` (a `max-width: 480px` container block) | XS |
| L3 | Minor | **Focus order no longer follows visual order in the ≤680px layout.** CSS `order` puts cfg on row 1, but Tab goes 📎 → 🔒 (row 2), then Provider → Model → Think → Mode (row 1), then back to ⇄Switch → ■ (row 2). The DOM order is unchanged from before (the moved switch button keeps its Tab position after Mode), so only the narrow reflow is out of step. This is WCAG 2.4.3 territory, but the jump is small and predictable. | Keyboard-driven composer use at narrow widths | Playwright Tab sequence at 1280 ctx-open: `attach > secret > provider > model > thinking > mode > switch-provider > stop > (out)`, and the same at 4K, where it matches the visuals. Disabled Interrupt/Queue are skipped as expected. | Leave as is, or move `.boring-composer-actions` after `.boring-composer-cfg` in the DOM and give actions `order: -1` only in the wide layout, so the DOM order matches the narrow (keyboard-heavy) layout. | `src/BoringComposerBar.tsx`, `src/boring.css` | XS |

Nit N1: at 758px (1920 split) `⇄ Switch to Claude` wraps alone to the left of row 2, opposite the send group. It reads as an action, not an orphan. No change needed.

## Checked, no issue
- **Mode orphan / pairing:** Think and Mode stayed in the same row in all 30 bars, and Mode was never alone on a row.
- **Clipping out of the card:** 0 controls outside the composer card. No button text clips (`scrollWidth ≤ clientWidth` for every button). No overlaps.
- **Send placement:** Send/Queue is always the right-most control of the last row, 11px from the card edge, at every width. Stop and Interrupt stay grouped with it.
- **B17 measure:** at every width, the permission card and pinned todo have exactly the same left and right edges as the composer card. Examples: 1280 ctx-open is 314/796 for all three, 4K collapsed is 932/2612, the 2560 split left pane is 434/1415, and the right panes match the todo.
- **Switch button move:** its Tab position is unchanged (after Mode). The `.boring-composer-bar > .btn.small` styling matches the old `.boring-composer-cfg .btn.small` (32px tall, 12px text).
- **Dark/light:** the light theme pill, Stop and Interrupt contrast look as they did in R30. Nothing is unreadable in either theme.
- **Psycho:** untouched, since the rules are scoped to `html[data-vibe="boring"]` and the existing Psycho test still passes.

## Owner decisions
None. L2's "accept 3 rows at 447px" is a lane call, not an owner call.

## Verdict
0 critical, 0 major, 3 minor (L1 model/mode value clipping with no value tooltip, L2 4 rows at 447px split, L3 narrow focus order). R30 L2 and L5 are closed. I recommend fixing L1 before the next round because it shows on the owner's 4K screen (`Bypass Perm`).

PASS 0/0/3 1b62f86b
