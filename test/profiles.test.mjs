import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_PACK_PROFILES,
  addInboxCards,
  detectNoteWarnings,
  diffProfiles,
  findProfile,
  importPaseoProfiles,
  loadProfiles,
  openTopicBrainstorm,
  performBrainstormRestart,
  saveProfiles,
  seedDefaultPack,
  syncProfilesToPaseo,
  toPaseoProfileShape,
  toPaseoSpawnConfig,
} from "../server/vibesquad-api.mjs";

// Mock-Paseo-daemon tests: the runner has a single owner and is never lazily started, so pin every lane to Paseo (as 35e895e did for 11 other suites).
process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;

const FIXTURE_PATH = resolve(import.meta.dirname, "fixtures", "paseo-profiles.json");

function makeTempEnv() {
  const dir = mkdtempSync(join(tmpdir(), "vs-profiles-test-"));
  const profilesPath = join(dir, ".vibesquad", "profiles.json");
  const paseoConfigPath = join(dir, ".paseo", "config.json");
  return {
    dir,
    profilesPath,
    paseoConfigPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("1. Golden fixture round-trips all 19 profiles with every Paseo field identical", () => {
  const env = makeTempEnv();
  try {
    const rawFixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    assert.equal(rawFixture.profiles.length, 19);

    const imported = importPaseoProfiles(rawFixture.profiles, {
      profilesPath: env.profilesPath,
      write: true,
    });
    assert.equal(imported.profiles.length, 19);
    assert.equal(imported.hasWarnings, false);

    const disk = JSON.parse(readFileSync(env.profilesPath, "utf8"));
    assert.equal(disk.profiles.length, 19);

    for (let i = 0; i < rawFixture.profiles.length; i++) {
      const expected = rawFixture.profiles[i];
      const roundTripped = toPaseoProfileShape(disk.profiles[i]);
      assert.deepEqual(
        roundTripped,
        expected,
        `Profile #${i} (${expected.name}) did not round-trip identically`,
      );
    }
  } finally {
    env.cleanup();
  }
});

test("2. Fresh install with empty Paseo seeds 19-profile default pack with 0 EFI/ord38/C:\\ leaks and warns on project-specific notes", () => {
  const env = makeTempEnv();
  try {
    const loaded = loadProfiles(env.profilesPath, {
      paseoConfigPath: env.paseoConfigPath, // does not exist -> empty Paseo
      autoSeed: true,
    });
    assert.equal(loaded.exists, true);
    assert.equal(loaded.seeded, true);
    assert.equal(loaded.needsSetup, false);
    assert.equal(loaded.profiles.length, 19);

    const forbidden = /[A-Za-z]:\\/i;
    for (const p of loaded.profiles) {
      assert.equal(
        forbidden.test(p.notes),
        false,
        `Default note for "${p.name}" matched forbidden project-specific pattern: ${p.notes}`,
      );
      assert.deepEqual(detectNoteWarnings(p.notes), []);
    }

    // Verify that importing a profile with EFI / absolute path triggers the warning
    const dirty = importPaseoProfiles([
      {
        name: "Brainstorm - Legacy",
        provider: "claude",
        model: "claude-opus-5-5",
        modeId: "auto",
        notes: "FIRST: read C:\\Users\\user\\AppData\\Local\\Temp\\myproject\\BRIEF.md for my-project",
      },
    ]);
    assert.equal(dirty.hasWarnings, true);
    const warns = dirty.warningsByProfile["Brainstorm - Legacy"] || [];
    assert.equal(warns.length > 0, true);
    assert.match(warns[0], /project-specific\? move it to the repo's AGENTS\.md/);
  } finally {
    env.cleanup();
  }
});

test("3. Spawning each role (lead, brainstorm, worker, restart, topic) matches Paseo profile config side by side", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  const prevProfilesPath = process.env.VIBESQUAD_PROFILES_PATH;
  process.env.VIBESQUAD_HOME = join(env.dir, ".vibesquad");
  process.env.VIBESQUAD_PROFILES_PATH = env.profilesPath;
  try {
    seedDefaultPack(env.profilesPath);
    const rawFixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const paseoByName = new Map(rawFixture.profiles.map((p) => [p.name, p]));
    const { profiles } = loadProfiles(env.profilesPath);

    // Side-by-side comparison for the 3 required profiles:
    // Lead - Claude, Mechanical - DSF, Brainstorm - Gemini
    const comparisonRows = [];
    for (const targetName of ["Lead - Claude", "Mechanical - DSF", "Brainstorm - Gemini"]) {
      const paseoProf = paseoByName.get(targetName);
      const vsProf = findProfile(targetName, profiles);
      const vsSpawn = toPaseoSpawnConfig(vsProf);

      const paseoExpected = {
        provider: paseoProf.provider,
        model: paseoProf.model,
        modeId: paseoProf.modeId,
        thinkingOptionId: paseoProf.thinkingOptionId,
        featureValues: paseoProf.featureValues ?? undefined,
      };
      const vsActual = {
        provider: vsSpawn.provider,
        model: vsSpawn.model,
        modeId: vsSpawn.modeId,
        thinkingOptionId: vsSpawn.thinkingOptionId,
        featureValues: vsSpawn.featureValues ?? undefined,
      };
      assert.deepEqual(vsActual, paseoExpected, `Mismatch on ${targetName}`);
      comparisonRows.push({
        profile: targetName,
        paseo: JSON.stringify(paseoExpected),
        vibesquad: JSON.stringify(vsActual),
      });
    }
    console.log("\n=== SIDE-BY-SIDE SPAWN CONFIG (PASEO vs VIBESQUAD) ===");
    for (const row of comparisonRows) {
      console.log(`Profile:   ${row.profile}`);
      console.log(`Paseo:     ${row.paseo}`);
      console.log(`VibeSquad: ${row.vibesquad}`);
      console.log("---");
    }

    // Verify all 19 profiles match Paseo's provider/model/modeId/thinkingOptionId/featureValues
    for (const paseoProf of rawFixture.profiles) {
      const vsSpawn = toPaseoSpawnConfig(paseoProf.name, {}, profiles);
      assert.equal(vsSpawn.provider, paseoProf.provider);
      assert.equal(vsSpawn.model, paseoProf.model);
      assert.equal(vsSpawn.modeId, paseoProf.modeId);
      assert.equal(vsSpawn.thinkingOptionId, paseoProf.thinkingOptionId);
      assert.deepEqual(vsSpawn.featureValues ?? undefined, paseoProf.featureValues ?? undefined);
      assert.equal(vsSpawn.notes, paseoProf.notes);
    }

    // Also verify brainstorm restart and inbox topic brainstorm spawn payloads against Brainstorm - Gemini
    const capturedCalls = [];
    const mockDaemon = {
      async createAgent(payload) {
        capturedCalls.push(payload);
        return { id: `agent-${capturedCalls.length}`, ...payload.config, labels: payload.labels };
      },
    };

    await performBrainstormRestart(
      {
        agentId: "old-bs-1",
        oldAgent: { id: "old-bs-1", labels: { role: "brainstorm" } }, // S4: only a known Buddy restarts
        teamId: "vibesquad",
        laneId: "vibesquad",
        profile: "Brainstorm - Gemini",
        agentClient: mockDaemon,
        profilesPath: env.profilesPath,
      },
      env.dir,
    );
    const restartCall = capturedCalls[0];
    const bsGemini = paseoByName.get("Brainstorm - Gemini");
    assert.equal(restartCall.config.provider, bsGemini.provider);
    assert.equal(restartCall.config.model, bsGemini.model);
    assert.equal(restartCall.config.modeId, bsGemini.modeId);
    assert.equal(restartCall.config.thinkingOptionId, bsGemini.thinkingOptionId);
    assert.deepEqual(restartCall.config.featureValues, bsGemini.featureValues);
    assert.equal(restartCall.config.systemPrompt, bsGemini.notes);
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    if (prevProfilesPath === undefined) delete process.env.VIBESQUAD_PROFILES_PATH;
    else process.env.VIBESQUAD_PROFILES_PATH = prevProfilesPath;
    env.cleanup();
  }
});

test("4. Claude brainstorm spawned by restart or Inbox topic runs in modeId: 'auto', never 'default' or undefined", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  const prevProfilesPath = process.env.VIBESQUAD_PROFILES_PATH;
  process.env.VIBESQUAD_HOME = join(env.dir, ".vibesquad");
  process.env.VIBESQUAD_PROFILES_PATH = env.profilesPath;
  try {
    seedDefaultPack(env.profilesPath);
    const captured = [];
    const mockDaemon = {
      async createAgent(payload) {
        captured.push(payload);
        return { id: `claude-bs-${captured.length}`, ...payload.config, labels: payload.labels };
      },
    };

    // 4a. Brainstorm restart with old agent in 'default' mode must re-read 'Brainstorm - Claude' -> modeId: 'auto'
    const restartRes = await performBrainstormRestart(
      {
        agentId: "old-claude-bs",
        teamId: "vibesquad",
        laneId: "vibesquad",
        oldAgent: {
          id: "old-claude-bs",
          provider: "claude",
          model: "claude-opus-5-5",
          modeId: "default",
          labels: { role: "brainstorm", profile: "Brainstorm - Claude" },
        },
        agentClient: mockDaemon,
        profilesPath: env.profilesPath,
      },
      env.dir,
    );
    assert.equal(restartRes.spawnConfig.modeId, "auto");
    assert.equal(captured[0].config.modeId, "auto");
    assert.notEqual(captured[0].config.modeId, "default");

    // 4b. Inbox topic brainstorm defaults to 'Brainstorm - Claude' -> modeId: 'auto'
    const added = addInboxCards(
      {
        teamId: "vibesquad",
        laneId: "vibesquad",
        ideas: ["Profile store sync and diff view"],
      },
      env.dir,
    );
    const cardId = added.added[0].id;
    const topicRes = await openTopicBrainstorm(
      {
        cardId,
        teamId: "vibesquad",
        laneId: "vibesquad",
        agentClient: mockDaemon,
        profilesPath: env.profilesPath,
      },
      env.dir,
    );
    assert.equal(topicRes.spawnConfig.modeId, "auto");
    assert.equal(captured[1].config.modeId, "auto");
    assert.equal(captured[1].labels.profile, "Brainstorm - Claude");
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    if (prevProfilesPath === undefined) delete process.env.VIBESQUAD_PROFILES_PATH;
    else process.env.VIBESQUAD_PROFILES_PATH = prevProfilesPath;
    env.cleanup();
  }
});

test("5. Editing a profile in ~/.vibesquad/profiles.json changes the next spawn immediately without code edits", async () => {
  const env = makeTempEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  const prevProfilesPath = process.env.VIBESQUAD_PROFILES_PATH;
  process.env.VIBESQUAD_HOME = join(env.dir, ".vibesquad");
  process.env.VIBESQUAD_PROFILES_PATH = env.profilesPath;
  try {
    seedDefaultPack(env.profilesPath);

    // Edit "Brainstorm - Claude" in the store (change thinkingOptionId -> "high" and model -> "claude-sonnet-5-5")
    const before = findProfile("Brainstorm - Claude", loadProfiles(env.profilesPath).profiles);
    assert.equal(before.thinkingOptionId, "medium");

    saveProfiles(
      {
        profile: {
          ...before,
          model: "claude-sonnet-5-5",
          thinkingOptionId: "high",
          notes: `${before.notes}\nCustom live-edited note line.`,
        },
      },
      env.profilesPath,
    );

    const captured = [];
    const mockDaemon = {
      async createAgent(payload) {
        captured.push(payload);
        return { id: "edited-bs-1", ...payload.config, labels: payload.labels };
      },
    };

    await performBrainstormRestart(
      {
        agentId: "bs-prev",
        oldAgent: { id: "bs-prev", labels: { role: "brainstorm" } }, // S4: only a known Buddy restarts
        teamId: "vibesquad",
        laneId: "vibesquad",
        profile: "Brainstorm - Claude",
        agentClient: mockDaemon,
        profilesPath: env.profilesPath,
      },
      env.dir,
    );

    assert.equal(captured.length, 1);
    assert.equal(captured[0].config.model, "claude-sonnet-5-5");
    assert.equal(captured[0].config.thinkingOptionId, "high");
    assert.equal(captured[0].config.modeId, "auto");
    assert.match(captured[0].config.systemPrompt, /Custom live-edited note line\./);

    // Also verify diffProfiles detects the 3 modified fields against the fixture
    const rawFixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    const bsDiff = diffProfiles(loadProfiles(env.profilesPath).profiles, rawFixture.profiles).find(
      (d) => d.name === "Brainstorm - Claude",
    );
    assert.equal(bsDiff.status, "modified");
    assert.deepEqual(bsDiff.changedFields.sort(), ["model", "notes", "thinkingOptionId"]);
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    if (prevProfilesPath === undefined) delete process.env.VIBESQUAD_PROFILES_PATH;
    else process.env.VIBESQUAD_PROFILES_PATH = prevProfilesPath;
    env.cleanup();
  }
});

test("6. syncProfilesToPaseo renames Art - Opus and Art - Gemini in place by id with no duplicates", () => {
  const env = makeTempEnv();
  try {
    mkdirSync(join(env.dir, ".paseo"), { recursive: true });
    writeFileSync(
      env.paseoConfigPath,
      JSON.stringify(
        {
          daemon: {
            agentProfiles: [
              {
                id: "agent_profile_mvso6xcl_hk9afi1fz2r",
                name: "Art - Gemini",
                provider: "antigravity-cli",
                model: "gemini-4-argon",
                notes: "old duet note",
              },
              {
                id: "agent_profile_mvwjrb2k_enr1rgj8hg5",
                name: "Art - Opus",
                provider: "claude",
                model: "claude-opus-5-5",
                notes: "old duet note",
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const seeded = seedDefaultPack(env.profilesPath);
    const syncRes = syncProfilesToPaseo(seeded.profiles, env.paseoConfigPath);
    assert.equal(syncRes.ok, true);

    const names = syncRes.agentProfiles.map((p) => p.name);
    assert.equal(names.includes("Art Director - Gemini"), true);
    assert.equal(names.includes("Art Painter - Opus"), true);
    assert.equal(names.includes("Art - Gemini"), false);
    assert.equal(names.includes("Art - Opus"), false);

    const director = syncRes.agentProfiles.find((p) => p.id === "agent_profile_mvso6xcl_hk9afi1fz2r");
    const painter = syncRes.agentProfiles.find((p) => p.id === "agent_profile_mvwjrb2k_enr1rgj8hg5");
    assert.equal(director.name, "Art Director - Gemini");
    assert.equal(painter.name, "Art Painter - Opus");
    assert.notEqual(director.notes, painter.notes);
    assert.match(painter.notes, /Art Painter in the standard Painter \+ Director artwork loop/);
    assert.match(director.notes, /Art Director in the standard Painter \+ Director artwork loop/);
  } finally {
    env.cleanup();
  }
});

test("7. R5: loadProfiles auto-imports Paseo profiles on first run (merging missing default pack) and appends newly added Paseo profiles when profiles.json already exists", () => {
  const env = makeTempEnv();
  try {
    mkdirSync(join(env.dir, ".paseo"), { recursive: true });
    writeFileSync(
      env.paseoConfigPath,
      JSON.stringify({
        daemon: {
          agentProfiles: [
            {
              id: "custom_paseo_1",
              name: "Custom Paseo Worker",
              provider: "claude",
              model: "claude-sonnet-5-5",
              modeId: "auto",
              notes: "Custom Paseo worker instructions",
            },
          ],
        },
      }),
      "utf8",
    );

    // Explicit autoSeed: false without autoImportPaseo returns paseo-unimported without writing disk
    const unimported = loadProfiles(env.profilesPath, {
      paseoConfigPath: env.paseoConfigPath,
      autoSeed: false,
    });
    assert.equal(unimported.exists, false);
    assert.equal(unimported.needsSetup, true);
    assert.equal(unimported.seeded, false);
    assert.equal(unimported.source, "paseo-unimported");

    // Default / autoImportPaseo: true imports Paseo profiles + merges missing 19 default pack profiles and persists
    const imported = loadProfiles(env.profilesPath, {
      paseoConfigPath: env.paseoConfigPath,
      autoImportPaseo: true,
    });
    assert.equal(imported.exists, true);
    assert.equal(imported.needsSetup, false);
    assert.equal(imported.seeded, true);
    assert.equal(imported.source, "paseo-imported");
    assert.equal(imported.profiles.length, 20);
    assert.equal(imported.profiles[0].name, "Custom Paseo Worker");

    // When profiles.json already exists on disk and a new profile appears in Paseo config, loadProfiles appends & persists it
    writeFileSync(
      env.paseoConfigPath,
      JSON.stringify({
        daemon: {
          agentProfiles: [
            {
              id: "custom_paseo_1",
              name: "Custom Paseo Worker",
              provider: "claude",
              model: "claude-sonnet-5-5",
              modeId: "auto",
              notes: "Custom Paseo worker instructions",
            },
            {
              id: "custom_paseo_2",
              name: "Second Paseo Agent",
              provider: "antigravity-cli",
              model: "gemini-4-argon",
              modeId: "accept-edits",
              notes: "Second custom Paseo agent",
            },
          ],
        },
      }),
      "utf8",
    );

    // Default: existing profiles.json is authoritative; leftover Paseo profiles are NOT resurrected
    const notResurrected = loadProfiles(env.profilesPath, {
      paseoConfigPath: env.paseoConfigPath,
      autoImportPaseo: true,
    });
    assert.equal(notResurrected.profiles.length, 20);
    assert.equal(notResurrected.profiles.some((p) => p.name === "Second Paseo Agent"), false);

    const reloaded = loadProfiles(env.profilesPath, {
      paseoConfigPath: env.paseoConfigPath,
      mergePaseoIntoExisting: true,
    });
    assert.equal(reloaded.source, "vibesquad");
    assert.equal(reloaded.profiles.length, 21);
    assert.ok(reloaded.profiles.some((p) => p.name === "Second Paseo Agent"));
    const onDisk = JSON.parse(readFileSync(env.profilesPath, "utf8"));
    assert.equal(onDisk.profiles.length, 21);
  } finally {
    env.cleanup();
  }
});

test("7b. syncProfilesToPaseo replaces daemon.agentProfiles by default and only merges with { merge: true }", () => {
  const env = makeTempEnv();
  try {
    mkdirSync(join(env.dir, ".paseo"), { recursive: true });
    const stale = { id: "stale_1", name: "Stale Profile", provider: "claude", model: "m", modeId: "auto" };
    const keep = { id: "keep_1", name: "Keep Me", provider: "claude", model: "m", modeId: "auto" };
    const write = () =>
      writeFileSync(env.paseoConfigPath, JSON.stringify({ daemon: { agentProfiles: [stale, keep] } }), "utf8");
    write();
    const replaced = syncProfilesToPaseo([keep], env.paseoConfigPath);
    assert.deepEqual(replaced.agentProfiles.map((p) => p.name), ["Keep Me"]);
    const onDisk = JSON.parse(readFileSync(env.paseoConfigPath, "utf8"));
    assert.equal(onDisk.daemon.agentProfiles.length, 1);

    write();
    const merged = syncProfilesToPaseo([keep], env.paseoConfigPath, { merge: true });
    assert.deepEqual(merged.agentProfiles.map((p) => p.name).sort(), ["Keep Me", "Stale Profile"]);
  } finally {
    env.cleanup();
  }
});

test("7c. every reviewer/checker profile note carries the cause-vs-symptom gate, and sync still yields the full default pack", () => {
  const question = "Does this fix the cause or hide the symptom?";
  const gated = ["Review - Sonnet", "Review - Gemini", "Check - Haiku", "Pre-check - Flash"];
  for (const name of gated) {
    const p = DEFAULT_PACK_PROFILES.find((x) => x.name === name);
    assert.ok(p, `${name} exists in the default pack`);
    assert.ok(p.notes.includes(question), `${name} note contains the gate question`);
    assert.match(p.notes, /FAIL/, `${name} note states the FAIL rule`);
    assert.match(p.notes, /follow-up/, `${name} note names the follow-up exception`);
  }
  const env = makeTempEnv();
  try {
    mkdirSync(join(env.dir, ".paseo"), { recursive: true });
    writeFileSync(env.paseoConfigPath, JSON.stringify({ daemon: { agentProfiles: [] } }), "utf8");
    const synced = syncProfilesToPaseo(DEFAULT_PACK_PROFILES, env.paseoConfigPath);
    assert.equal(synced.agentProfiles.length, 19);
    for (const name of gated) {
      assert.ok(synced.agentProfiles.find((p) => p.name === name)?.notes.includes(question), `${name} synced with gate`);
    }
  } finally {
    env.cleanup();
  }
});

test("8. DEFAULT_PROFILES in src/profiles.ts has all 19 default pack profiles matching DEFAULT_PACK_PROFILES and TeamSettingsModal renders visible profile roster", async () => {
  const { stripTypeScriptTypes } = await import("node:module");
  const tsPath = resolve(import.meta.dirname, "..", "src", "profiles.ts");
  const tsRaw = readFileSync(tsPath, "utf8");

  // Extract from `const BRIEF` up to `export const LEGACY_PROFILE_ALIASES` and evaluate as pure JS
  const startIdx = tsRaw.indexOf("const BRIEF =");
  const endIdx = tsRaw.indexOf("export function deriveRole");
  assert.ok(startIdx > 0 && endIdx > startIdx, "Expected DEFAULT_PROFILES block in src/profiles.ts");
  const jsSlice = stripTypeScriptTypes(tsRaw.slice(startIdx, endIdx))
    .replace(/^export\s+/gm, "");
  const evaluated = new Function(`${jsSlice}\nreturn { DEFAULT_PROFILES, LEGACY_PROFILE_ALIASES };`)();

  assert.equal(evaluated.DEFAULT_PROFILES.length, 19);
  assert.equal(DEFAULT_PACK_PROFILES.length, 19);

  for (let i = 0; i < DEFAULT_PACK_PROFILES.length; i++) {
    const serverProf = DEFAULT_PACK_PROFILES[i];
    const clientProf = evaluated.DEFAULT_PROFILES[i];
    assert.equal(clientProf.id, serverProf.id, `Profile #${i} id mismatch`);
    assert.equal(clientProf.name, serverProf.name, `Profile #${i} name mismatch`);
    assert.equal(clientProf.role, serverProf.role, `Profile #${i} (${serverProf.name}) role mismatch`);
    assert.equal(clientProf.icon, serverProf.icon, `Profile #${i} (${serverProf.name}) icon mismatch`);
    assert.equal(clientProf.color, serverProf.color, `Profile #${i} (${serverProf.name}) color mismatch`);
    assert.equal(clientProf.provider, serverProf.provider, `Profile #${i} (${serverProf.name}) provider mismatch`);
    assert.equal(clientProf.model, serverProf.model, `Profile #${i} (${serverProf.name}) model mismatch`);
    assert.equal(clientProf.modeId, serverProf.modeId, `Profile #${i} (${serverProf.name}) modeId mismatch`);
    assert.equal(
      clientProf.thinkingOptionId,
      serverProf.thinkingOptionId,
      `Profile #${i} (${serverProf.name}) thinkingOptionId mismatch`,
    );
    assert.deepEqual(
      clientProf.featureValues,
      serverProf.featureValues,
      `Profile #${i} (${serverProf.name}) featureValues mismatch`,
    );
    assert.equal(clientProf.notes, serverProf.notes, `Profile #${i} (${serverProf.name}) notes mismatch`);
  }

  const modalSrc = readFileSync(resolve(import.meta.dirname, "..", "src", "TeamSettingsModal.tsx"), "utf8");
  assert.ok(modalSrc.includes('data-testid="settings-profile-roster"'), "Missing settings-profile-roster in TeamSettingsModal.tsx");
  assert.ok(modalSrc.includes("Seed Default Pack (19)"), "Missing Seed Default Pack (19) button in TeamSettingsModal.tsx");
  assert.ok(modalSrc.includes("+ New Profile"), "Missing + New Profile button in TeamSettingsModal.tsx");
});

// Root cause: stored built-in notes that still equal an older default must follow default changes.
import { DEFAULT_PACK_PROFILES as PACK, isKnownDefaultNote, loadProfiles as loadProfilesDirect } from "../server/profiles.mjs";

const STALE_NOTE = readFileSync(resolve(import.meta.dirname, "fixtures", "stale-review-gemini-note.txt"), "utf8");

function seedFile(env, notesByName) {
  const profiles = PACK.slice(0, 3).map((p) => ({ ...p, notes: notesByName[p.name] ?? p.notes }));
  mkdirSync(join(env.dir, ".vibesquad"), { recursive: true });
  writeFileSync(env.profilesPath, JSON.stringify({ version: 1, profiles }), "utf8");
  return profiles.map((p) => p.name);
}

test("every current default note is recorded in profile-note-history.json", () => {
  for (const p of PACK) assert.equal(isKnownDefaultNote(p.notes), true, `${p.name}: add its hash to server/profile-note-history.json`);
  assert.equal(isKnownDefaultNote(STALE_NOTE), true);
  assert.equal(isKnownDefaultNote("A user's own custom note"), false);
});

test("stale default note is upgraded on load and persisted; user-edited note is preserved; canonical set unchanged", () => {
  const env = makeTempEnv();
  try {
    const [n0, n1] = PACK.slice(0, 2).map((p) => p.name);
    const current0 = PACK[0].notes;
    const names = seedFile(env, { [n0]: STALE_NOTE, [n1]: "A user's own custom note" });
    const res = loadProfilesDirect(env.profilesPath, { paseoProfiles: [], autoSeed: false });
    assert.notEqual(STALE_NOTE, current0);
    assert.equal(res.profiles[0].notes, current0);
    assert.equal(res.profiles[1].notes, "A user's own custom note");
    assert.equal(res.profiles[2].notes, PACK[2].notes);
    assert.deepEqual(res.profiles.map((p) => p.name), names);
    const disk = JSON.parse(readFileSync(env.profilesPath, "utf8"));
    assert.equal(disk.profiles[0].notes, current0);
    assert.equal(disk.profiles[1].notes, "A user's own custom note");
    assert.equal(disk.profiles.length, 3);
  } finally {
    env.cleanup();
  }
});

test("CRLF-stored stale note is upgraded", () => {
  const env = makeTempEnv();
  try {
    const crlf = STALE_NOTE.replace(/\r?\n/g, "\r\n") + "  \r\n";
    seedFile(env, { [PACK[0].name]: crlf });
    const res = loadProfilesDirect(env.profilesPath, { paseoProfiles: [], autoSeed: false });
    assert.equal(res.profiles[0].notes, PACK[0].notes);
    const raw = readFileSync(env.profilesPath);
    assert.notEqual(raw[0], 0xef, "no BOM");
  } finally {
    env.cleanup();
  }
});

test("custom (non-built-in) profile whose note equals a shipped default is not touched; no rewrite when unchanged", () => {
  const env = makeTempEnv();
  try {
    const custom = { ...PACK[0], id: "custom-id-1", name: "My Custom Lead", notes: STALE_NOTE };
    const profiles = [custom, ...PACK.slice(1, 3).map((p) => ({ ...p }))];
    mkdirSync(join(env.dir, ".vibesquad"), { recursive: true });
    writeFileSync(env.profilesPath, JSON.stringify({ version: 1, profiles }), "utf8");
    const before = readFileSync(env.profilesPath, "utf8");
    const res = loadProfilesDirect(env.profilesPath, { paseoProfiles: [], autoSeed: false });
    assert.equal(res.profiles[0].notes, STALE_NOTE);
    assert.equal(readFileSync(env.profilesPath, "utf8"), before, "file untouched when nothing changed");
  } finally {
    env.cleanup();
  }
});
