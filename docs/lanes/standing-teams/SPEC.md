# Standing Teams (`@sta`) — Lane Spec

## Scope & Goal
Separate the permanent **Team** (`lane` in `teams.json`, brief, spec, `@<code>`) from its current **goal** (`## Done when`):
1. **Standing vs Disposable Teams:** `standing?: boolean` on `PinFields` (`src/pins.ts`), toggled in `PinMenu` (`src/PinMenu.tsx`). Standing teams show `✓ Goal shipped` instead of `Mark complete` (`src/PinDone.tsx`, `src/pinComplete.ts`), moving `## Done when` to a `Shipped YYYY-MM-DD: <goal>` line in the brief, retiring Lead/Buddy, and keeping `state: "pinned"` (sleeping `.no-session` in sidebar/grid).
2. **Wake sleeping lanes on `Send to`:** `sendIdeaToTeam` (`src/pinActions.ts`) wakes a sleeping pinned lane's Buddy via `openPin` and sends the message directly instead of dropping to Inbox.
3. **Fold `-2` duplicate lanes & prevent `-2` clones:** Reopen same-squad `done`/`removed` lanes on `createPin` / `vs pin new` instead of minting `-2`, record `aliases` + `state: "removed"` on `vs pin merge`, and fold `bug-chaser-2` → `bug-chaser` (`@bug`) and `quickstart-2` → `quickstart` (`@qui`).

## Key Contracts & Files
- `src/pins.ts`: `PinFields.standing?: boolean`, `isStandingPin(pin: Pin): boolean`.
- `src/pinComplete.ts`: `shipGoalBrief(brief, stamp)`, `runMarkComplete(pin, fx)` branching on `pin.lane.standing`.
- `src/PinDone.tsx` & `src/PinMenu.tsx`: `✓ Goal shipped` label/tooltip on standing pins; `Make standing team` / `Make disposable team` menu toggle.
- `plugin/server/remote-proxy-rules.ts`: allow `standing` and `backend` in `LANE` schema; pin `backend` in `PINNED_LANE_KEYS`.
- `src/pinActions.ts` & `src/PinIdeas.tsx`: `sendIdeaToTeam` wakes sleeping pinned lanes via `openPin`; `createPin` reopens same-squad `done`/`removed` lanes of the same slug.
- `cli/vs.mjs`: `commandPin` reopens same-squad `done`/`removed` lanes; `commandPinMerge` appends `fromLane.id`/`code` to `intoLane.aliases` and sets `fromLane.state = "removed"`.
