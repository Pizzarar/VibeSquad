import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { checkSetup, runCheck, signFile } from "../scripts/sign-windows.mjs";
import { parseArgs, runRelease } from "../server/release.mjs";

const SECRET = "client-S3CRET-value";
const UPDATER_PW = "TAURI_SIGNING_PRIVATE_KEY_PASSWORD";
const HOME = "/h";
const FILES = {
  "/h/.vibesquad/signing/metadata.json": JSON.stringify({ Endpoint: "https://wus2.codesigning.azure.net", CodeSigningAccountName: "acct", CertificateProfileName: "prof", ExcludeCredentials: ["ManagedIdentityCredential"] }),
  "/h/.vibesquad/signing/azure.json": JSON.stringify({ tenantId: "tenant-1", clientId: "client-1" }),
  "/t/signtool.exe": "",
  "/t/Azure.CodeSigning.Dlib.dll": "",
};
const norm = (p) => String(p).replaceAll(String.fromCharCode(92), "/");

function rig({ drop = [], secret = SECRET, extra = {} } = {}) {
  const files = { ...FILES, ...extra };
  for (const k of drop) delete files[k];
  const logs = [];
  const calls = [];
  const deps = {
    env: { VS_SIGNTOOL: "/t/signtool.exe", VS_SIGN_DLIB: "/t/Azure.CodeSigning.Dlib.dll", VS_SIGN_DIR: "/h/.vibesquad/signing" },
    home: HOME,
    exists: (p) => norm(p) in files,
    readFile: (p) => files[norm(p)],
    readdir: () => [],
    read: (t) => (t === "vibesquad/artifact-signing" ? secret : null),
    log: (m) => logs.push(String(m)),
    exec: (cmd, args, opts) => calls.push({ cmd, args, env: opts.env }),
  };
  return { deps, logs, calls };
}

describe("sign-windows", () => {
  test("sign then verify; secret only in child env; /tr + /td SHA256 always passed", () => {
    const { deps, logs, calls } = rig();
    signFile("C:/out/app.exe", deps);
    assert.equal(calls.length, 2);
    const [sign, verify] = calls;
    assert.equal(sign.args[0], "sign");
    assert.equal(verify.args[0], "verify");
    assert.deepEqual(verify.args, ["verify", "/pa", "/v", "C:/out/app.exe"]);
    const a = sign.args;
    assert.equal(a[a.indexOf("/tr") + 1], "http://timestamp.acs.microsoft.com");
    assert.equal(a[a.indexOf("/td") + 1], "SHA256");
    assert.equal(a[a.indexOf("/fd") + 1], "SHA256");
    assert.ok(a.includes("/dlib") && a.includes("/dmdf"));
    assert.equal(a.at(-1), "C:/out/app.exe");
    for (const c of calls) {
      assert.equal(c.env.AZURE_CLIENT_SECRET, SECRET);
      assert.equal(c.env.AZURE_CLIENT_ID, "client-1");
      assert.equal(c.env.AZURE_TENANT_ID, "tenant-1");
    }
    assert.ok(!calls.flatMap((c) => c.args).some((x) => String(x).includes(SECRET)));
    assert.ok(!logs.join("\n").includes(SECRET));
    assert.equal(deps.env.AZURE_CLIENT_SECRET, undefined);
    assert.equal(process.env.AZURE_CLIENT_SECRET, undefined);
  });

  test("signtool never gets the updater key password, in any case variant", () => {
    const { deps, calls } = rig();
    Object.assign(deps.env, { [UPDATER_PW]: "updater-pw", tauri_signing_private_key_password: "updater-pw2" });
    signFile("C:/out/app.exe", deps);
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.deepEqual(Object.keys(c.env).filter((k) => k.toUpperCase() === UPDATER_PW), []);
      assert.equal(c.env.AZURE_CLIENT_SECRET, SECRET);
    }
    assert.equal(deps.env[UPDATER_PW], "updater-pw"); // caller's env not mutated
  });

  test("as tauri's signCommand (real process): no child inherits the updater key password", () => {
    // signtool = this node binary with a --require preload that records the env it was started with; the AZURE_*
    // values come from the env (dummy), so no credential store is read. The updater key password is a dummy too.
    const dir = mkdtempSync(join(tmpdir(), "vs-signwin-"));
    try {
      const dump = join(dir, "dump.jsonl");
      const preload = join(dir, "fake-signtool.cjs");
      writeFileSync(
        preload,
        `const a = process.argv;
if (a.includes("/dmdf") || a.includes("/pa")) {
  const leaked = Object.keys(process.env).filter((k) => k.toUpperCase() === "${UPDATER_PW}");
  require("fs").appendFileSync(process.env.VS_TEST_DUMP, JSON.stringify({ verb: a.includes("/pa") ? "verify" : "sign", leaked, secret: process.env.AZURE_CLIENT_SECRET === "dummy-secret" }) + "\\n");
  process.exit(0);
}`,
      );
      writeFileSync(join(dir, "metadata.json"), JSON.stringify({ Endpoint: "e", CodeSigningAccountName: "a", CertificateProfileName: "p" }));
      writeFileSync(join(dir, "dlib.dll"), "");
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== UPDATER_PW && !/^AZURE_|^VS_SIGN/i.test(k) && k.toUpperCase() !== "NODE_OPTIONS"));
      Object.assign(env, {
        [UPDATER_PW]: "dummy-updater-pw",
        NODE_OPTIONS: `--require "${preload.replaceAll("\\", "/")}"`,
        VS_TEST_DUMP: dump,
        VS_SIGNTOOL: process.execPath,
        VS_SIGN_DLIB: join(dir, "dlib.dll"),
        VS_SIGN_DIR: dir,
        AZURE_TENANT_ID: "t",
        AZURE_CLIENT_ID: "c",
        AZURE_CLIENT_SECRET: "dummy-secret",
      });
      const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "sign-windows.mjs");
      const r = spawnSync(process.execPath, [script, join(dir, "app.exe")], { env, encoding: "utf8", windowsHide: true });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.ok(existsSync(dump), r.stdout);
      const rows = readFileSync(dump, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(rows.map((x) => x.verb), ["sign", "verify"]);
      for (const row of rows) {
        assert.deepEqual(row.leaked, [], `${row.verb} inherited the updater key password`);
        assert.equal(row.secret, true);
      }
      assert.ok(!(r.stdout + r.stderr).includes("dummy-updater-pw"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("main entry detaches the updater key password before any work", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "sign-windows.mjs"), "utf8");
    assert.match(src, /if \(isMain\) \{\s*(\/\/[^\n]*\n\s*)*detachUpdaterKeyPassword\(\);/);
  });

  test("a failing signtool sign propagates and verify never runs", () => {
    const { deps, calls } = rig();
    deps.exec = (cmd, args) => {
      calls.push(args[0]);
      if (args[0] === "sign") throw new Error("signtool failed");
    };
    assert.throws(() => signFile("f.exe", deps), /signtool failed/);
    assert.deepEqual(calls, ["sign"]);
  });

  test("preflight messages", () => {
    const msg = (opts) => {
      const { deps } = rig(opts);
      assert.throws(() => signFile("f.exe", deps), (e) => ((msg.last = e.message), true));
      return msg.last;
    };
    assert.match(msg({ secret: null }), /missing vibesquad\/artifact-signing credential/);
    assert.match(norm(msg({ drop: ["/h/.vibesquad/signing/metadata.json"] })), /missing \/h\/\.vibesquad\/signing\/metadata\.json/);
    const custom = rig({ drop: ["/h/.vibesquad/signing/metadata.json"] });
    custom.deps.env.VS_SIGN_DIR = "/custom/dir";
    assert.throws(() => signFile("f.exe", custom.deps), (e) => /missing \/custom\/dir\/metadata\.json/.test(norm(e.message)) && !/~/.test(e.message));
    assert.match(msg({ drop: ["/t/Azure.CodeSigning.Dlib.dll"] }), /dlib not found/);
    assert.match(msg({ drop: ["/t/signtool.exe"] }), /signtool not found/);
  });

  test("--check maps to checklist steps and exit codes", () => {
    const ok = rig();
    assert.equal(runCheck(ok.deps), 0);
    assert.match(ok.logs.join("\n"), /OK/);

    const bad = rig({ secret: null, drop: ["/h/.vibesquad/signing/metadata.json", "/t/signtool.exe", "/t/Azure.CodeSigning.Dlib.dll"] });
    assert.equal(runCheck(bad.deps), 1);
    const out = bad.logs.join("\n");
    assert.match(out, /step 7: missing vibesquad\/artifact-signing credential/);
    assert.match(norm(out), /step 8: missing \/h\/\.vibesquad\/signing\/metadata\.json/);
    assert.match(out, /step 9: signtool not found/);
    assert.match(out, /step 9: dlib not found/);

    const profile = rig({ extra: { "/h/.vibesquad/signing/metadata.json": JSON.stringify({ Endpoint: "e" }) } });
    assert.deepEqual(checkSetup(profile.deps).map((m) => m.step), [6]);
    assert.equal(profile.calls.length, 0);
  });
});

describe("release overlay + build stage", () => {
  const root = join(import.meta.dirname, "..");
  test("overlay sets signCommand; tauri.conf.json does not", () => {
    const overlay = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.release-sign.conf.json"), "utf8"));
    assert.deepEqual(overlay, { bundle: { windows: { signCommand: { cmd: "node", args: ["scripts/sign-windows.mjs", "%1"] } } } });
    assert.ok(!readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8").includes("signCommand"));
  });

  function buildRoot() {
    const r = mkdtempSync(join(tmpdir(), "vs-sign-"));
    mkdirSync(join(r, "src-tauri"), { recursive: true });
    writeFileSync(join(r, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: "1.2.3" }));
    return r;
  }
  const HEAD = "abc1234def5678abc1234def5678abc1234def56";
  function run(argv, { failCheck = false } = {}) {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "rev-parse") return `${HEAD}\n`;
      if (cmd === "git" && args[0] === "status") return "";
      if (args.some((a) => String(a).endsWith("sign-windows.mjs")) && failCheck) throw new Error("check failed");
      return "";
    };
    const r = () => runRelease(["build", "--commit", HEAD, ...argv], { rootDir: buildRoot(), exec, env: {}, log: () => {} });
    return { calls, r };
  }

  test("build runs --check first, then passes --config overlay", () => {
    const { calls, r } = run([]);
    r();
    const chk = calls.findIndex((c) => c.some((a) => String(a).endsWith("sign-windows.mjs")) && c.includes("--check"));
    const build = calls.findIndex((c) => c.some((a) => String(a).endsWith("build-desktop.mjs")));
    assert.ok(chk >= 0 && build > chk);
    const i = calls[build].indexOf("--config");
    assert.ok(i > 0 && norm(calls[build][i + 1]).endsWith("src-tauri/tauri.release-sign.conf.json"));
  });

  test("failed --check stops the build; --unsigned skips check and overlay", () => {
    const bad = run([], { failCheck: true });
    assert.throws(() => bad.r(), /Windows signing is not set up/);
    assert.ok(!bad.calls.some((c) => c.some((a) => String(a).endsWith("build-desktop.mjs"))));

    const u = run(["--unsigned"]);
    assert.equal(parseArgs(["build", "--unsigned"]).unsigned, true);
    u.r();
    assert.ok(!u.calls.some((c) => c.some((a) => String(a).endsWith("sign-windows.mjs"))));
    assert.ok(!u.calls.flat().includes("--config"));
  });
});
