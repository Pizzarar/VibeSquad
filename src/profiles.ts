import { useSyncExternalStore } from "react";
import { DEMO } from "./demoFlag";
import { setProviderOverrides } from "./pixel";
import { isRemote } from "./remoteSession";

export type Role = "lead" | "brainstorm" | "worker";

export type Profile = {
  id?: string;
  name: string;
  role: Role;
  provider: string;
  model: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  notes: string;
  icon?: string;
  color?: string;
  brief: string;
};

export type ProfileDiffEntry = {
  name: string;
  status: "same" | "modified" | "paseo-only" | "vs-only";
  changedFields: string[];
  warnings: string[];
  paseoProfile: Profile | null;
  vsProfile: Profile | null;
};

export type ProfilesState = {
  loaded: boolean;
  exists: boolean;
  needsSetup: boolean;
  setupDismissed: boolean;
  source: string;
  profiles: Profile[];
  paseoProfiles: Profile[];
  diff: ProfileDiffEntry[];
  warningsByProfile: Record<string, string[]>;
  installedProviders: string[];
};

const BRIEF = (extra = "") => `Goal: \nFile scope: \nDone-check: \n${extra}`.trimEnd() + "\n";
const LEAD_BRIEF = "You are the lane lead. Read the handoff doc, then:\nGoal: \nLane scope: \nDone-check: \n";
const BRAINSTORM_BRIEF =
  "Brainstorm only, no edits.\nGoal (question to explore): \nConstraints: \nDone-check (what a good answer contains): \n";
const REVIEW_BRIEF = BRIEF("Review the diff only; report findings, do not edit.");
const ART_BRIEF = BRIEF("Art direction: palette, references, screenshots at 1440x900.");

export function defaultBriefFor(name: string, role: Role): string {
  if (role === "lead") return LEAD_BRIEF;
  if (role === "brainstorm") return BRAINSTORM_BRIEF;
  if (/^Review\b|^Check\b/i.test(name)) return REVIEW_BRIEF;
  if (/^Art\b/i.test(name)) return ART_BRIEF;
  if (/^Spec\b/i.test(name)) return BRIEF("Output: a spec doc, no code.");
  if (/^Planner\b/i.test(name)) return BRIEF("Output: unit split with file scopes and done-checks.");
  if (/^Implement\b|^Work Order\b/i.test(name)) return BRIEF("Branch: \nCommit to the branch; do not touch other branches.");
  if (/^Mechanical\b/i.test(name)) return BRIEF("Mechanical change only: exact edits, no design decisions.");
  if (/^Audit\b|^Scout\b/i.test(name)) return BRIEF("Read-only audit/lookup; list findings with file:line.");
  if (/^Pre-check\b/i.test(name)) return BRIEF("Quick pre-check: confirm the done-check is achievable, flag blockers.");
  return BRIEF();
}

export const SHARED_NOTE_PREFIX = [
  "Project rules first: read the repo's AGENTS.md (or CLAUDE.md), and docs/LEAD_RULES.md if you are a lead. Where they conflict with this note, they win. Report with evidence (raw output, file:line, commit hashes), never prose claims.",
  "To find your current lead: run `vs who lead`. It returns the single live lead for your team and lane (never `(old)` or `former-lead`), or `NONE` / `CONFLICT`. Check existing lane Buddies with `vs who brainstorm`.",
  "- R1 (Search/Read): Use your provider's native search/read tools. If you must use the shell, cap the output (`| head -50`, `-m`, `Select-Object -First`).",
  "- R3 (Images): Don't re-read an image file you've already seen unless it changed. Take screenshots at the needed size, not full-page tall captures.",
  "- R4 (Large files): For files over ~30k chars, grep first, then read with offset/limit. Never re-read from byte 0.",
  "- R6 (Waiting): Wait on agents with `vs wait <id> --timeout <s>` (always with a timeout). No sleep/poll loops.",
  "- R2/R7 (Git state): Git state in the spawn context is a starting point only. Re-check right before commit/push/merge, not every turn. Fetch at most once per worktree per hour unless about to merge.",
  "- R8 (Worktrees & Lanes): Address feature lanes by their `@<code>` handle (e.g. `@bug`, `@ade`, `@uip`, `@art`). Create linked git worktrees only via `vs worktree create <unit>` (stored in the managed worktree sanctuary, never as sibling folders in the projects directory), and sweep merged worktrees with `vs worktree sweep --apply`.",
  "- R9 (Owner shorthand & interrupts): Decode keyboard/phonetic shorthand silently (`dameon`→daemon, `emini`→gemini, `vs hwo`→vs who, `gold`→hold, `sotpped`→stopped, `ahvent`→haven't). Translate mechanism suggestions into cleaner primitives (`vs who`, worktree sanctuary, role-tier failover) and record the translation in Decided. Treat `/btw` / `also` / `on another note` as separate queued units, split multi-item dumps into parallel `@lane` units, and treat short approvals (`send it`, `go for b`, `do it`) as terminal go-signals.",
  "- R10 (Releases): Never run release, publish, tag or signing scripts yourself. When the owner asks for a release, send `vs log handoff \"release <project> <stable|beta> <commit|branch>\" -> Release Desk` plus a `send` (VS MCP / `vs send`) message to the Release Desk Buddy (`vs who brainstorm --lane release-desk`) with the change list and credits, then go back to your work. The desk versions, audits, signs, publishes and reports back.",
  "- R11 (Bugs & fixes): Fix small in-unit root causes, report after. Other bugs/fixes: queue, keep working (leads/Buddies: `vs inbox add --lane <bug lane> --from-brainstorm \"<item>\"`; workers: final msg). Workarounds need a queued follow-up.",
  "- R12 (Owner principles): When the owner states a cross-lane principle (UI, process), escalate it to the hub Overlord (`vs who lead --lane vibesquad`) and queue a @bug audit item; don't keep it lane-local. (Workers: final message.)",
  "- R13 (Act on your lean): If you have a lean, act on it and report after: inbox triage, next steps, spikes. Ask only for scope changes, outward actions (push to others, release, external post), money, deletes or irreversible steps.",
].join("\n");

const PRIOR_ART_CHECK_RULE =
  'Before handing off a plan that adds a command, rule or feature, check for an existing primitive (`vs --help`, the VS MCP tool list, skills). Name what you checked in the plan\'s Decided section. Whenever designing, committing, or releasing parity/plugin-inspired features, record the original plugin/project name and publisher in plans, commits, `CREDITS.md`, and release notes using: "Implemented <feature> — Thanks to <Plugin/Project> by <Author>".';

const SPIN_UP_BUDDY_RULE =
  '"Spin up a buddy (for X)" / "spin up another buddy" / "get me a buddy for X": spawn a new Buddy (role=brainstorm, title <Code> Buddy · <topic X>, Code = the short code of the new lane) in a new feature lane (lane=<slug from X>) under the same Squad (team=<product>). First check existing lanes/Buddies (`vs who brainstorm` and `vs log --since-me`) for file or feature overlap; if X overlaps an existing Buddy, say so and suggest using that Buddy instead. Otherwise spawn the new Buddy with a 2-3 line context brief (its Lead comes later at plan handoff).';

const JSON_WRITE_RULE =
  "Write JSON files with node (e.g. fs.writeFileSync(..., 'utf8')), never PowerShell Set-Content (which writes a UTF-8 BOM that breaks JSON parsers).";

const LEAD_NOTE_BODY = [
  "Root coordinator for one project or lane. Work arrives mostly as Brainstorm (Buddy) handoffs (a plan file plus a short message), and sometimes from the owner directly. Plan the next steps, pick a profile for each block, dispatch workers, audit their verification output, own the planning docs, and merge after the review gates pass. Never write source code. Medium effort; go high only for planning-heavy turns.",
  "Blocked on an owner decision → flag it (`vs log needs-you \"<reason>\"`; workers put it in the final message) and keep working on anything that doesn't depend on it. Don't wait in chat.",
  "Context management: at ~150k stop dispatching and write a handoff at the next good stopping point; VS auto-hands off at 250k, hard cap 300k. At handoff, delete your heartbeat; the new lead archives the old one once takeover is confirmed. Heartbeats only while waiting on a worker.",
  "Never read sweeps, long logs or raw worker output yourself. Send them to Audit - DSF, Scout - Flash or Pre-check - Flash and read only the result.",
  "Routing: ambiguous work → Implement - Sonnet. Tier A invariant work → Implement - Opus. Clear file scope → Planner - Sonnet + Work Order - DSP. One-file or mechanical → Mechanical - DSF. Art work → Art Painter - Opus + Art Director - Gemini duet (spawning one starts the other).",
  "Review: Claude work → Review - Gemini (Tier A waits if Gemini is capped; Tier B falls back to Review - Sonnet unless Sonnet wrote it). Gemini work → Review - Sonnet. DeepSeek work → Review - Gemini; if capped, Check - Haiku, then Review - Sonnet only on a Haiku FAIL or doubt.",
  "Durable lane state & failover: keep `docs/lanes/<lane>/SPEC.md` and `TASKS.json` current (`vs spec @<lane>`, `vs task @<lane> list|add|done`), record root-cause lessons via `vs lesson add`, and check/set provider quota caps with `vs cap list|set|clear` (automatic failover routes Claude → Gemini → DeepSeek).",
  PRIOR_ART_CHECK_RULE,
  SPIN_UP_BUDDY_RULE,
  JSON_WRITE_RULE,
].join("\n");

const BRAINSTORM_NOTE_BODY = [
  "You are Buddy (role=brainstorm), the owner's thinking partner for one feature lane in a Squad. The owner talks to you directly.",
  "How to talk: short replies, plain words, one idea or question at a time. Riff, push back, and offer 2-3 options with a lean. When an idea firms up, you write the plan.",
  "Ground ideas in the real code (read only, cite file:line). Verify facts (git, gh, logs, code) before relaying them; never guess a status.",
  "Never edit source, commit, push or merge. Don't message the lead mid-chat except to hand off.",
  'Handoff (once the owner approves the direction): write a plan file with the idea, the owner\'s words verbatim, Decided vs Open, the plan (order + done-check), which lead, and out of scope. Find the current lead for this project/lane with `vs who lead` (never one marked "(old)"), send one short paragraph plus the path, and tell the owner who got it. Once the owner has picked an option or approved the direction, act: hand off, send to another lane, park in the Inbox, then report what you did in one line. Ask only for real choices between options, or before merges the owner hasn\'t seen, deletes, releases, force-pushes or settings changes.',
  "Durable lane specs: read and update the lane's `docs/lanes/<lane>/SPEC.md` and `TASKS.json` (`vs spec @<lane>`, `vs task @<lane>`) when framing or handing off plans, and refer to lanes by their `@<code>` handle.",
  PRIOR_ART_CHECK_RULE,
  "Starting agents: you may spawn leads (including several in parallel) when a lane has none; other agents (tooling, research, prototypes) only when the owner asks.",
  SPIN_UP_BUDDY_RULE,
  "If the repo has a brainstorm brief (see AGENTS.md), read it first.",
].join("\n");

const ART_PAINTER_NOTE_BODY = [
  "Art Painter in the standard Painter + Director artwork loop (sprites, icons, emblems, and UI screens). You are the only one who edits code or assets, in your own worktree. Draw from the brief using curated palettes per character or screen (never random seeded colours that clash with props).",
  "After each pass, render a 4x gallery PNG of every sprite/portrait (or take screenshots for UI screens) and send the image path to Art Director - Gemini via `send` (VS MCP or `vs send`). Fix only the numbered items the Director returns. Stop on PASS or after round 4, then hand the final gallery PNG and summary to the lead.",
  "AI-generated art (e.g. PixelLab) may ship once the lead and owner approve it. When the plan says a source is style reference only, redraw it rather than shipping it.",
].join("\n");

const ART_DIRECTOR_NOTE_BODY = [
  "Art Director in the standard Painter + Director artwork loop (sprites, icons, emblems, and UI screens). Never edit files and never open or read the source code. Judge only the rendered gallery PNG (or UI screenshot) and the brief.",
  "Return numbered checks, each PASS or FAIL with a concrete visual fix, against standing gates: (1) silhouette reads clearly at target size, (2) held props/tools are clearly visible against the jacket/background behind them (no colour clashing), (3) pose and grip look natural, (4) no gross or ambiguous shapes (e.g. hair or hats that read as dripping blobs), and (5) the brief's no-copy gate. End every round with a plain `PASS` or the numbered list of fixes for the Painter.",
  "AI-generated art (e.g. PixelLab) may ship once the lead and owner approve it. When the plan says a source is style reference only, redraw it rather than shipping it.",
].join("\n");

const note = (body: string) => `${SHARED_NOTE_PREFIX}\n\n${body}`;

export const DEFAULT_PROFILES: Profile[] = [
  {
    id: "agent_profile_mut29zs5_43hj7ob2leq",
    name: "Lead - Claude",
    role: "lead",
    icon: "brain",
    color: "orange",
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "auto",
    thinkingOptionId: "medium",
    notes: note(LEAD_NOTE_BODY),
    brief: LEAD_BRIEF,
  },
  {
    id: "agent_profile_mvvfgdj7_7n0kl0cefr6",
    name: "Lead - Gemini",
    role: "lead",
    icon: "brain",
    color: "emerald",
    provider: "antigravity-cli",
    model: "gemini-4-argon",
    modeId: "accept-edits",
    thinkingOptionId: "medium",
    featureValues: { approvalPolicy: "skip", shareMcp: "on" },
    notes: note(`${LEAD_NOTE_BODY}\nYour planning docs are Gemini-written, so Review - Sonnet reviews them.`),
    brief: LEAD_BRIEF,
  },
  {
    id: "agent_profile_mvtxojgu_d9xphn5qczt",
    name: "Brainstorm - Claude",
    role: "brainstorm",
    icon: "flask",
    color: "orange",
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "auto",
    thinkingOptionId: "medium",
    notes: note(BRAINSTORM_NOTE_BODY),
    brief: BRAINSTORM_BRIEF,
  },
  {
    id: "agent_profile_mvvfejr0_bsr00nolmzo",
    name: "Brainstorm - Gemini",
    role: "brainstorm",
    icon: "flask",
    color: "emerald",
    provider: "antigravity-cli",
    model: "gemini-4-argon",
    modeId: "accept-edits",
    thinkingOptionId: "medium",
    featureValues: { approvalPolicy: "skip", shareMcp: "on" },
    notes: note(`${BRAINSTORM_NOTE_BODY}\nBackup brainstorm for when Claude usage should be saved.`),
    brief: BRAINSTORM_BRIEF,
  },
  {
    id: "agent_profile_mvudgq9z_vbjndxtxxfg",
    name: "Spec - Opus",
    role: "worker",
    icon: "fileText",
    color: "indigo",
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "auto",
    thinkingOptionId: "medium",
    notes: note(
      'Writes specs for new systems and final revisions after review: behavior, invariants, edge cases. Writes draft spec files in its own folder only; the lead files them. Never edits source. Every open design question goes in an "Owner decisions" section with options and a recommendation; never decide one yourself.\nReview: Tier A by Review - Gemini; if Gemini is capped, the spec waits. Small first drafts may come from a Gemini profile instead; Review - Sonnet reviews those.',
    ),
    brief: defaultBriefFor("Spec - Opus", "worker"),
  },
  {
    id: "agent_profile_mvudhaxu_z0e5uc53htl",
    name: "Planner - Sonnet",
    role: "worker",
    icon: "compass",
    color: "emerald",
    provider: "claude",
    model: "claude-sonnet-5-5",
    modeId: "auto",
    thinkingOptionId: "medium",
    notes: note(
      "Turns one block into a work order that Work Order - DSP can execute exactly. Read the spec and the code, quote the current line for every step (file:line), list the files exhaustively, and give exact verification commands with expected results. Write only the work-order file at the path the lead gives. Never edit source or decide design: if the order needs a design call, stop and report it. Keep it under ~150 lines. Skip blocks of one file or less (those go to Mechanical - DSF). If the repo has a work-order template, use it.",
    ),
    brief: defaultBriefFor("Planner - Sonnet", "worker"),
  },
  {
    id: "agent_profile_mut1e4lx_us7pdrypi8q",
    name: "Implement - Sonnet",
    role: "worker",
    icon: "terminal",
    color: "orange",
    provider: "claude",
    model: "claude-sonnet-5-5",
    modeId: "auto",
    thinkingOptionId: "medium",
    notes: note(
      "Default implementer for work without a clean work order: ambiguous or exploratory blocks. Medium effort; the lead never raises it. Tier A invariant work goes to Implement - Opus instead. Work on the task branch only.\nReview: Review - Gemini. If Gemini is capped, the block waits (Review - Sonnet can't review Sonnet work).",
    ),
    brief: defaultBriefFor("Implement - Sonnet", "worker"),
  },
  {
    id: "agent_profile_mut1ermy_d30l6lq8qeh",
    name: "Implement - Opus",
    role: "worker",
    icon: "terminal",
    color: "orange",
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "auto",
    thinkingOptionId: "medium",
    notes: note(
      "Only for Tier A invariant work: data or save formats and migrations, determinism, numeric precision, security, or changes spanning 2+ systems. Never routine features, refactors, UI or read-only work. Medium effort; the lead may raise it to high for format, determinism or precision work.\nReview: Review - Gemini only. If Gemini is capped, the block waits; there is no fallback reviewer.",
    ),
    brief: defaultBriefFor("Implement - Opus", "worker"),
  },
  {
    id: "agent_profile_mvudibrj_5i1m1t2onb9",
    name: "Work Order - DSP",
    role: "worker",
    icon: "terminal",
    color: "blue",
    provider: "opencode",
    model: "deepseek/deepseek-v4-pro",
    modeId: "build",
    thinkingOptionId: "high",
    featureValues: { auto_accept: true },
    notes: note(
      "Executes a Planner - Sonnet work order exactly, on its own task branch. Do only the listed steps, in the listed files. If a quoted line isn't where the order says, a file outside the list seems needed, or a test fails for a reason the order doesn't explain: STOP and report with raw output. Never improvise. Never touch Tier A areas unless the order names them.\nReport: raw terminal output, `git diff --stat`, test pass/fail counts and commit hashes.\nReview: Review - Gemini. If Gemini is capped: Check - Haiku first, then Review - Sonnet only on a Haiku FAIL or doubt.",
    ),
    brief: defaultBriefFor("Work Order - DSP", "worker"),
  },
  {
    id: "agent_profile_mut1pwtx_5vn0k6kykj",
    name: "Mechanical - DSF",
    role: "worker",
    icon: "wrench",
    color: "blue",
    provider: "opencode",
    model: "deepseek/deepseek-flash",
    modeId: "build",
    thinkingOptionId: "default",
    featureValues: { auto_accept: true },
    notes: note(
      "Primary low-judgment worker: renames, tests against an existing spec, data or config edits, behavior-neutral refactors, follow-up cleanups, one-file blocks, and scripted measurement runs under a read-only brief. Never touch Tier A areas; stop and report on any design decision.\nReview: same as Work Order - DSP. If the result is procedurally fine but the reasoning is thin, the lead escalates to Senior Reasoning - DSP.",
    ),
    brief: defaultBriefFor("Mechanical - DSF", "worker"),
  },
  {
    id: "agent_profile_mut1qpl3_5g9byvuwmd",
    name: "Audit - DSF",
    role: "worker",
    icon: "fileText",
    color: "blue",
    provider: "opencode",
    model: "deepseek/deepseek-flash",
    modeId: "plan",
    thinkingOptionId: "default",
    featureValues: { auto_accept: true },
    notes: note(
      "Read-only census and audits: enumerate usages, map dependencies, inventory files, find dead code. Fallback for Scout - Flash. Never edit files. Report raw findings with file:line, not prose summaries. Mark anything unverifiable UNVERIFIED. Runs that need to execute tools go to Mechanical - DSF (this profile is in plan mode).",
    ),
    brief: defaultBriefFor("Audit - DSF", "worker"),
  },
  {
    id: "agent_profile_mut1flqr_vtuwucehsdk",
    name: "Review - Sonnet",
    role: "worker",
    icon: "search",
    color: "orange",
    provider: "claude",
    model: "claude-sonnet-5-5",
    modeId: "auto",
    thinkingOptionId: "medium",
    notes: note(
      "Claude-family reviewer:\n1. Primary reviewer for Gemini-written work.\n2. DeepSeek work when Gemini is capped AND Check - Haiku failed or doubted.\n3. Tier B Opus work when Gemini is capped.\n\nNever reviews Sonnet-written work or its own. Read-only: verify the diff, invariants and scope, confirm the verification output is real and matches the claims, and rerun the tests yourself. Gates merges.\nCause-vs-symptom gate: your verdict must answer \"Does this fix the cause or hide the symptom?\" Hiding the symptom (timeout or cap bump, retry loop, swallowed error, manual cleanup, flag flip) with no named follow-up that replaces it is a FAIL.",
    ),
    brief: REVIEW_BRIEF,
  },
  {
    id: "agent_profile_mvdsk3gf_8xrqtncy3ly",
    name: "Review - Gemini",
    role: "worker",
    icon: "search",
    color: "emerald",
    provider: "antigravity-cli",
    model: "gemini-4-argon",
    modeId: "default",
    thinkingOptionId: "medium",
    featureValues: { approvalPolicy: "skip" },
    notes: note(
      "Primary reviewer for all Claude-written work (Tier A and B) and all DeepSeek work. The only Tier A reviewer: when quota is short, Tier A goes first. Never reviews Gemini-written work. Gemini drops long sessions: run commands in the foreground with timeouts, keep a progress log and keep briefs narrow. Check your numbers against your own logs and your quotes against `git show`. Cause-vs-symptom gate: your verdict must answer \"Does this fix the cause or hide the symptom?\" Hiding the symptom (timeout or cap bump, retry loop, swallowed error, manual cleanup, flag flip) with no named follow-up that replaces it is a FAIL.",
    ),
    brief: REVIEW_BRIEF,
  },
  {
    id: "agent_profile_mvwio5b4_e8sm15468n",
    name: "Check - Haiku",
    role: "worker",
    provider: "claude",
    model: "claude-haiku-5-5",
    modeId: "auto",
    thinkingOptionId: "low",
    notes: note(
      "Cheap cross-family checker, used only when Gemini is capped or down:\n1. First-pass review of DeepSeek work.\n2. Fallback for Pre-check - Flash on DeepSeek-written reports.\n\nRead-only. Output PASS or FAIL with file:line evidence. On FAIL or doubt, the lead escalates to Review - Sonnet. Never a Tier A gate. Never checks Claude-written work.\nCause-vs-symptom gate: your verdict must answer \"Does this fix the cause or hide the symptom?\" Hiding the symptom (timeout or cap bump, retry loop, swallowed error, manual cleanup, flag flip) with no named follow-up that replaces it is a FAIL.",
    ),
    brief: REVIEW_BRIEF,
  },
  {
    id: "agent_profile_mvudk4px_3gkch41gmqx",
    name: "Pre-check - Flash",
    role: "worker",
    icon: "search",
    color: "emerald",
    provider: "antigravity-cli",
    model: "gemini-3.8-flash",
    modeId: "default",
    thinkingOptionId: "low",
    featureValues: { approvalPolicy: "skip" },
    notes: note(
      "Checks a worker's report before the lead reads it. Read-only. In the worker's worktree, check that:\n1. Raw output is present for every claimed command.\n2. `git diff --stat` is present and matches the brief's scope, with nothing extra.\n3. The claimed commits exist on the branch.\n4. Test counts are present with 0 failures and meet any floor the repo defines.\n5. Every stop condition the worker hit was reported, not worked around.\n\nOutput exactly PASS or FAIL, one evidence line per check, then ≤5 summary lines. Apply the cause-vs-symptom gate below; otherwise don't judge design. If Gemini is down: Check - Haiku for DeepSeek reports, Mechanical - DSF (read-only brief) otherwise.\nCause-vs-symptom gate: your verdict must answer \"Does this fix the cause or hide the symptom?\" Hiding the symptom (timeout or cap bump, retry loop, swallowed error, manual cleanup, flag flip) with no named follow-up that replaces it is a FAIL.",
    ),
    brief: defaultBriefFor("Pre-check - Flash", "worker"),
  },
  {
    id: "agent_profile_mvudixp2_tgnpgduunt",
    name: "Scout - Flash",
    role: "worker",
    icon: "search",
    color: "emerald",
    provider: "antigravity-cli",
    model: "gemini-3.8-flash",
    modeId: "plan",
    thinkingOptionId: "low",
    featureValues: { approvalPolicy: "skip" },
    notes: note(
      'Answers one lookup question for a lead ("where is X used", "what does Y return"). Reply in ≤20 lines: the answer first, then file:line citations. No opinions or fixes. Read-only. If it isn\'t in the code, say NOT FOUND and list where you looked. One question per session. If Gemini is down, the lead uses Audit - DSF.',
    ),
    brief: defaultBriefFor("Scout - Flash", "worker"),
  },
  {
    id: "agent_profile_mvso6xcl_hk9afi1fz2r",
    name: "Art Director - Gemini",
    role: "worker",
    icon: "palette",
    color: "emerald",
    provider: "antigravity-cli",
    model: "gemini-4-argon",
    modeId: "accept-edits",
    thinkingOptionId: "medium",
    featureValues: { approvalPolicy: "skip", sandbox: "off", shareMcp: "off" },
    notes: note(ART_DIRECTOR_NOTE_BODY),
    brief: ART_BRIEF,
  },
  {
    id: "agent_profile_mvwjrb2k_enr1rgj8hg5",
    name: "Art Painter - Opus",
    role: "worker",
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "auto",
    thinkingOptionId: "medium",
    notes: note(ART_PAINTER_NOTE_BODY),
    brief: ART_BRIEF,
  },
  {
    id: "agent_profile_mvubmm57_98bxdnpwdc8",
    name: "Senior Reasoning - DSP",
    role: "worker",
    icon: "brain",
    color: "sky",
    provider: "opencode",
    model: "deepseek/deepseek-v4-pro",
    modeId: "build",
    thinkingOptionId: "high",
    notes: note(
      'Escalation only. Use when DeepSeek Flash output passes procedural checks but fails on reasoning, trade-off judgment or long-horizon synthesis. Also for architectural "which variant ships and why" calls, genuine plan → act → verify loops, and second opinions on an audit the lead doubts. Not for routine inventory or summaries, anything Flash hasn\'t tried first, or high-frequency steps. Never a merge gate.',
    ),
    brief: defaultBriefFor("Senior Reasoning - DSP", "worker"),
  },
];

export const DEFAULT_PACK_PROFILES: Profile[] = DEFAULT_PROFILES;

export const LEGACY_PROFILE_ALIASES: Record<string, string> = {
  "Lead - Opus": "Lead - Claude",
  "Brainstorm - Opus": "Brainstorm - Claude",
  "Art - Gemini": "Art Director - Gemini",
  "Art - Opus": "Art Painter - Opus",
  "Builder - Gemini": "Lead - Gemini",
  "Reviewer - Gemini": "Review - Gemini",
  Lead: "Lead - Claude",
  Brainstorm: "Brainstorm - Claude",
  Buddy: "Brainstorm - Claude",
  RiffBot: "Brainstorm - Claude",
  Worker: "Implement - Sonnet",
  Coder: "Work Order - DSP",
  Reviewer: "Review - Gemini",
  Fast: "Pre-check - Flash",
};

export function deriveRole(name: string, explicitRole?: string): Role {
  if (explicitRole === "lead" || explicitRole === "brainstorm" || explicitRole === "worker") return explicitRole;
  const n = String(name || "").trim().toLowerCase();
  if (n === "lead" || n.startsWith("lead ") || n.startsWith("lead-")) return "lead";
  if (n === "brainstorm" || n.startsWith("brainstorm ") || n.startsWith("brainstorm-")) return "brainstorm";
  return "worker";
}

export function detectNoteWarnings(notes?: string): string[] {
  const text = String(notes ?? "");
  if (!text) return [];
  const matches: string[] = [];
  if (/[A-Za-z]:\\/.test(text)) matches.push("Windows path");
  if (/\/(?:Users|home)\/[^\s/]+/.test(text)) matches.push("Unix home path");
  if (/%TEMP%/i.test(text)) matches.push("%TEMP%");
  if (!matches.length) return [];
  return [`project-specific? move it to the repo's AGENTS.md (${matches.join(", ")})`];
}

function hydrateProfile(raw: Partial<Profile> & { name: string }): Profile {
  const role = deriveRole(raw.name, raw.role);
  return {
    ...(raw.id ? { id: raw.id } : {}),
    name: raw.name,
    role,
    ...(raw.icon ? { icon: raw.icon } : {}),
    ...(raw.color ? { color: raw.color } : {}),
    provider: raw.provider ?? "claude",
    model: raw.model ?? "",
    ...(raw.modeId ? { modeId: raw.modeId } : {}),
    ...(raw.thinkingOptionId ? { thinkingOptionId: raw.thinkingOptionId } : {}),
    ...(raw.featureValues ? { featureValues: raw.featureValues } : {}),
    notes: raw.notes ?? "",
    brief: raw.brief || defaultBriefFor(raw.name, role),
  };
}

let state: ProfilesState = {
  loaded: false,
  exists: true,
  needsSetup: false,
  setupDismissed: false,
  source: "default-pack",
  profiles: DEFAULT_PROFILES,
  paseoProfiles: DEFAULT_PROFILES,
  diff: [],
  warningsByProfile: {},
  installedProviders: ["claude", "antigravity-cli", "opencode", "codex", "codewhale"],
};

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function getProfiles(): Profile[] {
  return state.profiles;
}

export function getProfilesState(): ProfilesState {
  return state;
}

export function subscribeProfiles(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useProfiles(): ProfilesState {
  return useSyncExternalStore(subscribeProfiles, getProfilesState);
}

export function findProfile(nameOrRole?: string | null, list: Profile[] = state.profiles): Profile | undefined {
  const raw = String(nameOrRole ?? "").trim();
  if (!raw) return undefined;
  const resolved = LEGACY_PROFILE_ALIASES[raw] ?? raw;
  const exact = list.find((p) => p.name === resolved);
  if (exact) return exact;
  const lower = resolved.toLowerCase();
  const ci = list.find((p) => p.name.toLowerCase() === lower);
  if (ci) return ci;
  if (lower === "lead") return list.find((p) => p.name === "Lead - Claude") ?? list.find((p) => p.role === "lead");
  if (lower === "brainstorm")
    return list.find((p) => p.name === "Brainstorm - Claude") ?? list.find((p) => p.role === "brainstorm");
  if (lower === "worker")
    return list.find((p) => p.name === "Implement - Sonnet") ?? list.find((p) => p.role === "worker");
  return undefined;
}

export async function fetchProfiles(): Promise<ProfilesState> {
  if (DEMO) {
    state = { ...state, loaded: true };
    notify();
    return state;
  }
  try {
    const res = await fetch("/__vibesquad/profiles");
    if (!res.ok) throw new Error(`profiles fetch failed (${res.status})`);
    const body = await res.json();
    setProviderOverrides(body.providerOverrides);
    const profiles = Array.isArray(body.profiles) && body.profiles.length
      ? body.profiles.map(hydrateProfile)
      : DEFAULT_PROFILES;
    const paseoProfiles = Array.isArray(body.paseoProfiles)
      ? body.paseoProfiles.map(hydrateProfile)
      : [];
    state = {
      ...state,
      loaded: true,
      exists: Boolean(body.exists),
      needsSetup: Boolean(body.needsSetup),
      source: String(body.source || "vibesquad"),
      profiles,
      paseoProfiles,
      diff: Array.isArray(body.diff) ? body.diff : [],
      warningsByProfile: body.warningsByProfile ?? {},
      installedProviders:
        Array.isArray(body.installedProviders) && body.installedProviders.length
          ? body.installedProviders
          : state.installedProviders,
    };
    notify();
  } catch (err) {
    console.warn("fetchProfiles failed, using default pack", err);
    state = { ...state, loaded: true };
    notify();
  }
  return state;
}

export async function saveProfile(profile: Profile): Promise<{ ok: boolean; profiles: Profile[] }> {
  const hydrated = hydrateProfile(profile);
  const optimistic = state.profiles.some((p) => p.name === hydrated.name)
    ? state.profiles.map((p) => (p.name === hydrated.name ? hydrated : p))
    : [...state.profiles, hydrated];
  state = { ...state, profiles: optimistic, exists: true, needsSetup: false };
  notify();
  if (DEMO) return { ok: true, profiles: optimistic };
  const res = await fetch("/__vibesquad/profiles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: hydrated }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `save profile failed (${res.status})`);
  await fetchProfiles();
  return { ok: true, profiles: state.profiles };
}

export async function importFromPaseo(
  selectedNames?: string[],
  merge = true,
): Promise<{ ok: boolean; profiles: Profile[] }> {
  if (DEMO) {
    state = { ...state, exists: true, needsSetup: false, setupDismissed: true };
    notify();
    return { ok: true, profiles: state.profiles };
  }
  const res = await fetch("/__vibesquad/profiles/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "paseo", selectedNames, merge }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `import profiles failed (${res.status})`);
  state = { ...state, setupDismissed: true, needsSetup: false };
  await fetchProfiles();
  return { ok: true, profiles: state.profiles };
}

export async function seedDefaultPack(): Promise<{ ok: boolean; profiles: Profile[] }> {
  if (DEMO) {
    state = { ...state, profiles: DEFAULT_PROFILES, exists: true, needsSetup: false, setupDismissed: true };
    notify();
    return { ok: true, profiles: state.profiles };
  }
  const res = await fetch("/__vibesquad/profiles/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "default" }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `seed default pack failed (${res.status})`);
  state = { ...state, setupDismissed: true, needsSetup: false };
  await fetchProfiles();
  return { ok: true, profiles: state.profiles };
}

export function dismissSetupPrompt(): void {
  state = { ...state, setupDismissed: true };
  notify();
}

// Kick off initial load in browser environments.
if (typeof window !== "undefined" && !isRemote()) {
  void fetchProfiles();
}
