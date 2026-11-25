// @desk D1 (docs/PLAN_DESK_DECISION_DESK.md): structured needs-you fields on `vs log needs-you`,
// `POST/GET /__vibesquad/log`, and `POST/GET /__vibesquad/vs-log`.
import "./setup/hermetic.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p = "vs-ny-") => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const close = (srv) => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });

const HOME = tmp("vs-ny-home-");
const ROOT = tmp("vs-ny-root-");
process.env.VIBESQUAD_HOME = HOME;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
delete process.env.VS_AGENT_ID;
delete process.env.PASEO_AGENT_ID;
delete process.env.VS_AGENT_TOKEN;

writeFileSync(
  path.join(ROOT, "teams.json"),
  JSON.stringify({ teams: [{ id: "sq", name: "Squad", paths: [], lanes: [{ id: "sq", name: "Hub", hub: true }, { id: "desk", name: "Desk" }] }] }),
  "utf8",
);

const { localTokenHeaders } = await import("../server/local-token.mjs");
const { getLocalToken } = await import("../server/auth.mjs");
const { createVibesquadMiddleware } = await import("../server/vibesquad-api.mjs");
const { parseArgs } = await import("../cli/vs.mjs");
const { validateNeedsYouFields, NEEDS_YOU_MAX_FIELD, NEEDS_YOU_MAX_ALTS } = await import("../server/needs-you-fields.mjs");

// Ensure the local token exists on disk for owner-authenticated requests and CLI runs.
getLocalToken();

const mw = createVibesquadMiddleware(ROOT);
const srv = http.createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end("not found"); }));
const port = await listen(srv);
after(() => close(srv));

async function reqJson(method, urlPath, body) {
  const headers = { ...localTokenHeaders(), ...(body !== undefined ? { "content-type": "application/json" } : {}) };
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

test("structured needs-you round-trips through POST and GET /__vibesquad/log with every field", async () => {
  const payload = {
    team: "sq",
    lane: "desk",
    type: "needs-you",
    text: "Make Decision Desk the default Normal landing page?",
    decides: "Whether opening Normal mode lands on Decisions or Overview",
    do: "Make Decision Desk default landing",
    alt: ["Sidebar link only", "Keep Overview default"],
    kind: "yesno",
  };
  const post = await reqJson("POST", "/__vibesquad/log", payload);
  assert.equal(post.status, 200, post.text);
  assert.equal(post.json.type, "needs-you");
  assert.equal(post.json.text, payload.text);
  assert.equal(post.json.summary, payload.text);
  assert.equal(post.json.decides, payload.decides);
  assert.equal(post.json.do, payload.do);
  assert.deepEqual(post.json.alt, payload.alt);
  assert.equal(post.json.kind, "yesno");

  const get = await reqJson("GET", "/__vibesquad/log?team=sq");
  assert.equal(get.status, 200);
  const found = get.json.find((e) => e.ts === post.json.ts && e.text === payload.text);
  assert.ok(found, "stored entry returned on GET /__vibesquad/log");
  assert.equal(found.summary, payload.text);
  assert.equal(found.decides, payload.decides);
  assert.equal(found.do, payload.do);
  assert.deepEqual(found.alt, payload.alt);
  assert.equal(found.kind, "yesno");
});

test("free-text needs-you round-trips unchanged with no structured keys added", async () => {
  const post = await reqJson("POST", "/__vibesquad/log", {
    team: "sq",
    lane: "desk",
    type: "needs-you",
    text: "Plain free-text escalation",
  });
  assert.equal(post.status, 200, post.text);
  assert.equal(post.json.text, "Plain free-text escalation");
  for (const k of ["summary", "decides", "do", "alt", "kind"]) {
    assert.equal(k in post.json, false, `free-text entry must not contain ${k}`);
  }
  const get = await reqJson("GET", "/__vibesquad/log?team=sq");
  const found = get.json.find((e) => e.ts === post.json.ts && e.text === "Plain free-text escalation");
  assert.ok(found);
  for (const k of ["summary", "decides", "do", "alt", "kind"]) {
    assert.equal(k in found, false, `read-back free-text entry must not contain ${k}`);
  }
});

test("bad kind, over-long fields, and too many alts are rejected with 400", async () => {
  const base = { team: "sq", lane: "desk", type: "needs-you", text: "Need a call" };
  const badKind = await reqJson("POST", "/__vibesquad/log", { ...base, kind: "maybe" });
  assert.equal(badKind.status, 400);
  assert.match(badKind.json.error, /invalid kind/i);

  const longDecides = await reqJson("POST", "/__vibesquad/log", { ...base, decides: "d".repeat(NEEDS_YOU_MAX_FIELD + 1) });
  assert.equal(longDecides.status, 400);
  assert.match(longDecides.json.error, /decides.*limit 240/i);

  const longDo = await reqJson("POST", "/__vibesquad/log", { ...base, do: "l".repeat(NEEDS_YOU_MAX_FIELD + 1) });
  assert.equal(longDo.status, 400);
  assert.match(longDo.json.error, /do.*limit 240/i);

  const longAlt = await reqJson("POST", "/__vibesquad/log", { ...base, alt: ["ok", "a".repeat(NEEDS_YOU_MAX_FIELD + 1)] });
  assert.equal(longAlt.status, 400);
  assert.match(longAlt.json.error, /alt.*limit 240/i);

  const tooManyAlts = await reqJson("POST", "/__vibesquad/log", {
    ...base,
    alt: Array.from({ length: NEEDS_YOU_MAX_ALTS + 1 }, (_, i) => `opt ${i}`),
  });
  assert.equal(tooManyAlts.status, 400);
  assert.match(tooManyAlts.json.error, /max 6/i);

  const badAltType = await reqJson("POST", "/__vibesquad/log", { ...base, alt: 123 });
  assert.equal(badAltType.status, 400);
});

test("240-char ask with structured flags succeeds (flags do not eat into text budget)", async () => {
  const maxAsk = "a".repeat(240);
  const maxDecides = "b".repeat(240);
  const maxDo = "c".repeat(240);
  const post = await reqJson("POST", "/__vibesquad/log", {
    team: "sq",
    lane: "desk",
    type: "needs-you",
    text: maxAsk,
    decides: maxDecides,
    do: maxDo,
    alt: ["d".repeat(240)],
    kind: "answer",
  });
  assert.equal(post.status, 200, post.text);
  assert.equal(post.json.text.length, 240);
  assert.equal(post.json.decides.length, 240);
  assert.equal(post.json.do.length, 240);
  assert.equal(post.json.alt[0].length, 240);
});

test("parseArgs parses --decides, --lean, repeatable --alt, and --kind", () => {
  const f = parseArgs([
    "log", "needs-you", "Ship now?",
    "--decides", "Whether beta goes out tonight",
    "--lean", "Ship beta now",
    "--alt", "Wait for D2",
    "--alt", "Skip beta",
    "--kind", "offscreen",
  ]);
  assert.deepEqual(f._, ["log", "needs-you", "Ship now?"]);
  assert.equal(f.decides, "Whether beta goes out tonight");
  assert.equal(f.lean, "Ship beta now");
  assert.deepEqual(f.alt, ["Wait for D2", "Skip beta"]);
  assert.equal(f.kind, "offscreen");
});

test("validateNeedsYouFields ignores non-needs-you types and deduplicates alt matching do", () => {
  assert.equal(validateNeedsYouFields("done", "shipped", { decides: "x" }), null);
  assert.equal(validateNeedsYouFields("needs-you", "plain", {}), null);
  const v = validateNeedsYouFields("needs-you", "Ask?", { do: "Option A", alt: ["option a", "Option B"], kind: "YESNO" });
  assert.deepEqual(v, { summary: "Ask?", do: "Option A", alt: ["Option B"], kind: "yesno" });
});

test("CLI `vs log needs-you` writes structured entry, keeps free-text unchanged, rejects bad flags, and documents flags in --help", () => {
  const cliPath = path.resolve("cli/vs.mjs");
  const env = {
    ...process.env,
    VIBESQUAD_HOME: HOME,
    VIBESQUAD_IGNORE_HOME_TEAMS: "1",
    VIBESQUAD_PORT: String(port),
  };
  delete env.VS_AGENT_ID;
  delete env.PASEO_AGENT_ID;
  delete env.VS_AGENT_TOKEN;

  const help = spawnSync(process.execPath, [cliPath, "--help"], { env, encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /vs log needs-you.*--decides.*--lean.*--alt.*--kind/);

  const structured = spawnSync(
    process.execPath,
    [
      cliPath, "log", "needs-you", "Push master after D1?",
      "--team", "sq", "--lane", "desk",
      "--decides", "Whether origin/master gets D1 before D2 starts",
      "--lean", "Push right after merge",
      "--alt", "Batch with D2",
      "--alt", "Hold until D4",
      "--kind", "yesno",
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(structured.status, 0, structured.stderr);
  const parsed = JSON.parse(structured.stdout.trim());
  assert.equal(parsed.type, "needs-you");
  assert.equal(parsed.summary, "Push master after D1?");
  assert.equal(parsed.decides, "Whether origin/master gets D1 before D2 starts");
  assert.equal(parsed.do, "Push right after merge");
  assert.deepEqual(parsed.alt, ["Batch with D2", "Hold until D4"]);
  assert.equal(parsed.kind, "yesno");

  const freeText = spawnSync(
    process.execPath,
    [cliPath, "log", "needs-you", "Legacy free text", "--team", "sq", "--lane", "desk"],
    { env, encoding: "utf8" },
  );
  assert.equal(freeText.status, 0, freeText.stderr);
  const freeParsed = JSON.parse(freeText.stdout.trim());
  assert.equal(freeParsed.text, "Legacy free text");
  assert.equal("decides" in freeParsed, false);
  assert.equal("kind" in freeParsed, false);

  const wrongType = spawnSync(
    process.execPath,
    [cliPath, "log", "decision", "Decided X", "--team", "sq", "--lane", "desk", "--decides", "nope"],
    { env, encoding: "utf8" },
  );
  assert.notEqual(wrongType.status, 0);
  assert.match(wrongType.stderr, /needs-you entries only/);

  const badKind = spawnSync(
    process.execPath,
    [cliPath, "log", "needs-you", "Ask?", "--team", "sq", "--lane", "desk", "--kind", "bogus"],
    { env, encoding: "utf8" },
  );
  assert.notEqual(badKind.status, 0);
  assert.match(badKind.stderr, /invalid kind/);

  // Verify the JSONL file on disk persisted the structured fields.
  const lines = readFileSync(path.join(HOME, "teams", "sq", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const stored = lines.find((e) => e.ts === parsed.ts && e.summary === "Push master after D1?");
  assert.ok(stored, "structured entry persisted in log.jsonl");
  assert.equal(stored.kind, "yesno");
});
