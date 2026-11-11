# bug-chaser (@bug) SPEC

Standing lane: Aub's bug dump, coordination fixes, and the 0.3 critical path (PLAN_V03_STABILIZE: M1 + R1 done, X1 identity in flight).

## Lane habits
- **Archive on merge (Hub6, 11-11):** when a branch that fixes an inbox card merges, run `vs inbox triage --archive <idea-ids>` in the same turn as the merge/push. Before a plan block closes, check its cards are archived.
- Commit trailer `Live-Needs: <server-restart|runner-restart|build|frontend-reload|none>` (valid tokens: `LIVE_NEEDS`, server/sync-runtime.mjs:176; UI changes are `build, frontend-reload`) goes in the same final -m paragraph as Co-Authored-By; ping Hub6 on push with the value.
- Full suite: `npm test -- --queue` in the foreground, once per merge batch. Workers run only their own tests.
- Don't restart the server or runner yourself (Hub6 owns build, sync and restart).