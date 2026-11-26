# VibeSquad UX review, round 47: @desk C2 Decision Desk cards show what the choices are

Date: 2026-11-26 · Build: `desk-c2-choices-card` @ `d5eb64fb` · Spec: `docs/PLAN_DESK_DD_CHOICES.md` block C2 · Previous @desk round: `docs/UX_REVIEW_R46_desk-f1.md` (PASS 0/0/1)

**Verdict: PASS 0/0/3** (critical/major/minor).

The owner's ask was "i dont know what the choices are". That is answered on both screenshot cases. Each option button carries its full one-line definition ("A: fill-or-kill at entry — cancel the order unless it fills completely"), and `Show source ▾` opens the asker's own words underneath. In all 4 configs nothing truncates. The mixed ask (pick B + type a veto reply) stages as one answer and delivers one prompt that holds both lines. The three minors are wording gaps around the options, not blockers.

## Setup
- **Build:** `npm run build` at `d5eb64fb`. `public/THIRD-PARTY-LICENSES.txt` was restored afterwards.
- **`docs/shots/desk-c2/`:** this folder is untracked, so git couldn't restore it. Running `test/desk-c2-choices-card-e2e.test.mjs` re-wrote its 4 PNGs at 23:39 UTC. It's the same test at the same tip, so the content is the same as the worker's.
- **Drivers:** `docs/ux-review-r47/drive/`.
  - `pass1.mjs` runs the real `?demo` fallback feed with no backend, in 4 configs.
  - `pass2.mjs` runs a mock backend that uses the real `buildAnswerPrompt`/`validateAnswerBatch`. Its stress items are: 4 long options including an unbroken URL, a 41-line excerpt, a mixed send, Not that + reply, and a plain reply. It runs at 1920 dark, 3200@1.2 light and 1280 dark.
- **Configs:** 1920x1080 and 3200x1800@1.2, dark and light.
- **Logs:** `docs/ux-review-r47/logs/pass1.json`, `pass2.json`. 0 page errors.
- **Worker tests:** `node --test test/desk-c2-choices-card-e2e.test.mjs test/desk-c2-choices-card.test.mjs test/desk-d4-decision-desk.test.mjs` → `# tests 23 # pass 23 # fail 0`.

## Status vs R46
| Item | Status | Evidence |
|---|---|---|
| R46 m2 / idea-1121: `+N hidden` doesn't name the project | Still open by design. The C2 e2e asserts `Send 0 answers (+1 hidden)` with VibeSquad toggled off. | e2e pass |
| Badge = summary parity (R45 M1) | Holds. `Decisions · 14` = `14 open · 11 here · 3 off-screen` in all 4 configs. | `pass1.json` counts |

## Brief checks
| Check | Result | Evidence |
|---|---|---|
| Can the owner tell what each option means at a glance? | **Yes.**<br>• Partial-fill: `A: fill-or-kill at entry — cancel the order unless it fills completely` / `B: keep the partial fill and resize the stop to the filled size` / `C: top up the remainder at the next bar's open`.<br>• U11: `a: survivor-only — keep only listed tickers and report coverage %` / `b: stop at A1 — ship the A1 universe and defer delisted data`. | `r47-*-pf-closed.png`, `r47-*-sv-closed.png` |
| Options wrap readably; card height is reasonable | **Yes.**<br>• Buttons are `white-space: normal; overflow-wrap: anywhere`, left-aligned, 13px. 0 clipped in any config.<br>• Demo options sit on one line each. Partial-fill card: 256px. U11 card: 256px at 1920 (the `Not that` button wraps to row 2) and 216px at 3200. Plain cards are 144–216px.<br>• Stress: 170-char options go full-width at 2 lines (50px), and a 170-char unbroken URL takes 3 lines (68px). No horizontal overflow at 1280, 1920 or 3200. A 4-option card is 488px. | `pass1.json` pf/sv; `pass2.json` longAlts; `r47-*-longalts.png` |
| `Show source ▾` is discoverable | **Adequate.** It's a 12px text button between `Decides:` and the options, the same muted tone as `Decides`, with a 2px accent focus ring. It shows on every inferred card. It's smaller than the options but where the eye passes on the way to them. | `r47-dark-1920-pf-closed.png` |
| Excerpt readable and scrolls | **Yes.**<br>• Plain text (`pre-wrap`, mono 12px/18px), on an inset panel in both themes.<br>• `max-height: 232px` (about 13 lines). A 41-line excerpt scrolls (scrollH 844) with no horizontal overflow, and the unbroken URL wraps.<br>• Partial-fill opens to 108px, card 256→370px. | `pass1.json` pfSource; `pass2.json` longSrc; `r47-*-pf-source-open.png`, `r47-*-longsrc.png` |
| Keyboard and screen reader | **Yes.**<br>• The toggle is a `<button type=button>` with `aria-expanded` false→true and `aria-controls` = the body id. Enter opens it and Space closes it.<br>• The body is `role=region`, `tabindex=0`, `aria-label="Source excerpt for <ask>"`, and PageDown scrolls it (scrollTop 0→201).<br>• Tab order: toggle → excerpt → A → B → C → Not that → reply box.<br>• Options carry `aria-pressed`. | `pass1.json` tabSeq/focusRing; `pass2.json` kbScrollTop |
| Mixed ask: B + typed veto | **Yes.**<br>• B goes `aria-pressed=true` and the reply box keeps "Yes, add the 30s veto window". Send reads `Send 0 answers` → `Send 1 answer` (one answer per card, which is correct).<br>• Switching to C keeps the reply. Unpicking C leaves a reply-only answer that still counts 1.<br>• The delivered prompt contains `Owner's answer: Go with option 2: "B: keep the partial fill…"` plus `--- BEGIN owner reply (Aub) --- Yes, add the 30s veto window`. | `pass1.json` send*/afterSwitchC/afterUnpick; `pass2.json` delivered[0]; `r47-*-pf-mixed.png` |
| Fit with the F1 pills and the page | **Yes.** The pills, summary and live-status column are unchanged. The selected card gets the accent outline, and the footer reads `1 ready to send · 6 leans not included`. | `r47-light-3200-page-mixed.png`, `r47-dark-1920-page-mixed.png` |
| Regressions on other cards | **None seen.**<br>• Plain-answer cards keep `One-line answer…` + `Dismiss`. Lean/alt cards keep `LEAN` + options + `Not that` + `Add a note or reply…`.<br>• Heights are unchanged at 144/184px.<br>• After a 3-answer send, all three cards clear. | `pass1.json` cardHeights; `pass2.json` afterSendCards=0 |

## Findings

### Minor

**m1. A lean given as a bare letter reads `LEAN B` and repeats option B.**
- **Job hurt:** 3 (respond to a pick). The owner reads "LEAN B" and still has to scan for what B is. This is the same "what is the choice" gap in a smaller form.
- **Evidence:** in the pass2 stress item (`lean: "B"`, alts A–D), the card shows a `LEAN B` chip above a separate `B: SQLite in the server…` button. Clicking either one stages a different answer (`lean` vs `alt 1`) that means the same thing. See `r47-dark-1920-longsrc.png`.
- **Cause:** D3 is told to put the lean "in the same form and leave it out of alts" (`server/decision-assistant.mjs:88`), so inferred cards are fine. Structured writers get `--lean "<option>"` with no such rule (`docs/WORKFLOWS.md:27`), and the card renders `item.lean` verbatim (`src/BoringDecisionDesk.tsx:1028-1035`).
- **Fix:**
  - In the card, when `lean` is a bare label (`^\(?[A-Za-z0-9]\)?$`) that matches an alt prefix, show the chip as `LEAN B: SQLite in the server…` and hide the duplicate alt button.
  - Extend the C3 writer rule: "`--lean` uses the same one-line definition and isn't repeated as `--alt`".
- **Files:** `src/BoringDecisionDesk.tsx`, `docs/WORKFLOWS.md`, role prompt text.
- **Effort:** S.

**m2. `Show source ▾` on an inferred card with no context opens on nothing useful.**
- **Job hurt:** 3. A disclosure that promises the asker's words but shows nothing (or the title again) teaches the owner to stop clicking it.
- **Evidence:** the demo parry card (`inferred: true`, no context, no rawText) opens to "No source message excerpt available." This is visible on the default `?demo` page in all 4 configs (`r47-*-parry-source-open.png`). In the live feed, an inferred item whose asker is gone falls back to `rawText`, the one logged line, which is often near-identical to the title.
- **Cause:** `hasSourceDisclosure` shows the disclosure on every inferred card (`src/BoringDecisionDesk.tsx:157`), and `sourceExcerptText` falls back to rawText, then the placeholder (`:162-165`). The spec asked for this ("every inferred card"), so this is a spec question.
- **Fix:** only show the toggle when there is `context`, or when `rawText` differs from `ask`. Label the rawText-only case `Show original line ▾`. Give the demo parry item a rawText or drop its `inferred` flag.
- **Files:** `src/BoringDecisionDesk.tsx`.
- **Effort:** XS.

**m3. `Not that` on a pick-one card with no lean is ambiguous.**
- **Job hurt:** 3. On `A | B | C | Not that` there is no "that". The button means "none of these", but the asker receives `Not that: no, do not go ahead.`, which reads as "drop the whole thing". On a mixed ask, the veto window could be read as rejected too.
- **Evidence:** both demo C2 cards have `lean: ""` with 2–3 alts and show `Not that` (`r47-*-pf-closed.png`). Building the prompt for `choice: "not"` on such an item gives `Owner's answer: Not that: no, do not go ahead.`
- **Cause:** `server/decisions.mjs:489`. This existed before C2, but C2 makes no-lean A/B/C cards common, because D3 now fills alts from the context.
- **Fix:** when `!lean && alts.length`, label the button `None of these`. Have the prompt say `None of the listed options; see the owner's reply.`
- **Files:** `src/BoringDecisionDesk.tsx`, `server/decisions.mjs`.
- **Effort:** XS.

## Owner decisions
- None needed. m2 asks whether the spec's "every inferred card" should become "every card with something new to show". **Recommendation:** yes. The lead can take that without the owner.

## Inbox cards (owning lane @desk)
- m1: resolve a bare-letter lean to its option definition and dedupe it; add a `--lean` same-form rule to C3.
- m2: hide or relabel `Show source` when there's no context; fix the demo parry item.
- m3: on no-lean pick-one cards, `Not that` becomes `None of these`, with matching prompt wording.
