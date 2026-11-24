# VibeSquad UX review, round 13: context refs R1 (idea-729), `msg:-N` / `idea-N` links + popover

Date: 2026-11-24 · Build: `unit-ui-ctxref-r1` @ `1b436c1a` (R1 `82c8b752` + demo fixtures `1b436c1a`), vite dev on `:5433`, run from the unit worktree.
Method: UX Reviewer (`docs/UX_REVIEW_PROCESS.md` §3A). `?demo`, Normal mode (default). Viewports 3200×1800 (4K at 120%), 1920×1080, 1280×720, phone 390×844 (touch, coarse pointer), light and dark. Psycho spot check at 1920 dark. Driven with Playwright. I read the plan (`docs/PLAN_CONTEXT_REFS.md`) only after the first pass.
Screenshots: `docs/ux-review-r13/` (untracked). The file names below refer to that folder.

**Fixtures:** they're present at `1b436c1a`. Every non-agy demo agent's timeline ends with three replies: "Rechecking `msg:-1` above." / "That's `idea-729`; `idea-999` is gone." / "`msg:-20` predates the loaded history." (`src/demo.tsx`). A parked `idea-729` card is seeded on the first inbox read (`src/IdeaInbox.tsx`). I tested on desktop with `?agent=demo-aud`. On the phone I used `?team=vibesquad` → Overlord tab, because the phone shell ignores `?agent=` and lands on EFI (that's existing phone routing, not this unit).

**Verdict at `1b436c1a`: FAIL 0/2/5** (critical/major/minor) for the chat context-ref area. Parsing, hover timing, focus, Esc, outside-click, tap-toggle, viewport clamping and flipping, the 8-line clamp and "Jump to message" all work at every size and in both themes. "Open in Inbox" does nothing in Normal mode (or on the phone), and in light theme the links don't look like links at rest.

## Status vs round 12

R12 covered the sidebar folders and Wake/Back, a different area from this one. Nothing in this diff touches them. R11-4 (native `alert` on folder failure), R8-5 (worker crumb "Worker") and R7-2 (1080 reason clamp) are carried over unchanged and weren't re-tested in this round. All the findings below are new.

## Context-ref checks

| Check | Result | Evidence |
|---|---|---|
| Tokens render as links (4 per timeline), and plain inline code (`@Art`) stays plain | ✓ `<code class="tl-icode tl-ref-link" role="button" tabindex=0 aria-haspopup=dialog>`, cursor pointer, underline on hover | all |
| Visibly a link but quiet in prose | **dark ✓ / light ✗.** Dark: `#9b72e8` against prose `#efeaf7`, a clear violet hue. Light: `#442b74` against prose `#1f1830` is **1.5:1** with no underline at rest, so it reads as ordinary monospace. It is actually *darker* than plain inline code (`#6f6787`) → **R13-2** | `light-1280-hover2`, `light-390-tap1` |
| Hover opens after ~250ms, and a brief pass doesn't open | ✓ Not open at 150ms, open at 500ms. A 120ms hover-then-leave never opens | none |
| Focus opens, Esc closes and keeps focus on the link, outside click closes | ✓ in both themes. Focus ring: 2px solid accent | `light-1920-focus` |
| Keyboard can reach the popover's button | ✗ Tab goes from the link to the next link and opens *its* popover. "Jump to message" / "Open in Inbox" can't be reached from the keyboard → **R13-4** | none |
| Phone: tap opens, a second tap closes, an outside tap closes | ✓ for all 4 tokens, dark and light, at 390×844 | `light-390-tap1` |
| Never clipped | ✓ 3200/1920/1280: the popover sits under its token. At 1280 with the token 105px above the composer, it flips above (pop 416→594, token at y=598). 700px wide: clamped to right=696. Phone: right edge 386 of 390 | `dark-1280-flip` |
| Compact: 8-line clamp, no scroll | ✓ `scrollHeight == clientHeight` in every case. msg 134px, idea 178px, not-found/not-loaded 38px, width 320px | `dark-3200-hover0`, `light-3200-hover1` |
| "Jump to message" lands | ✓ It scrolls to "Dispatching Art Painter…" and flashes it (`.tl-flash`, centred) | `dark-1920-jump` |
| "Open in Inbox" lands | ✗ **Nothing happens** in Normal at 1920, in both themes, or on the phone. The URL and view are unchanged and no inbox appears → **R13-1** | `dark-1920-inbox`, `dark-390-openinbox` |
| Not-loaded state is readable and muted by colour | ✓ "Not loaded — Jump to load older", `--muted` (dark `#b8afcb` on `#140c26`, light `#4c4363` on `#e0d1dc`, 6.3:1), opacity 1. **But the action is a no-op here** → **R13-3** | `dark-3200-hover3` |
| Card-not-found readable and muted | ✓ "Card not found", same muted colour | `light-1280-hover2` |
| Popover follows its anchor | ✗ It stays put when the timeline scrolls under it (link moved 150px, popover stayed at y=339) → **R13-5** | `dark-1280-scrollopen` |
| Chrome readability, no surreal touches on chrome | ✓ No art and no surreal touches. The light surface is off-palette for Normal → **R13-6** | `light-3200-hover1` |
| Psycho inherits | ✓ `data-vibe=fun`: 4 links, and the popover opens and places correctly | `psycho-1920-hover` |
| Console / page errors | 0 page errors in any pass (only the existing demo read-only token banner) | none |
| Whole-window invariants (Needs-you 5 = sidebar list, one `.on` row, crumb = open agent) | ✓ unchanged by this diff. The Needs you list shows 5 items, Audit - token scout is the only `.on` row, and the crumb reads VibeSquad › Desk › Worker (R8-5, carried) | `dark-1920-inbox` |

## Findings

### R13-1 · major · "Open in Inbox" is a dead button in Normal mode and on the phone
- **Job hurt:** 4, reviewing output (and the plan's whole point: "the owner hovers/taps it for the full text", then goes to the card to act on it). The owner hovers `idea-729`, clicks the only action the popover offers, and nothing happens: no navigation and no feedback.
- **Evidence:** `dark-1920-inbox`: after the click the view is still the Audit chat and the URL is unchanged. Phone: `dark-390-openinbox` shows the same.
- **Cause:** `RefPopover.tsx:189-192` → `openAndScrollToInbox()` (`src/IdeaInbox.tsx:120-130`) only sets the Psycho inbox-open flag and scrolls to `[data-testid="idea-inbox"]`. In Normal, the inbox is the project overview's "Idea Inbox" tab, driven by local state `overviewTab` (`src/BoringAde.tsx:402`, `:1011`, `:1051`). That tab only renders on the overview, never while a chat is open, and nothing in BoringAde listens to the inbox-open store. The phone shell has no inbox surface at all.
- **Fix:** in Normal, have the action navigate to the card's project overview with `overviewTab="inbox"` and scroll to or flash that card. A small store (`focusInboxCard(id)`) that BoringAde subscribes to would do it. On the phone, either open the same card in a sheet or hide the button. Pass the card id, not just "open inbox".
- **Files:** `src/RefPopover.tsx`, `src/IdeaInbox.tsx`, `src/BoringAde.tsx` (+ the phone shell). **Effort:** S–M. **Lane:** @ui-bois (coordinate with @bor on BoringAde).

### R13-2 · major · Light theme: ref links don't look like links at rest
- **Job hurt:** 4, reviewing output. The feature only pays off if the owner notices they can hover. In light theme the tokens look like ordinary monospace, and the only affordance is the cursor and underline that appear on hover.
- **Evidence:** the link `#442b74` against surrounding prose `#1f1830` measures **1.50:1** (the usual floor for colour-only link cues is 3:1), and there's no underline at rest. Plain inline code is `#6f6787`, so a ref link reads as *darker* code, not as a link (`light-1280-hover2`, `light-390-tap1`). Dark passes visually (`#9b72e8` vs `#efeaf7`, a clear hue shift at 2.98:1).
- **Cause:** `src/styles.css:4128-4129`: `color: var(--cyan-t)` only. The underline appears on `:hover` only.
- **Fix:** add a quiet non-colour cue at rest that works in both themes, for example `text-decoration: underline dotted; text-decoration-color: var(--muted); text-underline-offset: 2px`, going solid on hover/focus. Keep the colour.
- **Files:** `src/styles.css` (or a `html[data-vibe="boring"]` rule in `src/boring.css`). **Effort:** XS.

### R13-3 · minor · "Not loaded — Jump to load older" is a no-op when there's nothing older, and it doesn't land on the message when there is
- **Job hurt:** 4. `msg:-20` in the demo: clicking "Jump to load older" closes the popover and nothing else happens (timeline items 10 → 10). There's no `tl-load-older-btn`, because `hasMore` is false.
- **Cause:** `RefPopover.tsx:184-187` blindly clicks `[data-testid="tl-load-older-btn"]`, which only exists when `hasMore === true` (`src/Timeline.tsx:148-150`, `:1625`). When it does exist, one page loads and the user is left at the top with no jump to the cited message.
- **Spec question:** the plan (Decided) maps every out-of-range ref to "Not loaded". When the history is fully loaded and the agent has fewer than N replies, the text is wrong. It should read "No earlier message" (muted, with no action).
- **Fix:** pass `hasMore` into `RefLink`. If it's false, show "No earlier message". If it's true, load older and then re-resolve and jump (or at least keep the popover open with the new result).
- **Files:** `src/RefPopover.tsx`, `src/Timeline.tsx`, `src/contextRefs.ts`. **Effort:** S.

### R13-4 · minor · The popover's action can't be reached from the keyboard
- **Evidence:** focus `msg:-1` (the popover opens) → Tab → focus lands on `idea-729` and opens its popover. The popover is portalled to the end of `<body>`, so it is last in tab order and the trigger's blur closes it first. `onTriggerBlur` (`RefPopover.tsx:162-168`) only spares focus moving *into* the popover, which Tab never does.
- **Fix:** while it's open, let Tab or ArrowDown on the trigger move focus to the popover's first button (with `preventDefault`), and let Esc return focus to the trigger. Or render the popover right after the trigger in the DOM, keeping `position: fixed`.
- **Files:** `src/RefPopover.tsx`. **Effort:** XS–S.

### R13-5 · minor · An open popover detaches from its token when the timeline scrolls
- **Evidence:** with `msg:-1` focused, scrolling the timeline 150px leaves the popover at y=339 while the token moves to y=468. The popover then covers other messages, 130px away from what it explains (`dark-1280-scrollopen`). Hover-opened popovers mostly close as the pointer leaves, so this mainly affects focus/tap opens (the phone scrolls under a tapped popover).
- **Cause:** placement runs only on open and on popover resize (`RefPopover.tsx:77-101`). There's no scroll listener.
- **Fix:** close on any ancestor scroll (`window.addEventListener("scroll", close, true)`), which matches PinMenu's behaviour, or re-place on scroll.
- **Files:** `src/RefPopover.tsx`. **Effort:** XS.

### R13-6 · minor · The popover uses Psycho tokens in Normal, so light theme shows a mauve card with a violet border
- **Evidence:** light `.ref-popover` background `#e0d1dc` (`--navy`) with a `--cyan` border, against Normal's lavender/white surfaces (`light-3200-hover1`). Normal menus use `--surface-2` + `--border-strong` + shadow (`src/boring.css:1055`). It is readable (6.3:1 muted, 9:1+ body) but looks like it belongs to another app.
- **Fix:** add a `html[data-vibe="boring"] .ref-popover` override: `background: var(--surface-2); border: 1px solid var(--border-strong); box-shadow: 0 8px 24px #0006`, with the title in `--text-1`. Psycho keeps the current look.
- **Files:** `src/boring.css`. **Effort:** XS. Run the colour pair past @art per SPEC (the overlap guard routes contrast to @art).

### R13-7 · minor · "Jump to message" smooth-scrolls under reduced motion
- **Evidence:** `RefPopover.tsx:178` always uses `behavior: "smooth"`. The plan's Decided says "Reduced-motion: no fade". There's no fade (✓), but the jump still smooth-scrolls with `prefers-reduced-motion: reduce`. The `.tl-flash` outline is static (`src/styles.css:4349`), so it's fine.
- **Fix:** `behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"`.
- **Files:** `src/RefPopover.tsx`. **Effort:** XS.

### Noted, not findings
- **The idea popover repeats itself.** The title "Context refs in chat" is also the first four words of the body (`light-3200-hover1`). That comes from the card data (the title is derived from the text), not from the popover. It's harmless, and it costs about one line of the 8-line budget.
- **Tap to open on desktop.** A click on a desktop link opens the popover but a second click doesn't close it (`onClick` → `openNow`). That's fine, because outside-click and Esc close it.
- **Plan R2 (agent rule) depends on R13-1.** Until "Open in Inbox" works in Normal, teaching agents to cite `idea-N` *instead of* restating gives the owner a card summary with no way to reach the card from chat. Keep R2 behind R13-1.

## Owner decisions
None needed. The R13-3 wording change ("No earlier message" when the history is complete) is a spec correction the lane can make. It doesn't change scope.
