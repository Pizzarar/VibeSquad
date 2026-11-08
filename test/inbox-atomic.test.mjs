// Pilot2 W2 (arm=dsp) — inbox.json is read-modify-written by the server and the `vs inbox` CLI across processes.
// This test proves the merged file-lock fix: concurrent adds never lose cards or mint duplicate idea-N ids, and a
// concurrent triage keeps both its own change and the adds racing against it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { addInboxCards } from "../server/inbox.mjs";

const inboxUrl = pathToFileURL(fileURLToPath(new URL("../server/inbox.mjs", import.meta.url))).href;

function tmp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "vs-inbox-atomic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runChild(code, home) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["-e", code], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, VIBESQUAD_HOME: home },
    });
    c.on("exit", (rc) => (rc === 0 ? resolve() : reject(new Error(`child exit ${rc}`))));
    c.on("error", reject);
  });
}

function readCards(home) {
  return JSON.parse(readFileSync(path.join(home, "inbox.json"), "utf8"));
}

test("concurrent adds across processes never lose cards or mint duplicate idea-N ids", async (t) => {
  const home = tmp(t);
  const root = tmp(t);
  const procs = 4;
  const per = 40;

  const code = `import(${JSON.stringify(inboxUrl)}).then(m=>{` +
    `const h=${JSON.stringify(home)};` +
    `const r=${JSON.stringify(root)};` +
    `for(let i=0;i<${per};i++){m.addInboxCards({ideas:["card "+process.pid+"-"+i],baseHome:h,teamId:"vibesquad",laneId:"vibesquad"},r);}` +
    `})`;

  await Promise.all(Array.from({ length: procs }, () => runChild(code, home)));

  const cards = readCards(home);
  assert.equal(cards.length, procs * per);
  const ids = cards.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate idea-N ids minted");
  for (const id of ids) assert.match(id, /^idea-\d+$/);
});

test("concurrent add + triage keeps both the adds and the triage change", async (t) => {
  const home = tmp(t);
  const root = tmp(t);

  const seeded = addInboxCards({ ideas: ["seed card"], baseHome: home, teamId: "vibesquad", laneId: "vibesquad" }, root);
  const seedId = seeded.added[0].id;

  const adders = 3;
  const per = 30;

  const addCode = `import(${JSON.stringify(inboxUrl)}).then(m=>{` +
    `const h=${JSON.stringify(home)};` +
    `const r=${JSON.stringify(root)};` +
    `for(let i=0;i<${per};i++){m.addInboxCards({ideas:["add "+process.pid+"-"+i],baseHome:h,teamId:"vibesquad",laneId:"vibesquad"},r);}` +
    `})`;
  const triageCode = `import(${JSON.stringify(inboxUrl)}).then(m=>{` +
    `const h=${JSON.stringify(home)};` +
    `const r=${JSON.stringify(root)};` +
    `m.triageInboxCards({action:"archive",cardId:${JSON.stringify(seedId)},baseHome:h},r);` +
    `})`;

  await Promise.all([
    ...Array.from({ length: adders }, () => runChild(addCode, home)),
    runChild(triageCode, home),
  ]);

  const cards = readCards(home);
  assert.equal(cards.length, 1 + adders * per);
  const ids = cards.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate idea-N ids minted");
  const seedCard = cards.find((c) => c.id === seedId);
  assert.ok(seedCard, "seed card missing");
  assert.equal(seedCard.status, "archived");
});
