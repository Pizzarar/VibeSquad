FAIL 0/1/0 f5733849

## Findings

- **M1 · Hard-coded `"VibeSquad"` breadcrumb reads as the wrong project on `?team=efi&agent=…` deep links** (`src/BoringAde.tsx:552`)
  - While `opening` is true, `crumbs` is set to `[{ key: "project" as const, label: "VibeSquad" }]` and rendered inside `<nav className="boring-breadcrumb">` as `data-testid="boring-crumb-project"` (`src/BoringAde.tsx:785-792`).
  - Because the app mark `"VibeSquad"` already lives in the sidebar header (`src/BoringAde.tsx:588`, `.boring-sidebar-brand`) and `.boring-crumb-project` is the active project's name slot (`"Escape From Idle"` vs `"VibeSquad"`), opening `?team=efi&agent=<id>` displays `"VibeSquad"` (another project's name) in the project breadcrumb for 1.4–3.8s before flipping to `"Escape From Idle › …"`. This reproduces the R7-1 wrong-project breadcrumb symptom in reverse for non-VibeSquad projects.
  - **Fix:** Render an empty crumb list (`[]`) or a neutral non-project label (`[{ key: "project" as const, label: "Opening…" }]`) while `opening` is true.

## Verification Checklist (a–e)

- **(a) Plain page load with no `?agent=`:** `activeAgentId` (`src/BoringAde.tsx:398`) reads `panes.leftActiveId` / `panes.rightActiveId`. In Normal mode (`app.vibe === "boring"`), `savedFocusForUrl` in `src/pinFocus.ts` suppresses saved-agent restore unless the URL has `?agent=`, so a plain page load has `activeAgentId === null` and `boringDeepLinkPending` (`src/pinFocusLogic.ts:202`) returns `false` (never shows `"Opening agent…"`).
- **(b) Unsticking once `rosterLoaded` flips (including missing/deleted agent):** `boringDeepLinkPending` (`src/pinFocusLogic.ts:202`) is `!a.rosterLoaded && !!a.activeAgentId`. As soon as `rosterLoaded` becomes `true`, `opening` flips to `false` unconditionally even if `activeAgentId` no longer exists in `agents`, returning cleanly to Overview without sticking.
- **(c) Bare breadcrumb on `?team=efi`:** Rated **Medium (M1)** above (`src/BoringAde.tsx:552`).
- **(d) CSS rule:** `html[data-vibe="boring"] .boring-opening` (`src/boring.css:1228`) starts at column 0, is prefixed with `html[data-vibe="boring"]`, and uses no `@container`.
- **(e) `data-testid` contracts:** Existing `data-testid` attributes (`boring-usage-view`, `boring-project-view`, `boring-overview-tabs`, `boring-chat-column`, `boring-breadcrumb`, `boring-crumb-project`) are preserved when `!opening`, and `data-testid="boring-opening"` (`src/BoringAde.tsx:829`) is added for the pending deep-link state.
- **Cause-vs-symptom gate:** Fixes the root cause of the Overview flash (gates main-pane view rendering on `boringDeepLinkPending` while `!rosterLoaded && !!activeAgentId`), aside from M1's hard-coded project label.

## Test Output (`review-test.log`)

```
ℹ tests 117
ℹ suites 0
ℹ pass 116
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 105595.8723
```
