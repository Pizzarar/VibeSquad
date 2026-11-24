# VibeSquad UX review, round 15: context refs R1 delta (idea-729)

Date: 2026-11-24 · Build: `unit-ui-ctxref-r1` @ `4403ac7d`, vite dev on `:5433`. Re-checked R14-1/2/3 in `?demo` Normal mode:
- 1920×1080 and 1280×720 in dark and light, plus 1920 with `prefers-reduced-motion: reduce` in both themes.
- Phone 390×844 (touch) in dark and light.

Driven with Playwright. Screenshots are in `docs/ux-review-r15/` (untracked). There were 0 page errors in every pass.

**Verdict at `4403ac7d`: PASS 0/0/1** (critical/major/minor). The one open minor is the rest of R14-2 (Back doesn't restore the chat), which is queued to @bor as stated.

| Item | Status | Evidence |
|---|---|---|
| R14-1 the highlight was invisible in Normal and never cleared | **fixed** | **Outline at 250ms:** after "Open in Inbox", `#inbox-card-idea-729` has a 2px solid outline, dark `rgb(155,114,232)` and light `rgb(109,75,201)`. That comes from `html[data-vibe="boring"] .inbox-card.highlighted` (`src/styles.css:4164`). **Cleared by 2.5s:** the class is gone and the outline is `none`, at all 4 desktop combos. **Position:** the card sits at y=346, fully visible at 1080 and 720. **Reduced motion:** the inbox scroll uses `prefersReducedMotion() ? "auto" : "smooth"` (`src/IdeaInbox.tsx:364-367`). See `r15-dark-1920-inbox`, `r15-light-1280-inbox` |
| R14-2 Back after "Open in Inbox" left the URL and screen out of step | **half** (URL and screen now agree; restoring the chat is queued to @bor) | `history.length` stays 4 across "Open in Inbox" (`replaceState`, `src/RefPopover.tsx:276`). Back now lands on the previous entry, `?team=efi`, and the screen matches it: crumb "Escape From Idle › Overview", with exactly one `.on` row (Escape From Idle). The stale `?agent=` mismatch is gone. What remains: Back leaves the chat entirely. In this demo session it lands in **a different project** (EFI, the landing view before the deep link) rather than back in the Audit chat (`r15-dark-1920-back`). That's minor: the chat is one click away in the sidebar/Needs-you list |
| R14-3 focus fell to `<body>` | **fixed** | In all 6 desktop passes: Enter on a link moves focus to the popover button. Enter on "Jump to message" focuses the target message `DIV.tl.tl-assistant.tl-flash`. A scroll-close while focus is inside the popover returns focus to its link (`idea-729`), and Esc keeps focus on the link. The popover closes on scroll (count 0) |
| Phone regression check | stays fixed | Dark and light: tap opens and a second tap closes, for all 4 tokens. The `idea-729` popover has no "Open in Inbox" button. The `msg:-1` "Jump to message" tap flashes the target. Right edge at 386 of 390 (`r15-light-390`) |
| R13 checks (hover timing, clamp, dotted underline, Normal surfaces, "No earlier message") | stay fixed | They weren't the focus of this delta, but the same runs showed no change |

Open minor carried: **R14-2 remainder**. Back from the Inbox should return to the chat it came from. The fix belongs to Normal routing (BoringAde mode on popstate). Owner lane: @bor, already queued.
