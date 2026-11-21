// E6b: Alpha Tester Desk. userName role state, App wiring, TesterCockpit contract, ALPHA TESTER badge, bug submission.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const un = await import("../src/userName.ts");
const { submitPhoneBug, phoneBugStamp, pickBugImages } = await import("../src/phoneBugCapture.ts");

describe("userName device role", () => {
  test("bug-tester role, allowedTeams and deviceName come from health/auth status", () => {
    assert.equal(un.getDeviceRole(), "owner");
    un.setLocalAccess("bug-tester", { role: "bug-tester", allowedTeams: ["efi", "sbb"], deviceName: " Sam's phone " });
    assert.equal(un.getDeviceRole(), "bug-tester");
    assert.deepEqual(un.getAllowedTeams(), ["efi", "sbb"]);
    assert.equal(un.getDeviceName(), "Sam's phone");
    un.setLocalAccess("bug-tester", { allowedTeams: ["efi"] });
    assert.deepEqual(un.getAllowedTeams(), ["efi"]);
  });
  test("owner and read-only reset the scoped fields", () => {
    un.setLocalAccess("read-only");
    assert.equal(un.getDeviceRole(), "read-only");
    assert.deepEqual(un.getAllowedTeams(), []);
    assert.equal(un.getDeviceName(), null);
    un.setLocalAccess(undefined);
    assert.equal(un.getDeviceRole(), "owner");
  });
  test("exports hooks and stays backward compatible", () => {
    const src = read("src/userName.ts");
    for (const n of ["useDeviceRole", "useAllowedTeams", "useDeviceName", "useLocalReadOnly"]) assert.match(src, new RegExp(`export function ${n}`));
  });
});

describe("App + TesterCockpit wiring", () => {
  const app = read("src/App.tsx");
  const tc = read("src/TesterCockpit.tsx");
  test("App mounts TesterCockpit for bug-tester before the phone shell and desktop chrome", () => {
    const i = app.indexOf('deviceRole === "bug-tester"');
    assert.ok(i > 0);
    assert.match(app.slice(i, i + 200), /<TesterCockpit/);
    assert.ok(i < app.indexOf("if (phoneShell) {"));
  });
  test("cockpit has Log Bug, Unpair, squad picker, chat-only drawer and offline fallback", () => {
    for (const id of ["tester-log-bug-btn", "tester-unpair-btn", "tester-squad-select", "tester-squad-badge", "tester-offline"]) assert.ok(tc.includes(id), id);
    assert.match(tc, /<AgentDrawer[^>]*chatOnly/);
    assert.match(tc, /Bug Desk is offline right now/);
    assert.match(tc, /allowed\.length|squads\.length > 1/);
  });
});

describe("IdeaInbox badge", () => {
  test("renders ALPHA TESTER chip for source alpha-tester with device name", () => {
    const s = read("src/IdeaInbox.tsx");
    assert.match(s, /source === "alpha-tester"/);
    assert.match(s, /data-testid="inbox-tester-badge"/);
    assert.match(s, /testerDeviceName/);
    assert.match(read("src/styles.css"), /\.inbox-tester-badge/);
    assert.match(read("src/styles.css"), /\.tester-cockpit/);
  });
});

describe("bug submission", () => {
  test("tester reports park in the bug lane as alpha-tester, upload shots, then send", async () => {
    const calls = [];
    const f = async (url, init) => {
      calls.push({ url, init });
      const j = url === "/__vibesquad/inbox" ? { ok: true, added: [{ id: "77" }] } : { ok: true };
      return { ok: true, status: 200, json: async () => j };
    };
    const shot = new Blob(["x"], { type: "image/png" });
    const out = await submitPhoneBug({ text: "boom", teamId: "efi", bugLaneId: "bugs", ctx: { squad: "efi", lane: "bugs", testerDeviceName: "Sam" }, shots: [shot] }, f);
    assert.deepEqual(out, { cardId: "77", delivered: true });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.source, "alpha-tester");
    assert.equal(body.laneId, "bugs");
    assert.match(body.text, /^\[Alpha Tester: Sam\]/);
    assert.match(calls[1].url, /inbox\/attachment\?cardId=77/);
    assert.equal(calls[2].url, "/__vibesquad/inbox/send");
    assert.match(phoneBugStamp({ squad: "efi" }), /Android APK/);
  });
  test("pickBugImages keeps only small image files from clipboard items", () => {
    const f = new File(["x"], "a.png", { type: "image/png" });
    const items = [{ kind: "file", type: "image/png", getAsFile: () => f }, { kind: "string", type: "text/plain" }, { kind: "file", type: "application/pdf", getAsFile: () => f }];
    assert.deepEqual(pickBugImages(items), [f]);
  });
});
