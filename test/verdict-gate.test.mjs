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

import { budget } from "./helpers/load-budget.mjs";
const { Runner } = await import("../runner/runner.mjs");
const { createServer: createRunnerServer, writeDiscovery } = await import("../runner/server.mjs");
const { RunnerClient } = await import("../server/backend/runner-client.mjs");
const { RunnerBackend } = await import("../server/backend/runner-backend.mjs");
const { createVibesquadMiddleware, verbatimDigestText } = await import("../server/vibesquad-api.mjs");
const { STANDING_RULES, renderLessonsDigest } = await import("../server/lessons.mjs");
const { extractVerdictLine, digestVerdictText, evaluateVerdictGate, isReviewerAgent, isDocsTarget, GATE_EXIT, parseVerdictLine } = await import("../server/verdict.mjs");
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
// The runner server shares this process with spawnSync(git): under load the loop stalls past node's 5s keep-alive, the server then
// reaps an idle socket the client's pool is about to reuse -> ECONNRESET -> RunnerClient 504. Never reap idle sockets here.
runnerSrv.keepAliveTimeout = 0;
writeDiscovery(runnerHome, { port: await listen(runnerSrv), token: ADMIN });
const backend = new RunnerBackend({ client: new RunnerClient({ home: runnerHome, env: {}, requestTimeoutMs: budget(15000) }), hooks: false, buildPrefix: async () => "", whosHere: async () => {} });
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

test("extractVerdictLine: VERDICT: prefix, letter form and bold markers are returned byte-for-byte", () => {
  assert.equal(extractVerdictLine("VERDICT: PASS 0/1/2 abc1234"), "VERDICT: PASS 0/1/2 abc1234");
  assert.equal(extractVerdictLine("**PASS H abc1234**"), "**PASS H abc1234**");
  assert.equal(extractVerdictLine("done\n**FAIL 2/0/1 deadbeef** trailing"), "**FAIL 2/0/1 deadbeef** trailing");
  assert.equal(extractVerdictLine("**VERDICT:** PASS 0/1/2 abc1234"), "**VERDICT:** PASS 0/1/2 abc1234");
  assert.equal(extractVerdictLine("VERDICT: **PASS 0/1/2 abc1234**"), "VERDICT: **PASS 0/1/2 abc1234**");
  // Agrees with the fail-closed gate: the first FAIL wins over an earlier PASS.
  assert.equal(extractVerdictLine("PASS 0/0/0 abc1234\nFAIL 1/0/0 deadbeef"), "FAIL 1/0/0 deadbeef");
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

test("digestVerdictText stamps reviewer=<profile> after the verdict prefix; the gate still parses the stamped line", () => {
  const stamped = digestVerdictText({ workerText: "PASS 0/0/0 ecba323\nall good", digestText: "PASS: review clean, 67/67", reviewer: true, profile: "Review - Gemini" });
  assert.equal(stamped.text, "PASS 0/0/0 ecba323 reviewer=Review - Gemini — review clean, 67/67");
  assert.equal(stamped.verdictLine, "PASS 0/0/0 ecba323", "verdictLine stays the unstamped prefix");
  // no profile -> no stamp (back-compat)
  const plain = digestVerdictText({ workerText: "PASS 0/0/0 ecba323\nall good", digestText: "PASS: review clean, 67/67", reviewer: true });
  assert.equal(plain.text, "PASS 0/0/0 ecba323 — review clean, 67/67");
  // trailing text on the same line: the stamp goes right after the hash, before the trailing text
  const trail = digestVerdictText({ workerText: "FAIL 1/0/1 3528a4c stale lock\nH1", digestText: "FAIL: 1 high", reviewer: true, profile: "Review - Sonnet" });
  assert.equal(trail.text, "FAIL 1/0/1 3528a4c reviewer=Review - Sonnet stale lock — 1 high");
  // idea-300 M1: a digest that already copies the verdict line verbatim (the prompt's happy path) still gets the stamp
  const copied = digestVerdictText({ workerText: "PASS 0/0/0 ecba323", digestText: "PASS 0/0/0 ecba323 — all clean", reviewer: true, profile: "Review - Gemini" });
  assert.equal(copied.text, "PASS 0/0/0 ecba323 reviewer=Review - Gemini — all clean");
  // ...and it is never double-stamped when the digest already carries a reviewer= stamp
  const restamped = digestVerdictText({ workerText: "PASS 0/0/0 ecba323", digestText: "PASS 0/0/0 ecba323 reviewer=Review - Gemini — all clean", reviewer: true, profile: "Review - Gemini" });
  assert.equal(restamped.text, "PASS 0/0/0 ecba323 reviewer=Review - Gemini — all clean");
  // the merge gate's strict parser still reads PASS|FAIL H/M/L <hash> off the stamped line's front
  assert.deepEqual(parseVerdictLine("PASS 0/0/0 ecba323 reviewer=Review - Gemini"), { verdict: "PASS", high: 0, medium: 0, low: 0, severity: null, hash: "ecba323" });
  assert.deepEqual(parseVerdictLine("FAIL 1/0/1 3528a4c reviewer=Review - Sonnet stale lock"), { verdict: "FAIL", high: 1, medium: 0, low: 1, severity: null, hash: "3528a4c" });
});

test("digestVerdictText stamps bold and letter-severity verdicts after the full prefix; the gate still parses the stamped line", () => {
  // letter severity: stamp goes after the hash, before nothing else
  const letter = digestVerdictText({ workerText: "PASS H abc1234", digestText: "PASS: ok", reviewer: true, profile: "Review - Gemini" });
  assert.equal(letter.text, "PASS H abc1234 reviewer=Review - Gemini — ok");
  assert.deepEqual(parseVerdictLine(letter.text), { verdict: "PASS", high: null, medium: null, low: null, severity: "H", hash: "abc1234" });
  // bold around the whole line: stamp lands after the hash, before the closing `**`
  const bold = digestVerdictText({ workerText: "**FAIL 1/0/0 deadbeef**", digestText: "FAIL: rework", reviewer: true, profile: "Review - Gemini" });
  assert.equal(bold.text, "**FAIL 1/0/0 deadbeef reviewer=Review - Gemini** — rework");
  assert.deepEqual(parseVerdictLine(bold.text), { verdict: "FAIL", high: 1, medium: 0, low: 0, severity: null, hash: "deadbeef" });
  // VERDICT: prefix + bold verdict + letter severity, all combined
  const combined = digestVerdictText({ workerText: "VERDICT: **PASS M abc1234**", digestText: "PASS: ok", reviewer: true, profile: "Review - Sonnet" });
  assert.equal(combined.text, "VERDICT: **PASS M abc1234 reviewer=Review - Sonnet** — ok");
  assert.deepEqual(parseVerdictLine(combined.text), { verdict: "PASS", high: null, medium: null, low: null, severity: "M", hash: "abc1234" });
});

test("UX Reviewer is not an H/M/L code reviewer: digest 'done' is not rewritten to NO-VERDICT and the gate says not-a-reviewer", () => {
  for (const agent of [{ labels: { profile: "UX Reviewer - Opus" } }, { title: "UX Reviewer · R3", labels: {} }, { title: "UX review R3", labels: {} }]) {
    assert.equal(isReviewerAgent(agent), false, JSON.stringify(agent));
  }
  const d = digestVerdictText({ workerText: "PASS (no critical or major open)", digestText: "PASS: round 3 clean", reviewer: isReviewerAgent({ labels: { profile: "UX Reviewer - Opus" } }) });
  assert.ok(!d.noVerdict);
  assert.ok(!d.text.startsWith("NO-VERDICT"), d.text);
  const g = evaluateVerdictGate({ agent: { labels: { profile: "UX Reviewer - Opus" } }, lastMessage: "PASS", tip: "abcdef1" });
  assert.equal(g.exitCode ?? g.code, GATE_EXIT.notReviewer);
});

test("/vs-log: a digest's done entry is rewritten in code from the worker's own message (FAIL kept over a PASS digest, NO-VERDICT, passthrough)", async () => {
  const failing = await worker("FAIL 1/0/1 3528a4c lock not released\nH1: watch-sets.mjs:88", { profile: "Review - Gemini" });
  const e1 = await digestLog(digestFor(failing), "PASS: review approved");
  assert.ok(e1.text.startsWith("FAIL 1/0/1 3528a4c reviewer=Review - Gemini lock not released — VERDICT-MISMATCH: digest said PASS"), e1.text);
  assert.deepEqual(e1.refs, [failing]);
  const vague = await worker("Overall this looks like a PASS to me.", { profile: "Review - Sonnet" });
  assert.equal((await digestLog(digestFor(vague), "PASS: reviewer happy")).text, "NO-VERDICT: reviewer happy");
  const impl = await worker("PASS, 12/12 tests, commit abc1234", { profile: "Implement - Sonnet" });
  assert.equal((await digestLog(digestFor(impl), "PASS: unit done 12/12")).text, "PASS: unit done 12/12");
  // idea-382: a docs-target verdict line is kept (stamped), not rewritten to NO-VERDICT.
  const docs = await worker("PASS 0/0/0 docs:docs/lanes/perfection/EXP3.md", { profile: "Review - Gemini" });
  assert.equal((await digestLog(digestFor(docs), "PASS: docs reviewed")).text, "PASS 0/0/0 docs:docs/lanes/perfection/EXP3.md reviewer=Review - Gemini — docs reviewed");
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

test("evaluateVerdictGate: PASS on the tip -> 0; FAIL, stale hash, no verdict, not a reviewer -> non-zero", () => {
  const tip = "ecba3231f00dfeedbeefcafe0123456789abcdef";
  const rev = { id: "rn-r", title: "Review - Gemini", labels: { profile: "Review - Gemini" } };
  assert.equal(evaluateVerdictGate({ agent: rev, lastMessage: "PASS 0/0/0 ecba323\nnotes", tip }).code, GATE_EXIT.pass);
  assert.equal(evaluateVerdictGate({ agent: rev, lastMessage: "FAIL 1/0/1 ecba323", tip }).code, GATE_EXIT.fail);
  const stale = evaluateVerdictGate({ agent: rev, lastMessage: "PASS 0/0/0 3528a4c", tip, branch: "unit-x" });
  assert.equal(stale.code, GATE_EXIT.staleHash);
  assert.match(stale.reason, /stale review/);
  assert.equal(evaluateVerdictGate({ agent: rev, lastMessage: "Notes first\nPASS 0/0/0 ecba323", tip }).code, GATE_EXIT.pass, "the verdict on the last line counts");
  assert.equal(evaluateVerdictGate({ agent: rev, lastMessage: "", tip }).code, GATE_EXIT.noVerdict);
  assert.equal(evaluateVerdictGate({ agent: { id: "rn-i", title: "Implement", labels: { profile: "Implement - Sonnet" } }, lastMessage: "PASS 0/0/0 ecba323", tip }).code, GATE_EXIT.notReviewer);
  assert.equal(evaluateVerdictGate({ agent: rev, lastMessage: "PASS 0/0/0 ecba323", tip: "" }).code, GATE_EXIT.noBranch);
});

// idea-427/437/444/449: accept the canonical numeric counts, a highest-severity letter, a `VERDICT:` prefix,
// markdown bold, and a verdict on the first OR last non-empty line; a bare PASS (no hash) stays unverified.
test("evaluateVerdictGate accepts every verdict form and still rejects no-hash / in-prose FAIL", () => {
  const tip = "abc1234def5678abc1234def5678abc1234def56";
  const rev = { id: "rn-r", title: "Review - Gemini", labels: { profile: "Review - Gemini" } };
  const code = (msg) => evaluateVerdictGate({ agent: rev, lastMessage: msg, tip }).code;
  assert.equal(code("PASS 0/1/2 abc1234"), GATE_EXIT.pass, "canonical numeric counts");
  assert.equal(code("PASS H abc1234"), GATE_EXIT.pass, "highest-severity letter H");
  assert.equal(code("PASS M abc1234"), GATE_EXIT.pass, "highest-severity letter M");
  assert.equal(code("PASS L abc1234"), GATE_EXIT.pass, "highest-severity letter L");
  assert.equal(code("VERDICT: PASS 0/1/2 abc1234"), GATE_EXIT.pass, "VERDICT: prefix");
  assert.equal(code("**PASS 0/1/2 abc1234**"), GATE_EXIT.pass, "markdown bold");
  assert.equal(code("**VERDICT:** PASS 0/1/2 abc1234"), GATE_EXIT.pass, "bold around the VERDICT: prefix");
  assert.equal(code("VERDICT: **PASS 0/1/2 abc1234**"), GATE_EXIT.pass, "bold around the verdict after the prefix");
  assert.equal(code("Findings first.\nPASS 0/1/2 abc1234"), GATE_EXIT.pass, "verdict on the last line");
  const fail = evaluateVerdictGate({ agent: rev, lastMessage: "FAIL H abc1234", tip });
  assert.equal(fail.code, GATE_EXIT.fail);
  assert.match(fail.reason, /highest severity H/);
  assert.equal(code("PASS"), GATE_EXIT.noVerdict, "bare PASS has no hash");
  assert.equal(code("VERDICT: PASS 0/1/2"), GATE_EXIT.noVerdict, "VERDICT: prefix without a hash");
  assert.equal(code("The review FAILed because of a stale lock"), GATE_EXIT.noVerdict, "FAIL inside prose is not a verdict line");
  assert.equal(code("All checks PASS on abc1234"), GATE_EXIT.noVerdict, "PASS inside prose (no H/M/L hash) is not a verdict line");
});

test("evaluateVerdictGate fails closed: any FAIL verdict fails even with a PASS on the first or last line", () => {
  const tip = "abc1234def5678abc1234def5678abc1234def56";
  const rev = { id: "rn-r", title: "Review - Gemini", labels: { profile: "Review - Gemini" } };
  const code = (msg) => evaluateVerdictGate({ agent: rev, lastMessage: msg, tip }).code;
  assert.equal(code("FAIL 1/0/0 abc1234\nPASS 0/0/0 abc1234"), GATE_EXIT.fail, "a FAIL above a last-line PASS still fails");
  assert.equal(code("PASS 0/0/0 abc1234\nFAIL 1/0/0 abc1234"), GATE_EXIT.fail, "a PASS on line 1 above a FAIL still fails");
  assert.equal(code("FAIL 1/0/0 abc1234\nPASS 0/0/0 abc1234\n⚠ API error (attempt 1) EOF"), GATE_EXIT.fail, "a FAIL with trailing transport noise after a last-line PASS still fails");
});

test("parseVerdictLine: canonical numeric, letter form, VERDICT: prefix, bold; negatives return null", () => {
  assert.deepEqual(parseVerdictLine("PASS 0/1/2 abc1234"), { verdict: "PASS", high: 0, medium: 1, low: 2, severity: null, hash: "abc1234" });
  assert.deepEqual(parseVerdictLine("FAIL 1/0/0 deadbeef"), { verdict: "FAIL", high: 1, medium: 0, low: 0, severity: null, hash: "deadbeef" });
  assert.deepEqual(parseVerdictLine("PASS H abc1234"), { verdict: "PASS", high: null, medium: null, low: null, severity: "H", hash: "abc1234" });
  assert.deepEqual(parseVerdictLine("FAIL m 4f110d9"), { verdict: "FAIL", high: null, medium: null, low: null, severity: "M", hash: "4f110d9" });
  assert.deepEqual(parseVerdictLine("VERDICT: PASS 0/1/2 abc1234"), { verdict: "PASS", high: 0, medium: 1, low: 2, severity: null, hash: "abc1234" });
  assert.deepEqual(parseVerdictLine("**PASS 0/1/2 abc1234**"), { verdict: "PASS", high: 0, medium: 1, low: 2, severity: null, hash: "abc1234" });
  assert.deepEqual(parseVerdictLine("**VERDICT:** PASS 0/1/2 abc1234"), { verdict: "PASS", high: 0, medium: 1, low: 2, severity: null, hash: "abc1234" });
  assert.deepEqual(parseVerdictLine("VERDICT: **PASS 0/1/2 abc1234**"), { verdict: "PASS", high: 0, medium: 1, low: 2, severity: null, hash: "abc1234" });
  assert.equal(parseVerdictLine("PASS 0/1/2"), null);
  assert.equal(parseVerdictLine("FAIL"), null);
  assert.equal(parseVerdictLine("the build FAILed for a reason"), null);
});

test("parseVerdictLine accepts a repo-relative docs target (idea-382) and hex shas keep working", () => {
  assert.deepEqual(parseVerdictLine("PASS 0/0/0 docs:docs/lanes/perfection/EXP3.md"), { verdict: "PASS", high: 0, medium: 0, low: 0, severity: null, hash: "docs:docs/lanes/perfection/EXP3.md" });
  assert.deepEqual(parseVerdictLine("FAIL 1/0/0 EXP3.md"), { verdict: "FAIL", high: 1, medium: 0, low: 0, severity: null, hash: "EXP3.md" });
  assert.deepEqual(parseVerdictLine("PASS 0/0/0 docs/lanes/x/SPEC.md"), { verdict: "PASS", high: 0, medium: 0, low: 0, severity: null, hash: "docs/lanes/x/SPEC.md" });
  assert.deepEqual(parseVerdictLine("VERDICT: **PASS 0/0/0 EXP3.md**"), { verdict: "PASS", high: 0, medium: 0, low: 0, severity: null, hash: "EXP3.md" });
  // idea-382 L4: a .md file whose stem is 7-40 hex chars is a docs target, not a sha.
  assert.deepEqual(parseVerdictLine("PASS 0/0/0 deadbeef.md"), { verdict: "PASS", high: 0, medium: 0, low: 0, severity: null, hash: "deadbeef.md" });
  assert.deepEqual(parseVerdictLine("PASS 0/0/0 abcdef1.md"), { verdict: "PASS", high: 0, medium: 0, low: 0, severity: null, hash: "abcdef1.md" });
  // hex shas still parse as before.
  assert.deepEqual(parseVerdictLine("PASS 0/0/0 abc1234"), { verdict: "PASS", high: 0, medium: 0, low: 0, severity: null, hash: "abc1234" });
});

test("parseVerdictLine rejects non-repo-relative docs tokens (idea-382 M3)", () => {
  // URLs / schemes
  assert.equal(parseVerdictLine("PASS 0/0/0 https://example.com/notes.md"), null);
  assert.equal(parseVerdictLine("PASS 0/0/0 docs:https://example.com/notes.md"), null);
  // absolute / drive / traversal paths
  assert.equal(parseVerdictLine("PASS 0/0/0 /etc/passwd.md"), null);
  assert.equal(parseVerdictLine("PASS 0/0/0 ../outside.md"), null);
  assert.equal(parseVerdictLine("PASS 0/0/0 C:/path/notes.md"), null);
  // partial-extension match (no boundary after .md)
  assert.equal(parseVerdictLine("PASS 0/0/0 foo.mdx"), null);
  assert.equal(parseVerdictLine("PASS 0/0/0 foo.md.bak"), null);
  // a truncated docs: token (path with a space) is not a docs target
  assert.equal(parseVerdictLine("PASS 0/0/0 docs:my file.md"), null);
  // in-prose PASS with no H/M/L + docs shape
  assert.equal(parseVerdictLine("PASS 0/0/0 see notes.md"), null);
});

test("parseVerdictLine leaves trailing __ / ** bold markers out of a docs target (idea-382 M3)", () => {
  assert.deepEqual(parseVerdictLine("__PASS 0/0/0 docs:docs/lanes/x/EXP3.md__"), { verdict: "PASS", high: 0, medium: 0, low: 0, severity: null, hash: "docs:docs/lanes/x/EXP3.md" });
  assert.deepEqual(parseVerdictLine("**PASS 0/0/0 EXP3.md**"), { verdict: "PASS", high: 0, medium: 0, low: 0, severity: null, hash: "EXP3.md" });
});

test("isDocsTarget is consistent with DOCS_SRC (idea-382 M3/L4)", () => {
  assert.equal(isDocsTarget("docs:docs/lanes/perfection/EXP3.md"), true);
  assert.equal(isDocsTarget("EXP3.md"), true);
  assert.equal(isDocsTarget("docs/lanes/x/SPEC.md"), true);
  assert.equal(isDocsTarget("deadbeef.md"), true);
  assert.equal(isDocsTarget("3528a4c"), false);
  assert.equal(isDocsTarget("ecba3231f00dfeedbeefcafe0123456789abcdef"), false);
  assert.equal(isDocsTarget("https://example.com/notes.md"), false);
  assert.equal(isDocsTarget("foo.mdx"), false);
  assert.equal(isDocsTarget("/etc/passwd.md"), false);
  assert.equal(isDocsTarget("../outside.md"), false);
  assert.equal(isDocsTarget("C:/path/notes.md"), false);
});

test("extractVerdictLine and digestVerdictText: a docs-target line is kept byte-for-byte, not NO-VERDICT (idea-382)", () => {
  assert.equal(extractVerdictLine("PASS 0/0/0 docs:docs/lanes/perfection/EXP3.md\nnotes"), "PASS 0/0/0 docs:docs/lanes/perfection/EXP3.md");
  assert.equal(extractVerdictLine("Review done.\nFAIL 1/0/0 EXP3.md"), "FAIL 1/0/0 EXP3.md");
  const d = digestVerdictText({ workerText: "PASS 0/0/0 docs:docs/lanes/perfection/EXP3.md\nall good", digestText: "PASS: docs clean", reviewer: true });
  assert.equal(d.text, "PASS 0/0/0 docs:docs/lanes/perfection/EXP3.md — docs clean");
  assert.equal(d.noVerdict, false);
  const inverted = digestVerdictText({ workerText: "PASS 0/0/0 EXP3.md", digestText: "FAIL: no", reviewer: true });
  assert.equal(inverted.mismatch, true);
  assert.ok(inverted.text.startsWith("PASS 0/0/0 EXP3.md — VERDICT-MISMATCH: digest said FAIL"), inverted.text);
});

test("evaluateVerdictGate: a docs target only passes when nothing is gated; with a tip/branch it is a stale hash (idea-382 H1)", () => {
  const rev = { id: "rn-r", title: "Review - Gemini", labels: { profile: "Review - Gemini" } };
  // no tip, no branch -> a docs-only review passes
  const docs = evaluateVerdictGate({ agent: rev, lastMessage: "PASS 0/0/0 docs:docs/lanes/perfection/EXP3.md", tip: "", branch: "" });
  assert.equal(docs.code, GATE_EXIT.pass);
  assert.match(docs.reason, /docs target/);
  // a tip is supplied -> a docs target cannot gate a code branch
  const gated = evaluateVerdictGate({ agent: rev, lastMessage: "PASS 0/0/0 notes.md", tip: "ecba3231f00d1234567890abcdef1234567890ab", branch: "unit-code" });
  assert.equal(gated.code, GATE_EXIT.staleHash);
  assert.match(gated.reason, /docs target can't gate a code branch/);
  // a branch alone (unresolved tip) is still gating -> stale
  const bareBranch = evaluateVerdictGate({ agent: rev, lastMessage: "PASS 0/0/0 EXP3.md", tip: "", branch: "unit-x" });
  assert.equal(bareBranch.code, GATE_EXIT.staleHash);
  // a FAIL docs target still fails closed
  const fail = evaluateVerdictGate({ agent: rev, lastMessage: "FAIL 1/0/0 docs:docs/lanes/x/SPEC.md", tip: "ecba3231f00d" });
  assert.equal(fail.code, GATE_EXIT.fail);
});

test("digestVerdictText: new forms are copied byte-for-byte and the word is still recognized", () => {
  assert.equal(digestVerdictText({ workerText: "VERDICT: PASS 0/1/2 abc1234", digestText: "PASS: ok", reviewer: true }).text, "VERDICT: PASS 0/1/2 abc1234 — ok");
  const bold = digestVerdictText({ workerText: "**FAIL 1/0/0 deadbeef**", digestText: "PASS: fine", reviewer: true });
  assert.equal(bold.mismatch, true);
  assert.ok(bold.text.startsWith("**FAIL 1/0/0 deadbeef** — VERDICT-MISMATCH: digest said PASS"), bold.text);
  assert.equal(digestVerdictText({ workerText: "PASS H abc1234", digestText: "FAIL: no", reviewer: true }).mismatch, true);
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

// idea-265: provider transport noise before the verdict line is skipped; the hash/tip rule is unchanged.
test("evaluateVerdictGate skips transport-noise lines but still needs PASS H/M/L <hash> matching the tip", async () => {
  const { evaluateVerdictGate } = await import("../server/verdict.mjs");
  const agent = { id: "r", title: "Review - Gemini", labels: { profile: "Review - Gemini" } };
  const tip = "abc1234def5678abc1234def5678abc1234def56";
  const noise = "⚠ API error (attempt 1): Post \"https://x/y\": EOF\nAPI error (attempt 2) EOF\n\n";
  assert.equal(evaluateVerdictGate({ agent, lastMessage: `${noise}PASS 0/0/0 abc1234`, tip }).code, 0);
  assert.equal(evaluateVerdictGate({ agent, lastMessage: `${noise}PASS 0/0/0 ffff111`, tip }).code, 3);
  assert.equal(evaluateVerdictGate({ agent, lastMessage: `${noise}VERDICT: PASS 0/0/0`, tip }).code, 2);
  assert.equal(evaluateVerdictGate({ agent, lastMessage: `Some prose\nPASS 0/0/0 abc1234`, tip }).code, 0, "the verdict on the last line counts");
});
