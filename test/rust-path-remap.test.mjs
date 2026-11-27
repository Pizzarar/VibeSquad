import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { hostPathHits, hostPathPrefixes, remapRustflags, rustRemapChildEnv } from "../server/rust-path-remap.mjs";
import { updaterKeyChildEnvs } from "../server/secrets.mjs";

// Privacy (audit rn-31b210f0dd49): the 0.4.0 Rust binary carried the build host's home path in panic Location strings.
// Synthetic paths only: never a real username.
const PW = "TAURI_SIGNING_PRIVATE_KEY_PASSWORD";
const WIN_HOME = "C:\\Users\\tester";
const WIN_REPO = "C:\\Users\\tester\\projects\\VibeSquad";
const pwKeys = (env) => Object.keys(env).filter((k) => k.toUpperCase() === PW);
const winPrefixes = (env = {}) => hostPathPrefixes({ env, home: WIN_HOME, repoRoots: [WIN_REPO], platform: "win32" });

describe("hostPathPrefixes + remapRustflags", () => {
  test("win32 defaults: home catch-all first, nested cargo/rustup/repo after it (rustc applies the last match), plus \\\\?\\ forms", () => {
    const prefixes = winPrefixes();
    assert.deepEqual(remapRustflags(prefixes), [
      "--remap-path-prefix=C:\\Users\\tester=/home",
      "--remap-path-prefix=\\\\?\\C:\\Users\\tester=/home",
      "--remap-path-prefix=C:\\Users\\tester\\projects\\VibeSquad=/vibesquad",
      "--remap-path-prefix=\\\\?\\C:\\Users\\tester\\projects\\VibeSquad=/vibesquad",
      "--remap-path-prefix=C:\\Users\\tester\\.rustup=/rustup",
      "--remap-path-prefix=\\\\?\\C:\\Users\\tester\\.rustup=/rustup",
      "--remap-path-prefix=C:\\Users\\tester\\.cargo=/cargo",
      "--remap-path-prefix=\\\\?\\C:\\Users\\tester\\.cargo=/cargo",
    ]);
  });

  test("win32: CARGO_HOME / RUSTUP_HOME from env (any case), trailing separators trimmed, duplicates dropped", () => {
    const prefixes = winPrefixes({ cargo_home: "D:\\rust\\cargo\\", RUSTUP_HOME: "D:\\rust\\rustup" });
    const byRole = Object.fromEntries(prefixes.filter((p) => !p.from.startsWith("\\\\?\\")).map((p) => [p.role, p.from]));
    assert.deepEqual(byRole, { home: WIN_HOME, repo: WIN_REPO, rustup: "D:\\rust\\rustup", cargo: "D:\\rust\\cargo" });
    const dup = hostPathPrefixes({ home: WIN_HOME, repoRoots: [WIN_REPO, "c:\\users\\tester\\projects\\vibesquad"], platform: "win32" });
    assert.equal(dup.filter((p) => p.role === "repo").length, 2); // plain + verbatim, case-insensitive dedupe
  });

  test("POSIX: no verbatim forms; relative or root paths are never remapped", () => {
    const prefixes = hostPathPrefixes({ env: { CARGO_HOME: "rel/cargo" }, home: "/home/tester", repoRoots: ["/", "/home/tester/src/vs/"], platform: "linux" });
    assert.deepEqual(remapRustflags(prefixes), [
      "--remap-path-prefix=/home/tester=/home",
      "--remap-path-prefix=/home/tester/src/vs=/vibesquad",
      "--remap-path-prefix=/home/tester/.rustup=/rustup",
      "--remap-path-prefix=/home/tester/.cargo=/cargo",
    ]);
    assert.deepEqual(hostPathPrefixes({ home: "", platform: "linux" }), []);
  });
});

describe("rustRemapChildEnv (existing rustflags are preserved)", () => {
  test("no rustflags in env: cargo --config build.rustflags (merges with .cargo/config arrays), env unchanged", () => {
    const env = { Path: "C:\\Windows", COMSPEC: "cmd.exe" };
    const r = rustRemapChildEnv(env, winPrefixes(), { platform: "win32" });
    assert.equal(r.via, "--config build.rustflags");
    assert.deepEqual(r.env, env);
    assert.notEqual(r.env, env);
    assert.equal(r.cargoArgs[0], "--config");
    const [key, value] = [r.cargoArgs[1].slice(0, r.cargoArgs[1].indexOf("=")), r.cargoArgs[1].slice(r.cargoArgs[1].indexOf("=") + 1)];
    assert.equal(key, "build.rustflags");
    // a JSON array of strings is a valid TOML inline array; backslashes are escaped, so rustc gets the exact prefix
    assert.deepEqual(JSON.parse(value), r.flags);
    assert.match(value, /C:\\\\Users\\\\tester=\/home/);
  });

  test("RUSTFLAGS set (e.g. static CRT): kept first, ours appended, moved to CARGO_ENCODED_RUSTFLAGS so spaces survive", () => {
    const spaced = hostPathPrefixes({ home: "C:\\Users\\Test User", repoRoots: [], platform: "win32" });
    const r = rustRemapChildEnv({ RustFlags: " -C target-feature=+crt-static  -C link-arg=/X ", Path: "p" }, spaced, { platform: "win32" });
    assert.equal(r.via, "CARGO_ENCODED_RUSTFLAGS");
    assert.deepEqual(r.cargoArgs, []);
    assert.deepEqual(Object.keys(r.env).sort(), ["CARGO_ENCODED_RUSTFLAGS", "Path"]);
    const parts = r.env.CARGO_ENCODED_RUSTFLAGS.split("\x1f");
    assert.deepEqual(parts.slice(0, 4), ["-C", "target-feature=+crt-static", "-C", "link-arg=/X"]);
    assert.deepEqual(parts.slice(4), r.flags);
    assert.ok(parts.includes("--remap-path-prefix=C:\\Users\\Test User=/home"));
  });

  test("CARGO_ENCODED_RUSTFLAGS set: appended to it; RUSTFLAGS (ignored by cargo then) dropped; '' = no existing flags", () => {
    const prefixes = hostPathPrefixes({ home: "/home/tester", repoRoots: [], platform: "linux" });
    const r = rustRemapChildEnv({ CARGO_ENCODED_RUSTFLAGS: "-Ctarget-cpu=x86-64-v2\x1f-Cstrip=symbols", RUSTFLAGS: "-Cignored" }, prefixes, { platform: "linux" });
    assert.deepEqual(r.env, { CARGO_ENCODED_RUSTFLAGS: ["-Ctarget-cpu=x86-64-v2", "-Cstrip=symbols", ...r.flags].join("\x1f") });
    const empty = rustRemapChildEnv({ CARGO_ENCODED_RUSTFLAGS: "" }, prefixes, { platform: "linux" });
    assert.equal(empty.env.CARGO_ENCODED_RUSTFLAGS, r.flags.join("\x1f"));
    // POSIX env names are case-sensitive: a look-alike key is not cargo's RUSTFLAGS
    const posix = rustRemapChildEnv({ RustFlags: "-Cx" }, prefixes, { platform: "linux" });
    assert.equal(posix.via, "--config build.rustflags");
    assert.deepEqual(posix.env, { RustFlags: "-Cx" });
  });

  test("updater-key password: never added; tauriEnv's own key passes through untouched; no flag carries it", () => {
    const base = { Path: "C:\\Windows", [PW]: "pw-secret", RUSTFLAGS: "-Cx" };
    const { plain, tauri } = updaterKeyChildEnvs(base, { keyPath: "C:\\k\\key", read: () => null });
    const fromPlain = rustRemapChildEnv(plain, winPrefixes(), { platform: "win32" });
    assert.deepEqual(pwKeys(fromPlain.env), []);
    const fromTauri = rustRemapChildEnv(tauri, winPrefixes(), { platform: "win32" });
    assert.deepEqual(pwKeys(fromTauri.env), [PW]);
    assert.equal(fromTauri.env[PW], "pw-secret");
    for (const r of [fromPlain, fromTauri]) {
      assert.doesNotMatch(JSON.stringify([r.flags, r.cargoArgs, r.env.CARGO_ENCODED_RUSTFLAGS]), /pw-secret/);
    }
  });

  test("no prefixes: env copied as-is, no cargo args", () => {
    const r = rustRemapChildEnv({ RUSTFLAGS: "-Cx" }, [], { platform: "linux" });
    assert.deepEqual(r, { env: { RUSTFLAGS: "-Cx" }, cargoArgs: [], flags: [], via: "none" });
  });
});

describe("hostPathHits (post-build fail-closed scan)", () => {
  test("counts both slash styles case-insensitively, reports roles only (never the matched text)", () => {
    const bin = Buffer.concat([
      Buffer.from("\0panic at c:\\users\\TESTER\\.cargo\\registry\\src\\x\\tokio\\src\\lib.rs\0", "latin1"),
      Buffer.from("C:/Users/tester/.rustup/toolchains/x/lib.rs\0/cargo/registry/src/ok.rs\0", "latin1"),
    ]);
    const hits = hostPathHits(bin, winPrefixes());
    assert.deepEqual(hits, { home: 2, cargo: 1, rustup: 1 });
    assert.doesNotMatch(JSON.stringify(hits), /tester/i);
    assert.deepEqual(hostPathHits(Buffer.from("/cargo/registry/src/x.rs\0/rustup/x\0/vibesquad/src-tauri/src/main.rs"), winPrefixes()), {});
  });
});

test("build-desktop.mjs: remap goes only to the tauri build child (after --), scan runs before the copy to dist-desktop", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "server", "build-desktop.mjs"), "utf8");
  assert.match(src, /const remap = rustRemapChildEnv\(tauriKeyEnv, remapPrefixes\);\nconst tauriEnv = remap\.env;/);
  assert.match(src, /\[tauriCliJs, "build", "--bundles", "nsis", \.\.\.tauriConfigArgs, \.\.\.\(remap\.cargoArgs\.length \? \["--", \.\.\.remap\.cargoArgs\] : \[\]\)\]/);
  assert.equal(src.match(/env: tauriEnv\b/g)?.length, 1);
  assert.doesNotMatch(src, /env:\s*tauriKeyEnv/); // the un-remapped key env never reaches a child
  assert.match(src, /const env = withoutUpdaterKeyPassword\(baseEnv\);/);
  assert.ok(src.indexOf("hostPathHits(readFileSync(appExe)") < src.indexOf("copyFileSync(srcInstaller, destInstaller)"));
  assert.doesNotMatch(src, /console\.log\([^)]*remap\.flags/);
});
