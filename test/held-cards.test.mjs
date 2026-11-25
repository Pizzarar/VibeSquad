// idea-539/540: held inbox cards. Held = explicit triage --park (parkedAt marker) or a lane needs-you entry naming the card id.
import "./setup/hermetic.mjs"; // hermetic env for a direct `node --test <file>` run (run-tests.mjs preloads this)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { laneOpenWork, needsYouCardIds } from "../server/idle-lane-kick.mjs";
import { readInboxCards, triageInboxCards } from "../server/inbox.mjs";

const CLI = fileURLToPath(new URL("../cli/vs.mjs", import.meta.url));
const dirs = [];
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const card = (id, extra = {}) => ({ id, title: id, text: id, teamId: "vs", laneId: "bug", scope: "infra", status: "parked", ...extra });
function home(cards, logLines = []) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "held-"));
  dirs.push(h);
  fs.writeFileSync(path.join(h, "inbox.json"), JSON.stringify({ cards }));
  if (logLines.length) {
    fs.mkdirSync(path.join(h, "logs"));
    fs.writeFileSync(path.join(h, "logs", "vs--bug.jsonl"), logLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  return h;
}

test("idle-kick: a card named by a needs-you entry is held; others stay open", async () => {
  const h = home([card("idea-77"), card("idea-78"), card("idea-7")], [{ ts: new Date().toISOString(), type: "needs-you", text: "owner decision on idea-77 needed" }]);
  assert.deepEqual([...(await needsYouCardIds({ teamId: "vs", laneId: "bug", baseHome: h })).keys()], ["idea-77"]);
  const items = await laneOpenWork({ teamId: "vs", laneId: "bug", rootDir: h, baseHome: h });
  assert.deepEqual(items, ["idea-78 idea-78", "idea-7 idea-7"]);
});

test("idle-kick: needs-you ids match whole ids and honor refs; an old (>7d) entry holds nothing", async () => {
  const old = new Date(Date.now() - 9 * 24 * 3_600_000).toISOString();
  const h = home([card("idea-1"), card("idea-12"), card("idea-3")], [
    { ts: new Date().toISOString(), type: "needs-you", text: "waiting", ref: ["idea-12"] },
    { ts: old, type: "needs-you", text: "stale idea-3" },
  ]);
  const items = await laneOpenWork({ teamId: "vs", laneId: "bug", rootDir: h, baseHome: h });
  assert.deepEqual(items, ["idea-1 idea-1", "idea-3 idea-3"]);
});

test("idle-kick: explicit park (parkedAt) is skipped", async () => {
  const h = home([card("idea-1", { parkedAt: "2026-11-21T00:00:00.000Z" }), card("idea-2")]);
  assert.deepEqual(await laneOpenWork({ teamId: "vs", laneId: "bug", rootDir: h, baseHome: h }), ["idea-2 idea-2"]);
});

test("triage --park persists the held marker (and a plain new card has none)", () => {
  const h = home([card("a"), card("b")]);
  triageInboxCards({ action: "update", cardId: "a", patch: { status: "parked" }, baseHome: h });
  const cards = readInboxCards(h);
  assert.ok(cards.find((c) => c.id === "a").parkedAt);
  assert.equal(cards.find((c) => c.id === "b").parkedAt, undefined);
});

test("vs inbox list: held cards are marked and listed under their own header after queued ones", () => {
  const h = home([card("idea-1", { parkedAt: "2026-11-21T00:00:00.000Z" }), card("idea-2")]);
  const r = spawnSync(process.execPath, [CLI, "inbox", "list"], { encoding: "utf8", env: { ...process.env, VIBESQUAD_HOME: h } });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.match(lines[0], /^\[idea-2\]/);
  assert.doesNotMatch(lines[0], /\[held\]/);
  assert.match(lines[1], /^-- held \(1\)/);
  assert.match(lines[2], /^\[idea-1\].*\[held\]$/);
});

test("needs-you hold releases when a decision/you entry naming the card is the same age or newer", async () => {
  const t0 = new Date(Date.now() - 3_600_000).toISOString();
  const h = home([card("idea-1"), card("idea-2"), card("idea-3")], [
    { ts: t0, type: "needs-you", text: "idea-1 idea-2 idea-3 need the owner" },
    { ts: t0, type: "you", text: "idea-1: go" }, // same age: released
    { ts: new Date(Date.now() - 60_000).toISOString(), type: "decision", text: "idea-2 approved" }, // newer: released
    { ts: new Date().toISOString(), type: "decision", text: "unrelated idea-9" }, // names another card: idea-3 stays held
  ]);
  const items = await laneOpenWork({ teamId: "vs", laneId: "bug", rootDir: h, baseHome: h });
  assert.deepEqual(items, ["idea-1 idea-1", "idea-2 idea-2"]);
});

test("an accepted card, or one updated after the needs-you, is never suppressed; the injected clock is honored", async () => {
  const t0 = Date.now() - 3_600_000;
  const log = [{ ts: new Date(t0).toISOString(), type: "needs-you", text: "idea-1 idea-2 idea-3" }];
  const h = home([
    card("idea-1", { status: "accepted", updatedAt: new Date(t0 - 1000).toISOString() }),
    card("idea-2", { updatedAt: new Date(t0 + 1000).toISOString() }),
    card("idea-3", { updatedAt: new Date(t0 - 1000).toISOString() }),
  ], log);
  assert.deepEqual(await laneOpenWork({ teamId: "vs", laneId: "bug", rootDir: h, baseHome: h }), ["idea-1 idea-1", "idea-2 idea-2"]);
  // 8 days later (injected nowMs) the needs-you has aged out, so idea-3 is open again.
  const later = await laneOpenWork({ teamId: "vs", laneId: "bug", rootDir: h, baseHome: h, nowMs: Date.now() + 8 * 24 * 3_600_000 });
  assert.equal(later.length, 3);
});

test("archiving a parked card clears the held marker; list never shows an archived card as held", () => {
  const h = home([card("a", { parkedAt: "2026-11-21T00:00:00.000Z" })]);
  triageInboxCards({ action: "archive", cardId: "a", baseHome: h });
  assert.equal(readInboxCards(h)[0].parkedAt, undefined);
  fs.writeFileSync(path.join(h, "inbox.json"), JSON.stringify({ cards: [card("z", { status: "archived", parkedAt: "2026-11-21T00:00:00.000Z" })] }));
  const r = spawnSync(process.execPath, [CLI, "inbox", "list", "--status", "all"], { encoding: "utf8", env: { ...process.env, VIBESQUAD_HOME: h } });
  assert.doesNotMatch(r.stdout, /held/);
});
