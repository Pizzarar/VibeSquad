import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  assertFrozenCommit,
  DEFAULT_RELEASE_REPO,
  parseArgs,
  resolveTagCommit,
  publishRelease,
  buildLatestJson,
  runRelease,
  selectApk,
  signerSignArgs,
  syncVersionFiles,
  updaterSigningEnv,
  writeReleaseRecord,
} from "../server/release.mjs";

const HEAD = "abc1234def5678abc1234def5678abc1234def56";

function fakeExec({ head = HEAD, dirty = "", existingReleases = new Set(), tagShas = {} } = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return `${head}\n`;
    if (cmd === "git" && args[0] === "status") return dirty;
    if (cmd === "gh" && args[0] === "api") {
      const m = args[1].match(/git\/ref\/tags\/(.+)$/);
      if (m && tagShas[m[1]]) return JSON.stringify({ object: { type: "commit", sha: tagShas[m[1]] } });
      throw new Error("HTTP 404: Not Found");
    }
    if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--verify") {
      const rev = args[2].replace(/\^\{commit\}$/, "");
      if (head.startsWith(rev)) return `${head}
`;
      throw new Error("unknown revision");
    }
    if (cmd === "gh" && args[1] === "view") {
      if (!existingReleases.has(args[2])) throw new Error("not found");
      return "";
    }
    return "";
  };
  return { exec, calls };
}

function makeRoot({ version = "0.3.0", apk = false, marker = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rel-"));
  mkdirSync(join(root, "src-tauri"), { recursive: true });
  mkdirSync(join(root, "dist-desktop"), { recursive: true });
  mkdirSync(join(root, "docs", "releases"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", version }));
  writeFileSync(join(root, "src-tauri", "tauri.conf.json"), JSON.stringify({ version }));
  writeFileSync(join(root, "src-tauri", "Cargo.toml"), `[package]\nname = "demo-app"\nversion = "${version}"\n`);
  writeFileSync(
    join(root, "src-tauri", "Cargo.lock"),
    `[[package]]\nname = "other"\nversion = "1.0.0"\n\n[[package]]\nname = "demo-app"\nversion = "${version}"\n`,
  );
  writeFileSync(join(root, "docs", "releases", "TEMPLATE.md"), readFileSync(join(import.meta.dirname, "..", "docs", "releases", "TEMPLATE.md")));
  writeFileSync(join(root, "dist-desktop", "VibeSquad-setup.exe"), "installer");
  writeFileSync(join(root, "dist-desktop", "VibeSquad-setup.exe.sig"), "SIGDATA");
  writeFileSync(join(root, "dist-desktop", "latest.json"), "{}");
  if (apk) writeFileSync(join(root, "dist-desktop", "VibeSquad.apk"), "apk");
  if (marker) writeFileSync(join(root, "dist-desktop", "android-build.json"), JSON.stringify(marker));
  return root;
}

describe("signing env (F1)", () => {
  test("password is in env only, never in argv", () => {
    const env = updaterSigningEnv({ TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "hunter2" }, "/k/key");
    assert.equal(env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, "hunter2");
    assert.equal(env.TAURI_SIGNING_PRIVATE_KEY, undefined);
    const argv = signerSignArgs("tauri.js", "/k/key", "setup.exe");
    assert.ok(!argv.includes("-p"));
    assert.ok(!argv.join(" ").includes("hunter2"));
  });

  test("password falls back to the credential store via the injected reader; env wins", () => {
    const read = (target) => (target === "vibesquad/updater-key" ? "from-store" : null);
    assert.equal(updaterSigningEnv({}, "/k", { read }).TAURI_SIGNING_PRIVATE_KEY_PASSWORD, "from-store");
    assert.equal(updaterSigningEnv({ TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "env-pw" }, "/k", { read }).TAURI_SIGNING_PRIVATE_KEY_PASSWORD, "env-pw");
    assert.equal(updaterSigningEnv({}, "/k", { read: () => null }).TAURI_SIGNING_PRIVATE_KEY_PASSWORD, "");
  });

  test("sign stage passes no password in any exec argv", () => {
    const root = makeRoot();
    rmSync(join(root, "dist-desktop", "VibeSquad-setup.exe.sig"));
    const { exec, calls } = fakeExec();
    // fake signer "creates" the sig file
    const wrapped = (cmd, args, opts) => {
      if (args.includes("signer")) {
        writeFileSync(join(root, "dist-desktop", "VibeSquad-setup.exe.sig"), "S");
        assert.equal(opts.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, "hunter2");
      }
      return exec(cmd, args, opts);
    };
    runRelease(["sign", "--channel", "stable", "--commit", HEAD], {
      rootDir: root,
      exec: wrapped,
      env: { TAURI_SIGNING_PRIVATE_KEY: "inline", TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "hunter2" },
      log: () => {},
      resolveTauriCli: () => "tauri.js",
    });
    assert.ok(calls.some((c) => c.includes("signer")));
    assert.ok(!calls.flat().some((a) => String(a).includes("hunter2")));
  });
});

describe("subcommand parsing", () => {
  test("parses stage, channel, commit, version, android", () => {
    const o = parseArgs(["publish", "--channel", "stable", "--commit", "abc", "--version", "v1.2.3", "--with-android"]);
    assert.equal(o.stage, "publish");
    assert.equal(o.channel, "stable");
    assert.equal(o.commit, "abc");
    assert.equal(o.version, "1.2.3");
    assert.equal(o.withAndroid, true);
  });
  test("legacy invocation has no stage", () => {
    const o = parseArgs(["--channel", "beta"]);
    assert.equal(o.stage, "");
    assert.equal(o.channel, "beta");
  });
});

describe("frozen commit gate", () => {
  test("commit mismatch refused", () => {
    const { exec } = fakeExec();
    assert.throws(() => assertFrozenCommit({ commit: "d".repeat(40), requireClean: true, exec }), /HEAD is abc1234/);
  });
  test("missing --commit refused", () => {
    const { exec } = fakeExec();
    assert.throws(() => assertFrozenCommit({ commit: "", requireClean: true, exec }), /--commit/);
  });
  test("dirty tree refused, untracked files included (plain porcelain)", () => {
    const { exec, calls } = fakeExec({ dirty: " M server/release.mjs\n" });
    assert.throws(() => assertFrozenCommit({ commit: HEAD, requireClean: true, exec }), /dirty tree/);
    assert.ok(calls.some((c) => c[0] === "git" && c[1] === "status" && !c.includes("--untracked-files=no")));
  });
  test("clean tree at commit passes; abbreviated sha accepted", () => {
    const { exec } = fakeExec();
    assert.equal(assertFrozenCommit({ commit: "abc1234", requireClean: true, exec }), HEAD);
  });
  test("publish stage refuses on mismatch before any gh call", () => {
    const root = makeRoot();
    const { exec, calls } = fakeExec();
    assert.throws(() => runRelease(["publish", "--channel", "stable", "--commit", "b".repeat(40)], { rootDir: root, exec, env: {}, log: () => {} }), /HEAD is/);
    assert.ok(!calls.some((c) => c[0] === "gh"));
  });
});

describe("publish", () => {
  test("gh release create gets --target <sha>", () => {
    const root = makeRoot();
    const { exec, calls } = fakeExec();
    runRelease(["publish", "--channel", "stable", "--commit", HEAD], { rootDir: root, exec, env: {}, log: () => {} });
    const create = calls.find((c) => c[0] === "gh" && c[2] === "create" && c[3] === "v0.3.0");
    assert.ok(create);
    assert.equal(create[create.indexOf("--target") + 1], HEAD);
  });

  test("main path refuses an existing v-tag pointing elsewhere (no edit/upload/clobber)", () => {
    const root = makeRoot();
    const { exec, calls } = fakeExec({ existingReleases: new Set(["v0.3.0"]), tagShas: { "v0.3.0": "0ldc0mm1t" } });
    assert.throws(() => runRelease(["publish", "--channel", "stable", "--commit", HEAD], { rootDir: root, exec, env: {}, log: () => {} }), /Refusing to overwrite/);
    assert.ok(!calls.some((c) => c[0] === "gh" && (c[2] === "edit" || c[2] === "upload")));
  });

  test("tag existing without a release object is also refused when it points elsewhere", () => {
    const { exec, calls } = fakeExec({ tagShas: { "v0.3.0": "0ldc0mm1t" } });
    assert.throws(
      () => publishRelease({ channel: "stable", targetVersion: "0.3.0", assets: [], latestManifest: buildLatestJson({ version: "0.3.0", channel: "stable", signature: "S" }), exec, targetCommit: HEAD }),
      /Refusing to overwrite/,
    );
    assert.ok(!calls.some((c) => c[0] === "gh" && c[2] === "create"));
  });

  test("stale APK is excluded; matching-marker APK is included", () => {
    const stale = makeRoot({ apk: true, marker: { version: "0.2.9", commit: HEAD } });
    let r = fakeExec();
    runRelease(["publish", "--channel", "stable", "--commit", HEAD], { rootDir: stale, exec: r.exec, env: {}, log: () => {} });
    assert.ok(!r.calls.flat().some((a) => String(a).endsWith("VibeSquad.apk")));

    const noMarker = makeRoot({ apk: true });
    r = fakeExec();
    runRelease(["publish", "--channel", "stable", "--commit", HEAD], { rootDir: noMarker, exec: r.exec, env: {}, log: () => {} });
    assert.ok(!r.calls.flat().some((a) => String(a).endsWith("VibeSquad.apk")));

    const fresh = makeRoot({ apk: true, marker: { version: "0.3.0", commit: HEAD } });
    r = fakeExec();
    runRelease(["publish", "--channel", "stable", "--commit", HEAD], { rootDir: fresh, exec: r.exec, env: {}, log: () => {} });
    assert.ok(r.calls.flat().some((a) => String(a).endsWith("VibeSquad.apk")));
  });

  test("selectApk requires matching version and commit", () => {
    const root = makeRoot({ apk: true, marker: { version: "0.3.0", commit: "other" } });
    assert.equal(selectApk({ distDir: join(root, "dist-desktop"), version: "0.3.0", commit: HEAD }), null);
  });

  test("publish writes release record with artifact hashes and URL", () => {
    const root = makeRoot();
    const { exec } = fakeExec();
    runRelease(["publish", "--channel", "stable", "--commit", HEAD, "--project", "Demo", "--repo", "o/r"], { rootDir: root, exec, env: {}, log: () => {} });
    const rec = readFileSync(join(root, "docs", "releases", "Demo-0.3.0.md"), "utf8");
    assert.match(rec, /https:\/\/github\.com\/o\/r\/releases\/tag\/v0\.3\.0/);
    assert.match(rec, /VibeSquad-setup\.exe`: `[0-9a-f]{64}`/);
    assert.match(rec, new RegExp(HEAD));
  });
});

describe("stage", () => {
  test("syncVersionFiles bumps the Cargo.lock app entry only", () => {
    const root = makeRoot();
    syncVersionFiles(root, "0.4.0");
    const lock = readFileSync(join(root, "src-tauri", "Cargo.lock"), "utf8");
    assert.match(lock, /name = "demo-app"\nversion = "0\.4\.0"/);
    assert.match(lock, /name = "other"\nversion = "1\.0\.0"/);
  });

  test("stage bumps files and writes a record, with no build or gh calls", () => {
    const root = makeRoot();
    const { exec, calls } = fakeExec();
    runRelease(["stage", "--channel", "stable", "--version", "0.5.0", "--project", "Demo", "--repo", "o/r", "--requester", "Requester One"], { rootDir: root, exec, env: {}, log: () => {} });
    assert.equal(JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).version, "0.5.0");
    const rec = readFileSync(join(root, "docs", "releases", "Demo-0.5.0.md"), "utf8");
    assert.match(rec, /Requester One/);
    assert.ok(!calls.some((c) => c[0] === "gh" || c[0] === process.execPath));
  });

  test("record writer is project-agnostic", () => {
    const root = makeRoot();
    const p = writeReleaseRecord({ dir: root, project: "Roster", repo: "Pizzarar/Roster", version: "1.0.0", channel: "stable", commit: "c0ffee" });
    assert.match(p, /Roster-1\.0\.0\.md$/);
    assert.match(readFileSync(p, "utf8"), /# Roster 1\.0\.0 release record/);
  });
});

describe("review fixes", () => {
  const SHA = HEAD;

  test("--commit is canonicalized to the full sha via rev-parse --verify", () => {
    const root = makeRoot();
    const { exec, calls } = fakeExec();
    runRelease(["publish", "--channel", "stable", "--commit", "abc1234"], { rootDir: root, exec, env: {}, log: () => {} });
    assert.ok(calls.some((c) => c[0] === "git" && c[1] === "rev-parse" && c[2] === "--verify" && c[3] === "abc1234^{commit}"));
    const create = calls.find((c) => c[0] === "gh" && c[2] === "create" && c[3] === "v0.3.0");
    assert.equal(create[create.indexOf("--target") + 1], SHA);
  });

  test("unresolvable --commit is refused", () => {
    const { exec } = fakeExec();
    assert.throws(() => assertFrozenCommit({ commit: "zzzz", requireClean: false, exec }), /Cannot resolve commit/);
  });

  test("publishRelease normalizes a directly-passed short targetCommit", () => {
    const { exec, calls } = fakeExec();
    publishRelease({ channel: "stable", targetVersion: "0.3.0", assets: [], latestManifest: buildLatestJson({ version: "0.3.0", channel: "stable", signature: "S" }), exec, targetCommit: "abc1234", writeManifest: () => {} });
    const create = calls.find((c) => c[0] === "gh" && c[2] === "create" && c[3] === "v0.3.0");
    assert.equal(create[create.indexOf("--target") + 1], SHA);
  });

  test("rolling beta tag is pinned to the frozen sha, never HEAD", () => {
    const { exec, calls } = fakeExec({ head: "f".repeat(40), existingReleases: new Set(["beta"]) });
    publishRelease({ channel: "beta", targetVersion: "0.3.0-beta.1", assets: [], latestManifest: buildLatestJson({ version: "0.3.0-beta.1", channel: "beta", signature: "S" }), exec, targetCommit: SHA, writeManifest: () => {} });
    const tag = calls.find((c) => c[0] === "git" && c[1] === "tag");
    assert.deepEqual(tag.slice(1), ["tag", "-f", "beta", SHA]);
    assert.ok(!calls.some((c) => c.includes("HEAD") && c[0] === "git" && c[1] === "tag"));
  });

  test("tag lookup uses gh api for the configured repo and peels annotated tags", () => {
    const calls = [];
    const exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[1] === "repos/o/r/git/ref/tags/v1.0.0") return JSON.stringify({ object: { type: "tag", sha: "t1" } });
      if (args[1] === "repos/o/r/git/tags/t1") return JSON.stringify({ object: { type: "commit", sha: "c1" } });
      throw new Error("HTTP 404");
    };
    assert.equal(resolveTagCommit("v1.0.0", exec, ".", "o/r"), "c1");
    assert.equal(resolveTagCommit("v9", exec, ".", "o/r"), "");
    assert.ok(calls.every((c) => c[0] === "gh" && c[1] === "api"));
  });

  test("tag lookup fails closed on non-404 errors", () => {
    const exec = () => { throw new Error("network down"); };
    assert.throws(() => resolveTagCommit("v1.0.0", exec, ".", "o/r"), /Could not look up tag/);
  });

  test("publishRelease defaults --repo to DEFAULT_RELEASE_REPO", () => {
    const { exec, calls } = fakeExec();
    publishRelease({ channel: "stable", targetVersion: "0.3.0", assets: [], latestManifest: buildLatestJson({ version: "0.3.0", channel: "stable", signature: "S" }), exec, writeManifest: () => {} });
    const upload = calls.find((c) => c[0] === "gh" && c[2] === "upload");
    assert.deepEqual(upload.slice(-2), ["--repo", DEFAULT_RELEASE_REPO]);
  });

  test("record update preserves requester, approval, changelog and audit", () => {
    const root = makeRoot();
    const base = { dir: root, project: "Demo", repo: "o/r", version: "0.3.0", channel: "stable", commit: "c1" };
    const p = writeReleaseRecord({ ...base, requester: "Requester One", approval: "OK by lead", changelog: "- fixed things" });
    writeFileSync(p, readFileSync(p, "utf8").replace("| Tests | _pending_ |", "| Tests | PASS |"));
    writeReleaseRecord({ ...base, commit: "c2", releaseUrl: "https://x/y", artifacts: [{ name: "a.exe", sha256: "ab".repeat(32) }] });
    const rec = readFileSync(p, "utf8");
    assert.match(rec, /\| Requester \| Requester One \|/);
    assert.match(rec, /\| Approval \| OK by lead \|/);
    assert.match(rec, /- fixed things/);
    assert.match(rec, /\| Tests \| PASS \|/);
    assert.match(rec, /\| Commit \| c2 \|/);
    assert.match(rec, /\| Release URL \| https:\/\/x\/y \|/);
    assert.match(rec, /`a\.exe`: `abab/);
    assert.match(rec, /## Signature verification/);
  });

  test("legacy no-subcommand run writes no release record", () => {
    const root = makeRoot();
    const { exec } = fakeExec();
    runRelease(["--channel", "stable", "--skip-build"], { rootDir: root, exec, env: { TAURI_SIGNING_PRIVATE_KEY: "k" }, log: () => {}, resolveTauriCli: () => "t.js" });
    assert.equal(existsSync(join(root, "docs", "releases", "VibeSquad-0.3.0.md")), false);
  });
});
