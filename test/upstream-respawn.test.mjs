// idea-504: a worker that dies on an upstream model-API failure (exit upstream:true, idea-442) in its FIRST turn is re-spawned ONCE
// on the alternate provider (idea-218 failover order) with the same title, cwd, labels and prompt; the lead gets a decision line
// naming both ids, and every attempt logs a metric. Never a second respawn, never after tool edits, never after a cancel/archive.
// Drives the REAL runner-hooks host + plugin over a fake runner backend, and RunnerBackend.handleLogEvent for the emit side.
import "./helpers/clean-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDirs = [];
test.after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} } });
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), "vs-ur-")); tmpDirs.push(d); return d; };
const VS_HOME = tmp();
process.env.VIBESQUAD_HOME = VS_HOME;
process.env.VIBESQUAD_ROOT = tmp();
process.env.VIBESQUAD_CAPPED_PROVIDERS_PATH = path.join(VS_HOME, "capped-providers.json"); // the exit's cap never touches the real file
const CWD = path.join(tmp(), "VibeSquad");
mkdirSync(CWD, { recursive: true });
writeFileSync(
  path.join(VS_HOME, "teams.json"),
  JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "bug-chaser", paths: ["VibeSquad"] }], paths: ["VibeSquad"] }] }),
);

const { createRunnerHookHost } = await import("../server/backend/runner-hooks.mjs");
const { RunnerBackend } = await import("../server/backend/runner-backend.mjs");
const { upstreamRespawnPlan, respawnLabels, RESPAWN_OF_LABEL, RESPAWNED_AS_LABEL, UPSTREAM_RESPAWN_MAX_AGE_MS } = await import("../server/hooks/agent-duties.ts");

const LOG = path.join(VS_HOME, "teams", "vibesquad", "log.jsonl");
const teamLog = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const PROMPT = "Block CI-T. Lead: Bug1 (rn-lead1). stakes=mechanical.\nTask: set timeout-minutes: 45 in ci.yml.";
const ERR = "opencode exited (code 1) after: Internal error: Internal service failure";
const LABELS = {
  team: "vibesquad", lane: "bug-chaser", role: "worker", profile: "Mechanical - DSF", job: "CI timeout", ord: "3", stakes: "mechanical",
  "vs.parent": "rn-lead1", wf: "dsf", tier: "cheap", provider: "opencode", model: "deepseek/deepseek-flash", "vs.spawn-configured": "1",
  "vs.route": "stakes=mechanical", "vs.profile-derived": "model,thinking",
};

/** A fake runner backend holding one dead worker; createAgent records spawns (no turn is played). */
function fakeRunner({ id = "rn-dead", labels = LABELS, timeline, status = "closed", archivedAt = null } = {}) {
  const agents = new Map();
  const timelines = new Map();
  const created = [];
  const labelWrites = [];
  const sends = [];
  let seq = 0;
  const rows = (items) => items.map((item) => ({ item, seqStart: ++seq, seqEnd: seq, timestamp: new Date().toISOString() }));
  const backend = {
    async getAgent(aid) {
      const a = agents.get(aid);
      if (!a) throw new Error(`no agent ${aid}`);
      return { ...a, labels: { ...a.labels } };
    },
    async fetchAgentTimeline(aid, opts = {}) {
      const all = timelines.get(aid) ?? [];
      return { entries: Number(opts.limit) > 0 ? all.slice(-Number(opts.limit)) : all.slice() };
    },
    async listAgents(opts) {
      // Like RunnerBackend.fetchAgents: archived agents only with filter.includeArchived.
      const all = [...agents.values()].filter((a) => opts?.filter?.includeArchived || !a.archivedAt);
      return all.map((a) => ({ ...a, labels: { ...a.labels } }));
    },
    async createAgent({ config, prompt, labels: l, env }) {
      const nid = `rn-new-${created.length + 1}`;
      const a = { id: nid, title: config.title, cwd: config.cwd, provider: config.provider, modeId: config.modeId, status: "running", labels: { ...l }, archivedAt: null };
      agents.set(nid, a);
      timelines.set(nid, rows([{ type: "user_message", text: prompt }]));
      created.push({ ...a, prompt, env });
      return { ...a };
    },
    async sendAgentPrompt(aid, text) { sends.push({ id: aid, text }); return { queued: false }; },
    async archiveAgent(aid) { const a = agents.get(aid); if (a) a.archivedAt = new Date().toISOString(); },
    async updateAgent(aid, { labels: l } = {}) {
      labelWrites.push({ id: aid, labels: l });
      const a = agents.get(aid);
      if (a && l) a.labels = { ...a.labels, ...l };
    },
    async cancelAgent() {},
    async deleteHeartbeat() {},
  };
  agents.set(id, { id, title: "Bug1 · CI timeout", cwd: CWD, provider: "opencode", status, labels: { ...labels }, archivedAt });
  timelines.set(id, rows(timeline ?? [{ type: "user_message", text: PROMPT }, { type: "error", message: "Internal error: Internal service failure" }, { type: "error", message: ERR }]));
  return { backend, agents, created, labelWrites, sends };
}

async function withHost(f, fn, deps = {}) {
  const host = await createRunnerHookHost(f.backend, { startWatcher: false, deps: { cappedProviders: [], retryBaseMs: 30, ...deps }, pollMs: 20 });
  try { return await fn(host); } finally { host.dispose(); }
}
const emitExit = async (host, f, id = "rn-dead", { ts = Date.now(), error = ERR } = {}) =>
  host.emit("agent.upstream_exit", { agent: await f.backend.getAgent(id), error, ...(ts === null ? {} : { ts }) }); // ts null = an exit event with no ts
const emitFailedTurn = async (host, f, id, message) =>
  host.emit("agent.turn_ended", { agent: await f.backend.getAgent(id), turnId: "3", outcome: { kind: "failed", error: { message } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const metrics = (id) => teamLog().filter((e) => e.type === "metric" && /^upstream-respawn /.test(e.text) && e.text.includes(`agent=${id} `));

test("first-turn upstream death -> respawned ONCE on another provider: same title, cwd, prompt, job/ord/stakes; decision + metric", async () => {
  const f = fakeRunner();
  await withHost(f, async (host) => {
    await emitExit(host, f);
    assert.equal(f.created.length, 1, "one replacement");
    const n = f.created[0];
    assert.equal(n.title, "Bug1 · CI timeout");
    assert.equal(n.cwd, CWD);
    assert.equal(n.prompt, PROMPT, "the original prompt, verbatim");
    assert.notEqual(n.provider.split("/")[0], "opencode", "an alternate provider family");
    for (const k of ["team", "lane", "role", "job", "ord", "stakes", "vs.parent"]) assert.equal(n.labels[k], LABELS[k], k);
    assert.equal(n.labels[RESPAWN_OF_LABEL], "rn-dead");
    assert.notEqual(n.labels.profile, "Mechanical - DSF", "the failover profile");
    assert.equal(n.env.VS_PROFILE, n.labels.profile);
    for (const k of ["wf", "tier", "provider", "model", "vs.spawn-configured", "vs.route", "vs.profile-derived"]) assert.equal(n.labels[k], undefined, `${k} re-derived by the spawn hook`);
    assert.equal(f.agents.get("rn-dead").labels[RESPAWNED_AS_LABEL], n.id, "the dead worker points at its replacement");
    const dec = teamLog().filter((e) => e.type === "decision" && (e.refs ?? []).includes("rn-dead"));
    assert.equal(dec.length, 1);
    assert.deepEqual(dec[0].refs, ["rn-dead", n.id]);
    assert.match(dec[0].text, new RegExp(`^RESPAWNED rn-dead -> ${n.id}: .*Internal service failure`));
    const m = metrics("rn-dead");
    assert.equal(m.length, 1);
    assert.match(m[0].text, new RegExp(`result=respawned agent=rn-dead new=${n.id} provider=opencode->`));
  });
});

test("never a second respawn: the same exit replayed, a restarted host (respawnedAs), and the replacement dying too", async () => {
  const f = fakeRunner({ id: "rn-dead2" });
  await withHost(f, async (host) => {
    await emitExit(host, f, "rn-dead2");
    await emitExit(host, f, "rn-dead2"); // same process: already handled
  });
  assert.equal(f.created.length, 1);
  // A restarted server replays the exit: the respawnedAs label (and the replacement's respawnOf) stop it.
  await withHost(f, (host) => emitExit(host, f, "rn-dead2"));
  assert.equal(f.created.length, 1, "no second replacement after a restart");
  assert.match(metrics("rn-dead2").at(-1).text, /result=skipped reason=already-respawned/);
  // Even with the label write lost, the replacement carrying respawnOf=<dead> is found.
  delete f.agents.get("rn-dead2").labels[RESPAWNED_AS_LABEL];
  await withHost(f, (host) => emitExit(host, f, "rn-dead2"));
  assert.equal(f.created.length, 1);
  assert.match(metrics("rn-dead2").at(-1).text, /reason=already-respawned\(rn-new-1\)/);
  // The replacement itself dies upstream in its first turn: no loop.
  const rep = f.agents.get("rn-new-1");
  rep.status = "closed";
  await withHost(f, (host) => emitExit(host, f, "rn-new-1"));
  assert.equal(f.created.length, 1, "a respawn is never respawned");
  assert.match(metrics("rn-new-1").at(-1).text, /reason=already-a-respawn/);
});

test("no respawn after tool edits / a shell command, after a finished turn, or for a second-turn death", async () => {
  const cases = [
    ["edit", [{ type: "user_message", text: PROMPT }, { type: "tool_call", name: "Edit ci.yml", detail: { kind: "edit" } }, { type: "error", message: ERR }], /reason=tool-edits\(Edit ci\.yml\)/],
    ["shell", [{ type: "user_message", text: PROMPT }, { type: "tool_call", name: "git commit", detail: { kind: "execute" } }, { type: "error", message: ERR }], /reason=tool-edits\(git commit\)/],
    ["second", [{ type: "user_message", text: PROMPT }, { type: "assistant_message", text: "done" }, { type: "user_message", text: "fix round" }, { type: "error", message: ERR }], /reason=not-first-turn/],
  ];
  for (const [name, timeline, re] of cases) {
    const id = `rn-dead-${name}`;
    const f = fakeRunner({ id, timeline });
    await withHost(f, (host) => emitExit(host, f, id));
    assert.equal(f.created.length, 0, `${name}: not respawned`);
    assert.match(metrics(id).at(-1).text, re, name);
  }
  // Reads before the death are fine: nothing was changed.
  const f = fakeRunner({ id: "rn-dead-reads", timeline: [{ type: "user_message", text: PROMPT }, { type: "tool_call", name: "Read AGENTS.md", detail: { kind: "read" } }, { type: "error", message: ERR }] });
  await withHost(f, (host) => emitExit(host, f, "rn-dead-reads"));
  assert.equal(f.created.length, 1, "a read-only first turn is respawned");
});

test("no respawn for an archived (lead/user-cancelled) worker, a revived one, a lead, or a stale replayed exit", async () => {
  const runs = [
    ["arch", { archivedAt: new Date().toISOString() }, {}, /reason=archived/],
    ["busy", { status: "running" }, {}, /reason=revived\(running\)/],
    ["lead", { labels: { ...LABELS, role: "lead" } }, {}, /reason=role-lead/],
    ["old", {}, { ts: Date.now() - UPSTREAM_RESPAWN_MAX_AGE_MS - 1000 }, /reason=stale-exit/],
  ];
  for (const [name, opt, ev, re] of runs) {
    const id = `rn-dead-${name}`;
    const f = fakeRunner({ id, ...opt });
    await withHost(f, (host) => emitExit(host, f, id, ev));
    assert.equal(f.created.length, 0, `${name}: not respawned`);
    assert.match(metrics(id).at(-1).text, re, name);
  }
});

/** A RunnerBackend whose fetch returns `agent`; returns the events it emits for the given log events. */
async function backendEvents(events, agent) {
  const vs = tmp();
  const rc = { vs, home: path.join(vs, "runner"), request: async () => { throw new Error("unused"); }, stream: () => ({ close() {} }) };
  const b = new RunnerBackend({ client: rc, buildPrefix: async () => "" });
  b.live.hwm = new Map();
  b.noteSeen = () => {};
  b.emitTimeline = () => {};
  b.refreshLaneWhosHere = async () => {};
  b.fetchAgent = async () => ({ agent });
  const out = [];
  b.emitEvent = (e) => out.push(e);
  for (const event of events) await b.handleLogEvent({ id: agent.id, event });
  return out;
}

test("RunnerBackend emits upstream_exit for an upstream exit only: never after a cancel, never for a plain non-zero exit", async () => {
  const agent = { id: "rn-w1", provider: "opencode", status: "closed", labels: { role: "worker" } };
  const now = Date.now();
  const died = [
    { seq: 0, ts: now, type: "created", provider: "opencode" },
    { seq: 1, ts: now, type: "input", text: PROMPT },
    { seq: 2, ts: now, type: "error", message: "Internal error: Internal service failure" },
    { seq: 3, ts: now, type: "exit", code: 1, error: ERR, upstream: true },
  ];
  const ev = (await backendEvents(died, agent)).filter((e) => e.kind === "upstream_exit");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].agentId, "rn-w1");
  assert.equal(ev[0].error, ERR);
  assert.equal(ev[0].ts, now);
  const cancelled = [...died.slice(0, 2), { seq: 2, ts: now, type: "cancel" }, { seq: 3, ts: now, type: "exit", code: 1, error: ERR, upstream: true }];
  assert.equal((await backendEvents(cancelled, agent)).filter((e) => e.kind === "upstream_exit").length, 0, "a cancel never respawns");
  const plain = [...died.slice(0, 3), { seq: 3, ts: now, type: "exit", code: 1, error: "opencode exited (code 1) after: bad tool schema", upstream: false }];
  assert.equal((await backendEvents(plain, agent)).filter((e) => e.kind === "upstream_exit").length, 0, "not upstream");
});

test("runner-lifecycle forwards upstream_exit to the agent.upstream_exit hook with error + ts", () => {
  const src = readFileSync(new URL("../server/backend/runner-lifecycle.mjs", import.meta.url), "utf8");
  assert.match(src, /upstream_exit: "agent\.upstream_exit"/);
  assert.match(src, /ev\.kind === "upstream_exit"\) Object\.assign\(payload, \{ error: ev\.error, ts: ev\.ts \}\)/);
});

test("upstreamRespawnPlan / respawnLabels (pure)", () => {
  const tl = [{ item: { type: "user_message", text: "go" } }, { item: { type: "error", message: "x" } }];
  const w = { role: "worker" };
  assert.deepEqual(upstreamRespawnPlan(tl, { role: "worker" }, w), { prompt: "go" });
  assert.deepEqual(upstreamRespawnPlan([{ ...tl[0], turnEnd: true }, tl[1]], {}, w), { skip: "not-first-turn" }, "a finished first turn");
  assert.deepEqual(upstreamRespawnPlan([{ item: { type: "user_message", text: "  " } }], {}, w), { skip: "no-prompt" });
  assert.deepEqual(upstreamRespawnPlan(tl, { digestFor: "rn-x" }, w), { skip: "role-worker" }, "a digest agent is not a task");
  assert.deepEqual(upstreamRespawnPlan(tl, {}, { role: "worker", ageMs: Number.NaN }), { skip: "stale-exit" });
  const l = respawnLabels({ team: "t", job: "j", ord: "2", stakes: "high", wf: "dsf", tier: "cheap", [RESPAWNED_AS_LABEL]: "rn-z", digestTurn: "9" }, "Implement - Sonnet", "rn-d");
  assert.deepEqual(l, { team: "t", job: "j", ord: "2", stakes: "high", profile: "Implement - Sonnet", [RESPAWN_OF_LABEL]: "rn-d" });
});

// ---- R2 (Tier A review FAIL 1/2/1 on 2e3b9f49) ----

const EOF_ERR = "opencode exited (code 1) after: API Error: unexpected EOF"; // TRANSIENT_ERROR (A4) and upstream at once

test("R2 H1: turn_ended(failed) + upstream_exit for one transient exit -> exactly one follow-up run (the A4 resend), no respawn", async () => {
  const f = fakeRunner({ id: "rn-h1a" });
  await withHost(f, async (host) => {
    // Lifecycle order: the exit's failed turn_ended is dispatched (and awaited) before upstream_exit.
    await emitFailedTurn(host, f, "rn-h1a", EOF_ERR);
    await emitExit(host, f, "rn-h1a", { error: EOF_ERR });
    await sleep(150); // past the 30 ms A4 backoff
  });
  assert.equal(f.sends.filter((s) => s.id === "rn-h1a").length, 1, "one A4 resend");
  assert.equal(f.created.length, 0, "no respawn next to it");
  assert.match(metrics("rn-h1a").at(-1).text, /reason=a4-retry-scheduled/);
});

test("R2 H1: reverse order (upstream_exit first) -> the respawn claims it and A4 never resends the dead worker", async () => {
  const f = fakeRunner({ id: "rn-h1b" });
  await withHost(f, async (host) => {
    await emitExit(host, f, "rn-h1b", { error: EOF_ERR });
    await emitFailedTurn(host, f, "rn-h1b", EOF_ERR);
    await sleep(150);
  });
  assert.equal(f.created.length, 1, "one respawn");
  assert.equal(f.sends.filter((s) => s.id === "rn-h1b").length, 0, "no A4 resend to the dead worker");
});

test("R2 H1: a non-transient upstream failure (Internal service failure) with both hooks -> A4 does nothing, one respawn", async () => {
  const f = fakeRunner({ id: "rn-h1c" });
  await withHost(f, async (host) => {
    await emitFailedTurn(host, f, "rn-h1c", ERR);
    await emitExit(host, f, "rn-h1c");
    await sleep(150);
  });
  assert.equal(f.created.length, 1);
  assert.equal(f.sends.filter((s) => s.id === "rn-h1c").length, 0);
});

test("R2 M1: a replacement that already finished and was archived still blocks a second respawn (restart, label write lost)", async () => {
  const f = fakeRunner({ id: "rn-m1" });
  await withHost(f, (host) => emitExit(host, f, "rn-m1"));
  assert.equal(f.created.length, 1);
  delete f.agents.get("rn-m1").labels[RESPAWNED_AS_LABEL];
  f.agents.get("rn-new-1").archivedAt = new Date().toISOString();
  await withHost(f, (host) => emitExit(host, f, "rn-m1"));
  assert.equal(f.created.length, 1, "the archived replacement is found");
  assert.match(metrics("rn-m1").at(-1).text, /reason=already-respawned\(rn-new-1\)/);
});

test("R2 M2: a P5c role-name worker (profile=Implement) is respawned off the failed family, not skipped as no-alternate", async () => {
  const f = fakeRunner({ id: "rn-m2", labels: { ...LABELS, profile: "Implement" } });
  await withHost(f, (host) => emitExit(host, f, "rn-m2"));
  assert.equal(f.created.length, 1, metrics("rn-m2").at(-1)?.text);
  const n = f.created[0];
  assert.notEqual(n.provider.split("/")[0], "opencode");
  assert.equal(n.labels.profile, "Implement", "still the role name: the spawn hook routes it");
  assert.equal(n.labels[RESPAWN_OF_LABEL], "rn-m2");
});

test("R2 L1: capped providers are skipped, everything capped -> no-alternate, unknown/missing tool kinds block, no ts -> stale-exit", async () => {
  // claude capped: the alternate is neither opencode (failed) nor claude.
  const f1 = fakeRunner({ id: "rn-l1-cap" });
  await withHost(f1, (host) => emitExit(host, f1, "rn-l1-cap"), { cappedProviders: ["claude"] });
  assert.equal(f1.created.length, 1, metrics("rn-l1-cap").at(-1)?.text);
  assert.ok(!["opencode", "claude"].includes(f1.created[0].provider.split("/")[0]), f1.created[0].provider);
  // Every family capped: nothing to respawn on.
  const all = ["claude", "codex", "gemini", "opencode", "antigravity", "copilot", "cursor", "qwen", "kimi", "deepseek"];
  const f2 = fakeRunner({ id: "rn-l1-none" });
  await withHost(f2, (host) => emitExit(host, f2, "rn-l1-none"), { cappedProviders: all });
  assert.equal(f2.created.length, 0);
  assert.match(metrics("rn-l1-none").at(-1).text, /reason=no-alternate/);
  // A tool call with no kind (Claude adapter) or an unknown/other kind counts as a possible edit.
  for (const [name, detail] of [["nokind", {}], ["other", { kind: "other" }], ["weird", { kind: "frobnicate" }]]) {
    const id = `rn-l1-${name}`;
    const f = fakeRunner({ id, timeline: [{ type: "user_message", text: PROMPT }, { type: "tool_call", name: "mcp tool", detail }, { type: "error", message: ERR }] });
    await withHost(f, (host) => emitExit(host, f, id));
    assert.equal(f.created.length, 0, name);
    assert.match(metrics(id).at(-1).text, /reason=tool-edits\(mcp tool\)/, name);
  }
  // An exit with no ts can't prove it is fresh.
  const f3 = fakeRunner({ id: "rn-l1-nots" });
  await withHost(f3, (host) => emitExit(host, f3, "rn-l1-nots", { ts: null }));
  assert.equal(f3.created.length, 0);
  assert.match(metrics("rn-l1-nots").at(-1).text, /reason=stale-exit/);
});
