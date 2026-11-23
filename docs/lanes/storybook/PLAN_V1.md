# PLAN · Storybook v1 (`storybook`)

> Working name. "Storybook" collides with Storybook.js (a well-known UI dev tool). See Open #2.
> Companion doc: [`docs/lanes/studio/FUTURE_STATE.md`](../studio/FUTURE_STATE.md) (where this is heading). Anything here that has a 🔭 note is shaped now so the future state does not need a rewrite.

## Idea
Once a vibe-coded game grows past a prototype, the bottleneck moves from *making* story content to *understanding* it: dozens of quests, NPCs and dialogue branches spread across files, with dead ends, broken prerequisites and flags nobody sets. Storybook is the second workspace next to Code. It reads the project's narrative from the repo, draws it as a quest web you can click through, lints it deterministically, and lets you (or an agent) walk any branch. Every problem it finds can be sent to a lane as work.

The edge over generic narrative tools: VibeSquad's own agents write the content, so VibeSquad defines the format. Every finding can be dispatched to an agent and re-checked.

## Goals
1. One canonical, agent-friendly narrative format, committed in the game repo.
2. A read-only Storybook workspace: quest web → dialogue tree → detail card.
3. Deterministic structural lint you can trust (no LLM in v1).
4. Walk the story without running the game (path simulator, flag ledger).
5. Agents can query the narrative and create valid content (`vs story ...`).
6. Any node or finding → one click → a card in a lane.

## Non-goals (v1)
- Editing in the UI. It is read-only; changes go through agents or files.
- LLM checks (continuity, tone, pacing, "fun").
- Importing existing ad-hoc narrative, or third-party formats (Ink, Yarn, Dialogic).
- Branch/worktree views, narrative diff, verdict-gate integration.
- Production status, provenance, sign-off, roles. See the future state.
- Studio Hub. v1 uses simple top tabs.
- Psycho mode. Storybook is Normal-layout only.
- Engines other than Godot 4.

## Decided (from the owner riff)
- **General-purpose tool, game-specific pack.** VibeSquad builds apps, games, anything. Storybook is the first *domain pack*, shown only for Squads that opt in. The core pieces (registry, finding schema, `studio/` folder, dispatch) stay engine- and domain-agnostic.
- **Godot 4 only for now.** Engine specifics sit behind an adapter, following the `vs_playtest` precedent (`godot/addons/vs_playtest/`).
- **VibeSquad defines the format.** Existing narrative is ad-hoc (there is no code or instructions for it), so v1 ships no third-party parsers.
- **The repo is the source of truth.** A `studio/` folder is committed in the game repo. The derived index is a disposable cache under `~/.vibesquad/cache/`, never committed.
- **Read-only UI.** Fixes happen through "Send to lane" → agents → files → re-lint.
- **A minimal entity registry ships in v1.** Speakers, factions, locations and items referenced by the narrative are registry entities from day one, so v2 does not have to retrofit IDs. 🔭
- **Findings use the shared finding schema** (below), so they slot into the future audit contract and Studio Hub without changes. 🔭
- **Navigation:** top tabs `Code | Storybook` inside the Normal layout (`src/BoringAde.tsx`), scoped per Squad.
- **Phone:** outline, cards and findings list only. No graph on phones.

## The `studio/` folder (committed in the game repo)
```
studio/
  .gdignore                      # Godot never imports or exports this folder
  studio.yaml                    # schemaVersion, godotRoot (relative), enabled packs
  schemas/entity-types/*.yaml    # per-project, copied from starters (never linked)
  entities/<type>/<slug>.yaml    # one file per entity  (npc/bob.yaml → id npc.bob)
  narrative/
    quests/<slug>.yaml           # one file per quest
    dialogue/<slug>.yaml         # one file per dialogue tree
    flags/<namespace>.yaml       # flag declarations, grouped by namespace
  findings/dismissed/<findingId>.yaml   # a dismissal with its reason (shared, versioned)
```
Rules:
- **One file per thing.** Parallel lanes must not fight over one big file.
- **`schemaVersion` in every file.** `vs story migrate` upgrades old files later.
- **IDs are `<type>.<slug>`, immutable, and unique across the project.** Renaming changes `name`, never `id`. Delete by tombstone (`deleted: true`) so old references give a clear "deleted" finding instead of "unknown".
- **Folder location is configurable** in Squad settings (defaults to the repo root). Handles repos whose Godot project lives in a subfolder.
- **`.gdignore` is mandatory.** `vs story init` writes it and lint checks it is there.
- **The cache never lives in `studio/`.** Lint fails if index or cache files appear there.

### Example: entity
```yaml
schemaVersion: 1
id: npc.bob
type: npc
name: Bob
faction: fac.smiths
home: loc.millbrook
godot:
  scene: uid://c8k2...        # optional: the Godot resource UID this entity maps to
notes: Gruff blacksmith, lost his hammer in the mine.
```

### Example: quest
```yaml
schemaVersion: 1
id: quest.lost_hammer
title: The Lost Hammer
giver: npc.bob
area: loc.millbrook
faction: fac.smiths
act: 1
requires:
  quests: [quest.arrival]       # must be completed
  flags: { met_bob: true }
steps:
  - id: find
    text: Find Bob's hammer in the old mine
    location: loc.old_mine
    dialogue: dlg.bob_hammer_start
    completeWhen: { flags: { has_hammer: true } }
  - id: return
    text: Return the hammer
    dialogue: dlg.bob_hammer_return
outcomes:
  - id: returned
    sets: { hammer_returned: true }
    unlocks: [quest.forge_trial]
    ending: false
  - id: kept
    sets: { hammer_kept: true }
```

### Example: dialogue
```yaml
schemaVersion: 1
id: dlg.bob_hammer_start
speaker: npc.bob                # default speaker for nodes
start: greet
nodes:
  greet:
    text: "You there. Seen a hammer? Big one. Mine."
    choices:
      - text: "I'll find it."
        to: accept
        sets: { met_bob: true }
      - text: "Not my problem."
        to: refuse
      - text: "[Show hammer]"
        requires: { flags: { has_hammer: true } }
        to: early_return
  accept:
    text: "Old mine, east road. Don't die."
    startsQuest: quest.lost_hammer
    end: true
  refuse:
    text: "Hmph."
    end: true
  early_return:
    speaker: npc.bob
    goto: dlg.bob_hammer_return#start   # cross-tree jump
```

### Example: flags
```yaml
schemaVersion: 1
namespace: millbrook
flags:
  met_bob:        { type: bool, default: false, description: Player has spoken to Bob }
  has_hammer:     { type: bool, default: false }
  hammer_returned:{ type: bool, default: false }
  forge_rank:     { type: int,  default: 0 }
```

### Starter entity-type schemas
`vs story init` copies starters into `studio/schemas/entity-types/`: `generic`, `rpg`, `action`, or empty. They are per-project copies and agents may edit them. v1 uses them only for field validation. 🔭 In the future state they also declare *slots* (portrait, sprite, VO …) for coverage.

## Lint rules (deterministic, v1)
| Rule | Severity | What it catches |
|---|---|---|
| `NAR001 dead-end` | error | A dialogue node with no `choices`, `goto`, `startsQuest`, or `end: true` |
| `NAR002 unreachable-node` | warn | A node not reachable from its tree's `start` |
| `NAR003 orphan-quest` | warn | A quest with no giver or trigger that nothing unlocks or requires |
| `NAR004 broken-ref` | error | Unknown entity, quest, dialogue, node or flag ID (including `#node` targets) |
| `NAR005 deleted-ref` | warn | A reference to a tombstoned ID |
| `NAR006 prereq-cycle` | error | A quest requirement cycle (A needs B needs A) |
| `NAR007 flag-never-read` | info | A flag that is set but never read |
| `NAR008 flag-never-set` | error | A flag that is read but never set, where the required value ≠ its default (the condition can never be met) |
| `NAR009 unreachable-outcome` | warn | A quest outcome or ending that is unreachable under flag over-approximation (see below) |
| `NAR010 schema` | error | Missing required fields, wrong types, unknown `schemaVersion` |
| `NAR011 duplicate-id` | error | The same ID in two files |
| `NAR012 studio-hygiene` | error | `.gdignore` missing, or cache/index files inside `studio/` |

**Reachability model (NAR009, path simulator):** v1 treats flags as *monotonic over-approximation*: a flag value counts as obtainable if any reachable node sets it. This can miss some unreachable content but never falsely flags reachable content. Being trustworthy matters more than catching everything. The exact solver is in the backlog.

## Finding schema (shared, 🔭 audit contract v0)
```jsonc
{
  "id": "sha1(rule + subject + location)",   // stable across runs, used for dismissals
  "domain": "narrative",
  "signal": "integrity",          // integrity | coverage | cohesion | signoff (v1 emits integrity only)
  "rule": "NAR001",
  "severity": "error",            // error | warn | info
  "confidence": "deterministic",  // deterministic | heuristic | llm
  "subject": { "kind": "dialogue-node", "id": "dlg.bob_hammer_start#refuse" },
  "location": { "file": "studio/narrative/dialogue/bob_hammer_start.yaml", "pointer": "/nodes/refuse" },
  "message": "Node 'refuse' has no exit.",
  "deepLink": "?squad=<id>&ws=storybook&node=dlg.bob_hammer_start%23refuse",
  "firstSeen": "<iso>",
  "dismissed": null                // or { by, at, reason } from studio/findings/dismissed/
}
```

## Agent interface: `vs story`
| Command | Purpose |
|---|---|
| `vs story init [--starter rpg]` | Create `studio/`, `.gdignore`, `studio.yaml`, starter schemas |
| `vs story new <quest\|dialogue\|entity\|flag> <id>` | Scaffold a valid file (agents should use this, not invent structure) |
| `vs story lint [--json] [--rule NAR001]` | Run lint; exit code ≠ 0 on errors |
| `vs story query <id>` | One entity, quest, dialogue or node, with resolved references |
| `vs story refs <id>` | Everything that references the ID |
| `vs story find <text>` | Full-text search over titles and lines |
| `vs story path --to <id> [--flags k=v,...]` | One shortest path from game start to the target, with the flags it needs |
| `vs story flags [<flag>]` | Flag ledger: where each flag is set and read, its type and default |

All commands print compact text by default and accept `--json`. They read the same index as the UI. Agents must never receive the whole graph in their prompt; they query it.

**Agent duties (Squads with Storybook enabled):** a prompt-layer snippet via `server/hooks/agent-duties.ts` / role packs says: *story content goes in `studio/narrative/`; scaffold with `vs story new`; run `vs story lint` before reporting done; do not mark work done with new `error` findings.*

## UI
**Tabs:** `Code | Storybook` at the top of the Normal layout, per Squad. The tab appears when the Squad has Storybook enabled (Team Settings toggle; auto-suggested when a `studio/` folder exists). With no `studio/`, it shows an empty state with an **Init** button.

**Storybook layout (desktop):**
- **Left: outline.** Acts → quests → steps. Filters: act, faction, area, speaker, "broken only". Search.
- **Center: graph.**
  - *Quest level:* quests as nodes; edges for requires, unlocks and outcome. Finding badges on nodes.
  - *Dialogue level:* double-click a quest step or dialogue to drill into its tree. Breadcrumb back.
  - Auto-layout with a stable seed so the layout does not reshuffle on small edits. Positions are **not** stored in v1.
- **Right: card.** The selected item: full text, speaker card (from the registry), prerequisites, flags set/read, inbound/outbound references, findings, **Send to lane**, **Copy deep link**.
- **Bottom drawer: findings.** Table filtered to the current selection or the whole project. Dismiss (with a required reason → `studio/findings/dismissed/`).
- **Agent chat** stays reachable in the right dock (`src/RightDock.tsx`), so you can look at the graph and talk to the Buddy at the same time.

**Path simulator (in the card panel or a modal):** pick a start (game start or any node) and flag preset; click choices to walk; flags update live; locked choices show *why* they are locked. "Jump to" uses `vs story path` logic.

**Flag ledger view:** a table of flags: type, default, set-by, read-by, findings. Clicking a row highlights those nodes in the graph.

**Phone (`PhoneCockpit` / PWA / Android):** outline, card and findings list. No graph and no simulator in v1.

**Send to lane:** creates an inbox card in the chosen lane (`server/inbox.mjs`) with the subject ID, the finding (if any), the file pointer and the deep link. The card title is generated from the finding message.

## Plan
| Block | Touches | Kind |
|---|---|---|
| **B0 Format + schemas.** JSON Schema for each file type, the `studio/` layout doc, starter entity-type schemas, a sample story fixture (≥ 3 quests, ≥ 4 dialogues, deliberate lint violations) in `godot/sample/studio/` and `test/fixtures/story/`. Pick the YAML parser (new dependency, see Open #1). | docs, `test/fixtures/`, `godot/sample/` | Root |
| **B1 Parser + index.** Load `studio/`, validate against the schemas, resolve references, build an in-memory graph index. Cache to `~/.vibesquad/cache/<squad>/story-index.json`. Unit tests on the fixtures. | `server/story/` (new) | Root |
| **B2 Lint engine.** Rules NAR001–NAR012, the finding schema, stable finding IDs, dismissals, the reachability over-approximation. | `server/story/lint*` | Root |
| **B3 `vs story` CLI.** init, new, lint, query, refs, find, path, flags. | `cli/vs.mjs` (or `cli/story.mjs`) | Root |
| **B4 Server API + watch.** Routes under `/__vibesquad/story/*` (index, node, findings, path, dismiss); file watch on the Squad's main checkout via the existing git/file watch (`server/git-watch.mjs`); push updates to the UI. Owner and paired-device auth as for other Squad routes; bug-tester devices denied. | `server/vibesquad-api.mjs`, `server/story/` | Root |
| **B5 Workspace tabs + shell.** Tabs in Normal, the per-Squad enable toggle, outline, card, findings drawer, empty state + Init. | `src/BoringAde.tsx`, `src/storybook/` (new), Team Settings | Root |
| **B6 Graph.** Quest level + dialogue level, drill-down, badges, filters, deep links. Graph library + layout engine (new dependencies, see Open #4). | `src/storybook/graph*` | Root |
| **B7 Path simulator + flag ledger.** | `src/storybook/`, `server/story/path*` | Root |
| **B8 Send to lane + agent duties.** Inbox card creation from a node or finding; prompt-layer snippet; role-pack note. | `server/inbox.mjs`, `server/hooks/agent-duties.ts`, `docs/ROLE_PACKS.md` | Root |
| **B9 Phone view.** | `src/PhoneCockpit.tsx`, `src/storybook/` | Root |
| **B10 Godot runtime loader (optional, see Open #3).** `addons/vs_story/` with a `StoryDB` autoload that loads the compiled JSON, plus `vs story build` to compile `studio/narrative` → `res://.../story.json`. | `godot/addons/vs_story/`, `cli/` | Root |
| **B11 Docs.** Guide concept page (`guide/Concepts/Storybook.md`), README section, `docs/PRIVACY.md` (cache entry), `CREDITS.md` (new dependencies), Settings reference. | docs | Root |

**Order:** B0 → B1 → (B2 ∥ B4) → B3 → (B5 → B6 → B7) ∥ B8 → B9 → B10 (if taken) → B11. B5 can start against a stubbed API once B4's route shapes are fixed.

**Review:** B4 touches the auth route table, so it gets Tier A review. Everything else is normal cross-family review.

## Done-check (v1)
On the owner's PC, with the sample Godot project:
1. `vs story init --starter rpg` creates `studio/` with `.gdignore`. A Godot release export contains zero `studio/` files.
2. `vs story lint` on the fixture reports exactly the deliberately planted violations (no extras, none missed), and exits non-zero.
3. The Storybook tab shows the quest web. Drilling into a dialogue tree and clicking a node shows the correct card. Each finding badge deep-links to its node.
4. Editing a fixture file on disk updates the graph and findings within 3 s without a reload.
5. The path simulator walks from start to a quest outcome; locked choices name the missing flag. `vs story path --to <outcome>` agrees with it.
6. "Send to lane" on a finding creates an inbox card with a working deep link. An agent picks it up, fixes the file, the finding disappears, and `vs story lint` passes.
7. A worker in a Storybook Squad, asked to "add a side quest for Bob", uses `vs story new`, and the result lints clean.
8. Phone: outline, card and findings load on Android or the PWA. No graph is shown.
9. Server, CLI and UI test suites pass; the public-release hygiene tests pass with the new fixtures.

## Backlog (v1.x, after v1 lands; cross-cutting items live in the future-state spec)
- **LLM continuity:** a character bible (voice and knowledge per entity), checked against lines; canon/lore fact list → contradiction check. `confidence: llm`, dismissible, run on demand or on changed subgraphs only.
- **Importer:** `vs story import`, an agent-assisted one-time conversion of ad-hoc content into `studio/`, followed by human review.
- **Exact reachability solver** (replaces the over-approximation for small graphs).
- **Headless dialogue runner:** Godot headless walks every choice path in the real runtime and diffs it against the manifest. This is the long-term fix for drift.
- **Text budgets + localization readiness:** string extraction, line length vs. dialogue box, missing translations.
- **VO script export:** lines per speaker → CSV.
- **Content-rating tags** per node → pre-fill an IARC/ESRB questionnaire.
- **Playtest coverage:** which lines and branches testers never saw, via `vs_playtest` adapter state (`get_state()` includes the current node ID).
- **Stored node positions** for manually arranged graphs.
- **Narrative diff per branch** and **advisory lint in the verdict gate.** These depend on future-state Phase 1.

## Risks
| Risk | Mitigation |
|---|---|
| Drift between manifest and game code | Prefer the game *loading* the manifest as data (B10). Headless runner in the backlog. |
| Agents ignore the format | Agent-duties snippet, `vs story new` scaffolding, lint before done. Hard gate later. |
| The graph becomes a hairball past ~150 nodes | Two-level drill-down, filters, "broken only", per-act views |
| Lint noise makes people stop reading it | Deterministic rules only in v1; over-approximation errs toward silence; dismiss with a reason |
| Scope creep into a full narrative editor | Read-only is a hard rule for v1 |
| New dependencies (YAML parser, graph library, layout engine) | Pin versions; MIT or Apache only; CREDITS entry; bundle-size check |

## Open
1. **File format:** YAML (pleasant for multi-line dialogue, needs a parser dependency, Godot cannot read it natively) or JSON (Godot-native, painful to write by hand). **Recommendation:** YAML as the source format; `vs story build` compiles it to JSON for the game runtime (B10).
2. **Name:** keep "Storybook" despite the Storybook.js collision? Alternatives: Lorebook, Plotline, Quest Web, Loom.
3. **Runtime loader (B10) in v1?** It is the cheapest drift fix, but it adds a Godot addon and a build step. **Recommendation:** yes, as the last block, and cut it if v1 runs long.
4. **Graph stack:** React Flow (`@xyflow/react`) + `elkjs` (both MIT) is the default. Is the bundle size acceptable on Android?
5. **Enable rule:** opt in per Squad via Team Settings (default), or auto-enable when `studio/` exists?
