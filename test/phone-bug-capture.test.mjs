// E3 (docs/PLAN_ANDROID_END_STATE.md): phone fast bug capture. Card format agreed with Bug13: laneId = the Squad's
// bug lane, source "phone-apk", stamp as text line 1, optional `attachments` + "Screenshot: <path>" line.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

// Hermetic: own VIBESQUAD_HOME + teams registry, never the real ~/.vibesquad.
process.env.VS_DEFAULT_BACKEND = "paseo";
delete process.env.VS_BACKEND;
const home = mkdtempSync(join(tmpdir(), "vs-phone-bug-"));
process.env.VIBESQUAD_HOME = home;
const teamsFile = join(home, "teams.json");
writeFileSync(
  teamsFile,
  JSON.stringify({ teams: [{ id: "vibesquad", name: "VibeSquad", lanes: [{ id: "vibesquad", name: "VibeSquad", hub: true }, { id: "bug-chaser", name: "Bug Chaser", kind: "bug" }] }] }),
);
process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
const auth = await import("../server/auth.mjs");
const api = await import("../server/vibesquad-api.mjs");
const inbox = await import("../server/inbox.mjs");
const { phoneBugStamp, submitPhoneBug } = await import("../src/phoneBugCapture.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const repoRoot = join(import.meta.dirname, "..");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(16)]);

function call(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => ok({ status: res.statusCode, body: data }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

describe("phone bug capture", () => {
  let srv;
  let port;
  const owner = (type) => ({ "x-vibesquad-token": auth.getLocalToken(), "content-type": type });
  const park = async () => {
    const r = await call(port, "/__vibesquad/inbox", { method: "POST", headers: owner("application/json"), body: JSON.stringify({ text: "phone bug", laneId: "bug-chaser", teamId: "vibesquad", source: "phone-apk" }) });
    return JSON.parse(r.body).added[0].id;
  };
  const upload = (cardId, bytes, type = "image/png", headers = owner(type)) => call(port, `/__vibesquad/inbox/attachment?cardId=${encodeURIComponent(cardId)}`, { method: "POST", headers: { ...headers, "content-type": type }, body: bytes });
  before(async () => {
    srv = createServer(api.createVibesquadMiddleware(repoRoot));
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    port = srv.address().port;
  });
  after(async () => {
    srv.closeAllConnections?.();
    await new Promise((ok) => srv.close(ok));
  });

  test("stamp: src, lane, Android APK; hostId only when present", () => {
    assert.equal(phoneBugStamp({ squad: "vibesquad", lane: "ui-bois" }), "📱 Android APK · src=vibesquad · lane=ui-bois");
    assert.match(phoneBugStamp({ squad: "vibesquad", hostId: "h-1" }), /host=h-1$/);
  });

  test("submitPhoneBug parks in the bug lane with source phone-apk, uploads, then sends", async () => {
    const seen = [];
    const f = async (url, init) => {
      seen.push([url, init?.method, init?.headers?.["content-type"]]);
      if (url === "/__vibesquad/inbox") return new Response(JSON.stringify({ ok: true, added: [{ id: "idea-7" }] }));
      return new Response(JSON.stringify({ ok: true }));
    };
    const shot = new Blob([PNG], { type: "image/png" });
    const r = await submitPhoneBug({ text: "  boom ", teamId: "vibesquad", bugLaneId: "bug-chaser", ctx: { squad: "vibesquad" }, shots: [shot] }, f);
    assert.deepEqual(r, { cardId: "idea-7", delivered: true });
    assert.deepEqual(seen.map((s) => s[0]), ["/__vibesquad/inbox", "/__vibesquad/inbox/attachment?cardId=idea-7", "/__vibesquad/inbox/send"]);
    await assert.rejects(submitPhoneBug({ text: " ", teamId: "t", bugLaneId: "b", ctx: { squad: "t" } }, f), /Describe/);
  });

  test("upload saves under inbox-media/<cardId> with a server filename and links it in the card", async () => {
    const id = await park();
    const r = await upload(id, PNG);
    assert.equal(r.status, 200, r.body);
    const dir = join(home, "inbox-media", id);
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^shot-[0-9a-f]{12}\.png$/);
    const card = inbox.readInboxCards(home).find((c) => c.id === id);
    assert.equal(card.attachments[0].path, join(dir, files[0]));
    assert.match(card.text, /Screenshot: .*shot-/);
    assert.equal(card.source, "phone-apk");
    assert.ok((await upload(id, JPG, "image/jpeg")).status === 200);
    assert.ok((await upload(id, WEBP, "image/webp")).status === 200);
  });

  test("(a) auth: no token or a read-only caller is refused, and body/query baseHome cannot redirect the write", async () => {
    const id = await park();
    const anon = await call(port, `/__vibesquad/inbox/attachment?cardId=${id}`, { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
    assert.ok(anon.status === 401 || anon.status === 403, anon.body);
    assert.equal(existsSync(join(home, "inbox-media", id)), false);
    const evil = mkdtempSync(join(tmpdir(), "vs-phone-evil-"));
    try {
      const r = await call(port, `/__vibesquad/inbox/attachment?cardId=${id}&baseHome=${encodeURIComponent(evil)}`, { method: "POST", headers: owner("image/png"), body: PNG });
      assert.equal(r.status, 200, r.body);
      assert.deepEqual(readdirSync(evil), []);
      assert.equal(existsSync(join(home, "inbox-media", id)), true);
    } finally {
      rmSync(evil, { recursive: true, force: true });
    }
  });

  test("(b) cardId must be a real idea-N card; traversal is a 400", async () => {
    for (const bad of ["../x", "..%2F..%2Fx", "idea-1/../../x", "idea-abc", "", "idea-99999"]) {
      const r = await call(port, `/__vibesquad/inbox/attachment?cardId=${bad}`, { method: "POST", headers: owner("image/png"), body: PNG });
      assert.equal(r.status, 400, `${bad}: ${r.body}`);
    }
    assert.equal(existsSync(join(home, "x")), false);
  });

  test("(d) MIME allowlist plus magic-byte sniffing", async () => {
    const id = await park();
    assert.equal((await upload(id, PNG, "image/gif")).status, 400);
    assert.equal((await upload(id, Buffer.from("<svg onload=x>"), "image/svg+xml")).status, 400);
    assert.equal((await upload(id, Buffer.from("not an image at all"), "image/png")).status, 400);
    assert.equal((await upload(id, JPG, "image/png")).status, 400); // declared png, bytes jpeg
    assert.equal((await upload(id, Buffer.alloc(0), "image/png")).status, 400);
    assert.equal(existsSync(join(home, "inbox-media", id)), false);
  });

  test("(e) size cap (8 MB) and per-card count cap", async () => {
    const id = await park();
    const big = Buffer.concat([PNG, Buffer.alloc(inbox.INBOX_MEDIA_MAX_BYTES)]);
    const r = await upload(id, big).catch((e) => ({ status: 413, body: String(e) })); // server may reset the socket after 413
    assert.equal(r.status, 413);
    for (let i = 0; i < inbox.INBOX_MEDIA_MAX_PER_CARD; i++) assert.equal((await upload(id, PNG)).status, 200);
    const over = await upload(id, PNG);
    assert.equal(over.status, 400);
    assert.match(over.body, /at most/);
  });

  test("(f) writes via temp file then rename: no .tmp left behind", async () => {
    const id = await park();
    await upload(id, PNG);
    assert.ok(readdirSync(join(home, "inbox-media", id)).every((f) => !f.endsWith(".tmp")));
  });

  test("(g) archiving or deleting the card removes inbox-media/<cardId>", async () => {
    const a = await park();
    const d = await park();
    await upload(a, PNG);
    await upload(d, PNG);
    inbox.triageInboxCards({ action: "archive", cardId: a, baseHome: home }, repoRoot);
    assert.equal(existsSync(join(home, "inbox-media", a)), false);
    inbox.triageInboxCards({ action: "delete", cardId: d, baseHome: home }, repoRoot);
    assert.equal(existsSync(join(home, "inbox-media", d)), false);
  });

  test("a delivered card refuses new attachments; saved text survives into the delivery prompt", async () => {
    const id = await park();
    await upload(id, PNG);
    const sent = [];
    const client = {
      async fetchAgents() {
        return { entries: [{ agent: { id: "bud", status: "idle", title: "bug buddy", labels: { role: "brainstorm", team: "vibesquad", lane: "bug-chaser" } } }] };
      },
      async sendAgentPrompt(agentId, text) {
        sent.push({ agentId, text });
      },
    };
    await inbox.sendInboxCard({ cardId: id, baseHome: home, agentClient: client }, repoRoot);
    assert.equal(sent[0].agentId, "bud");
    assert.match(sent[0].text, /Screenshot: /);
    assert.equal((await upload(id, PNG)).status, 400);
  });

  test("bodyLimit: >1 MB and <8 MB uploads pass the real route; >8 MB is 413", async () => {
    const id = await park();
    const mid = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024, 3)]);
    assert.equal((await upload(id, mid)).status, 200);
    const big = Buffer.concat([PNG, Buffer.alloc(inbox.INBOX_MEDIA_MAX_BYTES + 1024)]);
    const r = await upload(id, big).catch(() => ({ status: 413 }));
    assert.equal(r.status, 413);
    // every other route keeps the 1 MB limit
    const other = await call(port, "/__vibesquad/inbox", { method: "POST", headers: owner("application/json"), body: JSON.stringify({ text: "x".repeat(1100 * 1024), laneId: "bug-chaser" }) }).catch(() => ({ status: 413 }));
    assert.equal(other.status, 413);
  });

  test("merge carries screenshots to the target and drops the source dirs; archive via update cleans media", async () => {
    const a = await park();
    const b = await park();
    await upload(a, PNG);
    await upload(b, JPG, "image/jpeg");
    const srcPath = inbox.readInboxCards(home).find((c) => c.id === b).attachments[0].path;
    inbox.triageInboxCards({ action: "merge", targetId: a, sourceIds: [b], baseHome: home }, repoRoot);
    const target = inbox.readInboxCards(home).find((c) => c.id === a);
    assert.equal(target.attachments.length, 2);
    assert.ok(target.attachments.every((x) => x.path.startsWith(join(home, "inbox-media", a))));
    assert.equal(target.text.includes(srcPath), false);
    assert.ok(target.text.includes(target.attachments[1].path));
    assert.equal(existsSync(join(home, "inbox-media", b)), false);
    inbox.triageInboxCards({ action: "update", cardId: a, patch: { status: "archived" }, baseHome: home }, repoRoot);
    assert.equal(existsSync(join(home, "inbox-media", a)), false);
  });

  test("attach re-checks under the lock: a failed attach leaves no orphan file", async () => {
    const id = await park();
    for (let i = 0; i < inbox.INBOX_MEDIA_MAX_PER_CARD; i++) await inbox.attachInboxMedia({ cardId: id, mime: "image/png", bytes: PNG, baseHome: home });
    const before = readdirSync(join(home, "inbox-media", id)).sort();
    await assert.rejects(() => inbox.attachInboxMedia({ cardId: id, mime: "image/png", bytes: PNG, baseHome: home }), /at most/);
    assert.deepEqual(readdirSync(join(home, "inbox-media", id)).sort(), before);
    // stale precheck: card flips to delivered between the read and the lock
    const id2 = await park();
    const orig = inbox.readInboxCards(home);
    const c = orig.find((x) => x.id === id2);
    c.status = "archived";
    inbox.writeInboxCards(orig, home);
    await assert.rejects(() => inbox.attachInboxMedia({ cardId: id2, mime: "image/png", bytes: PNG, baseHome: home }), /archived/);
    assert.equal(existsSync(join(home, "inbox-media", id2)), false);
  });
});
