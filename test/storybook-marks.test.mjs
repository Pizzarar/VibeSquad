// PLAN_STORYBOOK_V2 V6: owner marks into EFI docs/review/text_review.csv on a storybook/review-<date> branch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  pyRow, csvSafe, csvUnsafe, textHash, splitRecords, toObj, findRecord, parseNote, joinNote, markRow, applyMarks,
  listMarks, reviewBranch, marksFor, SHEET, lockKey, worktreeFor,
} from "../server/storybook/marks.mjs";
import { scrubPaths } from "../server/storybook/api.mjs";
import { makeFakeRepo, git, FILES } from "./storybook-fake-repo.mjs";

const hasPython = spawnSync("python3", ["--version"]).status === 0;

test("pyRow matches Python csv.writer (QUOTE_MINIMAL, \\n)", { skip: !hasPython && "python3 missing" }, () => {
  const rows = [
    ["a", "b,c", 'say "hi"', "line1\nline2", "", " lead", "trail ", "ünï ✓", "'+5"],
    ["cr\ronly", "x", "", "", "=sum", "@me", "-1", "+2", "tab\tin"],
  ];
  const py = execFileSync("python3", ["-c",
    "import csv,io,json,sys\nb=io.StringIO(newline='')\nw=csv.writer(b,lineterminator='\\n')\nfor r in json.load(sys.stdin): w.writerow(r)\nsys.stdout.write(b.getvalue())"],
  { input: JSON.stringify(rows), encoding: "utf8" });
  assert.equal(rows.map(pyRow).join("\n") + "\n", py);
});

test("csvSafe / csvUnsafe / textHash mirror review_pack", () => {
  assert.equal(csvSafe("-5 HP"), "'-5 HP");
  assert.equal(csvSafe("ok"), "ok");
  assert.equal(csvUnsafe("'-5 HP"), "-5 HP");
  assert.equal(csvUnsafe("'quoted"), "'quoted");
  assert.equal(textHash("'-5 HP"), textHash("-5 HP"));
  assert.match(textHash("Doc frowns."), /^[0-9a-f]{64}$/);
  if (hasPython) {
    const py = execFileSync("python3", ["-c", "import hashlib,sys;print(hashlib.sha256(sys.stdin.read().encode('utf-8')).hexdigest())"], { input: "Bring thirty casings,\nand \"he'll\" know you.", encoding: "utf8" }).trim();
    assert.equal(textHash("Bring thirty casings,\nand \"he'll\" know you."), py);
  }
});

const HEADER = "group,source,file,line,data_path,id,current_text,where_seen,length_budget,tags,confidence,appendix,owner_rewrite,status,speaker,owner_note,reviewed_hash";
const DP = (...p) => `"${JSON.stringify(p).replace(/"/g, '""')}"`;
const SHEET_TEXT = "\ufeff" + [
  HEADER,
  `Screen: Armory,gd,scenes/armory/armory_view.gd,14,,,Build the Armory,armory page,none,,verify,,,STORY-TODO,,,`,
  `Trader questlines,data,data/questlines.json,12,${DP("questlines", "popper", "steps", 1, "story")},popper_2,"Bring thirty casings,\nand ""he'll"" know you.",quests,,,verify,,Bring me thirty clean casings.,DRAFT,Popper,keep it short,`,
  `Trader relations,data,data/trader_relations.json,5,${DP("traders", "doc", "lines", "wary")},,Doc frowns.,relations,,,verify,,,STORY-TODO,Doc,,`,
  `Systems,gd,systems/ContractSystem.gd,720,,,Deliver {qty} {item},contract_title,,,verify,,,STORY-TODO,,,`,
  `Screen: Raids,gd,scenes/raids/raid.gd,30,,,'-5 HP,raids page,,,verify,,,STORY-TODO,,,`,
  `Screen: Raids,gd,scenes/raids/raid.gd,40,,,Same text,raids page,,,verify,,,STORY-TODO,,,`,
  `Screen: Raids,gd,scenes/raids/raid.gd,50,,,Same text,raids page,,,verify,,,STORY-TODO,,,`,
].join("\n") + "\n";
const rowsOf = (text) => { const { header, records } = splitRecords(text); return records.map((r) => toObj(header, r.cells)); };
const T = {
  armory: { file: "scenes/armory/armory_view.gd", where_seen: "armory page", line: "14", seen: "Build the Armory" },
  story: { file: "data/questlines.json", data_path: JSON.stringify(["questlines", "popper", "steps", 1, "story"]), seen: "Bring thirty casings,\nand \"he'll\" know you." },
  wary: { file: "data/trader_relations.json", data_path: JSON.stringify(["traders", "doc", "lines", "wary"]), seen: "Doc frowns." },
  contract: { file: "systems/ContractSystem.gd", where_seen: "contract_title", line: "720", seen: "Deliver {qty} {item}" },
  hp: { file: "scenes/raids/raid.gd", where_seen: "raids page", line: "30", seen: "-5 HP" },
};

test("splitRecords parses quoted multi-line cells and keeps byte ranges", () => {
  const { bom, header, records } = splitRecords(SHEET_TEXT);
  assert.equal(bom, "\ufeff");
  assert.equal(header.length, 17);
  assert.equal(records.length, 7);
  assert.equal(toObj(header, records[1].cells).current_text, "Bring thirty casings,\nand \"he'll\" know you.");
  for (const r of records) assert.equal(r.cells.length, 17);
  // each untouched record re-serializes to its exact source bytes (the sheet was written by csv.writer)
  for (const r of records) assert.equal(pyRow(r.cells), SHEET_TEXT.slice(r.start, r.end));
  const crlf = SHEET_TEXT.replace(/\n(?=[A-Z])/g, "\r\n");
  assert.equal(splitRecords(crlf).records.length, 7);
});

test("findRecord: data rows by data_path, code rows by where_seen+text, line breaks ties", () => {
  const { header, records } = splitRecords(SHEET_TEXT);
  assert.equal(findRecord(header, records, T.story).index, 1);
  assert.equal(findRecord(header, records, { ...T.armory, line: "99" }).index, 0, "a moved code row is still found");
  assert.equal(findRecord(header, records, { file: "scenes/raids/raid.gd", where_seen: "raids page", line: "50", seen: "Same text" }).index, 6);
  assert.equal(findRecord(header, records, { file: "scenes/raids/raid.gd", where_seen: "raids page", line: "1", seen: "Same text" }).error, "ambiguous");
  assert.equal(findRecord(header, records, { ...T.armory, seen: "Changed" }).error, "not-found");
});

test("parseNote / joinNote keep contract segments apart", () => {
  const p = parseNote("too long | contract:d_a: fine | contract:k_b: wrong enemy");
  assert.equal(p.own, "too long");
  assert.deepEqual([...p.contracts], [["d_a", "fine"], ["k_b", "wrong enemy"]]);
  assert.equal(joinNote(p), "too long | contract:d_a: fine | contract:k_b: wrong enemy");
});

test("markRow ok / redo / edit / clear", () => {
  const row = rowsOf(SHEET_TEXT)[1];
  const ok = markRow(row, { action: "ok" });
  assert.equal(ok.status, "OWNER-OK");
  assert.equal(ok.reviewed_hash, textHash(row.current_text));
  assert.equal(ok.owner_rewrite, "Bring me thirty clean casings.", "OK approves the drafted rewrite");
  const redo = markRow(row, { action: "redo", note: "more grit | less words" });
  assert.equal(redo.status, "NEEDS-REWRITE");
  assert.equal(redo.reviewed_hash, "");
  assert.equal(redo.owner_note, "more grit; less words", "the note separator is escaped");
  assert.throws(() => markRow(row, { action: "redo", note: "  " }), /note/);
  const edit = markRow(row, { action: "edit", text: "-Thirty casings. Now." });
  assert.equal(edit.owner_rewrite, "'-Thirty casings. Now.", "owner_rewrite is csv_safe'd");
  assert.equal(edit.status, "OWNER-OK");
  assert.throws(() => markRow(row, { action: "edit", text: "" }), /text/);
  const same = markRow(rowsOf(SHEET_TEXT)[2], { action: "edit", text: "Doc frowns." });
  assert.equal(same.owner_rewrite, "", "editing to the same text is a plain OK");
  const cleared = markRow(ok, { action: "clear", base: row });
  assert.deepEqual([cleared.status, cleared.owner_rewrite, cleared.owner_note, cleared.reviewed_hash], ["DRAFT", "Bring me thirty clean casings.", "keep it short", ""]);
  assert.equal(markRow(ok, { action: "clear" }).status, "STORY-TODO");
});

test("contract notes merge into the template row without clobbering other notes", () => {
  let row = { ...rowsOf(SHEET_TEXT)[3], owner_note: "template reads stiff" };
  row = markRow(row, { action: "redo", note: "wrong verb", contract: "d_popper_scrap" });
  row = markRow(row, { action: "redo", note: "say hunt", contract: "k_popper_scav" });
  row = markRow(row, { action: "redo", note: "use 'bring'", contract: "d_popper_scrap" });
  assert.equal(row.owner_note, "template reads stiff | contract:d_popper_scrap: use 'bring' | contract:k_popper_scav: say hunt");
  assert.equal(row.status, "NEEDS-REWRITE");
  const ok = markRow(row, { action: "ok", contract: "k_popper_scav", note: "good now" });
  assert.match(ok.owner_note, /contract:k_popper_scav: good now/);
  assert.match(ok.owner_note, /^template reads stiff/);
});

test("applyMarks rewrites only the marked rows, refuses stale ones, listMarks reads them back", () => {
  const res = applyMarks(SHEET_TEXT, [
    { target: T.armory, action: "ok" },
    { target: T.story, action: "redo", note: "shorter" },
    { target: T.wary, action: "edit", text: "Doc doesn't look up." },
    { target: T.contract, action: "redo", note: "wrong verb", contract: "d_x" },
    { target: T.hp, action: "ok" },
    { target: { ...T.wary, seen: "Doc smiles." }, action: "ok" },
    { target: { ...T.armory, seen: "Build it" }, action: "ok" },
    { target: T.armory, action: "nope" },
  ]);
  assert.equal(res.changed, 5);
  assert.deepEqual(res.results.map((r) => r.ok), [true, true, true, true, true, false, false, false]);
  assert.match(res.results[5].error, /^stale/);
  assert.match(res.results[6].error, /^stale/);
  const before = SHEET_TEXT.split("\n"), after = res.text.split("\n");
  assert.equal(after.length, before.length);
  const diff = before.map((l, k) => (l === after[k] ? null : k)).filter((k) => k !== null);
  assert.deepEqual(diff, [1, 3, 4, 5, 6], "armory, the story row's 2nd line (its 1st is unchanged), wary, contract, hp; the rest is byte-identical");
  assert.ok(res.text.startsWith("\ufeff" + HEADER + "\n"));
  const rows = rowsOf(res.text);
  assert.equal(rows[4].current_text, "'-5 HP", "csv_safe'd text survives a re-serialize");
  assert.equal(rows[4].reviewed_hash, textHash("-5 HP"));
  const marks = listMarks(res.text);
  assert.deepEqual(marks.map((m) => [m.file, m.status]), [
    ["scenes/armory/armory_view.gd", "OWNER-OK"], ["data/questlines.json", "NEEDS-REWRITE"], ["data/trader_relations.json", "OWNER-OK"],
    ["systems/ContractSystem.gd", "NEEDS-REWRITE"], ["scenes/raids/raid.gd", "OWNER-OK"],
  ]);
  assert.equal(marks[2].rewrite, "Doc doesn't look up.");
  assert.deepEqual(marks[3].contracts, { d_x: "wrong verb" });
  assert.ok(marks.every((m) => m.hashOk));
  // second pass on the result: the same edit target is still found by data_path
  const again = applyMarks(res.text, [{ target: T.wary, action: "clear" }], { baseText: SHEET_TEXT });
  assert.equal(rowsOf(again.text)[2].status, "STORY-TODO");
  assert.equal(rowsOf(again.text)[2].owner_rewrite, "");
  assert.equal(applyMarks(SHEET_TEXT, []).text, SHEET_TEXT);
});

test("applyMarks refuses a sheet without the mark columns", () => {
  assert.throws(() => applyMarks("group,file,current_text\nA,b,c\n", [{ target: T.armory, action: "ok" }]), /no data_path column|no status column/);
});

test("reviewBranch uses the UTC date", () => {
  assert.equal(reviewBranch(new Date("2026-11-27T03:00:00Z")), "storybook/review-2026-11-27");
});

test("marksFor: session worktree on storybook/review-<date>, one commit per session, main untouched", async () => {
  const fake = makeFakeRepo();
  const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const mainHead = git(fake.clone, "rev-parse", "HEAD");
    const wtRoot = path.join(fake.root, "wt");
    const now = () => new Date("2026-11-27T12:00:00Z");
    const api = marksFor(fake.clone, { now, autoCommitMs: 0, managedPath: (_repo, b) => path.join(wtRoot, b.replace(/\//g, "-")) });
    assert.deepEqual(await api.get(), { branch: "storybook/review-2026-11-27", exists: false, head: null, pending: 0, marks: [] });
    const wary = { file: "data/trader_relations.json", data_path: JSON.stringify(["traders", "doc", "lines", "wary"]), seen: "Doc frowns." };
    const bio = { file: "data/squad.json", data_path: JSON.stringify(["members", 0, "bio"]), seen: "A former paramedic." };
    const set = await api.set([{ target: wary, action: "redo", note: "colder" }, { target: bio, action: "ok" }, { target: { ...bio, seen: "old" }, action: "ok" }]);
    assert.equal(set.branch, "storybook/review-2026-11-27");
    assert.equal(set.created, true);
    assert.deepEqual(set.results.map((r) => r.ok), [true, true, false]);
    assert.equal(set.pending, 2);
    const wt = path.join(wtRoot, "storybook-review-2026-11-27");
    assert.ok(fs.existsSync(path.join(wt, SHEET)));
    assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "storybook/review-2026-11-27");
    // no review_pack.py in the fake repo: commit still lands, flagged
    const c = await api.commit();
    assert.ok(c.committed);
    assert.match(c.subject, /^storybook review 2026-11-27: 1 OK, 1 redo, 0 edit$/);
    assert.equal(c.write, "missing");
    assert.equal(git(wt, "log", "-1", "--format=%s"), c.subject);
    assert.equal(git(wt, "status", "--porcelain"), "");
    assert.equal(git(fake.clone, "rev-parse", "HEAD"), mainHead, "main checkout HEAD unchanged");
    assert.equal(git(fake.clone, "status", "--porcelain"), "", "main checkout tree untouched");
    const got = await api.get();
    assert.equal(got.exists, true);
    assert.equal(got.pending, 0);
    assert.deepEqual(got.marks.map((m) => m.status).sort(), ["NEEDS-REWRITE", "OWNER-OK"]);
    assert.equal((await api.commit()).committed, null, "nothing pending -> no empty commit");
    // a second session the same day reuses the worktree and never resets the branch
    const again = await api.set([{ target: wary, action: "clear" }]);
    assert.equal(again.created, false);
    const c2 = await api.commit();
    assert.equal(git(wt, "rev-list", "--count", "origin/main..HEAD"), "2");
    assert.match(c2.subject, /: 1 OK, 0 redo, 0 edit$/, "clear restores the pre-review OWNER-OK of the fake sheet row");
    // next day: base = yesterday's unmerged branch, so marks carry
    const api2 = marksFor(fake.clone, { now: () => new Date("2026-11-28T09:00:00Z"), autoCommitMs: 0, managedPath: (_r, b) => path.join(wtRoot, b.replace(/\//g, "-")) });
    const day2 = await api2.set([{ target: wary, action: "ok" }]);
    assert.equal(day2.branch, "storybook/review-2026-11-28");
    assert.ok(day2.marks.some((m) => m.file === "data/squad.json" && m.status === "OWNER-OK"), "yesterday's OK carries into today's branch");
    await api2.commit();
    assert.equal(git(fake.clone, "rev-parse", "HEAD"), mainHead);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fake.cleanup();
  }
});

test("HTTP marks routes behind the VS API guard: GET / POST / commit, no host paths, agent-less 401/403 on write", async () => {
  const os = await import("node:os");
  const http = await import("node:http");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-marks-"));
  const savedEnv = { VIBESQUAD_HOME: process.env.VIBESQUAD_HOME, VIBESQUAD_IGNORE_HOME_TEAMS: process.env.VIBESQUAD_IGNORE_HOME_TEAMS };
  process.env.VIBESQUAD_HOME = path.join(tmp, "home");
  process.env.VIBESQUAD_IGNORE_HOME_TEAMS = "1";
  const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const savedGit = Object.fromEntries(Object.keys(gitEnv).map((k) => [k, process.env[k]]));
  Object.assign(process.env, gitEnv);
  const fake = makeFakeRepo();
  const ROOT = path.join(tmp, "root");
  fs.mkdirSync(ROOT);
  fs.writeFileSync(path.join(ROOT, "teams.json"), JSON.stringify({ teams: [] }));
  const { createVibesquadMiddleware } = await import("../server/vibesquad-api.mjs");
  const { localTokenHeaders } = await import("../server/local-token.mjs");
  const { getLocalToken } = await import("../server/auth.mjs");
  getLocalToken();
  const wtRoot = path.join(tmp, "wt");
  const storybook = {
    teams: [{ id: "efi", paths: ["fake-efi"] }], resolvePath: (p) => (p === "fake-efi" ? fake.clone : null),
    marksFor: (repo) => marksFor(repo, { now: () => new Date("2026-11-27T12:00:00Z"), autoCommitMs: 0, managedPath: (_r, b) => path.join(wtRoot, b.replace(/\//g, "-")) }),
  };
  const mw = createVibesquadMiddleware(ROOT, { storybook });
  const srv = http.createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end("no"); }));
  const port = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  const call = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const rq = http.request({ host: "127.0.0.1", port, method, path: url, headers: { ...headers, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
    });
    rq.on("error", reject); if (data) rq.write(data); rq.end();
  });
  try {
    const g0 = await call("GET", "/api/storybook/efi/marks");
    assert.equal(g0.status, 200);
    assert.equal(g0.json.exists, false);
    const wary = { file: "data/trader_relations.json", data_path: '["traders", "doc", "lines", "wary"]', seen: "Doc frowns." };
    const noAuth = await call("POST", "/api/storybook/efi/marks", { marks: [{ target: wary, action: "ok" }] });
    assert.ok([401, 403].includes(noAuth.status), `unauthenticated write refused (${noAuth.status})`);
    const bad = await call("POST", "/api/storybook/efi/marks", { marks: [] }, localTokenHeaders());
    assert.equal(bad.status, 400);
    const set = await call("POST", "/api/storybook/efi/marks", { marks: [{ target: wary, action: "redo", note: "colder" }] }, localTokenHeaders());
    assert.equal(set.status, 200, set.body);
    assert.deepEqual(set.json.results.map((r) => r.ok), [true]);
    assert.equal(set.json.pending, 1);
    assert.ok(!set.body.includes(tmp), "no host path in the response");
    const c = await call("POST", "/api/storybook/efi/marks/commit", undefined, localTokenHeaders());
    assert.equal(c.status, 200, c.body);
    assert.match(c.json.subject, /0 OK, 1 redo, 0 edit/);
    assert.ok(!c.body.includes(tmp));
    const g1 = await call("GET", "/api/storybook/efi/marks");
    assert.deepEqual(g1.json.marks.map((m) => [m.status, m.note]), [["NEEDS-REWRITE", "colder"]], "the redo replaced the fake sheet row's pre-existing OWNER-OK");
    assert.equal((await call("GET", "/api/storybook/efi/marks/commit")).status, 405);
    assert.equal((await call("GET", "/api/storybook/nope/marks")).status, 404);
  } finally {
    srv.closeAllConnections?.(); await new Promise((r) => srv.close(() => r()));
    for (const [k, v] of Object.entries({ ...savedEnv, ...savedGit })) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fake.cleanup(); fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── review FAIL rn-f51381b5ee47 fixes ─────────────────────────────────────────────

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
async function withGitEnv(fn) {
  const saved = Object.fromEntries(Object.keys(GIT_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, GIT_ENV);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
const WARY = { file: "data/trader_relations.json", data_path: JSON.stringify(["traders", "doc", "lines", "wary"]), seen: "Doc frowns." };
const BIO = { file: "data/squad.json", data_path: JSON.stringify(["members", 0, "bio"]), seen: "A former paramedic." };
const wtPathFor = (root) => (_r, b) => path.join(root, b.replace(/\//g, "-"));

test("M1: Edit back to the current text clears a drafted/earlier owner_rewrite (no stale rewrite for --apply)", () => {
  const row = rowsOf(SHEET_TEXT)[1]; // DRAFT with owner_rewrite "Bring me thirty clean casings."
  const back = markRow(row, { action: "edit", text: "Bring thirty casings,\nand \"he'll\" know you." });
  assert.equal(back.owner_rewrite, "", "the drafted rewrite is gone");
  assert.equal(back.status, "OWNER-OK");
  assert.equal(back.reviewed_hash, textHash(row.current_text));
  const edited = markRow(row, { action: "edit", text: "Thirty casings." });
  assert.equal(markRow(edited, { action: "edit", text: "  Bring thirty casings,\r\nand \"he'll\" know you.  " }).owner_rewrite, "", "an earlier owner edit is dropped too (CRLF/space-insensitive)");
  const res = applyMarks(SHEET_TEXT, [{ target: T.story, action: "edit", text: T.story.seen }]);
  const m = listMarks(res.text).find((x) => x.file === "data/questlines.json");
  assert.equal(m.rewrite, "");
  assert.equal(m.status, "OWNER-OK");
});

test("M2: a review branch checked out in the main checkout is refused (409), never written there", async () => withGitEnv(async () => {
  const fake = makeFakeRepo();
  try {
    const branch = "storybook/review-2026-11-27";
    git(fake.clone, "checkout", "-q", "-b", branch);
    const head = git(fake.clone, "rev-parse", "HEAD");
    const sheet = fs.readFileSync(path.join(fake.clone, SHEET), "utf8");
    await assert.rejects(worktreeFor(fake.clone, branch), (e) => e.status === 409 && /main checkout/.test(e.message));
    await assert.rejects(worktreeFor(fake.clone + path.sep, branch), (e) => e.status === 409, "however the repo path is spelled");
    const api = marksFor(fake.clone, { now: () => new Date("2026-11-27T12:00:00Z"), autoCommitMs: 0, managedPath: wtPathFor(path.join(fake.root, "wt")) });
    await assert.rejects(api.set([{ target: WARY, action: "ok" }]), (e) => e.status === 409);
    await assert.rejects(api.commit(), (e) => e.status === 409);
    await assert.rejects(api.get(), (e) => e.status === 409);
    assert.equal(fs.readFileSync(path.join(fake.clone, SHEET), "utf8"), sheet, "main checkout sheet untouched");
    assert.equal(git(fake.clone, "status", "--porcelain"), "");
    assert.equal(git(fake.clone, "rev-parse", "HEAD"), head);
    assert.ok(!fs.existsSync(path.join(fake.root, "wt")), "no worktree made either");
    // a linked worktree on the branch is still found
    git(fake.clone, "checkout", "-q", "main");
    const linked = path.join(fake.root, "linked");
    git(fake.clone, "worktree", "add", "-q", linked, branch);
    assert.equal(fs.realpathSync(await worktreeFor(fake.clone, branch)), fs.realpathSync(linked));
  } finally { fake.cleanup(); }
}));

const FAILING_PACK = `import sys
if sys.argv[1] == "--check":
    sys.exit(0)
open("docs/review/text_review.csv", "a", encoding="utf-8").write("half,written\\n")
open("docs/review/README.md", "w", encoding="utf-8").write("partial regen\\n")
print("review_pack: refusing orphan rows", file=sys.stderr)
sys.exit(3)
`;

test("M3: a failed review_pack --write is never committed; marks stay, half-written pack files are restored, the error reaches the owner", { skip: !hasPython && "python3 missing" }, async () => withGitEnv(async () => {
  const fake = makeFakeRepo({ ...FILES, "tools/review_pack.py": FAILING_PACK, "docs/review/README.md": "pack readme\n" });
  try {
    const wtRoot = path.join(fake.root, "wt");
    const api = marksFor(fake.clone, { now: () => new Date("2026-11-27T12:00:00Z"), autoCommitMs: 0, managedPath: wtPathFor(wtRoot) });
    const set = await api.set([{ target: WARY, action: "redo", note: "colder" }, { target: BIO, action: "ok" }]);
    assert.deepEqual(set.results.map((r) => r.ok), [true, true]);
    const wt = path.join(wtRoot, "storybook-review-2026-11-27");
    const head = git(wt, "rev-parse", "HEAD");
    const marked = fs.readFileSync(path.join(wt, SHEET), "utf8");
    await assert.rejects(api.commit(), (e) => e.status === 409 && /review_pack --write failed \(exit 3\)/.test(e.message) && /refusing orphan rows/.test(e.message) && /Nothing committed/.test(e.message));
    assert.equal(git(wt, "rev-parse", "HEAD"), head, "no commit");
    assert.equal(git(wt, "diff", "--cached", "--name-only"), "", "nothing staged");
    assert.equal(fs.readFileSync(path.join(wt, SHEET), "utf8"), marked, "the owner's marked sheet is back, without the half-written row");
    assert.equal(fs.readFileSync(path.join(wt, "docs/review/README.md"), "utf8"), "pack readme\n", "the half-written pack file is restored");
    const got = await api.get();
    assert.equal(got.pending, 2, "marks still pending");
    // the auto-commit path keeps the failure for the owner's next read
    const auto = marksFor(fake.clone, { now: () => new Date("2026-11-27T12:00:00Z"), autoCommitMs: 25, managedPath: wtPathFor(wtRoot) });
    await auto.set([{ target: WARY, action: "redo", note: "colder still" }]);
    await new Promise((r) => setTimeout(r, 400));
    const after = await auto.get();
    assert.match(after.autoCommitError ?? "", /review_pack --write failed \(exit 3\)/);
    assert.equal(git(wt, "rev-parse", "HEAD"), head);
  } finally { fake.cleanup(); }
}));

test("M3: with review_pack missing only the sheet is committed, flagged write: missing", async () => withGitEnv(async () => {
  const fake = makeFakeRepo();
  try {
    const wtRoot = path.join(fake.root, "wt");
    const api = marksFor(fake.clone, { now: () => new Date("2026-11-27T12:00:00Z"), autoCommitMs: 0, managedPath: wtPathFor(wtRoot) });
    await api.set([{ target: WARY, action: "ok" }]);
    const wt = path.join(wtRoot, "storybook-review-2026-11-27");
    fs.writeFileSync(path.join(wt, "docs/review/stray.md"), "not ours\n");
    const c = await api.commit();
    assert.equal(c.write, "missing");
    assert.equal(git(wt, "show", "--name-only", "--format=", "HEAD"), SHEET);
  } finally { fake.cleanup(); }
}));

test("m1: scrubPaths masks repo, VIBESQUAD_HOME, home (both slash styles) and any other absolute path", () => {
  const env = { HOME: "/home/u", VIBESQUAD_HOME: "/srv/vs", USERPROFILE: "C:\\Users\\u" };
  const s = (m) => scrubPaths(m, "/home/u/projects/efi", env);
  assert.equal(s("fatal: '/srv/vs/worktrees/efi/x' already exists"), "fatal: '<vs-home>/worktrees/efi/x' already exists");
  assert.equal(s("/home/u/projects/efi/docs bad"), "<repo>/docs bad");
  assert.equal(s("fatal: C:/Users/u/wt/x is locked"), "fatal: ~/wt/x is locked", "forward-slash spelling of a backslash env path");
  assert.equal(s("C:\\Users\\u\\wt failed"), "~\\wt failed");
  assert.equal(s("at /opt/other/thing.py line 3"), "at <path> line 3");
  assert.equal(s("fatal: 'D:\\x\\y' missing"), "fatal: '<path>' missing");
  assert.equal(s("open \\\\host\\share\\p"), "open <path>");
  assert.equal(s("2 of 3 not saved: origin/main docs/review/text_review.csv a-b"), "2 of 3 not saved: origin/main docs/review/text_review.csv a-b", "relative paths and refs stay");
  for (const m of ["x /srv/vs/a", "x /home/u/b", "x /tmp/sb-1/c", "x C:/Users/u/d", "x E:/e"]) assert.doesNotMatch(s(m), /\/srv|\/home|\/tmp|[A-Z]:[\\/]/, m);
});

test("m2: one lock per repo however spelled; auto-commit after midnight commits the branch the marks were written on", async () => withGitEnv(async () => {
  assert.equal(lockKey("/a/b/"), lockKey("/a/b"));
  assert.equal(lockKey("/a/b/../b"), lockKey("/a/b"));
  const fake = makeFakeRepo();
  try {
    const wtRoot = path.join(fake.root, "wt");
    let clock = new Date("2026-11-27T23:59:50Z");
    const api = marksFor(fake.clone, { now: () => clock, autoCommitMs: 25, managedPath: wtPathFor(wtRoot) });
    assert.equal((await api.set([{ target: WARY, action: "redo", note: "colder" }])).pending, 1);
    clock = new Date("2026-11-28T00:00:10Z");
    await new Promise((r) => setTimeout(r, 400));
    const wt = path.join(wtRoot, "storybook-review-2026-11-27");
    assert.match(git(wt, "log", "-1", "--format=%s"), /^storybook review 2026-11-27: 0 OK, 1 redo, 0 edit$/);
    const got = await api.get();
    assert.equal(got.branch, "storybook/review-2026-11-27", "after midnight the read side shows yesterday's unmerged branch");
    assert.equal(got.pending, 0);
    assert.equal(got.autoCommitError, undefined);
    // a second marksFor on a differently spelled path shares the lock: two concurrent sets both land
    const api2 = marksFor(fake.clone + path.sep, { now: () => clock, autoCommitMs: 0, managedPath: wtPathFor(wtRoot) });
    const [a, b] = await Promise.all([api.set([{ target: BIO, action: "ok" }]), api2.set([{ target: WARY, action: "redo", note: "warmer" }])]);
    assert.equal(a.branch, b.branch);
    const marks = (await api.get()).marks;
    assert.ok(marks.some((m) => m.file === "data/squad.json" && m.status === "OWNER-OK") && marks.some((m) => m.file === "data/trader_relations.json" && m.note === "warmer"), "neither write lost the other");
  } finally { fake.cleanup(); }
}));
