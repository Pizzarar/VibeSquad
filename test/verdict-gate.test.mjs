// idea-170 + idea-175: reviewer verdicts are handled in code. (1) the standing rule, (2) a digest's done entry starts with the
// worker's own `PASS|FAIL H/M/L <hash>` line byte-for-byte (code wins over the digest's word; reviewer without one -> NO-VERDICT),
// (3) `vs verdict <reviewer> --branch <b>` exits 0 only on the reviewer's first-line PASS matching the branch tip.
// A real Runner + runner HTTP server + VS middleware on a temp VIBESQUAD_HOME, as in api-caller-gate.test.mjs.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });

const HOME = tmp("vs-verdict-home-");
const ROOT = tmp("vs-verdict-root-");
process.env.VIBESQUAD_HOME = HOME;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
delete process.env.VS_AGENT_ID;
delete process.env.PASEO_AGENT_ID;
delete process.env.VS_AGENT_TOKEN;
writeFileSync(path.join(ROOT, "teams.json"), JSON.stringify({ teams: [{ id: "sq", name: "Squad", paths: [], lanes: [{ id: "sq", name: "Hub", hub: true }, { id: "art", name: "Art" }] }] }), "utf8");

const { Runner } = await import("../runner/runner.mjs");
const { createServer: createRunnerServer, writeDiscovery } = await import("../runner/server.mjs");
const { RunnerClient } = await import("../server/backend/runner-client.mjs");
const { RunnerBackend } = await import("../server/backend/runner-backend.mjs");
const { createVibesquadMiddleware, verbatimDigestText } = await import("../server/vibesquad-api.mjs");
const { STANDING_RULES, renderLessonsDigest } = await import("../server/lessons.mjs");
const { extractVerdictLine, digestVerdictText, evaluateVerdictGate, isReviewerAgent, GATE_EXIT } = await import("../server/verdict.mjs");
const { commandVerdict } = await import("../cli/vs.mjs");
const { unverifiedDigestText } = await import("../server/hooks/agent-duties.ts").catch(() => ({})); // .ts loads under tsx only

/** Fake provider: the reply is the prompt itself, so a test controls the agent's last assistant message exactly. */
function fakeAdapter() {
  return {
    canPark: true,
    start({ id, emit }) {
      setImmediate(() => emit("session", { sessionId: `sess-${id}` }));
      return { pid: 5000, ready: Promise.resolve(), send(text) { emit("status", { status: "running" }); emit("output", { text }); emit("status", { status: "idle" }); }, cancel() {}, kill() {} };
    },
  };
}
const ADMIN = "adm1n-t0k";
const runnerHome = path.join(HOME, "runner");
const runner = new Runner({ dir: path.join(runnerHome, "agents"), adapters: { claude: fakeAdapter() }, parkGraceMs: 60_000, bgProbe: null });
const runnerSrv = createRunnerServer(runner, { token: ADMIN, hash: "h" });
writeDiscovery(runnerHome, { port: await listen(runnerSrv), token: ADMIN });
const backend = new RunnerBackend({ client: new RunnerClient({ home: runnerHome, env: {} }), hooks: false, buildPrefix: async () => "", whosHere: async () => {} });
const api = createVibesquadMiddleware(ROOT, { backend });
const vsSrv = http.createServer((req, res) => api(req, res, () => { res.statusCode = 404; res.end("no"); }));
const vsPort = await listen(vsSrv);
after(async () => { await close(vsSrv); await close(runnerSrv); runner.shutdown(); });

const lead = runner.create({ provider: "claude", cwd: ROOT, meta: { team: "sq", lane: "art", role: "lead", labels: {} } });
/** A worker whose last assistant message is `reply`; resolves once the reply is on its timeline. */
async function worker(reply, { profile, title } = {}) {
  const id = runner.create({ provider: "claude", cwd: ROOT, prompt: reply, meta: { team: "sq", lane: "art", role: "worker", ...(profile ? { profile } : {}), ...(title ? { title } : {}), labels: { "vs.parent": lead } } });
  for (let i = 0; i < 100; i++) {
    const tl = await backend.fetchAgentTimeline(id, { direction: "tail" });
    if (tl.entries.some((e) => e.item?.type === "assistant_message" && e.item.text)) return id;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no reply on ${id}`);
}
const digestFor = (workerId) => runner.create({ provider: "claude", cwd: ROOT, meta: { team: "sq", lane: "art", role: "worker", profile: "Pre-check - Flash", labels: { digestFor: workerId } } });
async function digestLog(digestId, text) {
  const r = await fetch(`http://127.0.0.1:${vsPort}/__vibesquad/vs-log`, {
    method: "POST",
    headers: { "x-vs-agent-id": digestId, "x-vs-agent-token": runner.tokensById.get(digestId), "content-type": "application/json" },
    body: JSON.stringify({ team: "sq", lane: "art", type: "done", text, refs: [] }),
  });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  return body.entry;
}

// ---------------------------------------------------------------------------- (1) standing rule

test("standing rule: merge only on the reviewer's own first-line verdict (verbatim, rendered into the lessons digest)", () => {
  const rule = "Merge only on the reviewer's own first-line verdict PASS|FAIL H/M/L <tip-hash>, never a digest summary; the hash must match the branch tip.";
  assert.ok(STANDING_RULES.includes(rule));
  assert.ok(renderLessonsDigest({ storePath: path.join(HOME, "no-lessons.jsonl") }).includes(`- ${rule}`));
});

// ---------------------------------------------------------------------------- (2) verdict extraction

test("extractVerdictLine: the whole PASS/FAIL line byte-for-byte (any line of the message), null when missing", () => {
  assert.equal(extractVerdictLine("FAIL 1/0/1 3528a4c stale lock in watch\r\nH1: ..."), "FAIL 1/0/1 3528a4c stale lock in watch");
  assert.equal(extractVerdictLine("Review done.\nPASS 0/0/0 ecba323\n"), "PASS 0/0/0 ecba323");
  assert.equal(extractVerdictLine("PASS: looks good 74/74"), null, "no H/M/L + hash shape");
  assert.equal(extractVerdictLine("I would say PASS 0/0/0 ecba323"), null, "must start a line");
  assert.equal(extractVerdictLine(""), null);
});

test("digestVerdictText: PASS kept, FAIL copied verbatim, inverted digest word -> the code's line wins and is marked", () => {
  const pass = digestVerdictText({ workerText: "PASS 0/0/0 ecba323\nall good", digestText: "PASS: review clean, 67/67", reviewer: true });
  assert.equal(pass.text, "PASS 0/0/0 ecba323 — review clean, 67/67");
  assert.equal(pass.mismatch, false);
  const fail = digestVerdictText({ workerText: "FAIL 1/2/1 683e4b4 escalation never closes\nH1 ...", digestText: "FAIL: 1 high", reviewer: true });
  assert.ok(fail.text.startsWith("FAIL 1/2/1 683e4b4 escalation never closes"), fail.text);
  const inverted = digestVerdictText({ workerText: "FAIL 1/0/1 3528a4c\nH1: race", digestText: "PASS: reviewer approved the fix", reviewer: true });
  assert.ok(inverted.text.startsWith("FAIL 1/0/1 3528a4c — VERDICT-MISMATCH: digest said PASS"), inverted.text);
  assert.equal(inverted.mismatch, true);
  assert.ok(!/^\s*PASS\b/.test(inverted.text));
  const already = digestVerdictText({ workerText: "PASS 0/0/1 47f3310", digestText: "PASS 0/0/1 47f3310 — guard fixed", reviewer: true });
  assert.equal(already.text, "PASS 0/0/1 47f3310 — guard fixed", "a digest that already copied the line is left as is");
});

test("digestVerdictText: a reviewer with no verdict line logs NO-VERDICT; a non-reviewer's text is unchanged", () => {
  const nv = digestVerdictText({ workerText: "Looks fine to me, PASS overall.", digestText: "PASS: reviewer is happy", reviewer: true });
  assert.equal(nv.text, "NO-VERDICT: reviewer is happy");
  assert.equal(nv.noVerdict, true);
  const impl = digestVerdictText({ workerText: "PASS, 12/12 tests", digestText: "PASS: unit done, 12/12", reviewer: false });
  assert.equal(impl.text, "PASS: unit done, 12/12");
  assert.ok(isReviewerAgent({ labels: { profile: "Review - Gemini" } }));
  assert.ok(isReviewerAgent({ title: "R2 re-review idea-160", labels: {} }));
  assert.ok(!isReviewerAgent({ title: "Review fix R2", labels: { profile: "Implement - Sonnet" } }));
  assert.ok(!isReviewerAgent({ title: "Implement unit", labels: { profile: "Implement - Sonnet" } }));
});

test("/vs-log: a digest's done entry is rewritten in code from the worker's own message (FAIL kept over a PASS digest, NO-VERDICT, passthrough)", async () => {
  const failing = await worker("FAIL 1/0/1 3528a4c lock not released\nH1: watch-sets.mjs:88", { profile: "Review - Gemini" });
  const e1 = await digestLog(digestFor(failing), "PASS: review approved");
  assert.ok(e1.text.startsWith("FAIL 1/0/1 3528a4c lock not released — VERDICT-MISMATCH: digest said PASS"), e1.text);
  assert.deepEqual(e1.refs, [failing]);
  const vague = await worker("Overall this looks like a PASS to me.", { profile: "Review - Sonnet" });
  assert.equal((await digestLog(digestFor(vague), "PASS: reviewer happy")).text, "NO-VERDICT: reviewer happy");
  const impl = await worker("PASS, 12/12 tests, commit abc1234", { profile: "Implement - Sonnet" });
  assert.equal((await digestLog(digestFor(impl), "PASS: unit done 12/12")).text, "PASS: unit done 12/12");
  // A long reviewer message: the verdict line at the top is not lost to the 2000-char tail cap.
  const long = await worker(`FAIL 2/0/0 deadbee\n${"x".repeat(5000)}`, { profile: "Review - Gemini" });
  assert.ok((await digestLog(digestFor(long), "PASS: fine")).text.startsWith("FAIL 2/0/0 deadbee"));
});

test("verbatimDigestText: non-digest callers and non-done types pass through; an unreadable worker report is marked UNVERIFIED", async () => {
  assert.equal(await verbatimDigestText({ id: "rn-x", role: "worker" }, "done", "PASS: x", backend), "PASS: x");
  assert.equal(await verbatimDigestText({ id: "rn-d", digest: true, digestFor: "rn-w" }, "metric", "m", backend), "m");
  const broken = { fetchAgent: async () => { throw new Error("runner down"); }, fetchAgentTimeline: async () => ({ entries: [] }) };
  assert.equal(await verbatimDigestText({ id: "rn-d", digest: true, digestFor: "rn-w" }, "done", "PASS: x", broken), "UNVERIFIED (worker report unreadable): PASS: x");
});

test("unverifiedDigestText (agent-duties fallback): the verdict line verbatim, NO-VERDICT for a reviewer, unchanged otherwise", { skip: !unverifiedDigestText && "agent-duties.ts needs tsx" }, () => {
  assert.equal(unverifiedDigestText("failed", "Summary first\nFAIL 1/0/0 abc1234 x", { labels: { profile: "Review - Gemini" } }), "UNVERIFIED (digest failed): FAIL 1/0/0 abc1234 x");
  assert.equal(unverifiedDigestText("orphaned", "PASS looks fine", { labels: { profile: "Review - Gemini" } }), "UNVERIFIED (digest orphaned): NO-VERDICT: PASS looks fine");
  assert.equal(unverifiedDigestText("failed", "PASS 12/12\nmore", { labels: { profile: "Implement - Sonnet" } }), "UNVERIFIED (digest failed): PASS 12/12");
  assert.equal(unverifiedDigestText("failed", "still thinking", {}), null);
});

// ---------------------------------------------------------------------------- (3) merge gate

test("evaluateVerdictGate: PASS on the tip -> 0; FAIL, stale hash, no first-line verdict, not a reviewer -> non-zero", () => {
  const tip = "ecba3231f00dfeedbeefcafe0123456789abcdef";
  const rev = { id: "rn-r", title: "Review - Gemini", labels: { profile: "Review - Gemini" } };
  assert.equal(evaluateVerdictGate({ agent: rev, lastMessage: "PASS 0/0/0 ecba323\nnotes", tip }).code, GATE_EXIT.pass);
  assert.equal(evaluateVerdictGate({ agent: rev, lastMessage: "FAIL 1/0/1 ecba323", tip }).code, GATE_EXIT.fail);
  const stale = evaluateVerdictGate({ agent: rev, lastMessage: "PASS 0/0/0 3528a4c", tip, branch: "unit-x" });
  assert.equal(stale.code, GATE_EXIT.staleHash);
  assert.match(stale.reason, /stale review/);
  assert.equal(evaluateVerdictGate({ agent: rev, lastMessage: "Notes first\nPASS 0/0/0 ecba323", tip }).code, GATE_EXIT.noVerdict, "only the FIRST line counts");
  assert.equal(evaluateVerdictGate({ agent: rev, lastMessage: "", tip }).code, GATE_EXIT.noVerdict);
  assert.equal(evaluateVerdictGate({ agent: { id: "rn-i", title: "Implement", labels: { profile: "Implement - Sonnet" } }, lastMessage: "PASS 0/0/0 ecba323", tip }).code, GATE_EXIT.notReviewer);
  assert.equal(evaluateVerdictGate({ agent: rev, lastMessage: "PASS 0/0/0 ecba323", tip: "" }).code, GATE_EXIT.noBranch);
});

test("vs verdict <reviewer> --branch <b>: real runner + real git: PASS on the tip exits 0; FAIL, stale hash, missing verdict, not a reviewer exit non-zero", async () => {
  const repo = tmp("vs-verdict-repo-");
  const git = (...a) => {
    const r = spawnSync("git", a, { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "unit-x");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c1");
  const old = git("rev-parse", "HEAD");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c2");
  const tip = git("rev-parse", "HEAD");
  const makeContext = () => ({ withBackend: (_opts, fn) => fn(backend) });
  const run = async (id, branch = "unit-x") => {
    let out = "";
    let err = "";
    const code = await commandVerdict({ _: [id], branch, cwd: repo }, makeContext, { out: (s) => (out += s), err: (s) => (err += s) });
    return { code, out, err };
  };
  const pass = await run(await worker(`PASS 0/0/1 ${tip.slice(0, 7)}\nL1: nit`, { profile: "Review - Gemini" }));
  assert.equal(pass.code, 0, pass.err);
  assert.equal(pass.out.split("\n")[0], `PASS 0/0/1 ${tip.slice(0, 7)}`, "prints the verdict line");
  const fail = await run(await worker(`FAIL 1/0/0 ${tip.slice(0, 7)}\nH1: bug`, { profile: "Review - Gemini" }));
  assert.equal(fail.code, GATE_EXIT.fail);
  assert.match(fail.err, /REFUSED: FAIL/);
  const stale = await run(await worker(`PASS 0/0/0 ${old.slice(0, 7)}`, { profile: "Review - Gemini" }));
  assert.equal(stale.code, GATE_EXIT.staleHash);
  assert.match(stale.err, /hash mismatch \(stale review\)/);
  const missing = await run(await worker("Looks good, PASS.", { profile: "Review - Gemini" }));
  assert.equal(missing.code, GATE_EXIT.noVerdict);
  assert.match(missing.err, /no verdict line/);
  const notReviewer = await run(await worker(`PASS 0/0/0 ${tip.slice(0, 7)}`, { profile: "Implement - Sonnet", title: "Implement unit-x" }));
  assert.equal(notReviewer.code, GATE_EXIT.notReviewer);
  assert.match(notReviewer.err, /not a reviewer/);
  const noBranch = await run(await worker(`PASS 0/0/0 ${tip.slice(0, 7)}`, { profile: "Review - Gemini" }), "no-such-branch");
  assert.equal(noBranch.code, GATE_EXIT.noBranch);
  await assert.rejects(commandVerdict({ _: ["rn-x"] }, makeContext), /usage: vs verdict/);
  await assert.rejects(commandVerdict({ _: ["rn-x"], branch: "--all" }, makeContext), /--branch must name/);
});

test("vs verdict (idea-177 L1): a verdict message buried under a long tool tail (>50 entries) is still found; no verdict still fails closed", async () => {
  const repo = tmp("vs-verdict-repo-");
  const git = (...a) => { const r = spawnSync("git", a, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git("init", "-q", "-b", "unit-x");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "c1");
  const tip = git("rev-parse", "HEAD");
  const tail = Array.from({ length: 120 }, (_, i) => ({ item: { type: "tool_call", name: `t${i}` } }));
  const mk = (msg) => ({
    withBackend: (_o, fn) => fn({
      fetchAgent: async () => ({ agent: { id: "rn-r", title: "Review", labels: { profile: "Review - Gemini" } } }),
      // honours `limit` like the real backend: only the newest N entries
      fetchAgentTimeline: async (_id, opts = {}) => {
        const all = [...(msg ? [{ item: { type: "assistant_message", text: msg } }] : []), ...tail];
        return { entries: Number(opts.limit) > 0 ? all.slice(-Number(opts.limit)) : all };
      },
    }),
  });
  const run = async (msg) => { let out = ""; let err = ""; const code = await commandVerdict({ _: ["rn-r"], branch: "unit-x", cwd: repo }, () => mk(msg), { out: (s) => (out += s), err: (s) => (err += s) }); return { code, out, err }; };
  const ok = await run(`PASS 0/0/0 ${tip.slice(0, 7)}`);
  assert.equal(ok.code, 0, ok.err);
  assert.equal((await run("")).code, GATE_EXIT.noVerdict);
});
