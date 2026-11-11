# VibeSquad: brief for writing a job-application artifact

**Who this is for:** a Claude chat with no access to the repo. Everything you need is in this file, and every claim here was checked against the repo on 2026-11-11. Use it to write a portfolio one-pager or a resume section for an **AI automation** job. Do not add facts that are not here. If you need a number that is not here, ask the user (the owner).

**Who the owner is:** the sole human developer of VibeSquad, and the user talking to you. This file uses no name or pronouns for them; take both from the user. See section 8 for how to describe the role honestly. Read it before you write anything.

---

## 1. The pitch (one paragraph)

VibeSquad is a local-first "agentic development environment": a desktop, web and phone app that runs whole teams of AI coding agents (Claude, Gemini and DeepSeek models) on real software projects. Instead of one chat window with one assistant, you get a roster of agents with defined jobs: a brainstorm partner who plans, a lead who dispatches work, and short-lived workers who each do one task. They coordinate through a shared log, an idea inbox, review gates and automatic handoffs, while the human owner makes the product and design decisions. The north star is "iOS for vibe coding": make directing a team of AI agents feel as approachable as using a phone. The owner designed and directed VibeSquad, running AI agents as the workforce that built it. It runs on the owner's own PC with no outbound telemetry.

## 2. How it works

### 2.1 The team structure

```
Squad (one per product, e.g. "VibeSquad", "a game", "a personal site")
  |-- Hub lane: Overlord (lead) + RiffBot (brainstorm), coordinate across lanes
  `-- Feature lane (called a "Team" in the UI), many in parallel
        |-- Buddy / Brainstorm: the human talks to this one; plans, explores, parks ideas
        |-- Lead: dispatches work, manages context, hands off when it runs low
        `-- Workers: one task each, in their own git worktree, report back in a final message
```

- **Squad > feature lane > Buddy + Lead + Workers.** Each lane has at most one live Buddy and one live Lead, so there is never ambiguity about who owns a feature. A squad runs many lanes in parallel.
- **Identity comes from labels, never from names.** Every agent carries `lane`, `role` and a counter. Display titles are generated from those labels. The server never guesses roles from title text. (This came from a real bug class recorded in the project's lessons file: title-prefix matching caused cross-lane collisions.)
- **Overlord** is the hub-lane lead that handles cross-lane process and standing rules.
- Lanes are short-coded (e.g. `@bug`, `@ade`, `@per`) so agents and the owner can address a lane with one token.

### 2.2 Coordination primitives

- **`vs` CLI** (one Node script, ~2,700 lines): team log (`vs log`, with `decision`, `needs-you` and `handoff` entry types), `vs who` (find the live lead/buddy for a lane), `vs inbox` (idea inbox per lane), `vs watch` (wait on several agents and end the turn, with stall timers), `vs worktree` (managed git worktrees), `vs handoff`, `vs profiles`, `vs lesson`.
- **MCP tools** expose the same operations to agents (`spawn_worker`, `send`, `wait`, `watch`, `report`, `handoff_lead`, `create_agent`, etc.) so agents orchestrate other agents.
- **Team log:** an append-only log shared across all lanes in a Squad, so a decision made in one lane is visible in the others.
- **Privacy design:** no prompt or transcript content is written to the log or to disk by VibeSquad itself.
- **Worker rules** are layered into every agent's prompt by a hook module (e.g. cap shell output, never re-read big files, no sleep/poll loops, wait with timeouts, git-state staleness rules, worktrees only via the managed command). These came from recorded lessons (see 4.8).

### 2.3 Profiles and routing by stakes

- A **profile store** of 19 default profiles (Lead, Brainstorm, Implement, Review, Check/Pre-check, Art roles, etc.), each with a provider, model, effort and a standing instruction note.
- **Stakes-based routing:** each spawn can carry a `stakes` label (`tierA-security`, `tierA-invariant`, `normal`, `mechanical`). A per-provider ladder maps stakes to model + effort. Example from the code: security work goes to the top model at high effort; mechanical work (renames, docs) goes to a small model at low effort. This keeps cost and quality matched to risk.
- **Provider failover:** when a provider's quota crosses a 95% threshold, a counterpart profile on another provider takes over (e.g. Lead - Claude <-> Lead - Gemini). A one-click provider switch also exists. A lesson in the repo records why: coupling many profiles to one provider froze lanes at that provider's cap.

### 2.4 Review gates

- **Cross-provider review:** work from one model family is reviewed by a different one (the profile pairing is Review - Sonnet <-> Review - Gemini; the rule is that a Sonnet reviewer cannot review Sonnet work).
- **Tier A reviews:** security and invariant-critical changes (auth, crypto, relay, state machines, locks, data migrations) get a stricter, higher-model review. A real example from the git log: a restart-safety change failed its first Tier A review (2 high, 3 medium findings), was fixed, passed round two, then needed a third fix after a cold-start replay bug was found.
- **Pre-merge verification:** merges in the git history cite the reviewer verdict and the full-suite test result (e.g. "Review PASS 30/30; suite 3231 pass / 1 pre-existing fail queued as a bug").
- **Worker reports are structured:** PASS/FAIL, what changed, commit hash, evidence. No prose claims.

### 2.5 Context limits and handoffs

- A server-side watcher tracks each agent's context usage from the runner's usage events. A lead gets a nudge at 150k tokens and an automatic successor handoff at 250k to 300k tokens. Buddies get a warning and a hard-limit retire.
- Handoffs carry state by label and file, not by scraping chat history (a recorded lesson: chat-history scraping wiped state across restarts).

### 2.6 The agent runner (replaced the Paseo daemon)

- VibeSquad was first built on top of **Paseo**, an open-source agent manager. It now has its **own agent runner** (`runner/`, ~2,600 lines) that is now the only backend; the Paseo daemon has been fully removed. The runner has adapters for Claude, ACP-based agents (Agent Client Protocol), and MCP, and a pricing table covering Claude and DeepSeek models for usage metering.
- **Restart-safe resume:** the server and runner can restart without cutting or wedging running agents. Prompt-less resumes are settled, verified and retried or failed explicitly; `vs restart` is held while background work is running; events missed during a server restart gap are replayed. This went through a Tier A review (see 2.4).
- **Live-Needs runtime sync:** a build step syncs the built runtime into the live install, and commits declare whether they need a live sync or restart (`Live-Needs: <what>` or `none`), so changes do not silently fail to reach the running app.
- Also built: native schedules and heartbeats, a session janitor that archives closed worker sessions, keep-host-awake while agents run, sealed secret input (secrets pass through a 0600 temp file and are never logged in chat), and PTY terminals per agent.

## 3. Surfaces (where it runs)

- **Standalone web app:** React 19 + TypeScript + Vite front end, Node.js server. Roster view of Squads and Teams, chat, idea inbox, profile management, diff review, file/PDF/image/Mermaid preview, listening-ports pills.
- **Windows desktop app:** a Tauri 2 (Rust) shell with an NSIS installer that bundles a pinned Node runtime, the server and the `vs` CLI. A GitHub-based updater exists.
- **Android app and phone PWA:** a Tauri Android build plus a progressive web app. Phones connect over LAN or a VPN mesh ("Meshnet") with a **QR pairing flow**: per-device tokens (the server stores only a SHA-256 hash, constant-time compare, HttpOnly + Secure + SameSite=Strict cookie), a locally generated root CA with X.509 name constraints, and the app pins the host's CA fingerprint. The Android Meshnet plan was completed and passed an on-device checklist on 2026-11-10.
- **E2EE relay (designed, with host-side code written, not yet wired in):** an outbound relay design where the home PC dials out to a "dumb" relay and clients connect through it. All content rides inside a Noise_NK-style channel (X25519 key agreement, HKDF-SHA256, AES-256-GCM with strict counters so replay, reorder and drop all fail closed). There is a written threat model and two review rounds for it. Say "designed and implemented host-side", not "shipped".
- **Security posture:** loopback-only by default, a per-install local token (32 random bytes, 0600), UNC-path refusal, no outbound telemetry. Known scope limits are documented openly in `SECURITY.md`.
- **Light and dark themes.**
- **Two UI modes:**
  - **"Psycho"**: the playful mode. A pixel-art "Vibespace" where the agents appear as sprite characters in an office scene, with hand-pixelled art made through an Aseprite pipeline and a CRT-style header.
  - **"Normal"**: a plain corporate "ADE" (agentic development environment) layout: sidebar of Projects > Conversations, card-grid dashboards, compact header.
  - **Naming note:** in the code today these are called "Fun" and "Boring Mode". The rename to **Psycho** and **Normal** is landing now. Use Psycho / Normal in the artifact.

## 4. Automation and ops highlights (the part that maps to an AI-automation role)

Each item below exists in the repo. Frame them as systems the owner designed and directed.

1. **Autonomous multi-agent pipelines.** Brainstorm -> plan -> lead -> parallel workers in isolated git worktrees -> review -> merge. The git history shows hundreds of such units merged with reviewer verdicts in the commit messages.
2. **Provider quota failover** (Claude -> Gemini -> DeepSeek-capable runner). Automatic counterpart-profile switch at 95% quota; a lead successor is placed on the better-capacity provider.
3. **Stakes-based model routing** (see 2.3). A concrete cost/quality control, and an A/B experiment is specified to test Sonnet vs Gemini implementers on first-try review pass rate and cost per merged unit.
4. **Automated review and verification gates** (see 2.4), including a cross-provider rule and Tier A security/invariant review.
5. **Self-healing ops.** Restart-safe resume, stall watches (`vs watch --stall <min>`), duplicate-lead detection with a one-tap retire, automatic ghost-agent cleanup, stale-runtime detection, daemon health checks, and automatic lead handoff at context limits.
6. **Usage and token metering.** A "usage" lane measures token use and cost per spawn and per merged unit, with a pricing table, a context watcher, and a periodic usage-review job (interval configured at one day).
7. **A "Perfection" / Workflows lane that measures and judges the workflow itself.** Rule: the usage lane *measures*, the workflow lane *judges*, the bug lane *fixes*. Workflow doubts become hypotheses and experiments with a written verdict (keep / change / ruled-out) logged with evidence; verdicts ship as config or code (profiles, routing, caps), not as extra prompt rules. A daily audit is seeded but paused by default.
8. **Bug inventory and triage automation.** A bug-chaser lane and a written inventory (2026-11-09) cluster open bugs by root-cause theme, with hotspot files and owning lanes. A standing inbox per lane catches bugs and ideas from any agent without breaking flow ("fix small in-unit root causes now, queue the rest").
9. **A lessons system** (`vs lesson`): recurring failure modes are recorded (e.g. 38 entries at the time of the inventory) and the useful ones are folded back into the default worker rules. Example: agents running a slow CLI every turn caused deadlocks, so the rule became "use native tools, cap shell output".

## 5. Numbers (all real; the command behind each is given)

Repo snapshot: branch cut from `master` on 2026-11-11.

| Fact | Value | How it was obtained |
|---|---|---|
| Commits | **1,898** | `git rev-list --count HEAD` |
| Date range | **2026-11-01 to 2026-11-10** (10 calendar days, 52 to 458 commits per day, peak 2026-11-07) | `git log --format=%ad --date=short \| sort \| uniq -c` |
| Tracked files | 1,821 | `git ls-files \| wc -l` |
| Front end (`src/`) | ~53,200 lines in 178 files | `git ls-files src \| xargs cat \| wc -l` |
| Server (`server/`) | ~31,600 lines in 104 files | same pattern, `server` |
| `vs` CLI (`cli/`) | ~2,700 lines in 1 file | same pattern, `cli` |
| Agent runner (`runner/`) | ~2,600 lines in 14 files | same pattern, `runner` |
| **Core code total (src + server + cli + runner)** | **~90,000 lines** | sum of the four rows above |
| Tauri shell (`src-tauri/`) | ~16,000 lines in 66 files (Rust, Android project, installer files) | same pattern, `src-tauri` |
| Test code (`test/`) | ~61,700 lines in 330 files | same pattern, `test` |
| Test files | **316** in `test/` (318 repo-wide including a few co-located) | `git ls-files test \| grep -c 'test\.'` and `git ls-files \| grep -c '\.test\.'` |
| Latest full suite (2026-11-11 run) | **3,245 tests, 3,231 passing**; remaining failures are pre-existing and queued as bugs | figure supplied by the owner from that run; the git history also records "suite 3231/1" for the latest merges |
| Feature lanes with written specs/plans in `docs/lanes/` | 8 (android-app, bug-chaser, perfection, runner-pilot, standing-teams, ui-bois, ui-polish, usage) | `ls docs/lanes` |
| Plan documents (`docs/PLAN_*.md`) in git history | 12 distinct files | `git log --all --name-only --format= -- 'docs/PLAN_*' \| sort -u \| wc -l` (the files are not in the current checkout; do not claim they exist now) |
| Docs files | 149 tracked under `docs/` | `git ls-files docs \| wc -l` |
| Art files | 265 tracked under `art/` | `git ls-files art \| wc -l` |
| Default profiles | 19 | `docs/profiles/DEFAULT_PACK.md` heading |
| Version | 0.2.7 (pre-1.0, being tested live) | `package.json` |
| Fix churn | 339 of 920 commits since 11-06 (~37%) match fix/regress/hotfix wording, an upper bound | `docs/research/BUG_INVENTORY_1109.md` |

Caveats to keep honest:
- Line counts are raw `wc -l` of tracked files: they include blank lines and comments, so say "about 90,000 lines of application code" and not more.
- The commit count is high mostly because agents commit often and every merge adds commits. It measures throughput of the agent workforce, not hand-typed work.
- The 10-day range is the date range of the git history in this repo. Do not claim anything about how long the idea existed before that.

## 6. Stack, and resume-ready bullets

### Stack

- **Languages:** TypeScript, JavaScript (ES modules, Node.js), Rust (Tauri shell), PowerShell and batch for Windows tooling.
- **Front end:** React 19, Vite, xterm.js terminals, a pixel-art UI system (Aseprite pipeline).
- **Back end:** Node.js 22+ HTTP/WebSocket server, own agent runner, MCP server, Web Push, node-pty.
- **Desktop and mobile:** Tauri 2 (Windows installer via NSIS, Android build), PWA.
- **AI:** Claude (several model tiers), Gemini via an ACP adapter, DeepSeek in the runner's pricing/provider mapping; Model Context Protocol (MCP); Agent Client Protocol (ACP).
- **Security and crypto:** per-device token pairing, local CA with name constraints, X25519 / HKDF / AES-GCM relay design.
- **Tooling:** git worktrees, GitHub, a custom Node test runner with 300+ test files.

### Resume bullets (impact-first; trim to fit)

1. Designed and directed VibeSquad, a local-first platform that runs teams of Claude, Gemini and DeepSeek coding agents; about 1,900 commits and ~90,000 lines of application code landed in 10 days with AI agents as the workforce.
2. Built a Squad / feature-lane / Buddy / Lead / Worker operating model with a shared team log and idea inbox, so many AI agents work in parallel on one codebase without stepping on each other.
3. Cut cost and cap risk with stakes-based model routing (top model for security work, small model for mechanical work) and automatic provider failover between Claude and Gemini at 95% quota.
4. Put automated quality gates around agent output: cross-provider review, stricter security/invariant reviews, and per-merge test verification (suite of 3,245 tests, 3,231 passing at the latest full run).
5. Made the agent fleet self-healing: restart-safe resume, stall watches, automatic context-limit handoffs, duplicate-lead detection and runtime sync, after replacing a third-party daemon with an in-house agent runner.
6. Instrumented the workflow itself: token/cost metering per spawn, plus a "Workflows" lane that runs experiments on routing and boot strategies and records keep/change/ruled-out verdicts as config.
7. Shipped the same product as a web app, a Tauri Windows desktop app and an Android app/PWA with QR device pairing over LAN/VPN mesh and a written threat model for an end-to-end-encrypted relay.
8. Turned recurring agent failures into a lessons library and default worker rules, with a bug-inventory process that clusters open issues by root cause.

## 7. Credits (include a line like this if the artifact lists influences)

From the project's `CREDITS.md`, using its format "Implemented X, thanks to Y by Z":
- Agent runner and orchestration concepts, native schedules, MCP name aliases: thanks to **Paseo** by getpaseo (VibeSquad was originally built on it).
- ACP adapters: thanks to **Agent Client Protocol** by Zed Industries.
- Provider quota failover and one-click provider switch: thanks to **Continuity**, **Switch provider**, **Usage Auto Resume** and **Zerosub** (community Paseo plugins by Chechulin Serhii, anh-chu, babo-jeonguk and Kapybara).
- Terminals: thanks to **node-pty** by Microsoft and **xterm.js** by the xterm.js authors.
- Pixel-art pipeline: thanks to **Aseprite** by Igara Studio and **aseprite-mcp** by diivi.
- QR pairing scan: thanks to **jsQR** by cozmo.

These are optional in a resume; they belong in a portfolio page's "built on / thanks to" line.

## 8. How to describe the owner's role honestly

- **Say:** the owner is the product owner, designer and director. The owner sets the goals, makes the product and design decisions, chooses the architecture direction, reviews outcomes, and runs a team of AI agents as the workforce. The agents write most of the code.
- **Do not say:** that the owner hand-wrote the code, or "built X lines". Use "designed and directed", "led", "orchestrated", "shipped with AI agents".
- **Frame this as the skill**, not an apology: AI orchestration is the job. The hard problems here are the ones an AI-automation role faces: splitting work across agents, keeping them from colliding, routing models by risk and cost, verifying output, recovering from failures, handling quota and context limits, and measuring what works. VibeSquad is a working answer to all of those, built and run daily.
- **Be careful with claims about outcomes.** It is pre-1.0 (0.2.7), is used by the owner, and is still being live-tested. It is not a commercial product with customers. There is no user count, revenue or uptime figure; do not invent any.
- **Be careful with maturity claims on the relay.** It is designed and partly implemented, not shipped.
- **Interview-safe talking points** (all backed above): why an in-house runner replaced a daemon, why identity comes from labels not titles, why reviews cross providers, why stakes pick the model, and what the Tier A review caught in the restart-resume work.
- **Suggested one-line summary:** "Designed and directed a multi-agent development platform (Claude/Gemini/DeepSeek) and used it to ship a web, desktop and Android app, with automated review gates, quota failover and self-healing ops."
