FAIL 0/1/4 cd3de949

# UX Review PER_R2: spawn transparency (`Role · model · reason`, landing badge) (@per)

- Code under review: `unit-per-r2-spawn-transparency` @ `cd3de949` (UI diff `cfafc3c0..cd3de949 -- src/`). Previous round: `docs/UX_REVIEW_PER_R1D.md` (PASS 0/0/0 on 6e21d4bf).
- Run: `vite --port 5391` in this worktree (not the live server), `?demo=1`, Normal mode (`app.vibe=boring`), 3200x1800 @ dsf 1.2 (4K at 120%), 1920x1080, 1280/1024 windows, phone 390x844 @ dsf 3, dark and light. The `?demoCapped=` hook drives the capped states. No page errors in any run.
- "Normal and Boring themes": Psycho (`app.vibe=fun`) is migrated to Normal once (`src/prefs.ts:245-256`), so the two live looks are Normal dark and Normal light. Both were measured.
- Shots are in `docs/ux-per-r2/`, named `per-r2-<d|l><width>-<surface>-<state>.png` (`dn`/`ln` = drawer in Normal).

## Status vs PER_R1D

| PER_R1D item | Status | Evidence |
|---|---|---|
| Badge contrast (M1 fixed there) | **Holds** | New Agent and Add Buddy `.def-badge`: dark 18.73:1, light 13.38:1, incl. the new `via failover (…)` and `via all capped (…)` badges |
| Add Buddy shows the resolved model (m1) | **Holds, improved** | `per-r2-d3200-addbuddy-failover.png`: `Gemini/gemini-4-neon · via failover (Claude capped → Gemini)` |
| New Agent preview = sent labels (m2) | Unchanged | not touched by this diff |

## What works

- **Landing badge (New Agent, Add Buddy)** is clear and readable at every size and in both themes. It never truncates: the longest badge is 407 px, `via all capped (Claude capped, Gemini capped, OpenCode capped)`, and the badges wrap.
  - `via ladder` → `per-r2-d3200-newagent-ladder.png`
  - `via failover (Claude capped → Gemini)` → `per-r2-d3200-newagent-failover.png`, `per-r2-l3200-newagent-failover.png`
  - mechanical with Gemini capped → `Claude/claude-haiku-5-5 · via failover (Gemini capped → Claude)` (A2 walk order) → `per-r2-d1920-newagent-mech-fail.png`
  - tierA-security → `Claude/claude-opus-5-5 · via ladder` → `per-r2-d1920-newagent-tierA.png`
  - all capped → `per-r2-d3200-newagent-allcapped.png`, `per-r2-l1920-newagent-allcapped.png`, `per-r2-l1920-addbuddy-allcapped.png`
- **Drawer chip** `Implement · claude-opus-5-5 · failover` is readable in full at 3200 and 1920, dark and light (`per-r2-dn3200-drawer-failover.png`, `per-r2-ln3200-drawer-failover.png`, `per-r2-dn1920-…`, `per-r2-ln1920-…`).
  - Contrast: dark 14.9:1 at the violet end and 18.1:1 at the well end. Light 8.7:1 and 11.1:1.
  - It looks like the existing chip (same `.role-model-chip`), so it doesn't clash with any other header chip. The reason just adds one more ` · ` segment.

## Findings

### M1 (major): the drawer chip loses the reason first when the header is tight
- **Job hurt:** 2 (monitor) and 5 (intervene: was this a failover I should switch back?). Breaks the invariant "nothing that explains WHY is truncated".
- **Evidence:**
  - The chip is a single ellipsized string, and the reason is its last segment.
  - 1024 window: `Implement · claude-opus-5-5 · failov…` (`per-r2-d1024-drawer.png`).
  - **Split at 1920** (the owner's normal Split use) with a 37-character title: the chip measures 250/265 px. With a 49-character title: 220/265 px, shown as `Implement · claude-opus-5-5 · …`, so the reason is gone entirely (`per-r2-d1920-split-longtitle.png`). Titles are allowed up to 60 characters.
  - The same row says "Implement" three times: the agent name, the muted `boring-agent-role` span, and the chip's role. The chip's role prefix is the part that could give way.
- **Cause:**
  - `src/BoringAgentHeader.tsx:180` joins role · model · why into one string.
  - `:204` renders it in one span.
  - `src/styles.css:6760-6774`: the `.role-model-chip` text overflows with an ellipsis.
- **Fix:**
  - In `BoringAgentHeader`, drop the role from the chip while the `boring-agent-role` span shows it.
  - Render the reason as its own child span with `flex-shrink: 0`, so the model id ellipsizes first. Or order it `Role · reason · model`.
  - `DrawerHeader.tsx:718` should get the same structure.
- **Files:** `src/BoringAgentHeader.tsx`, `src/DrawerHeader.tsx`, `src/styles.css`.
- **Effort:** S.

### m1 (minor): the tooltip is machine text and doesn't say what failed over
- **Job hurt:** 5.
- **Evidence:**
  - The chip's title is `Implement · claude-opus-5-5 (route:implement mid why=failover)` in the demo.
  - Live, it is the hook's `routeMetricText`: `stakes=… model=… effort=… reason=ladder tier=mid role=implement why=failover`. Here `reason=ladder` sits next to `why=failover`; `server/hooks/agent-duties.ts:2558` says this happens on purpose.
  - Before the spawn, the New Agent badge says `failover (Claude capped → Gemini)`. After the spawn, the drawer can't say which provider was skipped, because `vs.route` doesn't carry it (`server/spawn-route.mjs:284-292`).
- **Fix:**
  - Add a plain-words first line to the title, e.g. `Failover: Claude was capped, so this runs on Gemini`.
  - Keep the route text on a second line for experts.
  - This needs the hook to stamp the skipped family, e.g. ` from=claude` in `vs.route`; that is a @per/hook change.
- **Files:** `src/BoringAgentHeader.tsx:183`, `src/DrawerHeader.tsx:724`, `server/hooks/agent-duties.ts:2566`, `server/spawn-reason.mjs`.
- **Effort:** S.

### m2 (minor): "rung", "arm" and "legacy-name" are jargon, and the vocabulary differs between the modal and the drawer
- **Job hurt:** 2. A non-expert can't read "why" at a glance.
- **Evidence:**
  - The same routing shows `via ladder` in the New Agent badge (`src/roleSpawn.ts:86`) but `· rung` in the drawer chip (`SPAWN_REASONS`, `server/spawn-reason.mjs:9`).
  - Nothing in the UI explains `arm` (R0 alternation) or `legacy-name`. Their meaning lives only in the doc comment at `spawn-reason.mjs:6-8`.
- **Fix:**
  - Show the same word in both places (see Owner decisions).
  - Put a one-line gloss in the chip title: rung/ladder = "picked by role × stakes", arm = "alternating Sonnet/Gemini trial", override = "you or the caller picked the model", legacy-name = "old profile name".
- **Files:** `src/roleSpawn.ts` (`drawerSpawnWhy`), `src/BoringAgentHeader.tsx`, `src/DrawerHeader.tsx`.
- **Effort:** XS.

### m3 (minor): "all capped" looks exactly like a healthy pick
- **Job hurt:** 1 (start work).
- **Evidence:** `per-r2-d3200-newagent-allcapped.png`.
  - The badge `via all capped (…)` has the same neutral `.def-badge` style as `via ladder`.
  - `provider/model Claude/claude-sonnet-5-5` above it reads as if the spawn will just run there.
  - Spawn stays enabled, and nothing says what happens next. Per `src/roleSpawn.ts:60-62`, the hook "queues/warns" at the first provider.
- **Fix:**
  - Give the `via` badge a warn tone (`stat-alert` colours) when it starts with `all capped`. Optionally use a softer tone for `failover`.
  - Add one line saying what will actually happen, using the hook's real behaviour.
- **Files:** `src/TeamActions.tsx:419-425` and `:934-940`.
- **Effort:** XS.

### m4 (minor): phone and Psycho don't carry R2
- **Evidence:**
  - Phone (`per-r2-d390-phone.png`) shows only Overlord, Buddies and Bugs. `DrawerHeader` returns null in `chatOnly` (`src/DrawerHeader.tsx:1277`).
  - The phone's own line `◆ Gemini · gemini-4-neon` (PhoneCockpit) has no role or reason. Workers can't be opened on phone, so a failover is invisible there.
  - `DrawerHeader`'s chip title (`:724`) omits `vs.route`, unlike `BoringAgentHeader:183`. This is reachable only in Psycho, which is retired.
- **Fix:**
  - Append `· <reason>` to the phone provider line (`drawerSpawnWhy` is pure).
  - Mirror the title in `DrawerHeader`.
- **Effort:** XS.

## Not covered (demo limits)
- The staged-switch hide and `override` from a `vs.model` mismatch: no demo agent has `vs.model` or a staged switch. I read the code path, `drawerSpawnWhy` (`src/roleSpawn.ts:14-20`), and it looks right.
- **Live caps vs the usage banner:** in the demo the "Claude 5h: 0% left" banner shows while the badge says `via ladder → Claude`, because the demo's caps come only from `?demoCapped`. On a live runner, worth checking that `/roles capped` agrees with the banner.
- **Standard full-window sequences:** these were not re-driven. This round covered only the R2 surfaces, and the diff touches no lists, counts or selection.

## Owner decisions
1. **One word for "picked by the ladder":** the modal says `ladder` and the drawer says `rung`. **Recommendation: `ladder`** in both. It is the word the New Agent and Settings screens already teach. Keep `why=rung` as the machine value if metrics depend on it.
2. **Should Spawn need a confirm when every provider is capped?** **Recommendation: no block, just the warn tone plus a "what happens" line (m3).** Blocking would fight the hook, which already queues.

## Files (uncommitted, for the lead)
- `docs/UX_REVIEW_PER_R2.md`
- `docs/ux-per-r2/` (19 PNGs)
