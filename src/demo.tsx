// Fixed cast for ?demo (art review and screenshots without a live daemon) and the
// ?cast=1 cast sheet. Nothing here talks to Paseo.
import type { PaseoAgent } from "./agentTypes";
import { AGENT_TYPE_NAME, type AgentType } from "./teams";
import { Avatar, providerSpec } from "./pixel";

const VS = "/path/to/vibesquad";
const WT = "/path/to/.paseo/worktrees/2eokl1my/";
const EFI = "/path/to/main-project";

const MODELS: Record<string, [string, string]> = {
  claude: ["claude", "claude-opus-5-5"],
  sonnet: ["claude", "claude-sonnet-5-5"],
  gemini: ["antigravity-cli", "gemini-4-argon"],
  opencode: ["opencode", "deepseek/deepseek-v4-pro"],
  deepseek: ["opencode", "deepseek/deepseek-flash"],
  codex: ["codex", "gpt-codex"],
  cursor: ["cursor", "cursor-fast"],
  copilot: ["copilot", "gpt-5"],
  codewhale: ["codewhale", "deepseek-v4"],
  pi: ["pi", "pi-coder"],
  aider: ["aider", "sonnet"],
};

type Spec = {
  id: string;
  who: keyof typeof MODELS;
  title: string;
  status?: string;
  labels?: Record<string, string>;
  used?: number;
  cwd?: string;
  ago?: number;
  extra?: Record<string, unknown>;
};

function agent(s: Spec): PaseoAgent {
  const [provider, model] = MODELS[s.who];
  return {
    id: s.id,
    provider,
    model,
    title: s.title,
    status: s.status ?? "idle",
    cwd: s.cwd ?? VS,
    labels: s.labels ?? {},
    updatedAt: new Date(Date.now() - (s.ago ?? 3) * 60_000).toISOString(),
    lastUsage: s.used ? { contextWindowUsedTokens: s.used, contextWindowMaxTokens: 1_000_000 } : undefined,
    pendingPermissions: [],
    requiresAttention: false,
    ...s.extra,
  } as unknown as PaseoAgent;
}

const vs = (extra: Record<string, string> = {}) => ({ team: "vibesquad", lead: "vibesquad", ...extra });

export const DEMO_LEAD_ID = "demo-lead-vs";
export const DEMO_AGY_IDLE = "demo-agy-idle";
export const DEMO_AGY_ERR = "demo-agy-err";
export const DEMO_AGY_HUNG = "demo-art-g";

const CAST: Spec[] = [
  { id: DEMO_LEAD_ID, who: "gemini", title: "★ VIBESQUAD ord1", status: "running", labels: vs({ role: "lead", "paseo.parent-agent-id": "demo-old-2" }), used: 134_000, ago: 0 },
  { id: "demo-bs-vs", who: "claude", title: "BRAINSTORM · neon-noir cast", labels: vs({ role: "brainstorm" }), used: (typeof location === "undefined" ? 0 : Number(new URLSearchParams(location.search).get("bsUsed"))) || 62_000, ago: 12 },
  { id: "demo-old-1", who: "claude", title: "(old) ★ LEAD · VIBESQUAD v0", status: "closed", labels: vs({ role: "old-lead" }), used: 128_000, ago: 300 },
  { id: "demo-old-2", who: "gemini", title: "(old) ★ LEAD · VIBESQUAD art round A", status: "closed", labels: vs({ role: "old-lead" }), used: 131_000, ago: 140 },
  { id: "demo-art-o", who: "claude", title: "Art Painter - Opus · neon-noir", status: "running", labels: vs({ role: "worker", task: "art", job: "neon-noir", profile: "opus", "paseo.parent-agent-id": DEMO_LEAD_ID }), used: 88_000, cwd: WT + "vibesquad-neon-opus", ago: 0 },
  { id: "demo-art-g", who: "gemini", title: "Art Director - Gemini · neon-noir", status: "running", labels: vs({ role: "worker", job: "art", "paseo.parent-agent-id": DEMO_LEAD_ID }), used: 41_000, cwd: WT + "vibesquad-neon-gemini", ago: 4 },
  { id: "demo-impl-1", who: "deepseek", title: "Implement - drawer crash", status: "running", labels: vs({ role: "worker", "paseo.parent-agent-id": DEMO_LEAD_ID }), used: 245_000, ago: 2 },
  { id: "demo-impl-2", who: "claude", title: "Implement - team actions", status: "running", labels: vs({ role: "worker", "paseo.parent-agent-id": "demo-art-o" }), used: 37_000, ago: 4 },
  { id: "demo-mech", who: "codex", title: "Mechanical - rename sweep", status: "running", labels: vs({ role: "worker", "paseo.parent-agent-id": "demo-impl-2" }), used: 21_000, ago: 6 },
  { id: "demo-rev", who: "sonnet", title: "Review - Sonnet · drawer", labels: vs({ role: "worker", "needs-you": "pick", "needs-you-reason": "pick option A or B", "paseo.parent-agent-id": DEMO_LEAD_ID }), used: 74_000, ago: 9 },
  {
    id: "demo-aud", who: "gemini", title: "Audit - token scout", labels: vs({ role: "worker" }), used: 186_000, ago: 5,
    extra: { pendingPermissions: [{ id: "p1", name: "Bash", title: "Bash: rg --stats", description: "Count tokens per handoff" }] },
  },
  { id: "demo-attached", who: "claude", title: "Implement - legacy hook", status: "running", labels: vs({ role: "worker", "paseo.parent-agent-id": "demo-old-2" }), used: 28_000, ago: 3 },
  { id: DEMO_AGY_IDLE, who: "gemini", title: "Mechanical - doc sweep (Gemini)", labels: vs({ role: "worker" }), used: 58_000, ago: 3 },
  { id: DEMO_AGY_ERR, who: "gemini", title: "Review - Gemini · retry", status: "error", labels: vs({ role: "worker" }), used: 66_000, ago: 2, extra: { lastError: 'Post "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent": EOF' } },
  { id: "demo-spec", who: "claude", title: "Spec - step 6 server plugin", labels: vs({ role: "worker" }), used: 55_000, ago: 25 },
  { id: "demo-unk", who: "deepseek", title: "helper", labels: vs(), used: 9_000, ago: 40 },
  { id: "demo-rev-2", who: "gemini", title: "Review - Gemini · art", status: "closed", labels: vs({ role: "worker", "paseo.parent-agent-id": DEMO_LEAD_ID }), used: 92_000, ago: 200 },
  // One worker per provider row so ?demo=1 shows all 8 dedicated icons plus the generic fallback.
  { id: "demo-prov-cursor", who: "cursor", title: "Implement - Cursor · settings", status: "running", labels: vs({ role: "worker", "paseo.parent-agent-id": DEMO_LEAD_ID }), used: 30_000, ago: 3 },
  { id: "demo-prov-copilot", who: "copilot", title: "Review - Copilot · diff", labels: vs({ role: "worker", "paseo.parent-agent-id": DEMO_LEAD_ID }), used: 26_000, ago: 5 },
  { id: "demo-prov-codewhale", who: "codewhale", title: "Audit - CodeWhale · logs", status: "running", labels: vs({ role: "worker", "paseo.parent-agent-id": DEMO_LEAD_ID }), used: 44_000, ago: 4 },
  { id: "demo-prov-pi", who: "pi", title: "Mechanical - Pi · rename", labels: vs({ role: "worker", "paseo.parent-agent-id": DEMO_LEAD_ID }), used: 12_000, ago: 6 },
  { id: "demo-prov-opencode", who: "opencode", title: "Implement - OpenCode · hooks", status: "running", labels: vs({ role: "worker", "paseo.parent-agent-id": DEMO_LEAD_ID }), used: 52_000, ago: 2 },
  { id: "demo-prov-aider", who: "aider", title: "Implement - Aider · generic", labels: vs({ role: "worker", "paseo.parent-agent-id": DEMO_LEAD_ID }), used: 18_000, ago: 7 },
  // Other teams, so the sidebar has several bosses.
  { id: "demo-lead-efi", who: "claude", title: "★ MAIN GAME ord75", status: "running", labels: { team: "efi", lane: "main-game", role: "lead", ord: "75", "needs-you": "merge", "needs-you-reason": "approve the save-format merge" }, used: 97_000, cwd: EFI },
  { id: "demo-lead-efi-dup", who: "sonnet", title: "★ MAIN GAME ord74", labels: { team: "efi", lane: "main-game", role: "lead", ord: "74" }, used: 90_000, cwd: EFI, ago: 30 },
  { id: "demo-bs-efi-1", who: "claude", title: "BRAINSTORM · MAIN GAME · OpenRouter pipeline critique", labels: { team: "efi", lane: "main-game", role: "brainstorm", topic: "OpenRouter pipeline critique" }, cwd: EFI, ago: 20 },
  { id: "demo-bs-efi-2", who: "gemini", title: "BRAINSTORM · MAIN GAME · site polish", labels: { team: "efi", lane: "main-game", role: "brainstorm", topic: "site polish" }, cwd: EFI, ago: 40 },
  { id: "demo-lead-ui", who: "deepseek", title: "★ UI LAB ord3", labels: { team: "efi", lane: "ui-lab", role: "lead", ord: "3" }, used: 45_000, cwd: EFI },
  { id: "demo-lead-pl", who: "codex", title: "★ LEAD · Plugins", labels: { team: "plugins", lead: "plugins", role: "lead" }, used: 30_000, extra: { requiresAttention: true, attentionReason: "finished" }, cwd: "/path/to/paseo-agent-board" },
  { id: "demo-lead-site", who: "sonnet", title: "★ LEAD · Site polish", labels: { team: "site", lead: "site-polish", role: "lead" }, used: 12_000, cwd: "/path/to/example-site" },
];

// More VibeSquad teams (lanes) so the floor pager has 3+ teams: 5 teams at 2 per floor = 3 floors (the last half empty) for the lift < > to page.
CAST.push(
  { id: "demo-lead-ui-bois", who: "sonnet", title: "★ UI BOIS ord9", labels: vs({ role: "lead", lane: "ui-bois", ord: "9" }), used: 52_000, ago: 2 },
  { id: "demo-impl-ui-bois", who: "claude", title: "Implement - overlap guard", status: "running", labels: vs({ role: "worker", lane: "ui-bois", "paseo.parent-agent-id": "demo-lead-ui-bois" }), used: 31_000, ago: 3 },
  { id: "demo-lead-art-dir", who: "gemini", title: "★ ART DIRECTION ord4", labels: vs({ role: "lead", lane: "art-direction", ord: "4" }), used: 70_000, ago: 8 },
  { id: "demo-lead-runner", who: "codex", title: "★ RUNNER PILOT ord2", labels: vs({ role: "lead", lane: "runner-pilot", ord: "2" }), used: 20_000, ago: 12 },
  { id: "demo-lead-wiki", who: "claude", title: "★ WIKI ord1", labels: vs({ role: "lead", lane: "wiki", ord: "1" }), used: 15_000, ago: 15 },
);

// ?riff=1: a live RiffBot + Overlord on the VibeSquad hub lane (lane label "riffbot"), so the Sky page can open Riff's chat,
// slam him into the Overlord and land the takeover. Off by default: the plain demo's hub is idle ("Spin Up RiffBot").
if (typeof location !== "undefined" && new URLSearchParams(location.search).has("riff")) {
  CAST.push(
    { id: "demo-hub-riff", who: "claude", title: "RiffBot · VibeSquad hub", status: "running", labels: vs({ role: "brainstorm", lane: "riffbot" }), used: 40_000, ago: 1 },
    { id: "demo-hub-overlord", who: "gemini", title: "★ OVERLORD · VibeSquad hub", status: "running", labels: vs({ role: "lead", lane: "riffbot" }), used: 60_000, ago: 1 },
  );
}

const ARCHIVED: Spec[] = [
  { id: "demo-arc-1", who: "claude", title: "Implement - step 1 scaffold", status: "closed", labels: vs({ role: "worker" }), used: 90_000, ago: 3000, extra: { archivedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() } },
  { id: "demo-arc-2", who: "gemini", title: "Audit - DSF", status: "closed", labels: vs({ role: "worker" }), used: 120_000, ago: 4000, extra: { archivedAt: new Date(Date.now() - 5 * 3_600_000).toISOString() } },
  { id: "demo-arc-3", who: "codex", title: "Mechanical - lint sweep", status: "closed", labels: { team: "efi", role: "worker" }, used: 15_000, ago: 5000, extra: { archivedAt: new Date(Date.now() - 9 * 86_400_000).toISOString() } },
];

export function demoArchived(): Map<string, PaseoAgent> {
  return new Map(ARCHIVED.map((s) => [s.id, agent(s)]));
}

const day = 86_400_000;
const ws = (id: string, name: string, kind: string, dir: string, o: Record<string, unknown> = {}) => ({
  id,
  name,
  workspaceKind: kind,
  workspaceDirectory: dir,
  projectRootPath: dir,
  projectDisplayName: "VibeSquad",
  status: "done",
  activityAt: new Date(Date.now() - 0.2 * day).toISOString(),
  ...o,
});
const git = (branch: string, o: Record<string, unknown> = {}) => ({ currentBranch: branch, isPaseoOwnedWorktree: true, isDirty: false, aheadBehind: { ahead: 0, behind: 0 }, ...o });

export function demoWorkspaces(): Map<string, unknown> {
  const list = [
    ws("w1", "main", "local_checkout", VS, { gitRuntime: git("main", { isPaseoOwnedWorktree: false }) }),
    ws("w2", "vibesquad-neon-opus", "worktree", WT + "vibesquad-neon-opus", { gitRuntime: git("art-neon-opus", { isDirty: true }) }),
    ws("w3", "vibesquad-neon-gemini", "worktree", WT + "vibesquad-neon-gemini", { gitRuntime: git("art-neon-gemini") }),
    ws("w4", "vibesquad-art-gemini", "worktree", WT + "vibesquad-art-gemini", { activityAt: new Date(Date.now() - 6 * day).toISOString(), gitRuntime: git("vibesquad-art-gemini") }),
    ws("w5", "vibesquad-art-duet-opus", "worktree", WT + "vibesquad-art-duet-opus", { activityAt: new Date(Date.now() - 9 * day).toISOString(), gitRuntime: git("art-duet-opus") }),
    ws("w6", "vibesquad-old-spike", "worktree", WT + "vibesquad-old-spike", { activityAt: new Date(Date.now() - 12 * day).toISOString(), gitRuntime: git("old-spike", { aheadBehind: { ahead: 3, behind: 0 } }) }),
    ws("w7", "efi-ui-lab", "worktree", WT + "efi-ui-lab", { activityAt: new Date(Date.now() - 4 * day).toISOString(), gitRuntime: git("ui-lab", { isDirty: true }), githubRuntime: { pullRequest: { url: "#", title: "UI lab", state: "OPEN", baseRefName: "main", headRefName: "ui-lab", isMerged: false } } }),
  ];
  return new Map(list.map((w) => [w.id, w]));
}

export function demoAgents(): Map<string, PaseoAgent> {
  return new Map(CAST.map((s) => [s.id, agent(s)]));
}

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

// Antigravity hardening fixtures, keyed by demo agent id.
function agyTimeline(agentId: string): { item: unknown; timestamp: string }[] {
  if (agentId === DEMO_AGY_HUNG)
    return [
      { item: { type: "user_message", text: "Build the neon-noir portraits from the shared brief." }, timestamp: minsAgo(30) },
      { item: { type: "assistant_message", text: "I cannot read /path/to/Downloads/ref-sheet.png because it is outside the workspace. Please copy the file into the workspace." }, timestamp: minsAgo(20) },
      { item: { type: "tool_call", name: "SendMessage", status: "completed", detail: { type: "plain", label: "report to lead" } }, timestamp: minsAgo(12) },
      { item: { type: "tool_call", name: "run_command", status: "running", callId: "c1", detail: { type: "shell", command: 'node build.mjs --watch "palette"' } }, timestamp: minsAgo(7) },
    ];
  if (agentId === DEMO_AGY_IDLE)
    return [
      { item: { type: "user_message", text: "Sweep the docs for stale step numbers." }, timestamp: minsAgo(8) },
      { item: { type: "assistant_message", text: "Found 14 stale references. Now I'll run the rename script and check the diff." }, timestamp: minsAgo(4) },
    ];
  if (agentId === DEMO_AGY_ERR)
    return [{ item: { type: "user_message", text: "Review the drawer diff." }, timestamp: minsAgo(5) }];
  return [];
}

export function demoTimeline(agentId: string): { item: unknown; seqStart: number; timestamp?: string }[] {
  const agy = agyTimeline(agentId);
  if (agy.length) return agy.map((e, i) => ({ ...e, seqStart: i }));
  const items = [
    { type: "user_message", text: "Run the neon-noir Painter + Director loop. Painter renders a 4x gallery PNG; Director critiques against the brief." },
    { type: "assistant_message", text: "Dispatching Art Painter - Opus and Art Director - Gemini. Painter draws and renders the gallery; Director judges the PNG and returns numbered fixes." },
    { type: "tool_call", name: "Grep", status: "completed", detail: { query: "palette" } },
    { type: "tool_call", name: "PowerShell", status: "completed", detail: { type: "shell", command: "node scripts/check-cast.mjs" } },
    { type: "tool_call", name: "Edit", status: "completed", detail: { filePath: "src/pixel.tsx" } },
    { type: "tool_call", name: "create_agent", status: "completed", detail: { type: "plain", label: "Art Painter - Opus · neon-noir" } },
    { type: "tool_call", name: "create_agent", status: "completed", detail: { type: "plain", label: "Art Director - Gemini · neon-noir" } },
    { type: "tool_call", name: "Agent", status: "running", detail: { type: "sub_agent", subAgentType: "Explore", description: "check handoff budget numbers" } },
    { type: "todo", items: [{ text: "Duet builds", status: "in_progress" }, { text: "Cross-critique", status: "pending" }, { text: "Show user 2 options", status: "pending" }] },
    { type: "tool_call", name: "Bash", status: "running", detail: { type: "shell", command: "vs who lead" } },
  ];
  return agentId ? items.map((item, i) => ({ item, seqStart: i, timestamp: new Date(Date.now() - (items.length - i) * 7 * 60_000).toISOString() })) : [];
}

export function demoProviderUsage() {
  return [
    { provider: "claude", account: "you@max", usedPct: 62, resetAt: new Date(Date.now() + 3 * 3_600_000).toISOString() },
    { provider: "antigravity-cli", account: "ultra", usedPct: 91 },
    { provider: "codex", account: "plus", usedPct: 28 },
  ];
}

export type FeedEntry = { ts: string; agent: string; lane: string; type: string; text: string; refs?: string[] };

export function demoLog(): FeedEntry[] {
  const e = (m: number, agent: string, lane: string, type: string, text: string, refs: string[] = []): FeedEntry => ({ ts: minsAgo(m), agent, lane, type, text, refs });
  return [
    e(3, "you", "", "you", "Ship step 5B + 6U3 together, then pause for my review before any upstream filing."),
    e(6, "★ LEAD · VIBESQUAD ord1", "vibesquad", "metric", "first-dispatch context: 71k tokens (baseline 80k)"),
    e(14, "Pre-check - Flash", "vibesquad", "done", "PASS step4 team actions: build green, 3 files touched", ["docs/reports/step4.md"]),
    e(22, "★ LEAD · VIBESQUAD ord1", "vibesquad", "decision", "Successor spawns use the packet path, not a pasted summary.", ["docs/PLAN_STEP6_7_EFFICIENCY.md"]),
    e(41, "Implement - Sonnet", "vibesquad", "blocker", "Atlassian MCP needs auth; skipping Jira links."),
    e(55, "★ LEAD · VIBESQUAD ord1", "vibesquad", "needs-you", "Pick option A or B for the lead portrait pass."),
    e(90, "(old) VIBESQUAD ord0", "vibesquad", "handoff", "packet-vibesquad.md written; 3 workers still attached.", ["packet-vibesquad.md"]),
  ];
}

// ---- cast sheet ---------------------------------------------------------------

const TYPES = Object.keys(AGENT_TYPE_NAME) as AgentType[];
const SHEET_PROVIDERS = ["claude", "codex", "antigravity-cli", "opencode", "cursor", "copilot", "codewhale", "pi", "aider"];

export function SpriteSheet() {
  return (
    <main className="sheet">
      <h1>VibeSquad cast · neon-noir</h1>
      <div className="sheet-grid" style={{ gridTemplateColumns: `170px repeat(${SHEET_PROVIDERS.length}, 96px) 1fr` }}>
        <div />
        {SHEET_PROVIDERS.map((p) => {
          const spec = providerSpec(p);
          return (
            <div key={p} className="sheet-head" style={{ color: spec.color }}>
              {spec.symbol} {spec.name}
            </div>
          );
        })}
        <div className="sheet-head">same role + provider, different seeds</div>
        {TYPES.map((t) => (
          <Row key={t} t={t} />
        ))}
      </div>
    </main>
  );
}

function Row({ t }: { t: AgentType }) {
  return (
    <>
      <div className="sheet-name">{AGENT_TYPE_NAME[t]}</div>
      {SHEET_PROVIDERS.map((p) => (
        <div key={p}>
          <Avatar id={`sheet-${t}-${p}`} provider={p} agentType={t} size={84} />
        </div>
      ))}
      <div className="sheet-vars">
        {[1, 2, 3, 4, 5].map((i) => (
          <Avatar key={i} id={`var-${t}-${i}`} provider="claude" agentType={t} size={56} />
        ))}
      </div>
    </>
  );
}

// ---- ?five-leads=1: the project leads, one per provider at exact sidebar size ------------------------

const FIVE_LEADS: { id: string; provider: string; lane: string }[] = [
  { id: "demo-lead-efi", provider: "claude", lane: "Claude" },
  { id: "demo-lead-pl", provider: "codex", lane: "Codex" },
  { id: DEMO_LEAD_ID, provider: "antigravity-cli", lane: "Gemini" },
  { id: "demo-lead-ui", provider: "opencode", lane: "OpenCode" },
  { id: "demo-lead-cursor", provider: "cursor", lane: "Cursor" },
  { id: "demo-lead-copilot", provider: "copilot", lane: "Copilot" },
  { id: "demo-lead-codewhale", provider: "codewhale", lane: "CodeWhale" },
  { id: "demo-lead-pi", provider: "pi", lane: "Pi" },
  { id: "demo-lead-aider", provider: "aider", lane: "Aider" },
];

/** Top row: no labels, 28x28 like the sidebar. Second row: the same leads with lane names. */
export function FiveLeads() {
  return (
    <main className="sheet five-leads">
      <div className="five-row">
        {FIVE_LEADS.map((l, i) => (
          <Avatar key={l.id} id={l.id} provider={l.provider} agentType="lead" variant={i} size={32} />
        ))}
      </div>
      <div className="five-row labelled">
        {FIVE_LEADS.map((l, i) => (
          <div key={l.id} className="five-cell">
            <Avatar id={l.id} provider={l.provider} agentType="lead" variant={i} size={32} />
            <span>{l.lane}</span>
          </div>
        ))}
      </div>
      <div className="five-row labelled big">
        {FIVE_LEADS.map((l, i) => (
          <div key={l.id} className="five-cell">
            <Avatar id={l.id} provider={l.provider} agentType="lead" variant={i} size={112} />
            <span>{l.lane}</span>
          </div>
        ))}
      </div>
    </main>
  );
}
