// idea-452 shared-master push guard: server/push-guard.mjs + .githooks/pre-push; idea-883 verdict gate (+ pre-merge-commit, pre-commit).
import "./setup/hermetic.mjs"; // hermetic env for a direct `node --test <file>` run (run-tests.mjs preloads this)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { findLaneInRegistry } from "../server/identity.mjs";
import { STANDING_RULES } from "../server/lessons.mjs";
import { activeDefaultHooks, checkHead, checkPush, evaluatePush, formatRefusal, installHooks, parseIncludes, parseLaneTag, parsePrePushLines, readRecordedVerdicts, readRunnerVerdicts, recordedVerdicts, repoSquads, verdictHome, verdictWriterAttested } from "../server/push-guard.mjs";
import { recordServerStart } from "../server/sync-runtime.mjs";
import { attestedVerdict, entryVerdict, evaluateMergeVerdicts, formatVerdictRefusal, isUnitMergeSubject, latestRecordedVerdict, newestVerdict, runnerRecordVerdict, VERDICT_WRITER_CAPABILITY } from "../server/verdict.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const HOOKS = join(ROOT, ".githooks").replace(/\\/g, "/");
const TEAMS = [
  {
    id: "squad-a",
    name: "Squad A",
    paths: ["work"], // idea-883: owns every test repo (<tmp>/r<n>/work), so the verdict gate reads squad-a's log
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
// idea-883: a unit merge needs a recorded verdict on its tip: a reviewer digest's `done` entry in the (temp) VS home team log.
const HOME = join(tmp, "home");
const HOME_LOG = join(HOME, "teams", "squad-a", "log.jsonl");
// idea-941: attest that the server in `home` writes the `verdict` field on `done` entries (as recordServerStart does at boot).
function attestServer(home, { capabilities = [VERDICT_WRITER_CAPABILITY], startedAt = "2026-11-25T05:00:00.000Z" } = {}) {
  mkdirSync(home, { recursive: true });
  const file = `server-start-${startedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(join(home, file), JSON.stringify({ startedAt, commit: "abc1234", ok: true, dryRun: false, source: "server-start", ...(capabilities ? { capabilities } : {}) }));
}
attestServer(HOME);
// A digest of a reviewer carries the server-attested `verdict` field (vibesquad-api digestLogRecord); `attested: false` writes
// the same text without it (what any agent's own `done` could say).
function recordVerdict(text, { ts = new Date().toISOString(), type = "done", attested = true, squad = "squad-a", home = HOME } = {}) {
  mkdirSync(join(home, "teams", squad), { recursive: true });
  const line = text.split(" reviewer=")[0];
  const verdict = attested ? { verdict: { reviewer: "rv-1", profile: "Review - Gemini", line } } : {};
  appendFileSync(join(home, "teams", squad, "log.jsonl"), `${JSON.stringify({ ts, agent: "dg-1", lane: "lane-alpha", type, text, refs: ["rv-1"], ...verdict })}\n`);
}
/** Commit on a new `branch` off master; records `verdict` ("PASS" / "FAIL" / null = none) on its tip. Returns the tip. */
function unitBranch(work, branch, { inner = false, verdict = "PASS" } = {}) {
  ok(work, ["checkout", "-q", "-b", branch, "master"]);
  writeFileSync(join(work, `${branch}.txt`), `${branch}\n`);
  ok(work, ["add", "."]);
  ok(work, ["commit", "-q", "-m", `work on ${branch}`]);
  if (inner) ok(work, ["merge", "-q", "--no-ff", "-m", `Merge master into ${branch}`, "master"]);
  const tip = ok(work, ["rev-parse", "HEAD"]);
  if (verdict) recordVerdict(`${verdict} ${verdict === "PASS" ? "0/0/1" : "1/0/0"} ${tip.slice(0, 10)} reviewer=Review - Gemini: ok`);
  ok(work, ["checkout", "-q", "master"]);
  return tip;
}
function merge(work, branch, subject, opts = {}) {
  unitBranch(work, branch, opts);
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
    // idea-883: the unit merge's recorded PASS lives in the test's VS home (join(tmp, "home")), not the runner's VIBESQUAD_HOME.
    const res = await checkHead({ cwd: work, env: { VS_LANE: "lane-alpha", VIBESQUAD_HOME: HOME }, registry });
    assert.equal(res.ok, false);
    assert.equal(res.results[0].result.refused[0].reason, "other-lane");
    const mine = await checkHead({ cwd: work, env: { VS_LANE: "lane-beta", VIBESQUAD_HOME: HOME }, registry });
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
    const refused = await commandPushGuard({ _: ["check"] }, { cwd: work, env: { VS_LANE: "lane-alpha", VIBESQUAD_HOME: HOME }, out, registry });
    assert.equal(refused, 1);
    assert.match(text, /refusing to push/);
    text = "";
    const passed = await commandPushGuard({ _: ["check"] }, { cwd: work, env: { VS_LANE: "lane-alpha", VS_PUSH_INCLUDE: theirs.slice(0, 8), VIBESQUAD_HOME: HOME }, out, registry });
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

// ---- idea-883 recorded-verdict gate: pre-merge-commit / pre-commit / pre-push refuse unit merges whose tip has no recorded PASS.
const T40 = "4c288c19" + "a".repeat(32);
/** A digest `done` entry; attested (the default) carries the server's `verdict` field with the reviewer's own line. */
const done = (text, ts = "2026-11-24T10:00:00.000Z", type = "done", attested = true) => {
  const line = (text.split("\n").find((l) => /^(?:UNVERIFIED[^:]*:\s*)?(?:PASS|FAIL) /.test(l)) ?? "").replace(/^UNVERIFIED[^:]*:\s*/, "").split(" reviewer=")[0];
  return { ts, agent: "dg-1", type, text, ...(attested && line ? { verdict: { reviewer: "rv-1", profile: "Review - Gemini", line } } : {}) };
};

describe("push-guard: idea-883 verdict gate (pure)", () => {
  test("isUnitMergeSubject: lead subjects and git's defaults for unit branches; never master merges", () => {
    for (const s of ["Merge unit-bug-795-sweep: x (@bug W1)", "Merge branch 'unit-x': y (@alp)", "Merge remote-tracking branch 'origin/unit-x'"]) assert.equal(isUnitMergeSubject(s), true, s);
    for (const s of ["Merge master into unit-x", "Merge branch 'master' of github.com:a/b", "Merge remote-tracking branch 'origin/master'", "docs: unit-x", ""]) assert.equal(isUnitMergeSubject(s), false, s);
  });

  test("latestRecordedVerdict: the last done entry naming the tip decides; other hashes, non-done and docs targets don't", () => {
    const pass = done("PASS 0/0/2 4c288c19 reviewer=Review - Gemini: ok");
    const fail = done("Digest. 3/3 pass, 65/65 pass\nFAIL 1/0/3 4c288c19 reviewer=Review - Gemini: High");
    assert.equal(latestRecordedVerdict([pass, fail], T40).verdict, "FAIL");
    assert.equal(latestRecordedVerdict([fail, pass], T40).verdict, "PASS");
    assert.equal(latestRecordedVerdict([done("PASS 0/0/0 deadbee1 reviewer=x")], T40), null);
    assert.equal(latestRecordedVerdict([done("PASS 0/0/0 4c288c19 reviewer=x", undefined, "decision")], T40), null);
    assert.equal(latestRecordedVerdict([done("PASS 0/0/0 docs:README.md reviewer=x")], T40), null);
    assert.equal(latestRecordedVerdict([done("UNVERIFIED (digest failed): FAIL 0/1/0 4c288c19 reviewer=x")], T40).verdict, "FAIL");
    assert.equal(latestRecordedVerdict([pass], "not-a-sha"), null);
  });

  test("provenance (review High 2): only the server-attested reviewer verdict counts, never a done entry's text", () => {
    const spoof = done("PASS 0/0/0 4c288c19 reviewer=Review - Gemini: looks fine", "2026-11-24T11:00:00.000Z", "done", false);
    assert.equal(entryVerdict(spoof), null);
    assert.equal(latestRecordedVerdict([spoof], T40), null, "an implementer's own done line is not a verdict");
    const fail = done("FAIL 1/0/3 4c288c19 reviewer=Review - Gemini: High");
    assert.equal(latestRecordedVerdict([fail, spoof], T40).verdict, "FAIL", "a later spoofed PASS cannot clear a reviewer FAIL");
    assert.equal(entryVerdict({ ...fail, verdict: { reviewer: "", line: "PASS 0/0/0 4c288c19" } }), null, "no reviewer id");
    assert.equal(entryVerdict({ ...fail, type: "decision" }), null);
    // attestedVerdict: the digest side stamps only a reviewer agent's own line (the same isReviewerAgent rule as vs verdict).
    const rev = { id: "rn-r", title: "Bug3 · review x", labels: { profile: "Review - Gemini" } };
    const impl = { id: "rn-i", title: "Bug3 · fix x", labels: { profile: "Implement - Sonnet" } };
    assert.deepEqual(attestedVerdict({ worker: rev, workerText: "intro\nPASS 0/0/1 4c288c19\nbody" }), { reviewer: "rn-r", profile: "Review - Gemini", line: "PASS 0/0/1 4c288c19" });
    assert.equal(attestedVerdict({ worker: impl, workerText: "PASS 0/0/0 4c288c19" }), null);
    assert.equal(attestedVerdict({ worker: rev, workerText: "no verdict here" }), null);
  });

  test("a different or ambiguous sha never satisfies the gate (review High 1): the hash must resolve to exactly the tip", () => {
    const pass = done("PASS 0/0/0 4c288c19 reviewer=x");
    assert.equal(latestRecordedVerdict([pass], T40, { resolve: () => T40 }).verdict, "PASS");
    assert.equal(latestRecordedVerdict([pass], T40, { resolve: () => "4c288c19" + "b".repeat(32) }), null, "names another commit here");
    assert.equal(latestRecordedVerdict([pass], T40, { resolve: () => "" }), null, "ambiguous or unknown prefix");
    assert.equal(latestRecordedVerdict([{ ...pass, verdict: { reviewer: "rv", line: "PASS 0/0/0 4c288c" } }], T40), null, "under 7 hex never matches");
  });

  test("evaluateMergeVerdicts: PASS passes, FAIL and none refuse, overrides by tip or merge sha, non-unit merges skipped", () => {
    const rec = { [T40]: { verdict: "FAIL", line: "FAIL 1/0/3 4c288c19" }, [SHA("b")]: { verdict: "PASS", line: "PASS 0/0/0 bbbbbbbb" } };
    const merges = [
      { sha: SHA("1"), subject: "Merge unit-a: x (@bug)", tip: T40 },
      { sha: SHA("2"), subject: "Merge unit-b: x (@bug)", tip: SHA("b") },
      { sha: SHA("3"), subject: "Merge unit-c: x (@bug)", tip: SHA("c") },
      { sha: SHA("4"), subject: "Merge remote-tracking branch 'origin/master'", tip: SHA("d") },
    ];
    const r = evaluateMergeVerdicts({ merges, recorded: (t) => rec[t] ?? null });
    assert.equal(r.ok, false);
    assert.deepEqual(r.refused.map((x) => [x.tip.slice(0, 1), x.reason]), [["4", "fail"], ["c", "no-verdict"]]);
    assert.deepEqual(r.passed.map((x) => x.tip), [SHA("b")]);
    const msg = formatVerdictRefusal(r, { action: "merge" });
    assert.match(msg, /refusing to merge/);
    assert.match(msg, /latest recorded verdict is FAIL 1\/0\/3 4c288c19/);
    assert.match(msg, /vs\.verdictOverride=4c288c19,cccccccc/);
    const ov = evaluateMergeVerdicts({ merges, recorded: (t) => rec[t] ?? null, overrides: ["4c288c19", "3333333"] });
    assert.equal(ov.ok, true);
    assert.equal(ov.overridden.length, 2);
  });

  test("readRecordedVerdicts reads only the given Squads' logs; no Squad or no home records nothing", () => {
    const home = join(tmp, "multi-home");
    for (const [team, text, ts] of [["squad-a", "PASS 0/0/0 4c288c19 reviewer=x", "2026-11-24T10:00:00Z"], ["squad-z", "FAIL 0/1/0 4c288c19 reviewer=y", "2026-11-24T09:00:00Z"]]) {
      mkdirSync(join(home, "teams", team), { recursive: true });
      writeFileSync(join(home, "teams", team, "log.jsonl"), `not json 4c288c19\n${JSON.stringify(done(text, ts))}\n`);
    }
    // Only the repo's own Squads are read: squad-z's FAIL (or a PASS) never reaches squad-a's gate, and vice versa.
    assert.equal(readRecordedVerdicts({ tips: [T40], home, squads: ["squad-a"] })(T40).verdict, "PASS");
    assert.equal(readRecordedVerdicts({ tips: [T40], home, squads: ["squad-z"] })(T40).verdict, "FAIL");
    assert.equal(readRecordedVerdicts({ tips: [T40], home, squads: ["squad-a", "squad-z"] })(T40).verdict, "PASS", "newest ts across the repo's Squads");
    assert.equal(readRecordedVerdicts({ tips: [T40], home })(T40), null, "no Squad: nothing recorded (fail closed)");
    assert.equal(readRecordedVerdicts({ tips: [T40], home: join(tmp, "no-such-home"), squads: ["squad-a"] })(T40), null);
    assert.equal(verdictHome({ env: { VIBESQUAD_HOME: home } }), home);
  });
});

describe("push-guard: idea-883 verdict gate on real git", () => {
  const EMPTY_HOME = join(tmp, "empty-home"); // no teams/ and no attestation
  const ATTESTED_EMPTY_HOME = join(tmp, "attested-empty-home"); // attested server, no teams/log at all
  attestServer(ATTESTED_EMPTY_HOME);
  const at = (home, extra = {}) => baseEnv({ VIBESQUAD_HOME: home, ...extra });

  test("git merge of a unit branch into master: PASS merges; FAIL and no verdict are refused, master unchanged", () => {
    const { work } = freshRepo();
    unitBranch(work, "unit-g-pass");
    assert.equal(run(work, ["merge", "-q", "--no-ff", "-m", "Merge unit-g-pass: ok (@alp)", "unit-g-pass"]).code, 0);
    const before = ok(work, ["rev-parse", "HEAD"]);
    const failTip = unitBranch(work, "unit-g-fail", { verdict: "FAIL" });
    const r = run(work, ["merge", "-q", "--no-ff", "-m", "Merge unit-g-fail: x (@alp)", "unit-g-fail"]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /vs verdict gate: refusing to merge/);
    assert.match(r.err, new RegExp(`tip ${failTip.slice(0, 8)}: latest recorded verdict is FAIL 1/0/0`));
    assert.equal(ok(work, ["rev-parse", "HEAD"]), before);
    ok(work, ["merge", "--abort"]);
    unitBranch(work, "unit-g-none", { verdict: null });
    // No -m: git's own `Merge branch 'unit-g-none'` subject is a unit merge too.
    const none = run(work, ["merge", "-q", "--no-ff", "--no-edit", "unit-g-none"]);
    assert.notEqual(none.code, 0);
    assert.match(none.err, /no recorded verdict/);
    ok(work, ["merge", "--abort"]);
  });

  test("a later PASS on the same tip clears an earlier FAIL; override via git -c or VS_VERDICT_OVERRIDE admits a refused tip", () => {
    const { work } = freshRepo();
    const tip = unitBranch(work, "unit-g-refix", { verdict: "FAIL" });
    assert.notEqual(run(work, ["merge", "-q", "--no-ff", "-m", "Merge unit-g-refix: x (@alp)", "unit-g-refix"]).code, 0);
    ok(work, ["merge", "--abort"]);
    recordVerdict(`PASS 0/0/0 ${tip.slice(0, 8)} reviewer=Review - Gemini: re-review`);
    assert.equal(run(work, ["merge", "-q", "--no-ff", "-m", "Merge unit-g-refix: x (@alp)", "unit-g-refix"]).code, 0);
    const t2 = unitBranch(work, "unit-g-ov1", { verdict: "FAIL" });
    assert.equal(run(work, ["-c", `vs.verdictOverride=${t2.slice(0, 8)}`, "merge", "-q", "--no-ff", "-m", "Merge unit-g-ov1: owner override (@alp)", "unit-g-ov1"]).code, 0);
    const t3 = unitBranch(work, "unit-g-ov2", { verdict: null });
    assert.equal(run(work, ["merge", "-q", "--no-ff", "-m", "Merge unit-g-ov2: x (@alp)", "unit-g-ov2"], baseEnv({ VS_VERDICT_OVERRIDE: t3.slice(0, 10) })).code, 0);
  });

  test("never bricks normal work: non-unit merges, merges on unit branches, and git merge origin/master pass with no log at all", () => {
    const { work, origin } = freshRepo();
    // A non-unit branch merged into master (no VS home at all).
    ok(work, ["checkout", "-q", "-b", "feature-x", "master"]);
    writeFileSync(join(work, "f.txt"), "f\n");
    ok(work, ["add", "."]);
    ok(work, ["commit", "-q", "-m", "feature"]);
    ok(work, ["checkout", "-q", "master"]);
    assert.equal(run(work, ["merge", "-q", "--no-ff", "-m", "Merge feature-x", "feature-x"], at(EMPTY_HOME)).code, 0);
    // Master into a unit branch (the usual catch-up) is not a merge into master.
    ok(work, ["checkout", "-q", "-b", "unit-g-catchup", "master~1"]);
    assert.equal(run(work, ["merge", "-q", "--no-ff", "--no-edit", "master"], at(EMPTY_HOME)).code, 0);
    // origin/master moved; a fresh unit branch cut from it points at that tip. `git merge origin/master` still passes.
    const other = join(tmp, `other-${++n}`);
    ok(tmp, ["clone", "-q", "--template=", origin, other]);
    writeFileSync(join(other, "o.txt"), "o\n");
    ok(other, ["add", "."]);
    ok(other, ["commit", "-q", "-m", "someone else's commit"]);
    ok(other, ["push", "-q", "--no-verify", "origin", "master"]);
    ok(work, ["checkout", "-q", "master"]);
    ok(work, ["fetch", "-q", "origin"]);
    ok(work, ["branch", "unit-g-fresh", "origin/master"]);
    assert.equal(run(work, ["merge", "-q", "--no-ff", "--no-edit", "origin/master"], at(EMPTY_HOME)).code, 0);
    // `git pull` (merges FETCH_HEAD) after origin moved again: the fresh unit branch tracks nothing new, so it passes.
    writeFileSync(join(other, "o2.txt"), "o2\n");
    ok(other, ["add", "."]);
    ok(other, ["commit", "-q", "-m", "another commit"]);
    ok(other, ["push", "-q", "--no-verify", "origin", "master"]);
    const pulled = run(work, ["-c", "pull.rebase=false", "pull", "-q", "--no-edit", "origin", "master"], at(EMPTY_HOME));
    assert.equal(pulled.code, 0, pulled.err);
    // An ordinary commit on master runs pre-commit, which exits without node (no MERGE_HEAD).
    writeFileSync(join(work, "n.txt"), "n\n");
    ok(work, ["add", "."]);
    assert.equal(run(work, ["commit", "-q", "-m", "direct"], at(EMPTY_HOME)).code, 0);
  });

  test("a plain commit in a linked worktree (shared core.hooksPath) passes at once; a unit merged by sha or as git merge - is still gated", () => {
    const { work } = freshRepo();
    const wt = join(tmp, `wt-${++n}`);
    ok(work, ["worktree", "add", "-q", "-b", "unit-g-wt", wt, "master"]);
    writeFileSync(join(wt, "w.txt"), "w\n");
    ok(wt, ["add", "."]);
    const t0 = Date.now();
    assert.equal(run(wt, ["commit", "-q", "-m", "worktree commit"], at(EMPTY_HOME)).code, 0);
    assert.ok(Date.now() - t0 < 5000);
    const tip = ok(wt, ["rev-parse", "HEAD"]);
    const bySha = run(work, ["merge", "-q", "--no-ff", "-m", "misc", tip], at(ATTESTED_EMPTY_HOME));
    assert.notEqual(bySha.code, 0);
    assert.match(bySha.err, /Merge unit-g-wt \(merged as \w{8}\)/);
    ok(work, ["merge", "--abort"]);
    unitBranch(work, "unit-g-dash", { verdict: "FAIL" }); // ends on master, so `-` is unit-g-dash
    const dash = run(work, ["merge", "-q", "--no-ff", "--no-edit", "-"]);
    assert.notEqual(dash.code, 0);
    assert.match(dash.err, /Merge unit-g-dash/);
    ok(work, ["merge", "--abort"]);
  });

  test("missing log, another Squad's PASS, an unattested PASS, an unowned repo: each refused (fail closed)", () => {
    const { work } = freshRepo();
    const tip = unitBranch(work, "unit-g-xsquad", { verdict: null });
    const subject = "Merge unit-g-xsquad: x (@alp)";
    const tryMerge = (env) => {
      const r = run(work, ["merge", "-q", "--no-ff", "-m", subject, "unit-g-xsquad"], env);
      if (r.code !== 0) ok(work, ["merge", "--abort"]);
      return r;
    };
    // No log at all (attested server -> fails closed).
    let r = tryMerge(at(ATTESTED_EMPTY_HOME));
    assert.notEqual(r.code, 0);
    assert.match(r.err, /no recorded verdict/);
    // A PASS for this exact tip in another Squad's log (squad-b owns no path of this repo).
    const home = join(tmp, "xsquad-home");
    attestServer(home);
    recordVerdict(`PASS 0/0/1 ${tip.slice(0, 9)} reviewer=Review - Gemini: ok`, { home, squad: "squad-b" });
    r = tryMerge(at(home));
    assert.notEqual(r.code, 0, "another Squad's PASS must not satisfy this repo's gate");
    assert.match(r.err, /verdicts read from Squad log\(s\): squad-a/);
    // The same PASS text in the repo's own Squad log, but not attested (an implementer's own done line).
    recordVerdict(`PASS 0/0/1 ${tip.slice(0, 9)} reviewer=Review - Gemini: ok`, { home, attested: false });
    assert.notEqual(tryMerge(at(home)).code, 0, "an unattested PASS does not count");
    // A repo no Squad owns: refused, and says why.
    const noPaths = join(tmp, "teams-nopaths.json");
    writeFileSync(noPaths, JSON.stringify({ teams: TEAMS.map(({ paths, ...t }) => t) }), "utf8");
    recordVerdict(`PASS 0/0/1 ${tip.slice(0, 9)} reviewer=Review - Gemini: ok`, { home });
    r = tryMerge(at(home, { VIBESQUAD_TEAMS_FILE: noPaths }));
    assert.notEqual(r.code, 0);
    assert.match(r.err, /matches no Squad's paths in teams\.json/);
    // The repo's own Squad, attested: merges.
    assert.equal(tryMerge(at(home)).code, 0);
  });

  test("repoSquads: Squads whose paths (or a lane's) match the main checkout by whole segments; a linked worktree maps to it", async () => {
    const { work } = freshRepo();
    const teams = [
      { id: "own", paths: ["work"], lanes: [{ id: "l1" }, { id: "l2" }] },
      { id: "by-lane", lanes: [{ id: "x", paths: [work] }] },
      { id: "partial", paths: ["wor"], lanes: [] },
      { id: "none", lanes: [] },
    ];
    assert.deepEqual(await repoSquads({ cwd: work, teams }), ["own", "by-lane"]);
    const wt = join(tmp, `wt-${++n}`);
    ok(work, ["worktree", "add", "-q", "-b", "unit-g-rs", wt, "master"]);
    assert.deepEqual(await repoSquads({ cwd: wt, teams }), ["own", "by-lane"]);
    assert.deepEqual(await repoSquads({ cwd: tmp, teams }), [], "not a repo");
  });

  test("an override prints a notice and logs a decision entry on merge and on push (review Medium 1)", () => {
    const { work, origin } = freshRepo();
    const home = join(tmp, "ov-home");
    const tip = unitBranch(work, "unit-g-ovlog", { verdict: null });
    const env = at(home, { VS_LANE: "lane-alpha", VS_TEAM: "squad-a", VS_AGENT_ID: "rn-lead1" });
    const m = run(work, ["-c", `vs.verdictOverride=${tip.slice(0, 8)}`, "merge", "-q", "--no-ff", "-m", "Merge unit-g-ovlog: docs only (@alp; lead-checked)", "unit-g-ovlog"], env);
    assert.equal(m.code, 0, m.err);
    assert.match(m.err, /vs verdict gate: OVERRIDE on merge \(logged to Squad log\(s\) squad-a\)/);
    const p = run(work, ["-c", `vs.verdictOverride=${tip.slice(0, 8)}`, "push", "origin", "master"], env);
    assert.equal(p.code, 0, p.err);
    assert.match(p.err, /OVERRIDE on push \(logged/);
    assert.equal(remoteTip(origin), ok(work, ["rev-parse", "HEAD"]));
    const entries = readFileSync(join(home, "teams", "squad-a", "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const ov = entries.filter((e) => e.type === "decision" && /verdict override/.test(e.text));
    assert.deepEqual(ov.map((e) => e.text.match(/\((merge|push)\)/)[1]), ["merge", "push"]);
    assert.ok(ov.every((e) => e.agent === "rn-lead1" && e.refs[0] === tip && e.text.includes(tip.slice(0, 8))));
    assert.equal(entryVerdict(ov[0]), null, "an override entry is never a verdict");
    // Unowned repo: the override still works, and the notice says it was NOT logged.
    const noPaths = join(tmp, "teams-nopaths.json");
    const t2 = unitBranch(work, "unit-g-ovlog2", { verdict: null });
    const m2 = run(work, ["-c", `vs.verdictOverride=${t2.slice(0, 8)}`, "merge", "-q", "--no-ff", "-m", "Merge unit-g-ovlog2: x (@alp)", "unit-g-ovlog2"], at(home, { VIBESQUAD_TEAMS_FILE: noPaths }));
    assert.equal(m2.code, 0, m2.err);
    assert.match(m2.err, /NOT logged \(no Squad log for this repo\)/);
  });

  test("the refusal names the docs-only / lead-checked path and that the override is needed on merge AND push (review Medium 2)", () => {
    const r = evaluateMergeVerdicts({ merges: [{ sha: "", subject: "Merge unit-docs: x", tip: T40 }], recorded: () => null });
    const msg = formatVerdictRefusal(r, { action: "merge", squads: ["squad-a"] });
    assert.match(msg, /Docs-only or lead-checked unit/);
    assert.match(msg, /docs:<path> review, which names no commit/);
    assert.match(msg, /git merge AND again on the git push/);
    assert.match(readFileSync(join(ROOT, "docs", "WORKFLOWS.md"), "utf8"), /\*\*Docs-only \/ lead-checked units\*\*.*vs\.verdictOverride=<tip> merge.*AND again on .*push/);
  });

  test("a conflicted unit merge's final git commit is refused by pre-commit on FAIL", () => {
    const { work } = freshRepo();
    ok(work, ["checkout", "-q", "-b", "unit-g-conf", "master"]);
    writeFileSync(join(work, "a.txt"), "branch\n");
    ok(work, ["commit", "-q", "-am", "branch side"]);
    const tip = ok(work, ["rev-parse", "HEAD"]);
    recordVerdict(`FAIL 1/0/0 ${tip.slice(0, 8)} reviewer=Review - Gemini: no`);
    ok(work, ["checkout", "-q", "master"]);
    writeFileSync(join(work, "a.txt"), "master\n");
    ok(work, ["commit", "-q", "-am", "master side"]);
    const before = ok(work, ["rev-parse", "HEAD"]);
    assert.notEqual(run(work, ["merge", "-q", "--no-ff", "-m", "Merge unit-g-conf: x (@alp)", "unit-g-conf"]).code, 0); // conflict
    writeFileSync(join(work, "a.txt"), "resolved\n");
    ok(work, ["add", "a.txt"]);
    const c = run(work, ["commit", "-q", "--no-edit"]);
    assert.notEqual(c.code, 0);
    assert.match(c.err, /vs verdict gate: refusing to merge/);
    assert.equal(ok(work, ["rev-parse", "HEAD"]), before);
    ok(work, ["merge", "--abort"]);
  });

  test("push: a FAIL unit merge made with --no-verify (the c6d15975 shape) is refused; pushInclude doesn't waive it, verdictOverride does", () => {
    const { work, origin } = freshRepo();
    const before = remoteTip(origin);
    const tip = unitBranch(work, "unit-g-push", { verdict: "FAIL" });
    ok(work, ["merge", "-q", "--no-ff", "--no-verify", "-m", "Merge unit-g-push: sweep fix (@alp W1; Review-Gemini PASS)", "unit-g-push"]);
    const m = ok(work, ["rev-parse", "HEAD"]);
    const r = run(work, ["push", "origin", "master"], lane("lane-alpha"));
    assert.notEqual(r.code, 0);
    assert.match(r.err, /vs verdict gate: refusing to push/);
    assert.match(r.err, new RegExp(`${m.slice(0, 8)} Merge unit-g-push`));
    assert.equal(remoteTip(origin), before);
    assert.notEqual(run(work, ["-c", `vs.pushInclude=${m.slice(0, 8)}`, "push", "origin", "master"], lane("lane-alpha")).code, 0);
    const ov = run(work, ["-c", `vs.verdictOverride=${tip.slice(0, 8)}`, "push", "origin", "master"], lane("lane-alpha"));
    assert.equal(ov.code, 0, ov.err);
    assert.match(ov.err, /OVERRIDE\s+\w{8} tip \w{8}: verdict gate overridden/);
    assert.equal(remoteTip(origin), m);
  });
});

// ---- idea-883 runner-attested fallback: the reviewer's own last message from the on-disk runner store (<home>/runner/agents).
// Covers a digest `done` written before the server ran the attested-verdict writer (deploy skew) and a re-tasked reviewer's
// later turn that was never digested. Trust comes from the reviewer's runner record, never from a log entry's text.
const REVIEWER = { profile: "Review - Gemini", title: "Bug3 · unit-x review" };
const IMPLEMENTER = { profile: "Implement - Sonnet", title: "Bug3 · unit-x fix" };
/** Write <home>/runner/<sub>/<id>.jsonl: a created event, then per turn an input and the reply (split in two output chunks). */
function runnerLog(home, id, { profile, title, team = "squad-a", turns = [], sub = "agents", t0 = Date.now() - 60_000 } = {}) {
  const dir = join(home, "runner", sub);
  mkdirSync(dir, { recursive: true });
  let seq = 0;
  let ts = t0;
  const ev = (type, data = {}) => JSON.stringify({ seq: seq++, ts: ts++, type, ...data });
  const lines = [ev("created", { provider: "claude", model: "m", cwd: "/tmp/x", meta: { team, lane: "lane-alpha", role: "worker", profile, title, labels: { team, role: "worker" } }, systemPrompt: "rules" })];
  for (const [input, reply] of turns) {
    const cut = Math.floor(reply.length / 2);
    lines.push(ev("input", { text: input }), ev("status", { status: "running" }), ev("output", { text: reply.slice(0, cut) }), ev("output", { text: reply.slice(cut) }), ev("turn_done", { stopReason: "end_turn" }), ev("status", { status: "idle" }));
  }
  writeFileSync(join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}
const T41 = "5d399d2a" + "b".repeat(32);
const NOW_TIP = () => Date.now() - 30_000; // tip committed before the reviewer's log was written

describe("push-guard: idea-883 runner-attested fallback (pure + store)", () => {
  test("runnerRecordVerdict: a reviewer's own PASS on the tip passes; FAIL fails; non-reviewer, stale or foreign hash -> null", () => {
    const rev = { id: "rn-rev", ...REVIEWER, labels: { profile: REVIEWER.profile } };
    const impl = { id: "rn-imp", ...IMPLEMENTER, labels: { profile: IMPLEMENTER.profile } };
    const r = runnerRecordVerdict({ agent: rev, lastMessage: "Review done.\nPASS 0/0/1 4c288c19\nbody", tip: T40, resolve: () => T40, ts: 1795579758502 });
    assert.deepEqual(r, { verdict: "PASS", line: "PASS 0/0/1 4c288c19", ts: "2026-11-25T04:09:18.502Z", agent: null, reviewer: "rn-rev", source: "runner" });
    assert.equal(runnerRecordVerdict({ agent: rev, lastMessage: "FAIL 1/0/0 4c288c19", tip: T40 }).verdict, "FAIL");
    assert.equal(runnerRecordVerdict({ agent: rev, lastMessage: "PASS 0/0/0 4c288c19\nFAIL 0/1/0 4c288c19", tip: T40 }).verdict, "FAIL", "fails closed");
    assert.equal(runnerRecordVerdict({ agent: impl, lastMessage: "PASS 0/0/0 4c288c19", tip: T40 }), null, "an implementer's own PASS line is not a verdict");
    assert.equal(runnerRecordVerdict({ agent: rev, lastMessage: "PASS 0/0/0 deadbee1", tip: T40 }), null, "names another commit");
    assert.equal(runnerRecordVerdict({ agent: rev, lastMessage: "PASS 0/0/0 4c288c19", tip: T40, resolve: () => "" }), null, "ambiguous here");
    assert.equal(runnerRecordVerdict({ agent: rev, lastMessage: "PASS 0/0/0 docs:README.md", tip: T40 }), null);
    assert.equal(runnerRecordVerdict({ agent: rev, lastMessage: "no verdict", tip: T40 }), null);
    // newestVerdict: by ts, nulls skipped.
    const a = { verdict: "FAIL", ts: "2026-11-25T04:00:00.000Z" };
    const b = { verdict: "PASS", ts: "2026-11-25T04:09:00.000Z" };
    assert.equal(newestVerdict(b, null, a), b);
    assert.equal(newestVerdict(null, null), null);
    // A ts tie (both null included) fails closed: FAIL beats PASS whatever the argument order.
    const failNull = { verdict: "FAIL", ts: null };
    const passNull = { verdict: "PASS", ts: null };
    assert.equal(newestVerdict(failNull, passNull), failNull);
    assert.equal(newestVerdict(passNull, failNull), failNull);
    const failAt = { verdict: "FAIL", ts: b.ts };
    assert.equal(newestVerdict(failAt, b), failAt);
    assert.equal(newestVerdict(b, failAt), failAt);
    const pass2 = { verdict: "PASS", ts: b.ts };
    assert.equal(newestVerdict(b, pass2), pass2, "between equals the later argument wins");
  });

  test("a team-less reviewer record never counts as the vibesquad Squad's (no squadDir default)", async () => {
    const home = join(tmp, "rr-home-noteam");
    mkdirSync(join(home, "teams", "vibesquad"), { recursive: true });
    writeFileSync(join(home, "teams", "vibesquad", "log.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), agent: "rn-dg5", type: "done", text: "PASS 0/0/0 4c288c19", refs: ["rn-revnt"] })}\n`);
    runnerLog(home, "rn-revnt", { ...REVIEWER, team: "", turns: [["review", "PASS 0/0/0 4c288c19"]] });
    const opts = { tips: [T40], home, squads: ["vibesquad"], resolve: () => T40, tipTime: NOW_TIP };
    assert.equal((await readRunnerVerdicts(opts)).size, 0, "missing labels.team is no Squad");
    assert.equal((await recordedVerdicts(opts))(T40), null);
    // The same record with the team set does count (control).
    runnerLog(home, "rn-revnt", { ...REVIEWER, team: "vibesquad", turns: [["review", "PASS 0/0/0 4c288c19"]] });
    assert.equal((await recordedVerdicts(opts))(T40)?.verdict, "PASS");
    // An empty Squad entry is skipped, never read as "vibesquad".
    assert.equal((await readRunnerVerdicts({ ...opts, squads: ["", "  "] })).size, 0);
    const attested = { ts: new Date().toISOString(), agent: "rn-dg6", type: "done", text: "PASS 0/0/0 4c288c19", refs: ["rn-revnt"], verdict: { reviewer: "rn-revnt", profile: "Review - Gemini", line: "PASS 0/0/0 4c288c19" } };
    appendFileSync(join(home, "teams", "vibesquad", "log.jsonl"), `${JSON.stringify(attested)}\n`);
    assert.equal(readRecordedVerdicts({ tips: [T40], home, squads: [""] })(T40), null, "empty Squad id reads no log");
    assert.equal(readRecordedVerdicts({ tips: [T40], home, squads: ["vibesquad"] })(T40)?.verdict, "PASS", "control");
  });

  test("an unattested digest done falls back to the digested reviewer's runner record and passes", async () => {
    const home = join(tmp, "rr-home-1");
    mkdirSync(join(home, "teams", "squad-a"), { recursive: true });
    // The deploy-skew shape: the digest's done entry (refs[0] = the reviewer) has no server-attested `verdict` field.
    writeFileSync(join(home, "teams", "squad-a", "log.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), agent: "rn-dg1", type: "done", text: "PASS 0/0/1 4c288c19 reviewer=Review - Gemini: ok", refs: ["rn-rev1"] })}\n`);
    assert.equal(readRecordedVerdicts({ tips: [T40], home, squads: ["squad-a"] })(T40), null, "attested-only path records nothing");
    runnerLog(home, "rn-rev1", { ...REVIEWER, turns: [["review unit-x", "Findings: none.\nPASS 0/0/1 4c288c19\nTests 12/12."]] });
    const rec = await recordedVerdicts({ tips: [T40], home, squads: ["squad-a"], resolve: () => T40, tipTime: NOW_TIP });
    assert.equal(rec(T40)?.verdict, "PASS");
    assert.equal(rec(T40).reviewer, "rn-rev1");
    assert.equal(rec(T40).source, "runner");
    // The named reviewer is read even without a tip time (forced id), and from agents-archive.
    const home2 = join(tmp, "rr-home-1b");
    mkdirSync(join(home2, "teams", "squad-a"), { recursive: true });
    writeFileSync(join(home2, "teams", "squad-a", "log.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), agent: "rn-dg1", type: "done", text: "PASS 0/0/1 4c288c19", refs: ["rn-rev9"] })}\n`);
    runnerLog(home2, "rn-rev9", { ...REVIEWER, sub: "agents-archive", turns: [["r", "PASS 0/0/1 4c288c19"]] });
    assert.equal((await recordedVerdicts({ tips: [T40], home: home2, squads: ["squad-a"], resolve: () => T40 }))(T40)?.verdict, "PASS");
  });

  test("a non-reviewer's record, a reviewer FAIL, another Squad's reviewer, or a self-declared done line is refused", async () => {
    const home = join(tmp, "rr-home-2");
    mkdirSync(join(home, "teams", "squad-a"), { recursive: true });
    const log = (refs, text) => appendFileSync(join(home, "teams", "squad-a", "log.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), agent: "rn-dg2", type: "done", text, refs })}\n`);
    // Self-declared: the implementer's own done says PASS, and its own last message says PASS too. Neither counts.
    log(["rn-imp2"], "PASS 0/0/0 4c288c19 reviewer=Review - Gemini: self-declared");
    runnerLog(home, "rn-imp2", { ...IMPLEMENTER, turns: [["fix unit-x", "Done.\nPASS 0/0/0 4c288c19"]] });
    const opts = { tips: [T40, T41], home, squads: ["squad-a"], resolve: (h) => (T40.startsWith(h) ? T40 : T41.startsWith(h) ? T41 : ""), tipTime: NOW_TIP };
    assert.equal((await recordedVerdicts(opts))(T40), null, "non-reviewer record refused");
    // A done line with no runner record behind it at all.
    log(["rn-ghost"], "PASS 0/0/0 4c288c19 reviewer=Review - Gemini: no such agent");
    log([], "PASS 0/0/0 4c288c19 reviewer=Review - Gemini: no refs");
    assert.equal((await recordedVerdicts(opts))(T40), null, "a self-declared line is never read");
    // Another Squad's reviewer PASS on this tip does not count for squad-a.
    runnerLog(home, "rn-revz", { ...REVIEWER, team: "squad-z", turns: [["review", "PASS 0/0/0 4c288c19"]] });
    assert.equal((await recordedVerdicts(opts))(T40), null, "another Squad's reviewer");
    // The repo's own reviewer FAILs the tip: a FAIL, which refuses.
    runnerLog(home, "rn-rev2", { ...REVIEWER, turns: [["review", "FAIL 1/0/0 4c288c19\nH1 broken"]] });
    const rec = await recordedVerdicts(opts);
    assert.equal(rec(T40)?.verdict, "FAIL");
    assert.equal(evaluateMergeVerdicts({ merges: [{ sha: SHA("1"), subject: "Merge unit-x: x (@alp)", tip: T40 }], recorded: rec }).refused[0].reason, "fail");
    assert.equal(rec(T41), null);
    // A runner log older than the tip's commit cannot be a review of it (and is not read): the scan skips it.
    assert.equal((await readRunnerVerdicts({ ...opts, tipTime: () => Date.now() + 3_600_000 })).size, 0);
  });

  test("a re-tasked reviewer's second-turn verdict passes with no digest at all; the newest verdict decides", async () => {
    const home = join(tmp, "rr-home-3");
    mkdirSync(join(home, "teams", "squad-a"), { recursive: true });
    // Turn 1 FAILed T41 (attested digest, older); turn 2 re-reviewed the moved tip T40 and PASSed it; no entry names T40.
    appendFileSync(join(home, "teams", "squad-a", "log.jsonl"), `${JSON.stringify({ ts: new Date(Date.now() - 120_000).toISOString(), agent: "rn-dg3", type: "done", text: "FAIL 0/1/0 5d399d2a", refs: ["rn-rev3"], verdict: { reviewer: "rn-rev3", profile: "Review - Gemini", line: "FAIL 0/1/0 5d399d2a" } })}\n`);
    runnerLog(home, "rn-rev3", { ...REVIEWER, turns: [["review unit-x at 5d399d2a", "FAIL 0/1/0 5d399d2a\nM1"], ["follow-up: branch moved to 4c288c19", "M1 fixed.\nPASS 0/0/1 4c288c19"]] });
    const opts = { tips: [T40, T41], home, squads: ["squad-a"], resolve: (h) => (T40.startsWith(h) ? T40 : T41.startsWith(h) ? T41 : ""), tipTime: NOW_TIP };
    const rec = await recordedVerdicts(opts);
    assert.equal(rec(T40)?.verdict, "PASS", "the second turn's own verdict");
    assert.equal(rec(T40).reviewer, "rn-rev3");
    assert.equal(rec(T41)?.verdict, "FAIL", "the attested FAIL still stands for the old tip (the last message names only T40)");
    // The same reviewer re-reviews T41 and passes it: its newer runner verdict beats the older attested FAIL.
    runnerLog(home, "rn-rev3", { ...REVIEWER, turns: [["review", "FAIL 0/1/0 5d399d2a"], ["re-review 5d399d2a", "PASS 0/0/0 5d399d2a"]] });
    assert.equal((await recordedVerdicts(opts))(T41)?.verdict, "PASS");
    // A newer attested FAIL beats an older runner PASS.
    appendFileSync(join(home, "teams", "squad-a", "log.jsonl"), `${JSON.stringify({ ts: new Date(Date.now() + 60_000).toISOString(), agent: "rn-dg4", type: "done", text: "FAIL 1/0/0 5d399d2a", refs: ["rn-rev4"], verdict: { reviewer: "rn-rev4", profile: "Review - Gemini", line: "FAIL 1/0/0 5d399d2a" } })}\n`);
    assert.equal((await recordedVerdicts(opts))(T41)?.verdict, "FAIL");
  });

  test("real git: a unit merge with only the reviewer's runner record merges; an implementer's record is refused", () => {
    const { work } = freshRepo();
    const home = join(tmp, "rr-git-home");
    attestServer(home);
    mkdirSync(join(home, "teams", "squad-a"), { recursive: true });
    writeFileSync(join(home, "teams", "squad-a", "log.jsonl"), "");
    const env = baseEnv({ VIBESQUAD_HOME: home });
    const tip = unitBranch(work, "unit-rr-ok", { verdict: null });
    runnerLog(home, "rn-rrrev1", { ...REVIEWER, t0: Date.now(), turns: [["review", `PASS 0/0/0 ${tip.slice(0, 8)}`]] });
    const okMerge = run(work, ["merge", "-q", "--no-ff", "-m", "Merge unit-rr-ok: x (@alp)", "unit-rr-ok"], env);
    assert.equal(okMerge.code, 0, okMerge.err);
    const bad = unitBranch(work, "unit-rr-bad", { verdict: null });
    runnerLog(home, "rn-rrimp1", { ...IMPLEMENTER, t0: Date.now(), turns: [["fix", `PASS 0/0/0 ${bad.slice(0, 8)}`]] });
    appendFileSync(join(home, "teams", "squad-a", "log.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), agent: "rn-dg", type: "done", text: `PASS 0/0/0 ${bad.slice(0, 8)}`, refs: ["rn-rrimp1"] })}\n`);
    const r = run(work, ["merge", "-q", "--no-ff", "-m", "Merge unit-rr-bad: x (@alp)", "unit-rr-bad"], env);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /no recorded verdict/);
    ok(work, ["merge", "--abort"]);
  });
});

// ---- idea-941 rollout guard: warn instead of refusing until the running server attests `attested-verdict` at boot.
describe("push-guard: idea-941 rollout guard (unattested-warns, attested-refuses, attested-pass)", () => {
  const at = (home, extra = {}) => baseEnv({ VIBESQUAD_HOME: home, ...extra });

  test("verdictWriterAttested: missing or pre-restart server-start is unattested; recordServerStart attests; rollback clears", () => {
    assert.equal(verdictWriterAttested({ home: join(tmp, "no-such-rollout-home") }).attested, false);
    const home = join(tmp, "rollout-att-unit");
    // Pre-restart server-start record (no capabilities field) -> unattested.
    attestServer(home, { capabilities: null, startedAt: "2026-11-25T03:55:00.000Z" });
    assert.equal(verdictWriterAttested({ home }).attested, false);
    // dryRun / failed attested records do not count.
    writeFileSync(join(home, "server-start-2026-11-25T04-00-00-000Z.json"), JSON.stringify({ startedAt: "2026-11-25T04:00:00.000Z", ok: true, dryRun: true, capabilities: [VERDICT_WRITER_CAPABILITY] }));
    assert.equal(verdictWriterAttested({ home }).attested, false);
    // New server boots via recordServerStart -> writes capabilities: ["attested-verdict"] -> attested.
    const started = recordServerStart({ repoRoot: ROOT, vsHome: home, now: () => Date.parse("2026-11-25T04:10:00.000Z") });
    assert.equal(started.ok, true);
    assert.deepEqual(started.capabilities, [VERDICT_WRITER_CAPABILITY]);
    const att = verdictWriterAttested({ home });
    assert.equal(att.attested, true);
    assert.equal(att.startedAt, "2026-11-25T04:10:00.000Z");
    // Rollback: a newer server-start without the capability returns to unattested.
    attestServer(home, { capabilities: null, startedAt: "2026-11-25T04:20:00.000Z" });
    assert.equal(verdictWriterAttested({ home }).attested, false);
  });

  test("unattested-warns: pre-restart server warns on merge and push instead of refusing, while lane ownership still refuses", async () => {
    const { work, origin } = freshRepo();
    const home = join(tmp, "rollout-unattested");
    attestServer(home, { capabilities: null, startedAt: "2026-11-25T03:55:00.000Z" });
    const tip = unitBranch(work, "unit-941-warn", { verdict: null });
    // Pre-restart PASS digest (no server-attested `verdict` field).
    recordVerdict(`PASS 0/0/0 ${tip.slice(0, 8)} reviewer=Review - Gemini: pre-restart`, { home, attested: false });

    const env = at(home, { VS_LANE: "lane-alpha", VS_TEAM: "squad-a" });
    const m = run(work, ["merge", "-q", "--no-ff", "-m", "Merge unit-941-warn: pre-restart (@alp)", "unit-941-warn"], env);
    assert.equal(m.code, 0, m.err);
    assert.match(m.err, /WARNING \(rollout guard, idea-941\)/);
    assert.match(m.err, /PASS digests written before that restart never get the `verdict` field retroactively/);

    const chk = await checkHead({ cwd: work, env: { VS_LANE: "lane-alpha", VIBESQUAD_HOME: home }, registry });
    assert.equal(chk.ok, true);
    assert.equal(chk.attested, false);
    assert.match(chk.warnings, /WARNING \(rollout guard, idea-941\)/);

    const p = run(work, ["push", "origin", "master"], env);
    assert.equal(p.code, 0, p.err);
    assert.match(p.err, /WARNING \(rollout guard, idea-941\)/);
    assert.equal(remoteTip(origin), ok(work, ["rev-parse", "HEAD"]));

    // Lane-ownership push guard is NOT weakened when verdict gate is unattested.
    unitBranch(work, "unit-941-other", { verdict: null });
    assert.equal(run(work, ["merge", "-q", "--no-ff", "-m", "Merge unit-941-other: theirs (@bet)", "unit-941-other"], env).code, 0);
    const otherPush = run(work, ["push", "origin", "master"], env);
    assert.notEqual(otherPush.code, 0, "other lane merge must still be refused");
    assert.match(otherPush.err, /refusing to push refs\/heads\/master/);
    assert.match(otherPush.err, /WARNING \(rollout guard, idea-941\)/);
  });

  test("attested-refuses: once recordServerStart attests, missing verdict (incl. pre-restart digest) and FAIL refuse on merge and push", () => {
    const { work, origin } = freshRepo();
    const home = join(tmp, "rollout-attested-refuse");
    recordServerStart({ repoRoot: ROOT, vsHome: home, now: () => Date.parse("2026-11-25T05:00:00.000Z") });
    const env = at(home, { VS_LANE: "lane-alpha", VS_TEAM: "squad-a" });

    // Pre-restart unattested PASS digest -> refused after attestation, with pre-restart guidance.
    const tipMiss = unitBranch(work, "unit-941-miss", { verdict: null });
    recordVerdict(`PASS 0/0/0 ${tipMiss.slice(0, 8)} reviewer=Review - Gemini: pre-restart`, { home, attested: false });
    const mMiss = run(work, ["merge", "-q", "--no-ff", "-m", "Merge unit-941-miss: x (@alp)", "unit-941-miss"], env);
    assert.notEqual(mMiss.code, 0);
    assert.match(mMiss.err, /vs verdict gate: refusing to merge/);
    assert.match(mMiss.err, /Pre-restart PASS digests/);
    assert.match(mMiss.err, /re-review the tip or use an override/);
    ok(work, ["merge", "--abort"]);

    // Recorded FAIL -> refused on merge and on push (even after --no-verify merge).
    const tipFail = unitBranch(work, "unit-941-fail", { verdict: null });
    recordVerdict(`FAIL 1/0/0 ${tipFail.slice(0, 8)} reviewer=Review - Gemini: high`, { home, attested: true });
    const mFail = run(work, ["merge", "-q", "--no-ff", "-m", "Merge unit-941-fail: x (@alp)", "unit-941-fail"], env);
    assert.notEqual(mFail.code, 0);
    assert.match(mFail.err, /vs verdict gate: refusing to merge/);
    assert.match(mFail.err, /latest recorded verdict is FAIL 1\/0\/0/);
    ok(work, ["merge", "--abort"]);

    const before = remoteTip(origin);
    ok(work, ["merge", "-q", "--no-ff", "--no-verify", "-m", "Merge unit-941-fail: x (@alp)", "unit-941-fail"]);
    const pFail = run(work, ["push", "origin", "master"], env);
    assert.notEqual(pFail.code, 0);
    assert.match(pFail.err, /vs verdict gate: refusing to push/);
    assert.match(pFail.err, /Pre-restart PASS digests/);
    assert.equal(remoteTip(origin), before);
  });

  test("attested-pass: once attested, a recorded PASS merges and pushes cleanly with no warning", () => {
    const { work, origin } = freshRepo();
    const home = join(tmp, "rollout-attested-pass");
    recordServerStart({ repoRoot: ROOT, vsHome: home, now: () => Date.parse("2026-11-25T05:00:00.000Z") });
    const env = at(home, { VS_LANE: "lane-alpha", VS_TEAM: "squad-a" });

    const tip = unitBranch(work, "unit-941-pass", { verdict: null });
    recordVerdict(`PASS 0/0/1 ${tip.slice(0, 8)} reviewer=Review - Gemini: clean`, { home, attested: true });
    const m = run(work, ["merge", "-q", "--no-ff", "-m", "Merge unit-941-pass: ok (@alp)", "unit-941-pass"], env);
    assert.equal(m.code, 0, m.err);
    assert.doesNotMatch(m.err, /WARNING \(rollout guard/);

    const p = run(work, ["push", "origin", "master"], env);
    assert.equal(p.code, 0, p.err);
    assert.doesNotMatch(p.err, /WARNING \(rollout guard/);
    assert.equal(remoteTip(origin), ok(work, ["rev-parse", "HEAD"]));
  });

  test("docs/WORKFLOWS.md documents the idea-941 rollout guard and pre-restart PASS digests", () => {
    const wf = readFileSync(join(ROOT, "docs", "WORKFLOWS.md"), "utf8");
    assert.match(wf, /Rollout guard \(idea-941\)/);
    assert.match(wf, /PASS digests written before that restart never get the `verdict` field retroactively/);
  });
});
