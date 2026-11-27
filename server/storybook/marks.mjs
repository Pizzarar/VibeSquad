// Storybook owner marks (PLAN_STORYBOOK_V2 V6, storage option A). The owner's OK / Redo / Edit marks go into EFI's
// docs/review/text_review.csv columns status / owner_note / owner_rewrite / reviewed_hash, on an EFI branch
// storybook/review-<YYYY-MM-DD> checked out in a managed worktree (never EFI main, never pushed from here).
// EFI tools/review_pack.py stays the only game-data writer: VS writes the sheet, `--apply` (owner/EFI) writes data/.
//
// The csv contract mirrors review_pack.py (NARR-SHEET): CSV_COLS, STORY_STATUSES, text_hash = sha256(utf8 current_text)
// over the csv_unsafe text, reviewed_hash set only on OWNER-OK (finalize_story clears it on every other status), cells
// written through csv_safe, rows written by Python's csv.writer (QUOTE_MINIMAL, "\n" line ends, UTF-8 BOM). Only the
// rows we mark are re-serialized; every other byte of the file is kept, so a mark never reflows the sheet.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runGit, defaultBranch } from "./git-read.mjs";

export const SHEET = "docs/review/text_review.csv";
export const REVIEW_DIR = "docs/review";
export const MARK_COLS = ["status", "owner_note", "owner_rewrite", "reviewed_hash"];
export const STORY_STATUSES = ["STORY-TODO", "DRAFT", "NEEDS-REWRITE", "OWNER-OK"];
export const OWNER_MARKS = new Set(["OWNER-OK", "NEEDS-REWRITE"]);
export const ACTIONS = new Set(["ok", "redo", "edit", "clear"]);
export const NOTE_SEP = " | ";
const MAX_TEXT = 4000;
const MAX_BATCH = 2000;

// ── pure: csv cells ─────────────────────────────────────────────────────────────

/** review_pack csv_safe: a cell starting + - = @ gets a leading apostrophe. */
export const csvSafe = (v) => { const s = String(v ?? ""); return /^[+\-=@]/.test(s) ? `'${s}` : s; };
/** review_pack csv_unsafe. */
export const csvUnsafe = (v) => { const s = String(v ?? ""); return s.length >= 2 && s[0] === "'" && "+-=@".includes(s[1]) ? s.slice(1) : s; };
/** review_pack text_hash over the csv_unsafe text (what finalize_story hashes). */
export const textHash = (s) => createHash("sha256").update(csvUnsafe(s), "utf8").digest("hex");

/** One cell as Python csv.writer QUOTE_MINIMAL writes it (delimiter ",", quotechar '"', lineterminator "\n"). */
export function pyCell(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const pyRow = (cells) => cells.map(pyCell).join(",");

/**
 * Split csv text into records WITH their byte (char) ranges, so a row can be replaced in place.
 * Returns {bom, header, records:[{cells, start, end}]} where text.slice(start, end) is the record without its line end.
 */
export function splitRecords(text) {
  const src = String(text ?? "");
  const bom = src.startsWith("﻿") ? "﻿" : "";
  const recs = [];
  let i = bom.length, start = i, cells = [], field = "", inQ = false, any = false;
  const endRow = (end) => { cells.push(field); recs.push({ cells, start, end }); cells = []; field = ""; any = false; };
  for (; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c;
      continue;
    }
    if (c === '"' && field === "") { inQ = true; any = true; }
    else if (c === ",") { cells.push(field); field = ""; any = true; }
    else if (c === "\n" || c === "\r") {
      const end = i;
      if (c === "\r" && src[i + 1] === "\n") i++;
      if (any || cells.length) endRow(end); else { field = ""; }
      start = i + 1;
    } else { field += c; any = true; }
  }
  if (any || cells.length || field !== "") endRow(src.length);
  const [head, ...records] = recs;
  return { bom, header: head ? head.cells : [], records };
}

export const toObj = (header, cells) => Object.fromEntries(header.map((h, k) => [h, cells[k] ?? ""]));

// ── pure: row identity (the same rules review_pack carries marks by) ────────────

/**
 * Identity of a sheet row. Data rows: (file, data_path), stable across a text edit. Code rows (gd/tscn): (file, where_seen,
 * text), because their line moves when code above them changes; the line only breaks a tie.
 */
/** data_path as one canonical string: the sheet holds Python json.dumps (", " separators), a client may send JSON.stringify. */
export function normDataPath(dp) {
  const s = String(dp ?? "").trim();
  if (!s) return "";
  try { return JSON.stringify(JSON.parse(s)); } catch { return s; }
}

export function rowKey(r) {
  const file = String(r?.file ?? "");
  const dp = normDataPath(r?.data_path);
  return dp ? `d\u0000${file}\u0000${dp}` : `t\u0000${file}\u0000${String(r?.where_seen ?? "")}\u0000${csvUnsafe(r?.current_text ?? r?.seen ?? "")}`;
}

/** Index of the record a target names, or {error}. A target is {file, data_path, where_seen, line, seen}. */
export function findRecord(header, records, target) {
  const want = rowKey({ ...target, current_text: target.seen });
  const hits = [];
  for (let k = 0; k < records.length; k++) if (rowKey(toObj(header, records[k].cells)) === want) hits.push(k);
  if (target.data_path || hits.length <= 1) {
    if (hits.length === 1) return { index: hits[0] };
    if (!hits.length) return { error: "not-found" };
    return { error: "ambiguous" };
  }
  const li = header.indexOf("line");
  const same = hits.filter((k) => String(records[k].cells[li]) === String(target.line ?? ""));
  return same.length === 1 ? { index: same[0] } : { error: "ambiguous" };
}

/** owner_note split into the row's own note and its per-contract segments ("contract:<id>: <note>"). */
export function parseNote(note) {
  const own = [], contracts = new Map();
  for (const seg of String(note ?? "").split(NOTE_SEP)) {
    const s = seg.trim();
    if (!s) continue;
    const m = /^contract:([^:\s]+):\s*(.*)$/s.exec(s);
    if (m) contracts.set(m[1], m[2]); else own.push(s);
  }
  return { own: own.join(NOTE_SEP), contracts };
}
export function joinNote({ own, contracts }) {
  return [own, ...[...contracts].map(([id, n]) => `contract:${id}: ${n}`)].filter((s) => s && s.trim()).join(NOTE_SEP);
}

const clean = (s) => String(s ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_TEXT);

/**
 * Apply one mark to a row object (csv cells, already csv_safe'd as stored). Returns the new row object.
 *   ok    -> OWNER-OK, reviewed_hash = text_hash(current_text). A typed/drafted owner_rewrite stays (OK approves it).
 *   redo  -> NEEDS-REWRITE + note (row note replaced; contract:<id> segments kept). With contract: only that segment.
 *   edit  -> owner_rewrite = text, OWNER-OK, reviewed_hash. Text equal to the current text is a plain OK.
 *   clear -> the row's mark columns as they stand in `base` (the sheet before this review chain), else defaults.
 */
export function markRow(row, { action, note, text, contract, base } = {}) {
  const r = { ...row };
  const cur = csvUnsafe(r.current_text);
  if (action === "clear") {
    for (const c of MARK_COLS) r[c] = base ? base[c] ?? "" : "";
    if (!base) r.status = "STORY-TODO";
    return r;
  }
  if (action === "ok" || action === "edit") {
    if (action === "edit") {
      const t = clean(text);
      if (!t) throw new MarkError("edit needs text");
      if (t !== cur) r.owner_rewrite = csvSafe(t);
    }
    r.status = "OWNER-OK";
    r.reviewed_hash = textHash(cur);
    if (action === "ok" && contract && clean(note)) r.owner_note = csvSafe(withContractNote(csvUnsafe(r.owner_note), contract, clean(note)));
    return r;
  }
  if (action === "redo") {
    const n = clean(note);
    if (!n) throw new MarkError("redo needs a note");
    const parsed = parseNote(csvUnsafe(r.owner_note));
    if (contract) parsed.contracts.set(String(contract), n.replace(/\s*\|\s*/g, "; ")); else parsed.own = n.replace(/\s*\|\s*/g, "; ");
    r.owner_note = csvSafe(joinNote(parsed));
    r.status = "NEEDS-REWRITE";
    r.reviewed_hash = "";
    return r;
  }
  throw new MarkError(`unknown action ${action}`);
}
function withContractNote(note, contract, n) {
  const p = parseNote(note);
  p.contracts.set(String(contract), n.replace(/\s*\|\s*/g, "; "));
  return joinNote(p);
}

export class MarkError extends Error { constructor(m, status = 400) { super(m); this.name = "MarkError"; this.status = status; } }

/**
 * Apply a batch of marks to the sheet text. Each mark: {target:{file,data_path,where_seen,line,seen}, action, note?, text?,
 * contract?}. A mark whose row text no longer hashes to what the owner saw (`seen`) is refused as stale, per mark.
 * baseText (optional): the committed sheet, read for `clear`. Returns {text, results:[{ok, error?, status?, key?}], changed}.
 */
export function applyMarks(text, marks, { baseText = null } = {}) {
  const { header, records } = splitRecords(text);
  for (const c of ["current_text", "file", "data_path", ...MARK_COLS]) if (!header.includes(c)) throw new MarkError(`${SHEET} has no ${c} column; update EFI review_pack first`, 409);
  let base = null;
  const replace = new Map(); // record index -> new cells
  const results = [];
  for (const m of marks) {
    try {
      if (!m || typeof m !== "object" || !ACTIONS.has(m.action)) throw new MarkError("bad mark");
      const t = m.target ?? {};
      if (typeof t.file !== "string" || !t.file || typeof t.seen !== "string") throw new MarkError("target needs file and seen");
      const hit = findRecord(header, records, t);
      if (hit.error) { results.push({ ok: false, error: hit.error === "not-found" ? "stale: row not in the sheet (text or key changed)" : "ambiguous row" }); continue; }
      const rec = records[hit.index];
      const cells = replace.get(hit.index) ?? rec.cells;
      const row = toObj(header, cells);
      if (textHash(row.current_text) !== textHash(t.seen)) { results.push({ ok: false, error: "stale: the row's text changed since you saw it" }); continue; }
      let baseRow = null;
      if (m.action === "clear") {
        base ??= baseText == null ? { header, records: [] } : splitRecords(baseText);
        const bh = findRecord(base.header, base.records, t);
        baseRow = bh.error ? null : toObj(base.header, base.records[bh.index].cells);
      }
      const next = markRow(row, { action: m.action, note: m.note, text: m.text, contract: m.contract, base: baseRow });
      replace.set(hit.index, header.map((h) => next[h] ?? ""));
      results.push({ ok: true, status: next.status, key: rowKey(next) });
    } catch (e) {
      results.push({ ok: false, error: e instanceof MarkError ? e.message : String(e?.message ?? e) });
    }
  }
  if (!replace.size) return { text, results, changed: 0 };
  let out = "", at = 0;
  const idx = [...replace.keys()].sort((a, b) => a - b);
  for (const k of idx) {
    const rec = records[k];
    out += text.slice(at, rec.start) + pyRow(replace.get(k));
    at = rec.end;
  }
  out += text.slice(at);
  return { text: out, results, changed: idx.length };
}

/** The owner's marks in a sheet: rows with OWNER-OK / NEEDS-REWRITE, or a contract:<id> note. */
export function listMarks(text) {
  const { header, records } = splitRecords(text);
  const out = [];
  for (const rec of records) {
    const r = toObj(header, rec.cells);
    const st = String(r.status ?? "").trim();
    const note = csvUnsafe(r.owner_note);
    const parsed = parseNote(note);
    if (!OWNER_MARKS.has(st) && !parsed.contracts.size) continue;
    out.push({
      key: rowKey(r), file: r.file, line: r.line, data_path: r.data_path, where_seen: r.where_seen,
      status: st, note: parsed.own, contracts: Object.fromEntries(parsed.contracts), rewrite: csvUnsafe(r.owner_rewrite),
      text: csvUnsafe(r.current_text), hashOk: st !== "OWNER-OK" || r.reviewed_hash === textHash(r.current_text),
    });
  }
  return out;
}

// ── io: the EFI review branch + worktree ─────────────────────────────────────────

/** storybook/review-<UTC date>. */
export const reviewBranch = (now = new Date()) => `storybook/review-${new Date(now).toISOString().slice(0, 10)}`;

const git = async (cwd, args, o) => {
  const r = await runGit(cwd, args, o);
  if (!r.ok) throw new MarkError(`git ${args[0]} failed: ${(r.err || r.out).trim().split("\n").slice(-2).join(" ").slice(0, 240)}`, 500);
  return r.out.trim();
};

function runPython(cwd, args, { pythons = ["python3", "python"], timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const tryAt = (k) => {
      if (k >= pythons.length) return resolve({ ok: false, missing: true, out: "", code: null });
      execFile(pythons[k], args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        if (err && err.code === "ENOENT") return tryAt(k + 1);
        resolve({ ok: !err, code: err ? (typeof err.code === "number" ? err.code : null) : 0, out: String(stdout ?? "") + String(stderr ?? "") });
      });
    };
    tryAt(0);
  });
}

/** review_pack --check / --write in the worktree. {ok, missing, code, out}. */
export const reviewPack = (wt, mode, o) => fs.existsSync(path.join(wt, "tools/review_pack.py"))
  ? runPython(wt, ["tools/review_pack.py", mode], o)
  : Promise.resolve({ ok: false, missing: true, out: "", code: null });

const sessions = new Map(); // repo -> {chain: Promise, timer}
/** Serialize every write to one repo's review worktree. */
function locked(repo, fn) {
  const s = sessions.get(repo) ?? { chain: Promise.resolve(), timer: null };
  sessions.set(repo, s);
  const run = s.chain.then(fn, fn);
  s.chain = run.catch(() => {});
  return run;
}

async function reviewBranches(repo) {
  const r = await runGit(repo, ["for-each-ref", "--sort=-refname", "--format=%(refname:short)", "refs/heads/storybook/review-*"]);
  return r.out.split("\n").map((x) => x.trim()).filter(Boolean);
}
async function branchExists(repo, b) {
  return (await runGit(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}^{commit}`])).ok;
}
async function worktreeFor(repo, b) {
  const r = await runGit(repo, ["worktree", "list", "--porcelain"]);
  let p = null;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("worktree ")) p = line.slice(9);
    else if (line === `branch refs/heads/${b}` && p) return p;
  }
  return null;
}

/**
 * The review worktree for today's branch, created when absent. Never touches the main checkout's working tree and never
 * resets an existing branch. Base for a new branch: the newest storybook/review-* branch not yet merged into origin/main
 * (so yesterday's unmerged marks carry over; its pending marks are committed first), else origin/<default>.
 * On creation, a stale review pack gets one `review_pack --write` baseline commit, so later session commits only hold marks.
 */
export async function ensureSession(repo, { now = new Date(), create = true, wtPath, managedPath } = {}) {
  const branch = reviewBranch(now);
  const wt = await worktreeFor(repo, branch);
  if (wt && fs.existsSync(wt)) return { branch, path: wt, created: false };
  const main = `origin/${await defaultBranch(repo)}`;
  if (!create) {
    // Read side: no session today yet, so show the newest unmerged review branch's marks (they carry into today's).
    for (const b of await reviewBranches(repo)) {
      if ((await runGit(repo, ["merge-base", "--is-ancestor", b, main])).ok) continue;
      const p = await worktreeFor(repo, b);
      if (p && fs.existsSync(p)) return { branch: b, path: p, created: false };
      break;
    }
    return { branch, path: null, created: false };
  }
  const { resolveManagedWorktreePath } = await import("../team-worktrees.mjs");
  const dest = wtPath ?? (managedPath ?? resolveManagedWorktreePath)(repo, branch);
  if (fs.existsSync(dest)) throw new MarkError(`review worktree folder already exists but is not on ${branch}; remove it or finish that session`, 409);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (await branchExists(repo, branch)) {
    await git(repo, ["worktree", "add", dest, branch]);
    return { branch, path: dest, created: false };
  }
  let base = main;
  for (const b of await reviewBranches(repo)) {
    const merged = (await runGit(repo, ["merge-base", "--is-ancestor", b, main])).ok;
    if (merged) continue;
    const pwt = await worktreeFor(repo, b);
    if (pwt && fs.existsSync(pwt)) await commitIn(pwt, b, { reason: "carried into the next day's review branch" });
    base = b;
    break;
  }
  await git(repo, ["worktree", "add", "-b", branch, dest, base]);
  const baseline = await baselinePack(dest);
  return { branch, path: dest, created: true, base, baseline };
}

async function baselinePack(wt) {
  const chk = await reviewPack(wt, "--check");
  if (chk.missing) return { ran: false, reason: "python or tools/review_pack.py not found; review pack not regenerated" };
  if (chk.ok) return { ran: false, reason: "review pack already current" };
  const w = await reviewPack(wt, "--write");
  if (!w.ok) return { ran: true, ok: false, reason: `review_pack --write failed (exit ${w.code})` };
  await git(wt, ["add", "--", REVIEW_DIR]);
  if ((await runGit(wt, ["diff", "--cached", "--quiet"])).ok) return { ran: true, ok: true, committed: null };
  await git(wt, ["commit", "-q", "-m", "storybook review: review_pack --write baseline (the pack on main was stale)"]);
  return { ran: true, ok: true, committed: await git(wt, ["rev-parse", "HEAD"]) };
}

const readSheet = (wt) => fs.readFileSync(path.join(wt, SHEET), "utf8");

/** Pending (uncommitted) sheet changes in the worktree: changed row count vs HEAD. */
async function pendingRows(wt) {
  const r = await runGit(wt, ["diff", "--numstat", "--", SHEET]);
  const m = /^(\d+)\s+(\d+)/.exec(r.out.trim());
  return m ? Number(m[1]) : 0;
}

/** Commit pending marks in a worktree as one session commit (after `review_pack --write` so the branch passes --check). */
async function commitIn(wt, branch, { reason = "" } = {}) {
  const pending = await pendingRows(wt);
  if (!pending) return { committed: null, pending: 0 };
  const before = listMarks(readSheet(wt));
  const w = await reviewPack(wt, "--write");
  const after = listMarks(readSheet(wt));
  const lost = before.filter((m) => !after.some((a) => a.key === m.key && a.status === m.status));
  const n = { ok: 0, redo: 0, edit: 0, cleared: 0 };
  const head = await runGit(wt, ["show", `HEAD:${SHEET}`]);
  const prev = new Map(head.ok ? listMarks(head.out).map((m) => [m.key, m]) : []);
  for (const m of after) {
    const p = prev.get(m.key);
    if (p && p.status === m.status && p.note === m.note && p.rewrite === m.rewrite && JSON.stringify(p.contracts) === JSON.stringify(m.contracts)) continue;
    if (m.status !== "OWNER-OK") n.redo++;
    else if (m.rewrite) n.edit++;
    else n.ok++;
  }
  const afterKeys = new Set(after.map((m) => m.key));
  for (const k of prev.keys()) if (!afterKeys.has(k)) n.cleared++;
  await git(wt, ["add", "--", REVIEW_DIR]);
  if ((await runGit(wt, ["diff", "--cached", "--quiet"])).ok) return { committed: null, pending: 0 };
  const subject = `storybook review ${branch.replace(/^storybook\/review-/, "")}: ${n.ok} OK, ${n.redo} redo, ${n.edit} edit${n.cleared ? `, ${n.cleared} cleared` : ""}`;
  const body = [
    "Owner marks from VibeSquad Storybook (status / owner_note / owner_rewrite / reviewed_hash in docs/review/text_review.csv).",
    "Apply OWNER-OK rewrites with: python tools/review_pack.py --apply docs/review/text_review.csv",
    w.missing ? "review_pack --write NOT run (python or tools/review_pack.py not found): run it before --check." : w.ok ? "review_pack --write ran (pack regenerated)." : `review_pack --write failed (exit ${w.code}).`,
    lost.length ? `WARNING: ${lost.length} mark(s) did not survive --write: ${lost.slice(0, 5).map((m) => `${m.file}:${m.line} ${m.data_path}`).join("; ")}` : "",
    reason,
  ].filter(Boolean).join("\n");
  await git(wt, ["commit", "-q", "-m", subject, "-m", body]);
  return { committed: await git(wt, ["rev-parse", "HEAD"]), subject, counts: n, lost: lost.length, write: w.missing ? "missing" : w.ok ? "ok" : "failed", pending: 0 };
}

export const AUTO_COMMIT_MS = 10 * 60 * 1000;

/**
 * Marks API core, bound to one project repo. All writes are serialized per repo.
 *   get()          -> {branch, exists, head, pending, marks}
 *   set(marks)     -> {branch, results, pending}       (creates today's worktree on first write)
 *   commit()       -> {branch, committed, subject, counts, lost, write}
 */
export function marksFor(repo, { now = () => new Date(), autoCommitMs = AUTO_COMMIT_MS, ...o } = {}) {
  const schedule = (branch) => {
    const s = sessions.get(repo);
    if (!s || !autoCommitMs) return;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { locked(repo, async () => { const ses = await ensureSession(repo, { ...o, now: now(), create: false }); if (ses.path) await commitIn(ses.path, branch); }).catch((e) => console.warn(`[storybook] auto-commit failed: ${e?.message ?? e}`)); }, autoCommitMs);
    s.timer.unref?.();
  };
  return {
    get: () => locked(repo, async () => {
      const ses = await ensureSession(repo, { ...o, now: now(), create: false });
      if (!ses.path) return { branch: ses.branch, exists: false, head: null, pending: 0, marks: [] };
      return { branch: ses.branch, exists: true, head: await git(ses.path, ["rev-parse", "HEAD"]), pending: await pendingRows(ses.path), marks: listMarks(readSheet(ses.path)) };
    }),
    set: (marks) => {
      if (!Array.isArray(marks) || !marks.length) return Promise.reject(new MarkError("marks must be a non-empty array"));
      if (marks.length > MAX_BATCH) return Promise.reject(new MarkError(`at most ${MAX_BATCH} marks per request`));
      return locked(repo, async () => {
        const ses = await ensureSession(repo, { ...o, now: now() });
        const file = path.join(ses.path, SHEET);
        const text = fs.readFileSync(file, "utf8");
        const needBase = marks.some((m) => m?.action === "clear");
        // clear = back to the row's pre-review state: the sheet where this review chain left main
        let baseText = null;
        if (needBase) {
          const mb = await runGit(ses.path, ["merge-base", "HEAD", `origin/${await defaultBranch(repo)}`]);
          const shown = mb.ok ? await runGit(ses.path, ["show", `${mb.out.trim()}:${SHEET}`]) : { ok: false };
          baseText = shown.ok ? shown.out : null;
        }
        const res = applyMarks(text, marks, { baseText });
        if (res.changed) fs.writeFileSync(file, res.text, "utf8");
        schedule(ses.branch);
        return { branch: ses.branch, results: res.results, changed: res.changed, pending: await pendingRows(ses.path), marks: listMarks(res.text), created: ses.created, baseline: ses.baseline ?? null };
      });
    },
    commit: () => locked(repo, async () => {
      const ses = await ensureSession(repo, { ...o, now: now(), create: false });
      if (!ses.path) return { branch: ses.branch, committed: null, pending: 0 };
      clearTimeout(sessions.get(repo)?.timer);
      return { branch: ses.branch, ...(await commitIn(ses.path, ses.branch)) };
    }),
  };
}
