import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { resolveCmdShimEntry } from "../server/first-run.mjs";
import {
  checkDaemonListenExposure,
  controlPaseoHub,
  controlPaseoPlugin,
  isLoopbackListen,
  restoreLastPaseoConfigBackup,
  runPaseoCli,
  updatePaseoSettingsPatch,
  validateHubOrigin,
  validatePluginSource,
} from "../server/paseo-control.mjs";
import { clearAllConfigWarnings, getConfigWarnings } from "../server/user-settings.mjs";
import { createVibesquadMiddleware } from "../server/vibesquad-api.mjs";
import { ownerHeaders } from "./helpers/local-owner.mjs";

const rootDir = resolve(import.meta.dirname, "..");

// The shim npm writes for @getpaseo/cli (cmd-shim), trimmed to the lines the resolver reads.
const NPM_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" --disable-warning=DEP0040 "%dp0%\\node_modules\\@getpaseo\\cli\\bin\\paseo" %*',
].join("\r\n");

describe("S2 fix 1: no cmd.exe injection through the Paseo CLI", () => {
  test("plugin source allowlist rejects shell metacharacters and option-looking values", () => {
    for (const bad of ["x&calc", "x|calc", 'x"&calc', "%PATH%", "x^&calc", "x<y", "x>y", "a!b!", "x\ny", "-rf", "--registry=evil", ""]) {
      assert.throws(() => validatePluginSource(bad), undefined, JSON.stringify(bad));
    }
    for (const ok of ["C:\\Users\\me\\my plugin", "@scope/pkg@1.2.3", "paseo-plugin-x", "https://github.com/a/b.git#main", "git+ssh://git@github.com/a/b.git", "./local/dir"]) {
      assert.equal(validatePluginSource(ok), ok);
    }
  });

  test("hub origin must be a bare http(s) origin", () => {
    for (const bad of ["https://x.example&calc", "https://x.example/path", "https://x.example/?a=1", "javascript:alert(1)", "file:///C:/x", "https://u:p@x.example", "x.example", "https://x\"y.example"]) {
      assert.throws(() => validateHubOrigin(bad), undefined, bad);
    }
    assert.equal(validateHubOrigin(" https://hub.paseo.sh/ "), "https://hub.paseo.sh");
    assert.equal(validateHubOrigin("http://127.0.0.1:7000"), "http://127.0.0.1:7000");
  });

  test("plugin install and hub connect reject bad input before the CLI runs", async () => {
    let calls = 0;
    const cliRunner = () => {
      calls++;
      return { ok: true, code: 0, stdout: "", stderr: "", data: null };
    };
    await assert.rejects(controlPaseoPlugin("install", { source: "x & calc", confirmUnsandboxed: true }, { cliRunner }));
    await assert.rejects(controlPaseoHub("connect", { origin: "https://h.example & calc" }, { cliRunner }));
    assert.equal(calls, 0);
  });

  test("resolveCmdShimEntry finds the node entry of an npm shim", () => {
    const shim = join("C:\\npm", "paseo.cmd");
    const entry = resolveCmdShimEntry(shim, () => NPM_SHIM);
    assert.ok(entry);
    assert.equal(entry.script, join("C:\\npm", "node_modules", "@getpaseo", "cli", "bin", "paseo"));
    assert.deepEqual(entry.nodeArgs, ["--disable-warning=DEP0040"]);
    assert.equal(resolveCmdShimEntry(shim, () => "@echo off\r\nfoo.exe %*"), null);
    assert.equal(resolveCmdShimEntry(shim, () => '"%_prog%" "%dp0%\\..\\..\\evil.js" %*'), null, "entry must stay inside the shim dir");
    assert.equal(resolveCmdShimEntry(shim, () => {
      throw new Error("ENOENT");
    }), null);
  });

  test("a .cmd CLI runs node directly when the shim resolves (no cmd.exe)", async () => {
    const seen = [];
    const execFile = (file, args, _o, cb) => {
      seen.push({ file, args });
      cb(null, "", "");
    };
    const cli = { kind: "cmd", bin: "C:\\npm\\paseo.cmd" };
    const resolveCmdShim = () => ({ script: "C:\\npm\\node_modules\\@getpaseo\\cli\\bin\\paseo", nodeArgs: [] });
    const res = await runPaseoCli(["plugin", "install", "x&calc"], { cli, execFile, resolveCmdShim, paseoHome: "C:\\ph" });
    assert.equal(res.ok, true);
    assert.equal(seen.length, 1);
    assert.notEqual(seen[0].file, "cmd.exe");
    assert.deepEqual(seen[0].args.slice(-4), ["C:\\ph", "plugin", "install", "x&calc"]);
  });

  test("the cmd.exe fallback refuses metacharacters and quotes every arg", async () => {
    const seen = [];
    const execFile = (file, args, _o, cb) => {
      seen.push({ file, args });
      cb(null, "", "");
    };
    const cli = { kind: "cmd", bin: "C:\\npm\\paseo.cmd" };
    const resolveCmdShim = () => null;
    for (const bad of ["x&calc", 'a"b', "%PATH%", "a|b", "a^b", "a<b", "a>b", "a!b", "a\r\nb", "C:\\dir\\"]) {
      const res = await runPaseoCli(["plugin", "install", bad], { cli, execFile, resolveCmdShim, paseoHome: "C:\\ph" });
      assert.equal(res.ok, false, JSON.stringify(bad));
      assert.match(res.stderr, /metacharacters/);
    }
    assert.equal(seen.length, 0);
    const ok = await runPaseoCli(["ls", "--json"], { cli, execFile, resolveCmdShim, paseoHome: "C:\\ph" });
    assert.equal(ok.ok, true);
    assert.equal(seen[0].file, "cmd.exe");
    assert.equal(seen[0].args[3], '""C:\\npm\\paseo.cmd" "--home" "C:\\ph" "ls" "--json""');
  });
});

describe("S2 fix 2: non-loopback daemon.listen needs confirmExposure and raises a config warning", () => {
  let root;
  let paseoHome;
  const cliRunner = () => ({ ok: true, code: 0, stdout: "", stderr: "", data: null });
  const writeCfg = (listen) => writeFileSync(join(paseoHome, "config.json"), JSON.stringify({ version: 1, daemon: { listen } }), "utf8");
  const readListen = () => JSON.parse(readFileSync(join(paseoHome, "config.json"), "utf8")).daemon.listen;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "vs-sec-s2-listen-"));
    paseoHome = join(root, "paseo");
    mkdirSync(paseoHome, { recursive: true });
  });
  after(() => {
    clearAllConfigWarnings();
    rmSync(root, { recursive: true, force: true });
  });

  test("isLoopbackListen", () => {
    for (const l of ["127.0.0.1:6767", "127.0.0.2:1", "localhost:6767", "[::1]:6767", "ws://127.0.0.1:6767", "\\\\.\\pipe\\paseo", "unix:/tmp/p.sock", ""]) {
      assert.equal(isLoopbackListen(l), true, l);
    }
    for (const l of ["0.0.0.0:6767", "172.16.1.5:6767", "[::]:6767", "10.0.0.5:6767", "my-pc.mesh.test:6767"]) {
      assert.equal(isLoopbackListen(l), false, l);
    }
  });

  test("non-loopback listen without confirmExposure is refused and nothing is written", async () => {
    writeCfg("127.0.0.1:6767");
    const res = await updatePaseoSettingsPatch({ listen: "172.16.1.5:6767", relayEnabled: true }, { paseoHome, cliRunner, skipReload: true });
    assert.equal(res.ok, false);
    assert.equal(res.needsConfirmation, true);
    assert.match(res.warning, /not loopback/);
    assert.equal(readListen(), "127.0.0.1:6767");
  });

  test("confirmed exposure writes, returns a warning and records a config warning; loopback clears it", async () => {
    writeCfg("127.0.0.1:6767");
    const opts = { paseoHome, cliRunner, skipReload: true };
    const res = await updatePaseoSettingsPatch({ listen: "0.0.0.0:6767", confirmExposure: true }, opts);
    assert.equal(res.ok, true);
    assert.match(res.warning, /not loopback/);
    assert.equal(readListen(), "0.0.0.0:6767");
    const w = getConfigWarnings().find((x) => x.kind === "exposure");
    assert.ok(w, "exposure warning recorded");
    assert.match(w.error, /0\.0\.0\.0:6767/);
    const back = await updatePaseoSettingsPatch({ listen: "127.0.0.1:6767" }, opts);
    assert.equal(back.ok, true);
    assert.equal(back.warning, undefined);
    assert.equal(getConfigWarnings().some((x) => x.kind === "exposure"), false);
  });

  test("startup check flags an existing non-loopback config without changing it", () => {
    writeCfg("172.16.1.5:6767");
    const before = readFileSync(join(paseoHome, "config.json"), "utf8");
    assert.ok(checkDaemonListenExposure({ paseoHome }));
    assert.equal(getConfigWarnings().filter((x) => x.kind === "exposure").length, 1);
    assert.equal(readFileSync(join(paseoHome, "config.json"), "utf8"), before);
    writeCfg("127.0.0.1:6767");
    assert.equal(checkDaemonListenExposure({ paseoHome }), null);
    assert.equal(getConfigWarnings().some((x) => x.kind === "exposure"), false);
  });
});

describe("S2 fix 3: config restore is confined to the Paseo backup files", () => {
  let root;
  let paseoHome;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "vs-sec-s2-restore-"));
    paseoHome = join(root, "paseo");
    mkdirSync(paseoHome, { recursive: true });
    writeFileSync(join(paseoHome, "config.json"), JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:6767" } }), "utf8");
    writeFileSync(join(paseoHome, "config.json.bak-100"), JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:7000" } }), "utf8");
    writeFileSync(join(root, "evil.json"), JSON.stringify({ version: 1, daemon: { listen: "0.0.0.0:6767" } }), "utf8");
    writeFileSync(join(root, "config.json.bak-200"), JSON.stringify({ version: 1, daemon: { listen: "0.0.0.0:6767" } }), "utf8");
    writeFileSync(join(paseoHome, "other.json"), JSON.stringify({ version: 1 }), "utf8");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test("paths outside the backup set are rejected", () => {
    for (const p of [join(root, "evil.json"), join(root, "config.json.bak-200"), join(paseoHome, "..", "config.json.bak-200"), join(paseoHome, "other.json"), join(paseoHome, "config.json"), "..\\evil.json", "../config.json.bak-200"]) {
      assert.throws(() => restoreLastPaseoConfigBackup({ paseoHome, backupPath: p }), /Paseo home/, p);
    }
    assert.equal(JSON.parse(readFileSync(join(paseoHome, "config.json"), "utf8")).daemon.listen, "127.0.0.1:6767");
  });

  test("a real backup (full path or bare name) restores", () => {
    assert.equal(restoreLastPaseoConfigBackup({ paseoHome, backupPath: join(paseoHome, "config.json.bak-100") }).config.daemon.listen, "127.0.0.1:7000");
    assert.equal(restoreLastPaseoConfigBackup({ paseoHome, backupPath: "config.json.bak-100" }).config.daemon.listen, "127.0.0.1:7000");
  });

  test("the restore route answers 400 for an outside path", async () => {
    const mw = createVibesquadMiddleware(rootDir, { paseo: { paseoHome, cliRunner: () => ({ ok: true, code: 0, stdout: "", stderr: "", data: null }) } });
    const srv = createServer((req, res) => mw(req, res, () => {
      res.statusCode = 404;
      res.end();
    }));
    await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
    try {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/__vibesquad/paseo/raw/restore`, {
        method: "POST",
        headers: ownerHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ backupPath: join(root, "evil.json") }),
      });
      assert.equal(r.status, 400);
      assert.equal(JSON.parse(readFileSync(join(paseoHome, "config.json"), "utf8")).daemon.listen, "127.0.0.1:7000");
    } finally {
      srv.close();
    }
  });
});
