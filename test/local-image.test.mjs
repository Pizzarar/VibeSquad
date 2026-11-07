import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { handleLocalImage, lookupAgentCwd, resolveAllowedImage } from "../server/vibesquad-api.mjs";

const base = mkdtempSync(join(tmpdir(), "vs-img-"));
const root = join(base, "allowed");
const outside = join(base, "outside");
const agentWorktree = join(base, "worktree-agent-1");
const fakePaseoHome = join(base, "paseo-home");
const fakeAgentsSrv = join(fakePaseoHome, "runner", "agents");
mkdirSync(root);
mkdirSync(outside);
mkdirSync(agentWorktree, { recursive: true });
mkdirSync(fakeAgentsSrv, { recursive: true });
writeFileSync(join(root, "a.png"), "x");
writeFileSync(join(root, "a.txt"), "x");
writeFileSync(join(outside, "b.png"), "x");
writeFileSync(join(agentWorktree, "shot.png"), "PNGDATA");
writeFileSync(join(agentWorktree, "notes.md"), "# no");
writeFileSync(
  join(fakeAgentsSrv, "rn-wt1234.jsonl"),
  JSON.stringify({ seq: 0, ts: 1, type: "created", provider: "claude", model: "m", cwd: agentWorktree, meta: { title: "Worker 1" } }) + String.fromCharCode(10),
  "utf8",
);
const roots = [root];

function invokeLocalImage(url) {
  return new Promise((resolve) => {
    const chunks = [];
    const headers = {};
    const res = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    res.statusCode = 200;
    res.setHeader = (k, v) => {
      headers[k.toLowerCase()] = v;
    };
    const origEnd = res.end.bind(res);
    res.end = (data) => {
      if (data) chunks.push(Buffer.from(data));
      origEnd();
      resolve({ statusCode: res.statusCode, headers, body: Buffer.concat(chunks).toString("utf8") });
    };
    res.on("finish", () => {
      resolve({ statusCode: res.statusCode, headers, body: Buffer.concat(chunks).toString("utf8") });
    });
    handleLocalImage({ method: "GET", url }, res);
  });
}

test("serves images inside an allowed root (file URL and plain path)", () => {
  assert.ok(resolveAllowedImage(pathToFileURL(join(root, "a.png")).href, roots));
  assert.ok(resolveAllowedImage(join(root, "a.png"), roots));
});

test("rejects non-image extensions, outside roots, traversal, junk", () => {
  assert.equal(resolveAllowedImage(join(root, "a.txt"), roots), null);
  assert.equal(resolveAllowedImage(join(outside, "b.png"), roots), null);
  assert.equal(resolveAllowedImage(join(root, "..", "outside", "b.png"), roots), null);
  assert.equal(resolveAllowedImage(`${root}${sep}..${sep}outside${sep}b.png`, roots), null);
  assert.equal(resolveAllowedImage("", roots), null);
  assert.equal(resolveAllowedImage(undefined, roots), null);
  assert.equal(resolveAllowedImage(root + "-evil" + sep + "a.png", roots), null);
});

test("rejects symlink escape", (t) => {
  try {
    symlinkSync(join(outside, "b.png"), join(root, "link.png"));
  } catch {
    return t.skip("symlink not permitted");
  }
  assert.equal(resolveAllowedImage(join(root, "link.png"), roots), null);
});

test("Done-when #3: serves image inside agent cwd looked up by agentId and rejects outside path or forged cwd param", async () => {
  const prevHome = process.env.VIBESQUAD_HOME;
  process.env.VIBESQUAD_HOME = fakePaseoHome;
  try {
    // 1. Server looks up agent cwd from VIBESQUAD_HOME/runner/agents/<agentId>.jsonl
    assert.equal(lookupAgentCwd("rn-wt1234"), agentWorktree);
    assert.equal(lookupAgentCwd("../traversal"), null);
    assert.equal(lookupAgentCwd("unknown-agent-id"), null);

    // 2. resolveAllowedImage allows an image inside agentWorktree when agent cwd is supplied
    const resolved = resolveAllowedImage(join(agentWorktree, "shot.png"), roots, lookupAgentCwd("rn-wt1234"));
    assert.ok(resolved, "Expected image in agent worktree to resolve");

    // 3. HTTP route succeeds (200) for image inside the agent's cwd with ?path=...&agentId=rn-wt1234
    const okRes = await invokeLocalImage(
      `/__vibesquad/local-image?path=${encodeURIComponent(join(agentWorktree, "shot.png"))}&agentId=rn-wt1234`,
    );
    assert.equal(okRes.statusCode, 200);
    assert.equal(okRes.headers["content-type"], "image/png");
    assert.equal(okRes.body, "PNGDATA");

    // 4. Requesting an image outside that agent's cwd with valid agentId is rejected (404)
    const outsideRes = await invokeLocalImage(
      `/__vibesquad/local-image?path=${encodeURIComponent(join(outside, "b.png"))}&agentId=rn-wt1234`,
    );
    assert.equal(outsideRes.statusCode, 404);

    // 5. Passing a forged ?cwd=... query param without a matching server-side agent record is rejected (404)
    const forgedCwdRes = await invokeLocalImage(
      `/__vibesquad/local-image?path=${encodeURIComponent(join(outside, "b.png"))}&cwd=${encodeURIComponent(outside)}`,
    );
    assert.equal(forgedCwdRes.statusCode, 404);

    // 6. Requesting a non-image inside the agent's cwd is rejected (404)
    const nonImgRes = await invokeLocalImage(
      `/__vibesquad/local-image?path=${encodeURIComponent(join(agentWorktree, "notes.md"))}&agentId=rn-wt1234`,
    );
    assert.equal(nonImgRes.statusCode, 404);
  } finally {
    if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
    else process.env.VIBESQUAD_HOME = prevHome;
  }
});
