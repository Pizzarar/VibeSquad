// E6c (docs/PLAN_E6_TESTER_ROLES.md): scoped alpha-tester invites. Pure helpers, the two pair UIs' wiring, and the CLI
// (`vs pair --role bug-tester --team efi`, `vs devices list`) against a real in-process server.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { transformSync } from "rolldown/utils";

const home = mkdtempSync(join(tmpdir(), "vs-tester-invite-"));
process.env.VIBESQUAD_HOME = home;
process.env.PASEO_HOME = join(home, "paseo");
writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [] }));
const auth = await import("../server/auth.mjs");
const cli = await import("../cli/vs.mjs");
after(() => rmSync(home, { recursive: true, force: true }));

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const logicSrc = read("src/phonePairLogic.ts");
const logic = await import(
  "data:text/javascript;base64," +
    Buffer.from(transformSync("phonePairLogic.ts", logicSrc, { lang: "ts" }).code).toString("base64"),
);

const VS = new URL("../cli/vs.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const childEnv = (extra) => ({ ...process.env, VIBESQUAD_HOME: home, PASEO_AGENT_ID: "", VS_AGENT_ID: "", VS_AGENT_TOKEN: "", ...extra });
const vs = (args, extra = {}) => {
  const r = spawnSync(process.execPath, [VS, ...args], { encoding: "utf8", env: childEnv(extra), windowsHide: true, timeout: 60_000 });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const vsAsync = (args, extra = {}) =>
  new Promise((ok, fail) => {
    const child = spawn(process.execPath, [VS, ...args], { env: childEnv(extra), windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (err += d));
    child.on("error", fail);
    child.on("close", (status) => ok({ status, out, err }));
  });

describe("phonePairLogic tester helpers", () => {
  test("defaultTesterTeams prefers efi, then the active Squad, then the first", () => {
    assert.deepEqual(logic.defaultTesterTeams([{ id: "vs" }, { id: "efi" }], "vs"), ["efi"]);
    assert.deepEqual(logic.defaultTesterTeams([{ id: "vs" }, { id: "sbb" }], "sbb"), ["sbb"]);
    assert.deepEqual(logic.defaultTesterTeams([{ id: "vs" }, { id: "sbb" }], "gone"), ["vs"]);
    assert.deepEqual(logic.defaultTesterTeams([{ id: "vs" }], null), ["vs"]);
    assert.deepEqual(logic.defaultTesterTeams([], "vs"), []);
  });

  test("formatDeviceRoleBadge shows scope for testers only", () => {
    assert.equal(logic.formatDeviceRoleBadge({ role: "bug-tester", allowedTeams: ["efi"] }), "TESTER · efi");
    assert.equal(logic.formatDeviceRoleBadge({ role: "bug-tester", allowedTeams: ["efi", "vs"] }), "TESTER · efi, vs");
    assert.equal(logic.formatDeviceRoleBadge({ role: "owner", allowedTeams: null }), null);
    assert.equal(logic.formatDeviceRoleBadge({ role: "owner-playtest", allowedTeams: null }), "PLAYTEST");
    assert.deepEqual(logic.buildPairStartBody("owner-playtest", ["efi"]), { role: "owner-playtest", allowedTeams: null });
    assert.equal(logic.formatDeviceRoleBadge({}), null);
    assert.equal(logic.formatDeviceRoleBadge(null), null);
  });

  test("buildPairStartBody / pairStartInit: owner stays owner, tester needs Squads", () => {
    assert.deepEqual(logic.buildPairStartBody("owner", ["efi"]), { role: "owner" }, "an owner invite never carries Squads");
    assert.deepEqual(logic.buildPairStartBody("bug-tester", ["efi", "efi", "vs"]), { role: "bug-tester", allowedTeams: ["efi", "vs"] });
    assert.throws(() => logic.buildPairStartBody("bug-tester", []), /at least one Squad/);
    const init = logic.pairStartInit("bug-tester", ["efi"]);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(init.body), { role: "bug-tester", allowedTeams: ["efi"] });
  });
});

describe("pair UIs wire the role selector", () => {
  for (const [file, prefix] of [
    ["src/PairDeviceModal.tsx", "pair"],
    ["src/PhonePairSheet.tsx", "phone-pair"],
  ]) {
    test(`${file}: role selector, Squad checkboxes, scoped mint, role badges`, () => {
      const src = read(file);
      assert.match(src, /DEVICE ACCESS ROLE/);
      assert.match(src, /OWNER_ROLE_LABEL/);
      assert.match(src, /TESTER_ROLE_LABEL/);
      assert.match(src, /defaultTesterTeams\(/);
      assert.match(src, /type="checkbox"/);
      assert.match(src, /pairStartInit\(/, "pair/start goes through the JSON-body helper");
      assert.ok(!/pair\/start", \{ method: "POST" \}/.test(src), "no bare body-less mint left");
      assert.match(src, /testerBlocked/, "0 Squads checked blocks minting");
      assert.match(src, /setPair\(null\)/, "role switch / Squad toggle clears the stale code");
      assert.ok((src.match(/formatDeviceRoleBadge\(/g) ?? []).length >= 4, "badge on pending approvals and paired devices");
      assert.ok(src.includes(`${prefix}-role-badge`));
    });
  }
  for (const file of ["src/PairDeviceModal.tsx", "src/PhonePairSheet.tsx"]) {
    test(`${file}: a stale in-flight mint can never land under another role`, () => {
      const src = read(file);
      assert.ok(src.includes("mintSeqRef = useRef(0)"));
      assert.ok(src.includes("const seq = ++mintSeqRef.current"));
      assert.ok(src.includes("seq !== mintSeqRef.current) return"), "response dropped when superseded");
      const change = src.slice(src.indexOf("const changeRole"), src.indexOf("const toggleSquad"));
      const toggle = src.slice(src.indexOf("const toggleSquad"), src.indexOf("const toggleSquad") + 400);
      assert.ok(change.includes("mintSeqRef.current++"), "role switch invalidates");
      assert.ok(toggle.includes("mintSeqRef.current++"), "Squad toggle invalidates");
      assert.ok(!/className={role ===/.test(src), "no string literals from role comparisons inside className");
    });
  }
  test("labels are the spec strings", () => {
    assert.equal(logic.OWNER_ROLE_LABEL, "Owner (full access)");
    assert.equal(logic.TESTER_ROLE_LABEL, "Alpha Tester (Log Bug + Bug Desk chat only)");
  });
  test("PairDeviceModal keeps the APK card and CA fingerprint", () => {
    const src = read("src/PairDeviceModal.tsx");
    assert.match(src, /android-apk-card/);
    assert.match(src, /download-android-apk/);
    assert.match(src, /showFullFp/);
  });
});

describe("vs pair --role / --team", () => {
  test("parsePairScope", () => {
    assert.deepEqual(cli.parsePairScope(cli.parseArgs(["pair"])), {});
    assert.deepEqual(cli.parsePairScope(cli.parseArgs(["pair", "--role", "owner"])), { role: "owner" });
    assert.deepEqual(cli.parsePairScope(cli.parseArgs(["pair", "--role", "bug-tester", "--team", "efi"])), { role: "bug-tester", allowedTeams: ["efi"] });
    assert.deepEqual(cli.parsePairScope(cli.parseArgs(["pair", "--role", "bug-tester", "--team", "efi,vs", "--team", "sbb"])), { role: "bug-tester", allowedTeams: ["efi", "vs", "sbb"] });
    assert.throws(() => cli.parsePairScope(cli.parseArgs(["pair", "--role", "bug-tester"])), /needs --team/);
    assert.throws(() => cli.parsePairScope(cli.parseArgs(["pair", "--role", "root"])), /unknown --role/);
    assert.throws(() => cli.parsePairScope(cli.parseArgs(["pair", "--team", "efi"])), /only applies with --role bug-tester/);
  });

  test("bug-tester without --team exits non-zero with usage", () => {
    const r = vs(["pair", "--role", "bug-tester"]);
    assert.notEqual(r.status, 0);
    assert.match(r.err, /--role bug-tester needs --team/);
    assert.match(r.err, /usage: vs pair/);
  });

  test("formatPairOutput prints the scope for a tester invite", () => {
    const text = cli.formatPairOutput({ code: "123456", pairUrl: "https://pc:4180/pair?code=123456", role: "bug-tester", allowedTeams: ["efi", "vs"], caFingerprint: { full: "AA:BB" } });
    assert.match(text, /Role:\s+bug-tester \[efi, vs\]/);
    assert.ok(!/Role:/.test(cli.formatPairOutput({ code: "123456", pairUrl: "https://pc:4180/pair?code=123456", role: "owner", caFingerprint: { full: "AA:BB" } })));
  });

  test("mints a scoped invite on the real server; the device it pairs lists as bug-tester [efi]", async () => {
    process.env.VIBESQUAD_MESHNET_IP = "100.64.0.7";
    process.env.VIBESQUAD_MESHNET_HOST = "home-pc.test";
    const { server } = await import("../server/serve.mjs");
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    try {
      const port = String(server.address().port);
      auth.getLocalToken();
      const r = await vsAsync(["pair", "--role", "bug-tester", "--team", "efi"], { VIBESQUAD_PORT: port });
      assert.equal(r.status, 0, r.err);
      assert.match(r.out, /Role:\s+bug-tester \[efi\]/);
      const j = JSON.parse((await vsAsync(["pair", "--role", "bug-tester", "--team", "efi", "--json"], { VIBESQUAD_PORT: port })).out);
      assert.equal(j.role, "bug-tester");
      assert.deepEqual(j.allowedTeams, ["efi"]);

      // Redeem the code and read it back through `vs devices list`.
      const code = j.code;
      const res = { statusCode: 200, headers: {}, body: "", setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, getHeader(k) { return this.headers[k.toLowerCase()]; }, end(b) { this.body += b ?? ""; } };
      await auth.handlePairRedeem({ url: `/pair?code=${code}&name=Tester%20phone`, method: "GET", headers: { host: "home-pc.test:4180" }, socket: { remoteAddress: "100.64.0.41" }, on() {} }, res);
      assert.equal(res.statusCode, 302, res.body);
      const list = vs(["devices", "list"]);
      assert.equal(list.status, 0, list.err);
      assert.match(list.out, /Tester phone.*bug-tester \[efi\]/);
    } finally {
      await new Promise((ok) => server.close(ok));
    }
  });
});
