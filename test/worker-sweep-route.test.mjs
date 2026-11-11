// B3 (lean boot): `vs archive --sweep [--apply]` -> POST /__vibesquad/runner/sweep -> hook host sweepDoneWorkersReport.
import test from "node:test";
import assert from "node:assert/strict";
import { handleRunnerApi } from "../server/runner-api.mjs";
import { requestWorkerSweep, commandAgentVerb } from "../cli/vs.mjs";

const call = async (body, host) => {
  const seen = [];
  const res = { statusCode: 0, body: null };
  const backend = { hookHost: async () => host };
  await handleRunnerApi(
    { url: "/__vibesquad/runner/sweep", method: "POST" },
    res,
    { readBody: async () => body, sendJson: (r, code, b) => ((r.statusCode = code), (r.body = b)), backend },
  );
  return { res, seen };
};

test("sweep route: dry run unless body.apply is exactly true", async () => {
  const opts = [];
  const host = { sweepDoneWorkersReport: async (o) => (opts.push(o), { dryRun: !o.apply, archive: [], count: 0 }) };
  assert.equal((await call({}, host)).res.body.dryRun, true);
  assert.equal((await call({ apply: "yes" }, host)).res.body.dryRun, true);
  assert.equal((await call({ apply: true }, host)).res.body.dryRun, false);
  assert.deepEqual(opts, [{ apply: false }, { apply: false }, { apply: true }]);
});

test("sweep route: 503 when hooks are off", async () => {
  const { res } = await call({}, null);
  assert.equal(res.statusCode, 503);
});

test("vs archive --sweep posts apply flag with the local token and prints the report", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(mkdtempSync(join(tmpdir(), "vs-sweep-")), "local-token");
  writeFileSync(file, "a".repeat(64) + "\n");
  const { localProof } = await import("../server/auth.mjs");
  const proofs = [];
  const reqs = [];
  // unit-and-prove-local (X1 E4a L3): the CLI challenges the listener first; a fake that holds the token answers the HMAC.
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/__vibesquad/local-proof") {
      proofs.push({ nonce: u.searchParams.get("c"), token: init.headers?.["x-vibesquad-token"] ?? null });
      return { ok: true, status: 200, json: async () => ({ proof: localProof("a".repeat(64), u.searchParams.get("c"), 1), port: 1 }) };
    }
    reqs.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ dryRun: true, count: 0 }) };
  };
  assert.deepEqual(await requestWorkerSweep({ apply: false, port: 1, file, fetchImpl }), { dryRun: true, count: 0 });
  await requestWorkerSweep({ apply: true, port: 1, file, fetchImpl });
  assert.equal(proofs.length, 2, "one fresh proof per request (no cache)");
  assert.notEqual(proofs[0].nonce, proofs[1].nonce);
  assert.ok(proofs.every((p) => p.token === null), "the challenge never carries the token");
  assert.equal(reqs[0].url, "http://127.0.0.1:1/__vibesquad/runner/sweep");
  assert.equal(reqs[0].init.headers["x-vibesquad-token"], "a".repeat(64));
  assert.equal(reqs[0].init.headers["content-type"], "application/json");
  assert.equal(reqs[0].init.redirect, "error", "a 3xx never forwards the header");
  assert.deepEqual([JSON.parse(reqs[0].init.body), JSON.parse(reqs[1].init.body)], [{ apply: false }, { apply: true }]);
  await assert.rejects(() => requestWorkerSweep({ file: join(tmpdir(), "nope-token"), fetchImpl }), /no local token/);
});
