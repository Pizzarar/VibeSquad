# VibeSquad UX review, round 14: context refs R1 re-review (idea-729)

Date: 2026-11-24 · Build: `unit-ui-ctxref-r1` @ `57778313` (round-2 fixes on top of `a3880e0b`), vite dev on `:5433`, run from the unit worktree.
Method: UX Reviewer (`docs/UX_REVIEW_PROCESS.md` §3A). I re-ran the R13 sequences in `?demo`, Normal mode, at 3200×1800, 1920×1080 (with reduced motion), 1280×720 and phone 390×844 (touch), in light and dark. Driven with Playwright.
Screenshots: `docs/ux-review-r14/` (untracked).

**Verdict at `57778313`: PASS 0/0/3** (critical/major/minor) for the chat context-ref area. Both R13 majors are fixed and all five R13 minors are fixed. The three new minors are side effects of the fixes and don't block. There were 0 page errors in every pass.

## Status vs round 13

| Item | Status | Evidence |
|---|---|---|
| R13-1 (major) "Open in Inbox" dead in Normal / phone | **fixed** | At all 3 desktop sizes and in both themes, the click lands on the project overview's **Idea Inbox (1)** tab (`.on`). `#inbox-card-idea-729` is on screen (y=346–460), the crumb reads "VibeSquad › Overview", and there is exactly one `.on` sidebar row (VibeSquad). It also works from the keyboard (Enter → Enter). Phone: the popover shows no "Open in Inbox" button (`btns=` empty), in both themes. `dark-1920-inbox`, `light-1920-inbox`, `light-390-tap1`. But the card highlight isn't visible → R14-1 |
| R13-2 (major) light links not visibly links | **fixed** | `text-decoration: underline dotted` at rest, in both themes. In light the tokens now read as links and stay quiet (`light-1920-ideahover`, `light-1280-ideahover`). Plain inline code (`@Art`) stays plain |
| R13-3 not-loaded no-op | **fixed** (for the demo path) | `msg:-20` with the history fully loaded reads "No earlier message", muted (dark `#b8afcb`, light `#4c4363`, opacity 1), with no button. I couldn't drive the `hasMore=true` load-then-jump path, because no demo agent has more history. `RefPopover.tsx:141+` re-resolves after the load |
| R13-4 keyboard can't reach the action | **fixed** (through Enter) | Focusing a link opens its popover, and Enter then moves focus to the "Jump to message" button (`inPop=true`, `light-1920-kbdfocus`). A second Enter jumps and flashes. Tab still goes on to the next link, which is acceptable now that Enter works. Focus handling after close → R14-3 |
| R13-5 popover detaches on scroll | **fixed** | Scrolling the timeline 120px with a popover open closes it at 1920 and 1280 in both themes (`RefPopover.tsx:122-125`, capture-phase scroll). At 3200 the timeline didn't scroll, because everything fits on screen, so that size wasn't tested |
| R13-6 Psycho tokens in Normal | **fixed** | Popover background is dark `rgb(34,29,47)` and light `rgb(240,237,245)`, matching Normal's surfaces. The mauve card is gone (`light-3200-ideahover`) |
| R13-7 smooth jump under reduced motion | **fixed** | `RefPopover.tsx:233` uses `"auto"` under `prefers-reduced-motion`. The Inbox scroll it triggers doesn't do the same → R14-1 |
| Hover / Esc / outside click / tap / clamping / 8-line clamp | stay fixed | Popover rectangles are identical to R13 at every size, and `scrollHeight == clientHeight`. Phone: tap opens, a second tap closes, an outside tap closes, and the right edge is at 386 of 390 |

## Findings

### R14-1 · minor · The "highlighted" Inbox card looks identical to an unhighlighted one in Normal, the class never clears, and the scroll ignores reduced motion
- **Job hurt:** 4, reviewing output. With one demo card this doesn't matter. With a real inbox of 20 or more cards, the owner lands in the list (the card is centred) with no cue for which card the ref meant.
- **Evidence:** the computed style of `#inbox-card-idea-729` is identical with and without `.highlighted`, in both themes: border, box-shadow, background and outline are all the same (dark border `rgb(239,234,247)`, shadow `none`). The class was still present after 8.5s.
- **Cause:**
  - `.inbox-card.highlighted` (`src/styles.css:2078`, specificity 0,2,0) loses to `html[data-vibe="boring"] .inbox-card` (`src/boring.css:301`, 0,2,1).
  - In `src/IdeaInbox.tsx:344-355`, the effect calls `clearFocusedInboxCard()`, which re-runs the effect, and the cleanup then `clearTimeout`s the 2s un-highlight. So the class sticks.
  - `:351` uses `behavior: "smooth"` unconditionally.
- **Fix:**
  - Add a `html[data-vibe="boring"] .inbox-card.highlighted` rule, for example a 2px `--accent` outline or an inset shadow; check it with @art.
  - Clear the focus id without re-triggering the cleanup: keep the timer in a ref, or clear it in a separate effect.
  - Reuse `reducedMotion()` for the scroll.
- **Files:** `src/boring.css`, `src/IdeaInbox.tsx`. **Effort:** XS.

### R14-2 · minor · Browser Back after "Open in Inbox" restores the URL but not the chat
- **Job hurt:** 4. This is the natural loop: hover a ref, open the card, go back to the chat. After Back the URL is `?team=vibesquad&agent=demo-aud`, but the screen stays on "VibeSquad › Overview" with VibeSquad `.on` and no chat (`dark-1920-back`). Forward then Back doesn't recover it either. The owner has to click the agent's row in the sidebar. Reloading the stale URL would open the chat, so the URL and the screen disagree.
- **Cause:** the new effect at `src/BoringAde.tsx:405-412` flips the local `mode` to `"project"`. On Back, `App.tsx:1660-1666` calls `openAgent("demo-aud")`, but that agent is already the active pane, so nothing sets `mode` back to `"chat"`. Normal's mode generally isn't URL-driven (clicking a project row from a chat doesn't push history at all), so this is partly an older gap. This unit is the first path that pushes a URL and then leaves `mode` stale.
- **Fix:** have BoringAde react to popstate (or to `activeAgentId` plus the URL's `agent=`) by setting `mode="chat"`. Or have "Open in Inbox" `replaceState` instead of push.
- **Files:** `src/BoringAde.tsx`, `src/App.tsx`. **Effort:** S. Likely owner lane: @bor (Normal routing), with @ui-bois for the trigger.

### R14-3 · minor · Keyboard focus falls to `<body>` when the popover closes with focus inside it
- **Evidence:** focus a link, press Enter (focus moves to "Jump to message"), press Enter again: it jumps and flashes, and `document.activeElement` is `BODY`. In one run, focusing the next link scroll-adjusted the timeline. The scroll-close then fired while focus was inside the popover, and focus again ended on `BODY` (Esc then had nothing to act on).
- **Cause:** `close()` doesn't restore focus. Only the Esc path calls `trigger.current?.focus()` (`src/RefPopover.tsx:119`). The new scroll-close (`:122`) and the button actions (`jumpToMessage`, `openInbox`) unmount the focused button.
- **Fix:** if focus is inside the popover when it closes, return focus to the trigger. For Jump, focus the target message instead (`tabIndex=-1` + `focus({preventScroll:true})`). Also ignore scroll events in the first ~100ms after a focus-open.
- **Files:** `src/RefPopover.tsx`. **Effort:** XS.

### Noted, not findings
- The idea popover's title still repeats the first words of the body. That comes from the card data, as in R13.
- I didn't verify the `hasMore=true` "Jump to load older → land" path in the real app, because the demo has no paged history. It's covered only by code reading and the unit tests.
- Carried and out of this area: R11-4, R8-5 (the crumb still reads "Worker"), R7-2.

## Owner decisions
None.
