import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  createPlugin,
  gitUnitBranchState,
  deriveTeamForSpawn,
  isHubCwd,
  laneBriefBlock,
  nextLeadOrd,
  profileFieldDiffs,
  parseAgentMessageEnvelope,
  retiredHolderRole,
  HUB_BUDDY_RULES,
  BRAINSTORM_PACK,
  EVERYONE_LAYER,
} from "./agent-duties.ts";
import type { AgentSettingsPatch } from "./agent-duties.ts";

const CWD = "/projects/VibeSquad";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TEAMS_DOC: any = {
  teams: [
    {
      id: "vibesquad",
      name: "VibeSquad",
      lanes: [
        { id: "vibesquad", name: "VibeSquad", hub: true, paths: ["VibeSquad"] },
        { id: "bug-chaser", name: "Bug Chaser", code: "Bug", paths: ["VibeSquad"] },
        { id: "feat-alpha", name: "Feat Alpha", code: "Fea", paths: ["VibeSquad"] },
      ],
      paths: ["VibeSquad"],
    },
  ],
};

const PROFILES: any[] = [
  {
    name: "Brainstorm - Claude",
    role: "brainstorm",
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "auto",
    thinkingOptionId: "medium",
  },
  {
    name: "Brainstorm - Gemini",
    role: "brainstorm",
    provider: "antigravity-cli",
    model: "gemini-4-argon",
    modeId: "accept-edits",
    thinkingOptionId: "medium",
    featureValues: { approvalPolicy: "skip", shareMcp: "on" },
  },
  {
    name: "Lead - Claude",
    role: "lead",
    provider: "claude",
    model: "claude-opus-5-5",
    modeId: "auto",
    thinkingOptionId: "medium",
  },
  {
    name: "Lead - Gemini",
    role: "lead",
    provider: "antigravity-cli",
    model: "gemini-4-argon",
    modeId: "accept-edits",
    thinkingOptionId: "medium",
    featureValues: { approvalPolicy: "skip", shareMcp: "on" },
  },
  {
    name: "Work Order - DSP",
    role: "worker",
    provider: "opencode",
    model: "deepseek/deepseek-v4-pro",
    modeId: "build",
    thinkingOptionId: "high",
    featureValues: { auto_accept: true },
  },
  {
    name: "Review - Gemini",
    role: "worker",
    provider: "antigravity-cli",
    model: "gemini-4-argon",
    modeId: "default",
    thinkingOptionId: "medium",
    featureValues: { approvalPolicy: "skip" },
  },
];

const PROFILES_DOC: any = { profiles: PROFILES };

const BRIEF_VIBESQUAD = "## Done when\n- ship the hub\n\n## Decided\n- one hub lane\n";
const BRIEF_FEAT_ALPHA = "## Done when\n- phase two ships\n\n## Decided\n- split feature lane\n";

function readLogEntries(vsHome: string): any[] {
  const file = join(vsHome, "teams", "vibesquad", "log.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function metricTexts(vsHome: string): string[] {
  return readLogEntries(vsHome)
    .filter((e) => e.type === "metric")
    .map((e) => e.text);
}

function withEnv(fn: (ctx: { vsHome: string; briefRoot: string }) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-coord-e2e-"));
    const vsHome = join(dir, ".vibesquad");
    const briefRoot = join(dir, "repo");
    mkdirSync(vsHome, { recursive: true });
    mkdirSync(join(briefRoot, "docs", "brainstorm"), { recursive: true });
    writeFileSync(join(briefRoot, "docs", "brainstorm", "vibesquad.md"), BRIEF_VIBESQUAD, "utf8");
    writeFileSync(join(briefRoot, "docs", "brainstorm", "feat-alpha.md"), BRIEF_FEAT_ALPHA, "utf8");
    const teamsFile = join(vsHome, "teams.json");
    writeFileSync(teamsFile, JSON.stringify(TEAMS_DOC), "utf8");
    const profilesFile = join(vsHome, "profiles.json");
    writeFileSync(profilesFile, JSON.stringify(PROFILES_DOC), "utf8");
    const prev = {
      VIBESQUAD_HOME: process.env.VIBESQUAD_HOME,
      VIBESQUAD_TEAMS_FILE: process.env.VIBESQUAD_TEAMS_FILE,
      VIBESQUAD_PROFILES_PATH: process.env.VIBESQUAD_PROFILES_PATH,
    };
    process.env.VIBESQUAD_HOME = vsHome;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    process.env.VIBESQUAD_PROFILES_PATH = profilesFile;
    try {
      await fn({ vsHome, briefRoot });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function harness(
  agents: Map<string, any>,
  opts: {
    briefRoot: string;
    timelineByAgent?: Map<string, any[]>;
    cappedProviders?: any;
    usageProviders?: any[];
    leadWakeCooldownMs?: number;
    unitBranchState?: (cwd: string | undefined) => Promise<{ unit: string; merged: boolean }>;
    /** Test hook for flushWake's snap(): null -> null snapshot, a string -> the agent with that status. */
    snapStatusOverride?: (id: string) => string | null | undefined;
  },
) {
  const before = new Map<string, (input: any) => any>();
  const on = new Map<string, (input: any, ctx: any) => any>();
  const setLabelsCalls: Array<{ agentId: string; labels: Record<string, string>; name?: string }> = [];
  const detachedIds: string[] = [];
  const appliedSettings: Array<{ agentId: string; patch: AgentSettingsPatch }> = [];
  const refusedIds: string[] = [];
  const archivedIds: string[] = [];
  const sent: Array<{ to: string; text: string }> = [];
  const timelineByAgent = opts.timelineByAgent ?? new Map<string, any[]>();

  const server = {
    before(name: string, fn: (input: any) => any) {
      before.set(name, fn);
      return () => before.delete(name);
    },
    on(name: string, fn: (input: any, ctx: any) => any) {
      on.set(name, fn);
      return () => on.delete(name);
    },
  };

  const stop = createPlugin({
    startWatcher: false,
    briefRoot: opts.briefRoot,
    debounceMs: 20,
    retryBaseMs: 10,
    firstPromptRedeliverMs: 60_000,
    leadWakeCooldownMs: opts.leadWakeCooldownMs ?? 40,
    ...(opts.unitBranchState ? { unitBranchState: opts.unitBranchState } : {}),
    ...(opts.cappedProviders !== undefined ? { cappedProviders: opts.cappedProviders } : {}),
    ...(opts.usageProviders !== undefined ? { usageProviders: opts.usageProviders } : {}),
    setLabels: async (agentId: string, labels: Record<string, string>, name?: string) => {
      setLabelsCalls.push({ agentId, labels, name });
      const a = agents.get(agentId);
      if (a) {
        a.labels = { ...(a.labels ?? {}), ...labels };
        if (name) a.title = name;
      }
    },
    archiveAgent: async (agentId: string) => {
      archivedIds.push(agentId);
      const a = agents.get(agentId);
      if (a) a.archivedAt = new Date().toISOString();
    },
    applyAgentSettings: async (agentId: string, patch: AgentSettingsPatch) => {
      appliedSettings.push({ agentId, patch });
      const a = agents.get(agentId);
      if (a) {
        if (patch.model) a.model = patch.model;
        if (patch.modeId) a.modeId = patch.modeId;
        if (patch.thinkingOptionId) a.thinkingOptionId = patch.thinkingOptionId;
      }
    },
    refuseAgent: async (agentId: string) => {
      refusedIds.push(agentId);
      const a = agents.get(agentId);
      if (a) a.archivedAt = new Date().toISOString();
    },
  })(server as any);

  const paseo = {
    agents: {
      ref(id: string) {
        return {
          async refresh() {
            const a = agents.get(id);
            if (opts.snapStatusOverride) {
              const override = opts.snapStatusOverride(id);
              if (override === null) return null;
              if (typeof override === "string") return a ? { agent: { ...a, status: override } } : null;
            }
            return a ? { agent: a } : null;
          },
          async send(text: string) {
            sent.push({ to: id, text });
          },
          async detach() {
            detachedIds.push(id);
          },
          async archive() {
            archivedIds.push(id);
            const a = agents.get(id);
            if (a) a.archivedAt = new Date().toISOString();
          },
          timeline: {
            async refetch() {
              return { entries: timelineByAgent.get(id) ?? [] };
            },
          },
        };
      },
      async list() {
        return { entries: [...agents.values()].map((agent: any) => ({ agent })) };
      },
    },
  };

  return {
    stop,
    archivedIds,
    scanLogs: (stop as any).scanLogs as (baseline?: boolean) => void,
    sweepDoneWorkers: (stop as any).sweepDoneWorkers as (now?: number) => Promise<string[]>,
    sweepDoneWorkersReport: (stop as any).sweepDoneWorkersReport as (o?: { apply?: boolean; now?: number }) => Promise<any>,
    async beforeCreate(req: any) {
      return (await before.get("agent.create")!({ request: req })) ?? req;
    },
    beforeSend(payload: any) {
      return before.get("send_agent_prompt")!(payload);
    },
    onCreated(agent: any) {
      return on.get("agent.created")!({ agent }, { paseo });
    },
    onTurnStarted(agent: any) {
      return on.get("agent.turn_started")!({ agent }, { paseo });
    },
    onTurnEnded(agent: any, outcome: any = { kind: "completed" }) {
      return on.get("agent.turn_ended")!({ agent, turnId: "t1", outcome }, { paseo });
    },
    setLabelsCalls,
    detachedIds,
    appliedSettings,
    refusedIds,
    sent,
    timelineByAgent,
    paseo,
  };
}

// ---------------------------------------------------------------------------
// Stage 1 — RiffBot (hub) layering + feature Lane Buddy brief injection
// ---------------------------------------------------------------------------

test(
  "Stage 1: hub Buddy gets EVERYONE_LAYER + BRAINSTORM_PACK + HUB_BUDDY_RULES and the hub brief; feature Buddy gets its lane brief without hub rules",
  withEnv(async ({ vsHome, briefRoot }) => {
    const team = TEAMS_DOC.teams[0];
    assert.equal(isHubCwd(team, "vibesquad"), true);
    assert.equal(isHubCwd(team, "feat-alpha"), false);

    assert.ok(laneBriefBlock(briefRoot, "feat-alpha").includes("--- BEGIN docs/brainstorm/feat-alpha.md ---"));

    const h = harness(new Map(), { briefRoot });
    try {
      // RiffBot: the Squad hub Buddy (lane vibesquad, hub: true)
      const riff = await h.beforeCreate({
        config: { cwd: CWD, provider: "antigravity-cli", model: "gemini-4-argon", title: "RiffBot" },
        labels: { role: "brainstorm", lane: "vibesquad" },
      });
      const riffSys = riff.config.systemPrompt;
      assert.ok(riffSys.includes(EVERYONE_LAYER), "EVERYONE_LAYER injected");
      assert.ok(riffSys.includes(BRAINSTORM_PACK), "BRAINSTORM_PACK injected");
      assert.ok(riffSys.includes(HUB_BUDDY_RULES), "HUB_BUDDY_RULES injected for the hub Buddy");
      assert.ok(riffSys.includes("--- BEGIN docs/brainstorm/vibesquad.md ---"), "hub brief injected");

      // Feature Lane Buddy: lane feat-alpha (not the hub)
      const fea = await h.beforeCreate({
        config: { cwd: CWD, provider: "antigravity-cli", model: "gemini-4-argon", title: "Fea Buddy" },
        labels: { role: "brainstorm", lane: "feat-alpha" },
      });
      const feaSys = fea.config.systemPrompt;
      const derived = deriveTeamForSpawn({ role: "brainstorm", lane: "feat-alpha" }, CWD);
      assert.equal(derived.team, "vibesquad");
      assert.equal(derived.lane, "feat-alpha");
      assert.ok(feaSys.includes(BRAINSTORM_PACK), "BRAINSTORM_PACK injected");
      assert.ok(feaSys.includes("--- BEGIN docs/brainstorm/feat-alpha.md ---"), "feat-alpha brief injected");
      assert.ok(!feaSys.includes(HUB_BUDDY_RULES), "no hub rules for a feature Buddy");

      const m = metricTexts(vsHome);
      assert.ok(m.some((t) => t.startsWith("brief-injected: lane=vibesquad")), "hub brief-injected metric");
      assert.ok(m.some((t) => t.startsWith("brief-injected: lane=feat-alpha")), "feature brief-injected metric");
    } finally {
      h.stop?.();
    }
  }),
);

// ---------------------------------------------------------------------------
// Stage 2 — Lane Buddy spawns its Lane Lead; predecessor lead retired
// ---------------------------------------------------------------------------

test(
  "Stage 2: a Lane Buddy's handoff spawn auto-assigns team/ord, does not detach the new lead (row 13 gone), and retires the predecessor",
  withEnv(async ({ briefRoot }) => {
    assert.equal(nextLeadOrd([], "feat-alpha", "lead-2"), "1", "no lead -> ord 1");
    assert.equal(
      nextLeadOrd([{ id: "lead-1", labels: { lane: "feat-alpha", role: "lead", ord: "1" } }], "feat-alpha", "lead-2"),
      "2",
      "lead-1 exists -> ord 2",
    );

    const lead1 = {
      id: "lead-1",
      title: "★ Fea1 · initial setup",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "lead", ord: "1", job: "initial setup" },
    };
    const buddy1 = {
      id: "buddy-1",
      title: "Fea Buddy",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "brainstorm" },
    };
    const lead2 = {
      id: "lead-2",
      title: "★ Fea2 · phase two",
      cwd: CWD,
      status: "idle",
      labels: { lane: "feat-alpha", role: "lead", job: "phase two" } as Record<string, string>,
    };
    const agents = new Map<string, any>([
      ["lead-1", lead1],
      ["buddy-1", buddy1],
      ["lead-2", lead2],
    ]);
    const h = harness(agents, { briefRoot });
    try {
      await h.onCreated({
        id: "lead-2",
        parentAgentId: "buddy-1",
        cwd: CWD,
        labels: { lane: "feat-alpha", role: "lead", job: "phase two" },
      });

      assert.equal(lead2.labels.team, "vibesquad", "auto-assigned team");
      assert.equal(lead2.labels.lane, "feat-alpha", "lane kept");
      assert.equal(lead2.labels.ord, "2", "auto-assigned next ord");
      assert.deepEqual(h.detachedIds, [], "row 13 gone: the new lead is no longer detached from its Buddy parent");

      assert.equal(lead1.labels.role, "former-lead", "predecessor retired");
      assert.equal(lead1.title, "(old) Fea1 · initial setup", "predecessor title updated");
      assert.ok(
        h.setLabelsCalls.some(
          (c) => c.agentId === "lead-1" && c.labels.role === "former-lead" && c.name === "(old) Fea1 · initial setup",
        ),
        "retire wrote role + title via setLabels",
      );
    } finally {
      h.stop?.();
    }
  }),
);

// ---------------------------------------------------------------------------
// Stage 3 — Lane Lead dispatches Workers/Reviewers with explicit profile labels
// ---------------------------------------------------------------------------

test(
  "Stage 3: profile override before/after spawn, antigravity guard, provider refusal, and first-dispatch metric",
  withEnv(async ({ vsHome, briefRoot }) => {
    const lead2 = {
      id: "lead-2",
      title: "★ Fea2 · phase two",
      cwd: CWD,
      status: "idle",
      provider: "antigravity-cli",
      model: "gemini-4-argon",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "lead", ord: "2" },
    };
    const agents = new Map<string, any>([["lead-2", lead2]]);
    const h = harness(agents, { briefRoot });
    try {
      // 3a: before("agent.create") explicit profile override (antigravity-cli guard not triggered)
      const wo = PROFILES.find((p) => p.name === "Work Order - DSP");
      const diffs = profileFieldDiffs(
        { provider: "opencode", model: "wrong-model", modeId: "plan", thinkingOptionId: "low" },
        wo,
      );
      assert.deepEqual(diffs.map((d) => d.field).sort(), ["mode", "model", "thinking"]);

      const out = await h.beforeCreate({
        config: {
          provider: "opencode",
          model: "wrong-model",
          modeId: "plan",
          thinkingOptionId: "low",
          cwd: CWD,
          title: "Fea2 · build widget",
        },
        labels: { team: "vibesquad", lane: "feat-alpha", role: "worker", profile: "Work Order - DSP" },
      });
      assert.equal(out.config.model, "deepseek/deepseek-v4-pro");
      assert.equal(out.config.modeId, "build");
      assert.equal(out.config.thinkingOptionId, "high");
      assert.equal(out.config.featureValues.auto_accept, true);

      // 3b: antigravity-cli permission guard when no featureValues/modeId are supplied
      const agy = await h.beforeCreate({
        config: { provider: "antigravity-cli", model: "gemini-4-argon", cwd: CWD, title: "Fea2 · review" },
        labels: { team: "vibesquad", lane: "feat-alpha", role: "worker" },
      });
      assert.equal(agy.config.featureValues.approvalPolicy, "skip");
      assert.equal(agy.config.modeId, undefined, "row 4 gone: no forced accept-edits mode");

      const m1 = metricTexts(vsHome);
      for (const field of ["model", "mode", "thinking"]) {
        assert.ok(
          m1.some((t) => t.includes(`field=${field}`) && t.includes("profile=Work Order - DSP")),
          `profile-override metric for ${field}`,
        );
      }

      // 3c: agent.created enforceProfileAfterSpawn (label-only profile, as with MCP create_agent)
      const w1 = {
        id: "worker-1",
        title: "Fea2 · worker",
        cwd: CWD,
        provider: "antigravity-cli",
        model: "wrong-gemini",
        modeId: "accept-edits",
        thinkingOptionId: "low",
        labels: { team: "vibesquad", lane: "feat-alpha", role: "worker", profile: "Review - Gemini" },
      };
      agents.set("worker-1", w1);
      await h.onCreated({
        id: "worker-1",
        parentAgentId: "lead-2",
        cwd: CWD,
        provider: "antigravity-cli",
        model: "wrong-gemini",
        modeId: "accept-edits",
        thinkingOptionId: "low",
        labels: { team: "vibesquad", lane: "feat-alpha", role: "worker", profile: "Review - Gemini" },
      });
      assert.deepEqual(h.appliedSettings, [
        { agentId: "worker-1", patch: { model: "gemini-4-argon", modeId: "default", thinkingOptionId: "medium" } },
      ]);

      const m2 = metricTexts(vsHome);
      assert.ok(
        m2.some((t) => t.includes("profile-override") && t.includes("agent=worker-1")),
        "post-spawn profile-override logged",
      );
      assert.ok(
        m2.some((t) => t.startsWith("first-dispatch context:") && t.includes("lead=lead-2")),
        "first-dispatch context metric logged for the parent lead",
      );

      // 3d: provider conflict refusal (Lead - Gemini profile on a claude agent)
      const bad = {
        id: "bad-provider-1",
        title: "LEAD · wrong",
        cwd: CWD,
        provider: "claude",
        model: "claude-sonnet-5-5",
        labels: { team: "vibesquad", lane: "feat-alpha", role: "lead", profile: "Lead - Gemini" },
      };
      agents.set("bad-provider-1", bad);
      await h.onCreated({
        id: "bad-provider-1",
        parentAgentId: "lead-2",
        provider: "claude",
        model: "claude-sonnet-5-5",
        labels: { team: "vibesquad", lane: "feat-alpha", role: "lead", profile: "Lead - Gemini" },
      });
      assert.deepEqual(h.refusedIds, ["bad-provider-1"], "wrong-provider agent refused");
      assert.equal(lead2.labels.role, "lead", "lead-2 NOT retired on a refused spawn");

      const m3 = metricTexts(vsHome);
      assert.ok(
        m3.some((t) => t.includes("field=provider caller=claude profile=antigravity-cli action=refused")),
        "provider refusal metric logged",
      );
    } finally {
      h.stop?.();
    }
  }),
);

// ---------------------------------------------------------------------------
// Stage 4 — Handoff & misroute redirect (former-lead / former-brainstorm)
// ---------------------------------------------------------------------------

test(
  "Stage 4: retired lead/brainstorm redirect agent-messages to the live holder, dedupe, and relay wakeups",
  withEnv(async ({ vsHome, briefRoot }) => {
    const lead1 = {
      id: "lead-1",
      title: "(old) Fea1 · initial setup",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "former-lead", ord: "1" },
    };
    const lead2 = {
      id: "lead-2",
      title: "★ Fea2 · phase two",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "lead", ord: "2" },
    };
    const worker1 = {
      id: "worker-1",
      title: "Fea2 · worker",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "worker" },
    };
    const oldBuddy = {
      id: "buddy-old",
      title: "(old) Fea Buddy",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "former-brainstorm" },
    };
    const liveBuddy = {
      id: "buddy-2",
      title: "Fea Buddy",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "brainstorm" },
    };
    const agents = new Map<string, any>([
      ["lead-1", lead1],
      ["lead-2", lead2],
      ["worker-1", worker1],
      ["buddy-old", oldBuddy],
      ["buddy-2", liveBuddy],
    ]);

    const timelineByAgent = new Map<string, any[]>([
      [
        "lead-1",
        [
          {
            item: {
              type: "user_message",
              messageId: "m-201",
              text: `<paseo-system version="1" kind="agent-message" source-agent-id="worker-1" message-id="m-201" source-agent-title="Fea2 · worker">\nPASS: unit tests green\n</paseo-system>`,
            },
          },
        ],
      ],
      [
        "buddy-old",
        [
          {
            item: {
              type: "user_message",
              messageId: "m-202",
              text: `<paseo-system version="1" kind="agent-message" source-agent-id="worker-1" message-id="m-202" source-agent-title="Fea2 · worker">\nSend this to the buddy\n</paseo-system>`,
            },
          },
        ],
      ],
    ]);

    const h = harness(agents, { briefRoot, timelineByAgent });
    const flush = () => new Promise((r) => setTimeout(r, 5));
    const sentTo = (id: string) => h.sent.filter((s) => s.to === id).map((s) => s.text);

    try {
      // helpers
      assert.equal(retiredHolderRole(lead1), "lead");
      assert.equal(retiredHolderRole(oldBuddy), "brainstorm");
      assert.equal(parseAgentMessageEnvelope(timelineByAgent.get("lead-1")![0].item.text)?.senderId, "worker-1");

      // former-lead misroute
      await h.onTurnStarted(lead1);
      await flush();

      assert.ok(
        sentTo("lead-2").includes(
          "Forwarded by VibeSquad: Fea2 · worker (worker-1) sent this to retired ord1 (lead-1).\n\nPASS: unit tests green",
        ),
        "forwarded to the live lead",
      );
      assert.ok(sentTo("worker-1").includes("ord1 is retired; delivered to ord2"), "sender notified");

      let misroute = readLogEntries(vsHome).filter((e) => e.type === "metric" && e.text.startsWith("misroute-old:")).length;
      assert.equal(misroute, 1, "misroute-old logged once");

      // repeat turn_started with the same messageId is deduped
      await h.onTurnStarted(lead1);
      await flush();
      assert.equal(sentTo("lead-2").length, 1, "no double forward");
      assert.equal(
        readLogEntries(vsHome).filter((e) => e.type === "metric" && e.text.startsWith("misroute-old:")).length,
        1,
        "dedupe does not re-log misroute-old",
      );

      // retired former-brainstorm redirects to the live Lane Buddy
      await h.onTurnStarted(oldBuddy);
      await flush();
      assert.ok(sentTo("buddy-2").some((t) => t.includes("Send this to the buddy")), "forwarded to the live Buddy");
      assert.ok(sentTo("worker-1").some((t) => t.includes("delivered to")), "sender notified for the Buddy redirect");

      // relay on turn_ended of a former lead (or its child): relay-old, not misroute-old
      const misrouteBefore = readLogEntries(vsHome).filter(
        (e) => e.type === "metric" && e.text.startsWith("misroute-old:"),
      ).length;
      await h.onTurnEnded(lead1, { kind: "completed" });
      await wait(60); // debounceMs (20) + settle

      const entries = readLogEntries(vsHome);
      assert.equal(
        entries.filter((e) => e.type === "metric" && e.text.startsWith("relay-old:")).length,
        1,
        "relay-old logged",
      );
      assert.equal(
        entries.filter((e) => e.type === "metric" && e.text.startsWith("misroute-old:")).length,
        misrouteBefore,
        "relay does not increment misroute-old",
      );
      assert.ok(
        sentTo("lead-2").some((t) => t.includes("New team log event in lane feat-alpha: [done] Relayed from former lead")),
        "wakeup delivered to the live lead",
      );
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "Stage 4b: a live lead spawned by a since-retired Buddy does not relay-old to itself; its worker children still do",
  withEnv(async ({ vsHome, briefRoot }) => {
    const oldBuddy = {
      id: "buddy-old",
      title: "(old) Fea Buddy",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "former-brainstorm" },
    };
    const liveLead = {
      id: "lead-9",
      title: "★ Fea9 · live",
      cwd: CWD,
      status: "idle",
      parentAgentId: "buddy-old",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "lead", ord: "9" },
    };
    const orphanWorker = {
      id: "worker-9",
      title: "Fea9 · worker",
      cwd: CWD,
      status: "idle",
      parentAgentId: "buddy-old",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "worker" },
    };
    const agents = new Map<string, any>([
      ["buddy-old", oldBuddy],
      ["lead-9", liveLead],
      ["worker-9", orphanWorker],
    ]);
    const h = harness(agents, { briefRoot, timelineByAgent: new Map() });
    const relays = () => readLogEntries(vsHome).filter((e) => e.type === "metric" && e.text.startsWith("relay-old:"));
    try {
      await h.onTurnEnded(liveLead, { kind: "completed" });
      await wait(60);
      assert.equal(relays().length, 0, "live lead with a retired parent is not a relay source");
      assert.equal(h.sent.filter((s) => s.to === "lead-9" && s.text.includes("Relayed from former lead")).length, 0, "no self-wake");

      await h.onTurnEnded(orphanWorker, { kind: "completed" });
      await wait(60);
      assert.equal(relays().length, 1, "worker under a retired parent still relays");
    } finally {
      h.stop?.();
    }
  }),
);

// ---------------------------------------------------------------------------
// Stage 5 — MCP create_agent title-convention role inference (no labels / VS_ROLE)
// ---------------------------------------------------------------------------

test(
  "MCP create_agent: Lead title convention sets Role: lead + VS_ROLE in before(agent.create)",
  withEnv(async ({ briefRoot }) => {
    const h = harness(new Map(), { briefRoot });
    try {
      const out = await h.beforeCreate({
        config: { cwd: CWD, provider: "antigravity-cli", title: "★ UIP2 · polish modal" },
        env: {},
      });
      assert.match(String(out.config.systemPrompt ?? ""), /Role: lead/);
      assert.equal(out.env.VS_ROLE, "lead");
    } finally {
      h.stop?.();
    }
  }),
);

// ---------------------------------------------------------------------------
// Stage 6 — Failed turn recovery: stream idle timeout retry + checkLeadTokens
// ---------------------------------------------------------------------------

test(
  "Stage 6: stream idle timeout / context deadline exceeded auto-retries and failed turns no longer evaluate lead tokens (token-watch owns it)",
  withEnv(async ({ briefRoot }) => {
    const leadUnder = {
      id: "lead-under",
      title: "★ Bug8 · daemon spawn hang P0",
      cwd: CWD,
      status: "error",
      lastUsage: { contextWindowUsedTokens: 136_117 },
      labels: { team: "vibesquad", lane: "bug-chaser", role: "lead", ord: "8" },
    };
    const leadOverFlag = {
      id: "lead-over-flag",
      title: "★ Fea2 · phase two",
      cwd: CWD,
      status: "error",
      lastUsage: { contextWindowUsedTokens: 175_000 },
      labels: { team: "vibesquad", lane: "feat-alpha", role: "lead", ord: "2" },
    };
    const agents = new Map<string, any>([
      ["lead-under", leadUnder],
      ["lead-over-flag", leadOverFlag],
    ]);
    const h = harness(agents, { briefRoot });
    try {
      await h.onTurnEnded(leadUnder, {
        kind: "failed",
        error: { message: "API error (attempt 1): request failed: stream idle timeout (5m0s): context deadline exceeded" },
      });
      await wait(30);
      assert.ok(
        h.sent.some((s) => s.to === "lead-under" && s.text.includes("transient network error")),
        "stream idle timeout / context deadline exceeded retries the turn",
      );

      await h.onTurnEnded(leadOverFlag, {
        kind: "failed",
        error: { message: "non-transient provider error" },
      });
      assert.equal(leadOverFlag.labels["handoff-flagged"], undefined, "the lead token check moved to server/token-watch.mjs: the plugin does not flag");
    } finally {
      h.stop?.();
    }
  }),
);

// ---------------------------------------------------------------------------
// Stage 6b — A mid-turn stream interruption auto-retries the failed turn
// ---------------------------------------------------------------------------

test(
  "Stage 6b: stream was interrupted auto-retries the failed turn",
  withEnv(async ({ briefRoot }) => {
    const worker = {
      id: "worker-stream",
      title: "★ Bug10 · stream interrupt worker",
      cwd: CWD,
      status: "error",
      labels: { team: "vibesquad", lane: "bug-chaser", role: "worker" },
    };
    const h = harness(new Map([["worker-stream", worker]]), { briefRoot });
    try {
      await h.onTurnEnded(worker, {
        kind: "failed",
        error: {
          message: "[System Error] The stream was interrupted. Please continue the task you were working on.",
        },
      });
      await wait(30);
      assert.ok(
        h.sent.some((s) => s.to === "worker-stream" && s.text.includes("transient network error")),
        "stream was interrupted retries the turn",
      );
    } finally {
      h.stop?.();
    }
  }),
);

// ---------------------------------------------------------------------------
// Stage 7 — A fuzzy profile match never clobbers a caller-specified provider/model
// ---------------------------------------------------------------------------

test(
  "Stage 7: fuzzy role match keeps a caller-specified provider/model even when the default profile's provider is capped",
  withEnv(async ({ briefRoot }) => {
    // claude is capped. The fuzzy role match infers "Lead - Claude" (claude); before the
    // fix, failover promoted that fuzzy match to "Lead - Gemini" (explicit) and overwrote
    // the caller's provider/model. It must now leave them alone.
    const h = harness(new Map(), { briefRoot, cappedProviders: ["claude"] });
    try {
      const opencode = await h.beforeCreate({
        config: {
          cwd: CWD,
          provider: "opencode",
          model: "deepseek/deepseek-flash",
          title: "★ Bug9 · mobile spawn",
        },
        labels: { role: "lead", lane: "bug-chaser" },
      });
      assert.equal(opencode.config.provider, "opencode", "opencode provider preserved on a fuzzy match");
      assert.equal(opencode.config.model, "deepseek/deepseek-flash", "caller model preserved on a fuzzy match");

      // A caller on antigravity-cli (Gemini) is also left alone: its inferred "Lead - Gemini"
      // is healthy, so claude being capped must not redirect it anywhere.
      const agy = await h.beforeCreate({
        config: {
          cwd: CWD,
          provider: "antigravity-cli",
          model: "gemini-3.8-flash",
          title: "★ Bug9 · mobile spawn 2",
        },
        labels: { role: "lead", lane: "bug-chaser" },
      });
      assert.equal(agy.config.provider, "antigravity-cli", "antigravity-cli provider preserved on a fuzzy match");
      assert.equal(agy.config.model, "gemini-3.8-flash", "caller model preserved on a fuzzy match");
    } finally {
      h.stop?.();
    }
  }),
);

// ---------------------------------------------------------------------------
// Stage 8 — flushWake guards a running/vanished Lead and coalesces wakeups
// ---------------------------------------------------------------------------

test(
  "Stage 8a: flushWake holds when snap() reports a running Lead mid-race and a single turn_ended flushes it",
  withEnv(async ({ briefRoot }) => {
    const lead = {
      id: "lead-2",
      title: "★ Fea2 · phase two",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "lead", ord: "2" },
    };
    const former = {
      id: "lead-1",
      title: "(old) Fea1 · initial setup",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "former-lead", ord: "1" },
    };
    // Simulate the race: dispatchWakes sees the lead idle in list(), but flushWake's
    // snap() (refresh) reports "running" (e.g. notifyOnFinish just woke it).
    let snapStatus: string | null | undefined = "running";
    const h = harness(
      new Map<string, any>([
        ["lead-2", lead],
        ["lead-1", former],
      ]),
      { briefRoot, leadWakeCooldownMs: 200, snapStatusOverride: (id) => (id === "lead-2" ? snapStatus : undefined) },
    );
    const wakeCount = () => h.sent.filter((s) => s.to === "lead-2" && s.text.includes("New team log event")).length;
    try {
      // Relay a `done` entry; dispatchWakes sees idle, but snap() reports running.
      await h.onTurnEnded(former, { kind: "completed" });
      await wait(40); // debounce (20) fires dispatchWakes -> flushWake sees "running" and holds
      assert.equal(wakeCount(), 0, "no wakeup sent into a running lead");

      // The lead finishes: snap is now idle and a single turn_ended flushes the held entry.
      snapStatus = undefined;
      await h.onTurnEnded(lead, { kind: "completed" });
      await wait(60); // flushWake send settles
      assert.equal(wakeCount(), 1, "a single turn_ended flushed the held entry");

      // The deferred re-check timer (if any) must not double-send.
      await wait(250);
      assert.equal(wakeCount(), 1, "no duplicate wakeup after the re-check window");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "Stage 8b: wakeups arriving within the cooldown window are coalesced into a single send",
  withEnv(async ({ briefRoot }) => {
    const lead = {
      id: "lead-2",
      title: "★ Fea2 · phase two",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "lead", ord: "2" },
    };
    const former1 = {
      id: "lead-1",
      title: "(old) Fea1 · first",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "former-lead", ord: "1" },
    };
    const former2 = {
      id: "lead-0",
      title: "(old) Fea0 · second",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "former-lead", ord: "0" },
    };
    const h = harness(
      new Map<string, any>([
        ["lead-2", lead],
        ["lead-1", former1],
        ["lead-0", former2],
      ]),
      { briefRoot, leadWakeCooldownMs: 300 },
    );
    const wakeCount = () => h.sent.filter((s) => s.to === "lead-2" && s.text.includes("New team log event")).length;
    try {
      // The Lead starts a turn, opening the cooldown window.
      await h.onTurnStarted(lead);

      // Two relays land in separate debounce batches but within the same cooldown window.
      await h.onTurnEnded(former1, { kind: "completed" });
      await wait(40); // former1's dispatch already fired and deferred within the cooldown
      await h.onTurnEnded(former2, { kind: "completed" });
      await wait(500); // cooldown (300) + settle

      assert.equal(wakeCount(), 1, "both entries coalesced into a single wakeup");
      assert.ok(
        h.sent.some((s) => s.to === "lead-2" && s.text.includes("(+1 more)")),
        "the single wakeup reports the coalesced extra entry",
      );
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "Stage 8c: flushWake holds the queue on a null snapshot and never sends into a vanished lead",
  withEnv(async ({ briefRoot }) => {
    const lead = {
      id: "lead-2",
      title: "★ Fea2 · phase two",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "lead", ord: "2" },
    };
    const former = {
      id: "lead-1",
      title: "(old) Fea1 · initial setup",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "former-lead", ord: "1" },
    };
    // snap() reports a vanished/archived lead (null snapshot).
    let snapStatus: string | null | undefined = null;
    const h = harness(
      new Map<string, any>([
        ["lead-2", lead],
        ["lead-1", former],
      ]),
      { briefRoot, leadWakeCooldownMs: 200, snapStatusOverride: (id) => (id === "lead-2" ? snapStatus : undefined) },
    );
    const wakeCount = () => h.sent.filter((s) => s.to === "lead-2" && s.text.includes("New team log event")).length;
    try {
      await h.onTurnEnded(former, { kind: "completed" });
      await wait(60); // dispatchWakes -> flushWake sees a null snapshot and bails (keeps the queue)
      assert.equal(wakeCount(), 0, "never sends on a null snapshot");

      // Once the lead is visible again, a single turn_ended flushes the held entry.
      snapStatus = undefined;
      await h.onTurnEnded(lead, { kind: "completed" });
      await wait(60);
      assert.equal(wakeCount(), 1, "held entry flushed once the lead reappeared");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "Stage 8d: a retired lead's held wakeups are re-routed to the current lead, never sent to the retired one",
  withEnv(async ({ briefRoot }) => {
    const lead2 = {
      id: "lead-2",
      title: "★ Fea2 · phase two",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "lead", ord: "2" },
    };
    const former = {
      id: "lead-1",
      title: "(old) Fea1 · initial setup",
      cwd: CWD,
      status: "idle",
      labels: { team: "vibesquad", lane: "feat-alpha", role: "former-lead", ord: "1" },
    };
    const agents = new Map<string, any>([
      ["lead-2", lead2],
      ["lead-1", former],
    ]);
    // While the lead is "running" (held), it gets retired and a new lead takes over.
    let snapStatus: string | null | undefined = "running";
    const h = harness(agents, {
      briefRoot,
      leadWakeCooldownMs: 100,
      snapStatusOverride: (id) => (id === "lead-2" ? snapStatus : undefined),
    });
    const wakeTo = (id: string) => h.sent.filter((s) => s.to === id && s.text.includes("New team log event")).length;
    try {
      // Queue a relay `done` entry into lead-2's pendingWake, held because snap reports "running".
      await h.onTurnEnded(former, { kind: "completed" });
      await wait(40); // dispatchWakes -> flushWake holds (running) and schedules one re-check
      assert.equal(wakeTo("lead-2"), 0, "held entry is not yet sent");

      // lead-2 is retired; a new lead-3 takes its place.
      lead2.labels.role = "former-lead";
      agents.set("lead-3", {
        id: "lead-3",
        title: "★ Fea3 · phase three",
        cwd: CWD,
        status: "idle",
        labels: { team: "vibesquad", lane: "feat-alpha", role: "lead", ord: "3" },
      });
      snapStatus = undefined;

      // The re-check fires: flushWake sees a retired lead and re-routes to lead-3.
      await wait(300); // re-check (100) + re-dispatch debounce (20) + settle

      assert.equal(wakeTo("lead-2"), 0, "never sent to the retired lead");
      assert.equal(wakeTo("lead-3"), 1, "held entry re-routed to the current lead");
    } finally {
      h.stop?.();
    }
  }),
);

// ---------------------------------------------------------------------------
// Stage 9 — vs cap { capped: ... } unwrap + turn-1 enforceProfileAfterSpawn guard
// ---------------------------------------------------------------------------

test(
  "Stage 9a: normalizeCappedProviders unwraps { capped: { claude: ... } } and fails over Brainstorm - Claude to Brainstorm - Gemini",
  withEnv(async ({ briefRoot }) => {
    const h = harness(new Map(), {
      briefRoot,
      cappedProviders: { capped: { claude: { reason: "cli cap", updatedAt: "2026-11-05T00:00:00Z" } } },
    });
    try {
      const out = await h.beforeCreate({
        config: {
          cwd: CWD,
          provider: "claude",
          model: "claude-opus-5-5",
          title: "RiffBot",
        },
        labels: { role: "brainstorm", lane: "vibesquad", profile: "Brainstorm - Claude" },
        env: { VS_PROFILE: "Brainstorm - Claude" },
      });
      assert.equal(out.config.provider, "antigravity-cli", "provider failed over to antigravity-cli");
      assert.equal(out.config.model, "gemini-4-argon", "model failed over to gemini-4-argon");
      assert.equal(out.labels?.profile, "Brainstorm - Gemini", "profile label updated to Brainstorm - Gemini");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "Stage 9b: enforceProfileAfterSpawn does not call applyAgentSettings when before(agent.create) already configured the spawn or when status is running on turn 1",
  withEnv(async ({ briefRoot }) => {
    const agents = new Map<string, any>();
    const h = harness(agents, { briefRoot });
    try {
      // Case 1: before(agent.create) matched an explicit profile; onCreated sees thinkingOptionId: null
      const req = await h.beforeCreate({
        config: {
          cwd: CWD,
          provider: "antigravity-cli",
          model: "gemini-4-argon",
          title: "RiffBot",
        },
        labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm", profile: "Brainstorm - Gemini" },
        env: { VS_PROFILE: "Brainstorm - Gemini" },
      });
      assert.equal(req.config.thinkingOptionId, "medium");

      const spawned1 = {
        id: "riff-1",
        title: "RiffBot",
        cwd: CWD,
        status: "idle",
        provider: "antigravity-cli",
        model: "gemini-4-argon",
        modeId: "accept-edits",
        thinkingOptionId: null,
        labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm", profile: "Brainstorm - Gemini" },
      };
      agents.set("riff-1", spawned1);
      await h.onCreated(spawned1);
      assert.deepEqual(h.appliedSettings, [], "applyAgentSettings skipped when before(agent.create) already configured the spawn");

      // Case 2: label-only spawn (no beforeCreate call), but status === "running" with thinkingOptionId: null on initial snapshot
      const spawnedRunning = {
        id: "riff-running",
        title: "Fea Buddy",
        cwd: CWD,
        status: "running",
        provider: "antigravity-cli",
        model: "gemini-4-argon",
        modeId: "accept-edits",
        thinkingOptionId: null,
        labels: { team: "vibesquad", lane: "feat-alpha", role: "brainstorm", profile: "Brainstorm - Gemini" },
      };
      agents.set("riff-running", spawnedRunning);
      await h.onCreated(spawnedRunning);
      assert.deepEqual(h.appliedSettings, [], "applyAgentSettings skipped while status === running on initial snapshot");
    } finally {
      h.stop?.();
    }
  }),
);

// ---------------------------------------------------------------------------
// R5 — workers close on done; failover relabels the profile for the new provider
// ---------------------------------------------------------------------------

test(
  "R5: a worker that files a done report is archived when its turn ends; leads and workers without a report are not",
  withEnv(async ({ vsHome, briefRoot }) => {
    const mk = (id: string, role: string, extra: any = {}) => ({
      id, title: id, cwd: CWD, status: "idle", provider: "claude", model: "claude-opus-5-5",
      labels: { team: "vibesquad", lane: "vibesquad", role, ...extra },
    });
    const agents = new Map<string, any>([
      ["w-done", mk("w-done", "worker")],
      ["w-quiet", mk("w-quiet", "worker")],
      ["lead-1", mk("lead-1", "lead", { lead: "vibesquad" })],
    ]);
    const h = harness(agents, { briefRoot });
    try {
      const file = join(vsHome, "teams", "vibesquad", "log.jsonl");
      mkdirSync(join(vsHome, "teams", "vibesquad"), { recursive: true });
      const line = (o: any) => JSON.stringify({ ts: new Date().toISOString(), lane: "vibesquad", ...o }) + "\n";
      writeFileSync(file, line({ agent: "w-done", type: "done", text: "PASS: shipped", refs: [] }) + line({ agent: "lead-1", type: "done", text: "lane done", refs: [] }), "utf8");
      h.scanLogs(false);
      await h.onTurnEnded(agents.get("w-done"));
      await h.onTurnEnded(agents.get("w-quiet"));
      await h.onTurnEnded(agents.get("lead-1"));
      assert.deepEqual(h.archivedIds, ["w-done"], "only the reporting worker is archived");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "R5: a digest verdict (done filed by the digest agent against the worker's id in refs) closes the worker after the grace period",
  withEnv(async ({ vsHome, briefRoot }) => {
    const agents = new Map<string, any>([
      ["w-1", { id: "w-1", title: "w-1", cwd: CWD, status: "idle", provider: "claude", model: "claude-opus-5-5", labels: { team: "vibesquad", lane: "vibesquad", role: "worker" } }],
    ]);
    const h = harness(agents, { briefRoot });
    try {
      mkdirSync(join(vsHome, "teams", "vibesquad"), { recursive: true });
      await h.onTurnEnded(agents.get("w-1")); // gives the plugin its paseo handle; no report yet -> stays
      assert.deepEqual(h.archivedIds, []);
      writeFileSync(join(vsHome, "teams", "vibesquad", "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), agent: "digest-9", lane: "vibesquad", type: "done", text: "PASS", refs: ["w-1"] }) + "\n", "utf8");
      h.scanLogs(false);
      await wait(3300);
      assert.deepEqual(h.archivedIds, ["w-1"]);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "B1: the done sweep archives only long-done, merged, non-FAIL idle/closed workers; never leads, Buddies, running or in-grace workers",
  withEnv(async ({ vsHome, briefRoot }) => {
    const mk = (id: string, role: string, extra: any = {}, status = "idle") => ({
      id, title: id, cwd: id === "w-unmerged" ? "/unmerged" : CWD, status, provider: "claude", model: "claude-opus-5-5", resumable: true,
      labels: { team: "vibesquad", lane: "vibesquad", role, ...extra },
    });
    const agents = new Map<string, any>([
      ["w-old", mk("w-old", "worker", {}, "closed")],
      ["w-old-idle", mk("w-old-idle", "worker")],
      ["w-running", mk("w-running", "worker", {}, "running")],
      ["w-fresh", mk("w-fresh", "worker")],
      ["w-fail", mk("w-fail", "worker")],
      ["w-unmerged", mk("w-unmerged", "worker")],
      ["lead-1", mk("lead-1", "lead", { lead: "vibesquad" })],
      ["buddy-1", mk("buddy-1", "brainstorm")],
    ]);
    const h = harness(agents, {
      briefRoot,
      unitBranchState: async (cwd) => (cwd === "/unmerged" ? { unit: "unit-x", merged: false } : { unit: "unit-ok", merged: true }),
    });
    try {
      mkdirSync(join(vsHome, "teams", "vibesquad"), { recursive: true });
      const now = Date.now();
      const line = (id: string, text: string, ageMin: number) =>
        JSON.stringify({ ts: new Date(now - ageMin * 60_000).toISOString(), agent: id, lane: "vibesquad", type: "done", text, refs: [] }) + "\n";
      const file = join(vsHome, "teams", "vibesquad", "log.jsonl");
      await h.onTurnEnded(agents.get("lead-1")); // hands the plugin its paseo handle; scanLogs below stays baseline-free (history)
      writeFileSync(
        file,
        ["w-old", "w-old-idle", "w-running", "lead-1", "buddy-1", "w-unmerged"].map((id) => line(id, "PASS: shipped", 45)).join("") +
          line("w-fresh", "PASS: shipped", 5) +
          line("w-fail", "FAIL: tests red", 90),
        "utf8",
      );
      const archived = await h.sweepDoneWorkers(now);
      assert.deepEqual(archived.sort(), ["w-old", "w-old-idle"]);
      assert.deepEqual(h.archivedIds.sort(), ["w-old", "w-old-idle"]);
      const metrics = readFileSync(file, "utf8").split("\n").filter((l) => l.includes("worker-auto-archive"));
      assert.equal(metrics.length, 2);
      assert.ok(metrics.some((l) => l.includes("worker-auto-archive id=w-old unit=unit-ok")));
      assert.deepEqual(await h.sweepDoneWorkers(now), [], "archived workers are not archived twice");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "R5: failover relabels env VS_PROFILE and config labels, not just request labels",
  withEnv(async ({ briefRoot }) => {
    const h = harness(new Map(), { briefRoot, cappedProviders: { claude: { reason: "cap" } } });
    try {
      const out = await h.beforeCreate({
        config: { cwd: CWD, provider: "claude", model: "claude-opus-5-5", title: "RiffBot", labels: { role: "brainstorm", lane: "vibesquad", profile: "Brainstorm - Claude" } },
        env: { VS_PROFILE: "Brainstorm - Claude", VS_ROLE: "brainstorm" },
      });
      assert.equal(out.config.provider, "antigravity-cli");
      assert.equal(out.env?.VS_PROFILE, "Brainstorm - Gemini");
      assert.equal(out.config.labels?.profile, "Brainstorm - Gemini");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "R5 review: a failover spawn whose labels Paseo omitted is relabelled at agent.created, not refused",
  withEnv(async ({ briefRoot }) => {
    const agents = new Map<string, any>();
    const h = harness(agents, { briefRoot, cappedProviders: { claude: { reason: "cap" } } });
    try {
      const out = await h.beforeCreate({
        config: { cwd: CWD, provider: "claude", model: "claude-opus-5-5", title: "RiffBot" },
        env: { VS_PROFILE: "Brainstorm - Claude", VS_ROLE: "brainstorm", VS_LANE: "vibesquad" },
      });
      assert.equal(out.config.provider, "antigravity-cli", "failed over");
      // Paseo created the agent with the ORIGINAL (capped) profile label, on the failed-over provider.
      const agent = {
        id: "riff-fo", title: "RiffBot", cwd: CWD, status: "idle", provider: "antigravity-cli", model: out.config.model,
        modeId: out.config.modeId, currentModeId: out.config.modeId, thinkingOptionId: out.config.thinkingOptionId,
        labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm", profile: "Brainstorm - Claude" },
      };
      agents.set(agent.id, agent);
      await h.onCreated(agent);
      assert.deepEqual(h.refusedIds, [], "failover agent is not refused");
      assert.equal(agents.get("riff-fo").labels.profile, "Brainstorm - Gemini", "profile label follows the provider");
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "R5 review: auto-archive re-checks status + permissions, turn_started clears the mark, and the marker keeps the worker out of the retired-holder redirect",
  withEnv(async ({ vsHome, briefRoot }) => {
    const w: any = { id: "w-9", title: "w-9", cwd: CWD, status: "idle", provider: "claude", model: "claude-opus-5-5", labels: { team: "vibesquad", lane: "vibesquad", role: "worker" } };
    const agents = new Map<string, any>([["w-9", w]]);
    const h = harness(agents, { briefRoot });
    try {
      mkdirSync(join(vsHome, "teams", "vibesquad"), { recursive: true });
      const file = join(vsHome, "teams", "vibesquad", "log.jsonl");
      const report = () => {
        writeFileSync(file, JSON.stringify({ ts: new Date().toISOString(), agent: "w-9", lane: "vibesquad", type: "done", text: "PASS", refs: [] }) + "\n", { encoding: "utf8", flag: "a" });
        h.scanLogs(false);
      };
      report();
      w.status = "running"; // a fast follow-up started while the digest was awaited
      await h.onTurnEnded(w);
      assert.deepEqual(h.archivedIds, [], "running agent is never archived");
      w.status = "idle";
      w.pendingPermissions = [{ id: "p1" }];
      await h.onTurnEnded(w);
      assert.deepEqual(h.archivedIds, [], "pending permission blocks the archive");
      w.pendingPermissions = [];
      await h.onTurnStarted(w); // new turn after the report clears the mark
      await h.onTurnEnded(w);
      assert.deepEqual(h.archivedIds, [], "mark cleared by turn_started");
      report();
      await h.onTurnEnded(w);
      assert.deepEqual(h.archivedIds, ["w-9"]);
      assert.equal(w.labels["vs.auto-archived"], "1", "marker set before archive");
      // handleSendAgentPrompt: an auto-archived worker is not a retired holder (no redirect, no throw).
      assert.equal(await h.beforeSend({ agentId: "w-9", senderAgentId: "lead-x", prompt: "more" }), undefined);
      // The same archived agent WITHOUT the marker is still treated as retired (no live lead -> throws).
      delete w.labels["vs.auto-archived"];
      await assert.rejects(() => h.beforeSend({ agentId: "w-9", senderAgentId: "lead-x", prompt: "more" }), /retired/);
    } finally {
      h.stop?.();
    }
  }),
);

// ---------------------------------------------------------------------------
// B1 review R1 — default to keep
// ---------------------------------------------------------------------------

test(
  "B1 R1: the sweep needs an explicit role=worker; missing, empty, overlord and reviewer roles are kept",
  withEnv(async ({ vsHome, briefRoot }) => {
    const mk = (id: string, labels: Record<string, string>) => ({
      id, title: id, cwd: CWD, status: "idle", provider: "claude", model: "claude-opus-5-5", resumable: true,
      labels: { team: "vibesquad", lane: "vibesquad", ...labels },
    });
    const agents = new Map<string, any>([
      ["w-ok", mk("w-ok", { role: "worker" })],
      ["no-role", mk("no-role", {})],
      ["empty-role", mk("empty-role", { role: "" })],
      ["overlord", mk("overlord", { role: "overlord" })],
      ["reviewer", mk("reviewer", { role: "reviewer" })],
      ["lead-1", mk("lead-1", { role: "lead", lead: "vibesquad" })],
    ]);
    const h = harness(agents, { briefRoot, unitBranchState: async () => ({ unit: "u", merged: true }) });
    try {
      mkdirSync(join(vsHome, "teams", "vibesquad"), { recursive: true });
      const now = Date.now();
      const line = (id: string) => JSON.stringify({ ts: new Date(now - 60 * 60_000).toISOString(), agent: id, lane: "vibesquad", type: "done", text: "PASS", refs: [] }) + "\n";
      await h.onTurnEnded(agents.get("lead-1"));
      writeFileSync(join(vsHome, "teams", "vibesquad", "log.jsonl"), [...agents.keys()].map(line).join(""), "utf8");
      assert.deepEqual(await h.sweepDoneWorkers(now), ["w-ok"]);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "B1 R1: only the worker's own done counts; another author's ref is not its report, a digest FAIL verdict keeps it, git state is read once per cwd",
  withEnv(async ({ vsHome, briefRoot }) => {
    const mk = (id: string, cwd = CWD) => ({
      id, title: id, cwd, status: "idle", provider: "claude", model: "claude-opus-5-5", resumable: true,
      labels: { team: "vibesquad", lane: "vibesquad", role: "worker" },
    });
    const agents = new Map<string, any>([
      ["w-ref-only", mk("w-ref-only")],
      ["w-digest-fail", mk("w-digest-fail")],
      ["w-ok-1", mk("w-ok-1")],
      ["w-ok-2", mk("w-ok-2")],
      ["lead-1", { ...mk("lead-1"), labels: { team: "vibesquad", lane: "vibesquad", role: "lead", lead: "vibesquad" } }],
    ]);
    const calls: Array<string | undefined> = [];
    const h = harness(agents, { briefRoot, unitBranchState: async (cwd) => (calls.push(cwd), { unit: "u", merged: true }) });
    try {
      mkdirSync(join(vsHome, "teams", "vibesquad"), { recursive: true });
      const now = Date.now();
      const ts = (min: number) => new Date(now - min * 60_000).toISOString();
      const line = (agent: string, text: string, min: number, refs: string[] = []) =>
        JSON.stringify({ ts: ts(min), agent, lane: "vibesquad", type: "done", text, refs }) + "\n";
      await h.onTurnEnded(agents.get("lead-1"));
      writeFileSync(
        join(vsHome, "teams", "vibesquad", "log.jsonl"),
        line("lead-1", "PASS: lane note", 60, ["w-ref-only"]) +
          line("w-digest-fail", "PASS: shipped", 90) +
          line("digest-9", "FAIL: regression", 60, ["w-digest-fail"]) +
          line("w-ok-1", "PASS", 60) +
          line("w-ok-2", "PASS", 60),
        "utf8",
      );
      assert.deepEqual((await h.sweepDoneWorkers(now)).sort(), ["w-ok-1", "w-ok-2"]);
      assert.equal(calls.length, 1, "same cwd: one git lookup per sweep");
    } finally {
      h.stop?.();
    }
  }),
);

test("B1 R1: gitUnitBranchState keeps (merged:false) on every unknown; merged:true only for a named branch contained in master", async () => {
  const root = mkdtempSync(join(tmpdir(), "vs-b1-git-"));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });
  try {
    assert.deepEqual(await gitUnitBranchState(undefined), { unit: "", merged: false }, "no cwd");
    assert.deepEqual(await gitUnitBranchState(join(root, "missing")), { unit: "", merged: false }, "cwd absent");
    const plain = join(root, "plain");
    mkdirSync(plain);
    assert.equal((await gitUnitBranchState(plain)).merged, false, "not a repo");
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "master");
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "a");
    assert.equal((await gitUnitBranchState(repo)).merged, false, "on master");
    git(repo, "checkout", "-q", "-b", "unit-merged");
    assert.deepEqual(await gitUnitBranchState(repo), { unit: "unit-merged", merged: true }, "named branch contained in master");
    git(repo, "checkout", "-q", "-b", "unit-open");
    writeFileSync(join(repo, "b.txt"), "b");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "b");
    assert.deepEqual(await gitUnitBranchState(repo), { unit: "unit-open", merged: false }, "unmerged branch");
    git(repo, "checkout", "-q", "--detach");
    assert.equal((await gitUnitBranchState(repo)).merged, false, "detached HEAD");
    const nobase = join(root, "nobase");
    mkdirSync(nobase);
    git(nobase, "init", "-q", "-b", "trunk");
    writeFileSync(join(nobase, "a.txt"), "a");
    git(nobase, "add", ".");
    git(nobase, "commit", "-q", "-m", "a");
    git(nobase, "checkout", "-q", "-b", "unit-z");
    assert.equal((await gitUnitBranchState(nobase)).merged, false, "no master/main base branch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "B1 R2: digest verdicts (agent=digest, refs=[worker]) govern grace and FAIL; the newest wins; a lead decision that refs the worker does not count",
  withEnv(async ({ vsHome, briefRoot }) => {
    const base = { cwd: CWD, status: "idle", provider: "claude", model: "claude-opus-5-5", resumable: true };
    const mkW = (id: string) => ({ id, title: id, ...base, labels: { team: "vibesquad", lane: "vibesquad", role: "worker" } });
    const agents = new Map<string, any>([
      ...["w-pass", "w-fail", "w-reset", "w-lead-ref", "w-unv-fail", "w-unv-pass"].map((id) => [id, mkW(id)] as [string, any]),
      ["digest-1", { id: "digest-1", title: "digest-1", ...base, labels: { team: "vibesquad", lane: "vibesquad", role: "digest", digestFor: "x" } }],
      ["lead-1", { id: "lead-1", title: "lead-1", ...base, labels: { team: "vibesquad", lane: "vibesquad", role: "lead", lead: "vibesquad" } }],
    ]);
    const h = harness(agents, { briefRoot, unitBranchState: async () => ({ unit: "u", merged: true }) });
    try {
      mkdirSync(join(vsHome, "teams", "vibesquad"), { recursive: true });
      const now = Date.now();
      const line = (agent: string, text: string, min: number, refs: string[]) =>
        JSON.stringify({ ts: new Date(now - min * 60_000).toISOString(), agent, lane: "vibesquad", type: "done", text, refs }) + "\n";
      await h.onTurnEnded(agents.get("lead-1"));
      writeFileSync(
        join(vsHome, "teams", "vibesquad", "log.jsonl"),
        line("digest-1", "PASS: shipped", 45, ["w-pass"]) +
          line("digest-1", "FAIL: tests red", 45, ["w-fail"]) +
          line("digest-1", "PASS: first", 90, ["w-reset"]) +
          line("digest-1", "PASS: fix round", 5, ["w-reset"]) + // newer digest inside the grace window resets it
          line("lead-1", "PASS: decision", 60, ["w-lead-ref"]) + // lead decision refs the worker: not its report
          line("digest-9", "UNVERIFIED (digest failed): FAIL", 60, ["w-unv-fail"]) +
          line("digest-9", "UNVERIFIED (digest failed): PASS", 60, ["w-unv-pass"]),
        "utf8",
      );
      assert.deepEqual((await h.sweepDoneWorkers(now)).sort(), ["w-pass", "w-unv-pass"]);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "unit-digest-running: spawnDigest skips a running/queued worker (retries on next idle) and turn_started archives an in-flight digest via fast path",
  withEnv(async ({ briefRoot }) => {
    const w: any = {
      id: "w-run",
      title: "Bug12 · click audit",
      cwd: CWD,
      status: "running",
      provider: "antigravity-cli",
      model: "gemini-4-argon",
      labels: { team: "vibesquad", lane: "bug-chaser", role: "worker", job: "click audit" },
    };
    const agents = new Map<string, any>([["w-run", w]]);
    const createdDigests: any[] = [];
    const finishResolvers: (() => void)[] = [];
    const h = harness(agents, { briefRoot });
    let listCalls = 0;
    const origList = (h.paseo.agents as any).list.bind(h.paseo.agents);
    (h.paseo.agents as any).list = async (...args: any[]) => {
      listCalls++;
      return origList(...args);
    };
    (h.paseo.agents as any).create = async (payload: any) => {
      const id = `dig-${createdDigests.length + 1}`;
      const d = { id, ...payload, status: "initializing", queued: { ahead: 1 }, archivedAt: null };
      createdDigests.push(d);
      agents.set(id, d);
      return {
        id,
        agent: d,
        waitForFinish: () => new Promise<void>((r) => finishResolvers.push(r)),
      };
    };
    try {
      // 0. turn_started when no digest is tracked takes the fast path without calling paseo.agents.list
      const listBefore = listCalls;
      await h.onTurnStarted(w);
      await wait(20);
      assert.equal(listCalls, listBefore, "turn_started without a tracked digest does not call paseo.agents.list");

      // 1. turn_ended while worker is still running -> skipped, digested not marked
      await h.onTurnEnded(w);
      assert.equal(createdDigests.length, 0, "no digest created while worker is running");

      // 2. turn_ended while worker is queued/initializing -> skipped
      w.status = "initializing";
      w.queued = { ahead: 2 };
      await h.onTurnEnded(w);
      assert.equal(createdDigests.length, 0, "no digest created while worker is queued");

      // 3. worker finishes its turn (status idle) -> digest spawns with same turnId (not blocked by earlier skip)
      delete w.queued;
      w.status = "idle";
      await h.onTurnEnded(w);
      assert.equal(createdDigests.length, 1, "digest created once worker is idle");
      assert.ok(
        String(createdDigests[0].prompt).includes("If the worker is currently running or queued"),
        "digest prompt instructs to log nothing if worker is running or queued",
      );

      // 4. (M2) Even in the same epoch after dig-1 finishes, if a busy turn_ended is skipped, the next real idle still digests
      finishResolvers.shift()?.();
      await wait(20);
      w.status = "running";
      await h.onTurnEnded(w);
      assert.equal(createdDigests.length, 1, "busy turn_ended skipped");
      w.status = "idle";
      await h.onTurnEnded(w);
      assert.equal(createdDigests.length, 2, "next real idle after busy guard skip spawns a new digest");

      // 5. worker starts a new turn while dig-2 is still queued/running -> dig-2 is archived directly without listing
      const listBeforeCancel = listCalls;
      w.status = "running";
      await h.onTurnStarted(w);
      await wait(20);
      assert.ok(h.archivedIds.includes("dig-2") || createdDigests[1].archivedAt, "stale in-flight digest archived on worker turn_started");
      assert.equal(listCalls, listBeforeCancel, "tracked digest archived directly without calling paseo.agents.list");

// ---------------------------------------------------------------------------
// B3 — one-time sweep: dry run lists, apply archives exactly that set (same predicate)
// ---------------------------------------------------------------------------

test(
  "B3: dry run archives nothing and groups would-archive per Squad/lane plus kept by reason; apply archives exactly the dry-run set",
  withEnv(async ({ vsHome, briefRoot }) => {
    const mk = (id: string, over: Record<string, any> = {}, labels: Record<string, string> = {}) => ({
      id, title: id, cwd: `/repo/${id}`, status: "idle", provider: "claude", model: "claude-opus-5-5", resumable: true,
      labels: { team: "vibesquad", lane: "vibesquad", role: "worker", ...labels }, ...over,
    });
    const agents = new Map<string, any>([
      ["w-ok", mk("w-ok")],
      ["w-ok-other-lane", mk("w-ok-other-lane", {}, { lane: "bug-chaser" })],
      ["w-fail", mk("w-fail")],
      ["w-unmerged", mk("w-unmerged")],
      ["w-unknown", mk("w-unknown")],
      ["w-grace", mk("w-grace")],
      ["w-running", mk("w-running", { status: "running" })],
      ["lead-1", mk("lead-1", {}, { role: "lead", lead: "vibesquad" })],
    ]);
    const branch = async (cwd?: string) =>
      cwd === "/repo/w-unmerged" ? { unit: "u", merged: false } : cwd === "/repo/w-unknown" ? { unit: "", merged: false } : { unit: "u", merged: true };
    const h = harness(agents, { briefRoot, unitBranchState: branch });
    try {
      mkdirSync(join(vsHome, "teams", "vibesquad"), { recursive: true });
      const now = Date.now();
      const line = (agent: string, text: string, min: number) =>
        JSON.stringify({ ts: new Date(now - min * 60_000).toISOString(), agent, lane: "vibesquad", type: "done", text, refs: [] }) + "\n";
      await h.onTurnEnded(agents.get("lead-1"));
      writeFileSync(
        join(vsHome, "teams", "vibesquad", "log.jsonl"),
        ["w-ok", "w-ok-other-lane", "w-unmerged", "w-unknown"].map((id) => line(id, "PASS", 60)).join("") +
          line("w-fail", "FAIL: broke", 60) + line("w-grace", "PASS", 5) + line("w-running", "PASS", 60),
        "utf8",
      );
      const dry = await h.sweepDoneWorkersReport({ now });
      assert.equal(dry.dryRun, true);
      assert.deepEqual(h.archivedIds, [], "dry run makes no archive calls");
      assert.equal(agents.get("w-ok").labels["vs.auto-archived"], undefined, "dry run sets no marker");
      assert.equal(dry.count, 2);
      assert.deepEqual(dry.archive.map((i: any) => i.id).sort(), ["w-ok", "w-ok-other-lane"]);
      assert.deepEqual(dry.byLane, { vibesquad: { vibesquad: ["w-ok"], "bug-chaser": ["w-ok-other-lane"] } });
      const ids = (r: string) => dry.kept[r].map((i: any) => i.id);
      assert.deepEqual(ids("fail"), ["w-fail"]);
      assert.deepEqual(ids("unmerged"), ["w-unmerged"]);
      assert.deepEqual(ids("unknown-branch"), ["w-unknown"]);
      assert.deepEqual(ids("in-grace"), ["w-grace"]);
      assert.deepEqual(ids("not-idle"), ["w-running"]);
      assert.deepEqual(ids("not-worker"), ["lead-1"]);

      const applied = await h.sweepDoneWorkersReport({ apply: true, now });
      assert.equal(applied.dryRun, false);
      assert.deepEqual(h.archivedIds.slice().sort(), dry.archive.map((i: any) => i.id).sort(), "apply archives exactly the dry-run set");
      assert.equal(agents.get("w-ok").labels["vs.auto-archived"], "1");
    } finally {
      h.stop?.();
    }
  }),
);
