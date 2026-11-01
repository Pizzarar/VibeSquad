import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SHARED_NOTE_PREFIX = [
  "Project rules first: read the repo's AGENTS.md (or CLAUDE.md), and docs/LEAD_RULES.md if you are a lead. Where they conflict with this note, they win. Report with evidence (raw output, file:line, commit hashes), never prose claims.",
  "To find your current lead: run `vs who lead`. It returns the single live lead for your team and lane (never `(old)` or `former-lead`), or `NONE` / `CONFLICT`. Check existing lane Buddies with `vs who brainstorm`.",
  "- R1 (Search/Read): Use your provider's native search/read tools. If you must use the shell, cap the output (`| head -50`, `-m`, `Select-Object -First`).",
  "- R3 (Images): Don't re-read an image file you've already seen unless it changed. Take screenshots at the needed size, not full-page tall captures.",
  "- R4 (Large files): For files over ~30k chars, grep first, then read with offset/limit. Never re-read from byte 0.",
  "- R6 (Waiting): Wait on agents with `paseo wait <id> --timeout <s>` (always with a timeout). No sleep/poll loops.",
  "- R2/R7 (Git state): Git state in the spawn context is a starting point only. Re-check right before commit/push/merge, not every turn. Fetch at most once per worktree per hour unless about to merge.",
].join("\n");

const PRIOR_ART_CHECK_RULE =
  "Before handing off a plan that adds a command, rule or feature, check for an existing primitive (`paseo --help`, Paseo MCP tool list, `vs --help`, skills). Name what you checked in the plan's Decided section.";

const SPIN_UP_BUDDY_RULE =
  '"Spin up a buddy (for X)" / "spin up another buddy" / "get me a buddy for X": spawn a new Buddy (role=brainstorm, title BRAINSTORM · <LANE> · <topic X>) in a new feature lane (lane=<slug from X>) under the same Squad (team=<product>). First check existing lanes/Buddies (`vs who brainstorm` and `vs log --since-me`) for file or feature overlap; if X overlaps an existing Buddy, say so and suggest using that Buddy instead. Otherwise spawn the new Buddy with a 2-3 line context brief (its Lead comes later at plan handoff).';

const LEAD_NOTE_BODY = [
  "Root coordinator for one project or lane. Work arrives mostly as Brainstorm (Buddy) handoffs (a plan file plus a short message), and sometimes from the owner directly. Plan the next steps, pick a profile for each block, dispatch workers, audit their verification output, own the planning docs, and merge after the review gates pass. Never write source code. Medium effort; go high only for planning-heavy turns.",
  "Blocked on an owner decision → flag it (needs-you label, one-line reason) and keep working on anything that doesn't depend on it. Don't wait in chat.",
  "Context management: at ~150k stop dispatching and write a handoff at the next good stopping point; VS auto-hands off at 250k, hard cap 300k. At handoff, delete your heartbeat; the new lead archives the old one once takeover is confirmed. Heartbeats only while waiting on a worker.",
  "Never read sweeps, long logs or raw worker output yourself. Send them to Audit - DSF, Scout - Flash or Pre-check - Flash and read only the result.",
  "Routing: ambiguous work → Implement - Sonnet. Tier A invariant work → Implement - Opus. Clear file scope → Planner - Sonnet + Work Order - DSP. One-file or mechanical → Mechanical - DSF.",
  "Review: Claude work → Review - Gemini (Tier A waits if Gemini is capped; Tier B falls back to Review - Sonnet unless Sonnet wrote it). Gemini work → Review - Sonnet. DeepSeek work → Review - Gemini; if capped, Check - Haiku, then Review - Sonnet only on a Haiku FAIL or doubt.",
  PRIOR_ART_CHECK_RULE,
  SPIN_UP_BUDDY_RULE,
].join("\n");

const BRAINSTORM_NOTE_BODY = [
  "You are Buddy (role=brainstorm), the owner's thinking partner for one feature lane in a Squad. The owner talks to you directly.",
  "How to talk: short replies, plain words, one idea or question at a time. Riff, push back, and offer 2-3 options with a lean. When an idea firms up, you write the plan.",
  "Ground ideas in the real code (read only, cite file:line). Verify facts (git, gh, logs, code) before relaying them; never guess a status.",
  "Never edit source, commit, push or merge. Don't message the lead mid-chat except to hand off.",
  'Handoff (when the owner says "send it"): write a plan file with the idea, the owner\'s words verbatim, Decided vs Open, the plan (order + done-check), which lead, and out of scope. Find the current lead for this project/lane with `vs who lead` (never one marked "(old)"), send one short paragraph plus the path, and tell the owner who got it.',
  PRIOR_ART_CHECK_RULE,
  "Starting agents: only when the owner asks, at most one at a time, and only for side work (tooling, research, prototypes).",
  SPIN_UP_BUDDY_RULE,
  "If the repo has a brainstorm brief (see AGENTS.md), read it first.",
].join("\n");

const ART_NOTE_BODY = [
  "UI and art-direction experiments, as one half of an art duet. Build your own alternative direction on the project's current screens, in your own worktree (never main, never commit). Gemini's strength: spatial layout and composition. Opus's strength: hierarchy, typography, readability and clean theme structure. Both get the same brief and work separately; don't read the other's worktree until the lead asks for a cross-critique. Keep sessions short (1-2 screens per task). The lead reviews, picks or merges, and shows the owner. If one provider is capped, run the other alone.",
  "AI-generated art is concept/placeholder only: keep it under `AI_GENERATED/` and never ship it.",
].join("\n");

const NOTE_BODIES = {
  "Lead - Claude": LEAD_NOTE_BODY,
  "Lead - Gemini": `${LEAD_NOTE_BODY}\nYour planning docs are Gemini-written, so Review - Sonnet reviews them.`,
  "Brainstorm - Claude": BRAINSTORM_NOTE_BODY,
  "Brainstorm - Gemini": `${BRAINSTORM_NOTE_BODY}\nBackup brainstorm for when Claude usage should be saved.`,
  "Spec - Opus": [
    'Writes specs for new systems and final revisions after review: behavior, invariants, edge cases. Writes draft spec files in its own folder only; the lead files them. Never edits source. Every open design question goes in an "Owner decisions" section with options and a recommendation; never decide one yourself.',
    "Review: Tier A by Review - Gemini; if Gemini is capped, the spec waits. Small first drafts may come from a Gemini profile instead; Review - Sonnet reviews those.",
  ].join("\n"),
  "Planner - Sonnet":
    "Turns one block into a work order that Work Order - DSP can execute exactly. Read the spec and the code, quote the current line for every step (file:line), list the files exhaustively, and give exact verification commands with expected results. Write only the work-order file at the path the lead gives. Never edit source or decide design: if the order needs a design call, stop and report it. Keep it under ~150 lines. Skip blocks of one file or less (those go to Mechanical - DSF). If the repo has a work-order template, use it.",
  "Implement - Sonnet": [
    "Default implementer for work without a clean work order: ambiguous or exploratory blocks. Medium effort; the lead never raises it. Tier A invariant work goes to Implement - Opus instead. Work on the task branch only.",
    "Review: Review - Gemini. If Gemini is capped, the block waits (Review - Sonnet can't review Sonnet work).",
  ].join("\n"),
  "Implement - Opus": [
    "Only for Tier A invariant work: data or save formats and migrations, determinism, numeric precision, security, or changes spanning 2+ systems. Never routine features, refactors, UI or read-only work. Medium effort; the lead may raise it to high for format, determinism or precision work.",
    "Review: Review - Gemini only. If Gemini is capped, the block waits; there is no fallback reviewer.",
  ].join("\n"),
  "Work Order - DSP": [
    "Executes a Planner - Sonnet work order exactly, on its own task branch. Do only the listed steps, in the listed files. If a quoted line isn't where the order says, a file outside the list seems needed, or a test fails for a reason the order doesn't explain: STOP and report with raw output. Never improvise. Never touch Tier A areas unless the order names them.",
    "Report: raw terminal output, `git diff --stat`, test pass/fail counts and commit hashes.",
    "Review: Review - Gemini. If Gemini is capped: Check - Haiku first, then Review - Sonnet only on a Haiku FAIL or doubt.",
  ].join("\n"),
  "Mechanical - DSF": [
    "Primary low-judgment worker: renames, tests against an existing spec, data or config edits, behavior-neutral refactors, follow-up cleanups, one-file blocks, and scripted measurement runs under a read-only brief. Never touch Tier A areas; stop and report on any design decision.",
    "Review: same as Work Order - DSP. If the result is procedurally fine but the reasoning is thin, the lead escalates to Senior Reasoning - DSP.",
  ].join("\n"),
  "Audit - DSF":
    "Read-only census and audits: enumerate usages, map dependencies, inventory files, find dead code. Fallback for Scout - Flash. Never edit files. Report raw findings with file:line, not prose summaries. Mark anything unverifiable UNVERIFIED. Runs that need to execute tools go to Mechanical - DSF (this profile is in plan mode).",
  "Review - Sonnet": [
    "Claude-family reviewer:",
    "1. Primary reviewer for Gemini-written work.",
    "2. DeepSeek work when Gemini is capped AND Check - Haiku failed or doubted.",
    "3. Tier B Opus work when Gemini is capped.",
    "",
    "Never reviews Sonnet-written work or its own. Read-only: verify the diff, invariants and scope, confirm the verification output is real and matches the claims, and rerun the tests yourself. Gates merges.",
  ].join("\n"),
  "Review - Gemini":
    "Primary reviewer for all Claude-written work (Tier A and B) and all DeepSeek work. The only Tier A reviewer: when quota is short, Tier A goes first. Never reviews Gemini-written work. Gemini drops long sessions: run commands in the foreground with timeouts, keep a progress log and keep briefs narrow. Check your numbers against your own logs and your quotes against `git show`.",
  "Check - Haiku": [
    "Cheap cross-family checker, used only when Gemini is capped or down:",
    "1. First-pass review of DeepSeek work.",
    "2. Fallback for Pre-check - Flash on DeepSeek-written reports.",
    "",
    "Read-only. Output PASS or FAIL with file:line evidence. On FAIL or doubt, the lead escalates to Review - Sonnet. Never a Tier A gate. Never checks Claude-written work.",
  ].join("\n"),
  "Pre-check - Flash": [
    "Checks a worker's report before the lead reads it. Read-only. In the worker's worktree, check that:",
    "1. Raw output is present for every claimed command.",
    "2. `git diff --stat` is present and matches the brief's scope, with nothing extra.",
    "3. The claimed commits exist on the branch.",
    "4. Test counts are present with 0 failures and meet any floor the repo defines.",
    "5. Every stop condition the worker hit was reported, not worked around.",
    "",
    "Output exactly PASS or FAIL, one evidence line per check, then ≤5 summary lines. Don't judge design. If Gemini is down: Check - Haiku for DeepSeek reports, Mechanical - DSF (read-only brief) otherwise.",
  ].join("\n"),
  "Scout - Flash":
    'Answers one lookup question for a lead ("where is X used", "what does Y return"). Reply in ≤20 lines: the answer first, then file:line citations. No opinions or fixes. Read-only. If it isn\'t in the code, say NOT FOUND and list where you looked. One question per session. If Gemini is down, the lead uses Audit - DSF.',
  "Art - Gemini": ART_NOTE_BODY,
  "Art - Opus": ART_NOTE_BODY,
  "Senior Reasoning - DSP":
    'Escalation only. Use when DeepSeek Flash output passes procedural checks but fails on reasoning, trade-off judgment or long-horizon synthesis. Also for architectural "which variant ships and why" calls, genuine plan → act → verify loops, and second opinions on an audit the lead doubts. Not for routine inventory or summaries, anything Flash hasn\'t tried first, or high-frequency steps. Never a merge gate.',
};

export function buildDefaultPackNotesMap() {
  const map = {};
  for (const [name, body] of Object.entries(NOTE_BODIES)) {
    map[name] = `${SHARED_NOTE_PREFIX}\n\n${body}`;
  }
  return map;
}

const DEFAULT_NOTES_MAP = buildDefaultPackNotesMap();

export const DEFAULT_PACK_PROFILES = [
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
    notes: DEFAULT_NOTES_MAP["Lead - Claude"],
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
    featureValues: {
      approvalPolicy: "skip",
      shareMcp: "on",
    },
    notes: DEFAULT_NOTES_MAP["Lead - Gemini"],
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
    notes: DEFAULT_NOTES_MAP["Brainstorm - Claude"],
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
    featureValues: {
      approvalPolicy: "skip",
      shareMcp: "on",
    },
    notes: DEFAULT_NOTES_MAP["Brainstorm - Gemini"],
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
    notes: DEFAULT_NOTES_MAP["Spec - Opus"],
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
    notes: DEFAULT_NOTES_MAP["Planner - Sonnet"],
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
    notes: DEFAULT_NOTES_MAP["Implement - Sonnet"],
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
    notes: DEFAULT_NOTES_MAP["Implement - Opus"],
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
    featureValues: {
      auto_accept: true,
    },
    notes: DEFAULT_NOTES_MAP["Work Order - DSP"],
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
    featureValues: {
      auto_accept: true,
    },
    notes: DEFAULT_NOTES_MAP["Mechanical - DSF"],
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
    featureValues: {
      auto_accept: true,
    },
    notes: DEFAULT_NOTES_MAP["Audit - DSF"],
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
    notes: DEFAULT_NOTES_MAP["Review - Sonnet"],
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
    featureValues: {
      approvalPolicy: "skip",
    },
    notes: DEFAULT_NOTES_MAP["Review - Gemini"],
  },
  {
    id: "agent_profile_mvwio5b4_e8sm15468n",
    name: "Check - Haiku",
    role: "worker",
    provider: "claude",
    model: "claude-haiku-5-5",
    modeId: "auto",
    thinkingOptionId: "low",
    notes: DEFAULT_NOTES_MAP["Check - Haiku"],
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
    featureValues: {
      approvalPolicy: "skip",
    },
    notes: DEFAULT_NOTES_MAP["Pre-check - Flash"],
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
    featureValues: {
      approvalPolicy: "skip",
    },
    notes: DEFAULT_NOTES_MAP["Scout - Flash"],
  },
  {
    id: "agent_profile_mvso6xcl_hk9afi1fz2r",
    name: "Art - Gemini",
    role: "worker",
    icon: "palette",
    color: "emerald",
    provider: "antigravity-cli",
    model: "gemini-4-argon",
    modeId: "accept-edits",
    thinkingOptionId: "medium",
    featureValues: {
      approvalPolicy: "skip",
      sandbox: "off",
      shareMcp: "off",
    },
    notes: DEFAULT_NOTES_MAP["Art - Gemini"],
  },
  {
    id: "agent_profile_mvwjrb2k_enr1rgj8hg5",
    name: "Art - Opus",
    role: "worker",
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "auto",
    thinkingOptionId: "medium",
    notes: DEFAULT_NOTES_MAP["Art - Opus"],
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
    notes: DEFAULT_NOTES_MAP["Senior Reasoning - DSP"],
  },
];

export const DEFAULT_PROFILES = DEFAULT_PACK_PROFILES;

export const LEGACY_PROFILE_ALIASES = {
  "Lead - Opus": "Lead - Claude",
  "Brainstorm - Opus": "Brainstorm - Claude",
};

export function deriveRole(name, explicitRole) {
  if (explicitRole === "lead" || explicitRole === "brainstorm" || explicitRole === "worker") {
    return explicitRole;
  }
  const n = String(name || "").trim().toLowerCase();
  if (n === "lead" || n.startsWith("lead ") || n.startsWith("lead-")) return "lead";
  if (n === "brainstorm" || n.startsWith("brainstorm ") || n.startsWith("brainstorm-")) return "brainstorm";
  return "worker";
}

export function getProfilesPath(overridePath) {
  if (overridePath) return resolve(overridePath);
  if (process.env.VIBESQUAD_PROFILES_PATH) return resolve(process.env.VIBESQUAD_PROFILES_PATH);
  const base = process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
  return resolve(join(base, "profiles.json"));
}

export function getPaseoConfigPath(overridePath) {
  if (overridePath) return resolve(overridePath);
  if (process.env.PASEO_CONFIG_PATH) return resolve(process.env.PASEO_CONFIG_PATH);
  return resolve(join(homedir(), ".paseo", "config.json"));
}

export function detectNoteWarnings(notes) {
  const text = String(notes ?? "");
  if (!text) return [];
  const matches = [];
  if (/[A-Za-z]:\\/.test(text)) matches.push("Windows path");
  if (/\/(?:Users|home)\/[^\s/]+/.test(text)) matches.push("Unix home path");
  if (/%TEMP%/i.test(text)) matches.push("%TEMP%");
  if (!matches.length) return [];
  return [`project-specific? move it to the repo's AGENTS.md (${matches.join(", ")})`];
}

export function normalizeProfile(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name ?? "").trim();
  if (!name) return null;
  const out = {};
  if (raw.id !== undefined) out.id = String(raw.id);
  out.name = name;
  out.role = deriveRole(name, raw.role);
  if (raw.icon !== undefined) out.icon = String(raw.icon);
  if (raw.color !== undefined) out.color = String(raw.color);
  out.provider = String(raw.provider ?? "");
  out.model = String(raw.model ?? "");
  if (raw.modeId !== undefined) out.modeId = String(raw.modeId);
  if (raw.thinkingOptionId !== undefined) out.thinkingOptionId = String(raw.thinkingOptionId);
  if (raw.featureValues !== undefined && raw.featureValues !== null && typeof raw.featureValues === "object") {
    out.featureValues = JSON.parse(JSON.stringify(raw.featureValues));
  }
  out.notes = String(raw.notes ?? "");
  if (raw.brief !== undefined) out.brief = String(raw.brief);
  return out;
}

export function toPaseoProfileShape(profile) {
  const out = {};
  if (profile.id !== undefined) out.id = profile.id;
  out.name = profile.name;
  if (profile.icon !== undefined) out.icon = profile.icon;
  if (profile.color !== undefined) out.color = profile.color;
  out.provider = profile.provider;
  out.model = profile.model;
  if (profile.modeId !== undefined) out.modeId = profile.modeId;
  if (profile.thinkingOptionId !== undefined) out.thinkingOptionId = profile.thinkingOptionId;
  if (profile.featureValues !== undefined) out.featureValues = JSON.parse(JSON.stringify(profile.featureValues));
  out.notes = profile.notes ?? "";
  return out;
}

export function importPaseoProfiles(rawInput, options = {}) {
  const list = Array.isArray(rawInput)
    ? rawInput
    : Array.isArray(rawInput?.profiles)
      ? rawInput.profiles
      : Array.isArray(rawInput?.daemon?.agentProfiles)
        ? rawInput.daemon.agentProfiles
        : [];
  const selectedNames = Array.isArray(options.selectedNames) ? new Set(options.selectedNames) : null;
  const profiles = [];
  const warningsByProfile = {};
  for (const item of list) {
    const norm = normalizeProfile(item);
    if (!norm) continue;
    if (selectedNames && !selectedNames.has(norm.name)) continue;
    const warnings = detectNoteWarnings(norm.notes);
    if (warnings.length) {
      warningsByProfile[norm.name] = warnings;
    }
    profiles.push(norm);
  }
  if (options.profilesPath || options.write) {
    const targetPath = getProfilesPath(options.profilesPath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, JSON.stringify({ version: 1, profiles }, null, 2) + "\n", "utf8");
  }
  return {
    profiles,
    warningsByProfile,
    hasWarnings: Object.keys(warningsByProfile).length > 0,
  };
}

export function seedDefaultPack(profilesPath) {
  const targetPath = getProfilesPath(profilesPath);
  const profiles = DEFAULT_PACK_PROFILES.map((p) => normalizeProfile(p));
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify({ version: 1, profiles }, null, 2) + "\n", "utf8");
  return {
    ok: true,
    path: targetPath,
    profiles,
  };
}

export function readPaseoConfig(paseoConfigPath) {
  const cfgPath = getPaseoConfigPath(paseoConfigPath);
  if (!existsSync(cfgPath)) {
    return {
      exists: false,
      path: cfgPath,
      agentProfiles: [],
      installedProviders: ["claude", "antigravity-cli", "opencode", "codex"],
    };
  }
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
    const agentProfiles = Array.isArray(raw?.daemon?.agentProfiles) ? raw.daemon.agentProfiles : [];
    const installed = new Set();
    const providers = raw?.agents?.providers ?? {};
    for (const [k, v] of Object.entries(providers)) {
      if (v && typeof v === "object" && v.enabled !== false) installed.add(k);
    }
    const plugins = raw?.plugins ?? {};
    for (const [k, v] of Object.entries(plugins)) {
      if (v && typeof v === "object" && v.enabled !== false) installed.add(k);
    }
    if (!installed.size) {
      for (const p of ["claude", "antigravity-cli", "opencode", "codex"]) installed.add(p);
    }
    return {
      exists: true,
      path: cfgPath,
      agentProfiles,
      installedProviders: [...installed],
    };
  } catch {
    return {
      exists: false,
      path: cfgPath,
      agentProfiles: [],
      installedProviders: ["claude", "antigravity-cli", "opencode", "codex"],
    };
  }
}

export function loadProfiles(profilesPath, options = {}) {
  const targetPath = getProfilesPath(profilesPath);
  const paseoInfo =
    options.paseoProfiles !== undefined
      ? {
          exists: true,
          path: "",
          agentProfiles: options.paseoProfiles,
          installedProviders: options.installedProviders || ["claude", "antigravity-cli", "opencode", "codex"],
        }
      : readPaseoConfig(options.paseoConfigPath);

  if (existsSync(targetPath)) {
    try {
      const parsed = JSON.parse(readFileSync(targetPath, "utf8"));
      const rawList = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.profiles) ? parsed.profiles : [];
      const profiles = rawList.map(normalizeProfile).filter(Boolean);
      if (profiles.length > 0) {
        return {
          exists: true,
          needsSetup: false,
          seeded: false,
          source: "vibesquad",
          path: targetPath,
          profiles,
          installedProviders: paseoInfo.installedProviders,
          paseoProfiles: paseoInfo.agentProfiles.map(normalizeProfile).filter(Boolean),
        };
      }
    } catch {
      // Fall through to recovery/seed
    }
  }

  // First-run: if Paseo has profiles, surface them for import (needsSetup: true);
  // if Paseo has none, seed the 19-profile default pack automatically.
  if (paseoInfo.agentProfiles.length > 0) {
    const imported = importPaseoProfiles(paseoInfo.agentProfiles);
    return {
      exists: false,
      needsSetup: true,
      seeded: false,
      source: "paseo-unimported",
      path: targetPath,
      profiles: imported.profiles,
      warningsByProfile: imported.warningsByProfile,
      installedProviders: paseoInfo.installedProviders,
      paseoProfiles: imported.profiles,
    };
  }

  if (options.autoSeed !== false) {
    const seeded = seedDefaultPack(targetPath);
    return {
      exists: true,
      needsSetup: false,
      seeded: true,
      source: "default-pack",
      path: targetPath,
      profiles: seeded.profiles,
      warningsByProfile: {},
      installedProviders: paseoInfo.installedProviders,
      paseoProfiles: [],
    };
  }

  return {
    exists: false,
    needsSetup: true,
    seeded: false,
    source: "default-pack",
    path: targetPath,
    profiles: DEFAULT_PACK_PROFILES.map(normalizeProfile),
    warningsByProfile: {},
    installedProviders: paseoInfo.installedProviders,
    paseoProfiles: [],
  };
}

export function saveProfiles(input, profilesPath) {
  const targetPath = getProfilesPath(profilesPath);
  let nextProfiles = [];
  if (Array.isArray(input)) {
    nextProfiles = input.map(normalizeProfile).filter(Boolean);
  } else if (Array.isArray(input?.profiles)) {
    nextProfiles = input.profiles.map(normalizeProfile).filter(Boolean);
  } else if (input?.profile && typeof input.profile === "object") {
    const current = loadProfiles(targetPath, { autoSeed: true }).profiles;
    const updated = normalizeProfile(input.profile);
    if (!updated) throw new Error("Invalid profile object");
    const idx = current.findIndex(
      (p) => (updated.id && p.id === updated.id) || p.name.toLowerCase() === updated.name.toLowerCase(),
    );
    if (idx >= 0) {
      nextProfiles = [...current];
      nextProfiles[idx] = { ...current[idx], ...updated };
    } else {
      nextProfiles = [...current, updated];
    }
  } else {
    throw new Error("Expected { profiles: [...] } or { profile: {...} }");
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify({ version: 1, profiles: nextProfiles }, null, 2) + "\n", "utf8");
  return {
    ok: true,
    path: targetPath,
    profiles: nextProfiles,
  };
}

const DIFF_FIELDS = ["id", "name", "provider", "model", "modeId", "thinkingOptionId", "featureValues", "notes", "icon", "color"];

export function diffProfiles(vsProfiles = [], paseoProfiles = []) {
  const vsMap = new Map(vsProfiles.map((p) => [p.name, p]));
  const paseoMap = new Map(paseoProfiles.map((p) => [p.name, p]));
  const allNames = new Set([...paseoMap.keys(), ...vsMap.keys()]);
  const entries = [];
  for (const name of allNames) {
    const vsP = vsMap.get(name) || null;
    const paP = paseoMap.get(name) || null;
    const warnings = paP ? detectNoteWarnings(paP.notes) : [];
    if (paP && !vsP) {
      entries.push({
        name,
        status: "paseo-only",
        changedFields: [...DIFF_FIELDS],
        warnings,
        paseoProfile: paP,
        vsProfile: null,
      });
      continue;
    }
    if (vsP && !paP) {
      entries.push({
        name,
        status: "vs-only",
        changedFields: [],
        warnings: detectNoteWarnings(vsP.notes),
        paseoProfile: null,
        vsProfile: vsP,
      });
      continue;
    }
    const changedFields = [];
    for (const f of DIFF_FIELDS) {
      const a = JSON.stringify(vsP[f] ?? null);
      const b = JSON.stringify(paP[f] ?? null);
      if (a !== b) changedFields.push(f);
    }
    entries.push({
      name,
      status: changedFields.length ? "modified" : "same",
      changedFields,
      warnings,
      paseoProfile: paP,
      vsProfile: vsP,
    });
  }
  return entries;
}

export function findProfile(nameOrRole, profilesInput) {
  const profiles = Array.isArray(profilesInput) && profilesInput.length
    ? profilesInput
    : loadProfiles(undefined, { autoSeed: false }).profiles;
  const rawKey = String(nameOrRole ?? "").trim();
  if (!rawKey) return null;
  const resolvedName = LEGACY_PROFILE_ALIASES[rawKey] || rawKey;

  const exact = profiles.find((p) => p.name === resolvedName);
  if (exact) return exact;

  const lower = resolvedName.toLowerCase();
  const ci = profiles.find((p) => p.name.toLowerCase() === lower);
  if (ci) return ci;

  if (lower === "lead") {
    return profiles.find((p) => p.name === "Lead - Claude") || profiles.find((p) => p.role === "lead") || null;
  }
  if (lower === "brainstorm") {
    return (
      profiles.find((p) => p.name === "Brainstorm - Claude") ||
      profiles.find((p) => p.role === "brainstorm") ||
      null
    );
  }
  if (lower === "worker") {
    return (
      profiles.find((p) => p.name === "Implement - Sonnet") ||
      profiles.find((p) => p.role === "worker") ||
      null
    );
  }
  return null;
}

export function toPaseoSpawnConfig(profileOrName, overrides = {}, profilesInput) {
  const profile =
    typeof profileOrName === "string"
      ? findProfile(profileOrName, profilesInput)
      : profileOrName;
  if (!profile) {
    throw new Error(`Profile not found: ${String(profileOrName)}`);
  }
  const mergedFeatures = {
    ...(profile.featureValues ?? {}),
    ...(overrides.featureValues ?? {}),
  };
  const hasFeatures = Object.keys(mergedFeatures).length > 0;
  const notes = overrides.notes !== undefined ? overrides.notes : (profile.notes ?? "");
  const systemPrompt = overrides.systemPrompt !== undefined ? overrides.systemPrompt : notes;

  const out = {
    provider: overrides.provider ?? profile.provider,
    model: overrides.model ?? profile.model,
    ...(overrides.modeId !== undefined || profile.modeId !== undefined
      ? { modeId: overrides.modeId ?? profile.modeId }
      : {}),
    ...(overrides.thinkingOptionId !== undefined || profile.thinkingOptionId !== undefined
      ? { thinkingOptionId: overrides.thinkingOptionId ?? profile.thinkingOptionId }
      : {}),
    ...(hasFeatures ? { featureValues: mergedFeatures } : {}),
    notes,
    systemPrompt,
  };
  return out;
}
