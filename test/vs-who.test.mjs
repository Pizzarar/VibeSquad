import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  BRAINSTORM_PACK,
  EVERYONE_LAYER,
  LEAD_FALLBACK_PACK,
  createPlugin,
  inspectGitSpawnState,
} from "../server/hooks/agent-duties.ts";
import { DEFAULT_PROFILES, SHARED_NOTE_PREFIX, seedDefaultPack } from "../server/profiles.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI_PATH = resolve(REPO_ROOT, "cli", "vs.mjs");

function makeMockEnv() {
  const dir = mkdtempSync(join(tmpdir(), "vs-who-test-"));
  const vsHome = join(dir, ".vibesquad");
  const paseoHome = join(dir, ".paseo");
  const agentsDir = join(paseoHome, "agents", "srv_test");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(vsHome, { recursive: true });
  seedDefaultPack(join(vsHome, "profiles.json"));
  writeFileSync(
    join(vsHome, "teams.json"),
    JSON.stringify({
      teams: [
        {
          id: "efi",
          name: "Main Project",
          paths: ["main-project"],
          lanes: [
            { id: "main-game", name: "Main Game" },
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
    return {
      dir,
      vsHome,
      paseoHome,
      agentsDir,
      baseEnv() {
        return Object.fromEntries(
          Object.entries(process.env).filter(([k]) => !/^(PASEO_(AGENT_|CLI)|VS_)/.test(k)),
        );
      },
      writeAgent(record) {
        writeFileSync(join(agentsDir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf8");
      },
      runVs(args, extraEnv = {}) {
        // Hermetic: drop the caller's agent identity and live paseo CLI so a run inside an agent
        // session (PASEO_AGENT_ID, PASEO_CLI) cannot change what vs resolves or reach the daemon.
        const base = this.baseEnv();
        return spawnSync(process.execPath, [CLI_PATH, ...args], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: {
            ...base,
            VIBESQUAD_HOME: vsHome,
            PASEO_HOME: paseoHome,
            ...extraEnv,
          },
        });
      },
      cleanup() {
        rmSync(dir, { recursive: true, force: true });
      },
    };
}

test("Done-when #1: vs who lead returns only the live lead (ignoring former-lead and (old)), and prints ★ VIBESQUAD ord1 in the live repo", () => {
  const env = makeMockEnv();
  try {
    env.writeAgent({
      id: "lead-old-1",
      title: "(old) VIBESQUAD ord0",
      lastStatus: "idle",
      cwd: REPO_ROOT,
      labels: { team: "vibesquad", lane: "vibesquad", role: "former-lead", ord: "0" },
      lastUsage: { contextWindowUsedTokens: 155_000 },
    });
    env.writeAgent({
      id: "lead-old-2",
      title: "(old) ★ VIBESQUAD ord0b",
      lastStatus: "idle",
      cwd: REPO_ROOT,
      labels: { team: "vibesquad", lane: "vibesquad", role: "old-lead", ord: "0" },
      lastUsage: { contextWindowUsedTokens: 90_000 },
    });
    env.writeAgent({
      id: "lead-archived-3",
      title: "★ VIBESQUAD ord0c",
      lastStatus: "idle",
      archivedAt: "2026-10-31T00:00:00.000Z",
      cwd: REPO_ROOT,
      labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "0" },
    });
    env.writeAgent({
      id: "lead-live-1",
      title: "★ VIBESQUAD ord1",
      lastStatus: "idle",
      cwd: REPO_ROOT,
      labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "1" },
      lastUsage: { contextWindowUsedTokens: 115_000 },
    });

    const res = env.runVs(["who", "lead", "--team", "vibesquad", "--lane", "vibesquad"]);
    assert.equal(res.status, 0);
    const lines = res.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "★ VIBESQUAD ord1 · lead-live-1 · idle · 115k");

    // Also verify running vs who lead against the live repo prints ★ VIBESQUAD ord1 only
    // Runs in the repo cwd but against the mock agent homes: the real ~/.vibesquad runner agents must not leak in.
    const liveRes = env.runVs(["who", "lead", "--team", "vibesquad", "--lane", "vibesquad"]);
    assert.notEqual(liveRes.status, 2, "live repo must not have CONFLICT on vibesquad lead");
    if (liveRes.status === 0) {
      const liveLines = liveRes.stdout.trim().split(/\r?\n/);
      assert.equal(liveLines.length, 1);
      assert.equal(liveLines[0], "★ VIBESQUAD ord1 · lead-live-1 · idle · 115k");
    }
  } finally {
    env.cleanup();
  }
});

test("Done-when #2: vs who lead handles NONE (exit 1) and CONFLICT (exit 2), and filters brainstorm/buddy/workers/all accurately", () => {
  const env = makeMockEnv();
  try {
    // 0 live leads -> NONE, exit code 1
    env.writeAgent({
      id: "retired-only",
      title: "(old) VIBESQUAD ord1",
      lastStatus: "idle",
      cwd: REPO_ROOT,
      labels: { team: "vibesquad", lane: "vibesquad", role: "former-lead" },
    });

    const noneRes = env.runVs(["who", "lead", "--team", "vibesquad", "--lane", "vibesquad"]);
    assert.equal(noneRes.status, 1);
    assert.equal(noneRes.stdout.trim(), "NONE");

    const noneJson = env.runVs(["who", "lead", "--team", "vibesquad", "--lane", "vibesquad", "--json"]);
    assert.equal(noneJson.status, 1);
    assert.equal(JSON.parse(noneJson.stdout).status, "none");

    // 2 live leads -> CONFLICT + both lines, exit code 2
    env.writeAgent({
      id: "lead-a",
      title: "★ VIBESQUAD ord1",
      lastStatus: "idle",
      cwd: REPO_ROOT,
      labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "1" },
      lastUsage: { contextWindowUsedTokens: 80_000 },
    });
    env.writeAgent({
      id: "lead-b",
      title: "★ VIBESQUAD ord2",
      lastStatus: "running",
      cwd: REPO_ROOT,
      labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "2" },
      lastUsage: { contextWindowUsedTokens: 20_000 },
    });

    const conflictRes = env.runVs(["who", "lead", "--team", "vibesquad", "--lane", "vibesquad"]);
    assert.equal(conflictRes.status, 2);
    const conflictLines = conflictRes.stdout.trim().split(/\r?\n/);
    assert.equal(conflictLines[0], "CONFLICT");
    assert.equal(conflictLines.length, 3);
    assert.equal(conflictLines.some((l) => l.includes("lead-a")), true);
    assert.equal(conflictLines.some((l) => l.includes("lead-b")), true);

    // Add brainstorm, retired brainstorm, worker, and digest worker
    env.writeAgent({
      id: "bs-live",
      title: "BRAINSTORM · VIBESQUAD",
      lastStatus: "idle",
      cwd: REPO_ROOT,
      labels: { team: "vibesquad", lane: "vibesquad", role: "brainstorm" },
      lastUsage: { contextWindowUsedTokens: 42_000 },
    });
    env.writeAgent({
      id: "bs-retired",
      title: "(old) BRAINSTORM · VIBESQUAD",
      lastStatus: "idle",
      cwd: REPO_ROOT,
      labels: { team: "vibesquad", lane: "vibesquad", role: "former-brainstorm" },
    });
    env.writeAgent({
      id: "worker-live",
      title: "VIBESQUAD · unit-vs-who",
      lastStatus: "running",
      cwd: REPO_ROOT,
      labels: { team: "vibesquad", lane: "vibesquad", role: "worker" },
      lastUsage: { contextWindowUsedTokens: 15_000 },
    });
    env.writeAgent({
      id: "worker-digest",
      title: "Pre-check - Flash digest",
      lastStatus: "running",
      cwd: REPO_ROOT,
      labels: {
        team: "vibesquad",
        lane: "vibesquad",
        role: "worker",
        profile: "Pre-check - Flash",
        digestFor: "worker-live",
      },
    });

    const bsRes = env.runVs(["who", "brainstorm", "--team", "vibesquad", "--lane", "vibesquad"]);
    assert.equal(bsRes.status, 0);
    assert.equal(bsRes.stdout.trim(), "BRAINSTORM · VIBESQUAD · bs-live · idle · 42k");

    const buddyRes = env.runVs(["who", "buddy", "--team", "vibesquad", "--lane", "vibesquad"]);
    assert.equal(buddyRes.status, 0);
    assert.equal(buddyRes.stdout.trim(), "BRAINSTORM · VIBESQUAD · bs-live · idle · 42k");

    const workersRes = env.runVs(["who", "workers", "--team", "vibesquad", "--lane", "vibesquad"]);
    assert.equal(workersRes.status, 0);
    assert.equal(workersRes.stdout.trim(), "VIBESQUAD · unit-vs-who · worker-live · running · 15k");

    const allRes = env.runVs(["who", "all", "--team", "vibesquad", "--lane", "vibesquad"]);
    assert.equal(allRes.status, 0);
    const allLines = allRes.stdout.trim().split(/\r?\n/);
    assert.equal(allLines.length, 4); // lead-a, lead-b, bs-live, worker-live
  } finally {
    env.cleanup();
  }
});

test("Done-when #3 & Audit §2 + §3A: 0 hits for paseo ls -g, prior-art check rule and R1/R3/R4/R6/R2-R7 guardrails present", () => {
  const filesToCheck = [
    "server/hooks/agent-duties.ts",
    "server/profiles.mjs",
    "src/profiles.ts",
    "docs/profiles/DEFAULT_PACK.md",
    "docs/ROLE_PACKS.md",
    "docs/NAMING.md",
  ];

  for (const rel of filesToCheck) {
    const content = readFileSync(resolve(REPO_ROOT, rel), "utf8");
    assert.equal(
      content.includes("paseo ls -g"),
      false,
      `Expected 0 occurrences of "paseo ls -g" in ${rel}`,
    );
  }

  const priorArtNeedle = "check for an existing primitive";
  assert.equal(BRAINSTORM_PACK.includes(priorArtNeedle), true);
  assert.equal(LEAD_FALLBACK_PACK.includes(priorArtNeedle), true);
  assert.equal(BRAINSTORM_PACK.includes("Each block is marked Root cause or Workaround; a Workaround names the follow-up that replaces it"), true);
  assert.equal(BRAINSTORM_PACK.includes("A plan with an unnamed workaround is not ready to hand off."), true);
  assert.equal(readFileSync(resolve(REPO_ROOT, "docs/profiles/DEFAULT_PACK.md"), "utf8").includes(priorArtNeedle), true);

  for (const name of ["Brainstorm - Claude", "Brainstorm - Gemini", "Lead - Claude", "Lead - Gemini"]) {
    const prof = DEFAULT_PROFILES.find((p) => p.name === name);
    assert.ok(prof, `Missing profile ${name}`);
    assert.equal(prof.notes.includes(priorArtNeedle), true, `Profile ${name} missing prior-art check rule`);
  }

  const clientProfilesSource = readFileSync(resolve(REPO_ROOT, "src/profiles.ts"), "utf8");
  for (const ruleToken of [
    "R1 (Search/Read):",
    "R3 (Images):",
    "R4 (Large files):",
    "R6 (Waiting):",
    "R2/R7 (Git state):",
  ]) {
    assert.equal(EVERYONE_LAYER.includes(ruleToken), true, `EVERYONE_LAYER missing ${ruleToken}`);
    assert.equal(SHARED_NOTE_PREFIX.includes(ruleToken), true, `server SHARED_NOTE_PREFIX missing ${ruleToken}`);
    assert.equal(clientProfilesSource.includes(ruleToken), true, `client src/profiles.ts missing ${ruleToken}`);
  }
});

test("Audit §3B & §3C & §3D: inspectGitSpawnState injected at agent.create, vs profiles compact output, and audit-delta log subtype", async () => {
  // 1. inspectGitSpawnState on the current git repo
  const gitState = await inspectGitSpawnState(REPO_ROOT);
  assert.ok(gitState, "Expected non-null git state in git worktree");
  assert.match(gitState, /^Starting git state \(snapshot at spawn — re-check before commit\/push\/merge\): branch=\S+, origin=\d+ behind \/ \d+ ahead, dirty=\d+ files\.$/);

  // Verify before("agent.create") injects Starting git state
  let beforeHook = null;
  const server = {
    before: (event, fn) => {
      if (event === "agent.create") beforeHook = fn;
      return () => {};
    },
    on: () => () => {},
  };
  const dispose = createPlugin({ startWatcher: false })(server);
  try {
    assert.ok(beforeHook, "Expected before('agent.create') hook");
    const mutated = await beforeHook({
      request: {
        config: {
          title: "VIBESQUAD · test-worker",
          provider: "claude/claude-sonnet-5-5",
          cwd: REPO_ROOT,
          systemPrompt: "Initial task brief.",
        },
      },
    });
    assert.ok(mutated?.config?.systemPrompt);
    assert.match(mutated.config.systemPrompt, /Starting git state \(snapshot at spawn/);
  } finally {
    dispose();
  }

  // 2. vs profiles compact output vs --notes
  const env = makeMockEnv();
  try {
    const profLead = env.runVs(["profiles", "--role", "lead"]);
    assert.equal(profLead.status, 0);
    const lines = profLead.stdout.trim().split(/\r?\n/);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Lead - Claude · \S+ · claude\/claude-opus-5-5 · mode=auto$/);
    assert.equal(profLead.stdout.includes("Root coordinator"), false, "Compact mode must omit notes");

    const profWithNotes = env.runVs(["profiles", "--name", "Lead - Claude", "--notes"]);
    assert.equal(profWithNotes.status, 0);
    assert.equal(profWithNotes.stdout.includes("Root coordinator"), true, "--notes must include notes");

    // 3. vs log audit-delta subtype
    const logRes = env.runVs([
      "log",
      "audit-delta",
      "row5 vs-who: 89666 -> 1200 tok/day (-98%)",
      "--role",
      "lead",
      "--team",
      "vibesquad",
      "--lane",
      "vibesquad",
    ]);
    assert.equal(logRes.status, 0);
    const entry = JSON.parse(logRes.stdout.trim());
    assert.equal(entry.type, "metric");
    assert.match(entry.text, /^audit-delta: row5 vs-who:/);
  } finally {
    env.cleanup();
  }
});

test("misroute-old metric: turn_ended logs relay-old and turn_started agent-message on a former-lead logs misroute-old", async () => {
  const env = makeMockEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  try {
    const retiredLead = {
      id: "old-lead-42",
      title: "(old) VIBESQUAD ord0",
      cwd: REPO_ROOT,
      status: "idle",
      labels: {
        team: "vibesquad",
        lane: "vibesquad",
        role: "former-lead",
        ord: "0",
      },
    };
    const liveLead = {
      id: "live-lead-43",
      title: "★ VIBESQUAD ord1",
      cwd: REPO_ROOT,
      status: "idle",
      labels: {
        team: "vibesquad",
        lane: "vibesquad",
        role: "lead",
        ord: "1",
      },
    };
    const handlers = new Map();
    const server = {
      before: () => () => {},
      on: (event, fn) => {
        handlers.set(event, fn);
        return () => {};
      },
    };
    const paseo = {
      agents: {
        ref: (id) => ({
          refresh: async () => ({
            agent: id === retiredLead.id ? retiredLead : id === liveLead.id ? liveLead : null,
          }),
          timeline: {
            refetch: async () => ({
              entries: [
                {
                  item: {
                    type: "user_message",
                    text: `<paseo-system version="1" kind="agent-message" source-agent-id="worker-9" message-id="msg-42">\nReport for lead.\n</paseo-system>`,
                  },
                },
              ],
            }),
          },
          send: async () => {},
          archive: async () => {},
        }),
        list: async () => ({ entries: [{ agent: retiredLead }, { agent: liveLead }] }),
      },
    };

    const dispose = createPlugin({ startWatcher: false })(server);
    try {
      const turnEnded = handlers.get("agent.turn_ended");
      await turnEnded(
        { agent: retiredLead, turnId: "turn-1", outcome: { kind: "completed" } },
        { paseo },
      );

      const turnStarted = handlers.get("agent.turn_started");
      await turnStarted({ agent: retiredLead }, { paseo });

      const logPath = join(env.vsHome, "teams", "vibesquad", "log.jsonl");
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        if (existsSync(logPath)) {
          const raw = readFileSync(logPath, "utf8");
          if (raw.includes("relay-old:") && raw.includes("misroute-old:")) break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }

      const lines = readFileSync(logPath, "utf8")
        .trim()
        .split(/\r?\n/)
        .map((l) => JSON.parse(l));
      const relayEntry = lines.find((e) => e.type === "metric" && e.text.startsWith("relay-old:"));
      assert.ok(relayEntry, "Expected relay-old metric entry in team log on turn_ended");
      assert.match(relayEntry.text, /relay-old: date=\d{4}-\d{2}-\d{2} count=1 target=old-lead-42/);
      assert.deepEqual(relayEntry.refs, ["old-lead-42"]);

      const metricEntry = lines.find((e) => e.type === "metric" && e.text.startsWith("misroute-old:"));
      assert.ok(metricEntry, "Expected misroute-old metric entry in team log on turn_started");
      assert.match(metricEntry.text, /misroute-old: date=\d{4}-\d{2}-\d{2} count=1 target=old-lead-42/);
      assert.deepEqual(metricEntry.refs, ["old-lead-42"]);
    } finally {
      dispose();
    }
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});

test("Fix 2: vs who lead reports non-zero tokens when lastUsage comes from paseo inspect LastUsage while disk record has no lastUsage", () => {
  const env = makeMockEnv();
  try {
    // On-disk agent record has NO lastUsage (mirrors active Paseo session files)
    env.writeAgent({
      id: "lead-inspect-tokens",
      title: "★ VIBESQUAD ord1",
      lastStatus: "idle",
      cwd: REPO_ROOT,
      labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "1" },
    });

    const mockScript = join(env.dir, "mock-paseo.mjs");
    writeFileSync(
      mockScript,
      `
const args = process.argv.slice(2);
const mode = process.env.MOCK_INSPECT_MODE || "input";
if (args[0] === "inspect") {
  const id = args[1];
  const lastUsage = mode === "context"
    ? { ContextWindowUsedTokens: 95000, InputTokens: 5900000 }
    : { InputTokens: 142000, OutputTokens: 3200 };
  process.stdout.write(JSON.stringify({
    ID: id,
    Title: "★ VIBESQUAD ord1",
    Status: "idle",
    Cwd: ${JSON.stringify(REPO_ROOT)},
    Labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "1" },
    LastUsage: lastUsage,
  }));
  process.exit(0);
}
if (args[0] === "ls") {
  process.stdout.write(JSON.stringify([{
    id: "lead-inspect-tokens",
    title: "★ VIBESQUAD ord1",
    status: "idle",
    cwd: ${JSON.stringify(REPO_ROOT)},
    labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "1" },
  }]));
  process.exit(0);
}
process.exit(1);
`,
      "utf8",
    );

    const isWin = process.platform === "win32";
    const mockCli = join(env.dir, isWin ? "mock-paseo.cmd" : "mock-paseo.sh");
    if (isWin) {
      writeFileSync(mockCli, `@echo off\r\n"${process.execPath}" "${mockScript}" %*\r\n`, "utf8");
    } else {
      writeFileSync(mockCli, `#!/bin/sh\nexec "${process.execPath}" "${mockScript}" "$@"\n`, {
        encoding: "utf8",
        mode: 0o755,
      });
    }

    // 1. InputTokens fallback -> 142k
    const resInput = env.runVs(["who", "lead", "--team", "vibesquad", "--lane", "vibesquad"], {
      PASEO_CLI: mockCli,
      MOCK_INSPECT_MODE: "input",
    });
    assert.equal(resInput.status, 0);
    assert.equal(resInput.stdout.trim(), "★ VIBESQUAD ord1 · lead-inspect-tokens · idle · 142k");

    // 2. ContextWindowUsedTokens -> 95k
    const resCtx = env.runVs(["who", "lead", "--team", "vibesquad", "--lane", "vibesquad"], {
      PASEO_CLI: mockCli,
      MOCK_INSPECT_MODE: "context",
    });
    assert.equal(resCtx.status, 0);
    assert.equal(resCtx.stdout.trim(), "★ VIBESQUAD ord1 · lead-inspect-tokens · idle · 95k");
  } finally {
    env.cleanup();
  }
});

test("Fix 1a: vs who lead and vs log --since-me work when cwd is outside the VibeSquad repo (homedir with PASEO_AGENT_ID and git worktree pointer file)", () => {
  const env = makeMockEnv();
  try {
    env.writeAgent({
      id: "site-lead-1",
      title: "★ SITE ord1",
      lastStatus: "idle",
      cwd: "/path/to/example-site",
      labels: { team: "site", lane: "site-polish", role: "lead", ord: "1" },
      lastUsage: { contextWindowUsedTokens: 64_000 },
    });
    env.writeAgent({
      id: "site-worker-1",
      title: "SITE · suave-rhino",
      lastStatus: "running",
      cwd: join(env.dir, "external-worktree"),
      labels: { team: "site", lane: "site-polish", role: "worker" },
      createdAt: "2026-10-30T00:00:00.000Z",
    });

    // Write a team log entry for site so `vs log --since-me` returns it
    const logRes = env.runVs([
      "log",
      "decision",
      "Site layout grid settled",
      "--role",
      "lead",
      "--team",
      "site",
      "--lane",
      "site-polish",
    ]);
    assert.equal(logRes.status, 0);

    const baseEnv = env.baseEnv();

    // Case A: cwd is os.homedir() (outside any repo) with PASEO_AGENT_ID=site-worker-1
    const homeWho = spawnSync(process.execPath, [CLI_PATH, "who", "lead"], {
      cwd: homedir(),
      encoding: "utf8",
      env: {
        ...baseEnv,
        VIBESQUAD_HOME: env.vsHome,
        PASEO_HOME: env.paseoHome,
        PASEO_AGENT_ID: "site-worker-1",
      },
    });
    assert.equal(homeWho.status, 0);
    assert.equal(homeWho.stdout.trim(), "★ SITE ord1 · site-lead-1 · idle · 64k");

    const homeLog = spawnSync(process.execPath, [CLI_PATH, "log", "--since-me"], {
      cwd: homedir(),
      encoding: "utf8",
      env: {
        ...baseEnv,
        VIBESQUAD_HOME: env.vsHome,
        PASEO_HOME: env.paseoHome,
        PASEO_AGENT_ID: "site-worker-1",
      },
    });
    assert.equal(homeLog.status, 0);
    assert.match(homeLog.stdout, /Site layout grid settled/);

    // Case B: cwd is a detached git worktree folder outside the repo with a `.git` file pointing to example.dev
    const wtDir = join(env.dir, "suave-rhino-wt", "nested");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(
      join(env.dir, "suave-rhino-wt", ".git"),
      "gitdir: /path/to/example-site/.git/worktrees/suave-rhino\n",
      "utf8",
    );

    const wtWho = spawnSync(process.execPath, [CLI_PATH, "who", "lead"], {
      cwd: wtDir,
      encoding: "utf8",
      env: {
        ...baseEnv,
        VIBESQUAD_HOME: env.vsHome,
        PASEO_HOME: env.paseoHome,
        PASEO_AGENT_ID: "",
        VS_TEAM: "",
        VS_LANE: "",
      },
    });
    assert.equal(wtWho.status, 0);
    assert.equal(wtWho.stdout.trim(), "★ SITE ord1 · site-lead-1 · idle · 64k");
  } finally {
    env.cleanup();
  }
});

test("Fix 1b: vs install-shim --bin-dir <tempDir> creates vs, vs.cmd, vs.ps1 + runtime fallback and runs vs who lead via the shim", () => {
  const env = makeMockEnv();
  try {
    env.writeAgent({
      id: "lead-shim-1",
      title: "★ VIBESQUAD ord1",
      lastStatus: "idle",
      cwd: REPO_ROOT,
      labels: { team: "vibesquad", lane: "vibesquad", role: "lead", ord: "1" },
      lastUsage: { contextWindowUsedTokens: 33_000 },
    });

    const binDir = join(env.dir, "custom-bin");
    const installRes = env.runVs(["install-shim", "--bin-dir", binDir, "--json"]);
    assert.equal(installRes.status, 0);
    const parsed = JSON.parse(installRes.stdout);
    assert.equal(parsed.ok, true);

    assert.equal(existsSync(join(binDir, "vs")), true, "Expected POSIX vs shim");
    assert.equal(existsSync(join(binDir, "vs.cmd")), true, "Expected Windows vs.cmd shim");
    assert.equal(existsSync(join(binDir, "vs.ps1")), true, "Expected PowerShell vs.ps1 shim");
    assert.equal(existsSync(join(env.vsHome, "runtime", "cli", "vs.mjs")), true, "Expected fallback runtime cli/vs.mjs");
    assert.equal(existsSync(join(env.vsHome, "runtime", "teams.json")), true, "Expected fallback runtime teams.json");

    // Invoke the generated shim from homedir() to run `vs who lead`
    const isWin = process.platform === "win32";
    const shimCmd = isWin ? join(binDir, "vs.cmd") : join(binDir, "vs");
    const shimRes = spawnSync(shimCmd, ["who", "lead", "--team", "vibesquad", "--lane", "vibesquad"], {
      cwd: homedir(),
      encoding: "utf8",
      shell: isWin,
      env: {
        ...env.baseEnv(),
        VIBESQUAD_HOME: env.vsHome,
        PASEO_HOME: env.paseoHome,
      },
    });
    assert.equal(shimRes.status, 0);
    assert.equal(shimRes.stdout.trim(), "★ VIBESQUAD ord1 · lead-shim-1 · idle · 33k");
  } finally {
    env.cleanup();
  }
});

test("vs who uses runner liveness, not the last log event: a lead the restarted runner lost is closed, not live (CONFLICT fix)", () => {
  const env = makeMockEnv();
  try {
    const agentsDir = join(env.vsHome, "runner", "agents");
    mkdirSync(agentsDir, { recursive: true });
    const labels = { team: "vibesquad", lane: "vibesquad", role: "lead" };
    const writeRunnerAgent = (id, ts, lastStatus) =>
      writeFileSync(
        join(agentsDir, `${id}.jsonl`),
        [
          { seq: 0, ts, type: "created", provider: "claude", model: "m", cwd: REPO_ROOT, meta: { title: "★ VIBESQUAD lead", ...labels } },
          { seq: 1, ts, type: "status", status: lastStatus },
        ].map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    const now = Date.now();
    writeRunnerAgent("rn-lost0000001", now - 60_000, "idle"); // last event predates the runner start: its child died
    writeRunnerAgent("rn-live0000001", now + 1_000, "idle");
    // A meta/archive append after the restart (runner.updateMeta on a lost agent) is not liveness.
    appendFileSync(join(agentsDir, "rn-lost0000001.jsonl"), JSON.stringify({ seq: 2, ts: now + 2_000, type: "meta", patch: { labels: { x: "1" } } }) + "\n");
    writeFileSync(join(env.vsHome, "runner", "runner.json"), JSON.stringify({ port: 1, pid: process.pid, startedAt: now }));

    const args = ["who", "lead", "--team", "vibesquad", "--lane", "vibesquad", "--json"];
    const res = env.runVs(args);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const ids = JSON.parse(res.stdout).entries.map((e) => e.id);
    assert.deepEqual(ids, ["rn-live0000001"]);

    // A dead runner process owns no children at all.
    writeFileSync(join(env.vsHome, "runner", "runner.json"), JSON.stringify({ port: 1, pid: 2 ** 22 - 3, startedAt: now - 120_000 }));
    const dead = env.runVs(args);
    assert.equal(dead.status, 1, dead.stdout + dead.stderr);
  } finally {
    env.cleanup();
  }
});
