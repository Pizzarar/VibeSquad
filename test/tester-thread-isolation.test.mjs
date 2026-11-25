// PTO v1.2 block T (docs/lanes/playtest-overlay/PLAN_V1_2.md, Tier A security): per-caller tester thread isolation.
// A bug-tester's GET /__vibesquad/tester/thread (and its runner /timeline window) returns only (1) the lines that tester
// posted and (2) intake-agent replies addressed to one of its own cards via `vs inbox reply` (POST /__vibesquad/inbox/reply).
// Never the intake agent's raw timeline, another tester's lines/replies, owner or owner-playtest lines, or untagged agent
// output. Owner callers (local owner, owner device, owner-playtest device) keep the raw intake timeline. Attacker cases are
// marked "attacker:". Every request goes through the real middleware.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, test } from "node:test";

const HOME = mkdtempSync(join(tmpdir(), "vs-tti-home-"));
const ROOT = mkdtempSync(join(tmpdir(), "vs-tti-root-"));
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
  { id: "efi", name: "EFI", paths: [join(homedir(), "secret-proj")], lanes: [{ id: "efi", name: "Hub", hub: true }, { id: "efi-bugs", name: "Bugs", kind: "bug" }, { id: "efi-art", name: "Art" }] },
  { id: "oth", name: "Other", paths: [], lanes: [{ id: "oth", name: "Oth Hub", hub: true }, { id: "oth-bugs", name: "Oth Bugs", kind: "bug" }] },
];
writeFileSync(join(ROOT, "teams.json"), JSON.stringify({ teams: TEAMS }), "utf8");
writeFileSync(join(HOME, "teams.json"), JSON.stringify({ teams: TEAMS }), "utf8");

const auth = await import("../server/auth.mjs");
const inbox = await import("../server/inbox.mjs");
const api = await import("../server/vibesquad-api.mjs");
const tt = await import("../server/tester-thread.mjs");
after(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});

// ---- fake runner backend: the efi bug Buddy is the intake agent; every prompt it gets is recorded ----
const agent = (id, team, lane, role) => ({ id, title: `${role} ${lane}`, status: "idle", cwd: join(homedir(), "secret-proj"), labels: { team, lane, role }, provider: "claude" });
const AGENTS = [
  agent("rn-efibuddy", "efi", "efi-bugs", "brainstorm"),
  agent("rn-efihub", "efi", "efi", "lead"),
  agent("rn-efiwork", "efi", "efi-bugs", "worker"),
  agent("rn-othbuddy", "oth", "oth-bugs", "brainstorm"),
];
const TOKENS = { "rn-efibuddy": "tok-buddy", "rn-efihub": "tok-hub", "rn-efiwork": "tok-work", "rn-othbuddy": "tok-oth" };
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
  // L1: the runner event stream; like the real backend, a new subscriber gets the roster first.
  subscribeEvents(fn) {
    streamListeners.add(fn);
    fn({ kind: "roster", agents: AGENTS });
    return () => streamListeners.delete(fn);
  },
};
const streamListeners = new Set();
const emitRunner = (ev) => {
  for (const fn of [...streamListeners]) fn(ev);
};
const verifyAgent = async ({ id, token }) => {
  const a = AGENTS.find((x) => x.id === id);
  return a && TOKENS[id] === token ? { id, role: a.labels.role, team: a.labels.team, lane: a.labels.lane } : null;
};
const mw = api.createVibesquadMiddleware(ROOT, { backend, verifyAgent });

let ipN = 60;
function mkReq({ url, method = "GET", headers = {}, body, local = false }) {
  const req = new PassThrough();
  req.url = url;
  req.method = method;
  req.headers = { host: local ? "127.0.0.1:4180" : "100.64.0.7:4180", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers };
  req.socket = local ? { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1", localPort: 4180 } : { remoteAddress: `100.64.0.${++ipN}`, localAddress: "100.64.0.7" };
  setImmediate(() => req.end(body !== undefined ? JSON.stringify(body) : undefined));
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
      done();
    },
  };
  return { res, finished };
}
async function call(opts) {
  const req = mkReq(opts);
  const { res, finished } = mkRes();
  const viaNext = new Promise((r) => mw(req, res, () => r()));
  await Promise.race([finished, viaNext]);
  return { status: res.statusCode, body: res.body, json: () => JSON.parse(res.body) };
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const ownerLocal = () => ({ "x-vibesquad-token": auth.getLocalToken() });
const asAgent = (id, token = TOKENS[id]) => ({ "x-vs-agent-id": id, "x-vs-agent-token": token });

async function pcPair(name, scope) {
  const start = await call({ url: "/__vibesquad/pair/start", method: "POST", local: true, headers: ownerLocal(), body: scope ?? {} });
  assert.equal(start.status, 200, start.body);
  const r = await call({ url: `/pair?code=${start.json().code}&name=${encodeURIComponent(name)}&format=json` });
  assert.equal(r.status, 200, r.body);
  return r.json().token;
}
const alice = await pcPair("Alice", { role: "bug-tester", allowedTeams: ["efi"] });
const bob = await pcPair("Bob", { role: "bug-tester", allowedTeams: ["efi"] });
const carol = await pcPair("Carol", { role: "bug-tester", allowedTeams: ["oth"] });
const ownerDev = await pcPair("Owner phone");
const playtestDev = await pcPair("Owner Godot", { role: "owner-playtest", allowedTeams: null });
const deviceId = (name) => auth.listDevices().find((d) => d.name === name)?.id;

const THREAD = "/__vibesquad/tester/thread";
const REPLY = "/__vibesquad/inbox/reply";
const cards = () => inbox.readInboxCards();
const cardById = (id) => cards().find((c) => c.id === id);
const report = (token, body) => call({ url: "/__vibesquad/tester/report", method: "POST", headers: bearer(token), body });
const thread = (token, q = "teamId=efi") => call({ url: `${THREAD}?${q}`, headers: bearer(token) });
const say = (token, body) => call({ url: THREAD, method: "POST", headers: bearer(token), body });
const reply = (body, headers = asAgent("rn-efibuddy"), local = true) => call({ url: REPLY, method: "POST", local, headers, body });

// ---- the scene: two testers + the owner on efi, a third tester on oth; the Buddy's raw timeline holds everyone ----
const aCard = (await report(alice, { teamId: "efi", text: "Alice: door clips" })).json().cardId;
const bCard = (await report(bob, { teamId: "efi", text: "Bob: crash on load" })).json().cardId;
const cCard = (await report(carol, { teamId: "oth", text: "Carol: other squad" })).json().cardId;
const oCard = (await call({ url: "/__vibesquad/tester/report", method: "POST", local: true, headers: ownerLocal(), body: { teamId: "efi", text: "OWNER-SECRET playtest note" } })).json().cardId;
const uiCard = inbox.addInboxCards({ ideas: ["owner ui idea on the bug lane"], teamId: "efi", laneId: "efi-bugs", source: "ui" }, ROOT).added[0].id;
timelines.set("rn-efibuddy", [
  { seqStart: 1, timestamp: "t1", item: { type: "user_message", text: "OWNER-CHAT: plan the next sprint" } },
  { seqStart: 2, timestamp: "t2", item: { type: "user_message", text: `[Owner playtest · card:${oCard}] owner line` } },
  { seqStart: 3, timestamp: "t3", item: { type: "user_message", text: `[Alpha Tester · Bob · card:${bCard}] BOB-LINE` } },
  { seqStart: 4, timestamp: "t4", item: { type: "assistant_message", text: `RAW-BUDDY looking at ${SECRET_PATH}` } },
  { seqStart: 5, timestamp: "t5", item: { type: "assistant_message", text: `RAW-BUDDY about ${aCard}: card:${aCard} fixed` } },
]);

describe("reply verb: POST /__vibesquad/inbox/reply (vs inbox reply)", () => {
  test("the intake Buddy (and a lead of the Squad) replies to a tester card; stored under that card's device only", async () => {
    const r = await reply({ cardId: aCard, text: "Thanks Alice, repro'd" });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json().cardId, aCard);
    assert.ok(Number.isSafeInteger(r.json().seq));
    assert.equal((await reply({ cardId: bCard, text: "Thanks Bob" })).status, 200);
    assert.equal((await reply({ cardId: aCard, text: "Hub lead: fix queued" }, asAgent("rn-efihub"))).status, 200);
    const store = JSON.parse(readFileSync(tt.getTesterThreadPath(), "utf8"));
    assert.deepEqual(Object.keys(store.devices).sort(), [deviceId("Alice"), deviceId("Bob"), deviceId("Carol")].sort(), "keyed by tester device id; no owner bucket");
    const aliceReplies = store.devices[deviceId("Alice")].lines.filter((l) => l.role === "assistant");
    assert.deepEqual(aliceReplies.map((l) => l.text), ["Thanks Alice, repro'd", "Hub lead: fix queued"]);
    assert.ok(aliceReplies.every((l) => l.cardId === aCard && l.kind === "reply"));
    assert.ok(!JSON.stringify(store.devices[deviceId("Alice")]).includes("Thanks Bob"));
  });

  test("attacker: refused for a non-agent (owner, tester, owner-playtest device, read-only) and a bad agent token", async () => {
    const before = readFileSync(tt.getTesterThreadPath(), "utf8");
    assert.equal((await reply({ cardId: aCard, text: "x" }, ownerLocal())).status, 403, "local owner");
    assert.equal((await reply({ cardId: aCard, text: "x" }, bearer(ownerDev), false)).status, 403, "owner device");
    assert.equal((await reply({ cardId: aCard, text: "x" }, bearer(alice), false)).status, 403, "tester (own card)");
    assert.equal((await reply({ cardId: bCard, text: "x" }, bearer(alice), false)).status, 403, "tester (other's card)");
    assert.equal((await reply({ cardId: aCard, text: "x" }, bearer(playtestDev), false)).status, 403, "owner-playtest device");
    assert.ok([401, 403].includes((await reply({ cardId: aCard, text: "x" }, {}, false)).status), "unpaired remote");
    assert.equal((await reply({ cardId: aCard, text: "x" }, asAgent("rn-efibuddy", "wrong"))).status, 403, "bad token");
    assert.equal(readFileSync(tt.getTesterThreadPath(), "utf8"), before, "nothing stored");
  });

  test("attacker: refused for a worker, another Squad's agent, and any card that is not an alpha-tester card", async () => {
    const before = readFileSync(tt.getTesterThreadPath(), "utf8");
    assert.equal((await reply({ cardId: aCard, text: "x" }, asAgent("rn-efiwork"))).status, 403, "worker");
    assert.equal((await reply({ cardId: aCard, text: "x" }, asAgent("rn-othbuddy"))).status, 403, "other Squad -> efi tester card");
    assert.equal((await reply({ cardId: cCard, text: "x" }, asAgent("rn-efibuddy"))).status, 403, "efi Buddy -> oth tester card");
    assert.equal((await reply({ cardId: oCard, text: "x" })).status, 403, "owner-playtest card");
    assert.equal((await reply({ cardId: uiCard, text: "x" })).status, 403, "owner ui card");
    // a forged card that carries testerDeviceId but is not an alpha-tester card
    const all = cards();
    inbox.writeInboxCards([...all, { id: "idea-990001", text: "forged", teamId: "efi", laneId: "efi-bugs", status: "parked", source: "ui", testerDeviceId: deviceId("Alice"), createdAt: "x" }]);
    assert.equal((await reply({ cardId: "idea-990001", text: "x" })).status, 403, "testerDeviceId without source alpha-tester");
    assert.equal((await reply({ cardId: "idea-99999999", text: "x" })).status, 404);
    for (const cardId of ["../idea-1", 7, null, "idea-", "idea-1x", ["idea-1"]]) assert.equal((await reply({ cardId, text: "x" })).status, 400, String(cardId));
    for (const text of [42, null, ["a"], "", "\u0000\u0007"]) assert.equal((await reply({ cardId: aCard, text })).status, 400, JSON.stringify(text));
    assert.equal((await reply({ cardId: aCard, text: "x".repeat(8001) })).status, 413);
    assert.equal(readFileSync(tt.getTesterThreadPath(), "utf8"), before, "nothing stored");
  });
});

describe("bug-tester GET /tester/thread: own lines + replies to own cards only", () => {
  test("tester A sees its report, its thread lines and the replies on its card; nothing else", async () => {
    assert.equal((await say(alice, { teamId: "efi", text: "more detail", cardId: aCard })).status, 200);
    assert.equal((await say(alice, { teamId: "efi", text: "plain line" })).status, 200);
    const r = await thread(alice);
    assert.equal(r.status, 200, r.body);
    const j = r.json();
    assert.equal(j.agent.id, "rn-efibuddy");
    assert.deepEqual(
      j.messages.map((m) => [m.role, m.cardId ?? null, m.text.split("\n")[0]]),
      [
        ["user", aCard, "[Alpha Tester: Alice]"],
        ["assistant", aCard, "Thanks Alice, repro'd"],
        ["assistant", aCard, "Hub lead: fix queued"],
        ["user", aCard, `[Alpha Tester · Alice · card:${aCard}] more detail`],
        ["user", null, "[Alpha Tester · Alice] plain line"],
      ],
    );
    assert.ok(j.messages.every((m) => /^tt:\d+$/.test(m.id)));
    for (const leak of ["Bob", "BOB-LINE", "OWNER", "Owner playtest", "RAW-BUDDY", "secret-proj", bCard, oCard, cCard, "Carol"]) assert.ok(!r.body.includes(leak), `leaked ${leak}: ${r.body}`);
  });

  test("tester B sees only its own report + the reply on its card (never A's lines or replies)", async () => {
    const j = (await thread(bob)).json();
    assert.deepEqual(j.messages.map((m) => [m.role, m.cardId]), [["user", bCard], ["assistant", bCard]]);
    const body = JSON.stringify(j);
    for (const leak of ["Alice", aCard, "repro'd", "plain line", "OWNER", "RAW-BUDDY"]) assert.ok(!body.includes(leak), leak);
  });

  test("after / limit / cursor keep their semantics on the per-caller thread", async () => {
    const all = (await thread(alice)).json().messages.map((m) => m.id);
    assert.equal(all.length, 5);
    const lim = (await thread(alice, `teamId=efi&after=${all[0]}&limit=2`)).json();
    assert.deepEqual(lim.messages.map((m) => m.id), all.slice(1, 3));
    assert.equal(lim.cursor, all[2], "page forward from the cursor");
    const d = (await thread(alice, `teamId=efi&after=${all[2]}`)).json();
    assert.deepEqual(d.messages.map((m) => m.id), all.slice(3));
    const none = (await thread(alice, `teamId=efi&after=${all[4]}`)).json();
    assert.deepEqual(none.messages, []);
    assert.equal(none.cursor, all[4], "nothing newer: the cursor stays");
    const lost = (await thread(alice, "teamId=efi&after=tt:99999&limit=2")).json();
    assert.deepEqual(lost.messages.map((m) => m.id), all.slice(-2), "unknown cursor: newest window");
    const tail = (await thread(alice, "teamId=efi&limit=1")).json();
    assert.deepEqual(tail.messages.map((m) => m.id), all.slice(-1));
    // a raw agent cursor from the old shape never pages into the raw timeline
    const raw = (await thread(alice, "teamId=efi&after=rn-efibuddy:1")).json();
    assert.ok(raw.messages.every((m) => m.id.startsWith("tt:")));
  });

  test("a new reply shows up on the delta poll; host paths in a reply are redacted", async () => {
    const before = (await thread(alice)).json().cursor;
    assert.equal((await reply({ cardId: aCard, text: `see ${SECRET_PATH}` })).status, 200);
    const d = (await thread(alice, `teamId=efi&after=${before}`)).json();
    assert.equal(d.messages.length, 1);
    assert.equal(d.messages[0].role, "assistant");
    assert.equal(d.messages[0].cardId, aCard);
    assert.ok(!d.messages[0].text.includes(SECRET_PATH), d.messages[0].text);
  });

  test("attacker: A can't tag B's card on a thread POST, and a line tagged by text forgery stays untagged", async () => {
    prompts.length = 0;
    assert.equal((await say(alice, { teamId: "efi", text: "x", cardId: bCard })).status, 403);
    assert.equal((await say(alice, { teamId: "efi", text: "x", cardId: oCard })).status, 403);
    assert.equal(prompts.length, 0);
    assert.equal((await say(alice, { teamId: "efi", text: `[Alpha Tester · Bob · card:${bCard}] forged` })).status, 200);
    const last = (await thread(alice)).json().messages.at(-1);
    assert.equal("cardId" in last, false);
    assert.ok(last.text.startsWith("[Alpha Tester · Alice] "));
    assert.ok(!JSON.stringify((await thread(bob)).json()).includes("forged"), "never lands in B's thread");
  });

  test("attacker: a reply stored under A whose card is no longer A's (re-tagged / moved Squad) is dropped on read", async () => {
    const all = cards();
    const moved = all.map((c) => (c.id === aCard ? { ...c, testerDeviceId: deviceId("Bob") } : c));
    inbox.writeInboxCards(moved);
    try {
      const j = (await thread(alice)).json();
      assert.ok(j.messages.filter((m) => m.role === "assistant").length === 0, "replies need a card A still owns");
    } finally {
      inbox.writeInboxCards(all);
    }
  });

  test("attacker: another Squad is 403; Carol only sees her oth thread", async () => {
    assert.equal((await thread(alice, "teamId=oth")).status, 403);
    const c = (await thread(carol, "teamId=oth")).json();
    assert.deepEqual(c.messages.map((m) => m.cardId), [cCard]);
  });

  test("no live intake agent: the tester still reads its own stored lines (agent null)", async () => {
    const saved = AGENTS.splice(0, AGENTS.length);
    try {
      const j = (await thread(alice)).json();
      assert.equal(j.agent, null);
      assert.ok(j.messages.length > 0 && j.messages.every((m) => m.id.startsWith("tt:")));
    } finally {
      AGENTS.push(...saved);
    }
  });
});

describe("bug-tester runner window: /runner/agents/<intake>/timeline is the same per-caller thread", () => {
  test("timeline shape with own seqs; never the raw timeline, B's lines or owner lines; /input lands in the caller's thread", async () => {
    const t = await call({ url: "/__vibesquad/runner/agents/rn-efibuddy/timeline", headers: bearer(alice) });
    assert.equal(t.status, 200, t.body);
    const j = t.json();
    assert.ok(j.entries.length > 0);
    assert.ok(j.entries.every((e) => ["user_message", "assistant_message"].includes(e.item.type) && e.seqStart === e.seqEnd));
    for (const leak of ["BOB-LINE", "Thanks Bob", "crash on load", "OWNER", "RAW-BUDDY", "secret-proj"]) assert.ok(!t.body.includes(leak), leak);
    const page = (await call({ url: `/__vibesquad/runner/agents/rn-efibuddy/timeline?direction=before&cursor=${j.entries.at(-1).seqStart}&limit=2`, headers: bearer(alice) })).json();
    assert.deepEqual(page.entries.map((e) => e.seqStart), j.entries.slice(-3, -1).map((e) => e.seqStart), "before-cursor paging");
    assert.equal((await call({ url: "/__vibesquad/runner/agents/rn-efibuddy/input", method: "POST", headers: bearer(bob), body: { text: "bob via runner" } })).status, 200);
    const b = (await call({ url: "/__vibesquad/runner/agents/rn-efibuddy/timeline", headers: bearer(bob) })).json();
    assert.equal(b.entries.at(-1).item.text, "[Alpha Tester · Bob] bob via runner");
    assert.ok(!(await call({ url: "/__vibesquad/runner/agents/rn-efibuddy/timeline", headers: bearer(alice) })).body.includes("bob via runner"));
  });
});

describe("owner callers keep the raw intake timeline", () => {
  const rawIds = ["rn-efibuddy:1", "rn-efibuddy:2", "rn-efibuddy:3", "rn-efibuddy:4", "rn-efibuddy:5"];
  test("local owner", async () => {
    const j = (await call({ url: `${THREAD}?teamId=efi`, local: true, headers: ownerLocal() })).json();
    assert.deepEqual(j.messages.map((m) => m.id), rawIds);
    assert.equal(j.messages[1].cardId, oCard, "owner card tag surfaces");
  });
  test("owner device (header token)", async () => {
    const j = (await call({ url: `${THREAD}?teamId=efi`, headers: bearer(ownerDev) })).json();
    assert.deepEqual(j.messages.map((m) => m.id), rawIds);
  });
  test("owner-playtest device", async () => {
    const j = (await call({ url: `${THREAD}?teamId=efi`, headers: bearer(playtestDev) })).json();
    assert.deepEqual(j.messages.map((m) => m.id), rawIds);
  });
});

describe("delivery text tells the intake agent how to answer a tester", () => {
  test("a delivered tester card names `vs inbox reply <id>`; an owner-playtest card does not", async () => {
    prompts.length = 0;
    const id = (await report(alice, { teamId: "efi", text: "Alice: second bug" })).json().cardId;
    const p = prompts.find((x) => x.text.includes(`Inbox card #${id}`));
    assert.ok(p, JSON.stringify(prompts));
    assert.ok(p.text.includes(`vs inbox reply ${id} "<text>"`), p.text);
    prompts.length = 0;
    const o = (await call({ url: "/__vibesquad/tester/report", method: "POST", local: true, headers: ownerLocal(), body: { teamId: "efi", text: "owner again" } })).json().cardId;
    const op = prompts.find((x) => x.text.includes(`Inbox card #${o}`));
    assert.ok(op && !op.text.includes("vs inbox reply"), op?.text);
  });
});

describe("L2: inbox merge never folds a foreign card into a tester card", () => {
  const park = async (token, text) => (await call({ url: "/__vibesquad/inbox", method: "POST", headers: bearer(token), body: { teamId: "efi", text } })).json().cardId;
  const triage = (body) => call({ url: "/__vibesquad/inbox/triage", method: "POST", local: true, headers: ownerLocal(), body });

  test("attacker: owner card -> tester A card is refused (route + function); nothing changes", async () => {
    const a = await park(alice, "A-UNDELIVERED one");
    const owner = inbox.addInboxCards({ ideas: ["OWNER-MERGE-SECRET"], teamId: "efi", laneId: "efi-bugs", source: "ui" }, ROOT).added[0].id;
    const before = JSON.stringify(cards());
    const r = await triage({ action: "merge", targetId: a, sourceIds: [owner] });
    assert.equal(r.status, 400, r.body);
    assert.match(r.json().error, /alpha-tester card/);
    assert.throws(() => inbox.triageInboxCards({ action: "merge", targetId: a, sourceIds: [owner] }, ROOT), /same tester's cards/);
    assert.equal(JSON.stringify(cards()), before, "inbox untouched");
    const mine = (await call({ url: "/__vibesquad/inbox", headers: bearer(alice) })).json().cards.find((c) => c.id === a);
    assert.ok(!mine.text.includes("OWNER-MERGE-SECRET"));
  });

  test("attacker: tester B card -> tester A card is refused (alone or mixed with A's own card)", async () => {
    const a = await park(alice, "A-UNDELIVERED two");
    const a2 = await park(alice, "A-UNDELIVERED three");
    const b = await park(bob, "B-MERGE-SECRET");
    const before = JSON.stringify(cards());
    assert.equal((await triage({ action: "merge", targetId: a, sourceIds: [b] })).status, 400);
    assert.equal((await triage({ action: "merge", targetId: a, sourceIds: [a2, b] })).status, 400);
    assert.equal(JSON.stringify(cards()), before, "inbox untouched");
  });

  test("attacker: the same device's card from another Squad is refused", async () => {
    const a = await park(alice, "A-UNDELIVERED four");
    const all = cards();
    inbox.writeInboxCards([...all, { id: "idea-990101", text: "same device other squad", teamId: "oth", laneId: "oth-bugs", status: "parked", source: "alpha-tester", testerDeviceId: deviceId("Alice"), createdAt: "x" }]);
    assert.throws(() => inbox.triageInboxCards({ action: "merge", targetId: a, sourceIds: ["idea-990101"] }, ROOT), /same Squad/);
  });

  test("same tester, same Squad: merge is allowed and stays A's card", async () => {
    const a = await park(alice, "A-MERGE-OK first");
    const a2 = await park(alice, "A-MERGE-OK second");
    const r = await triage({ action: "merge", targetId: a, sourceIds: [a2] });
    assert.equal(r.status, 200, r.body);
    const t = cardById(a);
    assert.equal(t.testerDeviceId, deviceId("Alice"));
    assert.ok(t.text.includes("A-MERGE-OK second"));
  });

  test("non-tester target: merge is unchanged (owner card takes a tester card and an owner card)", async () => {
    const owner = inbox.addInboxCards({ ideas: ["owner target"], teamId: "efi", laneId: "efi-bugs", source: "ui" }, ROOT).added[0].id;
    const other = inbox.addInboxCards({ ideas: ["owner other"], teamId: "efi", laneId: "efi-bugs", source: "ui" }, ROOT).added[0].id;
    const b = await park(bob, "B into owner");
    const r = await triage({ action: "merge", targetId: owner, sourceIds: [other, b] });
    assert.equal(r.status, 200, r.body);
    const t = cardById(owner);
    assert.ok(t.text.includes("owner other") && t.text.includes("B into owner"));
    assert.equal("testerDeviceId" in t, false);
  });
});

describe("L1: tester SSE never carries the shared intake agent's timeline activity (review rn-b4d883e5fad2)", () => {
  /** Open GET /runner/events through the real middleware; the stream stays open until close(). */
  function openStream(opts) {
    const req = mkReq({ url: "/__vibesquad/runner/events", ...opts });
    const { res } = mkRes();
    res.on = () => res; // the stream only registers a close handler; req's close drives cleanup here
    mw(req, res, () => {});
    const events = () =>
      res.body
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice(6)));
    return { res, events, close: () => req.emit("close") };
  }
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const kinds = (s) => s.events().map((e) => e.kind);

  test("A gets nothing when the owner or tester B talks to intake; a tick (seq only) when a reply lands on A's card; owner stream unchanged", async () => {
    const A = openStream({ headers: bearer(alice) });
    const B = openStream({ headers: bearer(bob) });
    const O = openStream({ local: true, headers: ownerLocal() });
    const P = openStream({ headers: bearer(playtestDev) });
    try {
      await tick();
      assert.equal(A.res.statusCode, 200, A.res.body);
      assert.deepEqual(kinds(A), ["roster"]);
      const aBase = A.events().length;
      const bBase = B.events().length;

      // owner chats to the intake agent: the runner emits input/output timeline events
      const o = await call({ url: "/__vibesquad/runner/agents/rn-efibuddy/input", method: "POST", local: true, headers: ownerLocal(), body: { text: "OWNER-CHAT again" } });
      assert.equal(o.status, 200, o.body);
      emitRunner({ kind: "timeline", agentId: "rn-efibuddy", seq: 6, type: "input" });
      emitRunner({ kind: "timeline", agentId: "rn-efibuddy", seq: 7, type: "output" });
      // tester B talks to intake (both routes): stored under B's device only, plus the runner's raw timeline events
      assert.equal((await say(bob, { teamId: "efi", text: "B-SSE-1" })).status, 200);
      assert.equal((await call({ url: "/__vibesquad/runner/agents/rn-efibuddy/input", method: "POST", headers: bearer(bob), body: { text: "B-SSE-2" } })).status, 200);
      emitRunner({ kind: "timeline", agentId: "rn-efibuddy", seq: 8, type: "input" });
      emitRunner({ kind: "timeline", agentId: "rn-efibuddy", seq: 9, type: "output" });
      // the intake Buddy replies to B's card
      assert.equal((await reply({ cardId: bCard, text: "B-SSE reply" })).status, 200);
      await tick();

      assert.equal(A.events().length, aBase, `A saw: ${JSON.stringify(A.events().slice(aBase))}`);
      assert.ok(!A.res.body.includes('"timeline"') && !A.res.body.includes('"seq":6'), A.res.body);
      const bTicks = B.events().slice(bBase);
      assert.deepEqual(bTicks.map((e) => e.kind), ["tester-thread", "tester-thread", "tester-thread"], "B gets one tick per line on its own thread, nothing else");
      assert.ok(bTicks.every((e) => Object.keys(e).sort().join() === "kind,seq" && Number.isSafeInteger(e.seq)), JSON.stringify(bTicks));
      assert.ok(!B.res.body.includes('"timeline"'), "no raw timeline for B either");

      // owner stream: raw runner events as before, never a tester-thread tick
      assert.equal(O.res.statusCode, 200, O.res.body);
      const t = O.events().filter((e) => e.kind === "timeline");
      assert.deepEqual(t.map((e) => e.seq), [6, 7, 8, 9]);
      assert.deepEqual(t[0], { kind: "timeline", agentId: "rn-efibuddy", seq: 6, type: "input" });
      assert.ok(!O.events().some((e) => e.kind === "tester-thread"));
      // owner-playtest device: still refused the runner stream outright (unchanged)
      assert.equal(P.res.statusCode, 403, P.res.body);

      // a reply lands on A's card: A gets exactly one content-free tick whose seq matches A's thread
      const r = await reply({ cardId: aCard, text: "A-SSE reply" });
      assert.equal(r.status, 200, r.body);
      await tick();
      const aNew = A.events().slice(aBase);
      assert.deepEqual(aNew, [{ kind: "tester-thread", seq: r.json().seq }]);
      assert.ok(!A.res.body.includes("A-SSE reply") && !A.res.body.includes("rn-efibuddy\",\"seq"), "no text, no agentId on the tick");
      assert.equal(B.events().length, bBase + 3, "B never sees A's tick");
    } finally {
      for (const s of [A, B, O, P]) s.close();
    }
    // closed streams unsubscribe: a later reply writes nothing
    const after = A.res.body;
    assert.equal((await reply({ cardId: aCard, text: "after close" })).status, 200);
    await tick();
    assert.equal(A.res.body, after);
  });

  test("rn-630d32bc8390: cap+1 tester streams for one device -> 429, others untouched; close frees slots and listeners", async () => {
    const runnerApi = await import("../server/runner-api.mjs");
    const CAP = runnerApi.TESTER_STREAMS_PER_DEVICE;
    const aDev = deviceId("Alice");
    const bDev = deviceId("Bob");
    assert.equal(runnerApi.testerStreamCount(aDev), 0);
    assert.equal(tt.testerThreadListenerCount(aDev), 0);
    const open = [];
    try {
      for (let i = 0; i < CAP; i++) open.push(openStream({ headers: bearer(alice) }));
      await tick();
      for (const s of open) assert.equal(s.res.statusCode, 200, s.res.body);
      assert.equal(runnerApi.testerStreamCount(aDev), CAP);
      assert.equal(tt.testerThreadListenerCount(aDev), CAP);

      // cap+1: refused with 429; nothing subscribed, the open streams keep their slots
      const over = openStream({ headers: bearer(alice) });
      open.push(over);
      await tick();
      assert.equal(over.res.statusCode, 429, over.res.body);
      assert.match(over.res.body, /too many open event streams/);
      assert.equal(over.res.headers["retry-after"], "15");
      assert.equal(runnerApi.testerStreamCount(aDev), CAP);
      assert.equal(tt.testerThreadListenerCount(aDev), CAP);

      // another device and the owner are unaffected
      const B = openStream({ headers: bearer(bob) });
      const O = openStream({ local: true, headers: ownerLocal() });
      open.push(B, O);
      await tick();
      assert.equal(B.res.statusCode, 200, B.res.body);
      assert.equal(O.res.statusCode, 200, O.res.body);
      assert.equal(runnerApi.testerStreamCount(bDev), 1);

      // ticks still reach every surviving stream; the refused one gets nothing
      const base = open.slice(0, CAP).map((s) => s.events().length);
      const overBody = over.res.body;
      const r = await reply({ cardId: aCard, text: "cap tick" });
      assert.equal(r.status, 200, r.body);
      await tick();
      open.slice(0, CAP).forEach((s, i) => assert.deepEqual(s.events().slice(base[i]), [{ kind: "tester-thread", seq: r.json().seq }]));
      assert.equal(over.res.body, overBody);

      // closing one frees its slot: a new stream for the same device is admitted
      open[0].close();
      assert.equal(runnerApi.testerStreamCount(aDev), CAP - 1);
      assert.equal(tt.testerThreadListenerCount(aDev), CAP - 1);
      const again = openStream({ headers: bearer(alice) });
      open.push(again);
      await tick();
      assert.equal(again.res.statusCode, 200, again.res.body);
      assert.equal(runnerApi.testerStreamCount(aDev), CAP);
    } finally {
      for (const s of open) s.close();
    }
    assert.equal(runnerApi.testerStreamCount(aDev), 0, "every slot released");
    assert.equal(runnerApi.testerStreamCount(bDev), 0);
    assert.equal(tt.testerThreadListenerCount(aDev), 0, "every listener unsubscribed");
    assert.equal(tt.testerThreadListenerCount(bDev), 0);
  });

  test("rn-630d32bc8390 backstop: onTesterThreadLine refuses past the per-device cap, never throws, append still ticks", async () => {
    const dev = "dev-listener-cap-test";
    const MAX = tt.TESTER_THREAD_LISTENERS_MAX;
    const got = [];
    const offs = [];
    for (let i = 0; i < MAX; i++) offs.push(tt.onTesterThreadLine(dev, (e) => got.push([i, e.seq])));
    assert.equal(tt.testerThreadListenerCount(dev), MAX);
    const warn = console.warn;
    let warned = 0;
    console.warn = () => warned++;
    let extraOff;
    try {
      extraOff = tt.onTesterThreadLine(dev, () => got.push(["extra"]));
    } finally {
      console.warn = warn;
    }
    assert.equal(typeof extraOff, "function");
    assert.equal(warned, 1);
    assert.equal(tt.testerThreadListenerCount(dev), MAX);
    assert.equal(tt.testerThreadListenerCount("dev-listener-cap-other"), 0, "other device unaffected");
    const other = tt.onTesterThreadLine("dev-listener-cap-other", () => {});
    assert.equal(tt.testerThreadListenerCount("dev-listener-cap-other"), 1);
    other();
    const line = await tt.appendTesterThreadLine(dev, { role: "user", kind: "chat", teamId: "efi", text: "cap backstop" });
    assert.equal(got.length, MAX);
    assert.ok(got.every(([i, seq]) => i !== "extra" && seq === line.seq));
    extraOff();
    assert.equal(tt.testerThreadListenerCount(dev), MAX, "the refused no-op unsubscribe touches nothing");
    for (const off of offs) off();
    assert.equal(tt.testerThreadListenerCount(dev), 0);
  });

  test("createTesterEventFilter drops every raw timeline event, allowed agent or not", async () => {
    const runnerApi = await import("../server/runner-api.mjs");
    const teams = runnerApi.testerTeamRecords({ allowedTeams: ["efi"] }, TEAMS);
    const filter = runnerApi.createTesterEventFilter(() => teams);
    filter({ kind: "roster", agents: AGENTS });
    for (const type of ["input", "output", "tool_call", "meta"]) assert.deepEqual(filter({ kind: "timeline", agentId: "rn-efibuddy", seq: 1, type }), [], type);
    assert.deepEqual(filter({ kind: "tester-thread", seq: 1 }), [], "a backend event can never forge a tester tick");
  });
});
