import test from "node:test";
import assert from "node:assert/strict";
import { createCrunchToggle, vibeModeChanges, CRUNCH_ON_MESSAGE, CRUNCH_OFF_MESSAGE } from "../server/crunch-toggle.mjs";

// C2 (PLAN_CRUNCH_MODE): live wake on a per-Squad vibeMode toggle. No clock is injected: dedupe is by the vibeMode diff
// (prev vs next teams), not by time, so a fake clock would be inert.

const ag = (id, role, team, lane, extra = {}) => ({ id, status: "idle", labels: { role, team, lane }, ...extra });

function setup(over = {}) {
  const sent = [];
  const logs = [];
  const toggle = createCrunchToggle({
    listAgents: async () => over.agents ?? [],
    send: async (id, text, opts) => sent.push({ id, text, steerOnly: opts?.steerOnly === true }),
    asleepTeams: () => new Set(over.asleep ?? []),
    log: (e) => logs.push(e.text),
  });
  return { toggle, sent, logs };
}

test("vibeModeChanges: only flipped Squads, keyed case-insensitively, absent teams ignored", () => {
  assert.deepEqual(vibeModeChanges([], []), []);
  assert.deepEqual(
    vibeModeChanges(
      [{ id: "vs", vibeMode: false }, { id: "efi", vibeMode: true }],
      [{ id: "VS", vibeMode: true }, { id: "efi", vibeMode: true }],
    ),
    [{ teamId: "VS", from: false, to: true }],
  );
  // a team only in prev (removed) and one only in next (new, off) are not flips
  assert.deepEqual(
    vibeModeChanges(
      [{ id: "gone", vibeMode: true }],
      [{ id: "fresh", vibeMode: false }],
    ),
    [],
  );
});

test("OFF->ON messages each live Buddy/Lead once; busy = steer; workers/digest/archived/other Squad get nothing", async () => {
  const s = setup({
    agents: [
      ag("L", "lead", "vs", "bug"),
      ag("B", "buddy", "vs", "bug"),
      ag("L2", "lead", "vs", "art", { status: "running" }), // busy -> steer
      ag("W", "worker", "vs", "bug"),
      ag("D", "digest", "vs", "bug"),
      ag("AR", "lead", "vs", "bug", { archivedAt: 123 }), // not live
      ag("OL", "lead", "other", "bug"), // other Squad, unchanged
    ],
  });
  await s.toggle.onTeamsSave(
    [{ id: "vs", vibeMode: false }, { id: "other", vibeMode: false }],
    [{ id: "vs", vibeMode: true }, { id: "other", vibeMode: false }],
  );
  assert.deepEqual(s.sent.map((x) => x.id), ["L", "B", "L2"]);
  assert.equal(s.sent.find((x) => x.id === "L").steerOnly, false);
  assert.equal(s.sent.find((x) => x.id === "B").steerOnly, false);
  assert.equal(s.sent.find((x) => x.id === "L2").steerOnly, true);
  for (const x of s.sent) {
    assert.match(x.text, /Crunch mode is ON/);
    assert.match(x.text, /Pick your lean and go/);
  }
  assert.equal(s.logs.length, 3); // one line per message sent
});

test("ON->OFF sends the OFF text to each live Buddy/Lead; busy = steer", async () => {
  const s = setup({
    agents: [ag("L", "lead", "vs", "bug"), ag("B", "brainstorm", "vs", "bug", { status: "running" })],
  });
  await s.toggle.onTeamsSave([{ id: "vs", vibeMode: true }], [{ id: "vs", vibeMode: false }]);
  assert.deepEqual(s.sent.map((x) => x.id), ["L", "B"]);
  for (const x of s.sent) assert.equal(x.text, CRUNCH_OFF_MESSAGE);
  assert.equal(s.sent.find((x) => x.id === "B").steerOnly, true);
  assert.equal(s.sent.find((x) => x.id === "L").steerOnly, false);
});

test("unchanged saves send nothing", async () => {
  const s = setup({ agents: [ag("L", "lead", "vs", "bug")] });
  await s.toggle.onTeamsSave([{ id: "vs", vibeMode: true }], [{ id: "vs", vibeMode: true }]);
  assert.equal(s.sent.length, 0);
  assert.equal(s.logs.length, 0);
});

test("an asleep Squad gets nothing even on a change", async () => {
  const s = setup({ agents: [ag("AL", "lead", "zzz", "bug")], asleep: ["zzz"] });
  await s.toggle.onTeamsSave([{ id: "zzz", vibeMode: false }], [{ id: "zzz", vibeMode: true }]);
  assert.equal(s.sent.length, 0);
  assert.equal(s.logs.length, 0);
});

test("repeated saves with no change send nothing (one ON, then no-op)", async () => {
  const s = setup({ agents: [ag("L", "lead", "vs", "bug")] });
  const off = [{ id: "vs", vibeMode: false }];
  const on = [{ id: "vs", vibeMode: true }];
  await s.toggle.onTeamsSave(off, on);
  assert.equal(s.sent.length, 1);
  await s.toggle.onTeamsSave(on, on); // no change
  assert.equal(s.sent.length, 1);
  assert.equal(s.logs.length, 1);
});

test("CRUNCH_ON_MESSAGE contains the rule text plus the go line", () => {
  assert.match(CRUNCH_ON_MESSAGE, /until the lane has a tryable build/);
  assert.match(CRUNCH_ON_MESSAGE, /Crunch skips asking, not checking/);
  assert.ok(CRUNCH_ON_MESSAGE.endsWith("Pick your lean and go"));
});

test("a send() that throws does not stop the remaining members or other Squads", async () => {
  const sent = [];
  const toggle = createCrunchToggle({
    listAgents: async () => [ag("A", "lead", "vs", "x"), ag("B", "brainstorm", "vs", "x"), ag("C", "lead", "efi", "y")],
    send: async (id) => {
      sent.push(id);
      if (id === "A") throw new Error("dead session");
    },
    asleepTeams: () => new Set(),
    log: () => {},
  });
  await toggle.onTeamsSave([{ id: "vs" }, { id: "efi" }], [{ id: "vs", vibeMode: true }, { id: "efi", vibeMode: true }]);
  assert.deepEqual(sent.sort(), ["A", "B", "C"]);
});

test("a listAgents() that throws does not reject onTeamsSave", async () => {
  const toggle = createCrunchToggle({
    listAgents: async () => { throw new Error("runner down"); },
    asleepTeams: () => new Set(),
    log: () => {},
  });
  await assert.doesNotReject(toggle.onTeamsSave([{ id: "vs" }], [{ id: "vs", vibeMode: true }]));
});

test("a dropped steer (delivered:false) falls back to a normal prompt", async () => {
  const calls = [];
  const toggle = createCrunchToggle({
    listAgents: async () => [ag("A", "lead", "vs", "x", { status: "running" })],
    send: async (id, text, o) => { calls.push(o?.steerOnly === true); return o?.steerOnly ? { delivered: false } : {}; },
    asleepTeams: () => new Set(),
    log: () => {},
  });
  await toggle.onTeamsSave([{ id: "vs" }], [{ id: "vs", vibeMode: true }]);
  assert.deepEqual(calls, [true, false]);
});
