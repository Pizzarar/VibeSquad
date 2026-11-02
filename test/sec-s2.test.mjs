import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { resolveCmdShimEntry } from "../server/first-run.mjs";
import { controlPaseoHub, controlPaseoPlugin, runPaseoCli, validateHubOrigin, validatePluginSource } from "../server/paseo-control.mjs";

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
