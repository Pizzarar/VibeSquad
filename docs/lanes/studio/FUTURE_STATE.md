# FUTURE STATE · VibeSquad Studio (`studio`)

> North-star spec: what to work toward after [Storybook v1](../storybook/PLAN_V1.md). This is **not** a build plan. Each phase below gets its own `PLAN_*.md` when it starts.

## Vision
VibeSquad goes from "agents write code" to **a studio where agents and the owner take a project from concept to a finished, shippable thing**. For games, that means: generation is fast, but after it come hundreds of placeholders, scattered entities and AI drafts that must be verified and gradually replaced with final work. The studio makes that visible and actionable.

VibeSquad stays general-purpose (apps, games, fabrication, anything). The studio is a **core plus domain packs**. Games are the first packs; app and enterprise packs reuse the same core.

## Thesis (why this beats existing tools)
articy:draft, ShotGrid/Flow, HacknPlan and Codecks already track content and production. VibeSquad's only real edge:

> **Every finding can be dispatched to an agent.** Finding → lane → worker → fix → re-audit → closed.

If a feature does not feed that loop, it is a worse copy of an existing tool. Every domain must support the loop.

## Principles
1. **The repo is the source of truth.** Studio data lives in the committed `studio/` folder. Indexes are disposable caches under `~/.vibesquad/cache/`.
2. **Deterministic first, LLM second.** Every finding states its confidence. Never present an LLM opinion like a broken link.
3. **Domain-native UI, one shared contract.** Each discipline gets the UI that fits its medium. All of them emit the same finding schema.
4. **Engine-agnostic core, engine adapters.** Godot 4 first, following the `vs_playtest` adapter pattern.
5. **Agents never approve their own work.** Sign-off and enforcement changes require a human action that an agent process cannot perform.
6. **Infer state rather than ask for it.** Status that someone sets by hand goes stale. Derive it from files, metadata and hashes wherever possible.
7. **Build a domain only when it is a real bottleneck.** No speculative domains.

## Naming decisions (locked)
| Term | Meaning | Note |
|---|---|---|
| **Studio Hub** | The project front door: findings queue + health + RiffBot chat | Takes over the word "Hub". |
| **RiffBot** | Just a bot/chat, the Squad-level Buddy, shown as the chat pane in the Studio Hub | The current `HubBar` strip is retired. The persisted `hub: true` lane key and hub lane IDs in `teams.json` are **kept** (no migration needed). Only UI and code names change. |
| **Workspace** (or **Domain**) | A discipline view: Code, Storybook, Art, Audio … | **Never "lane".** Lane already means a parallel agent workstream. |
| **Domain pack** | A workspace + its schemas, lint rules and adapters | Opt-in per Squad |
| **Finding** | One audit result, using the shared schema | |

## Architecture
```
                         ┌──────────────── Studio Hub ────────────────┐
                         │ findings queue · health · RiffBot chat     │
                         │ (merged with the existing Needs You queue) │
                         └───────────────▲────────────────────────────┘
                                         │ findings (shared schema)
   ┌──────────┬───────────┬──────────────┼──────────┬───────────┬──────────┐
   │  Code    │ Storybook │  Art         │  Audio   │  Systems  │ World/UI │   ← domain packs
   └────┬─────┴─────┬─────┴──────┬───────┴────┬─────┴─────┬─────┴────┬─────┘
        └───────────┴────────────┴─────┬──────┴───────────┴──────────┘
                                       │
          ┌────────────────────────────▼─────────────────────────────┐
          │ Core: Entity Registry · Production ledger (provenance ×  │
          │ status × sign-off) · Audit contract · Dispatch · Gates · │
          │ Roles                                                    │
          └────────────────────────────▲─────────────────────────────┘
                                       │ reads
          ┌────────────────────────────┴─────────────────────────────┐
          │ Game repo: studio/ (committed) + engine files (Godot)    │
          │ ~/.vibesquad/cache/<squad>/ (derived, disposable)        │
          └──────────────────────────────────────────────────────────┘
```

## 1. Shared Entity Registry ("everything about Bob")
Every core object (character, item, enemy, location, faction, and for apps: screen, endpoint, feature, requirement) has one studio-wide ID.

- **Starts in Storybook v1** (speakers, factions, locations, items). It is generalized here, not built from scratch.
- **Entity page:** click `npc.bob` and see everything attached across all domains: portraits, sprites, dialogue lines, quests, stats, spawn points, audio cues, findings, and the production status of each slot.
- **Entity-type schemas:** per project, copied from starter templates (never linked). Each type declares **slots**, e.g.
  ```yaml
  type: npc
  slots:
    portrait:  { domain: art,   required: true }
    sprite:    { domain: art,   required: true }
    voice:     { domain: audio, required: false }
    dialogue:  { domain: narrative, required: true }
    stats:     { domain: systems,   required: false }
  ```
  Coverage = required slots with no content.
- **IDs:** `<type>.<slug>`, immutable; renaming changes the name only; deletion leaves a tombstone. Entity ID ≠ file ID: an entity spans many files, and Godot `uid://` values are stored as slot references, not as the entity's identity.
- **Variants:** `parent:` relation (`npc.bob_young` → `npc.bob`; `enemy.slime_t2` → `enemy.slime`). Slots inherit unless overridden.
- **Keeping it honest:** agents register entities when they create them (`vs studio new`). Lint flags engine resources that look like entities but are not referenced by any registry entry.

## 2. Production ledger: provenance × status × sign-off
Two separate fields, not one pipeline. Mixing "who made it" with "how done it is" breaks on real cases (a human placeholder, a final AI-assisted asset, a licensed pack asset).

| Provenance | Status |
|---|---|
| human · AI-generated · AI-assisted · licensed pack · procedural | missing · placeholder · draft · in review · final |

- **Inference first:** status and provenance come from folder conventions, naming, sidecar metadata, import metadata, generator tags written by agents, and pack manifests. Manual setting is the fallback.
- **Hash-pinned sign-off:** "final" means *signed off at content hash X*. Editing the file automatically drops it back to "in review". Sign-offs live in `studio/signoffs/<entity>/<slot>.yaml`, so they travel with branches.
- **License ledger:** each licensed asset records its pack, license and source. The ledger auto-generates game credits and flags assets whose license is unknown.
- **AI disclosure:** the provenance ledger drafts the store AI-content disclosure (e.g. Steam's AI disclosure section) and the credits text.
- **Production view:** filter the whole game by status/provenance, e.g. "every placeholder portrait in Act 1". This is the placeholder-to-final workflow.

## 3. Audit contract (four signals)
Every domain emits findings using the schema introduced in Storybook v1. The contract is **frozen at v1 only after a second domain implements it.**

| Signal | Meaning | Typical confidence |
|---|---|---|
| **Coverage** | Registry entities missing required slot content in this domain | deterministic |
| **Integrity** | Broken IDs, dead ends, unreachable states, orphans | deterministic |
| **Cohesion** | Drift from project rules (art style, tone/canon, mix levels, balance curve) | heuristic / llm |
| **Sign-off** | Placeholder or unsigned content; sign-off invalidated by a change | deterministic |

Finding fields (from v0): `id` (stable), `domain`, `signal`, `rule`, `severity`, `confidence`, `subject`, `location`, `message`, `deepLink`, `firstSeen`, `dismissed`. Added in v1 of the contract:
- `owner`: the lane or person responsible
- `baseline`: whether the finding existed when enforcement was turned on (see Gates)
- `dispatch`: `{ laneId, cardId, state }` once sent to a lane
- `snoozedUntil`

**Required behavior:** stable IDs, deduplication across runs, dismiss with a reason (versioned in `studio/findings/`), snooze, group by entity, and **dispatch → re-audit → auto-close**.

## 4. Studio Hub
- **One queue, not seven dashboards.** Domains do not get their own KPI dashboards. Every finding feeds one triage queue, **merged into the existing Needs You / attention queue** (`src/attentionItems.ts`, `src/BoringInbox.tsx`). No third queue.
- **Health summary:** per domain, counts by signal and severity, plus the production ledger ("41 placeholder portraits, 3 quests with dead ends, 2 weapons off the damage curve"). Every number deep-links to a filtered view.
- **RiffBot chat pane:** RiffBot is the Hub's chat, with **studio tools** (query the registry, read findings, `vs story`/`vs studio` queries, dispatch findings). Overlord is one click away. Both stay on the existing hub lane.
- **Navigation:** top tabs remain until there are **three or more workspaces**; then the Hub becomes the front door, with persistent navigation (Hub + every workspace one click away).
- **Configurable default startup:** Hub or last-used workspace. Build it together with the Hub, not before.
- **Phone:** Hub = findings list + RiffBot chat. No health grid.
- **Psycho mode:** not supported; stays legacy.

## 5. Gates and enforcement
| Gate | Default | When enforced |
|---|---|---|
| **Merge** (verdict gate, `server/verdict.mjs`) | advisory | Blocks merges that introduce **new** integrity errors |
| **Release export** (Godot `EditorExportPlugin`, same pattern as `vs_playtest`) | advisory | Refuses release presets with placeholders or unsigned required slots |
| **Store build** | off | Requires a complete provenance and license ledger |

- **One toggle per gate** (lean). Per-domain overrides are added only if someone asks.
- **Baseline-only blocking:** turning a gate on records the current findings as baseline; only regressions block. Otherwise turning on enforcement for an existing project blocks everything.
- **Owner override:** requires a reason and is written to the team log.
- **Config lives in the repo** (`studio/studio.yaml`), so it is identical on every machine and branch.
- **Toggles and overrides are owner-UI-only**, never CLI or local token, so an agent cannot switch enforcement off to get past a gate.

## 6. Roles, identity and access
Builds on the existing E6a device roles (`server/auth.mjs`: `owner`, `bug-tester` scoped to `allowedTeams`, deny by default).

### Roles
| Role | Code/agents | Findings | Sign-off | Settings/gates | Exists |
|---|---|---|---|---|---|
| Owner | ✅ | ✅ | ✅ all domains + override | ✅ | ✅ |
| Collaborator | ✅ (scoped Squads) | ✅ | ❌ | ❌ | — |
| Domain reviewer (e.g. art lead) | ❌ | ✅ own domain | ✅ own domain | ❌ | — |
| Bug-tester | ❌ | file bugs | ❌ | ❌ | ✅ |
| Viewer | ❌ | read | ❌ | ❌ | — |

### Requirements
1. **People, not just devices.** Roles are per device today. Sign-off attribution needs a person, so add lightweight identities with devices grouped under them. Existing device records migrate as "owner identity".
2. **Two collaboration models; the spec must support both explicitly:**
   - **Shared server:** collaborators pair devices to the owner's VibeSquad. The server enforces roles. ✅
   - **Shared repo:** collaborators run their own VibeSquad on a clone. A server cannot enforce anything here, because anyone with push access can edit `studio/signoffs/`. Sign-offs must therefore be **signed** (SSH/GPG signatures verified against an allowlist in `studio/signers.yaml`), backed by CODEOWNERS and branch protection on the git host.
3. **Agents are locked out of sign-off.** Agents run as the owner and can call `vs`. Sign-off is never a CLI command or local-token route; it requires a human UI action from a paired device, ideally producing a signature agent processes cannot create. A test asserts that agent-originated calls to sign-off and gate endpoints are refused.
4. **Revocation:** sign-offs by a revoked identity stay valid but are marked "signer revoked". They are never invalidated silently.
5. **Audit trail:** every sign-off, override, role change and gate toggle is written to the team log. This doubles as change-management evidence for the enterprise packs.

## 7. Game domain packs
Each is built **only when it becomes a real bottleneck**. Every pack must emit all four signals and support dispatch.

| Domain | UI | Key checks | Feasibility (Godot) | Gotchas |
|---|---|---|---|---|
| **Narrative** (Storybook) | Quest web, dialogue trees, simulator | See Storybook v1 + backlog | ✅ v1 | Drift between manifest and code: fixed by the runtime loader and headless runner |
| **Art & Visuals** (first after Storybook) | Gallery by entity, side-by-side style comparator, placeholder → final swap flow | Missing art per slot, orphan assets, resolution/format rules, unsigned finals, unknown license | High | Style cohesion is subjective: show it side by side and mark it `llm`; never auto-fail on it |
| **Audio** (cheap option for the second domain) | Event-linked cue sheet | Silent gameplay events, loudness (ffmpeg `ebur128`), loop seams, unused cues | High, low cost | Needs an event→cue mapping in the registry |
| **Systems & Balance** | Linked stat tables, progression curves | Stat outliers, broken loot/recipe links, difficulty spikes | Medium | "Simulation" means running game logic: headless Godot or a per-game adapter. A generic simulator is a trap; start with tables + outlier detection |
| **World & Levels** | Zone map, room-connection graph | Unreachable areas, missing spawns, broken quest↔location triggers | High (`.tscn` is text) | True reachability needs collision/navigation data, i.e. headless runs |
| **UI & Player Flow** | Screen-flow map | Menu soft-locks, missing input bindings (`project.godot` InputMap), text overflow | Mixed | Overflow needs rendering: headless screenshots |

**Choosing the second domain:** Art if placeholder pain is the bottleneck (the pitch default); Audio if the goal is a cheap, fast validation of the contract before freezing it.

## 8. App and enterprise packs (same core)
| Game concept | App / enterprise equivalent | Value |
|---|---|---|
| Entity registry | **Requirements traceability**: requirement → code → test → docs | Regulated industries need it |
| Storybook graph | **User-flow map**: route/screen graph, dead-end screens, unreachable routes, auth-gated paths | Reuses the Storybook graph engine |
| Provenance ledger | **AI-code provenance + OSS license ledger / SBOM** | Compliance teams increasingly ask for it |
| Hash-pinned sign-off + audit trail | **Change-management evidence** (SOC 2 style): who approved what, at which commit | Nearly free on top of the verdict gate + team log |
| Flag ledger | **Feature-flag registry**: stale flags, flags with no owner | Classic tech debt |
| Text budgets / localization | **Copy deck + i18n coverage** | Shared code with the narrative backlog |
| Character bible / tone | **Brand voice / content governance** on UI copy | LLM check, dismissible |
| Content rating | **Accessibility audit** (contrast, labels, focus order) | Legally required in some markets |
| `vs log` decisions | **ADR export** | Cheap |
| — | **Permission/role matrix**: who can reach which endpoint or screen | Wanted in security reviews |

## 9. Rollout
| Phase | Scope | Exit criteria |
|---|---|---|
| **P0 Storybook v1** | See `PLAN_V1.md`: minimal registry, finding schema v0, `studio/` folder | Storybook done-check passes; used on a real game for 2+ weeks |
| **P1 Core** | Registry generalized (entity-type slots, variants, `vs studio`); findings merged into Needs You; dispatch → re-audit → auto-close; narrative diff per branch; advisory lint in the merge gate | A finding goes from detection to auto-close with no manual steps except approval |
| **P2 Second domain** | Art (or Audio) pack | Both domains emit all four signals; **audit contract frozen at v1** |
| **P3 Production ledger + gates** | Provenance × status, hash-pinned sign-off (owner only, human-only action), license ledger, credits + AI disclosure drafts, three gate toggles, baseline, override | A release export is blocked by an unsigned required slot and unblocked by a UI sign-off; an agent cannot sign off (tested) |
| **P4 Studio Hub** | Hub page, RiffBot chat pane with studio tools, health summary, default startup, phone Hub; tabs retired | ≥ 3 workspaces live |
| **P5 Roles & identity** | Identities, the role matrix, signed sign-offs for shared-repo collaboration, revocation, audit trail | An alpha tester as domain reviewer signs off art in their domain only; their sign-off is verified on the owner's machine |
| **P6 On demand** | Systems, World, UI flow, Audio/Art (whichever is left); first app pack (user-flow map reusing the Storybook graph) | Each pack has its own plan |

## 10. Risks
| Risk | Mitigation |
|---|---|
| Scope: this is several products (articy + ShotGrid + a CI gate) | Phases with exit criteria; a domain is built only when it is a bottleneck |
| The registry drifts from the actual game | Agent duties, `vs studio new`, lint for unregistered resources, runtime loaders |
| Alert fatigue just moves into the one queue | Severity, confidence, baseline, dedupe, snooze, ownership, auto-close |
| Enforcement gets turned off the first time it blocks a hotfix | Baseline-only blocking + logged owner override |
| Agents bypass sign-off or gates | Human-only actions, signatures, tests that prove agent calls are refused |
| Shared-repo collaborators forge sign-offs | Signed sign-offs + signer allowlist + branch protection |
| Godot lock-in | Adapter boundary; core never imports engine specifics |
| `studio/` schema churn breaks alpha testers' projects | `schemaVersion` everywhere + `vs studio migrate` |

## 11. Open questions
1. Identity model for P5: local accounts on the owner's server, or identity = an SSH signing key?
2. Which collaboration model do alpha testers use first: shared server or shared repo?
3. Second domain: Art (production value) or Audio (cheap contract validation)?
4. Should signed sign-offs be required even for the owner-only setup (stronger protection against agents), or only once there are collaborators?
5. Is the first app pack (user-flow map) worth pulling ahead of the remaining game domains?
