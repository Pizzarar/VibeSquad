// `vs inbox list`: default shows open cards (parked + accepted); --status all is allowed; bad statuses still error.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli/vs.mjs", import.meta.url));

function card(id, status) {
  const now = new Date().toISOString();
  return { id, text: id, title: id, teamId: "vibesquad", laneId: "bug-chaser", scope: "infra", status, createdAt: now, updatedAt: now };
}

function setup(t) {
  const home = mkdtempSync(path.join(tmpdir(), "vs-inbox-list-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cards = [card("idea-1", "parked"), card("idea-2", "accepted"), card("idea-3", "rejected"), card("idea-4", "archived")];
  writeFileSync(path.join(home, "inbox.json"), JSON.stringify({ cards }));
  const list = (...args) => {
    const r = spawnSync(process.execPath, [CLI, "inbox", "list", "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, VIBESQUAD_HOME: home },
    });
    return { rc: r.status, ids: r.status === 0 ? JSON.parse(r.stdout).map((c) => c.id) : [], err: r.stderr };
  };
  return list;
}

test("vs inbox list: default is open cards (parked + accepted)", (t) => {
  const r = setup(t)();
  assert.equal(r.rc, 0);
  assert.deepEqual(r.ids, ["idea-1", "idea-2"]);
});

test("vs inbox list --status all returns every card instead of throwing", (t) => {
  const r = setup(t)("--status", "all");
  assert.equal(r.rc, 0, r.err);
  assert.deepEqual(r.ids, ["idea-1", "idea-2", "idea-3", "idea-4"]);
});

test("vs inbox list --status rejected / bogus", (t) => {
  const list = setup(t);
  assert.deepEqual(list("--status", "rejected").ids, ["idea-3"]);
  const bad = list("--status", "bogus");
  assert.notEqual(bad.rc, 0);
  assert.match(bad.err, /must be one of/);
});
