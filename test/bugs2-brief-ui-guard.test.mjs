// Bug2 block 7: UI BriefEditor saves go through the same guard as server brief writes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { briefShrinkWarning } from "../src/pins.ts";
import { createVibesquadMiddleware } from "../server/vibesquad-api.mjs";

test("client pre-check mirrors the server thresholds", () => {
  const big = "x".repeat(1500);
  assert.match(briefShrinkWarning(big, "# tiny"), /would replace a 1500-byte brief with 6 bytes/);
  assert.equal(briefShrinkWarning(big, "y".repeat(400)), "");
  assert.equal(briefShrinkWarning("small", ""), "");
});

async function post(port, body) {
  const r = await fetch(`http://127.0.0.1:${port}/__vibesquad/brainstorm-summary`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}

test("POST /__vibesquad/brainstorm-summary (what BriefEditor calls) refuses a near-empty replace and keeps a backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-bugs2-brief-ui-"));
  const prev = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = join(dir, ".vibesquad");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "docs", "brainstorm"), { recursive: true });
  const mw = createVibesquadMiddleware(repo);
  const server = http.createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    const big = "# Brief\n" + "- decision line\n".repeat(100);
    assert.equal((await post(port, { laneId: "lane-ui", content: big })).status, 200);
    const refused = await post(port, { laneId: "lane-ui", content: "# Brief\n" });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /Refusing to replace/);
    assert.equal(readFileSync(join(repo, "docs", "brainstorm", "lane-ui.md"), "utf8"), big);
    assert.ok(readdirSync(join(dir, ".vibesquad", "brief-history", "lane-ui")).length >= 1);
  } finally {
    await new Promise((r) => server.close(r));
    prev === undefined ? delete process.env.VIBESQUAD_HOME : (process.env.VIBESQUAD_HOME = prev);
    rmSync(dir, { recursive: true, force: true });
  }
});
