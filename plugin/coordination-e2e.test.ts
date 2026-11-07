import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createPlugin,
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
} from "./index.server.ts";
import type { AgentSettingsPatch } from "./index.server.ts";

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
          async archive() {},
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
    async beforeCreate(req: any) {
      return (await before.get("agent.create")!({ request: req })) ?? req;
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
  "Stage 2: a Lane Buddy's handoff spawn auto-assigns team/ord, detaches the new lead, and retires the predecessor",
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
      assert.ok(h.detachedIds.includes("lead-2"), "new lead detached from its Buddy parent");

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
      assert.equal(agy.config.modeId, "accept-edits");

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
  "Stage 6: stream idle timeout / context deadline exceeded auto-retries and failed turns still evaluate checkLeadTokens",
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
      assert.equal(leadOverFlag.labels["handoff-flagged"], "1", "failed turn still flags lead over 150k tokens");
      assert.ok(leadOverFlag.labels["needs-you"]?.includes("150k"), "failed turn sets needs-you on lead over 150k tokens");
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
