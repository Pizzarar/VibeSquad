import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlugin, keptLaneOf, snapshotIntoBrief } from "../plugin/index.server.ts";
import { isThrowawayLane, laneLeadMismatch } from "../server/identity.mjs";

const CWD = "/projects/VibeSquad";
const BRIEF = "# Brainstorm Summary · VIBESQUAD\n\n## Who's here\n- (VS)\n\n## Done when\n- ship\n\n## Decided\n- d1\n\n## In flight\n- block A\n\n## Open\n- none\n";

function withEnv(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "vs-buddy-retire-test-"));
    const vsHome = join(dir, ".vibesquad");
    const briefRoot = join(dir, "repo");
    mkdirSync(vsHome, { recursive: true });
    mkdirSync(join(briefRoot, "docs", "brainstorm"), { recursive: true });
    const teamsFile = join(vsHome, "teams.json");
    writeFileSync(
      teamsFile,
      JSON.stringify({
        teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", name: "VibeSquad", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }],
      }),
      "utf8",
    );
    const prev = {
      VIBESQUAD_HOME: process.env.VIBESQUAD_HOME,
      VIBESQUAD_TEAMS_FILE: process.env.VIBESQUAD_TEAMS_FILE,
      VIBESQUAD_PROFILES_PATH: process.env.VIBESQUAD_PROFILES_PATH,
    };
    process.env.VIBESQUAD_HOME = vsHome;
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    process.env.VIBESQUAD_PROFILES_PATH = join(vsHome, "profiles.json");
    const logFile = join(vsHome, "teams", "vibesquad", "log.jsonl");
    const readLog = () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
    try {
      await fn({ dir, briefRoot, readLog });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function harness(agents, { briefRoot, graceMs = 10_000, timeline = {} } = {}) {
  const onHandlers = new Map();
  const beforeHandlers = new Map();
  const labelUpdates = [];
  const archived = [];
  const server = {
    before(event, fn) {
      beforeHandlers.set(event, fn);
      return () => beforeHandlers.delete(event);
    },
    on(event, fn) {
      onHandlers.set(event, fn);
      return () => onHandlers.delete(event);
    },
  };
  const stop = createPlugin({
    startWatcher: false,
    briefRoot,
    brainstormArchiveGraceMs: graceMs,
    setLabels: async (agentId, labels, name) => {
      labelUpdates.push({ agentId, labels, name });
      const a = agents.get(agentId);
      if (a) a.labels = { ...a.labels, ...labels };
    },
    archiveAgent: async (id) => {
      archived.push(id);
    },
  })(server);
  const paseo = {
    agents: {
      ref(id) {
        return {
          async refresh() {
            const a = agents.get(id);
            return a ? { agent: a } : null;
          },
          async archive() {
            archived.push(id);
            const a = agents.get(id);
            if (a) a.archivedAt = new Date().toISOString();
          },
          async update() {},
          timeline: {
            async refetch() {
              const text = timeline[id];
              return { entries: text ? [{ item: { type: "assistant_message", text } }] : [] };
            },
          },
        };
      },
      async list() {
        return { entries: [...agents.values()].map((agent) => ({ agent })) };
      },
    },
  };
  return {
    stop,
    onCreated: onHandlers.get("agent.created"),
    beforeCreate: beforeHandlers.get("agent.create"),
    labelUpdates,
    archived,
    paseo,
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("helpers: throwaway lanes and lane/lead mismatch", () => {
  for (const l of ["walk-tmp", "scratch-ui", "pins-scratch", "tmp-1", "walk-pins"]) assert.ok(isThrowawayLane(l), l);
  for (const l of ["vibesquad", "pinned", "walkthrough", "template"]) assert.ok(!isThrowawayLane(l), l);
  assert.equal(laneLeadMismatch({ lane: "vibesquad", lead: "walk-tmp" }), "lane=vibesquad lead=walk-tmp");
  assert.equal(laneLeadMismatch({ lane: "vibesquad", lead: "VibeSquad" }), "");
  assert.equal(laneLeadMismatch({ lane: "vibesquad" }), "");
  assert.equal(keptLaneOf({ laneId: "vibesquad", callerLane: "walk-tmp", autofixedFromCwd: true }), "walk-tmp");
  assert.equal(keptLaneOf({ laneId: "vibesquad", callerLane: "unknown-x", autofixedFromCwd: true }), "vibesquad");
});

test(
  "(b) a Buddy whose lane label disagrees with its lead label is never retired by the lane's new Buddy",
  withEnv(async ({ briefRoot, readLog }) => {
    const agents = new Map([
      [
        "20fab2ba",
        { id: "20fab2ba", title: "BRAINSTORM · WALK TMP", cwd: CWD, status: "idle", labels: { team: "vibesquad", lane: "vibesquad", lead: "walk-tmp", role: "brainstorm" } },
      ],
      ["newbuddy", { id: "newbuddy", title: "BRAINSTORM · VIBESQUAD", cwd: CWD, status: "idle", labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm" } }],
    ]);
    const h = harness(agents, { briefRoot, graceMs: 5 });
    try {
      await h.onCreated({ agent: agents.get("newbuddy") }, { paseo: h.paseo });
      await wait(30);
      assert.equal(agents.get("20fab2ba").labels.role, "brainstorm", "mislabeled Buddy must stay a live brainstorm");
      assert.ok(!h.labelUpdates.some((u) => u.agentId === "20fab2ba"), "no label writes on 20fab2ba");
      assert.ok(!h.archived.includes("20fab2ba"), "20fab2ba must not be archived");
      const skip = readLog().find((e) => e.type === "metric" && e.text.startsWith("skipped-retire-mismatch:"));
      assert.ok(skip, "skipped-retire-mismatch metric logged");
      assert.match(skip.text, /old=20fab2ba new=newbuddy lane=vibesquad lead=walk-tmp/);
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "(b) a legacy-board throwaway Buddy keeps its own lane slug and retires nobody in the cwd lane",
  withEnv(async ({ briefRoot }) => {
    const agents = new Map([
      ["realbuddy", { id: "realbuddy", title: "BRAINSTORM · VIBESQUAD", cwd: CWD, status: "idle", labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm" } }],
      ["tmpbuddy", { id: "tmpbuddy", title: "BRAINSTORM · WALK TMP", cwd: CWD, status: "idle", labels: { role: "brainstorm", lead: "walk-tmp" } }],
      ["nextbuddy", { id: "nextbuddy", title: "BRAINSTORM · VIBESQUAD", cwd: CWD, status: "idle", labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm" } }],
    ]);
    const h = harness(agents, { briefRoot, graceMs: 5 });
    try {
      await h.onCreated({ agent: agents.get("tmpbuddy") }, { paseo: h.paseo });
      assert.equal(agents.get("tmpbuddy").labels.lane, "walk-tmp", "throwaway lane must not fold into vibesquad");
      assert.equal(agents.get("tmpbuddy").labels.team, "vibesquad");
      assert.equal(agents.get("realbuddy").labels.role, "brainstorm", "real Buddy untouched by the throwaway spawn");

      // Later, a new real Buddy in the vibesquad lane must not retire the throwaway one.
      agents.delete("realbuddy");
      await h.onCreated({ agent: agents.get("nextbuddy") }, { paseo: h.paseo });
      await wait(30);
      assert.equal(agents.get("tmpbuddy").labels.role, "brainstorm");
      assert.ok(!h.archived.includes("tmpbuddy"));
    } finally {
      h.stop?.();
    }
  }),
);

test(
  "(a) a legitimate Buddy retirement snapshots the brief, logs brainstorm-retired naming the successor, then archives after the grace",
  withEnv(async ({ briefRoot, readLog }) => {
    const briefFile = join(briefRoot, "docs", "brainstorm", "vibesquad.md");
    writeFileSync(briefFile, BRIEF, "utf8");
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    utimesSync(briefFile, twoHoursAgo, twoHoursAgo);
    const agents = new Map([
      [
        "oldbuddy",
        {
          id: "oldbuddy",
          title: "BRAINSTORM · VIBESQUAD",
          cwd: CWD,
          status: "running",
          updatedAt: new Date(Date.now() - 3600_000).toISOString(),
          labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm" },
        },
      ],
      ["newbuddy", { id: "newbuddy", title: "BRAINSTORM · VIBESQUAD", cwd: CWD, status: "idle", labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm" } }],
    ]);
    const h = harness(agents, { briefRoot, graceMs: 20, timeline: { oldbuddy: "We picked option B for the\nretire guard." } });
    try {
      await h.onCreated({ agent: agents.get("newbuddy") }, { paseo: h.paseo });

      const brief = readFileSync(briefFile, "utf8");
      const inFlight = brief.slice(brief.indexOf("## In flight"), brief.indexOf("## Open"));
      assert.match(inFlight, /- block A\n- Last turn of retired Buddy oldbuddy \(\d{4}-\d{2}-\d{2}\): We picked option B for the retire guard\./);

      const retired = readLog().find((e) => e.type === "metric" && e.text.startsWith("brainstorm-retired:"));
      assert.ok(retired, "brainstorm-retired metric logged");
      assert.equal(retired.text, "brainstorm-retired: old=oldbuddy new=newbuddy lane=vibesquad brief=snapshotted");
      assert.deepEqual(retired.refs, ["oldbuddy", "newbuddy"]);

      assert.equal(agents.get("oldbuddy").labels.role, "former-brainstorm");
      assert.match(h.labelUpdates.find((u) => u.agentId === "oldbuddy").name, /^\(old\) /);
      assert.deepEqual(h.archived, [], "no immediate archive");

      // Still mid-turn after the grace: archive waits.
      await wait(60);
      assert.deepEqual(h.archived, [], "never archived mid-turn");
      agents.get("oldbuddy").status = "idle";
      await wait(60);
      assert.deepEqual(h.archived, ["oldbuddy"], "archived once idle after the grace");
    } finally {
      h.stop?.();
    }
  }),
);

test("(a) snapshotIntoBrief leaves a brief alone when it was updated after the last turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-brief-snap-"));
  try {
    mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
    const f = join(dir, "docs", "brainstorm", "vibesquad.md");
    writeFileSync(f, BRIEF, "utf8");
    const old = { id: "oldbuddy", updatedAt: new Date(Date.now() - 3600_000).toISOString() };
    assert.equal(snapshotIntoBrief(dir, "vibesquad", old, "turn"), "current");
    assert.equal(readFileSync(f, "utf8"), BRIEF);
    assert.equal(snapshotIntoBrief(dir, "other", old, "turn"), "missing");
    const noHeading = join(dir, "docs", "brainstorm", "bare.md");
    writeFileSync(noHeading, "# Bare\n", "utf8");
    utimesSync(noHeading, new Date(0), new Date(0));
    assert.equal(snapshotIntoBrief(dir, "bare", old, "x"), "snapshotted");
    assert.match(readFileSync(noHeading, "utf8"), /## In flight\n- Last turn of retired Buddy oldbuddy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "(c) a legacy-board Buddy spawn gets docs/brainstorm/<lane>.md injected; an already-briefed spawn is not doubled",
  withEnv(async ({ briefRoot, readLog }) => {
    writeFileSync(join(briefRoot, "docs", "brainstorm", "vibesquad.md"), BRIEF, "utf8");
    const h = harness(new Map(), { briefRoot });
    try {
      const legacy = {
        prompt: "You are the Brainstorm chat for VibeSquad (/projects/VibeSquad). Riff here and dispatch or start a lead when approved.",
        labels: { role: "brainstorm", lead: "vibesquad" },
        config: { cwd: CWD, title: "BRAINSTORM · VIBESQUAD", provider: "claude" },
      };
      const out = h.beforeCreate({ request: legacy });
      assert.ok(out, "request rewritten");
      const sys = out.config.systemPrompt;
      assert.ok(sys.includes("--- BEGIN docs/brainstorm/vibesquad.md ---"), "brief marker injected");
      assert.ok(sys.includes("## Decided\n- d1"), "brief content injected");
      assert.equal(sys.split("--- BEGIN docs/brainstorm/vibesquad.md ---").length, 2, "injected once");
      const metric = readLog().find((e) => e.text.startsWith("brief-injected:"));
      assert.ok(metric);
      assert.match(metric.text, /lane=vibesquad .*source=legacy-board/);

      const briefed = {
        prompt: `Start.\n--- BEGIN docs/brainstorm/vibesquad.md ---\n${BRIEF}\n--- END docs/brainstorm/vibesquad.md ---`,
        labels: { role: "brainstorm", lane: "vibesquad", team: "vibesquad" },
        config: { cwd: CWD, title: "BRAINSTORM · VIBESQUAD", provider: "claude" },
      };
      const out2 = h.beforeCreate({ request: briefed });
      assert.ok(!(out2?.config?.systemPrompt ?? "").includes("--- BEGIN docs/brainstorm/"), "no second copy of the brief");

      const worker = {
        labels: { role: "worker", lane: "vibesquad", team: "vibesquad" },
        config: { cwd: CWD, title: "worker", provider: "claude" },
      };
      const out3 = h.beforeCreate({ request: worker });
      assert.ok(!(out3?.config?.systemPrompt ?? "").includes("--- BEGIN docs/brainstorm/"), "workers never get the brief");
    } finally {
      h.stop?.();
    }
  }),
);
