// Unit U9 — Fix inverted profile resolution & seamless provider switch on next message.
// Covers: resolveProviderSwitchTarget profile resolution, performBrainstormRestartOnce on provider-switch,
// stripBootPreamble, stagedSwitch on dropdown change, seamless restart on sendWithBehavior, and
// predecessor timeline stitching.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performBrainstormRestart, resetBrainstormRestartState } from "../server/brainstorm.mjs";
import { seedDefaultPack } from "../server/profiles.mjs";
import { matchesFilter } from "../src/timelineFilter.ts";

const drawerSrc = readFileSync(new URL("../src/DrawerHeader.tsx", import.meta.url), "utf8");
const agentSrc = readFileSync(new URL("../src/AgentDrawer.tsx", import.meta.url), "utf8");
const timelineSrc = readFileSync(new URL("../src/Timeline.tsx", import.meta.url), "utf8");

const strip = async (t) => {
  const { stripTypeScriptTypes } = await import("node:module");
  if (typeof stripTypeScriptTypes !== "function") {
    t.skip("node:module.stripTypeScriptTypes is unavailable on this Node");
    return null;
  }
  return stripTypeScriptTypes;
};

// ─── 1. resolveProviderSwitchTarget: profile resolution never inverts an already-target profile ───

test("resolveProviderSwitchTarget pins the target profile and never inverts an already-Gemini/Claude profile", async (t) => {
  const stripTypeScriptTypes = await strip(t);
  if (!stripTypeScriptTypes) return;
  const grab = (re, what) => {
    const m = drawerSrc.match(re);
    assert.ok(m, `could not locate ${what} in DrawerHeader.tsx`);
    return m[0];
  };
  const counter = grab(/const COUNTERPART_PROFILE_MAP[\s\S]*?\r?\n};\r?\n/, "COUNTERPART_PROFILE_MAP");
  const opposite = grab(/export type OppositeProviderTarget[\s\S]*?(?=export type DrawerHeaderProps)/, "oppositeProviderTarget");
  const js = stripTypeScriptTypes(counter + opposite, { mode: "strip" });
  const mod = await import("data:text/javascript," + encodeURIComponent(js));

  // Brainstorm role always lands on the target provider's Brainstorm profile (the original inversion bug).
  assert.equal(mod.resolveProviderSwitchTarget("claude", "antigravity-cli", "Brainstorm - Gemini", "brainstorm").profile, "Brainstorm - Gemini");
  assert.equal(mod.resolveProviderSwitchTarget("claude", "antigravity-cli", "Brainstorm - Claude", "brainstorm").profile, "Brainstorm - Gemini");
  assert.equal(mod.resolveProviderSwitchTarget("antigravity-cli", "claude", "Brainstorm - Gemini", "brainstorm").profile, "Brainstorm - Claude");
  // Lead role always lands on the target provider's Lead profile.
  assert.equal(mod.resolveProviderSwitchTarget("claude", "antigravity-cli", "Lead - Claude", "lead").profile, "Lead - Gemini");
  assert.equal(mod.resolveProviderSwitchTarget("antigravity-cli", "claude", "Lead - Gemini", "lead").profile, "Lead - Claude");
  // No role: an already-target profile stays as-is (never flipped back).
  assert.equal(mod.resolveProviderSwitchTarget("claude", "antigravity-cli", "Review - Gemini").profile, "Review - Gemini");
  assert.equal(mod.resolveProviderSwitchTarget("antigravity-cli", "claude", "Review - Claude").profile, "Review - Claude");
  // Current provider → null; non-Claude/Gemini targets → no profile.
  assert.equal(mod.resolveProviderSwitchTarget("claude", "claude"), null);
  const codex = mod.resolveProviderSwitchTarget("opencode", "codex");
  assert.deepEqual([codex.provider, codex.model, codex.profile], ["codex", "gpt-5.4", undefined]);
});

// ─── 2. stripBootPreamble: only the user's actual words survive ───

test("stripBootPreamble strips provider-switch boot preambles down to the user message", async (t) => {
  const stripTypeScriptTypes = await strip(t);
  if (!stripTypeScriptTypes) return;
  const m = timelineSrc.match(/export function stripBootPreamble[\s\S]*?\n}/);
  assert.ok(m, "could not locate stripBootPreamble in Timeline.tsx");
  const mod = await import("data:text/javascript," + encodeURIComponent(stripTypeScriptTypes(m[0], { mode: "strip" })));
  const s = mod.stripBootPreamble;

  assert.equal(s("plain message"), "plain message");
  assert.equal(s("User message to answer now:\nhi there"), "hi there");
  assert.equal(s("system brief...\nPending message from the user to answer now:\nreal text"), "real text");
  // Last marker wins when both are nested (a switch-of-a-switch).
  assert.equal(s("Pending message from the user to answer now:\nold\nUser message to answer now:\nnew"), "new");
  assert.equal(s("User message to answer now:\nfirst\nUser message to answer now:\nsecond"), "second");
});

// ─── 3. performBrainstormRestartOnce on provider-switch uses the requested profile ───

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "vs-uip-u9-"));
  const vsHome = join(dir, ".vibesquad");
  const profilesPath = join(vsHome, "profiles.json");
  mkdirSync(join(dir, "docs", "brainstorm"), { recursive: true });
  mkdirSync(vsHome, { recursive: true });
  writeFileSync(join(dir, "docs", "brainstorm", "art-direction.md"), "# Brief\n\n## Open\n- pick an art style\n", "utf8");
  writeFileSync(
    join(dir, "teams.json"),
    JSON.stringify({
      teams: [
        {
          id: "vibesquad",
          name: "VibeSquad",
          paths: ["vibesquad"],
          lanes: [{ id: "art-direction", name: "Art Direction", lastProfile: "Brainstorm - Claude" }],
        },
      ],
    }),
    "utf8",
  );
  seedDefaultPack(profilesPath);
  return { dir, vsHome, profilesPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("performBrainstormRestart on provider-switch honours the requested profile over an opposite oldLabels.profile", async () => {
  const env = makeEnv();
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = env.vsHome;
  resetBrainstormRestartState();
  try {
    const created = [];
    const agentClient = {
      async fetchAgents() {
        return { entries: [] };
      },
      async createAgent(req) {
        created.push(req);
        return { id: "bs-new", title: req.config?.title, labels: { ...(req.labels ?? {}) } };
      },
      async archiveAgent() {},
      async detachAgent() {},
      async updateAgent() {},
      async cancelAgent() {},
    };

    const res = await performBrainstormRestart(
      {
        agentId: "bs-old",
        reason: "provider-switch",
        teamId: "vibesquad",
        laneId: "art-direction",
        laneName: "Art Direction",
        profileName: "Brainstorm - Gemini",
        oldAgent: {
          id: "bs-old",
          title: "ART BUDDY",
          provider: "claude",
          status: "idle",
          labels: { team: "vibesquad", lane: "art-direction", role: "brainstorm", profile: "Brainstorm - Claude" },
        },
        agentClient,
        profilesPath: env.profilesPath,
        backstopDelayMs: 0,
      },
      env.dir,
    );

    assert.equal(res.profile, "Brainstorm - Gemini");
    assert.equal(res.spawnConfig.provider, "antigravity-cli");
    assert.equal(created.length, 1);
    assert.equal(created[0].config.provider, "antigravity-cli");
    assert.equal(created[0].labels.profile, "Brainstorm - Gemini");
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
    env.cleanup();
  }
});

// ─── 4. stagedSwitch: the top-bar dropdown stages, it does not cold-restart ───

test("provider dropdown stages the switch instead of restarting immediately", () => {
  // The dropdown onChange no longer fires switchToProvider directly.
  assert.doesNotMatch(drawerSrc, /onChange=\{\(e\) => void switchToProvider\(e\.target\.value\)\}/);
  assert.match(drawerSrc, /stageSwitch\(target\)/);
  assert.match(drawerSrc, /setModelValue\(target\.model\)/);
  assert.match(drawerSrc, /if \(isBs && target\.profile\) setLastBrainstormProfile\(target\.profile\)/);
  // Effective provider drives the select value + colour and the model list while staged.
  assert.match(drawerSrc, /const effectiveProvider = staged \? staged\.provider : agent\.provider;/);
  assert.match(drawerSrc, /const effectiveProv = providerSpec\(effectiveProvider\);/);
  assert.match(drawerSrc, /buildProviderModelOptions\(effectiveProvider, modelValue \|\| staged\?\.model \|\| agent\.model, liveModels\)/);
  // The legacy 1-click ⇄ button still restarts immediately via switchToProvider.
  assert.match(drawerSrc, /await doRestart\("provider-switch", undefined, nextProfile\);/);
});

// ─── 5. seamless restart on sendWithBehavior ───

test("sendWithBehavior switches and sends on the staged provider", () => {
  assert.match(agentSrc, /const \[stagedSwitch, setStagedSwitch\] = useState<ProviderSwitchTarget \| null>\(null\);/);
  assert.match(agentSrc, /useEffect\(\(\) => \{\s*setStagedSwitch\(null\);\s*\}, \[agent\.id\]\);/);
  // The queue branch must skip when a switch is staged.
  assert.match(agentSrc, /shouldQueueOnSend\(agent\.status, forceImmediate\) &&\s*!stagedSwitch &&/);
  // The staged-switch branch builds recent conversation context and hands the message to the new provider.
  assert.match(agentSrc, /Recent conversation before provider switch:\\n\\n/);
  assert.match(agentSrc, /User message to answer now:\\n/);
  assert.match(agentSrc, /stripBootPreamble\(it\.text\)/);
  assert.match(agentSrc, /await doRestart\("provider-switch", recentTurnsAndMessage, switchTarget\.profile, switchTarget\.model, switchTarget\.modeId, switchTarget\.thinkingOptionId\)/);
  assert.match(agentSrc, /"vs\.restart-reason": "provider-switch"/);
  assert.match(agentSrc, /openAgentInTab\(newId, paneOfAgent\(agent\.id\), agent\.id\)/);
});

// ─── 6. predecessor timeline stitching ───

test("useTimeline stitches the predecessor's tail ahead of the current entries", () => {
  assert.match(timelineSrc, /export function useTimeline\(agentId: string, status: string, active = true, predecessorId\?: string, switchLabel\?: string\)/);
  assert.match(timelineSrc, /type: "provider_switch"/);
  assert.match(timelineSrc, /seqStart: -1/);
  assert.match(timelineSrc, /direction: "tail", limit: 40, projection: "projected"/);
  assert.match(timelineSrc, /data-testid="tl-provider-switch-row"/);
  assert.match(timelineSrc, /Switched to \{it\.label \|\| "new provider"\}/);
  assert.match(timelineSrc, /return \{ entries: combinedEntries, error, hasMore, loadingMore, loadMore, loaded \};/);
});

test("the provider_switch divider stays visible in the text filter", () => {
  assert.equal(matchesFilter({ type: "provider_switch", label: "◆ Gemini" }, "text"), true);
  assert.equal(matchesFilter({ type: "user_message", text: "hi" }, "text"), true);
  assert.equal(matchesFilter({ type: "tool_call" }, "text"), false);
});
