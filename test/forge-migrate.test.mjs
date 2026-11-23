// scripts/forge-migrate.mjs (docs/PLAN_FORGE_CUTOVER.md C2a/C3). Hermetic: temp dirs only, placeholder paths only.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWLIST, backup, buildPathMap, main, migrate, parseArgs, rewriteJsonText, rewriteJsonlText, rewriteText, unpushedReport,
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
    assert.deepEqual(parseArgs(["--from=a", "--dry-run", "--to", "b"]), { dryRun: true, force: false, json: false, unpushedReport: false, help: false, from: "a", to: "b" });
  });

  test("the script never deletes: no delete calls in its source, source hash unchanged after every mode", () => {
    const code = readFileSync(SCRIPT, "utf8");
    assert.doesNotMatch(code, /\b(unlink|unlinkSync|rmSync|rmdirSync|rmdir|rm|removeSync)\s*\(/);
    assert.doesNotMatch(code, /\b(prune|fetch|gc|clean|reset)\b"/);
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

describe("unpushed report", () => {
  const g = (args, cwd) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe", windowsHide: true }).toString();

  test("lists worktrees with unpushed commits or dirty trees, read-only", () => {
    const base = tmp("git");
    const origin = join(base, "origin.git");
    const repo = join(base, "Demo");
    const sanctuary = join(base, "worktrees");
    execFileSync("git", ["init", "-q", "--bare", "-b", "master", origin], { windowsHide: true });
    execFileSync("git", ["init", "-q", "-b", "master", repo], { windowsHide: true });
    g(["commit", "-q", "--allow-empty", "-m", "init"], repo);
    g(["remote", "add", "origin", origin], repo);
    g(["push", "-q", "origin", "master"], repo);
    for (const unit of ["pushed", "ahead", "dirty"]) g(["worktree", "add", "-q", "-b", `unit-${unit}`, join(sanctuary, "Demo", unit), "master"], repo);
    g(["commit", "-q", "--allow-empty", "-m", "local only"], join(sanctuary, "Demo", "ahead"));
    writeFileSync(join(sanctuary, "Demo", "dirty", "new.txt"), "x");
    mkdirSync(join(sanctuary, "Demo", "not-a-worktree"), { recursive: true });
    const hash = treeHash(base);

    const s = unpushedReport({ sanctuary });
    assert.equal(treeHash(base), hash, "report wrote to the repo or worktrees");
    assert.equal(s.worktrees, 3);
    assert.equal(s.unpushed, 1);
    assert.equal(s.dirty, 1);
    assert.equal(s.clean, 1);
    assert.equal(s.safeToDelete, false);
    const by = Object.fromEntries(s.items.map((i) => [i.path, i]));
    assert.deepEqual([by["Demo/ahead"].branch, by["Demo/ahead"].ahead, by["Demo/ahead"].dirty], ["unit-ahead", 1, 0]);
    assert.deepEqual([by["Demo/dirty"].ahead, by["Demo/dirty"].dirty], [0, 1]);

    const out = quiet();
    assert.equal(main(["--unpushed-report", "--sanctuary", sanctuary], out.log, out.err), 0);
    const last = JSON.parse(out.lines.at(-1));
    assert.deepEqual([last.worktrees, last.unpushed, last.dirty, last.clean], [3, 1, 1, 1]);
    assert.match(out.lines.join("\n"), /unit-ahead\s+Demo\/ahead/);
    assert.equal(treeHash(base), hash);
  });
});
