# VibeSquad UX review, round 22: Code | Storybook tabs (idea-834 T1)

Date: 2026-11-25 · Build: `unit-ui-sb-tabs` @ `82a64189` (base `8f01b16f`).

**Setup.** `npx vite --port 5434` from this worktree, `?demo`. `?demo` has no Storybook project, so a Playwright `page.route('**/api/storybook/**')` answers `vibesquad` with HEAD 200 / GET 200 and a valid SB1 snapshot (2 entities, 1 finding). Every other project (`efi`, `site`, the `team-*` demos) gets 404. Chromium 1920×1080, 1280×720, 3200×1800 @ dpr 1.2 (the owner's 4K at 120%), and phone 390×844 @ dpr 3 (isMobile), each in dark and light. There were 0 page errors. Shots are in `docs/ux-review-r22/`. No source edits.

**Verdict at `82a64189`: FAIL 0/1/3 (critical/major/minor).** Everything about navigation works. The one major finding is placement: the pill is not "in the same spot" in the two headers, which the plan requires (`PLAN_CODE_STORYBOOK_TABS.md:11`). The fix is XS.

## Status vs the previous round

R21 reviewed SB5 (the Storybook view itself), not this unit. Its open m1 (a dead Back press after a forward pick leaves Storybook) and nit (double Esc) are not touched by T1 and were not re-driven.

| Check | Result | Evidence |
|---|---|---|
| Topbar pill right of the breadcrumb, known-Storybook project only | **Pass** | `vibesquad`: pill at x=548 (1080), x=530 (720), x=620 (4K), after `VibeSquad › Overview` (`1080d-code.png`, `4kd-code.png`). It also shows on an agent page: `VibeSquad › Desk › Worker  Code Storybook` (`agent.png`). |
| 404 project: no chrome change | **Pass** | `efi`: no `.project-tabs` in the DOM, topbar identical to base (`efi-404.png`). Boot sends only HEAD; the single GET fires on the Storybook click. |
| Storybook click | **Pass** | URL gains `&sb=vibesquad` and history +1. sb-head shows the pill with Storybook pressed (`aria-pressed=true`). |
| Code from Storybook = Back | **Pass** | `history.length` stays 4 and the URL returns to the exact prior entry. Browser Forward re-enters correctly. From an agent page, Code returns to `?agent=demo-aud` with `Desk › Worker` intact. |
| Cold load with `?sb=`, then Code | **Pass** | `history.length` stays 3, the page lands on `?team=vibesquad` and never leaves the app (`cold-code.png`). |
| Reload on `?sb=` | **Pass** | Storybook reopens. |
| Esc / ← Back unchanged | **Pass** | Esc → `?team=vibesquad`. The `← Back` button behaves the same. |
| Ctrl+J from Storybook | **Pass** | Leaves to `?agent=demo-aud`, with `sb` cleared. |
| Pill is in the same spot in both headers | **Fail (M1)** | Topbar x=548 vs sb-head x=1391 at 1080. At 4K it's x=620 vs x=2651. |
| Active segment is distinguishable | **Weak (m1)** | Light mode: the inactive pill is darker than the active one. |
| Phone ≤600px sb-head: title ellipsis, pill on row 1 | **Pass, with m2** | Title 113px with ellipsis, pill at y=16 on row 1, no horizontal overflow (docW 390) (`phd-sb.png`, `phl-sb.png`). The ellipsis cuts off the project name, though. |
| Compact contract | **Pass** | No added scroll: scrollHeight equals the viewport at every size. No new menus. |
| Dim by colour, not opacity | **Pass** | Both segments have `opacity: 1`. Inactive state comes from background only. |
| Invariants (counts, one selected row, crumb = row = agent) | **Pass / unchanged** | Breadcrumb tracks the agent through Storybook and back. The selection count is unchanged from base. |

## Findings

### Major

- **M1 · The pill jumps sides between the two headers (up to about 2000 CSS px at 4K), so it doesn't work as a stable tab control.**
  - **Job hurt:** 4 (Review output): flipping between a project's code and its Storybook. A segmented control's value is that you click Storybook, then click Code in the same place. Here, after clicking Storybook at the top-left, Code has moved to the far right next to "5 need you". The plan says "same pill in the same spot" (`PLAN_CODE_STORYBOOK_TABS.md:11`).
  - **Evidence:**

    | Viewport | Topbar pill x | sb-head pill x |
    |---|---|---|
    | 1280×720 | 530 | 751 |
    | 1920×1080 | 548 | 1391 |
    | 3200×1800 @ 1.2 | 620 | 2651 |

    Shots: `1080d-code.png` vs `1080d-sb.png`, `4kd-code.png` vs `4kd-sb.png`, and `4k-sbhead-pill-crop.png`.
  - **Cause:** `.sb-title { flex: 1 1 auto }` (`src/storybook.css:26`) grows the title to fill the header, which pushes `<ProjectTabs>` (`src/StorybookView.tsx:481`) right, up against `.sb-head-right`.
  - **Fix:** on desktop, make `.sb-title` `flex: 0 1 auto` and give `.sb-head-right` `margin-left: auto`. The pill then sits right after "Storybook · VibeSquad", mirroring "breadcrumb → pill" in the topbar. Keep the ≤600px block as it is.
  - **Files:** `src/storybook.css` · **Effort:** XS

### Minor

- **m1 · The active segment barely differs from the inactive one, and in light mode it reads inverted.**
  - **Job hurt:** orientation (which view am I in?). The title and breadcrumb soften this.
  - **Evidence:** Both segments use the same text colour. In dark, active is `rgb(51,42,74)` and inactive is `rgb(38,38,50)`, about 1.15:1. In light, active is a pale lilac `rgb(233,227,248)` and inactive is a beige `rgb(230,227,221)`, so the *inactive* pill looks heavier (`light-pill-crop.png`). The Overview / Idea Inbox tabs right below use a clearly stronger selected style.
  - **Cause:** the inherited `.boring-switch-pill.on` style (`src/boring.css:407`) against the resting pill background. T1 adopted this per plan ("same look as the switcher pills").
  - **Fix:** for `.project-tabs`, give the active segment an accent cue (accent text or a 1px `--accent` ring), or a transparent background for the inactive one. Route the colour pair to @art.
  - **Files:** `src/boring.css` · **Effort:** XS

- **m2 · Phone sb-head title ellipsizes to "Storyb…", hiding which project you're in.**
  - **Job hurt:** orientation on phone.
  - **Evidence:** `phd-sb.png`: `◉ Storyb…  Code Storybook`. The word "Storybook" is already on the pill right next to it, so the truncation removes the only unique part.
  - **Fix:** at ≤600px, hide the "Storybook" word in the h2 and keep `· VibeSquad`, or ellipsize the project span only.
  - **Files:** `src/storybook.css` (600px block, lines 101-111), maybe `src/StorybookView.tsx:479` · **Effort:** XS

- **m3 · Phone pill segments are 28px tall,** while ← Back and Refresh in the same header are 44px.
  - **Job hurt:** tap accuracy on phone.
  - **Evidence:** project-tabs box `[225,16,155,28]` at 390×844.
  - **Fix:** `min-height: 40px` for `.sb-head .project-tabs .boring-switch-pill` inside the 600px block.
  - **Files:** `src/storybook.css` · **Effort:** XS

## Owner decisions

- **Tabs in the phone Normal shell.** The phone Normal view (390×844) uses the mobile shell (project select + ⋯ menu), with no `boring-topbar`, so there's no Code | Storybook pill there. On phone, Storybook is reached via ⋯ → "Open Storybook · project", and the pill appears only once you're inside Storybook. **Recommendation:** leave it. The ⋯ entry already covers phone, and a pill in the cramped mobile header would break the compact contract.

## Not charged to T1

- The 12 `ui:overlap` hits are pre-existing on master (idea-945).
- R21 m1 (dead Back press after a forward pick out of Storybook) is unchanged.
