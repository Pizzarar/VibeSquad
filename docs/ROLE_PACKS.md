# Role packs

The VibeSquad server plugin (`plugin/index.ts`) adds a small, fixed prompt prefix to every new agent so workers never pay for lead-only rules and prompt caches keep hitting.

## Layer order (fixed, no timestamps or per-spawn values)

1. **Everyone layer**: how to find the lead (`vs who lead`, `role=lead` in the same team/lane, never `(old)` or `former-lead`), the multi-lane Squad model (multiple feature lanes per Squad `team`, each with 1 Buddy `role=brainstorm` and 1 Lead `role=lead`), the `needs-aub` label, `vs log --since-me` (shared across all lanes in the Squad), `docs/NAMING.md`, and the guardrail rules R1 (Search/Read), R3 (Images), R4 (Large files), R6 (Waiting with `paseo wait <id> --timeout <s>`), and R2/R7 (Git state).
2. **Project `AGENTS.md`**: loaded natively by the provider, not by the plugin.
3. **Role pack**, chosen by role:

   | Role | Source |
   |---|---|
   | `lead` | `<projectRoot>/docs/LEAD_RULES.md`; falls back to a built-in compact pack if the file is missing (includes prior-art check rule, `"Spin up a buddy (for X)"` trigger + overlap check via `vs who brainstorm`, and 150k/250k/300k handoff ladder: at ~150k stop dispatching and write a handoff at the next good stopping point; VS auto-hands off at 250k, hard cap 300k) |
   | `worker` | built-in: never `vs log` write; report PASS/FAIL and refs in the final message (the digest logs it); never call built-in `SendMessage`/`ListAgents` (A11) |
   | `brainstorm` (Buddy) | built-in: mascot name **Buddy**; may `vs log decision` / `vs log needs-aub`; checks for existing primitives (`paseo --help`, Paseo MCP tool list, `vs --help`, skills) before handing off a plan that adds a command, rule or feature; hands build work to a lead; handles `"Spin up a buddy (for X)"` / `"spin up another buddy"` / `"get me a buddy for X"` with overlap check (`vs who brainstorm` and `vs log --since-me`) before spawning a new Buddy in a new feature lane (`lane=<slug from X>`) under the same Squad (`team=<product>`) |

4. **The caller's brief** (the agent's own prompt).

Lead rules never reach workers or brainstorms; brainstorm rules never reach other roles.

## How the role is picked

The `before("agent.create")` request carries no labels, so the plugin uses env `VS_ROLE` if set, else the title convention: `★ LEAD …` → lead, `BRAINSTORM …` → brainstorm, `(old) …` → none, anything else → worker. `agent.created` then fills in missing `team`/`lane`/`role` labels (from the parent, else `teams.json` path rules).

## Antigravity (Gemini)

`antigravity-cli*` providers ignore `systemPrompt`, so after creation the plugin steers the same prefix in as a first message. Spawns also get `approvalPolicy: skip` (including an inherited `agy`, which stalls silently, A1) and `modeId: accept-edits`.

### Worker report routing (A11)

A worker's final message is its report. The worker pack says: "Your final message is the report; never call built-in SendMessage or ListAgents; mid-task use Paseo send_agent_prompt." Workers never address a lead directly; the digest routes by `team`/`lane` labels to the current lead. `src/antigravity.ts` exports `WORKER_REPORT_ROUTING_GUARD` and `detectMisroutedReport` (surfaced as `a11MisroutedReport` on `AntigravityAudit`) to flag turns that used Claude Code's built-in `SendMessage` or `ListAgents` instead.

## Measuring

Each start logs a `metric` entry: `prompt-injection role=<role> provider=<prov> chars=<N>`. A lead's first worker spawn logs `first-dispatch context: <N>k tokens (lead=<id>, ord=<n>)`. Baseline to beat: 80k.

## Editing a pack

Lead pack: edit the project's `docs/LEAD_RULES.md`. Worker and brainstorm packs live in `plugin/index.ts` (`WORKER_PACK`, `BRAINSTORM_PACK`). Keep them short; every character is paid on every start.
