// idea-475: restart aborts name each blocking shell's owner; a shell whose owner agent is archived/exited is counted drainable.
// 11-21: four machine-wide restarts read as blocked by "unowned" shells (009dc978f9, 95d4c3966a, 24f371b7b1, 5f46ef98fc).
// Every holder had an owner and a resolved lane lead; the request's abort reason kept only the deferral message's last 300
// chars (restart-request.mjs clean() slices the tail), which dropped the lead and cut the agent id mid-way.
import test from "node:test";
import assert from "node:assert/strict";
import { blockingLines, deferralMessage, drainedLogRefusal, holderLeads, ownerGone } from "../server/restart-coord.mjs";
import { deferredAbortReason, fitLog, heldByLead, LOG_MAX, stepRequest } from "../server/restart-request.mjs";
import { shellCmdTail } from "../runner/background.mjs";

const TEAMS = [{ id: "efi", name: "EFI", lanes: [{ id: "art-pipeline" }, { id: "ui" }] }];
const lead = { id: "rn-751ab1ef5a73", status: "idle", title: "★ Art39 · lead", labels: { team: "efi", lane: "art-pipeline", role: "lead", ord: "39" } };
const worker = (id, over = {}) => ({ id, status: "idle", title: `${id} · task`, labels: { team: "efi", lane: "art-pipeline", role: "worker", "vs.parent": lead.id }, ...over });

test("ownerGone: archived and exited (non-resumable) owners are gone; live, resumable-lost and missing are not", () => {
  assert.equal(ownerGone(worker("rn-a", { archivedAt: "2026-11-21T00:00:00Z" })), "archived");
  assert.equal(ownerGone(worker("rn-b", { status: "closed" })), "exited");
  assert.equal(ownerGone(worker("rn-c", { exit: { code: 0 } })), "exited");
  assert.equal(ownerGone(worker("rn-d", { status: "closed", resumable: true })), null, "a resumable agent may still want its suite");
  assert.equal(ownerGone(worker("rn-e")), null);
  assert.equal(ownerGone(undefined), null, "missing is unknown, not gone: it keeps blocking");
});

test("holderLeads: owners carry each holder's id/title/team/lane/role/state; dead owners go to gone, not to a lead", () => {
  const agents = [lead, worker("rn-live"), worker("rn-arch", { archivedAt: "2026-11-21T00:00:00Z" })];
  const r = holderLeads(["rn-live", "rn-arch", "rn-ghost"], agents, TEAMS);
  assert.deepEqual(r.leads.map((l) => [l.leadId, l.heldAgents]), [[lead.id, ["rn-live"]]]);
  assert.deepEqual(r.gone, [{ agentId: "rn-arch", reason: "owner archived" }]);
  assert.deepEqual(r.unresolved, [{ agentId: "rn-ghost", reason: "not in the runner's agent list" }]);
  assert.deepEqual(r.owners["rn-live"], { agentId: "rn-live", title: "rn-live · task", team: "efi", lane: "art-pipeline", role: "worker", state: "live" });
  assert.equal(r.owners["rn-arch"].state, "archived");
  assert.equal(r.owners["rn-ghost"].state, "missing");
});

test("blockingLines: owner first, then pid, name, age and the command; NO OWNER cases say so and still give the pid", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const owners = {
    "rn-live": { agentId: "rn-live", title: "ART-PHC1-P2 · review (Gemini)", team: "efi", lane: "art-pipeline", role: "worker", state: "live" },
    "rn-nolane": { agentId: "rn-nolane", title: null, team: null, lane: null, role: null, state: "live" },
    "rn-x": { agentId: "rn-x", title: null, team: null, lane: null, role: null, state: "missing" },
  };
  const heldWork = {
    "rn-live": [{ pid: 16696, name: "powershell", cmd: "python run_godot.py\nprint('GODOT_EXIT')", createdMs: now - 95 * 60000 }],
    "rn-nolane": [{ pid: 12, name: "bash", cmd: "sleep 5", createdMs: now - 30000 }],
    "rn-x": [{ pid: 7, name: "bash", cmd: Array(60).fill("abcd").join(" ") }],
  };
  const lines = blockingLines(["rn-live", "rn-nolane", "rn-x"], { owners, heldWork, unresolved: [{ agentId: "rn-x", reason: "not in the runner's agent list" }], now });
  assert.equal(lines[0], "rn-live [ART-PHC1-P2 review (Gemini)] efi/art-pipeline worker: pid 16696 powershell, 1h35m old: python run_godot.py print( GODOT_EXIT )");
  assert.equal(lines[1], "rn-nolane NO OWNER LANE (no Squad/lane label): pid 12 bash, 30s old: sleep 5");
  // a cut keeps the tail and drops the word it landed in (R2: no half path at the head)
  assert.match(lines[2], /^rn-x NO OWNER \(not in the runner's agent list\): pid 7 bash, age unknown: \.\.\.abcd( abcd){15}$/);
  for (const l of lines) assert.ok(!/["`\n]/.test(l), "pastes into vs send \"...\"");
});

test("deferralMessage: with owners, the Blocking list comes right after the head; dead owners are listed as gone", () => {
  const owners = { "rn-live": { agentId: "rn-live", title: "T", team: "efi", lane: "art-pipeline", role: "worker", state: "live" } };
  const msg = deferralMessage({ held: 2, heldAgents: ["rn-live"], waitSec: 600, leads: [{ lane: "art-pipeline", leadId: lead.id, leadTitle: "★ Art39", heldAgents: ["rn-live"] }], unresolved: [], heldWork: {}, owners, gone: [{ agentId: "rn-arch", reason: "owner archived" }] });
  assert.match(msg, /^deferred: 2 agent\(s\) still hold background work after 600s \(rn-live\)\. Blocking: rn-live \[T\] efi\/art-pipeline worker: no shell listed yet/);
  assert.match(msg, /Owner gone \(counted drainable, not waited on\): rn-arch \(owner archived\)\./);
  // without owners (an older caller) the message is unchanged
  assert.ok(!/Blocking:/.test(deferralMessage({ held: 1, heldAgents: ["rn-live"], waitSec: 1, leads: [], unresolved: [], heldWork: {} })));
});

test("drainedLogRefusal: a dead owner's shell does not block the lane lead's drain; a live worker's does", () => {
  const agents = [lead, worker("rn-live"), worker("rn-arch", { archivedAt: "2026-11-21T00:00:00Z" })];
  assert.equal(drainedLogRefusal(lead.id, { held: { ids: ["rn-arch"], work: {} }, agents, teams: TEAMS }), null);
  assert.match(drainedLogRefusal(lead.id, { held: { ids: ["rn-arch", "rn-live"], work: {} }, agents, teams: TEAMS }), /not drained: .*rn-live/);
});

test("heldByLead: dead-owner holders are listed under gone, never under a lead (they hold no lead's drain)", () => {
  const agents = [lead, worker("rn-live"), worker("rn-arch", { archivedAt: "2026-11-21T00:00:00Z" })];
  const h = heldByLead({ ids: ["rn-live", "rn-arch"], work: { "rn-arch": [{ pid: 5, cmd: "sleep 1" }] } }, agents, TEAMS);
  assert.deepEqual(Object.keys(h.byLead), [lead.id]);
  assert.deepEqual(h.byLead[lead.id].map((x) => x.agentId), ["rn-live"]);
  assert.deepEqual(h.gone, [{ agentId: "rn-arch", work: [{ pid: 5, cmd: "sleep 1" }], reason: "owner archived" }]);
});

// The 11-21 08:16 record, as restart-runtime wrote it (no `blocking`: an older runtime). Its abort read
// "...deferred on background work: 95d4c3966a --background (kills each shell s whole tree)...".
const LEGACY = {
  ok: false, startedAt: "2026-11-21T08:06:37.542Z", finishedAt: "2026-11-21T08:16:45.400Z",
  errors: [`deferred: 1 agent(s) still hold background work after 600s (rn-f395d4c3966a). Ask these leads to drain and hold background suites: vibesquad lead rn-37b05a6f04af (★ Hub14) holds rn-f395d4c3966a (pid 3780: ${"y".repeat(120)}). Idle holders can be stopped with vs stop rn-f395d4c3966a --background (kills each shell's whole tree). Wait for each lead's vs log restart-feedback 'drained restart', then rerun vs restart (it refuses until they have); after it succeeds the leads get 'restart-done' to lift the hold. No timer retries; --kill-background needs the owner's per-run OK.`],
  deferred: { held: 1, heldAgents: ["rn-f395d4c3966a"], leads: [{ team: "vibesquad", lane: "vibesquad", leadId: "rn-37b05a6f04af", leadTitle: "★ Hub14", heldAgents: ["rn-f395d4c3966a"] }], unresolved: [] },
};

test("deferredAbortReason: a legacy record names the full holder id and its lane lead (the tail cut lost both)", () => {
  const t = deferredAbortReason(LEGACY);
  assert.equal(t, "the restart deferred on background work: blocking: rn-f395d4c3966a (vibesquad/vibesquad, lead rn-37b05a6f04af Hub14)");
});

test("stepRequest: a deferred fire aborts with the owner-first reason; the logged line (cut to the log limit) keeps id, title, lane, pid", () => {
  const blocking = ["rn-f395d4c3966a [Hub14 disk survey] vibesquad/vibesquad worker: pid 3780 powershell, 10m old: powershell -File C:/x/survey_part1.ps1"];
  const fired = Date.parse("2026-11-21T08:00:00Z");
  const req = { id: "rr-20261121075958-0bb3", tip: "abc1234", requestedBy: "owner", state: "firing", firedAt: new Date(fired).toISOString(), deadline: new Date(fired).toISOString(), asked: { "rn-37b05a6f04af": { team: "vibesquad", lane: "vibesquad" } } };
  const actions = stepRequest(req, { now: fired + 20 * 60000, results: [{ ...LEGACY, startedAt: new Date(fired + 1000).toISOString(), deferred: { ...LEGACY.deferred, blocking } }] });
  assert.equal(req.state, "aborted");
  // R2 H1: the reason goes to the team log and every asked lead's send: the host path is redacted, owner/title/lane kept
  assert.equal(req.abortReason, "the restart deferred on background work: blocking: rn-f395d4c3966a [Hub14 disk survey] vibesquad/vibesquad worker: pid 3780 powershell, 10m old: powershell -File <host-path>");
  const logLine = fitLog(actions.find((a) => a.kind === "log").text, LOG_MAX - "restart-feedback: ".length);
  assert.match(logLine, /aborted: the restart deferred on background work: blocking: rn-f395d4c3966a \[Hub14 disk survey\] vibesquad\/vibesquad worker: pid 3780/);
  assert.ok(actions.some((a) => a.kind === "send" && a.text.includes("powershell -File <host-path>")), "the asked lead's send carries the whole reason");
  for (const a of actions) assert.ok(!/C:\/x|survey_part1/.test(a.text ?? ""), a.text);
});

test("R2 H1: held commands are host-path redacted in blocking lines, drain asks, refusals and heldByLead; ids, titles, lanes stay", () => {
  const win = String.raw`powershell -NoProfile -File C:\Users\someone\AppData\Local\Temp\probe.ps1 -Out C:\Users\someone\out.txt`;
  const posix = "cd /home/someone/proj && npm test -- --queue";
  const heldWork = { "rn-live": [{ pid: 41, name: "powershell", cmd: win }, { pid: 42, name: "bash", cmd: posix }] };
  const owners = { "rn-live": { agentId: "rn-live", title: "rn-live · task", team: "efi", lane: "art-pipeline", role: "worker", state: "live" } };
  const [line] = blockingLines(["rn-live"], { owners, heldWork, now: 0 });
  assert.match(line, /^rn-live \[rn-live task\] efi\/art-pipeline worker: pid 41 powershell, age unknown: powershell -NoProfile -File <host-path> -Out <host-path>; pid 42 bash, age unknown: cd <host-path> && npm test -- --queue$/);
  const msg = deferralMessage({ held: 1, heldAgents: ["rn-live"], waitSec: 1, leads: [{ lane: "art-pipeline", leadId: lead.id, leadTitle: "★ Art39", heldAgents: ["rn-live"] }], unresolved: [], heldWork, owners });
  const agents = [lead, worker("rn-live")];
  const refusal = drainedLogRefusal(lead.id, { held: { ids: ["rn-live"], work: heldWork }, agents, teams: TEAMS });
  const hb = heldByLead({ ids: ["rn-live"], work: heldWork }, agents, TEAMS);
  const hbCmds = hb.byLead[lead.id][0].work.map((w) => w.cmd);
  assert.deepEqual(hbCmds, ["powershell -NoProfile -File <host-path> -Out <host-path>", "cd <host-path> && npm test -- --queue"]);
  for (const t of [line, msg, refusal, ...hbCmds]) assert.ok(!/someone|[A-Za-z]:[\\/]/.test(t), t);
  assert.match(msg, /rn-live/);
});

test("shellCmdTail strips Claude Code's Bash wrapper before keeping the tail; other commands pass through", () => {
  const wrapped = `/usr/bin/bash -c -l "source /c/snap.sh && eval 'until ! tasklist //FI \\"PID eq 26796\\" | grep -q 26796; do sleep 20; done; echo done' < /dev/null && pwd -P >| /c/Users/x/AppData/Local/Temp/claude-96be-cwd"`;
  assert.match(shellCmdTail(wrapped, 40), /do sleep 20; done; echo done$/);
  assert.equal(shellCmdTail("powershell -File a.ps1"), "powershell -File a.ps1");
  assert.equal(shellCmdTail("ab ".repeat(100).trim(), 160), "ab ".repeat(53).trim(), "tail kept, the cut word dropped");
  // R2: a cut inside a host path drops the fragment ("meone/AppData/...") the server's whole-path redaction would miss
  assert.equal(shellCmdTail("cd C:/Users/someone/AppData/Local/Temp/wt && npm test -- --queue", 50), "&& npm test -- --queue");
});

test("R2 M1: the restart-request loop reads archived records only when a held id is missing, so an archived holder is gone, not unresolved", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createRestartRequestLoop, createRestartRequest, readRestartRequest } = await import("../server/restart-request.mjs");
  const home = mkdtempSync(path.join(os.tmpdir(), "vs-rr-arch-"));
  try {
    const now = Date.parse("2026-11-21T12:00:00Z");
    createRestartRequest(home, { tip: "abc1234", requestedBy: "owner", needs: "server-restart", now });
    const arch = worker("rn-arch", { archivedAt: "2026-11-21T00:00:00Z" });
    let archivedReads = 0;
    let held = { ids: ["rn-live"], work: {} };
    const loop = createRestartRequestLoop({
      home, teams: () => TEAMS, now: () => now, runVs: async () => ({ ok: true }), fire: async () => ({ ok: true }),
      listAgents: async () => [lead, worker("rn-live")],
      listAgentsWithArchived: async () => { archivedReads++; return [lead, worker("rn-live"), arch]; },
      heldList: async () => held,
    });
    await loop.tick();
    assert.equal(archivedReads, 0, "every held id listed: no archived read");
    held = { ids: ["rn-arch"], work: { "rn-arch": [{ pid: 5, cmd: "sleep 1" }] } };
    await loop.tick();
    const req = readRestartRequest(home);
    assert.equal(archivedReads, 1);
    assert.deepEqual(req.held.gone, [{ agentId: "rn-arch", work: [{ pid: 5, cmd: "sleep 1" }], reason: "owner archived" }]);
    assert.deepEqual(req.held.unresolved, [], "not 'not in the runner's agent list'");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
