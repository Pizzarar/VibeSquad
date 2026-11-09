// C2b G1: sky zones. Zone→agent mapping, the no-Overlord state, and per-zone chat independence.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NO_OVERLORD_TEXT, fetchHubCwd, hubSpinUpError, overlordProfileName, overlordStarting, overlordState, skyZoneIds, skyZonesFor, spinUpOverlord } from "../src/skyZonesLogic.ts";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const member = (id, kind, { status = "idle", attention = null, laneId = "sq1" } = {}) => ({
  agent: { id, title: id, status, updatedAt: "2026-11-07T00:00:00Z", archivedAt: null, labels: { lane: laneId }, createdAt: "2026-11-07T00:00:00Z" },
  attention,
  kind,
  agentType: kind === "brainstorm" ? "brainstorm" : kind === "lead" ? "lead" : "implement",
  laneId,
});
const view = (members) => ({ team: { id: "sq1", name: "Squad One", color: "#fff", lanes: [] }, lanes: [], members });

test("zone→agent mapping: RiffBot = hub Buddy (left), Overlord = hub lead (right)", () => {
  const z = skyZonesFor(view([member("buddy", "brainstorm"), member("boss", "lead"), member("w1", "worker")]));
  assert.equal(z.riffbot.bot, "riffbot");
  assert.equal(z.riffbot.agentId, "buddy");
  assert.equal(z.overlord.bot, "overlord");
  assert.equal(z.overlord.agentId, "boss");
  assert.deepEqual(skyZoneIds(z), ["buddy", "boss"]);
  assert.equal(overlordState(z), "live");
});

test("face pose follows the zone's agent: running → work (talk), needs → needs", () => {
  const z = skyZonesFor(view([member("buddy", "brainstorm", { status: "running" }), member("boss", "lead")]));
  assert.equal(z.riffbot.pose, "work");
  assert.equal(z.overlord.pose, "idle");
});

test("no live Overlord: the right zone has no agent and no pose, RiffBot is unaffected", () => {
  const z = skyZonesFor(view([member("buddy", "brainstorm")]));
  assert.equal(z.overlord.member, null);
  assert.equal(z.overlord.agentId, null);
  assert.equal(z.overlord.pose, null);
  assert.equal(overlordState(z), "none");
  assert.deepEqual(skyZoneIds(z), ["buddy"]);
  assert.equal(z.riffbot.agentId, "buddy");
  assert.equal(NO_OVERLORD_TEXT, "no Overlord on duty");
});

test("no hub view at all: both zones empty, nothing throws", () => {
  const z = skyZonesFor(null);
  assert.equal(z.hub, null);
  assert.deepEqual(skyZoneIds(z), []);
});

test("no-Overlord zone renders static + the text and mounts no chat (so no composer)", () => {
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes("NO_OVERLORD_TEXT"));
  assert.ok(sky.includes('data-testid="sky-static-overlord"'));
  // A DrawerSlot (which owns the composer) is only rendered behind `zone.agentId ? ... : static`.
  assert.ok(/zone\.agentId \? \(\s*<>[\s\S]*?<DrawerSlot/.test(sky));
  assert.equal((sky.match(/<DrawerSlot/g) || []).length, 1);
});

test("each zone's chat is independent: its own agent id into the shared chat body, no cross-zone state", () => {
  const sky = src("SkyZones.tsx");
  // The chat body is AgentPanes' DrawerSlot (reused, not rewritten), keyed to this zone's own agent.
  assert.ok(src("AgentPanes.tsx").includes("export const DrawerSlot"));
  assert.ok(sky.includes('<DrawerSlot id={zone.agentId} pane="left" shown'));
  // Zones share nothing but the faces.json model: no store, no draft key, no shared agent id.
  // (G6 adds UI-only useState for which zone has focus and the face box size; still no draft/send/agent state.)
  assert.ok(!/useDraft|setActivePane|sendMessage/.test(sky));
  // Drafts and sends are per agent id (Composer/AgentDrawer take the agent), so two ids never cross.
  assert.ok(src("AgentPanes.tsx").includes("<AgentDrawer agent={agent}"));
  const z = skyZonesFor(view([member("buddy", "brainstorm"), member("boss", "lead")]));
  assert.notEqual(z.riffbot.agentId, z.overlord.agentId);
});

test("hub wiring: sky zones in hub-body; other agents take the normal focus view", () => {
  const app = src("App.tsx");
  assert.ok(app.includes("<SkyZones view={pinFocusView}"));
  assert.ok(app.includes("hub-agent-open"));
  const css = src("styles.css");
  assert.ok(css.includes(".hub-body:not(.hub-agent-open) .agent-panes .pin-focus-empty"));
});

test("sky look: CSS gradient sky, CSS bezel, both themes, reduced motion freezes static + faces", () => {
  const css = src("styles.css");
  assert.ok(/\.sky-zones \{[^}]*linear-gradient/.test(css));
  assert.ok(/\.sky-zone \{[^}]*border: 7px solid/.test(css));
  assert.ok(css.includes(':root[data-theme="light"] .sky-zones'));
  assert.ok(/prefers-reduced-motion: reduce\) \{ \.sky-static \{ animation: none/.test(css));
  const hook = src("useBotFace.ts");
  assert.ok(hook.includes("blinking && !reduced"));
  assert.ok(hook.includes("reduced ? 0 : tick"));
});

// ── G3 queue strip ───────────────────────────────────────────────────────────
import { queueStripState } from "../src/skyZonesLogic.ts";

test("queue strip collapses to a thin line when empty, opens with items", () => {
  assert.equal(queueStripState(0), "empty");
  assert.equal(queueStripState(1), "open");
  assert.equal(queueStripState(7), "open");
  const q = src("SquadQueue.tsx");
  // Empty strip renders no head/rows/"Nobody needs you" body at all: just the thin aside.
  assert.ok(/variant === "strip" && queueStripState\(items\.length\) === "empty"\) \{\s*return <aside[^>]*sq-strip is-empty[^>]*\/>/.test(q));
  const css = src("styles.css");
  assert.ok(/\.hub-body \.sq-strip\.is-empty \{[^}]*height: 14px/.test(css));
  assert.ok(src("App.tsx").includes('<SquadQueue view={pinFocusView} variant="strip" />'));
});

test("queue strip order is unchanged: permissions first, then oldest first (shared squadQueue)", () => {
  const q = src("SquadQueue.tsx");
  assert.ok(q.includes("squadQueue(view.members)"));
  const items = src("attentionItems.ts");
  assert.ok(/export function squadQueue/.test(items));
});

// ── G4 asset swap-in ─────────────────────────────────────────────────────────
import { SKY_FRAME_URL, SKY_URL, skyAssets } from "../src/skyZonesLogic.ts";
import { faceFrame, idleFaceMode, validateFaces } from "../src/squadFloorLogic.ts";

const fixture = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));

test("assets absent: sky + frame are skipped (CSS gradient sky / CSS bezel stay), per theme", () => {
  for (const theme of ["dark", "light"]) {
    assert.deepEqual(skyAssets(theme, { sky: false, frame: false }), { skyUrl: null, frameUrl: null, frameStyle: null });
  }
});

test("assets present: sky-{theme}.png and the sky-CRT frame load; each is independent", () => {
  const crt = { slice: { top: 1, right: 1, bottom: 1, left: 1 }, scale: 2, repeat: "stretch" };
  const both = skyAssets("dark", { sky: true, frame: true }, crt);
  assert.deepEqual([both.skyUrl, both.frameUrl], ["/office/sky-dark.png", "/office/sky-crt-dark.png"]);
  assert.equal(skyAssets("light", { sky: true, frame: false }).skyUrl, SKY_URL("light"));
  assert.equal(skyAssets("light", { sky: true, frame: false }, crt).frameUrl, null);
  assert.equal(skyAssets("dark", { sky: false, frame: true }, crt).frameUrl, SKY_FRAME_URL("dark"));
  assert.equal(skyAssets("dark", { sky: false, frame: true }, crt).skyUrl, null);
});

test("lookDown absent (today's faces.json): idle stays the idle face", () => {
  const v = validateFaces(fixture("faces.json"));
  assert.equal(v.ok, true);
  assert.equal(idleFaceMode(v.value, "riffbot"), "idle");
  assert.equal(idleFaceMode(v.value, "overlord"), "idle");
  assert.equal(idleFaceMode(null, "riffbot"), "idle");
});

test("lookDown present: it becomes that bot's default idle, other bots keep idle", () => {
  const v = validateFaces(fixture("faces-lookdown.json"));
  assert.equal(v.ok, true);
  assert.equal(idleFaceMode(v.value, "riffbot"), "lookDown");
  assert.equal(idleFaceMode(v.value, "overlord"), "idle");
  assert.deepEqual(faceFrame(v.value, "riffbot", "lookDown", 1), { x: 1024, y: 0 });
  // Mode order of the hook: talk/needs/blink still win over the idle swap.
  const hook = src("useBotFace.ts");
  assert.ok(hook.includes('base === "idle" ? idleFaceMode(faces, bot) : base'));
});

test("a malformed lookDown list is rejected rather than half-loaded", () => {
  const bad = fixture("faces-lookdown.json");
  bad.riffbot.lookDown = [];
  assert.equal(validateFaces(bad).ok, false);
});

test("SkyZones probes each asset and draws the frame/sky only when it loaded", () => {
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes("skyAssets(theme, { sky: useImageOk(SKY_URL(theme)), frame: useImageOk(SKY_FRAME_URL(theme)) }, crt, dpr)"));
  assert.ok(sky.includes("style={frameStyle ?? undefined}"));
  assert.ok(sky.includes('skyUrl ? "has-sky-art" : ""')); // zonesClass is built outside the JSX (css-classes scan)
});

// ── G1-fix ───────────────────────────────────────────────────────────────────

test("G1-fix: a sky bot is mounted exactly once — AgentPanes excludes it, no CSS hiding", () => {
  const panes = src("AgentPanes.tsx");
  assert.ok(panes.includes("excludeIds"));
  assert.ok(panes.includes("s.mounted.filter((id) => !excludeIds.includes(id))"));
  assert.ok(panes.includes("{mountedIds.map((id) =>"));
  assert.ok(!panes.includes("{s.mounted.map("));
  const app = src("App.tsx");
  assert.ok(app.includes("excludeIds={skyOwned}"));
  // The exclusion list is exactly the zone ids, and only while the sky is shown (not for hubAgentOpen).
  assert.ok(app.includes("hubFocused && !hubAgentOpen && pinFocusView ? skyZoneIds(skyZonesFor(pinFocusView)) : undefined"));
  // The sky mounts each bot's DrawerSlot once; the display:none hack is gone.
  assert.equal((src("SkyZones.tsx").match(/<DrawerSlot/g) || []).length, 1);
  assert.ok(!/\.agent-panes \.pane-slot,?\s*\{?[^}]*display: none !important/.test(src("styles.css").split(".hub-body")[1] ?? ""));
  assert.ok(!src("styles.css").includes(".hub-body:not(.hub-agent-open) .agent-panes .pane-slot"));
  // Zone ids are distinct and each appears once.
  const z = skyZonesFor(view([member("buddy", "brainstorm"), member("boss", "lead")]));
  const ids = skyZoneIds(z);
  assert.equal(new Set(ids).size, ids.length);
});

test("G1-fix: sky composer wraps so the textarea owns the full row", () => {
  const css = src("styles.css");
  assert.ok(/\.sky-zone \.composer-row \{ flex-wrap: wrap; \}/.test(css));
  assert.ok(/\.sky-zone \.composer-row textarea \{ flex: 1 1 100%;/.test(css));
});

test("G1-fix: focusComposerSoon also finds a sky-zone composer", () => {
  assert.ok(src("pinFocus.ts").includes(":is(.agent-panes, .sky-zone) .pane-slot[data-agent="));
});

test("G1-fix: dormant RiffBot (closed, with history) keeps the sky layout and offers a working Resume", () => {
  const z = skyZonesFor(view([member("buddy", "brainstorm", { status: "closed" })]));
  assert.equal(z.riffbot.agentId, "buddy");
  assert.equal(z.riffbot.dormant, true);
  assert.equal(z.riffbot.pose, null);
  assert.deepEqual(skyZoneIds(z), ["buddy"]); // still a sky-owned id → hub stays in the sky layout
  assert.equal(skyZonesFor(view([member("buddy", "brainstorm")])).riffbot.dormant, false);
  assert.equal(skyZonesFor(view([member("boss", "lead")])).riffbot.dormant, false); // no Buddy at all: Spin Up, not Resume
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes('"sky-resume-btn"') && sky.includes('"sky-resume-overlord"'));
  assert.ok(sky.includes("zone.dormant && onSpinUp"));
  // Resume and Spin Up both go through App's onSpinUpPin (spinUpPin → openPin), the existing path.
  assert.ok(src("App.tsx").includes("onSpinUp={onSpinUpPin}"));
  assert.ok(src("pinFocus.ts").includes("export async function spinUpPin"));
});

test("G1-fix: face cell size + fps come from faces.json (48x48 @ 3fps), scaled by an integer (faceCover) to fill the CRT", () => {
  const v = validateFaces(fixture("faces-48.json"));
  assert.equal(v.ok, true);
  assert.deepEqual(v.value.cell, { w: 48, h: 48 });
  assert.equal(v.value.fps, 3);
  assert.equal(idleFaceMode(v.value, "riffbot"), "lookDown");
  assert.equal(idleFaceMode(v.value, "overlord"), "lookDown");
  assert.deepEqual(faceFrame(v.value, "overlord", "lookDown", 1), { x: 48, y: 0 });
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes("faces?.cell"));
  assert.ok(!/\b(128|96)\b/.test(sky));
  assert.ok(src("useBotFace.ts").includes("1000 / faces.fps"));
});

// ── O3: Spin Up / Resume Overlord ──
const withCwd = (m, cwd) => ({ ...m, agent: { ...m.agent, cwd } });
const profile = { name: "Lead - Claude", provider: "claude", model: "claude-opus-5-5", modeId: "bypassPermissions" };

test("O3: off state renders Spin Up Overlord (sky-start-overlord) wired to App's onSpinUpOverlord", () => {
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes('data-testid="sky-start-overlord"'));
  assert.ok(sky.includes("Spin Up Overlord"));
  // The button sits inside the no-Overlord static, after the NO_OVERLORD_TEXT line.
  assert.ok(/sky-static-overlord"[\s\S]*?NO_OVERLORD_TEXT[\s\S]*?sky-start-overlord/.test(sky));
  assert.ok(sky.includes("onSpinUpOverlord(view)"));
  assert.ok(src("App.tsx").includes("onSpinUpOverlord={onSpinUpOverlord}"));
  assert.ok(src("App.tsx").includes("spawn: spawnTeamAgent"));
});

test("O3: spinUpOverlord spawns role=lead on the hub lane with the Squad's Lead profile, in the hub cwd", async () => {
  const v = view([withCwd(member("buddy", "brainstorm"), "C:/hub")]);
  let req;
  const id = await spinUpOverlord(v, { spawn: async (r) => ((req = r), { id: "new-lead" }), profile, profileName: "Lead - Claude" });
  assert.equal(id, "new-lead");
  assert.equal(req.labels.role, "lead");
  assert.equal(req.labels.lane, "sq1"); // the hub lane of the Squad
  assert.equal(req.labels.team, "sq1");
  assert.equal(req.labels.profile, "Lead - Claude");
  assert.equal(req.labels.ord, "1");
  assert.equal(req.provider, "claude");
  assert.equal(req.model, "claude-opus-5-5");
  assert.equal(req.modeId, "bypassPermissions");
  assert.equal(req.cwd, "C:/hub");
  assert.equal(req.title, "Overlord");
});

test("O3: spinUpOverlord falls back to the Gemini defaults, bumps ord, and refuses with no hub cwd", async () => {
  const v = view([withCwd(member("buddy", "brainstorm"), "C:/hub"), { ...member("old", "lead", { status: "closed" }), agent: { ...member("old", "lead").agent, status: "closed", labels: { lane: "sq1", ord: "3" } } }]);
  let req;
  await spinUpOverlord(v, { spawn: async (r) => ((req = r), { id: "x" }), profile: undefined, profileName: "Lead - Gemini" });
  assert.equal(req.provider, "antigravity-cli");
  assert.equal(req.labels.ord, "4");
  await assert.rejects(() => spinUpOverlord(view([member("buddy", "brainstorm")]), { spawn: async () => ({ id: "x" }), profile, profileName: "Lead - Claude" }), /working directory/);
});

test("O3: a closed Overlord keeps its zone read-only (dormant) with Resume Overlord; a live one wins", () => {
  const closed = { ...member("old", "lead"), agent: { ...member("old", "lead").agent, status: "closed", labels: { lane: "sq1", profile: "Lead - Gemini" } } };
  const z = skyZonesFor(view([member("buddy", "brainstorm"), closed]));
  assert.equal(z.overlord.agentId, "old");
  assert.equal(z.overlord.dormant, true);
  assert.equal(z.overlord.member, null); // nobody on duty: never expands the sky
  assert.equal(overlordState(z), "none");
  assert.deepEqual(skyZoneIds(z), ["buddy", "old"]);
  assert.equal(overlordProfileName(view([member("buddy", "brainstorm"), closed])), "Lead - Gemini");
  assert.equal(overlordProfileName(view([member("buddy", "brainstorm")])), "Lead - Claude");
  const live = skyZonesFor(view([member("buddy", "brainstorm"), closed, member("boss", "lead")]));
  assert.equal(live.overlord.agentId, "boss");
  assert.equal(live.overlord.dormant, false);
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes('"sky-resume-overlord"'));
  assert.ok(sky.includes("Resume {label}"));
  // Archived closed leads do not count as dormant.
  const archived = { ...closed, agent: { ...closed.agent, archivedAt: "2026-11-07T00:00:00Z" } };
  assert.equal(skyZonesFor(view([member("buddy", "brainstorm"), archived])).overlord.agentId, null);
});

test("O3-fix: closed predecessor lead is retired first and old-lead ords are never reused", async () => {
  const closed = { ...member("old", "lead"), agent: { ...member("old", "lead").agent, status: "closed", labels: { lane: "sq1", ord: "2" } } };
  const oldLead = { ...member("older", "lead"), kind: "old-lead", agent: { ...member("older", "lead").agent, status: "closed", archivedAt: "2026-11-06T00:00:00Z", labels: { lane: "sq1", role: "former-lead", ord: "5" } } };
  const v = view([withCwd(member("buddy", "brainstorm"), "C:/hub"), closed, oldLead]);
  const order = [];
  let req;
  await spinUpOverlord(v, {
    retire: async (m) => void order.push(`retire:${m.agent.id}`),
    spawn: async (r) => (order.push("spawn"), (req = r), { id: "n" }),
    profile,
    profileName: "Lead - Claude",
  });
  assert.deepEqual(order, ["spawn", "retire:old"]);
  assert.equal(req.labels.ord, "6");
});

test("O3-fix: double click spawns once; a live Overlord is returned as is", async () => {
  const v = view([withCwd(member("buddy", "brainstorm"), "C:/hub")]);
  let n = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const deps = { spawn: async () => (n++, await gate, { id: "one" }), profile, profileName: "Lead - Claude" };
  const a = spinUpOverlord(v, deps);
  const b = spinUpOverlord(v, deps);
  assert.equal(overlordStarting("sq1"), true);
  release();
  assert.deepEqual(await Promise.all([a, b]), ["one", "one"]);
  assert.equal(n, 1);
  assert.equal(overlordStarting("sq1"), false);
  const live = view([withCwd(member("buddy", "brainstorm"), "C:/hub"), member("boss", "lead")]);
  assert.equal(await spinUpOverlord(live, deps), "boss");
  assert.equal(n, 1);
  const sky = src("SkyZones.tsx");
  assert.ok(sky.includes("disabled={busy}"));
  assert.ok(src("App.tsx").includes("overlordBusy={overlordBusy}"));
});

test("O3-fix: cwd comes only from the hub lane; never a feature-lane member", async () => {
  const feature = { ...withCwd(member("f", "worker", { laneId: "feat" }), "C:/feature-wt") };
  const deps = { spawn: async () => ({ id: "x" }), profile, profileName: "Lead - Claude" };
  await assert.rejects(() => spinUpOverlord(view([member("buddy", "brainstorm"), feature]), deps), /No working directory known/);
  let req;
  const hubWorker = withCwd(member("hw", "worker"), "C:/hub-wt");
  await spinUpOverlord(view([member("buddy", "brainstorm"), feature, hubWorker]), { ...deps, spawn: async (r) => ((req = r), { id: "x" }) });
  assert.equal(req.cwd, "C:/hub-wt");
});

test("O3-fix: profile falls back on the previous lead's provider like HandoffModal", () => {
  const prev = (provider) => ({ ...member("old", "lead"), agent: { ...member("old", "lead").agent, status: "closed", provider, labels: { lane: "sq1" } } });
  assert.equal(overlordProfileName(view([member("buddy", "brainstorm"), prev("antigravity-cli")])), "Lead - Gemini");
  assert.equal(overlordProfileName(view([member("buddy", "brainstorm"), prev("claude")])), "Lead - Claude");
});

test("O3-fix2: a rejected spawn leaves the closed Overlord alone (no retire)", async () => {
  const closed = { ...member("old", "lead"), agent: { ...member("old", "lead").agent, status: "closed", labels: { lane: "sq1", profile: "Lead - Gemini" } } };
  const v = view([withCwd(member("buddy", "brainstorm"), "C:/hub"), closed]);
  let retired = 0;
  await assert.rejects(
    () => spinUpOverlord(v, { retire: async () => void retired++, spawn: async () => Promise.reject(new Error("runner down")), profile, profileName: "Lead - Claude" }),
    /runner down/,
  );
  assert.equal(retired, 0);
  assert.equal(overlordStarting("sq1"), false);
  assert.equal(skyZonesFor(v).overlord.dormant, true);
  assert.equal(overlordProfileName(v), "Lead - Gemini");
});

test("hotfix2: Overlord clicks follow the zone's agentId (real-shaped zones): off = nothing opens, closed = read-only chat + Resume, live = chat", async () => {
  const { skyCanOpen, skyFaceClick, skyEffectiveOpen, slamPrevOpenOnMount, slamView, slamStart } = await import("../src/skyZonesLogic.ts");
  const click = (zones, tv) => skyEffectiveOpen(skyFaceClick(null, tv, skyCanOpen(zones)), skyCanOpen(zones));
  // No Overlord agent running (and no history): static + Spin Up, so the Overlord TV / mini face open nothing; Riff still opens.
  const off = skyZonesFor(view([member("buddy", "brainstorm")]));
  assert.equal(off.overlord.agentId, null);
  assert.equal(click(off, "overlord"), null);
  assert.equal(click(off, "riffbot"), "riffbot");
  // Closed Overlord (member null, agentId set): used to be unclickable because can.overlord read `member`. Now opens its history.
  const closed = { ...member("old", "lead"), agent: { ...member("old", "lead").agent, status: "closed", labels: { lane: "sq1" } } };
  const dormant = skyZonesFor(view([member("buddy", "brainstorm"), closed]));
  assert.equal(dormant.overlord.member, null);
  assert.equal(dormant.overlord.agentId, "old");
  assert.equal(click(dormant, "overlord"), "overlord");
  assert.equal(skyFaceClick(null, "overlord", { riffbot: true, overlord: !!dormant.overlord.member }), null); // the old `can.overlord = !!member` wiring: dead click
  // A running Overlord opens as before.
  const live = skyZonesFor(view([member("buddy", "brainstorm"), member("boss", "lead")]));
  assert.equal(click(live, "overlord"), "overlord");
  assert.match(src("SkyZones.tsx"), /const can: SkyCan = skyCanOpen\(zones\)/);
  // Riff open triggers the slam, including a chat that mounts already open (Tower mini-face jump, SkyZones initialOpen).
  assert.equal(slamPrevOpenOnMount(true, false), true); // plain mount: no slam
  assert.equal(slamPrevOpenOnMount(true, true), false); // jump mount: flips false -> true, so the slam starts
  const v = slamView(slamStart(true, false), false);
  assert.equal(v.swinging, true); // RS-c: the window starts swinging at once
  assert.equal(v.swing, -80);
  assert.equal(slamView({ dir: "open", t: 300 }, false).face, "smacked"); // the Overlord is hit when the window lands
});

test("hub spin-up H2: with no hub member cwd the Overlord starts in the Squad/lane working dir (resolveCwd); a member cwd still wins", async () => {
  let asked = null;
  let req;
  const id = await spinUpOverlord(view([]), {
    spawn: async (r) => ((req = r), { id: "boss" }),
    profile,
    profileName: "Lead - Claude",
    resolveCwd: async (hub) => ((asked = hub.lane.id), "C:/efi"),
  });
  assert.equal(id, "boss");
  assert.equal(asked, "sq1");
  assert.equal(req.cwd, "C:/efi");
  // A hub Buddy with a cwd never reaches the resolver.
  let calls = 0;
  await spinUpOverlord(view([withCwd(member("buddy", "brainstorm"), "C:/hub")]), {
    spawn: async (r) => ((req = r), { id: "boss2" }),
    profile,
    profileName: "Lead - Claude",
    resolveCwd: async () => (calls++, "C:/efi"),
  });
  assert.equal(req.cwd, "C:/hub");
  assert.equal(calls, 0);
  // Resolver finds nothing (or throws): still a clear refusal, no spawn.
  for (const resolveCwd of [async () => null, async () => Promise.reject(new Error("offline"))]) {
    await assert.rejects(() => spinUpOverlord(view([]), { spawn: async () => ({ id: "x" }), profile, profileName: "Lead - Claude", resolveCwd }), /No working directory known/);
  }
});

test("hub spin-up H2: fetchHubCwd reads cwd from brainstorm-summary for the hub lane", async () => {
  const hub = { squad: { id: "efi" }, lane: { id: "efi" } };
  let url = "";
  const ok = (cwd) => async (u) => ((url = u), { ok: true, json: async () => ({ ok: true, cwd }) });
  assert.equal(await fetchHubCwd(hub, ok("C:/efi")), "C:/efi");
  assert.equal(url, "/__vibesquad/brainstorm-summary?lane=efi&teamId=efi");
  assert.equal(await fetchHubCwd(hub, ok(null)), null);
  assert.equal(await fetchHubCwd(hub, async () => ({ ok: false, json: async () => ({}) })), null);
});

test("hub spin-up H3: the failed Spin Up error is shown under the hub TVs only when the focus is the hub lane", () => {
  const hub = { squad: { id: "sq1" }, lane: { id: "sq1" } };
  assert.equal(hubSpinUpError({ laneId: "sq1", spinUpError: "Could not read the live agent list" }, hub), "Could not read the live agent list");
  assert.equal(hubSpinUpError({ laneId: "other", spinUpError: "boom" }, hub), null);
  assert.equal(hubSpinUpError({ laneId: "sq1", spinUpError: null }, hub), null);
  assert.equal(hubSpinUpError(null, hub), null);
  const app = src("App.tsx");
  assert.ok(app.includes("hubSpinUpError(pinFocus, hubPinNow)"));
  assert.ok(app.includes('data-testid="sky-spin-up-error"'));
  assert.ok(app.includes("resolveCwd: (hub) => fetchHubCwd(hub)"));
});
