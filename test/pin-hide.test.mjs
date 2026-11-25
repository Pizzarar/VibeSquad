// idea-632: `vs pin hide|unhide|remove <lane>` is for the owner's shell or the Overlord of the lane's own Squad only.
// Every refused caller leaves teams.json byte-identical. Runs in its own process (node --test isolates files): the
// VibeSquad home/root and the caller env are set before cli/vs.mjs is imported.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT_DIR = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "vs-pin-hide-"));
const home = join(dir, "home");
const root = join(dir, "root");
mkdirSync(home, { recursive: true });
mkdirSync(join(root, "docs", "brainstorm"), { recursive: true });
writeFileSync(join(home, "local-token"), "a".repeat(64) + "\n"); // the owner proof (X1b)
// The test runner may itself be an agent: scrub every caller claim so only what each case passes counts.
for (const k of Object.keys(process.env)) if (/^(VS_|PASEO_)/.test(k)) delete process.env[k];
process.env.VIBESQUAD_HOME = home;
process.env.VIBESQUAD_ROOT = root;
delete process.env.VIBESQUAD_TEAMS_FILE;

const TEAMS = {
  teams: [
    {
      id: "vibesquad",
      name: "VibeSquad",
      paths: [],
      lanes: [
        { id: "vibesquad", name: "VibeSquad", hub: true, state: "pinned" },
        { id: "bug-chaser", name: "Bug Chaser", code: "bug", state: "pinned" },
        { id: "art", name: "Art", code: "art", state: "pinned", aliases: ["visuals"] },
      ],
    },
    {
      id: "efi",
      name: "EFI",
      paths: [],
      lanes: [
        { id: "efi", name: "EFI", hub: true, state: "pinned" },
        { id: "scav", name: "Scav", state: "pinned" },
      ],
    },
  ],
};
const teamsFile = join(home, "teams.json");
const reset = () => writeFileSync(teamsFile, JSON.stringify(TEAMS, null, 2));
const raw = () => readFileSync(teamsFile, "utf8");
const laneOf = (id, squad = "vibesquad") => JSON.parse(raw()).teams.find((t) => t.id === squad).lanes.find((l) => l.id === id);
const logLines = (squad = "vibesquad") => {
  const f = join(home, "teams", squad, "log.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
reset();

const { commandPinHide, commandPinMerge, assertPinAdminCaller } = await import("../cli/vs.mjs");

test.after(() => rmSync(dir, { recursive: true, force: true }));

const quiet = async (fn) => {
  const orig = [process.stdout.write, process.stderr.write];
  const out = [];
  process.stdout.write = (c) => (out.push(String(c)), true);
  process.stderr.write = (c) => (out.push(String(c)), true);
  try {
    return { code: await fn(), out: out.join("") };
  } finally {
    [process.stdout.write, process.stderr.write] = orig;
  }
};

const OWNER_ENV = { VIBESQUAD_HOME: home }; // no agent id + the readable local token
const AGENT = "rn-abcdef123456";
const agentEnv = { VS_AGENT_ID: AGENT, VS_AGENT_TOKEN: "t0k" };
// /verify-agent stub: the runner's record is the caller's identity (the VS_ROLE/VS_LANE/VS_TEAM env are never read).
const as = (role, lane, team = "vibesquad") => async ({ id, token }) => {
  assert.equal(id, AGENT);
  assert.equal(token, "t0k");
  return { id, role, lane, team };
};
const noAgents = async () => [];
const run = (verb, lane, { flags = {}, env = OWNER_ENV, ...opts } = {}) =>
  quiet(() => commandPinHide(verb, { _: [lane], team: "vibesquad", ...flags }, { env, listAgents: noAgents, ...opts }));

test("idea-632 gate: worker, lane lead, Buddies and another Squad's Overlord are refused; teams.json unchanged", async () => {
  reset();
  const before = raw();
  const refused = [
    ["plain worker", as("worker", "bug-chaser")],
    ["lane lead (non-hub)", as("lead", "bug-chaser")],
    ["hub Buddy", as("brainstorm", "vibesquad")],
    ["lane Buddy", as("brainstorm", "art")],
    ["other Squad's Overlord", as("lead", "efi", "efi")],
    ["digest on the hub", as("digest", "vibesquad")],
  ];
  for (const verb of ["hide", "unhide", "remove"]) {
    for (const [who, verify] of refused) {
      await assert.rejects(run(verb, "art", { env: agentEnv, verify }), /only the owner or the Overlord of Squad vibesquad/, `${verb}: ${who}`);
    }
  }
  await assert.rejects(run("hide", "art", { env: agentEnv, verify: as("lead", "efi", "efi") }), /of Squad efi/, "the message names the caller's Squad");
  assert.equal(raw(), before, "no refused caller wrote teams.json");
  assert.equal(logLines().length, 0, "no refused caller logged a decision");
});

test("idea-632 gate: no owner proof, an id without a token, a wrong token and env spoofs are refused", async () => {
  reset();
  const before = raw();
  const verifyNever = async () => { throw new Error("verify must not be called"); };
  await assert.rejects(run("hide", "art", { env: {} }), /no owner proof/, "a scrubbed shell is not the owner");
  await assert.rejects(run("hide", "art", { env: { HOME: join(dir, "nobody") } }), /no owner proof/, "a home with no local token");
  // an agent id (even with the owner's home readable) is never the owner; without a token it is a 403 before the runner is asked
  const spoof = { ...OWNER_ENV, VS_AGENT_ID: AGENT, VS_ROLE: "lead", VS_LANE: "vibesquad", VS_TEAM: "vibesquad" };
  await assert.rejects(run("hide", "art", { env: spoof, verify: verifyNever }), /403: .*no VS_AGENT_TOKEN/);
  await assert.rejects(run("hide", "art", { env: { ...OWNER_ENV, PASEO_AGENT_ID: AGENT }, verify: verifyNever }), /403/, "PASEO_AGENT_ID counts as an agent id");
  // a leftover token with the id cleared is still an agent shell, not the owner
  await assert.rejects(run("hide", "art", { env: { ...OWNER_ENV, VS_AGENT_TOKEN: "t0k" } }), /no owner proof/);
  const verify403 = async () => { throw Object.assign(new Error("agent token invalid"), { status: 403 }); };
  await assert.rejects(run("hide", "art", { env: { ...spoof, VS_AGENT_TOKEN: "bad" }, verify: verify403 }), /403: .*token does not match/);
  await assert.rejects(run("hide", "art", { env: agentEnv, verify: async () => ({ id: "rn-someoneelse0", role: "lead", lane: "vibesquad", team: "vibesquad" }) }), /403: the runner does not know/);
  await assert.rejects(run("hide", "art", { env: agentEnv, verify: async () => { throw new Error("ECONNREFUSED"); } }), /could not verify/, "runner down: refused, not waved through");
  assert.equal(raw(), before);
});

test("idea-632: the owner and the same-Squad Overlord may hide; hide is reversible with unhide", async () => {
  reset();
  const logStart = logLines().length;
  // owner
  let r = await run("hide", "@art");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Hid Art \(art\) in VibeSquad\. Undo: vs pin unhide art/);
  assert.equal(laneOf("art").hidden, true);
  assert.ok(laneOf("art").hiddenAt);
  r = await run("hide", "art");
  assert.equal(r.code, 0);
  assert.match(r.out, /already hidden; nothing changed/);
  r = await run("unhide", "visuals"); // alias resolves
  assert.equal(r.code, 0, r.out);
  const art = laneOf("art");
  assert.equal(art.hidden, false);
  assert.equal("hiddenAt" in art, false);
  assert.equal(art.state, "pinned", "hide/unhide never touch state");
  assert.deepEqual(art, { ...TEAMS.teams[0].lanes[2], hidden: false }, "round trip restores the lane (plus an explicit hidden:false)");
  r = await run("unhide", "art", { flags: { json: true } });
  assert.equal(JSON.parse(r.out).changed, false, "unhide of a shown lane is a no-op");

  // same-Squad Overlord, verified by token
  r = await run("hide", "art", { env: agentEnv, verify: as("lead", "vibesquad"), flags: { json: true } });
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.out);
  assert.deepEqual([j.ok, j.changed, j.lane, j.verb, j.undo], [true, true, "art", "hide", "vs pin unhide art"]);
  assert.equal(laneOf("art").hidden, true);
  r = await run("unhide", "art", { env: agentEnv, verify: as("lead", "vibesquad") });
  assert.equal(r.code, 0, r.out);
  assert.equal(laneOf("art").hidden, false);

  // decisions are logged under the verified caller, with the undo hint
  const log = logLines().slice(logStart).filter((e) => e.type === "decision");
  assert.equal(log.length, 4);
  assert.match(log[0].text, /^vs pin hide Art \(art\); undo: vs pin unhide art$/);
  assert.equal(log[2].agent, AGENT, "the Overlord's entry is attributed to its verified id");
  assert.ok(log.every((e) => e.lane === "art" && e.refs[0] === "art"));
  assert.equal(laneOf("bug-chaser").hidden, undefined, "other lanes untouched");
});

test("idea-632: remove marks the lane removed (nothing archived) and is a no-op twice", async () => {
  reset();
  const r = await run("remove", "art", { env: agentEnv, verify: as("lead", "vibesquad") });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Undo: vs pin new "Art" --team vibesquad/);
  const art = laneOf("art");
  assert.equal(art.state, "removed");
  assert.ok(art.removedAt);
  assert.match((await run("remove", "art")).out, /already removed/);
});

test("idea-632: the Overlord cannot reach another Squad's lanes", async () => {
  reset();
  const before = raw();
  await assert.rejects(
    quiet(() => commandPinHide("remove", { _: ["scav"], team: "efi" }, { env: agentEnv, verify: as("lead", "vibesquad"), listAgents: noAgents })),
    /only the owner or the Overlord of Squad efi/,
  );
  assert.equal(raw(), before);
  const ok = await quiet(() => commandPinHide("remove", { _: ["scav"], team: "efi" }, { env: agentEnv, verify: as("lead", "efi", "efi"), listAgents: noAgents }));
  assert.equal(ok.code, 0, ok.out);
  assert.equal(laneOf("scav", "efi").state, "removed");
});

test("idea-632: the hub lane is refused even for the owner", async () => {
  reset();
  const before = raw();
  for (const verb of ["hide", "remove"]) await assert.rejects(run(verb, "vibesquad"), /hub lane/);
  assert.equal(raw(), before);
});

test("idea-632: a lane with live agents is refused unless --force; an unreadable roster refuses too", async () => {
  reset();
  const before = raw();
  const roster = [
    { id: "rn-live00000001", title: "Art lead", labels: { team: "vibesquad", lane: "art", role: "lead" } },
    { id: "rn-live00000002", labels: { team: "vibesquad", lead: "visuals" } }, // worker found by its lead label + alias
    { id: "rn-gone00000003", labels: { team: "vibesquad", lane: "art" }, archivedAt: "2026-11-01T00:00:00Z" },
    { id: "rn-other0000004", labels: { team: "efi", lane: "art" } }, // same lane id, other Squad
  ];
  for (const verb of ["hide", "remove"]) {
    const r = await run(verb, "art", { listAgents: async () => roster });
    assert.equal(r.code, 1, `${verb} refused with live agents`);
    assert.match(r.out, /art has 2 live agent\(s\): Art lead \(rn-live00000001, lead\), rn-live00000002 \(rn-live00000002, worker\)/);
    await assert.rejects(run(verb, "art", { listAgents: async () => { throw new Error("runner down"); } }), /could not read the agent roster.*refusing/);
  }
  assert.equal(raw(), before, "nothing written while live agents block");

  const forced = await run("hide", "art", { listAgents: async () => roster, flags: { force: true } });
  assert.equal(forced.code, 0, forced.out);
  assert.match(forced.out, /with --force over 2 live agent\(s\)/);
  assert.equal(laneOf("art").hidden, true);
  // unhide never consults the roster
  const un = await run("unhide", "art", { listAgents: async () => { throw new Error("must not be read"); } });
  assert.equal(un.code, 0, un.out);
  const removed = await run("remove", "art", { listAgents: async () => { throw new Error("runner down"); }, flags: { force: true } });
  assert.equal(removed.code, 0, removed.out);
  assert.equal(laneOf("art").state, "removed");
});

test("idea-632: assertPinAdminCaller takes only the runner's record, never the env role", async () => {
  const teams = TEAMS.teams;
  await assert.doesNotReject(assertPinAdminCaller("hide", "vibesquad", teams, OWNER_ENV));
  assert.deepEqual(await assertPinAdminCaller("hide", "vibesquad", teams, agentEnv, { verify: as("lead", "vibesquad") }), { owner: false, id: AGENT });
  await assert.rejects(
    assertPinAdminCaller("hide", "vibesquad", teams, { ...agentEnv, VS_ROLE: "lead", VS_LANE: "vibesquad", VS_TEAM: "vibesquad" }, { verify: as("worker", "art") }),
    /only the owner/,
  );
});

test("idea-632 CLI: vs pin hide from a worker shell is refused; from the owner's shell it works", () => {
  reset();
  const before = raw();
  const base = { PATH: process.env.PATH, VIBESQUAD_HOME: home, VIBESQUAD_ROOT: root }; // no runner.json in the temp home: nothing is booted
  const vs = (env, ...args) => spawnSync(process.execPath, ["cli/vs.mjs", "pin", ...args], { cwd: ROOT_DIR, env, encoding: "utf8" });
  const worker = vs({ ...base, VS_AGENT_ID: AGENT, VS_ROLE: "lead", VS_LANE: "vibesquad", VS_TEAM: "vibesquad" }, "hide", "art", "--team", "vibesquad");
  assert.equal(worker.status, 1, worker.stdout);
  assert.match(worker.stderr, /403/);
  const tokened = vs({ ...base, VS_AGENT_ID: AGENT, VS_AGENT_TOKEN: "forged" }, "remove", "art", "--team", "vibesquad");
  assert.equal(tokened.status, 1, tokened.stdout);
  assert.match(tokened.stderr, /vs pin remove: (403|could not verify)/, "an unverifiable token is refused");
  assert.equal(raw(), before);
  // the owner (the roster folds from the empty temp home: no live agents)
  const owner = vs(base, "hide", "art", "--team", "vibesquad");
  assert.equal(owner.status, 0, owner.stderr);
  assert.equal(laneOf("art").hidden, true);
  const back = vs(base, "unhide", "art", "--team", "vibesquad");
  assert.equal(back.status, 0, back.stderr);
  assert.equal(laneOf("art").hidden, false);
});

// `vs pin merge` marks <from> removed, so it is the same security class (it had no gate before). Same gate, plus the
// same-Squad hub Buddy, which HUB_BUDDY_RULES has run the merge after the user confirms.
const briefs = () => {
  for (const id of ["art", "bug-chaser"]) writeFileSync(join(root, "docs", "brainstorm", `${id}.md`), `# Brainstorm Summary · ${id}\n\n## Decided\n- d-${id}\n\n## Open\n- o-${id}\n`);
};
const merge = (env, verify, team = "vibesquad") =>
  quiet(() => commandPinMerge({ _: ["art", "bug-chaser"], note: "fold", team }, { env, ...(verify ? { verify } : {}) }));

test("pin merge gate: worker, lane lead, lane Buddy, other Squads' Overlord/Buddy, no proof and no token are refused", async () => {
  reset();
  briefs();
  const before = raw();
  const brief = readFileSync(join(root, "docs", "brainstorm", "bug-chaser.md"), "utf8");
  for (const [who, verify] of [
    ["plain worker", as("worker", "bug-chaser")],
    ["lane lead (non-hub)", as("lead", "bug-chaser")],
    ["lane Buddy", as("brainstorm", "art")],
    ["other Squad's Overlord", as("lead", "efi", "efi")],
    ["other Squad's hub Buddy", as("brainstorm", "efi", "efi")],
    ["digest on the hub", as("digest", "vibesquad")],
  ]) {
    await assert.rejects(merge(agentEnv, verify), /vs pin merge: .*only the owner, the Overlord or the hub Buddy of Squad vibesquad/, who);
  }
  await assert.rejects(merge({}), /no owner proof/, "a scrubbed shell");
  const verifyNever = async () => { throw new Error("verify must not be called"); };
  await assert.rejects(merge({ ...OWNER_ENV, VS_AGENT_ID: AGENT, VS_ROLE: "lead", VS_LANE: "vibesquad", VS_TEAM: "vibesquad" }, verifyNever), /403/, "id without token");
  await assert.rejects(merge(agentEnv, async () => { throw Object.assign(new Error("bad"), { status: 403 }); }), /403/, "wrong token");
  assert.equal(raw(), before, "teams.json unchanged");
  assert.equal(readFileSync(join(root, "docs", "brainstorm", "bug-chaser.md"), "utf8"), brief, "the target brief is unchanged");
});

test("pin merge gate: the owner, the same-Squad Overlord and the same-Squad hub Buddy may merge", async () => {
  for (const [who, env, verify, agent] of [
    ["owner", OWNER_ENV, null, null], // the owner shell keeps its resolved name
    ["Overlord", agentEnv, as("lead", "vibesquad"), AGENT],
    ["hub Buddy", agentEnv, as("brainstorm", "vibesquad"), AGENT],
  ]) {
    reset();
    briefs();
    const logStart = logLines().length;
    const r = await merge(env, verify);
    assert.equal(r.code, 0, `${who}: ${r.out}`);
    assert.equal(laneOf("art").state, "removed", who);
    assert.ok(laneOf("bug-chaser").aliases.includes("art"), who);
    const entry = logLines().slice(logStart).find((e) => e.type === "decision");
    if (agent) assert.equal(entry.agent, agent, `${who}: the decision is attributed to the verified caller`);
    else assert.notEqual(entry.agent, AGENT);
  }
  // the hub-Buddy allowance is merge-only: the same Buddy still cannot hide or remove
  reset();
  await assert.rejects(run("remove", "art", { env: agentEnv, verify: as("brainstorm", "vibesquad") }), /only the owner or the Overlord/);
});

test("pin merge CLI: a worker shell is refused and teams.json is unchanged", () => {
  reset();
  briefs();
  const before = raw();
  const env = { PATH: process.env.PATH, VIBESQUAD_HOME: home, VIBESQUAD_ROOT: root, VS_AGENT_ID: AGENT, VS_ROLE: "lead", VS_LANE: "vibesquad", VS_TEAM: "vibesquad" };
  const r = spawnSync(process.execPath, ["cli/vs.mjs", "pin", "merge", "art", "bug-chaser", "--team", "vibesquad"], { cwd: ROOT_DIR, env, encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /vs pin merge: 403/);
  assert.equal(raw(), before);
});
