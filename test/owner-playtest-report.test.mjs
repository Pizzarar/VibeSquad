// PTO-B1 (docs/lanes/playtest-overlay/PLAN_V1.md, Tier A: it touches the auth route table): the local owner (loopback +
// the per-install local token, auth.mjs isLocalOwner) may call the E6a report/thread handlers with a REQUIRED teamId.
// Owner cards are stamped `[Owner playtest]`; tester gating and tester answers are unchanged; nobody else gains the routes.
// PTO-B1b (Tier A): a paired OWNER device that authenticates with a header token (Authorization: Bearer / x-vs-device-token)
// gains the same routes from a remote socket (VS on another box over Tailscale); a cookie-only or relayed owner device does not.
// Every request goes through the real middleware on a loopback or a Meshnet (non-loopback) socket. Attacker cases are
// marked "attacker:".
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, test } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "vs-ptob1-home-"));
const ROOT = mkdtempSync(join(tmpdir(), "vs-ptob1-root-"));
process.env.VIBESQUAD_HOME = HOME;
process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
process.env.PASEO_HOME = join(HOME, "paseo");
process.env.PASEO_DAEMON = "127.0.0.1:1";
process.env.VIBESQUAD_MESHNET_IP = "100.64.0.7";
delete process.env.VS_AGENT_ID;
delete process.env.VS_AGENT_TOKEN;
delete process.env.PASEO_AGENT_ID;

const SECRET_PATH = join(homedir(), "secret-proj", "notes.txt");
const TEAMS = [
  {
    id: "efi",
    name: "EFI",
    paths: [join(homedir(), "secret-proj")],
    lanes: [
      { id: "efi", name: "Hub", hub: true },
      { id: "efi-bugs", name: "Bugs", code: "bug", kind: "bug" },
    ],
  },
  { id: "oth", name: "Other", paths: [], lanes: [{ id: "oth", name: "Oth Hub", hub: true }, { id: "oth-bugs", name: "Oth Bugs", kind: "bug" }] },
  { id: "nobug", name: "No bug lane", paths: [], lanes: [{ id: "nobug", name: "Hub", hub: true }] },
];
writeFileSync(join(ROOT, "teams.json"), JSON.stringify({ teams: TEAMS }), "utf8");
writeFileSync(join(HOME, "teams.json"), JSON.stringify({ teams: TEAMS }), "utf8");

const auth = await import("../server/auth.mjs");
const inbox = await import("../server/inbox.mjs");
const api = await import("../server/vibesquad-api.mjs");
const { createSyntheticRequest } = await import("../server/relay-tunnel.mjs");
after(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});

const agent = (id, team, lane, role) => ({ id, title: `${role} ${lane}`, status: "idle", cwd: join(homedir(), "secret-proj"), labels: { team, lane, role }, provider: "claude" });
const AGENTS = [agent("rn-efibuddy", "efi", "efi-bugs", "brainstorm"), agent("rn-efihub", "efi", "efi", "lead"), agent("rn-othbuddy", "oth", "oth-bugs", "brainstorm")];
const timelines = new Map();
const prompts = [];
const backend = {
  async listAgents() {
    return AGENTS;
  },
  async fetchAgents() {
    return AGENTS;
  },
  async fetchAgentTimeline(id, opts = {}) {
    const entries = timelines.get(id) ?? [];
    return { entries: opts.limit ? entries.slice(-opts.limit) : entries, hasOlder: false };
  },
  async sendAgentPrompt(id, text, opts) {
    prompts.push({ id, text, opts });
  },
  async verifyAgent() {
    return null;
  },
};
const mw = api.createVibesquadMiddleware(ROOT, { backend, verifyAgent: async () => null });

let ipN = 40;
function mkReq({ url, method = "GET", headers = {}, body, raw, local = false, host }) {
  const req = new PassThrough();
  req.url = url;
  req.method = method;
  req.headers = { host: host ?? (local ? "127.0.0.1:4180" : "100.64.0.7:4180"), ...(body !== undefined || raw ? { "content-type": "application/json" } : {}), ...headers };
  req.socket = local ? { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 4180 } : { remoteAddress: `100.64.0.${++ipN}`, localAddress: "100.64.0.7" };
  const payload = raw ?? (body !== undefined ? JSON.stringify(body) : null);
  setImmediate(() => req.end(payload ?? undefined));
  return req;
}
function mkRes() {
  let done;
  const finished = new Promise((r) => (done = r));
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    headersSent: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return this.headers[k.toLowerCase()];
    },
    writeHead(code, h) {
      this.statusCode = code;
      for (const [k, v] of Object.entries(h ?? {})) this.setHeader(k, v);
      this.headersSent = true;
    },
    write(c) {
      this.body += c;
      return true;
    },
    end(b) {
      this.body += b ?? "";
      this.headersSent = true;
      done("end");
    },
  };
  return { res, finished };
}
async function call(opts) {
  const req = mkReq(opts);
  const { res, finished } = mkRes();
  let nextCalled = false;
  const viaNext = new Promise((r) => mw(req, res, () => ((nextCalled = true), r("next"))));
  await Promise.race([finished, viaNext]);
  return { status: res.statusCode, body: res.body, next: nextCalled, json: () => JSON.parse(res.body) };
}
const ownerLocal = () => ({ "x-vibesquad-token": auth.getLocalToken() });
const bearer = (t) => ({ authorization: `Bearer ${t}` });

async function pcPair(name, scope) {
  const start = await call({ url: "/__vibesquad/pair/start", method: "POST", local: true, headers: ownerLocal(), body: scope ?? {} });
  assert.equal(start.status, 200, start.body);
  const r = await call({ url: `/pair?code=${start.json().code}&name=${encodeURIComponent(name)}&format=json` });
  assert.equal(r.status, 200, r.body);
  return r.json().token;
}
const ownerPhone = await pcPair("Owner phone");
const ownerGame = await pcPair("Owner game");
const alice = await pcPair("Alice", { role: "bug-tester", allowedTeams: ["efi"] });
const deviceId = (name) => auth.listDevices().find((d) => d.name === name)?.id;

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const cards = () => inbox.readInboxCards();
const cardById = (id) => cards().find((c) => c.id === id);

const REPORT = "/__vibesquad/tester/report";
const THREAD = "/__vibesquad/tester/thread";
const ownerReport = (body, extra = {}) => call({ url: REPORT, method: "POST", local: true, headers: ownerLocal(), body, ...extra });
const ownerThread = (q) => call({ url: `${THREAD}?${q}`, local: true, headers: ownerLocal() });
const ownerSay = (body) => call({ url: THREAD, method: "POST", local: true, headers: ownerLocal(), body });
const testerReport = (body) => call({ url: REPORT, method: "POST", headers: bearer(alice), body });

describe("owner POST /__vibesquad/tester/report", () => {
  test("creates one [Owner playtest] card on the named Squad's bug lane: telemetry, screenshot, delivery", async () => {
    prompts.length = 0;
    const r = await ownerReport({
      teamId: "EFI",
      text: `Door clips at ${SECRET_PATH}`,
      screenshotBase64: `data:image/png;base64,${PNG_B64}`,
      telemetry: { clickedPoint: { x: 10, y: 20 }, cursorNode: "/root/Main/Door", scene: "res://door.tscn", seed: "s-1", buildHash: "b1", logLines: ["a", "b"], extraKey: { ok: true } },
    });
    assert.equal(r.status, 200, r.body);
    const out = r.json();
    assert.equal(out.ok, true);
    assert.match(out.cardId, /^idea-\d+$/);
    assert.equal(out.laneId, "efi-bugs");
    assert.equal(out.screenshotAttached, true);
    assert.equal(out.delivered, true);
    assert.equal(out.threadAgentId, "rn-efibuddy");
    assert.equal("deduplicated" in out, false);
    const card = cardById(out.cardId);
    assert.ok(card.text.startsWith("[Owner playtest]\n"), card.text.slice(0, 40));
    assert.ok(!card.text.includes("Alpha Tester"));
    assert.equal(card.source, "owner-playtest");
    assert.equal(card.ownerPlaytest, true);
    assert.equal("testerDeviceId" in card, false);
    assert.equal(card.teamId, "efi");
    assert.equal(card.laneId, "efi-bugs");
    assert.equal(card.attachments.length, 1);
    assert.equal(card.telemetry.cursorNode, "/root/Main/Door");
    assert.deepEqual(card.telemetry.extraKey, { ok: true }, "same forward-compat telemetry rules as a tester");
    assert.ok(card.text.includes("- Cursor node: /root/Main/Door"));
    assert.ok(prompts.some((p) => p.id === "rn-efibuddy" && p.text.includes(`#${out.cardId}`)), "delivered to the bug-intake Buddy");
  });

  test("teamId is required: missing / blank / non-string is 400, unknown is 404, no bug lane is 409; nothing is parked", async () => {
    const before = cards().length;
    for (const body of [{ text: "x" }, { teamId: "", text: "x" }, { teamId: "  ", text: "x" }, { teamId: 7, text: "x" }, { teamId: ["efi"], text: "x" }]) {
      const r = await ownerReport(body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.body}`);
    }
    for (const teamId of ["nope", "../efi", "efi/x", "x".repeat(65)]) {
      const r = await ownerReport({ teamId, text: "x" });
      assert.equal(r.status, 404, `${teamId} -> ${r.body}`);
    }
    assert.equal((await ownerReport({ teamId: "nobug", text: "x" })).status, 409);
    assert.equal(cards().length, before);
  });

  test("same validation as a tester: text, 64 KB telemetry cap, screenshot magic-byte sniff, clientReportId shape", async () => {
    const before = cards().length;
    assert.equal((await ownerReport({ teamId: "efi", text: "  " })).status, 400);
    assert.equal((await ownerReport({ teamId: "efi", text: "big", telemetry: { blob: "x".repeat(api.TESTER_TELEMETRY_MAX_BYTES) } })).status, 413);
    const jpegAsPng = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]).toString("base64");
    assert.equal((await ownerReport({ teamId: "efi", text: "x", screenshotMime: "image/png", screenshotBase64: jpegAsPng })).status, 400);
    assert.equal((await ownerReport({ teamId: "efi", text: "x", screenshotBase64: Buffer.from("GIF89a....").toString("base64") })).status, 400);
    assert.equal((await ownerReport({ teamId: "efi", text: "x", clientReportId: "bad\nid" })).status, 400);
    assert.equal((await ownerReport({ teamId: "efi", text: "x" }, { raw: "{not json" })).status, 400);
    assert.equal(cards().length, before, "a rejected report parks nothing");
  });

  test("clientReportId: a retry is deduplicated (one card); scoped to (owner, Squad); never matches a tester's id", async () => {
    const id = "owner-report-uuid-1";
    const first = await ownerReport({ teamId: "efi", text: "first", clientReportId: id });
    assert.equal(first.status, 200, first.body);
    const again = await ownerReport({ teamId: "efi", text: "retry", clientReportId: id });
    assert.equal(again.status, 200, again.body);
    assert.equal(again.json().deduplicated, true);
    assert.equal(again.json().cardId, first.json().cardId);
    assert.equal(again.json().laneId, "efi-bugs");
    assert.equal(again.json().threadAgentId, "rn-efibuddy");
    assert.equal(cards().filter((c) => c.clientReportId === id).length, 1);

    const other = await ownerReport({ teamId: "oth", text: "other Squad", clientReportId: id });
    assert.equal(other.status, 200);
    assert.equal("deduplicated" in other.json(), false, "another Squad is another scope");

    // attacker: a tester reusing the owner's id gets its own card; the owner reusing a tester's id gets its own card
    const t = await testerReport({ teamId: "efi", text: "tester", clientReportId: id });
    assert.equal(t.status, 200, t.body);
    assert.equal("deduplicated" in t.json(), false);
    assert.equal(cardById(t.json().cardId).source, "alpha-tester");
    const tid = "tester-only-id";
    assert.equal((await testerReport({ teamId: "efi", text: "t", clientReportId: tid })).status, 200);
    const o = await ownerReport({ teamId: "efi", text: "o", clientReportId: tid });
    assert.equal("deduplicated" in o.json(), false);
    assert.equal(cardById(o.json().cardId).source, "owner-playtest");

    const cid = "owner-concurrent";
    const [x, y] = await Promise.all([ownerReport({ teamId: "efi", text: "c1", clientReportId: cid }), ownerReport({ teamId: "efi", text: "c2", clientReportId: cid })]);
    assert.equal(x.json().cardId, y.json().cardId);
    assert.equal(cards().filter((c) => c.clientReportId === cid).length, 1);
  });
});

describe("owner GET/POST /__vibesquad/tester/thread", () => {
  test("GET needs teamId (400 / 404), returns the Squad's intake thread and delta-polls with ?after=", async () => {
    assert.equal((await ownerThread("")).status, 400);
    assert.equal((await ownerThread("teamId=nope")).status, 404);
    const mine = cards().find((c) => c.ownerPlaytest === true && c.teamId === "efi");
    timelines.set("rn-efibuddy", [
      { seqStart: 1, timestamp: "t1", item: { type: "user_message", text: `[Owner playtest · card:${mine.id}] door again` } },
      { seqStart: 2, timestamp: "t2", item: { type: "tool_call", name: "Bash", input: "cat secrets" } },
      { seqStart: 3, timestamp: "t3", item: { type: "assistant_message", text: `Looking at ${SECRET_PATH}` } },
      { seqStart: 4, timestamp: "t4", item: { type: "user_message", text: "[Owner playtest] plain" } },
      { seqStart: 5, timestamp: "t5", item: { type: "assistant_message", text: "fixed" } },
    ]);
    const r = await ownerThread("teamId=efi");
    assert.equal(r.status, 200, r.body);
    const j = r.json();
    assert.deepEqual(Object.keys(j).sort(), ["agent", "cursor", "laneId", "messages", "ok", "teamId"]);
    assert.equal(j.teamId, "efi");
    assert.equal(j.laneId, "efi-bugs");
    assert.deepEqual(j.agent, { id: "rn-efibuddy", title: "brainstorm efi-bugs", status: "idle" });
    assert.deepEqual(j.messages.map((m) => m.id), ["rn-efibuddy:1", "rn-efibuddy:3", "rn-efibuddy:4", "rn-efibuddy:5"]);
    assert.equal(j.messages[0].cardId, mine.id, "owner card tag surfaces as cardId");
    assert.equal("cardId" in j.messages[2], false);
    assert.ok(!r.body.includes(SECRET_PATH) && !r.body.includes("cat secrets"), r.body);
    assert.equal(j.cursor, "rn-efibuddy:5");
    const d = (await ownerThread("teamId=efi&after=rn-efibuddy:3")).json();
    assert.deepEqual(d.messages.map((m) => m.id), ["rn-efibuddy:4", "rn-efibuddy:5"], "only newer messages");
    assert.equal(d.cursor, "rn-efibuddy:5");
    const none = (await ownerThread("teamId=efi&after=rn-efibuddy:5")).json();
    assert.deepEqual(none.messages, []);
    assert.equal(none.cursor, "rn-efibuddy:5");
  });

  test("POST round-trips: an owner line (owner:true) with the card tag, visible on the next GET", async () => {
    const mine = cards().find((c) => c.ownerPlaytest === true && c.teamId === "efi");
    prompts.length = 0;
    const r = await ownerSay({ teamId: "efi", text: "still broken", cardId: mine.id });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(r.json(), { ok: true, agentId: "rn-efibuddy" });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].id, "rn-efibuddy");
    assert.equal(prompts[0].text, `[Owner playtest · card:${mine.id}] still broken`);
    assert.equal(prompts[0].opts.owner, true);
    const plain = await ownerSay({ teamId: "efi", text: "no card" });
    assert.equal(plain.status, 200);
    assert.equal(prompts[1].text, "[Owner playtest] no card");

    // the backend records the sent line; the next GET with the last cursor returns exactly it
    const tl = timelines.get("rn-efibuddy");
    tl.push({ seqStart: 6, timestamp: "t6", item: { type: "user_message", text: prompts[0].text } });
    const g = (await ownerThread("teamId=efi&after=rn-efibuddy:5")).json();
    assert.deepEqual(g.messages, [{ id: "rn-efibuddy:6", role: "user", text: prompts[0].text, ts: "t6", cardId: mine.id }]);
  });

  test("POST: teamId required; cardId must be an owner-playtest card of that Squad (a tester's card or another Squad's is 403)", async () => {
    assert.equal((await ownerSay({ text: "x" })).status, 400);
    assert.equal((await ownerSay({ teamId: "nope", text: "x" })).status, 404);
    const testerCard = cards().find((c) => c.testerDeviceId === deviceId("Alice"));
    const othCard = cards().find((c) => c.ownerPlaytest === true && c.teamId === "oth");
    prompts.length = 0;
    assert.equal((await ownerSay({ teamId: "efi", text: "x", cardId: testerCard.id })).status, 403);
    assert.equal((await ownerSay({ teamId: "efi", text: "x", cardId: othCard.id })).status, 403);
    assert.equal((await ownerSay({ teamId: "efi", text: "x", cardId: "idea-999999" })).status, 403);
    assert.equal((await ownerSay({ teamId: "efi", text: "x", cardId: "nope" })).status, 400);
    assert.equal(prompts.length, 0, "nothing sent");
  });
});

describe("PTO-B1b: a remote owner device with a header token", () => {
  const devReport = (headers, body) => call({ url: REPORT, method: "POST", headers, body });

  test("Authorization: Bearer owner device -> 200 and an [Owner playtest] card owned by that device", async () => {
    prompts.length = 0;
    const r = await devReport(bearer(ownerGame), { teamId: "efi", text: "remote door", screenshotBase64: PNG_B64, telemetry: { scene: "res://door.tscn" } });
    assert.equal(r.status, 200, r.body);
    const out = r.json();
    assert.equal(out.ok, true);
    assert.equal(out.laneId, "efi-bugs");
    assert.equal(out.threadAgentId, "rn-efibuddy");
    assert.equal(out.screenshotAttached, true);
    const card = cardById(out.cardId);
    assert.ok(card.text.startsWith("[Owner playtest]\n"), card.text.slice(0, 40));
    assert.equal(card.source, "owner-playtest");
    assert.equal(card.ownerPlaytest, true);
    assert.equal(card.ownerPlaytestBy, `device:${deviceId("Owner game")}`);
    assert.equal("testerDeviceId" in card, false);
    assert.ok(!JSON.stringify(card).includes(ownerGame), "the device token is never stored on the card");
    assert.ok(prompts.some((p) => p.id === "rn-efibuddy" && p.text.includes(`#${out.cardId}`)));
  });

  test("x-vs-device-token owner device -> 200; thread GET and POST work too (owner line)", async () => {
    const h = { "x-vs-device-token": ownerGame };
    const r = await devReport(h, { teamId: "efi", text: "via x-vs-device-token" });
    assert.equal(r.status, 200, r.body);
    assert.equal(cardById(r.json().cardId).ownerPlaytestBy, `device:${deviceId("Owner game")}`);
    const g = await call({ url: `${THREAD}?teamId=efi`, headers: h });
    assert.equal(g.status, 200, g.body);
    assert.equal(g.json().teamId, "efi");
    prompts.length = 0;
    const p = await call({ url: THREAD, method: "POST", headers: bearer(ownerGame), body: { teamId: "efi", text: "remote line", cardId: r.json().cardId } });
    assert.equal(p.status, 200, p.body);
    assert.equal(prompts[0].text, `[Owner playtest · card:${r.json().cardId}] remote line`);
    assert.equal(prompts[0].opts.owner, true);
  });

  test("every B1 rule holds for a device owner: teamId 400/404/409, validation, 64 KB cap, screenshot sniff, 405", async () => {
    const h = bearer(ownerGame);
    const before = cards().length;
    assert.equal((await devReport(h, { text: "x" })).status, 400);
    assert.equal((await devReport(h, { teamId: "nope", text: "x" })).status, 404);
    assert.equal((await devReport(h, { teamId: "nobug", text: "x" })).status, 409);
    assert.equal((await devReport(h, { teamId: "efi", text: " " })).status, 400);
    assert.equal((await devReport(h, { teamId: "efi", text: "big", telemetry: { blob: "x".repeat(api.TESTER_TELEMETRY_MAX_BYTES) } })).status, 413);
    assert.equal((await devReport(h, { teamId: "efi", text: "x", screenshotBase64: Buffer.from("GIF89a....").toString("base64") })).status, 400);
    assert.equal((await call({ url: REPORT, method: "GET", headers: h })).status, 405);
    assert.equal((await call({ url: THREAD, headers: h })).status, 400);
    assert.equal(cards().length, before);
  });

  test("clientReportId dedupes per owner principal: same device dedupes; another device and the local owner do not collide", async () => {
    const id = "b1b-principal-id";
    const a = await devReport(bearer(ownerGame), { teamId: "efi", text: "a", clientReportId: id });
    assert.equal(a.status, 200, a.body);
    const a2 = await devReport({ "x-vs-device-token": ownerGame }, { teamId: "efi", text: "a retry", clientReportId: id });
    assert.equal(a2.json().deduplicated, true, "same device, other header form: still one principal");
    assert.equal(a2.json().cardId, a.json().cardId);
    const b = await devReport(bearer(ownerPhone), { teamId: "efi", text: "b", clientReportId: id });
    assert.equal(b.status, 200, b.body);
    assert.equal("deduplicated" in b.json(), false, "another owner device is another principal");
    assert.equal(cardById(b.json().cardId).ownerPlaytestBy, `device:${deviceId("Owner phone")}`);
    const l = await ownerReport({ teamId: "efi", text: "local", clientReportId: id });
    assert.equal("deduplicated" in l.json(), false, "the local owner is another principal");
    assert.equal(cardById(l.json().cardId).ownerPlaytestBy, "local-owner");
    assert.equal((await ownerReport({ teamId: "efi", text: "local again", clientReportId: id })).json().cardId, l.json().cardId);
    const t = await testerReport({ teamId: "efi", text: "tester", clientReportId: id });
    assert.equal("deduplicated" in t.json(), false, "a tester is never an owner principal");
    assert.equal(cards().filter((c) => c.clientReportId === id).length, 4);
    // concurrent retries from one device park one card
    const cid = "b1b-concurrent";
    const [x, y] = await Promise.all([devReport(bearer(ownerGame), { teamId: "efi", text: "c1", clientReportId: cid }), devReport(bearer(ownerGame), { teamId: "efi", text: "c2", clientReportId: cid })]);
    assert.equal(x.json().cardId, y.json().cardId);
    assert.equal(cards().filter((c) => c.clientReportId === cid).length, 1);
  });

  test("a B1 card without ownerPlaytestBy still dedupes for the local owner (it was the local owner's), never for a device", async () => {
    const all = cards();
    const legacy = all.find((c) => c.clientReportId === "owner-report-uuid-1" && c.teamId === "efi" && c.ownerPlaytest === true);
    assert.ok(legacy);
    delete legacy.ownerPlaytestBy;
    inbox.writeInboxCards(all);
    assert.equal("ownerPlaytestBy" in cardById(legacy.id), false);
    const again = await ownerReport({ teamId: "efi", text: "retry", clientReportId: "owner-report-uuid-1" });
    assert.equal(again.json().deduplicated, true);
    assert.equal(again.json().cardId, legacy.id);
    const dev = await devReport(bearer(ownerGame), { teamId: "efi", text: "dev", clientReportId: "owner-report-uuid-1" });
    assert.equal(dev.status, 200, dev.body);
    assert.equal("deduplicated" in dev.json(), false, "a device never matches a legacy local-owner card");
  });

  test("a bug-tester device on the same route still gets tester behaviour (both header forms)", async () => {
    for (const headers of [bearer(alice), { "x-vs-device-token": alice }]) {
      const r = await call({ url: REPORT, method: "POST", headers, body: { text: "tester path" } });
      assert.equal(r.status, 200, r.body);
      assert.deepEqual(Object.keys(r.json()).sort(), ["cardId", "delivered", "laneId", "ok", "threadAgentId"]);
      const card = cardById(r.json().cardId);
      assert.ok(card.text.startsWith("[Alpha Tester: Alice]\n"));
      assert.equal(card.source, "alpha-tester");
      assert.equal("ownerPlaytest" in card, false);
      assert.equal("ownerPlaytestBy" in card, false);
      assert.equal((await call({ url: REPORT, method: "POST", headers, body: { teamId: "oth", text: "x" } })).status, 403);
    }
  });
});

describe("attacker: only the local owner or a header-token owner device gains the routes", () => {
  const routes = [
    { url: REPORT, method: "POST", body: { teamId: "efi", text: "x" } },
    { url: `${THREAD}?teamId=efi`, method: "GET" },
    { url: THREAD, method: "POST", body: { teamId: "efi", text: "x" } },
  ];
  test("loopback with no token / a wrong token / a token in the wrong header is 403; nothing parked or sent", async () => {
    const before = cards().length;
    prompts.length = 0;
    for (const r of routes) {
      for (const headers of [{}, { "x-vibesquad-token": "0".repeat(64) }, { "x-vibesquad-token": "" }, bearer(auth.getLocalToken())]) {
        const out = await call({ ...r, local: true, headers });
        assert.equal(out.status, 403, `${r.method} ${r.url} ${JSON.stringify(Object.keys(headers))} -> ${out.status} ${out.body}`);
      }
    }
    assert.equal(cards().length, before);
    assert.equal(prompts.length, 0);
  });

  test("a remote (Meshnet) caller is refused even with the real local token; an unpaired remote caller is 401", async () => {
    for (const r of routes) {
      const tok = await call({ ...r, headers: ownerLocal() });
      assert.ok([401, 403].includes(tok.status), `remote + local token ${r.method} ${r.url} -> ${tok.status}`);
      const anon = await call({ ...r });
      assert.equal(anon.status, 401, `unpaired remote ${r.method} ${r.url}`);
    }
  });

  test("attacker: a COOKIE-only owner device is 403 (same-origin or not, loopback or remote); nothing parked or sent", async () => {
    const before = cards().length;
    prompts.length = 0;
    const cookie = { cookie: `${auth.DEVICE_COOKIE}=${ownerPhone}` };
    // sanity: the cookie really authenticates (a remote API read is 200 with it, 401 without)
    assert.equal((await call({ url: "/__vibesquad/settings", headers: cookie })).status, 200);
    assert.equal((await call({ url: "/__vibesquad/settings" })).status, 401);
    for (const r of routes) {
      for (const extra of [{}, { origin: "http://100.64.0.7:4180" }, { "sec-fetch-site": "same-origin" }]) {
        const out = await call({ ...r, headers: { ...cookie, ...extra } });
        assert.equal(out.status, 403, `cookie owner ${r.method} ${r.url} ${JSON.stringify(extra)} -> ${out.body}`);
      }
      assert.equal((await call({ ...r, local: true, headers: cookie })).status, 403, `loopback cookie owner ${r.method} ${r.url}`);
    }
    assert.equal(cards().length, before);
    assert.equal(prompts.length, 0);
  });

  test("attacker: a revoked or unknown device token is 401 remote / 403 loopback; a malformed header never falls back to the cookie", async () => {
    const doomed = await pcPair("Owner doomed");
    assert.equal((await call({ ...routes[1], headers: bearer(doomed) })).status, 200, "works before the revoke");
    auth.revokeDevice(deviceId("Owner doomed"));
    const before = cards().length;
    for (const r of routes) {
      for (const headers of [bearer(doomed), { "x-vs-device-token": doomed }, bearer("f".repeat(64)), { "x-vs-device-token": "f".repeat(64) }]) {
        assert.equal((await call({ ...r, headers })).status, 401, `remote ${r.method} ${r.url}`);
        assert.equal((await call({ ...r, local: true, headers })).status, 403, `loopback ${r.method} ${r.url}`);
      }
      // a malformed header plus a valid owner cookie: the header wins and fails, the cookie is not consulted
      const mixed = await call({ ...r, headers: { "x-vs-device-token": "not a token", cookie: `${auth.DEVICE_COOKIE}=${ownerPhone}` } });
      assert.ok([401, 403].includes(mixed.status), `malformed header + cookie ${r.method} ${r.url} -> ${mixed.status}`);
    }
    assert.equal(cards().length, before);
  });

  test("attacker: an owner device token header plus agent headers is 403", async () => {
    for (const r of routes) {
      for (const headers of [bearer(ownerPhone), { "x-vs-device-token": ownerPhone }]) {
        const out = await call({ ...r, headers: { ...headers, "x-vs-agent-id": "rn-efihub", "x-vs-agent-token": "t" } });
        assert.equal(out.status, 403, `${r.method} ${r.url} -> ${out.body}`);
      }
    }
  });

  test("an E5 relayed owner device is 403 (channel identity, not a header token), even if a token header rides along", async () => {
    prompts.length = 0;
    const before = cards().length;
    const relayed = async (method, path, headers = {}, body) => {
      const req = createSyntheticRequest({ method, path, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0), deviceId: deviceId("Owner phone") });
      const { res, finished } = mkRes();
      const viaNext = new Promise((done) => mw(req, res, () => done("next")));
      assert.notEqual(await Promise.race([finished, viaNext]), "next");
      return res;
    };
    // sanity: the same relayed device is a trusted caller on an ordinary API read
    assert.equal((await relayed("GET", "/__vibesquad/settings")).statusCode, 200);
    for (const r of routes) {
      for (const headers of [{}, bearer(ownerPhone), { "x-vs-device-token": ownerPhone }]) {
        const res = await relayed(r.method, r.url, headers, r.body);
        assert.equal(res.statusCode, 403, `relay ${r.method} ${r.url} ${JSON.stringify(Object.keys(headers))} -> ${res.body}`);
      }
    }
    assert.equal(cards().length, before);
    assert.equal(prompts.length, 0);
  });

  test("loopback with a foreign Host or Origin is refused even with the token (isLocalBrowserSafe)", async () => {
    for (const r of routes) {
      assert.equal((await call({ ...r, local: true, headers: ownerLocal(), host: "evil.example:4180" })).status, 403);
      assert.equal((await call({ ...r, local: true, headers: { ...ownerLocal(), origin: "http://evil.example" } })).status, 403);
    }
  });

  test("an agent-header caller never becomes the owner here (token + x-vs-agent-id)", async () => {
    for (const r of routes) {
      const out = await call({ ...r, local: true, headers: { ...ownerLocal(), "x-vs-agent-id": "rn-efihub", "x-vs-agent-token": "t" } });
      assert.equal(out.status, 403, `${r.method} ${r.url} -> ${out.body}`);
    }
  });

  test("wrong method is 405 for the owner", async () => {
    assert.equal((await call({ url: REPORT, method: "GET", local: true, headers: ownerLocal() })).status, 405);
    assert.equal((await call({ url: THREAD, method: "DELETE", local: true, headers: ownerLocal() })).status, 405);
  });
});

describe("tester gating is unchanged", () => {
  test("a tester still defaults to its first Squad, keeps the [Alpha Tester] stamp and the same answer shape", async () => {
    const r = await testerReport({ text: "no teamId" });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(Object.keys(r.json()).sort(), ["cardId", "delivered", "laneId", "ok", "threadAgentId"]);
    const card = cardById(r.json().cardId);
    assert.equal(card.teamId, "efi");
    assert.ok(card.text.startsWith("[Alpha Tester: Alice]\n"));
    assert.equal(card.source, "alpha-tester");
    assert.equal("ownerPlaytest" in card, false);
  });

  test("attacker: a tester cannot use teamId to reach another Squad (report, thread GET/POST)", async () => {
    const before = cards().length;
    for (const teamId of ["oth", "OTH", "nobug", "nope"]) {
      assert.equal((await testerReport({ teamId, text: "x" })).status, 403, teamId);
      assert.equal((await call({ url: `${THREAD}?teamId=${teamId}`, headers: bearer(alice) })).status, 403, teamId);
      assert.equal((await call({ url: THREAD, method: "POST", headers: bearer(alice), body: { teamId, text: "x" } })).status, 403, teamId);
    }
    assert.equal(cards().length, before);
  });

  test("attacker: a tester cannot tag an owner-playtest card, and its thread does not mark owner card tags as its own", async () => {
    const ownerCard = cards().find((c) => c.ownerPlaytest === true && c.teamId === "efi");
    prompts.length = 0;
    const r = await call({ url: THREAD, method: "POST", headers: bearer(alice), body: { teamId: "efi", text: "x", cardId: ownerCard.id } });
    assert.equal(r.status, 403, r.body);
    assert.equal(prompts.length, 0);
    const g = await call({ url: `${THREAD}?teamId=efi`, headers: bearer(alice) });
    assert.equal(g.status, 200);
    // PTO v1.2 T: the tester's thread is its own lines only (its own report cards may carry their cardId), never an owner line.
    assert.ok(g.json().messages.every((m) => m.cardId !== ownerCard.id && !m.text.includes("[Owner playtest")), "owner lines / card tags never reach a tester");
    assert.ok(g.json().messages.every((m) => !m.cardId || cardById(m.cardId)?.testerDeviceId), "only tester cards are tagged");
  });

  test("attacker: a tester's local-token-shaped header does not make it the owner (stays a tester, still scoped)", async () => {
    const r = await call({ url: REPORT, method: "POST", headers: { ...bearer(alice), "x-vibesquad-token": auth.getLocalToken() }, body: { teamId: "oth", text: "x" } });
    assert.equal(r.status, 403, r.body);
  });

  test("a tester is still held to its allowlist elsewhere", async () => {
    assert.equal((await call({ url: "/__vibesquad/settings", headers: bearer(alice) })).status, 403);
    assert.equal((await call({ url: "/__vibesquad/runner/spawn", method: "POST", headers: bearer(alice), body: {} })).status, 403);
  });
});
