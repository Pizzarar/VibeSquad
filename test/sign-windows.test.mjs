import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { checkSetup, runCheck, signFile } from "../scripts/sign-windows.mjs";
import { parseArgs, runRelease } from "../server/release.mjs";

const SECRET = "client-S3CRET-value";
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
