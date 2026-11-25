# UX Review R29: R1 roles-only pickers + role editor (@per)

- Code under review: `unit-per-r1-integ` @ `3e93d2e6` (R1 46dc0a16 + R1b 9781133a), plan `docs/PLAN_PER_ROLES_LADDER_1125.md` R1 (line 32) + done-check (line 42).
- Scope: `src/profiles.ts`, `src/TeamActions.tsx`, `src/TeamSettingsModal.tsx`, `src/SettingsHome.tsx`, `src/RoleEditors.tsx`.
- Run: `vite` on the R1 worktree, `?demo=1`, 3200x1800 @ dsf 1.2 (4K at 120%) and 1920x1080, dark + light. Shots: `docs/ux-r29/` (`d`/`l` = dark/light, then width). Native `<select>` lists were expanded with `size=N` so the options show up in a still image.

**Verdict: FAIL 0/2/3 on 3e93d2e6**

## Status vs previous round

This is the first UX round on R1. R28 covered a different area (B1 popstate), so nothing carries over.

| Check (brief) | Result |
|---|---|
| Settings role editor shows roles only; Planner is new; Work Order is hidden | PASS: tabs are Lead, Brainstorm, Implement, Planner, Review, Pre-check, Art Director, Art Painter. Work Order is gone from the tabs and from the ladder's "used by" list (`d1920-set-profiles.png`, `l3200-set-legacy.png`). |
| Profile pickers show roles only; model-named profiles are hidden aliases | **FAIL**: New Agent and Settings > New Agent defaults still list all 19 legacy profiles. They are relabeled `Role · model` but not collapsed (M1). |
| "Role · model" labels read clearly | **Partial**: the format reads well, but 2 pairs of labels are identical and 2 labels name the wrong role (M1, M2). |
| Saved selections still display sensibly | PASS: `Work Order - DSP` stays selected as `Work Order · deepseek-v4-pro`, an unknown name shows `Old Custom - Turbo (missing)`, and `Audit - DSF` shows `Implement · deepseek-flash` (wrong role, see M2). |
| Chrome readable (art-direction SPEC) | PASS: all text is readable in dark and light at both sizes. The ladder's dithered header band slightly lowers contrast on the TOP/MID/CHEAP captions, but this predates R1. |

## Findings

### M1 (major): The pickers are relabeled legacy profiles, not roles. Labels collide and model names still show.
- **Job hurt:** 1 (start work) and 5 (intervene: pick the right worker). The owner asked for one choice per job, with the model coming from the ladder.
- **Evidence:** `d3200-newagent-list.png`, `l1920-newagent-list.png`. The New Agent PROFILE list has 19 rows: Lead ×2, Brainstorm ×2, Planner ×2, Implement ×5, Review ×3, Pre-check ×3, Art Director, Art Painter. Exact duplicates:
  - `Implement · deepseek-flash` ×2 (Mechanical - DSF in `build` mode; Audit - DSF in `plan` mode, read-only).
  - `Pre-check · gemini-3.8-flash` ×2 (Pre-check - Flash; Scout - Flash).
  
  Picking one of a pair spawns a different prompt and mode than the other, and nothing on screen says which. The only clue is `<option title>`, which native dropdowns don't show.
  
  The same modal still shows model-named profile names: the `profile=Implement - Sonnet` label chip and the **"Reset to Implement - Sonnet template"** button (`TeamActions.tsx:587`). Settings > New Agent defaults has the same 20-entry list (`d3200-set-newagent.png`).
- **Cause:** `pickableProfiles` (`src/profiles.ts:806`) only drops profiles whose role is hidden (`work-order`). It never collapses profiles onto roles. `profileOptionLabel` (`:799`) builds the label from the profile's pinned `model`, not from the ladder rung.
- **Fix (recommended):** The picker lists roles (8 rows), plus a separate, optional "Model override" select. The default is "ladder (claude-sonnet-5-5)" and the options are catalog models. The saved legacy value shows as one extra row, `<Role> · <model> (legacy)`. The label chip and Reset button use the role name. Until then, at minimum, give colliding labels a suffix with the legacy head (e.g. `Implement · deepseek-flash (audit, read-only)`).
- **Files:** `src/profiles.ts`, `src/TeamActions.tsx`, `src/SettingsHome.tsx`. **Effort:** M.

### M2 (major): Read-only and specialist legacy profiles are labeled with the wrong role.
- **Job hurt:** 1 and 5. The label promises a builder and the spawn is something else.
- **Evidence:** In `saved-AuditDSF-set-newagent.png` and the roster dump, `Audit - DSF` (opencode, mode `plan`, read-only census) shows as **`Implement · deepseek-flash`**. Its own R1 prompt calls it "The DeepSeek hop of the Pre-check role" (`src/profiles.ts:368` block). `UX Reviewer - Opus` (`:500`) shows as plain `Review · claude-opus-5-5`, so the UX-review brief is invisible and it looks like a third generic reviewer.
- **Cause:** `LEGACY_HEAD_ROLE` at `src/profiles.ts:782` (`audit: "Implement"`) and `:786` (`"ux reviewer": "Review"`).
- **Fix:** Map `audit` to `Pre-check`, matching its prompt. Then either give UX Reviewer its own visible role or label it `Review (UX) · …`. Owner decision below.
- **Files:** `src/profiles.ts`. **Effort:** S.

### m1 (minor): The Add Buddy picker still shows raw legacy names.
- **Evidence:** `src/TeamActions.tsx:816-821`, the BRAINSTORM PROFILE select, renders `{p.name}` (`Brainstorm - Claude`, `Brainstorm - Gemini`). R1 changed the `title` there but not the label, so it disagrees with every other picker.
- **Fix:** Use `profileOptionLabel(p)`. **Effort:** XS.

### m2 (minor): The legacy profile count disagrees with the rows shown.
- **Evidence:** `l3200-set-legacy.png`: the header says `LEGACY AGENT PROFILES · read-only · 20 profiles`, but the roster below lists 19 rows because Work Order - DSP is filtered out. This breaks the "counts agree everywhere" invariant.
- **Cause:** The header counts all profiles (`src/TeamSettingsModal.tsx:132`, `:632` `{profiles.length}`), while the roster uses `pickableProfiles` (`:671`).
- **Fix:** Count the filtered list, or say "19 shown · 1 hidden alias". **Effort:** XS.

### m3 (minor): Roster rows in Legacy profiles lost their identity.
- **Evidence:** `l3200-set-legacy.png`. Rows read `WORKER Implement claude / claude-sonnet-5-5` ×1, `WORKER Implement opencode / deepseek/deepseek-flash` ×2, and so on (`TeamSettingsModal.tsx:695` shows `profileRoleName`). The NAME field below then shows the real name (`Lead - Claude`), so the row and the form disagree about what is selected. In a read-only legacy archive, the legacy name is the useful key.
- **Fix:** In this archive section show `<legacy name> → <Role>`. **Effort:** XS.

## Checked and fine
- Hidden alias kept when saved: `newAgent.profile = "Work Order - DSP"` still preselects in Settings and New Agent (`saved-WorkOrderDSP-*.png`) and is otherwise absent from the lists.
- Missing name: Settings shows `Old Custom - Turbo (missing)` (`saved-OldCustomTurbo-set-newagent.png`). New Agent falls back to `Implement · claude-sonnet-5-5` without saying so. This predates R1 and is out of scope.
- No page errors in any run.

## Owner decisions
1. **What should a picker list?** (a) 8 roles plus an optional model override, as the plan's "ladder is the only place a model is named" says; or (b) `Role · model` rows per legacy profile, as built. **Recommend (a).** (b) contradicts plan line 32 ("Settings UI ... show roles + ladder only") and keeps model choice in the profile.
2. **UX Reviewer:** make it its own visible role (it has a distinct brief and is spawned by name in lead notes), or fold it into Review as a brief/label. **Recommend:** a visible role "UX Review" at tier top. Folding it hides a real job.
