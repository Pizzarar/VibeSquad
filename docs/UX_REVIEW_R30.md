# UX Review R30: R1 roles-only pickers, re-review after fix (@per)

- Code under review: `unit-per-r1-integ` @ `f4987476` (UI fix `be9dcd85`, server fix `bd049c12`). Previous round: `docs/UX_REVIEW_R29.md` (FAIL 0/2/3 on 3e93d2e6).
- Lead decision applied (not re-litigated): pickers list roles plus an optional "Model override" that defaults to "From ladder (stakes)". A saved legacy pick shows as `<Role> (legacy: <old name>)`. The UX Reviewer role is deferred.
- Run: `vite` on the integ worktree, `?demo=1`, 3200x1800 @ dsf 1.2 and 1920x1080, dark and light. Shots are in `docs/ux-r30/` (`d`/`l` = dark/light, then width; `saved-*` = a seeded `newAgent.profile`). Native `<select>` lists were expanded with `size=N` so the options show in a still image. No page errors in any run.

**Verdict: FAIL 0/2/3 on f4987476**

## Status vs R29

| R29 finding | Status | Evidence |
|---|---|---|
| M1 pickers are relabeled legacy profiles | **Fixed (list)** | New Agent PROFILE has 8 rows: Lead, Brainstorm, Implement, Planner, Review, Pre-check, Art Director, Art Painter. There are no duplicates and no model names. The chip reads `profile=Implement` and the button reads `Reset to Implement template` (`d3200-newagent-list.png`, `l1920-newagent-list.png`). Settings > New Agent defaults has `Built-in default` plus the same 8 rows (`d3200-set-newagent.png`). **But** the ladder half of the fix does not hold: see new M1. |
| M2 Audit labeled Implement, UX Reviewer hidden | **Fixed / deferred** | `Audit - DSF → Pre-check` (`l3200-set-legacy.png`). UX Reviewer is deferred by the lead. It still maps to Review and can't be reached from New Agent (see M2). |
| m1 Add Buddy shows raw names | **Partly fixed** | The option now reads `Brainstorm`, but the labels chip still reads `profile=Brainstorm - Claude` (`d3200-addbuddy.png`). See m1. |
| m2 legacy count vs rows | **Fixed** | Header `LEGACY AGENT PROFILES · read-only · 18 profiles` matches the 18 roster rows (`l3200-set-legacy.png`). |
| m3 roster rows lost identity | **Fixed** | Rows read `Lead - Claude → Lead`, `Audit - DSF → Pre-check`, and the NAME field agrees. |

Saved-pick states (New Agent and Settings, dark 3200):

| Saved `newAgent.profile` | Shows | OK? |
|---|---|---|
| `Work Order - DSP` (hidden role) | `Work Order (legacy: Work Order - DSP)`, opencode/deepseek-v4-pro | yes |
| `Audit - DSF` | `Pre-check (legacy: Audit - DSF)` | yes |
| `Mechanical - DSF` | `Work Order (legacy: Mechanical - DSF)` | yes |
| `Review - Gemini` | `Review (legacy: Review - Gemini)`, override lists gemini-4-neon / gemini-3.8-flash | yes |
| `Old Custom - Turbo` (missing) | Settings: `Old Custom - Turbo (missing)`. New Agent: falls back to `Implement` without saying so | pre-existing (R29 out-of-scope note) |

Readability: all picker, override, chip and legacy-roster text is readable in dark and light at 3200x1800 and 1920x1080. No truncation of explanatory text.

## Findings

### M1 (major): "From ladder (stakes)" is not what the spawn does. New Agent always spawns the old profile's pinned model.
- **Job hurt:** 1 (start work) and 5 (pick the right worker). The default option tells the owner that the tier ladder picks the model. The owner edits the ladder in Settings (`l3200-set-legacy.png` shows the ladder editor), expects New Agent to follow it, and it doesn't.
- **Evidence:** The modal stamps the label with the backing legacy name, not the role: `profile: profile.name` gives `Implement - Sonnet` (`src/TeamActions.tsx:222`). It also sends `model: effectiveModel`, which is `modelOverride || profile.model` (`src/TeamActions.tsx:231`, `:276`). In the spawn hook, `matchStoredProfile` exact-matches the stored `Implement - Sonnet` and returns `explicit: true` (`server/hooks/agent-duties.ts:406-407`, `:2107`). The role route only runs when `!profileMatch?.explicit` (`:2134`), so the ladder is never consulted and the pinned model wins.
  - The modal has no stakes field at all (no `stakes` in `TeamActions.tsx`), so the "(stakes)" in the label has nothing behind it.
  - In demo the pinned models happen to equal the default ladder rungs (Implement - Sonnet = claude mid = sonnet), so the badge `provider/model claude/claude-sonnet-5-5` looks right. It goes wrong as soon as the ladder is edited or a role's main profile pins a different model.
  - The chip shows `profile=Implement` (display-only map, `TeamActions.tsx:424`), while the label actually written is `profile=Implement - Sonnet`, so the preview disagrees with what is sent.
- **Fix:** When the row is a role (not a `legacy` row), send `profile=<Role name>` and omit `model` unless an override is picked, so the hook's role route (`roleSpawnProfile`, stakes x tier ladder) picks provider and model. Show the model the ladder resolved in the `provider/model` badge, e.g. "ladder: claude-sonnet-5-5". Either add a stakes select (normal default) or rename the option to "From ladder". Keep legacy rows on today's path.
- **Files:** `src/TeamActions.tsx` (NewAgentModal, and AddBuddyModal `:709`; light Add Buddy shot is `l1920-addbuddy.png`), `src/profiles.ts` (a client-side ladder-resolve helper for the badge). **Effort:** M.

### M2 (major): Non-Claude workers and Buddies can't be started from the UI any more.
- **Job hurt:** 1 and 5. The owner can no longer start a Gemini cross-provider reviewer, a Gemini Buddy, a Gemini Lead or an opt-in DeepSeek implementer from the UI. Before R1 these were rows in the list (`Review - Gemini`, `Brainstorm - Gemini`, `Lead - Gemini`, `Senior Reasoning - DSP`). The R0 verdict "Sonnet default, DSP opt-in" needs a place to opt in.
- **Evidence:**
  - `rolePickRows` collapses each role to one main profile, ranked Claude first (`src/profiles.ts` `rolePickRows`, `rank` gives `provider === "claude" ? 0 : 1`).
  - `ladderModels(profile.provider)` then lists only that provider's rungs. With Implement selected, the override offers `claude-opus-5-5`, `claude-sonnet-5-5` only (`d3200-newagent-list.png`). The model changes but the provider can't.
  - The Add Buddy BRAINSTORM PROFILE select has exactly one option, `Brainstorm`, and no override at all (`d3200-addbuddy.png`, `d3200-addbuddy-list.png`), so it is a dead control.
  - `UX Reviewer - Opus` is also unreachable: Review maps to Review - Sonnet.
  - The only way back to a Gemini pick is a saved legacy default (`saved-ReviewGemini-*.png`). Once the owner switches away from it, it's gone from the list.
- **Fix:** Group the override select by the role's provider list, the same list the role editor shows (Claude / Gemini / OpenCode, `l3200-set-legacy.png` top). Picking one sets provider and model, e.g. `Gemini · gemini-4-neon`, with a "(provider)" option that means "that provider's ladder rung". Add the same select to Add Buddy. Then the 1-option select can stay, or it can become a static "Brainstorm" label.
- **Files:** `src/TeamActions.tsx` (NewAgentModal override `:348-355`, AddBuddyModal `:831-838`), `src/profiles.ts` (`ladderModels` takes the role's providers). Server: a role spawn already honours a caller provider/model (`bd049c12`, `vs.route-override`), but only via spawn_worker. The UI path needs the same, which comes for free with the M1 fix. **Effort:** M.

### m1 (minor): Add Buddy's labels chip still leaks the legacy name.
- **Evidence:** `d3200-addbuddy.png` shows the LABELS chip `profile=Brainstorm - Claude` while the select shows `Brainstorm`. `src/TeamActions.tsx:709` writes `profile: profile.name`. New Agent got the display map (`:424`); Add Buddy didn't.
- **Fix:** Folded into M1 (send the role name). At minimum, use the same `profileRoleName` display map. **Effort:** XS.

### m2 (minor): Two fields called "profile" and "role" mean different things in one modal.
- **Evidence:** New Agent shows `PROFILE: Implement` (a role from the role editor) right above `ROLE: worker` (the agent kind: lead/brainstorm/worker) (`l1920-newagent-list.png`). After R1 the PROFILE list is literally the Roles list, so "Role" now names the wrong control.
- **Fix:** Relabel PROFILE as ROLE, and the current ROLE as SEAT or KIND (lead / brainstorm / worker). Apply the same change in Settings > New Agent defaults ("Built-in default" + roles) and in Add Buddy. **Effort:** XS.

### m3 (minor, pre-existing): A missing saved default falls back silently in New Agent.
- **Evidence:** With `newAgent.profile = "Old Custom - Turbo"`, Settings shows `Old Custom - Turbo (missing)`, but New Agent quietly preselects `Implement` (`saved-OldCustomTurbo-newagent.png`). This was noted in R29 and is unchanged. It is now the one picker state that doesn't explain itself.
- **Fix:** Show a one-line note under the select: "Saved default 'Old Custom - Turbo' is missing; using Implement." **Effort:** XS.

## Checked and fine
- No duplicate or model-named rows in any role picker. Work Order is hidden unless it is the saved pick.
- The chip and Reset button use the role name in New Agent.
- Legacy roster: the header count matches the rows, rows read `old name → Role`, and Audit maps to Pre-check.
- Saved legacy picks display as `<Role> (legacy: <name>)` in both pickers, and their override lists match their provider.
- Readable in dark and light at both sizes.

## Owner decisions
1. **What does "From ladder" mean for a UI spawn?** (a) The ladder resolves it at spawn time: send the role name and let stakes x tier pick (needs a stakes select, default normal). (b) Keep pinned per-role models and rename the option "Role default". **Recommend (a)**, because it is what plan R1 says ("the ladder is the only place a model is named") and what the label already promises.
2. **Override scope:** should the Model override cross providers (Gemini reviewer, DSP implementer), or only change the model within the role's first provider? **Recommend crossing providers**, limited to the role's provider list from the role editor. Otherwise "DSP opt-in" and Gemini cross-review have no UI path.
