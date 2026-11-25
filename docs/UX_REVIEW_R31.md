# UX Review R31: R1 roles-only pickers, round 3 (@per)

- Code under review: `unit-per-r1-integ` @ `958b6ee9` (UI r2 `98fcb131` + `3dfe093c`, server r2 `a7e856d6`). Previous round: `docs/UX_REVIEW_R30.md` (FAIL 0/2/3 on f4987476).
- Owner answers applied (lead, 11-25; not re-litigated): UI spawns resolve through the ladder with a Stakes select, and the override spans the role's provider list.
- Run: `vite` on the integ worktree, `?demo=1`, Normal mode (`app.vibe=boring`), 3200x1800 @ dsf 1.2 and 1920x1080, dark and light. Shots are in `docs/ux-r31/` (`d`/`l` = dark/light, then width; `saved-*` = a seeded `newAgent.profile`, dark 3200). In `*-newagent-override.png` the override `<select>` was expanded with `size=N` so its groups show. No page errors in any run. `node --test test/r1-fix-ui-r2-spawn.test.mjs`: 9/9 pass (it covers the role → hook → ladder path, stakes, the override, legacy picks, and the Paseo env carrier).

**Verdict: FAIL 0/1/3 on 958b6ee9.** Every R30 finding is fixed. The one open major is pre-existing and needs one CSS line: in dark Normal mode the badge that now says which model the ladder picked can't be read (1.4:1 contrast).

## Status vs R30

| R30 finding | Status | Evidence |
|---|---|---|
| M1 "From ladder" not real | **Fixed** | A role row sends the role key as `profile`, sends no `model`, and puts `stakes` in the labels (`src/roleSpawn.ts` `buildRoleSpawn`; `TeamActions.tsx` submit). The badge follows stakes. Implement: normal `claude/claude-sonnet-5-5`, tierA-security `claude/claude-opus-5-5`, mechanical `claude/claude-sonnet-5-5` (the demo ladder's claude cheap rung is sonnet). Per-role ladder at normal: Lead and Brainstorm `claude-opus-5-5`, Planner `claude-sonnet-5-5`, Review and Art Director `antigravity-cli/gemini-4-neon`, Pre-check `antigravity-cli/gemini-3.8-flash`, Art Painter `claude-opus-5-5`. The badge row reads `provider/model … · via ladder · stakes normal` (`d3200-newagent.png`, `l1920-newagent.png`). Tests 2-4 in `r1-fix-ui-r2-spawn.test.mjs` show the hook routes these by ladder. **Readability: see new M1.** |
| M2 non-Claude workers, Buddies and Leads can't be started | **Fixed** | The override is grouped by the role's providers: `claude`, `antigravity-cli`, `opencode`. Each group has a "· ladder rung" row plus that provider's models (`d3200-newagent-override.png`, `l3200-newagent-override.png`). Lead, Brainstorm, Review, Pre-check, Art Director, Art Painter and Planner were each set to `antigravity-cli|gemini-4-neon`, and the badge reads `antigravity-cli/gemini-4-neon · via override` (`d3200-newagent-lead-gemini.png`, `d1920-newagent-review-gemini.png`). OpenCode: `opencode/deepseek/deepseek-v4-pro`. Add Buddy has Stakes and Model override too, all 9 override values. The label written is `vs.route-override=provider=antigravity-cli model=gemini-4-neon`. |
| m1 Add Buddy chip leaks the legacy name | **Fixed** | Chip `profile=Brainstorm`, and the value sent is the role key `brainstorm` (`l3200-addbuddy.png`, `d3200-addbuddy.png`). |
| m2 PROFILE vs ROLE labels | **Fixed** | New Agent: `ROLE` (the role) and `SEAT` (lead/brainstorm/worker). Add Buddy: `BRAINSTORM ROLE`. Settings: `Default role` (`*-set-newagent.png`). |
| m3 missing saved default is silent | **Fixed** | `Saved default "Old Custom - Turbo" is missing; using Implement.` shows under ROLE in alert colour (`saved-OldCustomTurbo-newagent.png`). Settings shows `Old Custom - Turbo (missing)`. |

Saved-pick states (dark 3200):

| Saved `newAgent.profile` | New Agent shows | OK? |
|---|---|---|
| `Review - Gemini` | `Review (legacy: Review - Gemini)` + "Saved legacy pick: spawns with its pinned model until you choose a role.". Badge `antigravity-cli/gemini-4-neon`, modeId, thinkingOptionId. No stakes or override fields (these need a role row). | yes |
| `Work Order - DSP` | `Work Order (legacy: Work Order - DSP)` + the same note. Badge `opencode/deepseek/deepseek-v4-pro` | yes |
| `Old Custom - Turbo` | Missing note (above). Falls back to Implement via ladder | yes |

Settings shows the same three as `Review (legacy: …)`, `Work Order (legacy: …)` and `Old Custom - Turbo (missing)`.

Readability: selects, labels, chips, notes and the expanded override list read fine at both sizes, dark and light. Add Buddy at 3200 light (missing last round) is fine (`l3200-addbuddy.png`). **Exception:** badge values in dark (M1).

## Findings

### M1 (major, pre-existing, now load-bearing): In dark Normal mode the badge values, including the ladder-picked model, are near-black on a dark panel.
- **Job hurt:** 1 (start work) and 5 (pick the right worker). The owner's answer made this badge the only place the UI says which model the ladder resolved for the chosen stakes and override. In dark mode the value half (`claude/claude-sonnet-5-5`, `ladder`, `normal`) is almost invisible. The key half (`provider/model`) is light, so the row looks like labels with nothing in them (`d3200-newagent-override.png`, `d1920-newagent-review-gemini.png`).
- **Evidence:** Computed in dark at 1920: value `rgb(7, 4, 15)` on `rgb(38, 38, 50)`, which is **1.4:1**. Key `rgb(195, 192, 207)`. Light is fine: `rgb(43, 24, 64)` on `rgb(230, 227, 221)`. Cause: `src/styles.css:6163` forces `color: var(--on-pastel) !important` (ink `#07040f`) on `.def-badge`. That ink was meant for the fun-mode pastel fill, but Normal mode draws the badge on the dark panel. The rule is the same on master (`styles.css:6180`, from `805ce666`), so it is pre-existing. I missed it in R30. It also hits the other `.def-badge` uses (`RunnerSettingsSection.tsx:103/132/135`, `TeamSettingsModal.tsx:699-708`).
- **Fix:** In `src/boring.css`, add `html[data-vibe="boring"] .def-badge { color: var(--text-1) !important; }`, or add `:not(.def-badge)` to the 6163 rule for boring mode. Then check that the value reads at least 4.5:1 in dark and light. **Files:** `src/boring.css` or `src/styles.css:6163`. **Effort:** XS. The owning lane can be @per (it blocks R1) or @ui-bois (cross-surface CSS). I lean @per, as a one-line fold-in to R1.

### m1 (minor): Add Buddy doesn't show which model the ladder will pick.
- **Evidence:** New Agent has a `provider/model · via · stakes` badge row. Add Buddy has Stakes and `From ladder (stakes)` but nothing that resolves them. The only hint is the labels chip `stakes=normal` (`l3200-addbuddy.png`). To learn that a Buddy will run on `claude-opus-5-5`, or `gemini-4-neon` after a tierA change, the owner has to know the ladder.
- **Fix:** Reuse the New Agent badge row: `ladderPick(roleDef, ladder, stakes)` plus the override. **Files:** `src/TeamActions.tsx` (AddBuddyModal). **Effort:** XS.

### m2 (minor): New Agent's LABELS preview leaves out labels that are sent.
- **Evidence:** New Agent's chips read `team lane lead role profile job` only. The spawn merges `roleSpawn.labels` (`stakes=…`, `vs.route-override=…`) at submit (`TeamActions.tsx` `labels: roleSpawn ? { ...labels, ...roleSpawn.labels } : labels`). Add Buddy merges them before the preview, so its chips show `stakes=normal vs.route-override=provider=antigravity-cli model=gemini-4-neon`. The two modals disagree, and New Agent's preview is not what gets written. The badge row does carry stakes and via, so the information isn't lost.
- **Fix:** Merge `roleSpawn.labels` into `labels` before the chips render, as Add Buddy does. **Effort:** XS.

### m3 (minor): The override uses raw provider ids.
- **Evidence:** The group headers and rung rows read `antigravity-cli`, `antigravity-cli · ladder rung`, `opencode · ladder rung`. The badge reads `antigravity-cli/gemini-4-neon`. The owner thinks of these as "Gemini" and "OpenCode/DeepSeek", and the role editor uses display names. When closed, the select shows only `gemini-4-neon` with no provider (`d1920-newagent-review-gemini.png`). That's fine for Gemini but ambiguous if two providers ever share a model name.
- **Fix:** Use the provider display name in the optgroup label and the rung row ("Gemini · ladder rung"). Keep the id in `value`. **Effort:** XS.

## Checked and fine
- Stakes select (normal / tierA-security / tierA-invariant / mechanical) in New Agent and Add Buddy. The tierA options move Implement to the top rung.
- "From ladder (stakes)" is now accurate. The `via` badge separates `ladder`, `override (provider rung)` and `override`.
- Picking a role resets the override (`pickProfile` → `setOvValue("")`, the Add Buddy select onChange).
- Legacy picks keep the pinned path and say so. Picking any role row moves them to the ladder.
- The Add Buddy BRAINSTORM ROLE select still has one option (`Brainstorm`). It's acceptable now that override and stakes sit beside it, per the R30 note.

## Owner decisions
None new. Both R30 questions were answered (ladder + stakes; cross-provider override within the role's list), and the build matches.
