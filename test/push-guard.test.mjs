// idea-452 shared-master push guard: server/push-guard.mjs + .githooks/pre-push.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { findLaneInRegistry } from "../server/identity.mjs";
import { STANDING_RULES } from "../server/lessons.mjs";
import { activeDefaultHooks, checkHead, checkPush, evaluatePush, formatRefusal, installHooks, parseIncludes, parseLaneTag, parsePrePushLines } from "../server/push-guard.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const HOOKS = join(ROOT, ".githooks").replace(/\\/g, "/");
const TEAMS = [
  {
    id: "squad-a",
    name: "Squad A",
    lanes: [
      { id: "squad-a", name: "Squad A", hub: true, code: "Hub" },
      { id: "lane-alpha", name: "Alpha Lane", code: "Alp", aliases: ["alpha-old"] },
      { id: "lane-beta", name: "Beta Lane", code: "Bet" },
    ],
  },
];
const registry = { teams: TEAMS, findLane: findLaneInRegistry };
const SHA = (c) => c.repeat(40);

describe("push-guard: evaluatePush (pure)", () => {
  test("parseLaneTag reads the first (@<lane> handle; none -> null", () => {
    assert.equal(parseLaneTag("Merge branch 'unit-x': fix (@alp idea-1; Review PASS 0/0/0 abc1234)"), "alp");
    assert.equal(parseLaneTag("Merge branch 'unit-y': thing (@lane-beta; lead Bet3)"), "lane-beta");
    assert.equal(parseLaneTag("Merge branch 'unit-z': no tag, mentions @alp outside parens"), null);
    assert.equal(parseLaneTag("Merge branch 'unit-z'"), null);
  });

  test("parseIncludes keeps 7-40 hex prefixes from env and git -c values", () => {
    assert.deepEqual(parseIncludes("AbCdEf1,  1234567890", ["deadbee", "nothex!", "abc"]), ["abcdef1", "1234567890", "deadbee"]);
  });

  test("own lane (code or id tag) passes; hub lane resolves by its handle", () => {
    const r = evaluatePush({
      merges: [
        { sha: SHA("a"), subject: "Merge branch 'u1': x (@alp idea-1)" },
        { sha: SHA("b"), subject: "Merge branch 'u2': y (@lane-alpha; z)" },
      ],
      pusherLane: "lane-alpha",
      pusherTeam: "squad-a",
      ...registry,
    });
    assert.equal(r.ok, true);
    assert.equal(r.own.length, 2);
    const hub = evaluatePush({ merges: [{ sha: SHA("c"), subject: "Merge x (@hub idea-2)" }], pusherLane: "squad-a", ...registry });
    assert.equal(hub.ok, true);
  });

  test("another lane's merge is refused with the ask-its-lead message and the include override", () => {
    const r = evaluatePush({
      merges: [
        { sha: SHA("a"), subject: "Merge branch 'mine': (@alp idea-1)" },
        { sha: SHA("b"), subject: "Merge branch 'theirs': (@bet idea-2)" },
      ],
      pusherLane: "@alp",
      ...registry,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.refused.map((x) => [x.sha.slice(0, 8), x.reason, x.lane]), [["bbbbbbbb", "other-lane", "lane-beta"]]);
    const msg = formatRefusal(r);
    assert.match(msg, /ask that lane's lead \(vs who lead --lane lane-beta\)/);
    assert.match(msg, /never push it for them/);
    assert.match(msg, /git -c vs\.pushInclude=bbbbbbbb push/);
  });

  test("include override admits exactly the named sha", () => {
    const merges = [
      { sha: SHA("b"), subject: "Merge 'theirs' (@bet x)" },
      { sha: SHA("c"), subject: "Merge 'other' (@bet y)" },
    ];
    const r = evaluatePush({ merges, pusherLane: "lane-alpha", includes: ["bbbbbbb"], ...registry });
    assert.equal(r.ok, false);
    assert.deepEqual(r.included.map((x) => x.sha[0]), ["b"]);
    assert.deepEqual(r.refused.map((x) => x.sha[0]), ["c"]);
    assert.equal(evaluatePush({ merges, pusherLane: "lane-alpha", includes: ["bbbbbbb", "ccccccc"], ...registry }).ok, true);
  });

  test("a merge with no lane tag fails closed", () => {
    const r = evaluatePush({ merges: [{ sha: SHA("d"), subject: "Merge branch 'unit-untagged'" }], pusherLane: "lane-alpha", ...registry });
    assert.equal(r.ok, false);
    assert.equal(r.refused[0].reason, "untagged");
    assert.match(formatRefusal(r), /no \(@<lane> tag/);
  });

  test("an unknown tag never matches the pusher (fails closed as another lane)", () => {
    const r = evaluatePush({ merges: [{ sha: SHA("e"), subject: "Merge x (@nosuch y)" }], pusherLane: "lane-alpha", ...registry });
    assert.equal(r.ok, false);
    assert.equal(r.refused[0].reason, "other-lane");
  });

  test("unknown pusher identity fails closed, even for tagged merges, unless each sha is included", () => {
    const merges = [{ sha: SHA("a"), subject: "Merge (@alp x)" }];
    const r = evaluatePush({ merges, pusherLane: "", ...registry });
    assert.equal(r.ok, false);
    assert.equal(r.refused[0].reason, "unknown-pusher");
    const msg = formatRefusal(r);
    assert.match(msg, /pushing lane is unknown/);
    assert.match(msg, /git -c vs\.pushLane=<lane> push/);
    assert.equal(evaluatePush({ merges, pusherLane: "", includes: ["aaaaaaa"], ...registry }).ok, true);
  });

  test("only master/main updates are guarded; unit branches, tags and deletes pass", async () => {
    const fail = () => {
      throw new Error("git must not run for unguarded refs");
    };
    const updates = parsePrePushLines(
      [`refs/heads/unit-x ${SHA("a")} refs/heads/unit-x ${SHA("0")}`, `refs/tags/beta ${SHA("b")} refs/tags/beta ${SHA("c")}`, `(delete) ${SHA("0")} refs/heads/master ${SHA("c")}`].join("\n"),
    );
    assert.equal(updates.length, 3);
    const res = await checkPush({ updates, env: {}, git: fail, registry });
    assert.equal(res.ok, true);
  });

  test("a remote tip git cannot walk (not fetched) fails closed and says to fetch", async () => {
    const git = (args) => {
      if (args[0] === "log") throw new Error("fatal: bad revision");
      throw new Error("no config");
    };
    const res = await checkPush({ updates: [{ localRef: "refs/heads/master", localSha: SHA("a"), remoteRef: "refs/heads/master", remoteSha: SHA("f") }], env: { VS_LANE: "lane-alpha" }, git, registry });
    assert.equal(res.ok, false);
    assert.match(res.message, /git fetch origin/);
  });

  test("the standing rule is present and fits the 300-char budget", () => {
    const rule = STANDING_RULES.find((r) => r.startsWith("Before pushing master"));
    assert.ok(rule, "push rule missing");
    assert.ok(rule.length <= 300, `${rule.length} chars`);
    assert.match(rule, /git log origin\/master\.\.HEAD/);
    assert.match(rule, /never push it for them/);
  });
});

// ---- real git: a bare origin, a clone whose core.hooksPath is this checkout's .githooks, and real `git push`.
const tmp = mkdtempSync(join(tmpdir(), "vs-push-guard-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const teamsFile = join(tmp, "teams.json");
writeFileSync(teamsFile, JSON.stringify({ teams: TEAMS }), "utf8");

// One read-only seed repo (base commit), built once. Each test clones it into its own private bare origin + work repo,
// instead of re-initing + configuring + committing + pushing per test. The origin is per-test because tests push merges to it.
const SEED = join(tmp, "seed");
before(() => {
  ok(tmp, ["init", "-q", "--template=", "-b", "master", SEED]);
  writeFileSync(join(SEED, "a.txt"), "base\n");
  ok(SEED, ["add", "a.txt"]);
  ok(SEED, ["commit", "-q", "-m", "base"]);
});

function baseEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(VS_|GIT_|PASEO_)/.test(k)) env[k] = v;
  return {
    ...env,
    VIBESQUAD_HOME: join(tmp, "home"),
    VIBESQUAD_TEAMS_FILE: teamsFile,
    // git identity + gpgsign/autocrlf via env, so `git commit` needs no per-repo `git config` (and no extra spawns).
    GIT_AUTHOR_NAME: "Test Agent",
    GIT_AUTHOR_EMAIL: "agent@example.invalid",
    GIT_COMMITTER_NAME: "Test Agent",
    GIT_COMMITTER_EMAIL: "agent@example.invalid",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.autocrlf",
    GIT_CONFIG_VALUE_1: "false",
    ...extra,
  };
}
function run(cwd, args, env = baseEnv()) {
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function ok(cwd, args, env) {
  const r = run(cwd, args, env);
  assert.equal(r.code, 0, `git ${args.join(" ")}\n${r.err}`);
  return r.out.trim();
}

let n = 0;
function freshRepo({ push = true, dev = false, hooks = true } = {}) {
  const dir = join(tmp, `r${++n}`);
  const work = join(dir, "work");
  mkdirSync(dir, { recursive: true });
  const origin = join(dir, "origin.git");
  if (push) {
    // A private bare origin per test (clone of the seed): tests push merges to it, so it must not be shared.
    ok(dir, ["clone", "-q", "--bare", "--template=", SEED, origin]);
    ok(dir, ["clone", "-q", "--template=", origin, work]);
  } else {
    // A fresh empty origin (no master yet) so the push reads an all-zero remote sha.
    ok(dir, ["init", "-q", "--bare", "--template=", "-b", "master", origin]);
    ok(dir, ["clone", "-q", "--template=", SEED, work]);
    ok(work, ["remote", "set-url", "origin", origin]);
    // The clone's origin/* refs track SEED, not this empty origin: drop them so the repo has no stale remote-tracking state.
    ok(work, ["update-ref", "-d", "refs/remotes/origin/master"]);
    ok(work, ["remote", "set-head", "origin", "-d"]);
  }
  if (hooks) ok(work, ["config", "core.hooksPath", HOOKS]);
  let devRemote = null;
  if (dev) {
    devRemote = join(dir, "dev.git");
    ok(dir, ["init", "-q", "--bare", "--template=", "-b", "master", devRemote]);
    ok(work, ["remote", "add", "dev", devRemote]);
    ok(work, ["push", "-q", "dev", "master"]); // base only, no merges: passes even with no identity
  }
  return { work, origin, dev: devRemote };
}
function merge(work, branch, subject, { inner = false } = {}) {
  ok(work, ["checkout", "-q", "-b", branch, "master"]);
  writeFileSync(join(work, `${branch}.txt`), `${branch}\n`);
  ok(work, ["add", "."]);
  ok(work, ["commit", "-q", "-m", `work on ${branch}`]);
  if (inner) ok(work, ["merge", "-q", "--no-ff", "-m", `Merge master into ${branch}`, "master"]);
  ok(work, ["checkout", "-q", "master"]);
  ok(work, ["merge", "-q", "--no-ff", "-m", subject, branch]);
  return ok(work, ["rev-parse", "HEAD"]);
}
const remoteTip = (origin) => ok(origin, ["rev-parse", "master"]);
const lane = (l) => baseEnv({ VS_LANE: l, VS_TEAM: "squad-a" });

describe("push-guard: pre-push hook on a real push", () => {
  test("own-lane merge pushes", () => {
    const { work, origin } = freshRepo();
    const tip = merge(work, "unit-mine", "Merge branch 'unit-mine': fix (@alp idea-1)", { inner: true });
    const r = run(work, ["push", "origin", "master"], lane("lane-alpha"));
    assert.equal(r.code, 0, r.err);
    assert.equal(remoteTip(origin), tip);
    assert.match(r.err, /own\s+\w{8} Merge branch 'unit-mine'/);
  });

  test("another lane's unpushed merge under your own is refused; origin unchanged", () => {
    const { work, origin } = freshRepo();
    const before = remoteTip(origin);
    const theirs = merge(work, "unit-theirs", "Merge branch 'unit-theirs': x (@bet idea-2)");
    merge(work, "unit-mine", "Merge branch 'unit-mine': y (@alp idea-3)");
    const r = run(work, ["push", "origin", "master"], lane("lane-alpha"));
    assert.notEqual(r.code, 0);
    assert.match(r.err, /refusing to push refs\/heads\/master/);
    assert.match(r.err, new RegExp(`${theirs.slice(0, 8)} Merge branch 'unit-theirs'`));
    assert.match(r.err, /never push it for them/);
    assert.equal(remoteTip(origin), before);
  });

  test("include override (git -c vs.pushInclude, or VS_PUSH_INCLUDE) admits that merge only", () => {
    const { work, origin } = freshRepo();
    const theirs = merge(work, "unit-theirs", "Merge branch 'unit-theirs': x (@bet idea-2)");
    const mine = merge(work, "unit-mine", "Merge branch 'unit-mine': y (@alp idea-3)");
    const r = run(work, ["-c", `vs.pushInclude=${theirs.slice(0, 8)}`, "push", "origin", "master"], lane("lane-alpha"));
    assert.equal(r.code, 0, r.err);
    assert.equal(remoteTip(origin), mine);
    const third = merge(work, "unit-third", "Merge branch 'unit-third': z (@bet idea-4)");
    assert.notEqual(run(work, ["push", "origin", "master"], lane("lane-alpha")).code, 0);
    const env = run(work, ["push", "origin", "master"], baseEnv({ VS_LANE: "lane-alpha", VS_PUSH_INCLUDE: third.slice(0, 7) }));
    assert.equal(env.code, 0, env.err);
    assert.equal(remoteTip(origin), third);
  });

  test("a merge with no lane tag is refused (fail closed)", () => {
    const { work, origin } = freshRepo();
    const before = remoteTip(origin);
    merge(work, "unit-untagged", "Merge branch 'unit-untagged'");
    const r = run(work, ["push", "origin", "master"], lane("lane-alpha"));
    assert.notEqual(r.code, 0);
    assert.match(r.err, /no \(@<lane> tag/);
    assert.match(r.err, /vs\.pushInclude=/);
    assert.equal(remoteTip(origin), before);
  });

  test("unknown pusher identity is refused with how to override; vs.pushLane names it", () => {
    const { work, origin } = freshRepo();
    const before = remoteTip(origin);
    const tip = merge(work, "unit-mine", "Merge branch 'unit-mine': y (@alp idea-3)");
    const r = run(work, ["push", "origin", "master"], baseEnv());
    assert.notEqual(r.code, 0);
    assert.match(r.err, /pushing lane is unknown/);
    assert.match(r.err, /git -c vs\.pushLane=<lane> push/);
    assert.equal(remoteTip(origin), before);
    const named = run(work, ["-c", "vs.pushLane=alp", "push", "origin", "master"], baseEnv());
    assert.equal(named.code, 0, named.err);
    assert.equal(remoteTip(origin), tip);
  });

  test("a unit branch push and a tag push are never guarded", () => {
    const { work, origin } = freshRepo();
    merge(work, "unit-theirs", "Merge branch 'unit-theirs': x (@bet idea-2)");
    ok(work, ["checkout", "-q", "-b", "unit-carrier", "master"]);
    assert.equal(run(work, ["push", "origin", "unit-carrier"], lane("lane-alpha")).code, 0);
    ok(work, ["tag", "beta"]);
    assert.equal(run(work, ["push", "-f", "origin", "refs/tags/beta"], baseEnv()).code, 0);
    assert.equal(ok(origin, ["rev-parse", "unit-carrier"]), ok(work, ["rev-parse", "HEAD"]));
  });

  test("checkHead (vs push-guard check) reads origin/master..HEAD the same way", async () => {
    const { work } = freshRepo();
    ok(work, ["fetch", "-q", "origin"]);
    merge(work, "unit-theirs", "Merge branch 'unit-theirs': x (@bet idea-2)");
    const res = await checkHead({ cwd: work, env: { VS_LANE: "lane-alpha" }, registry });
    assert.equal(res.ok, false);
    assert.equal(res.results[0].result.refused[0].reason, "other-lane");
    const mine = await checkHead({ cwd: work, env: { VS_LANE: "lane-beta" }, registry });
    assert.equal(mine.ok, true);
  });

  test("dev mirror: master that origin already has pushes to a lagging dev; an unpushed foreign merge does not", () => {
    const { work, origin, dev } = freshRepo({ dev: true });
    // Lane beta's merge lands on origin (pushed by beta); dev now lags origin by that @bet merge.
    const theirs = merge(work, "unit-theirs", "Merge branch 'unit-theirs': x (@bet idea-2)");
    assert.equal(run(work, ["push", "origin", "master"], lane("lane-beta")).code, 0);
    assert.equal(remoteTip(origin), theirs);
    const mirror = run(work, ["push", "dev", "master"], lane("lane-alpha"));
    assert.equal(mirror.code, 0, mirror.err);
    assert.equal(remoteTip(dev), theirs);
    // A second @bet merge not on origin yet: refused for dev too (compared against origin/master).
    const unpushed = merge(work, "unit-theirs-2", "Merge branch 'unit-theirs-2': y (@bet idea-5)");
    const r = run(work, ["push", "dev", "master"], lane("lane-alpha"));
    assert.notEqual(r.code, 0);
    assert.match(r.err, new RegExp(unpushed.slice(0, 8)));
    assert.doesNotMatch(r.err, new RegExp(theirs.slice(0, 8)));
    assert.equal(remoteTip(dev), theirs);
    // Pushing to origin by URL instead of by name is still the shared remote.
    const byUrl = run(work, ["push", origin, "master"], lane("lane-alpha"));
    assert.notEqual(byUrl.code, 0);
    assert.match(byUrl.err, /refusing to push refs\/heads\/master/);
  });

  test("new remote branch (all-zero remote sha) carrying merges is checked like any other push", () => {
    const { work, origin } = freshRepo({ push: false });
    const theirs = merge(work, "unit-theirs", "Merge branch 'unit-theirs': x (@bet idea-2)");
    const r = run(work, ["push", "origin", "master"], lane("lane-alpha"));
    assert.notEqual(r.code, 0);
    assert.match(r.err, new RegExp(`${theirs.slice(0, 8)} Merge branch 'unit-theirs'`));
    assert.notEqual(run(origin, ["rev-parse", "--verify", "--quiet", "master"]).code, 0);
    const own = run(work, ["push", "origin", "master"], lane("lane-beta"));
    assert.equal(own.code, 0, own.err);
    assert.equal(remoteTip(origin), theirs);
  });

  test("non-fast-forward force push of master checks <old remote tip>..<new tip>", () => {
    const { work, origin } = freshRepo();
    const first = merge(work, "unit-first", "Merge branch 'unit-first': x (@alp idea-1)");
    assert.equal(run(work, ["push", "origin", "master"], lane("lane-alpha")).code, 0);
    ok(work, ["reset", "-q", "--hard", "HEAD~1"]);
    merge(work, "unit-theirs", "Merge branch 'unit-theirs': y (@bet idea-2)");
    const r = run(work, ["push", "-f", "origin", "master"], lane("lane-alpha"));
    assert.notEqual(r.code, 0);
    assert.match(r.err, /unit-theirs/);
    assert.equal(remoteTip(origin), first);
    ok(work, ["reset", "-q", "--hard", "HEAD~1"]);
    const mine = merge(work, "unit-redo", "Merge branch 'unit-redo': z (@alp idea-3)");
    const f = run(work, ["push", "-f", "origin", "master"], lane("lane-alpha"));
    assert.equal(f.code, 0, f.err);
    assert.equal(remoteTip(origin), mine);
  });
});

describe("push-guard: aliases, install and the vs verb", () => {
  test("a lane alias in the tag resolves to the pusher's lane", () => {
    const r = evaluatePush({ merges: [{ sha: SHA("a"), subject: "Merge 'u' (@alpha-old idea-1)" }], pusherLane: "lane-alpha", ...registry });
    assert.equal(r.ok, true);
    assert.equal(r.own[0].lane, "lane-alpha");
  });

  test("installHooks sets core.hooksPath once, refuses to replace another hooksPath without force", () => {
    const { work } = freshRepo({ push: false, hooks: false });
    assert.deepEqual(installHooks({ cwd: work }), { changed: true, hooksPath: ".githooks", previous: "" });
    assert.equal(ok(work, ["config", "core.hooksPath"]), ".githooks");
    assert.equal(installHooks({ cwd: work }).changed, false);
    ok(work, ["config", "core.hooksPath", "other-hooks"]);
    assert.throws(() => installHooks({ cwd: work }), /already other-hooks; pass --force/);
    assert.equal(installHooks({ cwd: work, force: true }).previous, "other-hooks");
  });

  test("installHooks refuses when active .git/hooks would be silenced, unless forced", () => {
    const { work } = freshRepo({ push: false, hooks: false });
    mkdirSync(join(work, ".git", "hooks"), { recursive: true }); // a --template= clone has no hooks dir
    writeFileSync(join(work, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
    assert.deepEqual(activeDefaultHooks({ cwd: work }), ["pre-commit"]);
    assert.throws(() => installHooks({ cwd: work }), /active hooks in \.git\/hooks would stop running.*pre-commit/);
    assert.notEqual(run(work, ["config", "core.hooksPath"]).code, 0);
    assert.equal(installHooks({ cwd: work, force: true }).changed, true);
  });

  test("vs push-guard check prints the own/included summary on OK and the refusal otherwise; install works", async () => {
    process.env.VIBESQUAD_HOME ??= join(tmp, "home");
    process.env.VIBESQUAD_TEAMS_FILE = teamsFile;
    const { commandPushGuard } = await import("../cli/vs.mjs");
    const { work } = freshRepo();
    ok(work, ["fetch", "-q", "origin"]);
    merge(work, "unit-mine", "Merge branch 'unit-mine': y (@alp idea-3)");
    const theirs = merge(work, "unit-theirs", "Merge branch 'unit-theirs': x (@bet idea-2)");
    writeFileSync(join(work, "notes.md"), "direct\n");
    ok(work, ["add", "notes.md"]);
    ok(work, ["commit", "-q", "-m", "docs: direct commit on master"]);
    let text = "";
    const out = (s) => (text += s);
    const refused = await commandPushGuard({ _: ["check"] }, { cwd: work, env: { VS_LANE: "lane-alpha" }, out, registry });
    assert.equal(refused, 1);
    assert.match(text, /refusing to push/);
    text = "";
    const passed = await commandPushGuard({ _: ["check"] }, { cwd: work, env: { VS_LANE: "lane-alpha", VS_PUSH_INCLUDE: theirs.slice(0, 8) }, out, registry });
    assert.equal(passed, 0);
    assert.match(text, /OK to push HEAD to origin\/master/);
    assert.match(text, /own\s+\w{8} Merge branch 'unit-mine'/);
    assert.match(text, /included\s+\w{8} Merge branch 'unit-theirs'/);
    assert.match(text, /direct \(non-merge\) commit/);
    const bare = freshRepo({ push: false, hooks: false });
    text = "";
    assert.equal(await commandPushGuard({ _: ["install"] }, { cwd: bare.work, out }), 0);
    assert.match(text, /core\.hooksPath=\.githooks/);
  });
});
