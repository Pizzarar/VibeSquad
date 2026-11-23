// idea-539/540: held inbox cards. Held = explicit triage --park (parkedAt marker) or a lane needs-you entry naming the card id.
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
  assert.deepEqual([...(await needsYouCardIds({ teamId: "vs", laneId: "bug", baseHome: h }))], ["idea-77"]);
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
