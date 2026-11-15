# Code Review · `unit-desk-r2-needs-you` (`f32e7e8`)

**Verdict:** `FAIL 2/2/2 f32e7e8` (2 High, 2 Medium, 2 Low)
**Branch / Commit:** `unit-desk-r2-needs-you` @ `f32e7e8` (`git diff master..f32e7e8`)
**Spec:** `docs/PLAN_DESK_R2_SIDEBAR.md` (Unit 2), `docs/UX_REVIEW_R2.md` (R2.4, R2.7), `docs/lanes/desk/SPEC.md` (rule 5)

## Verification Run
- `npx tsc --noEmit`: PASS (exit 0)
- `node --test test/boring-mode.test.mjs test/attention-items.test.mjs test/css-classes.test.mjs test/clear-attention.test.mjs test/squad-queue.test.mjs`: PASS (101/101 tests)
- Viewed all 6 screenshots in `docs/shots/desk-r2-needs-you/`:
  - `needs-you-dark-expanded.png`
  - `needs-you-dark-hover-menu.png`
  - `needs-you-dark-sidebar.png`
  - `needs-you-light-expanded.png`
  - `needs-you-light-hover-menu.png`
  - `needs-you-light-sidebar.png`

---

## Findings

### High

1. **[H1] Hub / Squad-id lane items still render `"VibeSquad › VibeSquad"` (and `"VibeSquad › vibesquad"` in `Done recently`, `"VibeSquad › ui-bois"` on dynamic lanes) in all 6 screenshots (`src/BoringInbox.tsx:59-61, 82`)**
   - In `needsYouRows` (`src/BoringInbox.tsx:59-61`):
     ```tsx
     const laneDef = view.team.lanes.find((l) => l.id === member.laneId);
     const hub = laneDef ? isHubLane(view.team, laneDef) : !member.laneId;
     const lane = hub ? "Desk" : laneDef?.name ?? member.laneId ?? "Desk";
     ```
     - In `src/BoringAde.tsx:79, 180, 202`, any lane whose `id === view.team.id` is folded into the project's `Desk` (`!isHubPin(p) && p.lane.id === view?.team.id`). However, `BoringInbox.tsx:60` only checks `laneDef ? isHubLane(view.team, laneDef) : !member.laneId`. When a Squad has an explicit `hub: true` lane alongside a Squad-id lane (e.g., `scripts/ui-overlap/env.mjs:20-21` has `{ id: "riffbot", hub: true }` and `{ id: "vibesquad", name: "VibeSquad" }`), `isHubLane(view.team, laneDef)` returns `false` for `id: "vibesquad"`; and when `member.laneId === view.team.id` is not in `view.team.lanes`, `!member.laneId` is also `false`.
     - As a result, **every VibeSquad Desk item in all 6 screenshots (`docs/shots/desk-r2-needs-you/*.png`) still displays `VibeSquad › VibeSq...` (`VibeSquad › VibeSquad`) instead of `VibeSquad › Desk`**, directly failing `docs/UX_REVIEW_R2.md` R2-7 and the Unit 2 done-check (`docs/PLAN_DESK_R2_SIDEBAR.md:34, 57`).
     - Additionally, `view.team.lanes.find(...)` (`src/BoringInbox.tsx:59`) searches only static `view.team.lanes` instead of `view.lanes` (`view.lanes.find((l) => l.lane.id === member.laneId)?.lane`) and does not format with `boringLaneLabel`. Dynamic lanes like `ui-bois` in `?demo` fall back to raw `member.laneId`, rendering `VibeSquad › ui-bois` on row 9 of `needs-you-{dark,light}-expanded.png` while the sidebar tree renders `UI Bois`.
     - In `doneRecently` (`src/BoringInbox.tsx:82`), `fromLog` formats `where` as `` `${d.project}${d.entry.lane ? ` › ${d.entry.lane}` : ""}` `` without mapping hub / Squad-id lanes (`d.entry.lane === d.teamId` or `isHubLane`) to `"Desk"`. In all 6 screenshots, `Done recently (1)` displays `VibeSquad › vibesquad · 14m` instead of `VibeSquad › Desk · 14m`.

2. **[H2] Legacy v1 lead titles (`"★ MAIN GAME ord75"`, `"★ LEAD · Plugins"`) are not cleaned, and `legacyLeadTitle` adds a new regex cleaner that misses the v1 format (`src/attentionItems.ts:86-90`, `src/BoringInbox.tsx:63`)**
   - `docs/UX_REVIEW_R2.md` R2-10 (`line 43`) and R2.7 (`line 106`) require cleaning raw legacy titles in `Needs you` — specifically `"★ MAIN GAME ord75"` (`src/demo.tsx:91`, matching `legacyTitleFor` `★ ${LANE} ord${l.ord}` at `src/teams.ts:1214`) and `"★ LEAD · Plugins"` (`src/demo.tsx:96`) — using the existing `formatDisplayTitle` / `cleanTitle` helpers (no new cleaner).
   - Instead, `src/attentionItems.ts:86-90` introduces a new regex function `legacyLeadTitle`:
     ```ts
     export function legacyLeadTitle(who: string, lane: { laneName?: string; laneId?: string; hub?: boolean }): string {
       const m = /^(?:★\s*)?(?:lead\s*·\s*)?ord(\d+)\s*(?:·\s*(.+))?$/i.exec(who.trim());
       if (!m) return who;
       return formatDisplayTitle({ role: "lead", laneName: lane.laneName, laneId: lane.laneId, ord: m[1], job: m[2], hub: lane.hub }).replace(/^★\s*/, "");
     }
     ```
   - For `"★ MAIN GAME ord75"`, `cleanTitle("★ MAIN GAME ord75")` returns `"★ MAIN GAME ord75"`, and `legacyLeadTitle`'s regex fails to match because the lane name (`MAIN GAME`) sits between `★` and `ord75`, returning `"★ MAIN GAME ord75"` untouched.
   - For `"★ LEAD · Plugins"`, `cleanTitle("★ LEAD · Plugins")` strips `"★ lead · "` to `"Plugins"`, which also does not match `legacyLeadTitle`, leaving the lane name `"Plugins"` as `who`.
   - In `needsYouRows` (`src/BoringInbox.tsx:57-64`), `member` is already resolved (`member.kind`, `member.agent.labels`), so lead titles can be formatted via the existing `formatDisplayTitle` (`src/identity.ts:591`) / `cleanTitle` (`src/ui.tsx:56`) without adding a separate cleaner in `src/attentionItems.ts`.

### Medium

1. **[M1] `Done recently` log entries stack `.boring-dot.st-done` on a separate line above the text (`src/boring.css:1186-1187`, `src/BoringInbox.tsx:191-195`)**
   - Non-agent log rows (`src/BoringInbox.tsx:191-195`) render `<span className="boring-dot st-done" />` and `<span className="boring-done-text">{d.text}</span>` as direct children of `<li className="boring-done-row">`.
   - `src/boring.css:1186-1187` overrides `.boring-done-row` (previously `grid-template-columns: auto 1fr` at `src/boring.css:921`) with:
     ```css
     html[data-vibe="boring"] .boring-done-row { grid-template-columns: 1fr auto; }
     html[data-vibe="boring"] .boring-done-row > .boring-dot, html[data-vibe="boring"] .boring-done-row > .boring-done-text { grid-column: 1; }
     ```
   - Assigning both direct child spans to `grid-column: 1` places `.boring-dot` on row 1 and `.boring-done-text` on row 2. In all 6 screenshots (`docs/shots/desk-r2-needs-you/*.png`), the blue `.st-done` dot under `▾ Done recently (1)` sits on its own blank line above `PASS step4 team actions: build green, 3 files tou...`.

2. **[M2] Dismissing a `stalled` item records a static `"stalled"` signature in `dismissLocal`, permanently suppressing future stalls for that agent (`src/attentionItems.ts:70, 131-133`, `src/attentionLocal.ts:85-88, 105-109`)**
   - `dismissLocal(id, signature)` / `isLocallyHidden(id, signature, now)` (`src/attentionLocal.ts:85-109`) suppresses an item until its `signature` changes.
   - `src/attentionItems.ts:70` checks `!isLocallyHidden(m.agent.id, "stalled", now)` and `clearItem` (`line 132`) calls `d.dismissLocal(item.id, "stalled")` with the constant literal `"stalled"` instead of keying the signature to the agent's last activity timestamp (e.g., `stalled:${m.agent.updatedAt ?? ""}`).
   - Once a user dismisses a stalled agent once, `dismissed.get(agent.id) === "stalled"` stays true in `localStorage` even after the agent resumes work, updates `updatedAt`, and stalls again later.
   - Also, `BoringInbox` (`src/BoringInbox.tsx:86`: `now = Date.now()`) has no periodic timer (`setInterval`) to advance `now` (unlike `SquadQueue.tsx:88-91` and `BoringAgentHeader.tsx`), so a running agent that goes silent for 90s+ will not transition into `stalled` until an unrelated re-render occurs.

### Low

1. **[L1] Project row dot in `BoringAde.tsx` checks `(v.needsYou ?? 0) > 0` instead of `m.totalNeedsYou > 0` (`src/BoringAde.tsx:701, 703`)**
   - `src/BoringAde.tsx:701` computes the project dot tone with `m.projectErr ? "error" : (v.needsYou ?? 0) > 0 ? "needs-you" : null`, while line 703 renders `badge(m.totalNeedsYou, m.projectErr)`. Using `m.totalNeedsYou > 0` keeps the dot and collapsed badge consistent.

2. **[L2] Screenshot coverage gaps in `docs/shots/desk-r2-needs-you/`**
   - Neither `Desk` nor `UI Bois` is expanded in `needs-you-{dark,light}-sidebar.png`, so the new sidebar worker attention reason (`boring-worker-why`) and row tints (`.needs-attn`, `.needs-err`) are not shown in any screenshot.
   - `needs-you-{dark,light}-hover-menu.png` opens the `⋯` menu on a `permission` row (`Audit - token scout`), which only shows `Snooze 2h` and does not show the `Dismiss` menu item on non-permission rows.

---

## Checklist Summary

| Check | Status | Notes |
|---|---|---|
| `Needs you` count == rows listed | PASS | `rows = all.filter((r) => r.item.kind !== "finished")`; `boring-needs-you-count` uses `rows.length` (`src/BoringInbox.tsx:103, 132`). |
| Cap 5 + `+ N more` | PASS | `NEEDS_YOU_VISIBLE = 5`; `boring-needs-you-more` toggles `▾ Show fewer` / `▸ + N more` (`src/BoringInbox.tsx:47, 105, 169-173`). |
| `finished` moved to `Done recently` | PASS | `finished` items merge into `doneRecently()` alongside `done` log entries (`src/BoringInbox.tsx:80-84, 104-106`). Log entries have a grid layout bug (**M1**). |
| Buttons only on permission rows; hover `⋯` Snooze/Dismiss keyboard-reachable | PASS | Inline `Allow`/`Deny` only when `item.kind === "permission" && item.quickPermission`; hover/focus-within `⋯` menu has `Snooze 2h` and (for non-permission rows) `Dismiss` (`src/BoringInbox.tsx:113-127, 158-163`, `src/boring.css:1174-1185`). |
| Hub location reads `Desk` | **FAIL** | Squad-id lane (`id === team.id`) when another lane has `hub: true` and `Done recently` log entries still render `VibeSquad › VibeSquad` / `VibeSquad › vibesquad` in all 6 screenshots (**H1**). |
| Legacy titles cleaned via existing `formatDisplayTitle`/`cleanTitle` (no new cleaner) | **FAIL** | Added new `legacyLeadTitle` regex in `src/attentionItems.ts:86-90`, which fails to match v1 `"★ MAIN GAME ord75"` and `"★ LEAD · Plugins"` (**H2**). |
| `stalled` kind in `src/attentionItems.ts` with nothing downstream broken | PARTIAL | Opt-in via `now` parameter keeps badge/queue callers (`pins.ts`, `SquadQueue.tsx`, `AttentionList.tsx`) unbroken (`KIND_LABEL.stalled` added in `AttentionList.tsx:39`), but `dismissLocal` uses a static `"stalled"` signature (**M2**). |
| Worst-state `glyphCls` on container dots | PASS | Lane (`c.err ? "error" : ...`) and project (`m.projectErr ? "error" : ...`) dots use worst-state `glyphCls` (`src/BoringAde.tsx:618, 701`; minor `v.needsYou` vs `m.totalNeedsYou` note in **L1**). |
| CSS only under `html[data-vibe="boring"]`, append-only, no new `@media` | PASS | `src/boring.css:1165-1197` is append-only, all 32 rules scoped under `html[data-vibe="boring"]`, 0 `@media` rules. |
| `data-testid` contracts kept | PASS | All existing testids preserved (`boring-needs-dismiss` remains in DOM inside the menu for non-permission rows). |

## Cause-vs-Symptom Gate
- **Does this fix the cause or hide the symptom?** The separation of `finished` into `doneRecently()` and the 2-line row restructure address the root cause of R2-4/R2-5/R2-6, but the incomplete hub-lane detection (`BoringInbox.tsx:59-61, 82` disagreeing with `BoringAde.tsx:79, 180, 202` — **H1**), the custom regex in `legacyLeadTitle` that misses v1 lead titles (**H2**), the broken CSS grid placement on `Done recently` log items (**M1**), and the non-expiring `"stalled"` dismissal signature (**M2**) must be fixed before merge.
