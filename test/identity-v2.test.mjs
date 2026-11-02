import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createPlugin } from "../plugin/index.server.ts";
import {
  UNASSIGNED_TEAM_ID,
  effectiveAgentRole,
  formatDisplayTitle,
  isBrainstormAgent,
  laneCodeFor,
  laneCodesForTeam,
  isDigestAgent,
  isRetiredAgent,
  kindOf,
  ordOf,
  resolveAgentIdentity,
} from "../server/identity.mjs";
import {
  effectiveAgentRole as tsEffectiveAgentRole,
  isBrainstormAgent as tsIsBrainstormAgent,
  isDigestAgent as tsIsDigestAgent,
  isRetiredAgent as tsIsRetiredAgent,
  kindOf as tsKindOf,
  ordOf as tsOrdOf,
  resolveAgentIdentity as tsResolveAgentIdentity,
} from "../src/identity.ts";
import {
  UNASSIGNED,
  assignAgentToLane,
  buildTeamViews,
  kindOf as teamsKindOf,
  ordOf as teamsOrdOf,
  resolve as resolveMembers,
} from "../src/teams.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const VS_CLI = join(REPO_ROOT, "cli", "vs.mjs");

function makeTempEnv() {
  const root = mkdtempSync(join(tmpdir(), "vs-identity-v2-"));
  const paseoHome = join(root, ".paseo");
  const vsHome = join(root, ".vibesquad");
  const agentsShard = join(paseoHome, "agents", "aa");
  mkdirSync(agentsShard, { recursive: true });
  mkdirSync(join(vsHome, "teams", "vibesquad"), { recursive: true });
  writeFileSync(
    join(vsHome, "teams.json"),
    JSON.stringify({
      teams: [
        {
          id: "efi",
          name: "Main Project",
          paths: ["main-project"],
          lanes: [
            { id: "main-game", name: "Main Game", aliases: ["main-old"] },
            { id: "ui-lab", name: "UI Lab" },
          ],
        },
        {
          id: "site",
          name: "Example Site",
          paths: ["example-site"],
          lanes: [{ id: "site-polish", name: "Site Polish" }],
        },
        {
          id: "vibesquad",
          name: "VibeSquad",
          paths: ["vibesquad"],
          lanes: [{ id: "vibesquad", name: "VibeSquad" }],
        },
        {
          id: "plugins",
          name: "Plugins",
          paths: [],
          lanes: [{ id: "plugins", name: "Plugins" }],
        },
      ],
    }) + "\n",
    "utf8",
  );
  writeFileSync(
    join(vsHome, "teams", "vibesquad", "log.jsonl"),
    JSON.stringify({
      ts: "2026-11-01T00:00:00.000Z",
      agent: "lead-vs-1",
      lane: "vibesquad",
      type: "decision",
      text: "Identity v2 test log entry",
      refs: [],
    }) + "\n",
    "utf8",
  );

  function writeAgent(record) {
    const file = join(agentsShard, `${record.id}.json`);
    writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
    return file;
  }

  function runVs(args, extraEnv = {}, cwd = root) {
    const env = {
      ...process.env,
      PASEO_HOME: paseoHome,
      VIBESQUAD_HOME: vsHome,
      PASEO_CLI: "",
      ...extraEnv,
    };
    return spawnSync(process.execPath, [VS_CLI, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
  }

  return {
    root,
    paseoHome,
    vsHome,
    agentsShard,
    writeAgent,
    runVs,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (/\.(mjs|ts|tsx|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test("Done-when #1: Zero title/name-prefix matching for identity in plugin/server/src/cli and misleading titles never affect resolved identity", () => {
  const dirs = ["plugin", "server", "src", "cli"].map((d) => join(REPO_ROOT, d));
  const files = dirs.flatMap((d) => collectSourceFiles(d));
  assert.ok(files.length > 0, "Expected source files to scan");

  const forbiddenPatterns = [
    { name: "roleFromTitle", re: /\broleFromTitle\b/ },
    { name: "title star-prefix regex", re: /\[\^★\]|\/\^★/ },
    { name: "title BRAINSTORM-prefix regex", re: /\/\^BRAINSTORM/i },
    { name: "title (old)-prefix regex", re: /\/\^\\\(old\\\)/i },
    { name: "title ordN regex", re: /\/(?:\\b)?ord\(\\d\+\)/i },
    { name: "title digest/pre-check regex", re: /\/digest\|pre-check/i },
  ];

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const pat of forbiddenPatterns) {
      assert.equal(
        pat.re.test(src),
        false,
        `Forbidden title-matching pattern (${pat.name}) found in ${file}`,
      );
    }
  }

  // Verify misleading titles never override label-driven identity in server/identity.mjs and src/identity.ts
  const misleadingLeadTitleAgent = {
    id: "misleading-1",
    title: "★ VIBESQUAD ord99",
    status: "running",
    cwd: "/path/to/vibesquad",
    labels: {
      lane: "vibesquad",
      role: "worker",
    },
  };

  for (const [label, fnSet] of [
    [
      "server/identity.mjs",
      {
        resolve: resolveAgentIdentity,
        effectiveRole: effectiveAgentRole,
        retired: isRetiredAgent,
        digest: isDigestAgent,
        kind: kindOf,
        ord: ordOf,
        bs: isBrainstormAgent,
      },
    ],
    [
      "src/identity.ts",
      {
        resolve: tsResolveAgentIdentity,
        effectiveRole: tsEffectiveAgentRole,
        retired: tsIsRetiredAgent,
        digest: tsIsDigestAgent,
        kind: tsKindOf,
        ord: tsOrdOf,
        bs: tsIsBrainstormAgent,
      },
    ],
  ]) {
    const res = fnSet.resolve(misleadingLeadTitleAgent);
    assert.equal(res.role, "worker", `${label}: misleading ★ title must stay worker`);
    assert.equal(res.effectiveRole, "worker", `${label}: effectiveRole must stay worker`);
    assert.equal(res.ord, "1", `${label}: ord99 in title must not be parsed`);
    assert.equal(fnSet.ord(misleadingLeadTitleAgent), 1, `${label}: ordOf must be 1`);
    assert.equal(fnSet.kind(misleadingLeadTitleAgent), "worker", `${label}: kindOf must be worker`);
    assert.equal(fnSet.bs(misleadingLeadTitleAgent), false, `${label}: isBrainstormAgent must be false`);

    const misleadingOldTitleAgent = {
      id: "misleading-2",
      title: "(old) BRAINSTORM · VIBESQUAD · fake-topic",
      status: "idle",
      labels: {
        lane: "vibesquad",
        role: "lead",
        ord: "4",
      },
    };
    assert.equal(fnSet.retired(misleadingOldTitleAgent), false, `${label}: (old) in title must not retire live lead`);
    assert.equal(fnSet.effectiveRole(misleadingOldTitleAgent), "lead", `${label}: must stay lead`);
    assert.equal(fnSet.ord(misleadingOldTitleAgent), 4, `${label}: ord from labels.ord`);

    const misleadingDigestTitleAgent = {
      id: "misleading-3",
      title: "Pre-check - Flash digest",
      status: "idle",
      labels: {
        lane: "vibesquad",
        role: "worker",
      },
    };
    assert.equal(fnSet.digest(misleadingDigestTitleAgent), false, `${label}: digest in title must not trigger digest`);
  }

  assert.equal(teamsKindOf(misleadingLeadTitleAgent), "worker");
  assert.equal(teamsOrdOf(misleadingLeadTitleAgent), 1);
  assert.equal(
    formatDisplayTitle({ role: "lead", laneName: "Site Polish", ord: "3" }),
    "★ Sit3",
  );
});

test("Done-when #2: Spawn validation handles no team, wrong team, unknown lane + matching cwd (lane-autofix), and unmatched spawn -> orphan in Unassigned tray + one-click assign", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;

  try {
    const labelUpdates = [];
    const beforeHandlers = new Map();
    const onHandlers = new Map();
    const server = {
      before(event, fn) {
        beforeHandlers.set(event, fn);
        return () => {};
      },
      on(event, fn) {
        onHandlers.set(event, fn);
        return () => {};
      },
    };

    const dispose = createPlugin({
      startWatcher: false,
      async setLabels(agentId, labels, name) {
        labelUpdates.push({ agentId, labels, name });
      },
      async archiveAgent() {},
    })(server);

    try {
      const beforeCreate = beforeHandlers.get("agent.create");
      const onCreated = onHandlers.get("agent.created");
      assert.equal(typeof beforeCreate, "function");
      assert.equal(typeof onCreated, "function");

      const agents = new Map();
      const paseo = {
        agents: {
          ref(id) {
            return {
              async refresh() {
                const a = agents.get(id);
                return a ? { agent: a } : null;
              },
              async archive() {},
            };
          },
          async list() {
            return { entries: [...agents.values()].map((agent) => ({ agent })) };
          },
        },
      };

      // Case 1a: Spawn with NO team label (only lane="site-polish") -> derives team="site"
      const reqNoTeam = {
        config: {
          provider: "claude",
          model: "claude-sonnet-5-5",
          cwd: "C:/tmp/any",
          title: "SITE POLISH · worker-1",
        },
        labels: {
          lane: "site-polish",
          role: "worker",
        },
      };
      beforeCreate({ request: reqNoTeam });
      assert.equal(reqNoTeam.labels.team, "site");
      assert.equal(reqNoTeam.labels.lane, "site-polish");
      assert.equal(reqNoTeam.labels.role, "worker");

      // Case 1b: Spawn with WRONG team label (team="efi", lane="site-polish") -> overrides team="site" & logs team-mismatch
      const reqWrongTeam = {
        config: {
          provider: "claude",
          model: "claude-sonnet-5-5",
          cwd: "/path/to/example-site",
          title: "SITE POLISH · worker-2",
        },
        labels: {
          team: "efi",
          lane: "site-polish",
          role: "worker",
        },
      };
      beforeCreate({ request: reqWrongTeam });
      assert.equal(reqWrongTeam.labels.team, "site");
      assert.equal(reqWrongTeam.labels.lane, "site-polish");

      const siteLogPath = join(env.vsHome, "teams", "site", "log.jsonl");
      assert.equal(existsSync(siteLogPath), true);
      const siteLogs = readFileSync(siteLogPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l));
      assert.equal(
        siteLogs.some((e) => e.type === "metric" && e.text.includes("team-mismatch: caller=efi derived=site lane=site-polish")),
        true,
        "Expected team-mismatch metric in site log",
      );

      // Case 2: Spawn with NO lane + cwd in a one-lane Squad ("/path/to/example-site/worktree-1")
      // -> lane-autofix fills the blank: lane="site-polish", team="site", and logs lane-autofix
      agents.set("agent-autofix", {
        id: "agent-autofix",
        title: "SITE · worker",
        cwd: "/path/to/example-site/worktree-1",
        status: "running",
        labels: {
          role: "worker",
        },
      });
      await onCreated({ agent: agents.get("agent-autofix") }, { paseo });
      const autofixUpdate = labelUpdates.find((u) => u.agentId === "agent-autofix");
      assert.ok(autofixUpdate, "Expected setLabels on agent-autofix");
      assert.equal(autofixUpdate.labels.lane, "site-polish");
      assert.equal(autofixUpdate.labels.team, "site");
      const siteLogs2 = readFileSync(siteLogPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l));
      assert.equal(
        siteLogs2.some(
          (e) =>
            e.type === "metric" &&
            e.text.includes("lane-autofix: callerLane=(none) derivedLane=site-polish team=site"),
        ),
        true,
        "Expected lane-autofix metric in site log",
      );

      // Case 2a: NO lane + team label + cwd in a multi-lane Squad -> orphan, never the Squad's first lane
      agents.set("agent-multilane", {
        id: "agent-multilane",
        title: "EFI · worker",
        cwd: "/path/to/main-project/worktree-1",
        status: "running",
        labels: { team: "efi", role: "worker" },
      });
      await onCreated({ agent: agents.get("agent-multilane") }, { paseo });
      const multiUpdate = labelUpdates.find((u) => u.agentId === "agent-multilane");
      assert.ok(multiUpdate, "Expected setLabels on agent-multilane");
      assert.equal(multiUpdate.labels.orphan, "1");
      assert.notEqual(multiUpdate.labels.lane, "main-game", "no lanes[0] guess");

      // Case 2b: an explicit lane that is not in teams.json is kept (never overwritten from cwd), no lane-autofix logged
      agents.set("agent-explicit", {
        id: "agent-explicit",
        title: "EFI · worker",
        cwd: "/path/to/main-project/worktree-1",
        status: "running",
        labels: { lane: "zz-x", role: "worker" },
      });
      await onCreated({ agent: agents.get("agent-explicit") }, { paseo });
      const explicitUpdate = labelUpdates.find((u) => u.agentId === "agent-explicit");
      assert.notEqual(explicitUpdate?.labels.lane, "main-game", "explicit lane must not be overwritten from cwd");
      assert.ok(!explicitUpdate || explicitUpdate.labels.lane === "zz-x", "explicit lane kept");
      const efiLogPath = join(env.vsHome, "teams", "efi", "log.jsonl");
      const efiLogs2 = existsSync(efiLogPath)
        ? readFileSync(efiLogPath, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l))
        : [];
      assert.equal(
        efiLogs2.some((e) => e.type === "metric" && e.text.includes("callerLane=zz-x")),
        false,
        "no lane-autofix metric for an explicit lane",
      );

      // Case 4: Unmatched spawn (unknown lane "mystery-lane" + unmatched cwd "C:/tmp/scratch")
      // -> never rejects, tags orphan="1" and logs orphan metric
      agents.set("agent-orphan", {
        id: "agent-orphan",
        title: "Scratch Worker",
        cwd: "C:/tmp/scratch",
        status: "idle",
        labels: {
          lane: "mystery-lane",
          role: "worker",
        },
      });
      await onCreated({ agent: agents.get("agent-orphan") }, { paseo });
      const orphanUpdate = labelUpdates.find((u) => u.agentId === "agent-orphan");
      assert.ok(orphanUpdate, "Expected setLabels on agent-orphan");
      assert.equal(orphanUpdate.labels.orphan, "1");

      const unassignedLogPath = join(env.vsHome, "teams", UNASSIGNED_TEAM_ID, "log.jsonl");
      assert.equal(existsSync(unassignedLogPath), true);
      const orphanLogs = readFileSync(unassignedLogPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l));
      assert.equal(
        orphanLogs.some((e) => e.type === "metric" && e.text.includes("orphan: lane=mystery-lane")),
        true,
        "Expected orphan metric in _unassigned log",
      );

      // Verify UI Unassigned tray resolution & one-click assignAgentToLane
      const uiOrphanAgent = {
        ...agents.get("agent-orphan"),
        labels: { ...orphanUpdate.labels },
      };
      const uiMap = new Map([[uiOrphanAgent.id, uiOrphanAgent]]);
      const resolvedMembers = resolveMembers(uiMap);
      assert.equal(resolvedMembers.length, 1);
      assert.equal(resolvedMembers[0].team.id, UNASSIGNED.id);
      assert.equal(resolvedMembers[0].team.id, "_unassigned");

      const viewsBefore = buildTeamViews(resolvedMembers);
      const unassignedView = viewsBefore.find((v) => v.team.id === "_unassigned");
      assert.ok(unassignedView, "Expected Unassigned view in buildTeamViews when orphan is present");
      assert.equal(unassignedView.members.length, 1);
      assert.equal(unassignedView.members[0].agent.id, "agent-orphan");

      // One-click assign to "ui-lab"
      const assignPatches = [];
      const assigned = await assignAgentToLane(uiOrphanAgent, "ui-lab", async (id, patch) => {
        assignPatches.push({ id, patch });
      });
      assert.equal(assigned.laneId, "ui-lab");
      assert.equal(assigned.teamId, "efi");
      assert.equal(assignPatches.length, 1);
      assert.equal(assignPatches[0].patch.labels.lane, "ui-lab");
      assert.equal(assignPatches[0].patch.labels.team, "efi");
      assert.equal(assignPatches[0].patch.labels.orphan, "");

      // The daemon merges the patch and pushes the agent back (assignAgentToLane no longer mutates it).
      uiMap.set(uiOrphanAgent.id, { ...uiOrphanAgent, labels: { ...uiOrphanAgent.labels, ...assignPatches[0].patch.labels } });
      const viewsAfter = buildTeamViews(resolveMembers(uiMap));
      assert.equal(
        viewsAfter.some((v) => v.team.id === "_unassigned"),
        false,
        "Unassigned view should disappear once orphan is assigned to a lane",
      );
      const efiView = viewsAfter.find((v) => v.team.id === "efi");
      const uiLabLane = efiView.lanes.find((l) => l.lane.id === "ui-lab");
      assert.equal(uiLabLane.members.some((m) => m.agent.id === "agent-orphan"), true);
    } finally {
      dispose();
    }
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});

test("Done-when #3: vs whoami is right for a lead, a brainstorm, and a worker across two different squads, and exits 1 for orphans", () => {
  const env = makeTempEnv();
  try {
    // Squad 1: vibesquad (lane: vibesquad)
    env.writeAgent({
      id: "vs-lead-1",
      title: "★ VIBESQUAD ord2",
      lastStatus: "idle",
      cwd: "/path/to/vibesquad",
      labels: { lane: "vibesquad", team: "vibesquad", role: "lead", ord: "2" },
    });
    env.writeAgent({
      id: "vs-bs-1",
      title: "BRAINSTORM · VIBESQUAD",
      lastStatus: "idle",
      cwd: "/path/to/vibesquad",
      labels: { lane: "vibesquad", team: "vibesquad", role: "brainstorm" },
    });
    env.writeAgent({
      id: "vs-worker-1",
      title: "VIBESQUAD · unit-identity-v2",
      lastStatus: "running",
      cwd: "/path/to/vibesquad",
      labels: { lane: "vibesquad", team: "vibesquad", role: "worker" },
    });

    // Squad 2: site (lane: site-polish)
    env.writeAgent({
      id: "site-lead-1",
      title: "★ SITE POLISH ord1",
      lastStatus: "idle",
      cwd: "/path/to/example-site",
      labels: { lane: "site-polish", team: "site", role: "lead", ord: "1" },
    });
    env.writeAgent({
      id: "site-bs-1",
      title: "BRAINSTORM · SITE POLISH",
      lastStatus: "idle",
      cwd: "/path/to/example-site",
      labels: { lane: "site-polish", team: "site", role: "brainstorm" },
    });
    env.writeAgent({
      id: "site-worker-1",
      title: "SITE POLISH · css-audit",
      lastStatus: "running",
      cwd: "/path/to/example-site",
      labels: { lane: "site-polish", team: "site", role: "worker" },
    });

    // Orphan agent
    env.writeAgent({
      id: "orphan-99",
      title: "Mystery Agent",
      lastStatus: "idle",
      cwd: "C:/tmp/mystery",
      labels: { lane: "nonexistent-lane", role: "worker", orphan: "1" },
    });

    for (const check of [
      {
        agentId: "vs-lead-1",
        lane: "vibesquad",
        squad: "vibesquad",
        role: "lead",
        ord: "2",
        leadId: "vs-lead-1",
      },
      {
        agentId: "vs-bs-1",
        lane: "vibesquad",
        squad: "vibesquad",
        role: "brainstorm",
        ord: "1",
        leadId: "vs-lead-1",
      },
      {
        agentId: "vs-worker-1",
        lane: "vibesquad",
        squad: "vibesquad",
        role: "worker",
        ord: "1",
        leadId: "vs-lead-1",
      },
      {
        agentId: "site-lead-1",
        lane: "site-polish",
        squad: "site",
        role: "lead",
        ord: "1",
        leadId: "site-lead-1",
      },
      {
        agentId: "site-bs-1",
        lane: "site-polish",
        squad: "site",
        role: "brainstorm",
        ord: "1",
        leadId: "site-lead-1",
      },
      {
        agentId: "site-worker-1",
        lane: "site-polish",
        squad: "site",
        role: "worker",
        ord: "1",
        leadId: "site-lead-1",
      },
    ]) {
      const textRes = env.runVs(["whoami", "--agent", check.agentId]);
      assert.equal(textRes.status, 0, `Expected exit 0 for ${check.agentId}: ${textRes.stderr}`);
      assert.match(textRes.stdout, new RegExp(`lane: ${check.lane}`));
      assert.match(textRes.stdout, new RegExp(`squad: ${check.squad}`));
      assert.match(textRes.stdout, new RegExp(`role: ${check.role}`));
      assert.match(textRes.stdout, new RegExp(`\\(${check.leadId}\\)`));

      const jsonRes = env.runVs(["whoami", "--agent", check.agentId, "--json"]);
      assert.equal(jsonRes.status, 0);
      const parsed = JSON.parse(jsonRes.stdout);
      assert.equal(parsed.agentId, check.agentId);
      assert.equal(parsed.lane, check.lane);
      assert.equal(parsed.squad, check.squad);
      assert.equal(parsed.role, check.role);
      assert.equal(parsed.ord, check.ord);
      assert.equal(parsed.orphan, false);
      assert.equal(parsed.currentLead?.id, check.leadId);
    }

    const orphanRes = env.runVs(["whoami", "--agent", "orphan-99", "--json"]);
    assert.equal(orphanRes.status, 1, "Expected exit 1 for unassigned orphan");
    const orphanJson = JSON.parse(orphanRes.stdout);
    assert.equal(orphanJson.orphan, true);
    assert.equal(orphanJson.squad, "_unassigned");
  } finally {
    env.cleanup();
  }
});

test("Done-when #4: vs migrate identity --dry-run lists all agents with proposed labels without writing, and the real run backs up and is idempotent", () => {
  const env = makeTempEnv();
  try {
    // 1. Already canonical agent
    const fCanonical = env.writeAgent({
      id: "ag-canonical",
      title: "★ VIBESQUAD ord1",
      lastStatus: "idle",
      cwd: "/path/to/vibesquad",
      labels: { lane: "vibesquad", team: "vibesquad", role: "lead", ord: "1" },
    });
    // 2. Legacy alias lane + wrong team
    const fAlias = env.writeAgent({
      id: "ag-alias",
      title: "★ MAIN GAME ord3",
      lastStatus: "idle",
      cwd: "/path/to/main-project",
      labels: { lane: "main-old", team: "main-old", role: "lead", ord: "3" },
    });
    // 3. Archived agent with cwd only (no lane/team labels)
    const fArchivedCwd = env.writeAgent({
      id: "ag-archived-cwd",
      title: "SITE POLISH · worker",
      lastStatus: "closed",
      archivedAt: "2026-10-30T00:00:00.000Z",
      cwd: "/path/to/example-site",
      labels: { role: "worker" },
    });
    // 4. Team label, no lane: an orphan, never the Squad's first lane
    const fTeamOnly = env.writeAgent({
      id: "ag-team-only",
      title: "PLUGINS · audit",
      lastStatus: "idle",
      cwd: "",
      labels: { team: "plugins", role: "buddy" },
    });
    // 5. Unmatched orphan
    const fOrphan = env.writeAgent({
      id: "ag-orphan",
      title: "Random Scratch",
      lastStatus: "idle",
      cwd: "C:/tmp/unmatched-folder",
      labels: { lane: "unknown-free-text", role: "worker" },
    });

    const snapshotBeforeDryRun = readFileSync(fAlias, "utf8");

    // Step A: Run --dry-run
    const dryText = env.runVs(["migrate", "identity", "--dry-run"]);
    assert.equal(dryText.status, 0, dryText.stderr);
    assert.match(dryText.stdout, /ag-canonical \(idle\)/);
    assert.match(dryText.stdout, /ag-alias \(idle\).*lane=main-old.*->.*lane=main-game, team=efi.*\[CHANGED\]/);
    assert.match(dryText.stdout, /ag-archived-cwd \(archived\).*\[CHANGED\]/);
    assert.match(dryText.stdout, /ag-orphan \(idle\).*\[ORPHAN\]/);
    assert.match(dryText.stdout, /ag-team-only \(idle\).*\[ORPHAN\]/);
    assert.match(dryText.stdout, /total=5 changed=4 unchanged=1 orphans=2 archived-orphans=0/);

    // Verify --dry-run did NOT modify files or create backups
    assert.equal(readFileSync(fAlias, "utf8"), snapshotBeforeDryRun);
    assert.equal(existsSync(join(env.vsHome, "backups")), false);

    // Step B: Run real migration (inside isolated temp PASEO_HOME & VIBESQUAD_HOME)
    const run1 = env.runVs(["migrate", "identity", "--json"]);
    assert.equal(run1.status, 0, run1.stderr);
    const out1 = JSON.parse(run1.stdout);
    assert.equal(out1.dryRun, false);
    assert.equal(out1.total, 5);
    assert.equal(out1.changed, 4);
    assert.equal(out1.unchanged, 1);
    assert.equal(out1.orphans, 2);
    assert.ok(out1.backupDir, "Expected backupDir to be created");
    assert.equal(existsSync(join(out1.backupDir, "teams.json")), true, "Expected teams.json backup");
    assert.equal(
      existsSync(join(out1.backupDir, "teams", "vibesquad", "log.jsonl")),
      true,
      "Expected log.jsonl backup",
    );

    // Verify updated labels on disk
    assert.deepEqual(JSON.parse(readFileSync(fCanonical, "utf8")).labels, {
      lane: "vibesquad",
      team: "vibesquad",
      role: "lead",
      ord: "1",
    });
    assert.deepEqual(JSON.parse(readFileSync(fAlias, "utf8")).labels, {
      lane: "main-game",
      team: "efi",
      role: "lead",
      ord: "3",
    });
    assert.deepEqual(JSON.parse(readFileSync(fArchivedCwd, "utf8")).labels, {
      lane: "site-polish",
      team: "site",
      role: "worker",
    });
    assert.deepEqual(JSON.parse(readFileSync(fTeamOnly, "utf8")).labels, {
      team: "plugins",
      role: "brainstorm",
      orphan: "1",
    });
    assert.deepEqual(JSON.parse(readFileSync(fOrphan, "utf8")).labels, {
      lane: "unknown-free-text",
      role: "worker",
      orphan: "1",
    });

    // Step C: Run real migration a second time -> must be idempotent (changed=0)
    const run2 = env.runVs(["migrate", "identity", "--json"]);
    assert.equal(run2.status, 0, run2.stderr);
    const out2 = JSON.parse(run2.stdout);
    assert.equal(out2.total, 5);
    assert.equal(out2.changed, 0, "Second migration run must produce 0 changes (idempotent)");
    assert.equal(out2.unchanged, 5);
  } finally {
    env.cleanup();
  }
});

const CODE_SQUAD = {
  id: "vibesquad",
  lanes: [
    { id: "vibesquad", name: "VibeSquad" },
    { id: "pinned", name: "Pinned Teams" },
    { id: "art-direction", name: "Art Direction" },
    { id: "token-checker", name: "Token Checker" },
    { id: "basic-ade-agentic-development-en", name: "Basic ADE (Agentic Development Enviroment)" },
    { id: "bug-chaser", name: "Bug Chaser" },
    { id: "quickstart", name: "Quickstart" },
  ],
};

test("lane codes: generated rule, stable, deduped within a Squad", () => {
  const codes = laneCodesForTeam(CODE_SQUAD);
  assert.deepEqual(codes, {
    vibesquad: "Hub",
    pinned: "Pin",
    "art-direction": "Art",
    "token-checker": "Tok",
    "basic-ade-agentic-development-en": "ADE",
    "bug-chaser": "Bug",
    quickstart: "Qui",
  });
  // Stable: same registry, same answer; also through the lookup helper.
  assert.deepEqual(laneCodesForTeam(CODE_SQUAD), codes);
  assert.equal(laneCodeFor("bug-chaser", [CODE_SQUAD]), "Bug");

  // Dedupe: a clashing lane gets the next candidate; a stored code is never displaced.
  const clash = laneCodesForTeam({
    lanes: [
      { id: "bug-chaser", name: "Bug Chaser" },
      { id: "bugs-two", name: "Bugs Two" },
      { id: "bugs-three", name: "Bugs Three" },
    ],
  });
  assert.equal(clash["bug-chaser"], "Bug");
  assert.equal(clash["bugs-two"], "Bugs");
  assert.equal(new Set(Object.values(clash).map((c) => c.toLowerCase())).size, 3);
  const stored = laneCodesForTeam({
    lanes: [
      { id: "a-lane", name: "Alpha" },
      { id: "b-lane", name: "Bravo", code: "Alp" },
    ],
  });
  assert.equal(stored["b-lane"], "Alp");
  assert.equal(stored["a-lane"], "Alph");
  // Invalid stored codes are ignored.
  assert.equal(laneCodesForTeam({ lanes: [{ id: "x", name: "Xylo", code: "toolongcode" }] }).x, "Xyl");
});

test("formatDisplayTitle: every role, with and without an objective", () => {
  const base = { laneId: "vibesquad", laneName: "VibeSquad", code: "Hub" };
  assert.equal(formatDisplayTitle({ ...base, role: "lead", ord: 6, job: "squad view" }), "★ Hub6 · squad view");
  assert.equal(formatDisplayTitle({ ...base, role: "lead", ord: "6" }), "★ Hub6");
  assert.equal(formatDisplayTitle({ ...base, role: "former-lead", ord: "5", job: "drop files" }), "(old) Hub5 · drop files");
  assert.equal(formatDisplayTitle({ ...base, role: "former-lead", ord: "5" }), "(old) Hub5");
  assert.equal(formatDisplayTitle({ ...base, role: "brainstorm" }), "Hub Buddy");
  assert.equal(formatDisplayTitle({ ...base, role: "brainstorm", topic: "vibesquad" }), "Hub Buddy");
  assert.equal(formatDisplayTitle({ ...base, role: "brainstorm", topic: "naming" }), "Hub Buddy · naming");
  assert.equal(formatDisplayTitle({ ...base, role: "worker", ord: "6", job: "drop files" }), "Hub6 · drop files");
  assert.equal(formatDisplayTitle({ ...base, role: "worker", ord: "6" }), "Hub6 · worker");
  // No stored code: the generated one is used.
  assert.equal(formatDisplayTitle({ laneId: "bug-chaser", laneName: "Bug Chaser", role: "lead", ord: "4" }), "★ Bug4");
  assert.equal(formatDisplayTitle({ laneId: "vibesquad", laneName: "VibeSquad", role: "brainstorm" }), "Hub Buddy");
  // Retired brainstorms keep their title.
  assert.equal(formatDisplayTitle({ ...base, role: "former-brainstorm", title: "Hub Buddy" }), "Hub Buddy");
});
