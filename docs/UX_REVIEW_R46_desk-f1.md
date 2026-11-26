# VibeSquad UX review, round 46: @desk F1 Decision Desk filter pills (recheck)

Date: 2026-11-26 · Build: `desk-f1-filter-pills` @ `bc2a265a` · Previous round: `docs/UX_REVIEW_R45_desk-f1.md` (FAIL 0/1/4)

**Verdict: PASS 0/0/1** (critical/major/minor). The one open minor is R45 m2, which is queued as idea-1121 and left open on purpose.

The sidebar `Decisions · N` badge now matches the page summary's `N open` in every state I drove (19 states × 4 configs, 0 mismatches). That includes the on-hold-only case that failed R45. The empty state names the hidden count and offers `Show all`. The asleep group says `Asleep`, with a tooltip. Pills have spoken names. Nothing from the R45 brief checks regressed.

## Setup
- **Build:** `npm run build` at `bc2a265a`. `public/THIRD-PARTY-LICENSES.txt` was restored afterwards. `docs/shots/desk-f1/` was untouched.
- **Drivers:** `docs/ux-review-r46/drive/`. These are the R45 drivers with three changes:
  - `pass2` reads `[data-testid="boring-decisions-nav-count"]`, adds a `parity` field to every step (badge number vs the summary's `N open`), records each pill's aria-label and title, and clicks the empty-state `Show all`.
  - `pass3` runs all 4 configs, clicks `Show all`, reloads, goes back to `Active`, then leaves the Decision Desk to check the badge off the page.
  - Run with `PLAYWRIGHT_DIR=<npx playwright node_modules> TMPDIR=/tmp/...`. The worktree has no playwright, and Chromium can't write under the default cache tmp.
- **Configs:** 1920x1080 and 3200x1800@1.2, dark and light.
- **Logs:** `docs/ux-review-r46/logs/pass1.json`, `pass2.json` (all 4 configs), `pass3.json`. 0 page errors. The only console errors are 404s from endpoints the mock doesn't serve.

## Status vs R45
| R45 item | Status | Evidence |
|---|---|---|
| **M1** Badge ignores the filter | **Fixed.** `parity: OK` on every step in all 4 configs. Checked states: default (4/4), Site off (3/3), 3 toggles (6/6), after reload (6/6), `All` (7/7), `Active` (4/4), none on (0/0), `Show all` (7/7), hide with a staged answer (2/2), typed+hidden (3/3), Space/Enter (3/3 → 4/4). On-hold-only gives `· 0` / `0 open in selected projects`. After `Show all` it gives `· 3` / `3 open`, and the same after reload. Off the desk (1920) the badge stays `· 0` with the desk unmounted. | `logs/pass2.json`, `logs/pass3.json`; `r46-dark-1920-onhold-only.png`, `r46-light-3200-onhold-only.png` |
| **m1** Empty state has no hidden count or way back | **Fixed.** It reads "No open decisions in the selected projects (7 items hidden by the filter)." / "(3 items …)" for on-hold-only, with a `Show all` button on the right. The button applies `All`: every pill is pressed and the badge and summary move together. | `r46-*-none-on.png` (4 configs), `r46-dark-1920-onhold-only.png` |
| **m2** `+1 hidden` doesn't name the project | **Open by design** (idea-1121). Behaviour is unchanged: `Send 0 answers (+1 hidden)`, and hidden answers never send. | `r46-dark-1920-staged-hidden.png` |
| **m3** `On hold` vs `Asleep` | **Fixed.** The group label is `ASLEEP` with title "In an asleep folder. Click a pill to show anyway." Each asleep pill has title "In an asleep folder. Click to show anyway." It now matches the sidebar's `Backlog · 2 💤 Asleep`. | `logs/pass1.json` pills[].title; default shots |
| **m4** Accessible name runs together | **Fixed.** Every pill's aria-label is `"<Project>, N open"` (e.g. `Main Game Project, 1 open`), in all 4 configs. | `logs/pass1.json` pills[].label |

## R45 brief checks (regression sweep)
| Check | Result |
|---|---|
| Pill size and colours | Same as R45: 12px text, 26px tall, same ON/OFF/asleep colours, one row (1920 ends at x≈1007). |
| Presets | `Active` is pressed by default. A custom toggle un-presses both. `All` = 7 open, `Active` = 4. |
| Toggle 3, reload | `{"site":false,"forework":true,"sbb":true}` is still applied after reload (6 open, both sides). |
| Feed, strip and rail follow the filter | Squad lists match the pressed set at every step. |
| Stage → hide → unhide | `Send 1 answer` → `Send 0 answers (+1 hidden)` (disabled) → `Send 1 answer`. A typed Site answer with Site hidden gives `Send 1 answer (+1 hidden)`. |
| Keyboard | Tab order: Active → All → 3 awake pills → 2 asleep pills → feed. 2px purple outline. Space and Enter toggle. |

## Findings
No critical or major findings. Open minors:
- **m2 (R45, carried, idea-1121):** `+1 hidden` doesn't say which project holds the hidden answer.

### Note (no card): `Show all` from the empty state is sticky
`Show all` writes the same persistent overrides as `All` (`vs.decisionFilterOverrides={"forework":true,"sbb":true}`, which survives a reload). So after one click to peek at asleep items, the badge goes on counting asleep projects until the owner presses `Active`. This matches what the pressed `All` preset shows, so it's honest, and it's one click to undo.
- Possible change if it bites: make the empty-state button session-only ("Show for now").
- I'm not filing it. The lead decision (badge = visible only) plus a visible pressed preset is coherent.

### Pre-existing (unchanged from R45)
- Staged answers don't survive a reload.
- The rail shows `Desk` and `Desk lane @desk` as separate rows.

## Owner decisions
None new. The R45 decisions were settled by the lead: the badge counts visible items only, and the label is `Asleep`.

## Inbox cards (@desk)
None new. m2 is already queued as idea-1121.
