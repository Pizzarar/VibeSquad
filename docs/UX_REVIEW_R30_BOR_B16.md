# UX Review R30: @bor B16 Normal-mode composer bar

Scope: `66e35b5e` vs `e89f5142`. Evidence: `artifacts/boring-b16/dark-4k-120.png`, `dark-1280x720-ctxpanel.png`, plus code in `src/BoringComposerBar.tsx`, `src/useAgentConfig.tsx`, `src/BoringAgentHeader.tsx`. Screenshots reviewed: dark 4K and 1280x720. I did not re-shoot the light or menu shots. Psycho untouched in the diff (`ComposerMore` branch kept; the hook is gated by `active && boringChat`).

Job hurt: "intervene" (change model/mode/thinking mid-session) and "start work".

## Findings

| # | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| M1 | **Major** | The Thinking and Mode selects have no visible label and no accessible name. Previously each had a labelled row in the ⋯ menu. In the bar they show as a bare `low` and a bare `Default`, and a screen reader announces two unnamed comboboxes. Only Mode gets a wrapper `title` (hover only, `BoringComposerBar.tsx:49`). Provider has `title` only. Model has `aria-label`. | dark-4k-120.png bottom bar; `useAgentConfig.tsx` thinking select (~L353) and mode select (~L262) have no `aria-label`/`title`; provider select L197-203 has a `title` only. | Add `aria-label`/`title` ("Thinking effort", "Permission mode (Shift+Tab)", "Provider"), or prefix tiny visible labels. Do it in the bar, or in the shared hook so Psycho gets it too. Effort: XS. |
| L1 | Minor | Zero-lost-features: the one-click "⇄ Switch to X" `providerSwitchBtn` is no longer rendered in Normal mode. It was in the ⋯ menu and is now in neither the menu nor the bar. Switching still works through the Provider select, which stages the switch for the next send. The immediate-switch path is gone. | `grep providerSwitchBtn`: only `DrawerHeader.tsx:907` (Psycho) and the hook. | Put it back in the bar, or note in the plan that it was dropped on purpose. |
| L2 | Minor | Narrow-width wrap is clumsy. At 1280x720 with the ctx panel open, the bar breaks into 3 rows: attach/lock + provider/model/thinking, then `Default` alone, then Stop/Interrupt/Queue alone. The row 1 / row 2 grouping is lost and the orphaned mode select looks accidental. | dark-1280x720-ctxpanel.png. | Give `.boring-composer-cfg` `flex-basis: 100%` below about 700px, or let the send group stay inline with the actions row. |
| L3 | Minor | Staged-switch feedback ("Switching to X on your next message") is only in the header strip (`BoringAgentHeader.tsx:409-416`), far from the Provider select the user just changed at the bottom. In a long transcript the select shows the new value, but nothing next to the composer says it hasn't taken effect yet. | Code, plus layout in the screenshots (header at the top, bar at the bottom). | Add a small `staged` dot/ring on the Provider select, or a one-line hint above the bar. |
| L4 | Minor | Tap targets and truncation: icon buttons are 34px and selects 32px, below 44px. The model select is capped at 150px, so `deepseek/deepseek-flash` shows as `deepseek/deepseek`. Fine for desktop, but not for touch. | CSS `boring.css` B16 block; dark-4k-120.png. | Consider a wider max-width for the model select (about 200px) and 40px on coarse pointers. |

## Checked, no issue
- Grouping: actions on the left, config in the middle, send group on the right. The hierarchy reads well at 4K.
- Keyboard and aria: the toolbar has a role and label, icon buttons have `aria-label`, and focus rings are defined (`:focus-visible`).
- Contrast: send button `color-mix(accent 70%, #000)` with white text, disabled `#475569` with white text. Acceptable.
- ⋯ menu leftovers: only a "Session" section remains (chips, cost) and no empty Model & mode group. OK.
- Workers rows overlap in the ctx panel at 1280x720: known and pre-existing, not counted.

## Verdict
M1 is open (unlabelled Thinking/Mode controls), so FAIL until labelled. L1-L4 are non-blocking.

---

## R30 r2 (fix commit `dea2ca38`)

Evidence: `git diff 794c9325..dea2ca38`, and all 5 re-shot images in `artifacts/boring-b16/`. I opened both menu shots (`dark-4k-120-menu.png`, `light-4k-120-menu.png`). I did not render the staged-switch or Switch-button states. They are verified from code only (see L1/L3).

| Prior | Status | Evidence |
|---|---|---|
| M1 | **Closed** | `useAgentConfig.tsx` now sets `aria-label="Provider"`, `aria-label="Mode"` + `title`, and `aria-label="Thinking"` + `title`. The bar shows visible `Think` and `Mode` hints (`.boring-composer-field-label`, `aria-hidden` so the aria-label is not doubled). Both are visible in dark-4k-120.png and dark-1280x720-ctxpanel.png. The labels are 11px `--text-2`, which is small but legible. |
| L1 | Closed (code) | `providerSwitchBtn` is passed from `Composer.tsx:705` into the bar. The hook only returns it when `switchTarget` is set. The demo agent is on OpenCode, so it does not show in the shots. |
| L3 | Closed (code) | `Composer.tsx:706` builds the hint from `staged` and `effectiveProv.name`. Both are returned by the hook. It renders in a `role="status"` row with `--st-attn`, which has a readable contrast on dark (#ffc15e) and light (#8a5700). Not rendered. |
| L4 | Closed | The model select cap is now 240px. `deepseek/deepseek-flash` shows in full in all shots. |
| L2 | Open, minor (accepted skip) | At 1280x720 with the ctx panel open the bar wraps to 3 rows: icons + provider + model, then Think + Mode, then the Stop / Interrupt & send / Queue group. The groups still read as intentional, with no orphans. Same wrap at 4K: Mode drops under Think. |

Menu shots: the ⋯ menu shows only Mark unread, Flag needs you, Search transcript, Reload session, the Session block (Sandbox, Fork/Export, chips, Attach, meta) and Close chat. There is no leftover Model & mode group. The menu overlaps the right ctx panel as a normal popover, and the text is readable in both themes.

Fresh pass, new issues: none above minor.
- Minor (L5): Mode wraps onto its own row at the ~550px composer width even at 4K, so the config group is 2 rows beside a single send row. This is cosmetic.
- Psycho is gated by `enabled: boringChat`, so no second listener or fetch there. Reviewed in the diff, not run.
- Desktop touch targets are still 32/34px (minor, out of scope).

Open: 0 critical, 0 major, 2 minor (L2, L5).

**Verdict: PASS 0/0/2.**
