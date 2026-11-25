# UX review R26: @bor B15 full-width Working-now strip (idea-918)

Reviewer: UX Reviewer (read-only). Branch `unit-bor-b15-worknow` @ `50b25a35`. Method per `docs/UX_REVIEW_PROCESS.md` §A.
(R20/R21 were taken in `docs/`; R22–R25 exist on other branches, so this is R26.)

Build: `vite build` of the branch, served statically, Snap-free Playwright Chromium. `?demo=1&riff=1&team=vibesquad`, with `agent=demo-lead-vs&crowd=1` (multi), `demo-impl-1` (single), `demo-aud` (needs-you). 1280x720 DPR 1, and 3200x1800 DPR 1.2 (3840x2160 px), dark and light. Decision-pin case: demo bundle patched so the Overlord's last message carries a `vs:decision` fence (test fixture only, not in the branch).

## Verdict: PASS, 0 critical / 0 major / 4 minor

## Measurements

| Check | Result |
|---|---|
| Strip height, 1280x720 | single 47px, multi 63px (drawer is 672px). |
| Conversation room left (timeline), 1280x720 | single 411px, multi 395px, i.e. 55–57% of the viewport. Pin pinned: 242px (see pin row). |
| Width | 990px at 1280 (spans chat + context panel), 2820px at 3200 CSS px. The "Context" side tab starts below the strip, so the strip really is full-width. |
| Bust buttons, a11y | Chips are `<button>`, 30px, `aria-label="Open <name>, <activity>"`, wrapped in `role=group aria-label="Other agents working"`. The strip is `role=status aria-live=polite`. Tab order: focal bust, 6 chips, then timeline. All show the 2px purple focus outline. |
| Click a bust | Chip #2 opened `demo-prov-opencode`; headline switched to "Implement - OpenCode · hooks is thinking". Works. |
| Single agent | Focal button is `disabled` when the focal is the open agent, so it leaves the tab order and has no empty-name stop. |
| Pin order | DecisionPin renders first in `.drawer` (`AgentDrawer.tsx:686`), strip after (`:687`). With a 142px pin: pin top 130, strip top 278, timeline 242px (34% of viewport). |
| Light WORKING NOW contrast | Rendered fg `rgb(189,82,12)` on sampled bg `rgb(251,249,247)` = **4.57:1** (worker hand-computed 4.71). Passes AA 4.5 for 11px text, narrowly. Dark: 8.58:1. |
| Psycho | `data-vibe="fun"` at 1600x1000: no `.boring-now` in DOM; shell layout unchanged. All new CSS is under `html[data-vibe="boring"]`. |
| Needs-you / pending perm | Strip is `display:none` when `data-has-perm` (perm stack stays in the chat column). `demo-aud` measures h=0. By design; see M4. |

## Findings

**Minor**

- **M1 (job: monitor).** The six chips use the same bust art for same-role agents (five identical robots in the multi shot), so they can only be told apart by hover title or screen reader. Identification is by tooltip only. Fix: a one-letter or provider initial badge, or an accessible visible label on hover/focus. `src/BoringWorkingNow.tsx` chip render, `src/boring.css` `.boring-now-chip`. Effort S.
- **M2 (a11y).** The last chip sits flush against the `.boring-now-chips` container, which has `overflow:hidden`, so the right half of its 2px focus ring and the warm glow are clipped (visible in focus crop). Fix: add `padding: 4px` (or `overflow:visible` plus the 55% max-width via flex) to the chips group. `boring.css` `.boring-now-chips`. Effort S.
- **M3 (a11y).** Light-theme label contrast is 4.57:1 for 11px text, only 0.07 over AA, with the 78% translucent strip over a tinted page. Any bg drift (the airbrushed sky variants) could dip under 4.5. Fix: darken `.boring-now-t` by one step in light (e.g. `#a8470a`), or measure on the sunset themes. Also the focal bust has no `aria-label` (name comes only from `title`). Effort S.
- **M4 (spec question, not a defect).** When a decision is pinned, the chrome stacks header, context bar, pin, strip and leaves 242px of conversation at 1280x720 (34%). Strip below the pin is acceptable: the pin is the actionable item and belongs first. But the Overlord's decision is also repeated in the transcript, and the strip hides while a perm is pending but not for a pin. Consider collapsing multi to the single-line form (47px) while a pin is showing. Owner decision: leave as is (recommended; the stacked case is transient), or add the collapse.

No critical or major findings. Strip height (47/63px) is reasonable and the one-line single form is a clear win over the old 68px bust card.

## Screens
Worker shots: `artifacts/boring-b15/`. Reviewer shots were kept out of the repo (scratch only). Raw numbers above came from `getBoundingClientRect` and a rendered pixel sample, not from the diff.
