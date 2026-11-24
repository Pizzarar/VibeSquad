# Storybook workspace + Studio future state (owner pitch, 2026-11-24)

Owner-written pitch, pasted verbatim to the hub Overlord on 2026-11-24 (found on the dev PC; not yet carded or planned).
Status: routed to RiffBot (hub Buddy) to riff and propose lanes. Prior art to check:
EFI NARR-SHEET (#1018 d3cc385a, game-side quest-text storyboard, EFI docs/PLAN_NARRATIVE.md §2) and VS idea-729 context-ref popovers (hover/tap cards).

---

# Product Pitch: Adding Storybook as Our Second Workspace & Scaling Into a Full Studio

## The Big Picture
Right now, we have a single vibecoding workspace. To grow into a full-scope studio where creators can vibe-code an entire game from concept to playable world, we need to solve what happens *after* fast generation: once a project scales past a prototype, creators drown in disconnected systems, half-remembered mechanics, and sprawling story branches.

The proposal is to build **Storybook** as our new second workspace—and use that expansion to lay out a clean navigation path toward a multi-tool studio.

---

## 1. Proposed New Workspace: Storybook (Narrative & Quest Tracking)
When a creator generates dozens of quests, NPCs, and dialogue branches, the bottleneck shifts from *creating* content to *understanding* whether it makes sense and is actually fun to play. Storybook will be a dedicated second workspace built to solve narrative sprawl.

* **Parse & Track Everything:** Automatically ingest and map every piece of story content in the project—who says it, what area or faction it applies to, and where it sits in a quest chain.
* **Visual Quest Web:** Turn scattered narrative files into an interactive web/flowchart of connected quests and dialogue. Hovering or clicking any node pops up a readable card with full context on the spot, instead of forcing creators to dig through raw text or spreadsheets.
* **Work Through the Fun (With AI Assist):** Give creators—and an AI agent plugged into the same context—a dedicated space to walk through branches, evaluate pacing, and catch dead ends, broken prerequisites, or continuity gaps before players ever hit them.

---

## 2. Navigation & Studio Architecture (Next Step vs. Future State)

### Next Step (Launching a 2-Workspace Studio)
Once Storybook is built alongside our existing vibecoding workspace, a full hub would still feel like an empty launcher.
* **Lightweight switching:** Add simple top-level tabs to switch directly between the core workspace and Storybook with zero friction.
* **Shared project brain:** Design Storybook from day one to read from the same live project state as the core workspace so they operate as one unified studio, not two separate apps bolted together.

### Future State (Full Studio Hub)
As we add additional creative workspaces down the road (art, world-building, balancing, audio, etc.), top tabs won't scale.
* **Central Hub / Landing Page:** Introduce a project Hub as the front door—giving creators a high-level overview of their game and a clean launchpad into every tool.
* **Configurable Default Startup:** Let users choose their default landing view (either the Hub or straight into their active workspace) so repeat workflows stay fast, with normal top-level navigation always keeping the Hub and other tools one click away.

# Future-State Pitch: Scaling Beyond Storybook Into a Unified Game Studio

## The Big Picture
Once **Code** and **Storybook** are live as a two-tab studio, our next challenge is scaling into a full game-creation platform without turning into a cluttered menu of disconnected tools.

Generating a game fast creates a specific problem: you end up with hundreds of placeholder assets, scattered entities, and AI-generated drafts that have to be verified and gradually replaced with final, human-made work. The future state solves this by connecting every creative domain to a **Shared Entity Registry** and rolling every lane's health up into **one Studio Hub**.

---

## 1. The Backbone: Shared Entity Registry ("Everything About Bob")
Instead of letting quests live only in Storybook, sprites live only in folders, and stats live only in code, every core object in the game (characters, items, enemies, locations, factions) gets a single, studio-wide ID.

* **Entity-Centric Grouping:** Click any entity—say, an NPC like *Bob*—and immediately see everything attached to him across the whole game: his portraits, sprites, dialogue lines, quest chains, stats, and where he spawns in the world.
* **Built for Placeholder-to-Final Production:** Every slot tied to an entity tracks its production state (`Missing` → `Placeholder` → `AI Draft` → `Needs Review` → `Final Human Asset`). You can click through your game by ID and see exactly what still needs human polish before launch.

---

## 2. Studio Hub & Single Project Health Dashboard
As we grow past two workspaces, top-level tabs won't scale—and giving every tool its own KPI dashboard creates dashboard fatigue.

* **Central Hub & Configurable Startup:** The Hub becomes the front door to the project, showing overall studio health and launching any workspace. Users can set any workspace as their default startup view for fast repeat work, while persistent navigation keeps the Hub and all tools one click away.
* **One Health Dashboard, Not Seven:** Individual tools don't get dashboards. Instead, every workspace feeds standardized alerts into one triage queue on the Hub (e.g., *12 placeholder portraits remaining, 3 quests have dead ends, 2 weapons break the damage curve*). Clicking any alert deep-links straight to the exact entity or item to fix.

---

## 3. Domain-Native Lanes With One Shared Audit Contract
Each creative discipline gets the UI that actually fits its medium—not forced into one generic table or flowchart—paired with a lightweight audit filter bar (`Missing`, `Placeholder`, `Broken`, `Inconsistent`, `Unreviewed`).

Every lane emits the same four audit signals up to the Hub:
1. **Coverage:** Registry entities missing content in this lane.
2. **Integrity:** Broken IDs, dead ends, unreachable states, or unused orphans.
3. **Cohesion:** Drift from project rules (art style, tone/canon, audio mix, balance curve).
4. **Sign-Off & Asset Status:** What is still placeholder or AI-generated vs. human-verified and final.

### Planned Future Lanes
* **Art & Visuals (First post-Storybook lane):** Asset gallery + side-by-side style comparator. Lets creators audit by entity ID to verify every character/item has art, visually compare style consistency, flag orphans, and systematically swap placeholders for final human art.
* **Systems & Balance:** Linked stat tables, progression curves, and quick simulations to surface stat outliers, broken recipes/loot links, and difficulty spikes.
* **World & Levels:** Zone maps and room-connection graphs to catch unreachable areas, missing spawns, and broken quest-to-location triggers.
* **Audio (SFX & Music):** Event-linked cue sheet and loudness checks to spot silent gameplay triggers, volume spikes, and broken loops.
* **UI & Player Flow:** Screen-flow map (Title → HUD → Pause → Inventory) to catch menu soft-locks, text overflow, and missing input bindings.

---

## 4. Rollout Approach
We don't build all of these at once:
1. **Lock the foundation early:** Build the **Shared Entity Registry** and the **4-Part Audit Contract** right after Storybook so every future workspace plugs into the same backbone.
2. **Ship Art & Visuals + Hub next:** Delivering placeholder-to-human-art tracking alongside the transition from top tabs to the Studio Hub gives immediate production value.
3. **Add remaining lanes on demand:** Expand into Balance, World, Audio, and UI only as each becomes a real bottleneck for creators shipping complete games.

---

## Owner addendum (2026-11-24)
Track more than dialogue as Storybook input, the same way dialogue is tracked today: quests, character names, locations. Link them all together so content can be checked for staying true to its area, making sense, and being on-theme. (This pulls the Shared Entity Registry + Cohesion signal forward into Storybook v1 rather than after it.)
