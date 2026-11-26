# VibeSquad UX review, round 44: @desk P3 recheck (split + lane empty card, Bugs Lead with no Bugs lane)

Date: 2026-11-26 · Build: `desk-p3-empty-card-url` @ `c456f311` · Previous: `docs/UX_REVIEW_R43_desk-p3.md` (PASS 0/0/2 on `f80b6a2c`)

**Verdict: PASS 0/0/3** (critical/major/minor). 2 minors are new. Both come from code older than P3, but P3 makes them reachable or puts them next to its own screens. R43 m1 is carried, unchanged.

- **Check 1 (split open, Back/Forward onto a lane's empty card, then reload): pass.** Back onto `?lane=` with a real split hides the split and shows the card the URL names. The split itself is kept. The topbar's `Unsplit` stays pressed. Forward brings both panes back as they were. Reload on the card shows the card.
- **Check 2 (click into an empty lane card while split is open): pass on the screen invariants.** URL, breadcrumb, the one selected row and the card all agree. B17's right-pane card is cleared. But the topbar `Lead · none` pill folds the split for good (m1).
- **Check 3 (Bugs Lead, no Bugs lane): pass. R43 m2 is fixed.** A cold load, a reload, and Back onto a `?slot=bugs&role=lead` history entry all land on `… › Bugs › Brainstorm`. The URL becomes `?slot=bugs` (the role is dropped). The `Bugs` row is the one selected row.
- 0 page errors in every run.

## Setup
- **Build:** `npm run build` at `c456f311`. `public/THIRD-PARTY-LICENSES.txt` was unchanged afterwards (`git status` clean apart from `docs/`).
- **Drivers:** `docs/ux-review-r44/drive/`. `common`/`lib`/`mock` are copied from R43, and `state()` now also records `split` and the right pane's text. Each step also reads `vs.panes.v1` from localStorage (`split`, the active agent per pane, `rightTabs`), so a hidden split can be told apart from a folded one.
  - `pass1`: split + Back/Forward/reload onto lane cards. Runs dark 1920x1080 and light 1600x900.
  - `pass2`: clicks into empty cards with split open: the topbar pills, the B17 right card, sidebar rows. Runs dark 1920 and light 1600.
  - `pass3`: split survival compared three ways: the lane card via Back, the lane card via the pill, and a Desk slot card.
  - `pass4`: reload on an empty card with a real right agent, compared three ways (`?lane=`, `?slot=`, `?agent=`). Also R43 m2: cold load, reload and an injected popstate.
  - `explore*.mjs`: sidebar row discovery.
- **Logs:** `docs/ux-review-r44/logs/`.
- **Not re-shot:** 3200x1800. This recheck changes routing only (`git diff 6a140895 c456f311 -- src/*.css` is empty), and R43 shot the card at 3200.
- **Reachability note:** no lane in the demo data has neither a Lead nor a Brainstorm, and the sidebar draws a `Lead` child row only when a Lead exists. So no sidebar row lands on a feature lane's empty card. The in-app ways into `pickRole`'s no-member branch are the topbar `Lead · none` / `Brainstorm` pills. The sidebar paths that clear B17's right card are the lane rows and the Desk/Bugs slot rows. All were driven.

## Status vs R43

| R43 item | Status at `c456f311` | Evidence |
|---|---|---|
| m1: Overview Lead cell on a lane with no Lead opens the Brainstorm chat, not the Lead card | **Open, unchanged.** The cell still goes `go("lead")` → `pickRole` → `onOpenPin(pin)` (`src/BoringAde.tsx:1383`, `:603-606`). See m1 below: the same call is the cause there too. | code read; not re-driven |
| m2: `?slot=bugs&role=lead` with no Bugs lane: the URL drops the role, but the breadcrumb said Lead | **Fixed.** efi, vibesquad, and vibesquad `?riff=1`: cold load, reload and popstate all give `… › Bugs › Brainstorm` with URL `?slot=bugs`. The popstate case ends in a `replaceState` to the clean URL. | `logs/pass4.json` (last 3 blocks); `r44-dark-1920-bugs-lead-nolane.png` |
| Note: the Lead card's `Brainstorm Idle` chip hides needs-you | Unchanged (pre-existing, out of scope). | — |

## What was checked

| Sequence | Result | Evidence |
|---|---|---|
| Runner Pilot card → Lead (sidebar) → Split → Plugins Lead right → Back → Back to `?lane=runner-pilot` | **Pass.**<br>• Card shown full width: `Runner Pilot · Lead idle · no Brainstorm`.<br>• Breadcrumb: `VibeSquad › Runner Pilot › Brainstorm`.<br>• Selected row: the `Runner Pilot` lane row, and only that one.<br>• Panes stay `split=true R=demo-lead-pl`, and `Unsplit` stays pressed. | `logs/pass3.json` X; `r44-dark-1920-X-back-card-split-kept.png` |
| … then reload on the card, then Forward | Reload: the card again, with no history call. Forward: the split comes back, but the right pane shows the picker, not Plugins Lead (**m2**, pre-existing). | `logs/pass3.json` X; `r44-dark-1920-X-forward-after-reload.png` |
| Bug Chaser (`?riff=1`) Lead card → chip Brainstorm → Split (picker) → Back to `?lane=bug-chaser&role=lead` → Forward → Back → reload → Forward | **Pass.**<br>• Back: the card (`split` hidden), breadcrumb `… › Bug Chaser › Lead`, one selected row.<br>• Forward: the split picker returns.<br>• Reload: the card.<br>• The same in dark 1920 and light 1600. | `logs/pass1.json` B; `r44-dark-1920-B-back-leadcard.png` |
| Split (Bug Chaser Brainstorm left, Plugins Lead right), left active → topbar `Lead · none` | Screen **pass**: 1 push to `?lane=bug-chaser&role=lead`; card, breadcrumb and selected row agree. Split **folded**: panes go to `split=false rightTabs=[]`. The card chip and Back do not bring it back (**m1**). | `logs/pass3.json` Y; `r44-dark-1920-a-leadpill-split.png`, `r44-dark-1920-Y-after-chip.png` |
| Split with the B17 right card (Runner Pilot `Buddy (not running)`), left active → topbar `Brainstorm` (Runner Pilot has none) | **Pass.**<br>• 1 push to `?lane=runner-pilot`, and the card is shown.<br>• The right card is cleared.<br>• Back returns to the Lead with the split picker, and Forward to the card. | `logs/pass2.json` b; `r44-dark-1920-b-rightcard.png`, `r44-dark-1920-b-bspill-card.png` |
| B17 right card shown → sidebar Runner Pilot row | Pass. The selection moves to the left Lead and no URL is written (same agent). This is B17 by design, unchanged. | `logs/pass2.json` c |
| Desk slot comparison: same split → sidebar Main Game Overlord (no agent) → sidebar Bug Chaser → sidebar Main Game Bugs → Back | Pass. The slot card hides the split and keeps it (`split=true R=demo-lead-pl`). Opening an agent brings both panes back. | `logs/pass3.json` Z |

## Findings

### Minor 1 · The topbar `Lead · none` pill folds an open split; Desk slots and Back keep it
- **Job hurt:** 2 (monitor two agents side by side).
  - The owner has Bug Chaser's Brainstorm on the left and another lane on the right. They click `Lead · none` to see the Lead card.
  - The split is gone. The right agent moves into the left tab strip.
  - Neither the card's `Brainstorm` chip nor Back restores the split. The owner has to press Split and re-pick the right agent.
  - Every other way onto an empty card (Back/Forward onto `?lane=`, and the Desk/Bugs slot rows) keeps the split hidden and brings it back. The pill is the one exception.
- **Evidence:** `logs/pass3.json` Y.
  - Before the pill: `split=true L=demo-bugs R=demo-lead-pl`.
  - After the pill: `split=false L=demo-bugs R=null rightTabs=`.
  - Compare Z (Desk slot): `split=true` throughout.
  - The Runner Pilot `Brainstorm` pill does **not** fold the split (`pass2.json` b), because that lane has no live Buddy. Only a lane with a live Brainstorm and no Lead triggers this.
- **Cause:**
  - `pickRole`'s no-member branch (`src/BoringAde.tsx:603-606`) calls `onOpenPin(pin)`.
  - In `App` that is `onQuickStart` → `focusPin` (`src/App.tsx`, `onQuickStart`).
  - `focusPin` finds the lane's live Buddy and calls `show(live)`.
  - `show` folds any split: `if (getPanes().split) toggleSplit()` (`src/pinFocus.ts:94`, from `f3c083b2` 2026-11-01).
  - The code is pre-existing, but it is the only in-app path to the P3 Lead card.
- **Fix:**
  - When the requested role has no member, make the card the screen the way `enterSlotLane` does: set lane and role, and clear the right card.
  - Don't call `onOpenPin`/`focusPin`, which opens (and so folds onto) the sibling agent.
  - The same change fixes R43 m1, because the Overview Lead cell then lands on `?lane=&role=lead` instead of the Brainstorm chat.
  - Add an e2e step: split with a right agent → `Lead · none` → assert the persisted `split` is still true and the right agent comes back on Back.
- **Files:** `src/BoringAde.tsx` (`pickRole`), `test/desk-nav-history-e2e.test.mjs`.
- **Effort:** S.

### Minor 2 · A reload on any empty card (lane or Desk slot) loses the right pane's agent when the split comes back
- **Job hurt:** 2 (monitor).
  - After a reload on a card, opening an agent brings the split back with the right pane showing `Pick an agent or lane`.
  - The previous right agent is still in `rightTabs` but is not active, and no tab strip shows it.
  - The owner has to re-pick it.
- **Evidence:** `logs/pass4.json` LANE and SLOT. Before the reload: `R=demo-lead-pl`. After the reload and Back: `R=null rightTabs=demo-lead-pl`, right pane `Pick an agent or lane`. The `?agent=` control keeps `R=demo-lead-pl`. Screenshot `r44-dark-1920-X-forward-after-reload.png`.
- **Cause:**
  - `src/panes.ts:79` (R5-4): on a cold load with `?team=` and no `?agent=`, the code nulls **both** `leftActiveId` and `rightActiveId`.
  - Back/Forward restores the left pane from `?agent=`, but nothing restores the right.
  - This is pre-existing and shared with the idea-1075 Desk slot cards, so it is not caused by P3.
- **Fix:** null only `leftActiveId`. Keep `rightActiveId` when `split` is set, so the right pane is restored as it was.
- **Files:** `src/panes.ts`, plus a panes unit case.
- **Effort:** XS.

### Minor 3 (carried, R43 m1) · The Overview Lead cell on a lane with no Lead opens the Brainstorm chat
Unchanged. See R43. Its cause is the same `onOpenPin` fallback as m1, so a single fix covers both.

## Owner decisions
None.

## Inbox cards for @desk
- **m1 (R44):** the `Lead · none` pill folds an open split, through `pickRole` → `onOpenPin` → `focusPin` → `show()` (`src/BoringAde.tsx:603-606`, `src/pinFocus.ts:94`). Make an empty role enter like `enterSlotLane`. This also closes R43 m1.
- **m2 (R44, pre-existing, shared with Desk slots):** a cold load on `?team=` without `?agent=` nulls `rightActiveId` (`src/panes.ts:79`), so the split returns with an empty right pane after a reload on a card.
