# UX Review PER_R1D: R1 roles-only pickers, round 4 (@per)

- Code under review: `unit-per-r1-integ` @ `6e21d4bf`, fix r3 fast-forwarded from `958b6ee9`. Previous round: `docs/UX_REVIEW_PER_R1C.md` (FAIL 0/1/3 on 958b6ee9).
- Run: `vite` on the integ worktree, `?demo=1`, Normal mode (`app.vibe=boring`), 3200x1800 @ dsf 1.2 and 1920x1080, dark and light. Shots are in `docs/ux-per-r1d/` (`d`/`l` = dark/light, then width). Contrast is WCAG 2.x relative luminance, computed in the page on every visible `.def-badge`; translucent backgrounds are composited over their ancestors. No page errors. `node --test test/r1-fix-ui-r2-spawn.test.mjs`: 10/10 pass.

**Verdict: PASS 0/0/0 6e21d4bf**

## Status vs PER_R1C

| PER_R1C finding | Status | Evidence |
|---|---|---|
| M1 dark badge values 1.4:1 | **Fixed** | `src/boring.css:1186` `html[data-vibe="boring"] .def-badge.def-badge { color: var(--text-1) !important }`. New Agent and Add Buddy badge values in dark (3200 and 1920): `rgb(243,241,247)` on `rgb(38,38,50)` = **13.33:1**. Key (`<b>`, `--muted`) = 8.37:1. Light: `rgb(29,26,36)` on `rgb(230,227,221)` = **13.38:1**, key 7.18:1 (`d3200-newagent-override.png`, `d1920-newagent-review-gemini.png`, `l3200-newagent.png`). |
| m1 Add Buddy shows no resolved model | **Fixed** | `add-buddy-badges`: `provider/model Claude/claude-opus-5-5 · via ladder · stakes normal`. With the override set to Gemini · gemini-4-neon it reads `Gemini/gemini-4-neon · via override`. Reset brings back `via ladder`, and tierA-invariant reads `stakes tierA-invariant`. Same at all four size/theme combos, incl. **3200 light** (`l3200-addbuddy.png`, `*-addbuddy-tierA.png`). |
| m2 New Agent labels preview omits sent labels | **Fixed** | Chips now include `stakes=normal`, and with an override `vs.route-override=provider=antigravity-cli model=gemini-4-neon`. The submit path sends the same `labels` object (`TeamActions.tsx` `labels = roleSpawn ? { ...baseLabels, ...roleSpawn.labels } : baseLabels`; submit `labels,`). It matches Add Buddy. |
| m3 raw provider ids | **Fixed** | Override groups: `Claude` / `Gemini` / `OpenCode`, with rows `Claude · ladder rung` and so on (`*-newagent-override.png`). Badge `Gemini/gemini-4-neon`. Values and labels still use the ids (`provider=antigravity-cli`), which is correct for the machine fields. |

## Leak check: other `.def-badge` uses

The new rule is scoped to `html[data-vibe="boring"]`, so fun mode keeps its pastel-ink rule (`styles.css:6163`) unchanged. Other boring-mode users:
- **Settings > Profiles > Legacy agent profiles** (`TeamSettingsModal.tsx:699-708`): measured 54 badges. Dark: min 14.33:1 (`rgb(243,241,247)` on `rgb(17,35,43)`), key min 8.99:1. Light: min 10.00:1 (`rgb(29,26,36)` on `rgb(196,196,207)`), key min 5.37:1. All ≥ 4.5 (`*-set-legacy.png`).
- **Runner settings offered models and usage rows** (`RunnerSettingsSection.tsx:103/132/135`): these don't render in `?demo` (no runner data), so I couldn't measure them. They get the same rule on the same panel tokens, so they should read like the New Agent badges (`--text-1` on a panel). Not a finding, but worth a glance on a live runner.
- There are no other `.def-badge` users (`grep -rn def-badge src`).

## Findings
None.

## Owner decisions
None.
