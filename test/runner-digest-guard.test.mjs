// idea-1046 (PLAN_INBOX_1125E block S): the agent spawn guard keys on what marks a Buddy or a digest, not on a role-name
// prefix. Agents may spawn the R1 Pre-check role and its legacy names; no alias, case or spacing variant reaches a Buddy or
// digest profile, and a digest label from an agent is a 403. Pure rule table + the runner's POST /agents (agent headers).
import "./helpers/clean-env.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Runner, adminOnlyProfile, isDigestMeta, spawnMetaForAgent } from "../runner/runner.mjs";
import { createServer as createRunnerServer } from "../runner/server.mjs";
import { LEGACY_PROFILE_ALIASES } from "../server/profile-aliases.mjs";
import { LEGACY_PROFILE_ROLES, legacyProfileRole } from "../server/profiles.mjs";
import { isDigestAgent } from "../server/identity.mjs";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const lead = { id: "rn-lead", role: "lead", lane: "art", team: "sq", overlord: false };
const worker = { id: "rn-w", role: "worker", lane: "art", team: "sq", overlord: false };
const buddy = { id: "rn-b", role: "brainstorm", lane: "art", team: "sq", overlord: false };
const overlord = { id: "rn-ov", role: "lead", lane: "sq", team: "sq", overlord: true };
const CALLERS = [lead, worker, buddy, overlord];

const PRECHECK_NAMES = ["Pre-check", "pre-check", "PRE-CHECK", "Pre check", "Scout - Flash", "scout - flash", "Check - Haiku", "Audit - DSF"];
const BUDDY_NAMES = [
  "Brainstorm", "brainstorm", "BRAINSTORM", " Brainstorm ", "Brainstorm - Claude", "brainstorm - claude", "Brainstorm-Gemini",
  "BRAINSTORM  -  GEMINI", "brainstorm_claude", "Brainstorm - Opus", "Buddy", "buddy", "BUDDY", "RiffBot", "riffbot", "Riff Bot",
];
const DIGEST_NAMES = ["Pre-check - Flash", "pre-check - flash", "PRE-CHECK-FLASH", "Pre-check  -  Flash", "pre check flash", "Fast", "fast", "FAST"];

test("idea-1046: Pre-check and its legacy names are not admin-only; every Buddy/digest spelling and alias is", () => {
  for (const n of PRECHECK_NAMES) assert.equal(adminOnlyProfile(n), null, n);
  for (const n of ["Implement", "Review", "Planner", "Lead", "Worker", "Implement - Sonnet", "", null, undefined]) assert.equal(adminOnlyProfile(n), null, String(n));
  for (const n of BUDDY_NAMES) assert.equal(adminOnlyProfile(n), "buddy", n);
  for (const n of DIGEST_NAMES) assert.equal(adminOnlyProfile(n), "digest", n);
  // Drift guard against the one alias table and the legacy role column: every name or alias that resolves to the brainstorm
  // role is a Buddy, the digest profile and every alias of it are digests, every other pre-check name is allowed.
  for (const [name, role] of Object.entries(LEGACY_PROFILE_ROLES)) {
    const want = name === "Pre-check - Flash" ? "digest" : role === "brainstorm" ? "buddy" : null;
    assert.equal(adminOnlyProfile(name), want, name);
    assert.equal(adminOnlyProfile(name.toUpperCase()), want, `${name} upper`);
  }
  for (const [alias, target] of Object.entries(LEGACY_PROFILE_ALIASES)) {
    const want = target === "Pre-check - Flash" ? "digest" : LEGACY_PROFILE_ROLES[target] === "brainstorm" ? "buddy" : null;
    assert.equal(adminOnlyProfile(alias), want, alias);
    assert.equal(adminOnlyProfile(alias.toLowerCase()), want, `${alias} lower`);
  }
  // The legacy alias still resolves Scout - Flash to the pre-check role (until P5f/R5), and it is allowed.
  assert.equal(legacyProfileRole("Scout - Flash")?.role, "pre-check");
  // Every DIGEST_NAMES spelling the server's isDigestAgent reads as a digest is refused here (the refusal is a superset).
  for (const n of ["Pre-check - Flash", "pre-check - flash", "Pre-check  -  Flash", "PRE-CHECK-FLASH"]) assert.equal(isDigestAgent({ profile: n }), true, n);
});

test("idea-1046: spawnMetaForAgent lets every agent caller spawn Pre-check as a worker", () => {
  for (const caller of CALLERS) {
    for (const profile of PRECHECK_NAMES) {
      for (const meta of [{ profile }, { labels: { profile } }, { profile, labels: { profile } }]) {
        const m = spawnMetaForAgent(caller, meta);
        assert.equal(m.role, "worker", `${caller.id} ${profile}`);
        assert.equal(m.labels.role, "worker");
        assert.equal(m.labels["vs.parent"], caller.id);
        assert.equal(isDigestMeta(m), false, "never a digest");
      }
    }
  }
});

test("idea-1046: Buddy and digest profiles, aliases and case variants are 403 on either carrier", () => {
  for (const caller of CALLERS) {
    for (const profile of [...BUDDY_NAMES, ...DIGEST_NAMES]) {
      for (const meta of [{ profile }, { labels: { profile } }, { profile: "Pre-check", labels: { profile } }, { profile, labels: { profile: "Pre-check" } }]) {
        assert.throws(() => spawnMetaForAgent(caller, meta), (e) => e.status === 403 && /may not spawn profile/.test(e.message), `${caller.id} ${JSON.stringify(meta)}`);
      }
    }
    assert.throws(() => spawnMetaForAgent(caller, { role: "Brainstorm" }), (e) => e.status === 403 && /brainstorm/.test(e.message));
    assert.throws(() => spawnMetaForAgent(caller, { labels: { role: " BUDDY " } }), (e) => e.status === 403 && /brainstorm/.test(e.message));
  }
});

test("idea-1046: a digest label from an agent is 403 (never silently stripped into a worker), on labels or top-level meta", () => {
  for (const caller of CALLERS) {
    for (const meta of [
      { profile: "Pre-check", labels: { digestFor: "rn-x" } },
      { labels: { digestFor: "rn-x" } },
      { digestFor: "rn-x" },
      { profile: "Pre-check - Flash", labels: { digestFor: "rn-x" } },
      { labels: { digestTurn: "t1" } },
      { profile: "Scout - Flash", digestTurn: "t1" },
      { digestFor: "rn-x", labels: { digestFor: "" } },
    ]) {
      assert.throws(() => spawnMetaForAgent(caller, meta), (e) => e.status === 403 && /digest/.test(e.message), `${caller.id} ${JSON.stringify(meta)}`);
    }
    // Empty markers are not a request: dropped, never stamped.
    const m = spawnMetaForAgent(caller, { profile: "Pre-check", digestFor: "", labels: { digestFor: "", digestTurn: " " } });
    assert.equal(m.digestFor, undefined);
    assert.equal(m.labels.digestFor, undefined);
    assert.equal(m.labels.digestTurn, undefined);
  }
});

test("idea-1046: runner POST /agents with agent headers: Pre-check / Scout - Flash 201, Buddy/digest spellings 403", async () => {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "vs-1046-")), "agents");
  dirs.push(path.dirname(dir));
  const adapter = {
    canPark: true,
    start({ id, emit }) {
      setImmediate(() => emit("session", { sessionId: `sess-${id}` }));
      return { pid: 4242, ready: Promise.resolve(), send() {}, cancel() {}, kill() {} };
    },
  };
  const runner = new Runner({ dir, adapters: { claude: adapter }, parkGraceMs: 60_000, bgProbe: null });
  const mk = (meta) => runner.create({ provider: "claude", cwd: process.cwd(), meta });
  const ids = {
    lead: mk({ team: "sq", lane: "art", role: "lead", labels: {} }),
    buddy: mk({ team: "sq", lane: "art", role: "brainstorm", labels: {} }),
  };
  ids.worker = mk({ team: "sq", lane: "art", role: "worker", labels: { "vs.parent": ids.lead } });
  const srv = createRunnerServer(runner, { token: "adm", hash: "h", onShutdown: () => {} });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  const spawn = async (who, meta) => {
    const r = await fetch(`http://127.0.0.1:${port}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vs-agent-id": who, "x-vs-agent-token": runner.tokensById.get(who) },
      body: JSON.stringify({ provider: "claude", cwd: process.cwd(), meta }),
    });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch { /* empty */ }
    return { status: r.status, body, text };
  };
  try {
    for (const who of [ids.lead, ids.worker]) {
      for (const profile of ["Pre-check", "Scout - Flash"]) {
        const r = await spawn(who, { profile, labels: { profile } });
        assert.equal(r.status, 201, `${who} ${profile}: ${r.text}`);
        const meta = runner.status(r.body.id).meta;
        assert.equal(meta.role, "worker");
        assert.equal(meta.profile, profile);
        assert.equal(meta.labels["vs.parent"], who);
        assert.equal(isDigestMeta(meta), false);
      }
      for (const profile of ["Brainstorm", "brainstorm - claude", "Buddy", "RiffBot", "Pre-check - Flash", "pre-check-flash", "Fast"]) {
        assert.equal((await spawn(who, { profile })).status, 403, `${who} ${profile}`);
        assert.equal((await spawn(who, { labels: { profile } })).status, 403, `${who} labels.profile ${profile}`);
      }
      assert.equal((await spawn(who, { role: "brainstorm" })).status, 403, "role brainstorm");
      assert.equal((await spawn(who, { profile: "Pre-check", labels: { digestFor: ids.worker } })).status, 403, "digestFor");
    }
    assert.equal((await spawn(ids.buddy, { profile: "Brainstorm - Gemini" })).status, 403, "a Buddy may not spawn a Buddy either");
  } finally {
    await new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
    runner.shutdown();
  }
});

// Per3 (R5 alias removal owner) asked for these two by name: they must hold before and after the legacy aliases go.
async function agentSpawnHarness() {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "vs-1046-ab-")), "agents");
  dirs.push(path.dirname(dir));
  const adapter = { canPark: true, start({ id, emit }) { setImmediate(() => emit("session", { sessionId: `sess-${id}` })); return { pid: 4343, ready: Promise.resolve(), send() {}, cancel() {}, kill() {} }; } };
  const runner = new Runner({ dir, adapters: { claude: adapter }, parkGraceMs: 60_000, bgProbe: null });
  const mk = (meta) => runner.create({ provider: "claude", cwd: process.cwd(), meta });
  const ids = { lead: mk({ team: "sq", lane: "art", role: "lead", labels: {} }) };
  ids.worker = mk({ team: "sq", lane: "art", role: "worker", labels: { "vs.parent": ids.lead } });
  const srv = createRunnerServer(runner, { token: "adm", hash: "h", onShutdown: () => {} });
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  const spawn = async (who, meta) => {
    const r = await fetch(`http://127.0.0.1:${port}/agents`, { method: "POST", headers: { "content-type": "application/json", "x-vs-agent-id": who, "x-vs-agent-token": runner.tokensById.get(who) }, body: JSON.stringify({ provider: "claude", cwd: process.cwd(), meta }) });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch { /* empty */ }
    return { status: r.status, body, text };
  };
  const stop = async () => { await new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }); runner.shutdown(); };
  return { runner, ids, spawn, stop };
}

test("idea-1046 (a): an agent spawn of role \"Pre-check\" with no labels.digestFor is ALLOWED", async () => {
  for (const caller of [lead, worker]) {
    const m = spawnMetaForAgent(caller, { profile: "Pre-check", labels: { profile: "Pre-check" } });
    assert.equal(m.role, "worker");
    assert.equal(m.profile, "Pre-check");
    assert.equal(m.labels.digestFor, undefined);
    assert.equal(isDigestMeta(m), false);
    assert.equal(isDigestAgent(m.labels), false, "the server does not read it as a digest either");
  }
  const h = await agentSpawnHarness();
  try {
    for (const who of [h.ids.lead, h.ids.worker]) {
      const r = await h.spawn(who, { profile: "Pre-check", labels: { profile: "Pre-check" } });
      assert.equal(r.status, 201, `${who}: ${r.text}`);
      const meta = h.runner.status(r.body.id).meta;
      assert.equal(meta.role, "worker");
      assert.equal(meta.profile, "Pre-check");
      assert.equal(meta.labels.digestFor, undefined);
      assert.equal(isDigestMeta(meta), false);
    }
  } finally { await h.stop(); }
});

test("idea-1046 (b): a spawn that sets labels.digestFor, or uses the exact DIGEST_PROFILE name, is still REFUSED", async () => {
  const DIGEST_PROFILE = "Pre-check - Flash"; // runner.mjs / identity.mjs / agent-duties.ts DIGEST_PROFILE
  const refused = [
    { profile: "Pre-check", labels: { digestFor: "rn-x" } },
    { labels: { digestFor: "rn-x" } },
    { profile: DIGEST_PROFILE },
    { labels: { profile: DIGEST_PROFILE } },
    { profile: DIGEST_PROFILE, labels: { digestFor: "rn-x" } },
  ];
  for (const caller of CALLERS) {
    for (const meta of refused) assert.throws(() => spawnMetaForAgent(caller, meta), (e) => e.status === 403, `${caller.id} ${JSON.stringify(meta)}`);
  }
  const h = await agentSpawnHarness();
  try {
    for (const who of [h.ids.lead, h.ids.worker]) {
      for (const meta of refused) {
        const r = await h.spawn(who, meta);
        assert.equal(r.status, 403, `${who} ${JSON.stringify(meta)}: ${r.text}`);
      }
    }
  } finally { await h.stop(); }
});
