// scripts/forge-migrate.mjs (docs/PLAN_FORGE_CUTOVER.md C2a/C3). Hermetic: temp dirs only, placeholder paths only.
import "./setup/hermetic.mjs"; // hermetic env for a direct `node --test <file>` run (run-tests.mjs preloads this)
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWLIST, HEAVY_DIRS, LARGE_UNTRACKED_BYTES, WIP_NS, backup, buildPathMap, bundleFlagged, devpcInventory, main, migrate, parseArgs, planUntracked,
  rewriteJsonText, rewriteJsonlText, rewriteString, rewriteText, unpushedReport,
} from "../scripts/forge-migrate.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/forge-migrate.mjs", import.meta.url));
const MAP_OPTS = { winUser: "someone", forgeHome: "/home/forge" };
const map = buildPathMap(MAP_OPTS, { platform: "linux", env: {}, home: "/home/forge" });
const W = "C:\\Users\\someone";

const temps = [];
const tmp = (tag) => { const d = mkdtempSync(join(tmpdir(), `vs-forge-migrate-${tag}-`)); temps.push(d); return d; };
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

/** Content hash of a tree: relative names, kinds and bytes. */
function treeHash(root) {
  const h = createHash("sha256");
  const walk = (rel) => {
    const abs = rel ? join(root, rel) : root;
    for (const name of readdirSync(abs).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, r));
      if (st.isDirectory()) { h.update(`d:${r}\n`); walk(r); }
      else { h.update(`f:${r}:${st.size}\n`); h.update(readFileSync(join(root, r))); }
    }
  };
  walk("");
  return h.digest("hex");
}

const put = (root, rel, body) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), body); };
const quiet = () => { const lines = []; return { log: (l) => lines.push(l), err: (l) => lines.push(l), lines }; };

function makeHome() {
  const home = tmp("src");
  put(home, "teams.json", JSON.stringify({
    teams: [{ id: "demo", repoRoot: `${W}\\projects\\Demo`, cwd: `${W}\\projects\\Demo\\sub`, big: 12345678901234567890, f: 1.50 }],
  }, null, 2).replace("12345678901234567000", "12345678901234567890").replace('"f": 1.5', '"f": 1.50') + "\n");
  put(home, "inbox.json", `{"items":[{"note":"see c:/users/SOMEONE/Projects/Demo/docs/x.md and C:\\\\Users\\\\someone\\\\AppData\\\\Local\\\\VibeSquad\\\\worktrees\\\\Demo\\\\unit-1","tmp":"C:\\\\Users\\\\someone\\\\AppData\\\\Local\\\\Temp\\\\vs-x"}]}`);
  put(home, "lessons.jsonl", [
    JSON.stringify({ cwd: `${W}\\projects\\Demo` }),
    "{not json C:\\Users\\someone\\projects\\Demo",
    JSON.stringify({ home: `${W}\\.vibesquad\\teams\\demo\\packet.md` }),
    "",
  ].join("\r\n"));
  put(home, "profiles.json", "{ broken json C:\\\\Users\\\\someone\\\\projects\\\\Demo ");
  put(home, "settings.json", "{}");
  put(home, "teams/demo/notes.md", `cwd: ${W}\\projects\\Demo\\x and D:\\Elsewhere\\thing\n`);
  put(home, "teams/demo/pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x43, 0x3a, 0x5c]));
  put(home, "brief-history/lane/b1.md", "brief");
  for (const name of ["runner/roster-index.json", "runtime/x.json", "worktrees/a/b", "tls/ca.pem", "devices.json", "host-id", "local-token", "daemon-password", "vapid.json", "logs/a.log", "restart-1.json", "teams.json.bak-x"]) {
    put(home, name, name.endsWith(".json") ? `{"cwd":"${W.replace(/\\/g, "\\\\")}\\\\projects\\\\Demo"}` : "secret");
  }
  return home;
}

describe("path map", () => {
  test("backslash, forward slash, JSON-escaped and case variants map to the forge roots", () => {
    const cases = [
      [`${W}\\projects\\Demo\\a.md`, "/home/forge/projects/Demo/a.md"],
      ["C:/Users/someone/projects/Demo/a.md", "/home/forge/projects/Demo/a.md"],
      ["c:\\USERS\\Someone\\PROJECTS\\Demo", "/home/forge/projects/Demo"],
      ["C:\\\\Users\\\\someone\\\\projects\\\\Demo\\\\x", "/home/forge/projects/Demo/x"],
      [`${W}\\AppData\\Local\\VibeSquad\\worktrees\\Demo\\unit-1`, "/home/forge/.vibesquad/worktrees/Demo/unit-1"],
      [`${W}\\AppData\\Local\\VibeSquad\\runtime\\cli\\vs.mjs`, "/home/forge/.vibesquad/runtime/cli/vs.mjs"],
      [`${W}\\.vibesquad\\teams\\demo`, "/home/forge/.vibesquad/teams/demo"],
    ];
    for (const [input, want] of cases) assert.equal(rewriteText(`x ${input} y`, map).text, `x ${want} y`, input);
  });

  test("leaves other users, look-alike prefixes and other drives alone", () => {
    for (const s of [`C:\\Users\\other\\projects\\Demo`, `${W}\\projectsX\\Demo`, `${W}\\AppData\\Local\\Temp\\x`, "D:\\projects\\Demo", "xC:\\Users\\someone\\projects\\Demo"]) {
      assert.equal(rewriteText(s, map).count, 0, s);
    }
  });

  test("custom roots and the win32 forge-home requirement", () => {
    const m = buildPathMap({ winUser: "someone", forgeHome: "/home/forge", projectsRoot: "/srv/p", worktreesRoot: "/srv/wt" }, { platform: "linux", env: {} });
    assert.equal(rewriteText(`${W}\\projects\\Demo`, m).text, "/srv/p/Demo");
    assert.equal(rewriteText(`${W}\\AppData\\Local\\VibeSquad\\worktrees\\a`, m).text, "/srv/wt/a");
    assert.throws(() => buildPathMap({ winUser: "someone" }, { platform: "win32", env: {} }), /--forge-home is required/);
    assert.throws(() => buildPathMap({}, { platform: "linux", env: {}, home: "/home/forge" }), /--win-user/);
    assert.equal(buildPathMap({ winUser: "someone", dryRun: true }, { platform: "win32", env: {} }).placeholder, true);
  });

  test("JSON rewrite touches only path strings (numbers, spacing, keys preserved) and keys are mapped", () => {
    const src = `{\n  "n": 12345678901234567890, "f": 1.50,\n  "${"C:\\\\Users\\\\someone\\\\projects\\\\Demo"}": "C:/Users/someone/projects/Demo/x"\n}`;
    const r = rewriteJsonText(src, map);
    assert.equal(r.count, 2);
    assert.equal(r.text, `{\n  "n": 12345678901234567890, "f": 1.50,\n  "/home/forge/projects/Demo": "/home/forge/projects/Demo/x"\n}`);
    assert.throws(() => rewriteJsonText("{bad", map));
  });

  test("JSONL is rewritten line by line, unparseable lines kept verbatim, CRLF kept", () => {
    const src = `{"cwd":"C:\\\\Users\\\\someone\\\\projects\\\\A"}\r\n{oops C:\\Users\\someone\\projects\\B\r\n{"cwd":"C:/Users/someone/projects/C"}\r\n`;
    const r = rewriteJsonlText(src, map);
    assert.equal(r.count, 2);
    assert.equal(r.badLines, 1);
    assert.equal(r.text, `{"cwd":"/home/forge/projects/A"}\r\n{oops C:\\Users\\someone\\projects\\B\r\n{"cwd":"/home/forge/projects/C"}\r\n`);
  });
});

describe("migrate", () => {
  let home;
  let srcHash;
  before(() => { home = makeHome(); srcHash = treeHash(home); });

  test("real run: allowlist only, exclusions honoured, files rewritten, unparseable copied verbatim, source untouched", () => {
    const to = join(tmp("dst"), "home");
    const s = migrate({ from: home, to, ...MAP_OPTS });
    assert.equal(treeHash(home), srcHash, "source tree changed");
    const top = readdirSync(to).sort();
    assert.deepEqual(top, ["brief-history", "inbox.json", "lessons.jsonl", "profiles.json", "settings.json", "teams", "teams.json"]);
    for (const name of top) assert.ok(ALLOWLIST.includes(name), name);
    const behind = s.leftBehind.map((l) => l.name).sort();
    for (const name of ["runner", "runtime", "worktrees", "tls", "devices.json", "host-id", "local-token", "daemon-password", "vapid.json", "logs", "restart-1.json", "teams.json.bak-x"]) {
      assert.ok(behind.includes(name), `left behind: ${name}`);
      assert.equal(existsSync(join(to, name)), false, `copied: ${name}`);
    }
    assert.ok(s.leftBehind.every((l) => l.bytes > 0));
    assert.deepEqual(s.missing.sort(), ["capped-providers.json", "reports", "schedules.json", "stakes-ladder.json"]);

    const teams = readFileSync(join(to, "teams.json"), "utf8");
    assert.match(teams, /"repoRoot": "\/home\/forge\/projects\/Demo"/);
    assert.match(teams, /12345678901234567890/);
    assert.match(teams, /"f": 1\.50/);
    const inbox = JSON.parse(readFileSync(join(to, "inbox.json"), "utf8"));
    assert.equal(inbox.items[0].note, "see /home/forge/projects/Demo/docs/x.md and /home/forge/.vibesquad/worktrees/Demo/unit-1");
    const lessons = readFileSync(join(to, "lessons.jsonl"), "utf8").split("\r\n");
    assert.equal(JSON.parse(lessons[0]).cwd, "/home/forge/projects/Demo");
    assert.equal(lessons[1], "{not json C:\\Users\\someone\\projects\\Demo");
    assert.equal(JSON.parse(lessons[2]).home, "/home/forge/.vibesquad/teams/demo/packet.md");
    assert.equal(readFileSync(join(to, "teams/demo/notes.md"), "utf8"), "cwd: /home/forge/projects/Demo/x and D:\\Elsewhere\\thing\n");
    assert.deepEqual(readFileSync(join(to, "teams/demo/pic.png")), readFileSync(join(home, "teams/demo/pic.png")));
    assert.deepEqual(readFileSync(join(to, "profiles.json")), readFileSync(join(home, "profiles.json")), "unparseable copied verbatim");
    assert.deepEqual(s.unparseable.map((u) => u.file), ["profiles.json"]);
    assert.deepEqual(s.badJsonlLines, [{ file: "lessons.jsonl", lines: 1 }]);
    assert.equal(s.copied, 8);
    assert.equal(s.unparseable.length, 1);
    assert.ok(s.rewritten >= 4);
    assert.equal(readdirSync(to, { recursive: true }).some((f) => String(f).includes("forge-migrate-")), false, "temp files left");
  });

  test("dry-run writes nothing, reports per-file counts and unmapped drive paths", () => {
    const parent = tmp("dry");
    const to = join(parent, "home");
    const before = treeHash(parent);
    const out = quiet();
    const code = main(["--from", home, "--to", to, "--dry-run", "--win-user", "someone", "--forge-home", "/home/forge"], out.log, out.err);
    assert.equal(code, 0, out.lines.join("\n"));
    assert.equal(existsSync(to), false);
    assert.equal(treeHash(parent), before);
    assert.equal(treeHash(home), srcHash);
    const text = out.lines.join("\n");
    assert.match(text, /\d+ {2}teams\.json/);
    assert.match(text, /UNMAPPED drive paths: [1-9]/);
    assert.match(text, /C:\\Users\\someone\\AppData\\Local\\Temp/);
    assert.match(text, /D:\\Elsewhere\\thing/);
    assert.match(text, /left behind .*\n(?:.*\n)*.*runner/);
    assert.match(text, /summary: copied=8 rewritten=\d+ .*unparseable=1 .*\(dry run: nothing written\)/);
  });

  test("refusals: non-empty destination without --force, same path, nested paths", () => {
    const to = tmp("full");
    put(to, "keep.txt", "forge-owned");
    const out = quiet();
    assert.equal(main(["--from", home, "--to", to, "--win-user", "someone", "--forge-home", "/home/forge"], out.log, out.err), 1);
    assert.match(out.lines.join("\n"), /not empty/);
    assert.equal(readdirSync(to).length, 1);
    assert.throws(() => migrate({ from: home, to: home, ...MAP_OPTS }), /same path/);
    assert.throws(() => migrate({ from: home, to: `${home}${process.platform === "win32" ? "\\." : "/."}`, ...MAP_OPTS }), /same path/);
    if (process.platform === "win32") assert.throws(() => migrate({ from: home, to: home.toUpperCase(), ...MAP_OPTS }), /same path/);
    assert.throws(() => migrate({ from: home, to: join(home, "teams", "x"), ...MAP_OPTS }), /inside --from/);
    assert.throws(() => migrate({ from: join(home, "teams"), to: home, ...MAP_OPTS }), /inside --to/);
    // --force merges: allowlisted files written, the forge's own files kept.
    migrate({ from: home, to, force: true, ...MAP_OPTS });
    assert.equal(readFileSync(join(to, "keep.txt"), "utf8"), "forge-owned");
    assert.ok(existsSync(join(to, "teams.json")));
    assert.equal(treeHash(home), srcHash);
  });

  test("non-UTF-8 text and BOM JSON: invalid bytes copied verbatim, BOM kept", () => {
    const src = tmp("enc");
    const latin1 = Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from(` ${W}\\projects\\Demo\n`)]);
    put(src, "reports/latin1.md", latin1);
    put(src, "settings.json", `\uFEFF{"cwd":"C:/Users/someone/projects/Demo"}`);
    const to = join(tmp("enc-dst"), "home");
    const s = migrate({ from: src, to, ...MAP_OPTS });
    assert.deepEqual(readFileSync(join(to, "reports/latin1.md")), latin1);
    assert.deepEqual(s.unparseable, [{ file: "reports/latin1.md", error: "not valid UTF-8" }]);
    assert.equal(readFileSync(join(to, "settings.json"), "utf8"), `\uFEFF{"cwd":"/home/forge/projects/Demo"}`);
  });

  test("CLI: usage errors exit 2, a bad --from exits 1", () => {
    const out = quiet();
    assert.equal(main(["--bogus"], out.log, out.err), 2);
    assert.equal(main(["--from", home], out.log, out.err), 2);
    assert.equal(main(["--from", join(home, "nope"), "--to", tmp("x"), "--win-user", "u", "--forge-home", "/h"], out.log, out.err), 1);
    assert.deepEqual(parseArgs(["--from=a", "--dry-run", "--to", "b"]), { dryRun: true, force: false, json: false, unpushedReport: false, bundle: false, devpcInventory: false, help: false, from: "a", to: "b" });
    assert.deepEqual(parseArgs(["--skip-bundle", "a", "--skip-bundle=b:c", "--keep", "k"]).skipBundle, ["a", "b:c"]);
  });

  test("the script never deletes: no delete calls in its source, source hash unchanged after every mode", () => {
    const code = readFileSync(SCRIPT, "utf8");
    assert.doesNotMatch(code, /\b(unlink|unlinkSync|rmdirSync|rmdir|rm|removeSync|truncateSync)\s*\(/);
    // The two allowed exceptions (both remove only what this run itself created): removeOwnScratch's one rmSync, and
    // the update-ref -d of the run's own temp refs under WIP_NS (see writeBundle).
    assert.equal(code.match(/\brmSync\s*\(/g).length, 1);
    assert.match(code, /function removeOwnScratch\(dir\) \{\n[^\n]*SCRATCH_PREFIX[^\n]*\n\s+rmSync\(dir/);
    assert.equal(code.match(/"update-ref", "-d"/g).length, 1);
    assert.doesNotMatch(code, /"(prune|fetch|gc|clean|reset|checkout|switch|push|pull)"/);
    assert.doesNotMatch(code, /"stash", "(push|save|drop|pop|clear)"/);
    assert.equal(treeHash(home), srcHash);
  });
});

describe("backup", () => {
  test("archives the full home, skips lock files, writes only into --backup, refuses a dir inside the source", () => {
    const home = makeHome();
    put(home, "teams/demo/teams.json.lock", "123");
    const srcHash = treeHash(home);
    const dir = tmp("bak");
    const dry = backup({ from: home, backup: dir, dryRun: true });
    assert.equal(readdirSync(dir).length, 0, "dry run wrote");
    assert.deepEqual(dry.skipped, [{ file: "teams/demo/teams.json.lock", reason: "lock" }]);
    const s = backup({ from: home, backup: dir }, { now: new Date("2026-01-02T03:04:05.006Z") });
    assert.equal(treeHash(home), srcHash);
    const ext = process.platform === "win32" ? "zip" : "tar.gz";
    assert.deepEqual(readdirSync(dir), [`vibesquad-home-2026-01-02T03-04-05-006Z.${ext}`]);
    assert.equal(s.archived, s.files, JSON.stringify(s.errors));
    assert.ok(s.files >= 20);
    assert.deepEqual(s.errors, []);
    assert.throws(() => backup({ from: home, backup: join(home, "backups") }), /inside --from/);
    assert.equal(existsSync(join(home, "backups")), false);
    assert.throws(() => backup({ from: home, backup: dir }, { now: new Date("2026-01-02T03:04:05.006Z") }), /already exists/);
  });
});

describe("review R1 fixes", () => {
  const link = (target, path) => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");

  test("H1a: a junction under --to pointing into the source is refused (with --force), source untouched", () => {
    const src = makeHome();
    const hash = treeHash(src);
    const to = tmp("h1a");
    link(join(src, "teams"), join(to, "teams"));
    assert.throws(() => migrate({ from: src, to, force: true, ...MAP_OPTS }), /link or junction/);
    const to2 = tmp("h1a-deep");
    mkdirSync(join(to2, "teams"));
    link(join(src, "teams", "demo"), join(to2, "teams", "demo"));
    assert.throws(() => migrate({ from: src, to: to2, force: true, ...MAP_OPTS }), /link or junction/);
    assert.equal(treeHash(src), hash);
  });

  test("H1b: a --to under a junction to the source is refused, nothing created in the source", () => {
    const src = makeHome();
    const hash = treeHash(src);
    const j = join(tmp("h1b"), "j");
    link(src, j);
    assert.throws(() => migrate({ from: src, to: join(j, "new"), ...MAP_OPTS }), /inside --from/);
    assert.throws(() => backup({ from: src, backup: join(j, "bak") }), /inside --from/);
    assert.equal(existsSync(join(src, "new")), false);
    assert.equal(existsSync(join(src, "bak")), false);
    assert.equal(treeHash(src), hash);
  });

  test("M1: a path that would be half converted is left whole and reported; a whole-string path converts fully", () => {
    for (const s of [`open ${W}\\projects\\My Game\\x now`, `${W}\\projects\\Demo(1)\\x`, `${W}\\projects\\a,b\\x`]) {
      const r = rewriteText(s, map);
      assert.deepEqual([r.text, r.count, r.half], [s, 0, 1], s);
    }
    assert.equal(rewriteText(`${W}\\projects\\Demo\\a.md:39 and (${W}\\projects\\Demo\\b.md)`, map).text, "/home/forge/projects/Demo/a.md:39 and (/home/forge/projects/Demo/b.md)");
    // M1 regression (real log shape): `<path> key=<second drive path>` is two paths, both convert.
    const twoPaths = `runtime=${W}\\AppData\\Local\\VibeSquad\\runtime\\docs\\b.md project=${W}\\projects\\Demo\\docs\\b.md\n- x (${W}\\projects\\Demo\\a.md (C:/Users/someone/projects/Demo/c.md)`;
    const tp = rewriteText(twoPaths, map);
    assert.deepEqual([tp.text, tp.count, tp.half], ["runtime=/home/forge/.vibesquad/runtime/docs/b.md project=/home/forge/projects/Demo/docs/b.md\n- x (/home/forge/projects/Demo/a.md (/home/forge/projects/Demo/c.md)", 4, 0]);
    const tj = rewriteJsonText(JSON.stringify({ msg: twoPaths }), map);
    assert.deepEqual([tj.count, tj.half], [4, 0]);
    // ...but a real continuation after a second path's key is still refused.
    assert.equal(rewriteText(`${W}\\projects\\My Game\\x project=${W}\\projects\\Demo`, map).half, 1);
    assert.equal(rewriteString(`${W}\\projects\\My Game\\x (copy).md`, map).text, "/home/forge/projects/My Game/x (copy).md");
    const j = rewriteJsonText(JSON.stringify({ a: `see ${W}\\projects\\My Game\\x`, b: `${W}\\projects\\My Game\\x` }), map);
    assert.deepEqual(JSON.parse(j.text), { a: `see ${W}\\projects\\My Game\\x`, b: "/home/forge/projects/My Game/x" });
    assert.equal(j.half, 1);
    const src = tmp("m1");
    put(src, "teams/n.md", `see ${W}\\projects\\My Game\\x\n`);
    const s = migrate({ from: src, to: join(tmp("m1-dst"), "h"), dryRun: true, ...MAP_OPTS });
    assert.equal(s.halfLeft, 1);
    assert.deepEqual(s.unmapped, [{ path: "C:\\Users\\someone\\projects\\My", count: 1 }]);
  });

  test("L1 (re-review): 2+ space-separated words before a backslash are refused, a later drive path still converts", () => {
    for (const s of [`see ${W}\\projects\\My Big Game\\src\\a.mjs`, `see ${W}\\projects\\My  Big Game\\src`, `(${W}\\projects\\A B C D\\x)`]) {
      const r = rewriteText(s, map);
      assert.deepEqual([r.text, r.count, r.half], [s, 0, 1], s);
    }
    // No new drive prefix is crossed: the words before a second drive path are not a continuation.
    const two = rewriteText(`${W}\\projects\\Demo\\a.md and some more words ${W}\\projects\\Demo\\b.md`, map);
    assert.deepEqual([two.text, two.count, two.half], ["/home/forge/projects/Demo/a.md and some more words /home/forge/projects/Demo/b.md", 2, 0]);
    // The M1-regression shape (`key=<drive path>`) still converts both paths.
    const kv = rewriteText(`runtime=${W}\\projects\\Demo\\a.md project=${W}\\projects\\Demo\\b.md`, map);
    assert.deepEqual([kv.count, kv.half], [2, 0]);
    assert.equal(rewriteString(`${W}\\projects\\My Big Game\\src\\a.mjs`, map).text, "/home/forge/projects/My Big Game/src/a.mjs");
  });

  test("L1: keys that would collide keep their original text and are reported", () => {
    const src = JSON.stringify({
      "C:\\Users\\someone\\projects\\Demo": 1, "C:/Users/someone/projects/Demo": 2,
      "/home/forge/projects/X": 3, "C:/Users/someone/projects/X": 4, nest: { "C:/Users/someone/projects/Y": 5 },
    });
    const r = rewriteJsonText(src, map);
    const out = JSON.parse(r.text);
    assert.deepEqual(r.conflicts.sort(), ["C:/Users/someone/projects/Demo", "C:/Users/someone/projects/X", "C:\\Users\\someone\\projects\\Demo"]);
    assert.equal(out["C:\\Users\\someone\\projects\\Demo"], 1);
    assert.equal(out["C:/Users/someone/projects/Demo"], 2);
    assert.equal(out["/home/forge/projects/X"], 3);
    assert.equal(out["C:/Users/someone/projects/X"], 4);
    assert.deepEqual(out.nest, { "/home/forge/projects/Y": 5 });
    const home = tmp("l1");
    put(home, "teams.json", src);
    const s = migrate({ from: home, to: join(tmp("l1-dst"), "h"), dryRun: true, ...MAP_OPTS });
    assert.equal(s.keyConflicts.length, 3);
  });

  test("L2: file:/// and \\\\?\\ prefixes are left alone and reported as unmapped", () => {
    const s = `file:///C:/Users/someone/projects/Demo/x.md and \\\\?\\C:\\Users\\someone\\projects\\Demo\\y`;
    assert.equal(rewriteText(s, map).count, 0);
    assert.equal(rewriteString("\\\\?\\C:\\Users\\someone\\projects\\Demo", map).count, 0);
    const home = tmp("l2");
    put(home, "teams/x.md", s);
    const r = migrate({ from: home, to: join(tmp("l2-dst"), "h"), dryRun: true, ...MAP_OPTS });
    assert.equal(r.unmappedTotal, 2);
  });
});

// ---------------------------------------------------------------- git fixtures
const g = (args, cwd) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { cwd, stdio: "pipe", windowsHide: true }).toString();
const refsOf = (cwd) => g(["for-each-ref", "--format=%(refname) %(objectname)"], cwd) + g(["rev-parse", "HEAD"], cwd);

/**
 * origin.git + Demo (main checkout: unpushed branch unit-loose, one stash) + sanctuary worktrees:
 * Demo/work (unit-work: 1 unpushed commit, tracked.txt modified, new.txt (+ big.bin) untracked), Demo/pushed (clean),
 * Demo/det (detached HEAD with a commit), Demo/not-a-worktree (plain folder).
 */
function makeSanctuary({ big = false } = {}) {
  const base = tmp("git");
  const origin = join(base, "origin.git");
  const repo = join(base, "Demo");
  const sanctuary = join(base, "worktrees");
  execFileSync("git", ["init", "-q", "--bare", "-b", "master", origin], { windowsHide: true });
  execFileSync("git", ["init", "-q", "-b", "master", repo], { windowsHide: true });
  writeFileSync(join(repo, "tracked.txt"), "v1\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  g(["add", "-A"], repo);
  g(["commit", "-q", "-m", "init"], repo);
  g(["remote", "add", "origin", origin], repo);
  g(["push", "-q", "-u", "origin", "master"], repo);
  g(["update-ref", "refs/heads/unit-loose", g(["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "loose"], repo).trim()], repo);
  writeFileSync(join(repo, "tracked.txt"), "stashed\n");
  g(["stash", "push", "-q", "-m", "s1"], repo);
  const work = join(sanctuary, "Demo", "work");
  g(["worktree", "add", "-q", "-b", "unit-work", work, "master"], repo);
  g(["worktree", "add", "-q", "-b", "unit-pushed", join(sanctuary, "Demo", "pushed"), "master"], repo);
  g(["push", "-q", "origin", "unit-pushed"], repo);
  g(["worktree", "add", "-q", "--detach", join(sanctuary, "Demo", "det"), "master"], repo);
  g(["commit", "-q", "--allow-empty", "-m", "detached work"], join(sanctuary, "Demo", "det"));
  writeFileSync(join(work, "committed.txt"), "committed\n");
  g(["add", "committed.txt"], work);
  g(["commit", "-q", "-m", "unpushed"], work);
  writeFileSync(join(work, "tracked.txt"), "v2-dirty\n");
  writeFileSync(join(work, "new.txt"), "untracked\n");
  writeFileSync(join(work, "ignored.txt"), "ignored\n");
  if (big) writeFileSync(join(work, "big.bin"), Buffer.alloc(LARGE_UNTRACKED_BYTES + 1));
  mkdirSync(join(sanctuary, "Demo", "not-a-worktree"), { recursive: true });
  return { base, origin, repo, sanctuary, work };
}

describe("unpushed report", () => {
  test("per common dir: unpushed branches with owners, stashes, dirty, detached, non-git folders; read-only", () => {
    const fx = makeSanctuary();
    const hash = treeHash(fx.base);
    const s = unpushedReport({ sanctuary: fx.sanctuary });
    assert.equal(treeHash(fx.base), hash, "report wrote to the repo or worktrees");
    assert.deepEqual(
      [s.worktrees, s.repos, s.unpushedCommits, s.unpushedBranches, s.stashes, s.dirty, s.detached, s.notGit, s.errors, s.safeToDelete],
      [3, 1, 2, 2, 1, 1, 1, ["Demo/not-a-worktree"], 0, false],
    );
    const repo = s.repoReports[0];
    assert.equal(repo.name, "Demo");
    assert.deepEqual(repo.branches.sort((a, b) => a.name.localeCompare(b.name)), [
      { name: "unit-loose", ahead: 1, owner: null },
      { name: "unit-work", ahead: 1, owner: "Demo/work" },
    ]);
    const out = quiet();
    assert.equal(main(["--unpushed-report", "--sanctuary", fx.sanctuary, "--win-projects", tmp("noproj")], out.log, out.err), 0);
    const last = JSON.parse(out.lines.at(-1));
    assert.deepEqual([last.unpushedBranches, last.stashes, last.dirty, last.detached, last.notGit, last.safeToDelete], [2, 1, 1, 1, 1, false]);
    assert.match(out.lines.join("\n"), /as of the last fetch/);
    assert.match(out.lines.join("\n"), /NOT A GIT WORKTREE: Demo\/not-a-worktree/);
    assert.equal(treeHash(fx.base), hash);
  });
});

describe("bundle", () => {
  const NOW = new Date("2026-01-02T03:04:05.006Z");
  const STAMP = "2026-01-02T03-04-05-006Z";

  test("bundles restore unpushed, dirty and untracked work; worktree, index and refs untouched; temp refs gone", () => {
    const fx = makeSanctuary({ big: true });
    const indexFile = resolve(fx.work, g(["rev-parse", "--git-path", "index"], fx.work).trim());
    const before = { status: g(["status", "--porcelain=v2", "--untracked-files=all"], fx.work), index: readFileSync(indexFile), refs: refsOf(fx.repo), tree: treeHash(fx.work), stash: g(["stash", "list"], fx.repo) };
    const scratchBefore = readdirSync(tmpdir()).filter((n) => n.startsWith("vs-forge-migrate-scratch-")).length;
    const dir = join(tmp("bundles"), "out");
    const s = bundleFlagged(unpushedReport({ sanctuary: fx.sanctuary }), { bundleDir: dir }, { now: NOW });

    assert.equal(g(["status", "--porcelain=v2", "--untracked-files=all"], fx.work), before.status);
    assert.deepEqual(readFileSync(indexFile), before.index);
    assert.equal(refsOf(fx.repo), before.refs);
    assert.equal(treeHash(fx.work), before.tree);
    assert.equal(g(["stash", "list"], fx.repo), before.stash);
    assert.equal(g(["for-each-ref", WIP_NS], fx.repo), "", "temp ref left behind");
    assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith("vs-forge-migrate-scratch-")).length, scratchBefore, "scratch left behind");

    assert.deepEqual(readdirSync(dir).sort(), ["Demo__det.bundle", "Demo__repo.bundle", "Demo__work.bundle", "manifest.json"]);
    assert.deepEqual([s.bundles, s.verified, s.failed, s.skippedLarge], [3, 3, 0, 1], JSON.stringify(s.entries.map((e) => e.error)));
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const work = manifest.bundles.find((b) => b.worktree === "Demo/work");
    assert.deepEqual([work.branch, work.unpushedCount, work.dirtyCount, work.bundle, work.verified], ["unit-work", 1, 3, "Demo__work.bundle", true]);
    assert.deepEqual(work.skippedLarge.map((f) => f.path), ["big.bin"]);
    assert.match(work.sha, /^[0-9a-f]{40}$/);

    // Restore: clone the remote, fetch everything from the bundles.
    const r = join(tmp("restore"), "r");
    execFileSync("git", ["clone", "-q", fx.origin, r], { windowsHide: true });
    for (const b of ["Demo__work.bundle", "Demo__repo.bundle"]) g(["fetch", "-q", join(dir, b), "refs/*:refs/restored/*"], r);
    g(["fetch", "-q", join(dir, "Demo__det.bundle"), "HEAD:refs/restored/det"], r);
    assert.equal(g(["show", "refs/restored/heads/unit-work:committed.txt"], r), "committed\n");
    const wip = `refs/restored/vs-migrate-wip/Demo/work/${STAMP}/wip`;
    assert.equal(g(["show", `${wip}:tracked.txt`], r), "v2-dirty\n");
    assert.equal(g(["show", `${wip}:new.txt`], r), "untracked\n");
    assert.equal(g(["show", `${wip}:committed.txt`], r), "committed\n");
    assert.throws(() => g(["cat-file", "-e", `${wip}:big.bin`], r));
    assert.throws(() => g(["cat-file", "-e", `${wip}:ignored.txt`], r));
    assert.match(g(["log", "-1", "--format=%s", wip], r), /^WIP snapshot Demo\/work /);
    assert.match(g(["log", "-1", "--format=%s", "refs/restored/heads/unit-loose"], r), /loose/);
    assert.equal(g(["show", `refs/restored/vs-migrate-wip/Demo/_repo/${STAMP}/stash-0:tracked.txt`], r), "stashed\n");
    assert.match(g(["log", "-1", "--format=%s", "refs/restored/det"], r), /detached work/);
  });

  test("refusals, dry run, and --backup --bundle puts the bundles in the archive", () => {
    const fx = makeSanctuary();
    const report = unpushedReport({ sanctuary: fx.sanctuary });
    const full = tmp("full");
    put(full, "x", "x");
    assert.throws(() => bundleFlagged(report, { bundleDir: full }), /not empty/);
    assert.throws(() => bundleFlagged(report, { bundleDir: join(fx.sanctuary, "b") }), /would land in/);
    const dryDir = join(tmp("dry"), "b");
    const dry = bundleFlagged(report, { bundleDir: dryDir, dryRun: true });
    assert.equal(dry.entries.length, 3);
    assert.equal(existsSync(dryDir), false);
    const out = quiet();
    assert.equal(main(["--bundle", "--sanctuary", fx.sanctuary, "--win-projects", tmp("noproj")], out.log, out.err), 2);

    const home = makeHome();
    const homeHash = treeHash(home);
    const bak = tmp("bak-bundle");
    const code = main(["--from", home, "--backup", bak, "--bundle", "--sanctuary", fx.sanctuary, "--win-projects", tmp("noproj")], out.log, out.err, { now: NOW });
    assert.equal(code, 0, out.lines.join("\n"));
    assert.equal(treeHash(home), homeHash);
    const ext = process.platform === "win32" ? "zip" : "tar.gz";
    const archive = join(bak, `vibesquad-home-${STAMP}.${ext}`);
    const tarBin = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
    const names = execFileSync(tarBin, ["-tf", archive], { windowsHide: true }).toString().split(/\r?\n/);
    for (const b of ["Demo__work.bundle", "Demo__det.bundle", "Demo__repo.bundle", "manifest.json"]) assert.ok(names.includes(`vibesquad-bundles-${STAMP}/${b}`), b);
    assert.ok(names.includes("teams.json"));
    assert.match(out.lines.join("\n"), /backup: files=\d+ bundles=4 .*archived=/);
  });
});

describe("main checkouts, untracked tar, --skip-bundle, --devpc-inventory", () => {
  const NOW = new Date("2026-01-02T03:04:05.006Z");
  const STAMP = "2026-01-02T03-04-05-006Z";

  /**
   * makeSanctuary + work in the main checkout Demo: branch main-feature (1 unpushed commit) checked out, untracked
   * notes.txt, ignored docs/brainstorm/x.md, node_modules/pkg/index.js and app.exe (via .git/info/exclude). Plus a
   * second clone Site under the projects dir (fx.base) with an unpushed branch, and a plain folder Scratch.
   */
  function makeMainWork() {
    const fx = makeSanctuary();
    g(["checkout", "-q", "-b", "main-feature"], fx.repo);
    writeFileSync(join(fx.repo, "main.txt"), "main work\n");
    g(["add", "main.txt"], fx.repo);
    g(["commit", "-q", "-m", "main unpushed"], fx.repo);
    writeFileSync(join(fx.repo, ".git", "info", "exclude"), "docs/brainstorm/\nnode_modules/\n*.exe\n");
    put(fx.repo, "notes.txt", "untracked notes\n");
    put(fx.repo, "docs/brainstorm/x.md", "ignored brainstorm\n");
    put(fx.repo, "node_modules/pkg/index.js", "module.exports = 1;\n");
    put(fx.repo, "app.exe", "MZ");
    const site = join(fx.base, "Site");
    execFileSync("git", ["clone", "-q", fx.origin, site], { windowsHide: true });
    g(["checkout", "-q", "-b", "site-old"], site);
    g(["commit", "-q", "--allow-empty", "-m", "site old"], site);
    g(["checkout", "-q", "master"], site);
    mkdirSync(join(fx.base, "Scratch"));
    return { ...fx, site };
  }

  test("untracked plan includes ignored docs, leaves out denylisted dirs and binaries; read-only", () => {
    const fx = makeMainWork();
    const hash = treeHash(fx.repo);
    const u = planUntracked(fx.repo);
    assert.deepEqual(u.files.sort(), ["docs/brainstorm/x.md", "notes.txt"]);
    assert.deepEqual(u.skipped.map((k) => `${k.path}:${k.reason}`).sort(), ["app.exe:denylist", "node_modules/:denylist"]);
    assert.equal(treeHash(fx.repo), hash);
  });

  test("M2: src-tauri/target and the other heavy dirs are left out of the untracked plan", () => {
    const repo = join(tmp("heavy"), "App");
    execFileSync("git", ["init", "-q", "-b", "master", repo], { windowsHide: true });
    for (const d of ["src-tauri/target/debug", "dist-desktop", "coverage", "playwright-report", "test-results", "web/Target"]) put(repo, `${d}/x.bin`, "x");
    put(repo, "src-tauri/src/main.rs", "fn main() {}\n");
    put(repo, "docs/brainstorm/b.md", "brief\n");
    put(repo, "scratch/shots/s.png", "png");
    const hash = treeHash(repo);
    const u = planUntracked(repo);
    assert.deepEqual(u.files.sort(), ["docs/brainstorm/b.md", "scratch/shots/s.png", "src-tauri/src/main.rs"]);
    assert.deepEqual(u.skipped.filter((k) => k.reason === "denylist").map((k) => k.path).sort(),
      ["coverage/", "dist-desktop/", "playwright-report/", "src-tauri/target/", "test-results/", "web/Target/"]);
    assert.equal(treeHash(repo), hash);
    for (const d of ["node_modules", "dist", ".godot", ".import", "build", "target"]) assert.ok(HEAVY_DIRS.includes(d), d);
  });

  test("--bundle covers main checkouts under --win-projects: unpushed branch + WIP bundle, untracked tar, manifest", () => {
    const fx = makeMainWork();
    const before = { refs: refsOf(fx.repo), status: g(["status", "--porcelain=v2", "--untracked-files=all", "--ignored"], fx.repo) };
    const report = unpushedReport({ sanctuary: fx.sanctuary, winProjects: fx.base });
    assert.deepEqual(report.items.filter((i) => i.main).map((i) => i.path).sort(), ["projects/Demo", "projects/Site"]);
    assert.equal(report.checkouts, 2);
    const dir = join(tmp("main-bundles"), "out");
    const s = bundleFlagged(report, { bundleDir: dir }, { now: NOW });
    assert.equal(refsOf(fx.repo), before.refs);
    assert.equal(g(["status", "--porcelain=v2", "--untracked-files=all", "--ignored"], fx.repo), before.status);
    assert.equal(s.failed, 0, JSON.stringify([s.entries, s.checkouts]));
    const files = readdirSync(dir).sort();
    for (const f of ["Demo__main.bundle", "Demo__untracked.tar", "Site__repo.bundle", "manifest.json"]) assert.ok(files.includes(f), `${f} in ${files}`);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const demo = manifest.checkouts.find((c) => c.path === "projects/Demo");
    assert.deepEqual([demo.bundle, demo.untrackedTar, demo.fileCount], ["Demo__main.bundle", "Demo__untracked.tar", 2]);
    assert.ok(demo.skipped.some((k) => k.path === "node_modules/" && k.reason === "denylist"));
    const tarBin = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
    const names = execFileSync(tarBin, ["-tf", join(dir, "Demo__untracked.tar")], { windowsHide: true }).toString().split(/\r?\n/).filter(Boolean);
    assert.ok(names.includes("docs/brainstorm/x.md"), names.join(","));
    assert.ok(!names.some((n) => n.includes("node_modules") || n.endsWith(".exe")), names.join(","));
    // Restore: the main checkout's unpushed branch and its WIP (untracked non-ignored notes.txt, not the ignored doc).
    const r = join(tmp("restore-main"), "r");
    execFileSync("git", ["clone", "-q", fx.origin, r], { windowsHide: true });
    g(["fetch", "-q", join(dir, "Demo__main.bundle"), "refs/*:refs/restored/*"], r);
    assert.equal(g(["show", "refs/restored/heads/main-feature:main.txt"], r), "main work\n");
    const wip = `refs/restored/vs-migrate-wip/Demo/Demo/${STAMP}/wip`;
    assert.equal(g(["show", `${wip}:notes.txt`], r), "untracked notes\n");
    assert.throws(() => g(["cat-file", "-e", `${wip}:docs/brainstorm/x.md`], r));
    g(["fetch", "-q", join(dir, "Site__repo.bundle"), "refs/*:refs/restored-site/*"], r);
    assert.match(g(["log", "-1", "--format=%s", "refs/restored-site/heads/site-old"], r), /site old/);
  });

  test("--skip-bundle <repo>:<branch> and <repo> are honoured and listed as skipped-by-owner", () => {
    const fx = makeMainWork();
    const report = unpushedReport({ sanctuary: fx.sanctuary, winProjects: fx.base });
    const a = bundleFlagged(report, { bundleDir: join(tmp("skip"), "b"), dryRun: true, skipBundle: ["site:site-old", "Demo:unit-work"] });
    assert.ok(!a.entries.some((e) => e.repo === "Site"), "Site bundle planned");
    assert.ok(!a.entries.some((e) => e.worktree === "Demo/work"), "Demo/work bundle planned");
    assert.ok(a.entries.some((e) => e.worktree === "projects/Demo"));
    assert.deepEqual(a.skippedByOwner.map((k) => `${k.repo}:${k.branch}${k.worktree ? `@${k.worktree}` : ""}`).sort(), ["Demo:unit-work", "Demo:unit-work@Demo/work", "Site:site-old"]);
    const dir = join(tmp("skip-real"), "b");
    const b = bundleFlagged(report, { bundleDir: dir, skipBundle: ["Demo"] }, { now: NOW });
    assert.ok(b.entries.every((e) => e.repo !== "Demo"));
    assert.ok(b.checkouts.every((c) => c.repo !== "Demo"));
    assert.ok(!readdirSync(dir).some((f) => f.startsWith("Demo__")));
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.skippedByOwner.map((k) => [k.repo, k.branch, k.reason]), [["Demo", null, "skipped-by-owner"]]);
  });

  test("M1 (re-review): skipping the main checkout's branch keeps its untracked tar", () => {
    const fx = makeMainWork();
    const report = unpushedReport({ sanctuary: fx.sanctuary, winProjects: fx.base });
    const dryDir = join(tmp("skip-main"), "b");
    const a = bundleFlagged(report, { bundleDir: dryDir, dryRun: true, skipBundle: ["Demo:main-feature"] });
    assert.equal(existsSync(dryDir), false);
    const demo = a.checkouts.find((c) => c.path === "projects/Demo");
    assert.ok(demo, JSON.stringify(a.checkouts));
    assert.equal(demo.untrackedTar, "Demo__untracked.tar");
    assert.ok(!a.entries.some((e) => e.worktree === "projects/Demo"), "skipped branch's checkout bundled");
    assert.ok(a.entries.some((e) => e.worktree === "Demo/work"), "unrelated worktree dropped");
    assert.ok(a.skippedByOwner.some((k) => k.worktree === "projects/Demo" && k.branch === "main-feature"));
    // Real run: the tar is written with the ignored brief.
    const dir = join(tmp("skip-main-real"), "b");
    const b = bundleFlagged(report, { bundleDir: dir, skipBundle: ["Demo:main-feature"] }, { now: NOW });
    assert.equal(b.failed, 0, JSON.stringify([b.entries, b.checkouts]));
    const tarBin = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
    const names = execFileSync(tarBin, ["-tf", join(dir, "Demo__untracked.tar")], { windowsHide: true }).toString().split(/\r?\n/);
    assert.ok(names.includes("docs/brainstorm/x.md"), names.join(","));
  });

  test("M1 (re-review): skipping a worktree's branch moves its other owned unpushed branches to the repo bundle", () => {
    const fx = makeMainWork();
    // A branch named after the Demo/work worktree folder: owned by it through the name match, not checked out.
    g(["update-ref", "refs/heads/work", g(["commit-tree", "master^{tree}", "-p", "master", "-m", "named after wt"], fx.repo).trim()], fx.repo);
    const report = unpushedReport({ sanctuary: fx.sanctuary, winProjects: fx.base });
    assert.equal(report.repoReports.find((r) => r.name === "Demo").branches.find((b) => b.name === "work").owner, "Demo/work");
    const a = bundleFlagged(report, { bundleDir: join(tmp("skip-wt"), "b"), dryRun: true, skipBundle: ["Demo:unit-work"] });
    assert.ok(!a.entries.some((e) => e.worktree === "Demo/work"));
    const repoEntry = a.entries.find((e) => e.kind === "repo" && e.repo === "Demo");
    assert.ok(repoEntry && repoEntry.branches.some((b) => b.name === "work"), JSON.stringify(a.entries));
    const all = a.entries.flatMap((e) => e.branches.map((b) => b.name));
    assert.ok(!all.includes("unit-work"), "skipped branch bundled");
    assert.deepEqual(all.filter((n) => n === "work"), ["work"], "kept branch bundled exactly once");
    // Real run: the moved branch restores from the repo bundle.
    const dir = join(tmp("skip-wt-real"), "b");
    const b = bundleFlagged(report, { bundleDir: dir, skipBundle: ["Demo:unit-work"] }, { now: NOW });
    assert.equal(b.failed, 0, JSON.stringify([b.entries, b.checkouts]));
    const r = join(tmp("restore-skip-wt"), "r");
    execFileSync("git", ["clone", "-q", fx.origin, r], { windowsHide: true });
    g(["fetch", "-q", join(dir, "Demo__repo.bundle"), "refs/*:refs/restored/*"], r);
    assert.match(g(["log", "-1", "--format=%s", "refs/restored/heads/work"], r), /named after wt/);
  });

  test("--devpc-inventory: read-only, proposes keep for --keep and the default keep names, delete otherwise", () => {
    const fx = makeMainWork();
    const hash = treeHash(fx.base);
    const vs = tmp("vsdata");
    put(vs, "runtime/x.txt", "x");
    const s = devpcInventory({ winProjects: fx.base, keep: ["site"], vsData: [join(vs, "runtime")] });
    assert.equal(treeHash(fx.base), hash);
    const by = Object.fromEntries(s.rows.map((r) => [r.name, r]));
    assert.equal(by.Site.proposal, "keep");
    assert.equal(by.Site.reason, "--keep");
    assert.deepEqual(by.Site.localOnlyBranches, [{ name: "site-old", ahead: 1 }]);
    assert.equal(by.Demo.proposal, "delete");
    assert.equal(by.Demo.git, true);
    assert.equal(by.Demo.untrackedDocs, 1);
    assert.ok(by.Demo.dirty >= 1);
    assert.equal(by.Scratch.git, false);
    assert.equal(by.runtime.kind, "vs-data");
    assert.equal(by.runtime.bytes, 1);
    const out = quiet();
    assert.equal(main(["--devpc-inventory", "--win-projects", fx.base, "--keep", "Demo", "--vs-data", join(vs, "runtime")], out.log, out.err), 0);
    assert.match(out.lines.join("\n"), /keep\s+.*\bDemo\b/);
    assert.match(out.lines.at(-1), /^inventory: dirs=\d+ .*keep=1 /);
  });
});
