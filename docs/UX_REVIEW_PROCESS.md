# UX review: what was missing, and what to add (handoff for the Lead)

Context: three outside UX reviews (`docs/UX_REVIEW.md`, `_R2`, `_R3`) found critical and major problems in Normal mode. The squad's own reviewers had passed every unit involved. This doc explains why, and what to add so the squad catches these itself.

## 1. What the current reviewers are built to check

| Reviewer / check | What its brief says (source) | What it therefore can't catch |
|---|---|---|
| **Art Director - Gemini** | Judges **one rendered PNG + the brief**, **never reads code**. Its gates are sprite gates: silhouette, props vs background, pose, blob shapes, no-copy. Max 4 rounds, ends on `PASS`. (`server/profiles.mjs`, `ART_DIRECTOR_NOTE_BODY`) | Flows, multi-step states, two screens disagreeing, wrong counts, information architecture. A PNG can't show "the badge says 3 but nothing is listed". |
| **Review - Gemini** (code review) | Reviews the diff against the unit's plan; H/M/L findings; cause-vs-symptom gate. | Whether the **plan** is right for the owner. A unit that does exactly what its plan says passes, even when the plan makes the whole screen worse. |
| **Pre-check - Flash** | Checks report integrity (raw output, diff scope, tests). "Don't judge design." | Anything about UX, by design. |
| **ADE job walk** (`docs/ADE_JOB_WALK.md`) | Task-based, but "control-present" counts as passing, rows are mostly single steps, and it runs at 1600×1000. | It scored **41/41**, then **65/71**, while the core supervision job (see a badge → find who needs you and why) was broken. |
| **`scripts/ui-overlap.mjs`, `ui-clicks.mjs`** | Geometry: clipping, overlap, contrast, menu size. | Meaning. A perfectly laid-out list that shows the wrong thing passes. |
| **Unit screenshots** | Taken by the implementer, of the states the unit changed. | The rest of the screen, and the states nobody thought to open. |

**Result:** every reviewer is scoped to a unit, an image or a diff. Nobody owns the question *"does the whole app make sense to the owner doing their real jobs, on their real screen?"*

## 2. What the outside reviews did that the squad doesn't

Each item below shows how a specific finding was caught.

1. **Started from the owner's jobs, not the diff.** Five jobs: start work, monitor, respond to "needs you", review output, intervene. For each one, traced the actual clicks. Every finding names the job it hurts.
2. **Ran the real app, busy, on the owner's real screen.** `?demo` cast: 20+ agents, 3 projects, permissions, errors, questions, stalls. Viewport 3200×1800 CSS px (4K at 120%), both themes. Not the unit's own screenshots.
3. **Drove sequences, not single states.** Open project A, then B. Ctrl+J into a *different* project. Deep-link `?agent=`. Expand two projects. Push 10+ alerts. *Caught:* R2-1 (one tree, two shapes), R2-2 (wrong breadcrumb after Ctrl+J), R2-3 (two rows selected). None of these show in a single state.
4. **Checked that the same fact agrees everywhere it's shown.** Badge vs list vs overview count. Selected row vs breadcrumb vs open agent. Exactly one selected row. *Caught:* round 1's "badge 3, overview says nothing needs you", and round 3's "Needs you 13 vs badges 4".
5. **Looked at the whole screen after merges, not the unit's area.** *Caught:* R3-1. Workers ended up listed three times on screen (Needs you, tree, Workers panel), and each unit was correct against its own spec.
6. **Read code only to locate the cause of a symptom already seen.** *Caught:* the hub pin dropped in `boringSidebarModel`, the breadcrumb built from `view.team`, the 90s stall threshold. The Art Director is forbidden to read code, which is right for art and wrong for UX.
7. **Challenged the spec, not just the implementation.** The "active project" concept, "finished" counted as needs-you, a 90-second stall rule. A reviewer that grades against the plan cannot fail a bad plan.
8. **Measured instead of eyeballing.** About 115 characters per line, header taking about 30% of the column, 16 font sizes in one stylesheet, 100 `!important`s, column widths, row heights.
9. **Reported in a fixed shape.** Severity by user impact, evidence (screenshot or file:line), fix, files, effort. Each round starts with a status table against the previous round: fixed / regressed / half.
10. **Escalated real choices to the owner** (lane naming, inline approval) with a recommendation, instead of deciding silently.
11. **Wireframed structural changes before code** (the Design canvas linked in `docs/UX_REVIEW.md`).

## 3. What to add

### A. A UX reviewer profile (separate from the Art Director)

Needs vision + code reading + a browser (Playwright). Never edits source. A draft note body to add to `server/profiles.mjs` next to `ART_DIRECTOR_NOTE_BODY`:

```text
UX Reviewer. Judges whether the app works for the owner's real jobs, across the whole window, after merges. Never edit source; write only docs/UX_REVIEW_<lane>_R<n>.md and its screenshots (<lane> = your lane code, lowercase; n counts per lane: one more than the highest existing docs/UX_REVIEW_<lane>_R*.md, starting at R1, so two lanes never pick the same file; the old shared docs/UX_REVIEW_R<n>.md files stay where they are).
1. Read the job list (docs/UX_REVIEW.md §1.3) and the previous round's doc. Do NOT read the unit's plan until after your first pass.
2. Run the app with ?demo at 3200x1800 (the owner's 4K at 120%), then 1920x1080, dark and light. Drive the standard sequences: open project A then B; Ctrl+J into another project; open a Needs-you item; deep-link ?agent=; expand two projects; open a worker; 10+ alerts. Screenshot each.
3. Check the invariants: counts agree everywhere they're shown; exactly one selected row; breadcrumb = selected row = open agent; expanded projects share one shape; no agent listed more than twice on screen; nothing that explains WHY is truncated.
4. Only after you see a symptom, read code to name the cause (file:line).
5. Report: status table vs the previous round, then findings ranked critical/major/minor, each with job hurt, evidence, fix, files, effort. Question the spec when the spec is the problem. Put owner decisions in an "Owner decisions" section with a recommendation; never decide them.
Verdict line: PASS only if no critical or major finding is open for the area under review.
```

### B. When it runs

- At the end of each plan phase that touches Normal UI (`src/Boring*.tsx`, `src/boring*.ts`, `src/boring.css`, `src/Timeline.tsx`, `src/PermissionCard.tsx`, `src/BoringContextPanel.tsx`), and whenever the owner says "round N".
- **Gate:** a phase isn't done while a critical or major finding is open for its area, unless the owner overrides.
- Findings go to the owning lane as inbox cards. The doc lands under `docs/`.
- Keep the Art Director for pixel art and art-heavy screens. Don't stretch it into UX.

### C. Make the invariants automatic (cheap, and they catch regressions without a reviewer)

Playwright tests in `?demo` at 3200×1800, run with the suite:

1. Needs-you header count = number of items (shown + "N more").
2. With all projects collapsed, the project badges add up to the Needs-you count.
3. Exactly one selected row in the sidebar in every state below.
4. After a lane click, Ctrl+J, a Needs-you click, and `?agent=<id>`: the breadcrumb's project = the selected row's project = the open agent's project.
5. Two expanded projects have the same child structure (Desk, Bugs, lanes, all under their own row).
6. No agent title appears more than twice in the visible viewport.
7. The sidebar footer's y position is the same in every state.
8. A Needs-you reason shows at least ~40 characters before truncating.

Good homes: `scripts/ui-clicks.mjs` already drives the app and has test ids, or a new `test/normal-invariants.test.mjs`.

### D. Fix the job walk

- "Control-present" no longer counts as a pass for UX rows.
- Add multi-step attention rows:
  - "A permission in another project → answered in ≤1 click from anywhere"
  - "For each lit badge, know why in ≤1 click"
  - "Find a stuck worker and its reason"
  - "After Ctrl+J, the sidebar and breadcrumb show where you are"
- Run at 3200×1800 and 1920×1080, dark and light.
- Fresh-eyes rule: the walker doesn't read the batch's plan first.

## 4. Order

1. **C** (invariant tests). Fastest, and it would have caught R2-2, R2-3 and R3-2 automatically.
2. **A + B** (UX reviewer profile + gate).
3. **D** (job walk fixes).
