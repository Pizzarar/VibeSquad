import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { appendPathEntry, detachUpdaterKeyPassword, updaterKeyChildEnvs, withoutUpdaterKeyPassword } from "../server/secrets.mjs";

// Regression from bf4633ad: build-desktop's env snapshot is a plain object, so on win32 `env.PATH` missed the OS "Path"
// key and children got Path (real) + PATH (";<cargo bin>"): `spawnSync cmd.exe ENOENT` at step 1/4.
const PW = "TAURI_SIGNING_PRIVATE_KEY_PASSWORD";
const CARGO = "C:\\Users\\me\\.cargo\\bin";
const pathKeys = (env) => Object.keys(env).filter((k) => k.toUpperCase() === "PATH");
const pwKeys = (env) => Object.keys(env).filter((k) => k.toUpperCase() === PW);

describe("build-desktop child env PATH (win32 Path survives the updater-key detach)", () => {
  test("win32-shaped env: one PATH key with original + cargo bin, no password key in the child env", () => {
    const live = { Path: "C:\\a;C:\\Windows\\System32", ComSpec: "C:\\Windows\\system32\\cmd.exe", [PW]: "pw" };
    const inherited = detachUpdaterKeyPassword(live);
    const baseEnv = appendPathEntry(inherited, CARGO, { platform: "win32" });
    const env = withoutUpdaterKeyPassword(baseEnv);
    assert.deepEqual(pathKeys(env), ["PATH"]);
    assert.equal(env.PATH, `C:\\a;C:\\Windows\\System32;${CARGO}`);
    assert.deepEqual(pwKeys(env), []);
    assert.equal(env.ComSpec, live.ComSpec);
    // baseEnv still holds the password (only tauri build / signer get it), and those children see the same single PATH
    assert.equal(baseEnv[PW], "pw");
    const { tauri, signer } = updaterKeyChildEnvs(baseEnv, { keyPath: "C:\\k\\key", read: () => null });
    for (const child of [tauri, signer]) {
      assert.deepEqual(pathKeys(child), ["PATH"]);
      assert.equal(child.PATH, env.PATH);
      assert.deepEqual(pwKeys(child), [PW]);
    }
  });

  test("win32: every case variant goes; the first non-empty one is the original; input untouched", () => {
    const input = { Path: "C:\\a", path: "C:\\b", PATH: "" };
    const out = appendPathEntry(input, CARGO, { platform: "win32" });
    assert.deepEqual(pathKeys(out), ["PATH"]);
    assert.equal(out.PATH, `C:\\a;${CARGO}`);
    assert.deepEqual(input, { Path: "C:\\a", path: "C:\\b", PATH: "" });
    assert.deepEqual(appendPathEntry({}, CARGO, { platform: "win32" }), { PATH: CARGO });
  });

  test("POSIX: exact PATH key only, joined with ':' (path.delimiter), other keys untouched", () => {
    const out = appendPathEntry({ PATH: "/usr/local/bin:/usr/bin", Path: "odd", HOME: "/h" }, "/h/.cargo/bin", { platform: "linux" });
    assert.equal(out.PATH, "/usr/local/bin:/usr/bin:/h/.cargo/bin");
    assert.equal(out.Path, "odd");
    assert.equal(out.HOME, "/h");
    assert.deepEqual(appendPathEntry({}, "/c", { platform: "darwin" }), { PATH: "/c" });
  });

  test("build-desktop.mjs builds baseEnv with appendPathEntry, not a literal PATH override", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "server", "build-desktop.mjs"), "utf8");
    assert.match(src, /const baseEnv = appendPathEntry\(inheritedEnv, cargoBin\);/);
    assert.doesNotMatch(src, /\bPATH:\s*`/);
  });
});
