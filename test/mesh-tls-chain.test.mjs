// @pto V1.4 (docs/lanes/playtest-overlay/PLAN_V1_4_CA_COMPAT.md): the Meshnet/LAN https listener presents the LEAF ONLY.
// Node appends a `ca` option cert to the chain it sends; the VS CA carries critical nameConstraints (server/auth.mjs
// ensureTls), and Godot's mbedtls aborts the handshake on any peer cert it can't parse (-9570 / -98), even with a pinned
// CA. RFC 8446 4.4.2 lets the server omit the trust anchor; every client gets the CA from GET /ca.crt + fingerprint.
// The Godot leg runs the real addon pin (godot/tests/pinned_https_probe.gd); it needs `godot` on PATH or GODOT_BIN.
// Run: node --test test/mesh-tls-chain.test.mjs
import "./setup/hermetic.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:tls";
import { after, before, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "vs-mesh-chain-"));
process.env.VIBESQUAD_HOME = home;
writeFileSync(join(home, "teams.json"), JSON.stringify({ teams: [] }));
const auth = await import("../server/auth.mjs");
const { createMeshnetMux } = await import("../server/serve.mjs");
auth.setNetInterfacesForTest({ lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, netmask: "255.0.0.0", mac: "00:00:00:00:00:00" }] });

const tls = auth.ensureTls({ meshnetHost: "forge.example.test", meshnetIp: "100.64.0.10", lanIp: "" });
const caFile = join(home, "tls", "ca.crt");
/** Async spawn (the mux runs in this process, so spawnSync would block it): -> combined stdout+stderr. */
function run(cmd, args, timeoutMs, opts = {}) {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, windowsHide: true, ...opts });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.stdin.end();
    p.on("close", () => ok(out));
    p.on("error", (e) => ok(`${out}\nspawn error: ${e.message}`));
  });
}

let mux;
let port;
before(async () => {
  ({ mux } = createMeshnetMux({ port: 4180, meshnetHost: "forge.example.test", meshnetIp: "100.64.0.10", tls }));
  await new Promise((ok) => mux.listen(0, "127.0.0.1", ok));
  port = mux.address().port;
});
after(async () => {
  await new Promise((ok) => mux.close(ok));
  rmSync(home, { recursive: true, force: true });
});

test("the CA under test has the real shape: critical nameConstraints", () => {
  const text = auth.openssl(["x509", "-in", caFile, "-noout", "-text"]);
  assert.match(text, /X509v3 Name Constraints: critical/);
});

test("the https listener presents exactly one certificate, the leaf (never the CA)", async () => {
  const out = await run(auth.opensslBin(), ["s_client", "-connect", `127.0.0.1:${port}`, "-servername", "localhost", "-showcerts"], 15000);
  const sent = out.match(/-----BEGIN CERTIFICATE-----/g) ?? [];
  assert.equal(sent.length, 1, out);
  assert.match(out, /0 s:CN\s*=\s*forge\.example\.test/, out);
  assert.doesNotMatch(out, /1 s:/, "negative: a second chain entry (the CA) was sent");
});

test("a client pinned to the CA still verifies the leaf-only chain (RFC 8446 4.4.2)", async () => {
  const authorized = await new Promise((ok, fail) => {
    const s = connect({ host: "127.0.0.1", port, servername: "localhost", ca: tls.ca }, () => {
      ok(s.authorized);
      s.destroy();
    });
    s.on("error", fail);
  });
  assert.equal(authorized, true);
});

const CMD_SPECIAL = /[\s"&()<>^|;,=%!]/;
function quoteCmdArg(arg) {
  const s = String(arg);
  if (s && !CMD_SPECIAL.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
}

// .cmd/.bat shims (or bare `godot` resolving to godot.cmd on PATH) need cmd.exe on Windows; .exe and POSIX spawn directly.
// Explicit quoting + outer quotes after /c + windowsVerbatimArguments keep cmd from stripping inner quotes when both bin and args have spaces.
function godotCmd(bin, args, { win = process.platform === "win32", comSpec = process.env.ComSpec || process.env.COMSPEC } = {}) {
  if (!win || /\.exe$/i.test(bin)) return [bin, args, {}];
  const line = [bin, ...args].map(quoteCmdArg).join(" ");
  return [comSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { windowsVerbatimArguments: true }];
}

test("godotCmd quotes Windows .cmd shims and args across spaces, plain paths, & and ^ while leaving POSIX/.exe direct", () => {
  const tricky = ["--path", "C:\\My Repo & ^Test\\godot", "--", "C:\\tmp\\ca&1^2.crt"];
  assert.deepEqual(godotCmd("/opt/my godot/godot", tricky, { win: false }), ["/opt/my godot/godot", tricky, {}]);
  assert.deepEqual(godotCmd("C:\\My Tools\\godot.cmd", tricky, { win: false }), ["C:\\My Tools\\godot.cmd", tricky, {}]);
  assert.deepEqual(godotCmd("C:\\Program Files\\Godot\\Godot_console.exe", tricky, { win: true }), ["C:\\Program Files\\Godot\\Godot_console.exe", tricky, {}]);
  assert.deepEqual(godotCmd("C:\\Tools\\GODOT.EXE", ["--version"], { win: true }), ["C:\\Tools\\GODOT.EXE", ["--version"], {}]);

  assert.deepEqual(godotCmd("C:\\Tools\\godot.cmd", ["--headless", "--path", "C:\\repo\\godot"], { win: true, comSpec: "C:\\Windows\\System32\\cmd.exe" }), [
    "C:\\Windows\\System32\\cmd.exe",
    ["/d", "/s", "/c", '"C:\\Tools\\godot.cmd --headless --path C:\\repo\\godot"'],
    { windowsVerbatimArguments: true },
  ]);

  assert.deepEqual(
    godotCmd("C:\\Users\\My User\\Temp\\godot space\\godot.cmd", ["--headless", "--path", "C:\\Users\\My User\\My Repo\\godot", "--", "C:\\Users\\My User\\ca.crt"], {
      win: true,
      comSpec: "",
    }),
    [
      "cmd.exe",
      ["/d", "/s", "/c", '""C:\\Users\\My User\\Temp\\godot space\\godot.cmd" --headless --path "C:\\Users\\My User\\My Repo\\godot" -- "C:\\Users\\My User\\ca.crt""'],
      { windowsVerbatimArguments: true },
    ],
  );

  assert.deepEqual(
    godotCmd("C:\\a&b^c\\godot.cmd", ["plain", "C:\\no_space&amp\\x", "C:\\no_space^caret\\y", "C:\\sp & ^both\\z", "C:\\my trail\\", ""], { win: true, comSpec: "cmd.exe" }),
    [
      "cmd.exe",
      ["/d", "/s", "/c", '""C:\\a&b^c\\godot.cmd" plain "C:\\no_space&amp\\x" "C:\\no_space^caret\\y" "C:\\sp & ^both\\z" "C:\\my trail\\\\" """'],
      { windowsVerbatimArguments: true },
    ],
  );

  if (process.platform === "win32") {
    const dir = join(home, "shim & ^space");
    mkdirSync(dir, { recursive: true });
    const shim = join(dir, "echo-args.cmd");
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*\r\n`);
    const sample = ["C:\\plain\\path", "C:\\with spaces\\repo", "C:\\amp&nospace", "C:\\caret^nospace", "C:\\both & ^spaces\\ca.crt", "C:\\my trail\\"];
    const [c, a, o] = godotCmd(shim, sample);
    const r = spawnSync(c, a, { windowsHide: true, encoding: "utf8", ...o });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), sample);
  }
});

const win = process.platform === "win32";
const godot = process.env.GODOT_BIN || (win && (process.env.GODOT_PATH || process.env.GODOT)) || "godot";
const [probeCmd, probeArgs, probeOpts] = godotCmd(godot, ["--version"]);
const hasGodot = spawnSync(probeCmd, probeArgs, { windowsHide: true, ...probeOpts }).status === 0;
test("Godot addon: pinned HTTPRequest to the listener succeeds (result 0, HTTP 200)", { skip: !hasGodot && "godot not on PATH (set GODOT_BIN)", timeout: 180000 }, async () => {
  const proj = resolve(import.meta.dirname, "..", "godot");
  // Connect to 127.0.0.1 directly (mux binds 127.0.0.1 only; on Windows `localhost` resolves ::1 first and times out).
  const [cmd, args, opts] = godotCmd(godot, ["--headless", "--path", proj, "-s", "tests/pinned_https_probe.gd", "--", caFile, `https://127.0.0.1:${port}/ca.crt`]);
  const out = await run(cmd, args, 120000, opts);
  assert.match(out, /PROBE result=0 http=200/, out);
});
