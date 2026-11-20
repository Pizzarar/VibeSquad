// G1 (PLAN_INBOX_TOP3_1119, unit-buddy-midturn-restart): an auto-restarted Buddy's successor gets the owner's unanswered message.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performBrainstormRestart, resetBrainstormRestartState, unansweredOwnerMessages } from "../server/brainstorm.mjs";
import { seedDefaultPack } from "../server/profiles.mjs";

process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";

const ev = (seq, type, extra = {}) => ({ seq, ts: seq, type, ...extra });

test("unansweredOwnerMessages: owner inputs after the last completed turn only; agent sends, steers and a cancelled turn_done do not count", () => {
  const events = [
    ev(0, "input", { text: "old question", owner: true }),
    ev(1, "output", { text: "old answer" }),
    ev(2, "turn_done", { stopReason: "end_turn" }),
    ev(3, "input", { text: "lead report", senderId: "rn-lead" }),
    ev(4, "input", { text: "send it", owner: true }),
    ev(5, "input", { text: "context nudge", steerOnly: true }),
    ev(6, "output", { text: "On it, dispatching" }),
    ev(7, "cancel"),
    ev(8, "turn_done", { stopReason: "cancelled" }),
    ev(9, "input", { text: "  and the P1 one too  ", owner: true }),
  ];
  assert.deepEqual(unansweredOwnerMessages(events), { text: "send it\n\nand the P1 one too", lastSeq: 9 });
  assert.deepEqual(unansweredOwnerMessages(events.slice(0, 3)), { text: "", lastSeq: 2 }, "answered by a completed turn");
  assert.deepEqual(unansweredOwnerMessages(events, { afterSeq: 8 }), { text: "and the P1 one too", lastSeq: 9 });
  assert.deepEqual(unansweredOwnerMessages(events, { afterSeq: 9 }), { text: "", lastSeq: 9 });
  assert.deepEqual(unansweredOwnerMessages(null), { text: "", lastSeq: -1 });
  const long = unansweredOwnerMessages([ev(0, "input", { text: "x".repeat(9_000) + "END", owner: true })]).text;
  assert.ok(long.length < 8_100 && long.endsWith("END"), "capped, newest words kept");
});

function setup() {
  const rootDir = mkdtempSync(join(tmpdir(), "vs-buddy-carry-"));
  mkdirSync(join(rootDir, "docs", "brainstorm"), { recursive: true });
  writeFileSync(join(rootDir, "teams.json"), JSON.stringify({ teams: [{ id: "t", name: "T", lanes: [{ id: "l", name: "L" }] }] }));
  writeFileSync(join(rootDir, "docs", "brainstorm", "l.md"), "# Brief\n\n## Open\n- x\n", "utf8");
  process.env.VIBESQUAD_ROOT = rootDir;
  process.env.VIBESQUAD_HOME = join(rootDir, "home");
  const profilesPath = join(rootDir, "profiles.json");
  seedDefaultPack(profilesPath);
  resetBrainstormRestartState();
  const creates = [];
  const sends = [];
  const agentClient = {
    async fetchAgents() { return []; },
    async createAgent(req) { creates.push(req); return { id: `rn-succ${creates.length}`, labels: req.labels }; },
    async updateAgent() {},
    async archiveAgent() {},
    async cancelAgent() {},
    async sendAgentPrompt(id, text, opts) { sends.push({ id, text, opts }); },
  };
  const oldAgent = { id: "rn-2391c3a0b51f", provider: "antigravity-cli", status: "idle", labels: { role: "brainstorm", team: "t", lane: "l", profile: "Brainstorm - Gemini" } };
  return { rootDir, profilesPath, agentClient, creates, sends, oldAgent };
}

test("G1: an auto restart puts the owner's unanswered message in the successor's first input", async () => {
  const { rootDir, profilesPath, agentClient, creates, sends, oldAgent } = setup();
  const events = [
    ev(0, "input", { text: "earlier, answered", owner: true }),
    ev(1, "turn_done", { stopReason: "end_turn" }),
    ev(2, "input", { text: "send it", owner: true }),
    ev(3, "output", { text: "dispatching" }),
    ev(4, "error", { message: "agent exited" }),
  ];
  const r = await performBrainstormRestart(
    { agentId: oldAgent.id, oldAgent, reason: "auto-token-limit", usedTokens: 158_000, agentClient, profilesPath, backstopDelayMs: 60_000, readAgentEvents: () => events },
    rootDir,
  );
  assert.equal(r.ok, true);
  assert.equal(creates.length, 1);
  assert.match(creates[0].initialPrompt, /Pending message from the user to answer now:\nsend it\s*$/);
  assert.doesNotMatch(creates[0].initialPrompt, /earlier, answered/);
  assert.equal(r.pendingPrompt, undefined, "the carried text is not handed back to the drawer as a draft");
  assert.equal(sends.length, 0, "nothing arrived late");
});

test("G1: nothing unanswered -> the auto-retire boot tail, unchanged", async () => {
  const { rootDir, profilesPath, agentClient, creates, oldAgent } = setup();
  const events = [ev(0, "input", { text: "send it", owner: true }), ev(1, "output", { text: "done" }), ev(2, "turn_done", { stopReason: "end_turn" })];
  await performBrainstormRestart(
    { agentId: oldAgent.id, oldAgent, reason: "auto-token-limit", agentClient, profilesPath, backstopDelayMs: 60_000, readAgentEvents: () => events },
    rootDir,
  );
  assert.doesNotMatch(creates[0].initialPrompt, /Pending message from the user/);
  assert.match(creates[0].initialPrompt, /Keep this first turn small/);
});

test("G1: a caller's pendingPrompt wins; a manual restart does not scan the old log", async () => {
  const { rootDir, profilesPath, agentClient, creates, oldAgent } = setup();
  let reads = 0;
  const events = [ev(0, "input", { text: "from the log", owner: true })];
  await performBrainstormRestart(
    { agentId: oldAgent.id, oldAgent: { ...oldAgent }, reason: "auto-token-limit", pendingPrompt: "from the drawer", agentClient, profilesPath, backstopDelayMs: 60_000, readAgentEvents: () => (reads++, events) },
    rootDir,
  );
  assert.match(creates[0].initialPrompt, /answer now:\nfrom the drawer/);
  assert.doesNotMatch(creates[0].initialPrompt, /from the log/);
  resetBrainstormRestartState();
  await performBrainstormRestart(
    { agentId: "rn-other", oldAgent: { ...oldAgent, id: "rn-other" }, reason: "manual", agentClient, profilesPath, backstopDelayMs: 60_000, readAgentEvents: () => (reads++, events) },
    rootDir,
  );
  assert.equal(reads, 0);
  assert.doesNotMatch(creates[1].initialPrompt, /from the log/);
});

test("G1: an owner message that reaches the old Buddy while the successor spawns is forwarded to the successor as the owner's", async () => {
  const { rootDir, profilesPath, agentClient, creates, sends, oldAgent } = setup();
  const base = [ev(0, "input", { text: "q", owner: true }), ev(1, "turn_done", { stopReason: "end_turn" })];
  let calls = 0;
  const readAgentEvents = () => (++calls === 1 ? base : [...base, ev(2, "input", { text: "wait, also X", owner: true }), ev(3, "cancel")]);
  const r = await performBrainstormRestart(
    { agentId: oldAgent.id, oldAgent, reason: "auto-token-limit", agentClient, profilesPath, backstopDelayMs: 60_000, readAgentEvents },
    rootDir,
  );
  assert.doesNotMatch(creates[0].initialPrompt, /Pending message/);
  assert.deepEqual(sends, [{ id: r.newAgentId, text: "wait, also X", opts: { owner: true } }]);
});
