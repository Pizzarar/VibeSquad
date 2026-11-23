#!/usr/bin/env node
// Forge cutover C2 (docs/PLAN_FORGE_CUTOVER.md C2/C2a): carry the untracked + ignored docs/** of each main checkout
// (lane briefs docs/brainstorm/<lane>.md read by server/brainstorm.mjs, docs/lanes/<lane>/{SPEC.md,TASKS.json}, plans)
// into the forge's fresh clones, and check on the forge that every lane in teams.json has its brief.
//
//   node scripts/forge-docs-sync.mjs --sync-docs --from-projects <projects root> --to <dest projects root | host:dir>
//        [--repo <name>]... [--as <src name>=<dest name>]... [--staging <dir>] [--dry-run] [--json]
//   node scripts/forge-docs-sync.mjs --verify-briefs --teams <teams.json> [--projects-root <dir>] [--vs-root <dir>] [--json]
//   (scripts/forge-migrate.mjs --sync-docs / --verify-briefs dispatch here.)
//
// --sync-docs. Source: every folder directly under --from-projects whose `.git` is a directory (a main checkout, not a
// linked worktree), or only the --repo names. The dest clone has the same folder name unless `--as <src>=<dest>` maps it
// (Linux is case-sensitive: a dev pp folder `game` that teams.json calls `Game` must be cloned and synced as `Game`). Per repo `git ls-files --others -z -- docs` (untracked, ignored included).
// Skipped and reported: path segments node_modules/.godot/.import/dist/build, files over 200 MB, anything that is not a
// regular file. The source is only read (git runs with --no-optional-locks).
// Dest: never writes a path the dest clone tracks in git; a dest file that exists and differs is kept and reported as a
// conflict; an identical one counts as "same". A dest repo folder that is not a git checkout is reported (not cloned)
// and nothing is written there.
//   Local dest: before every mkdir / copy the nearest existing ancestor is realpath'd (junctions and symlinks resolved);
//   the write is refused if it lands inside the source projects root or outside the dest repo (a link escape). Copies
//   use COPYFILE_EXCL (never replace) and are re-hashed against the source.
//   Remote dest `host:dir` (OpenSSH, BatchMode): every eligible file is first copied into a local staging dir
//   (--staging, default <tmp>/vs-docs-sync-<ts>; never deleted, its path is in the report). Per repo, over ssh:
//   `git ls-files -s -z -- docs` (tracked paths and tracked symlinks), `sha256sum` of the candidates that exist, then
//   the new files as one tar stream (`tar --null -T -` locally, `tar -x -k` remotely: existing files are never
//   replaced) and a final `sha256sum` that must match the local hashes. The remote side needs only cd, git, sha256sum
//   and tar. A path under a tracked symlink is skipped.
// --dry-run reads only (a remote dry run still probes over ssh): per repo files, bytes, would-copy, same, conflicts,
// skipped.
//
// --verify-briefs (read-only, run on the forge): every lane of every team in teams.json except state "removed" and hidden
// helper lanes (`hidden: true`, Bug Runner / Perfection: no Buddy brief, a gap there is a warning) must have
// <project dir>/docs/brainstorm/<lane>.md, the project dir resolved like server/brief-path.mjs laneWorkingDir (lane
// paths, then team paths; relative names under --projects-root, default ~/projects; absolute paths only inside it),
// falling back to --vs-root (default <projects-root>/VibeSquad) like briefRootFor. Missing docs/lanes/<lane>/ dirs are
// warnings. Exit 1 if any brief is missing.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fmtBytes, realOfNearest } from "./forge-migrate.mjs";

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const SKIP_SEGMENTS = ["node_modules", ".godot", ".import", "dist", "build"];
const SHA_BATCH_CHARS = 16_000; // stays well under the Windows 32k command line for ssh.exe
const LIST_CAP = 50;

// ---------------------------------------------------------------- args
const VALUE_FLAGS = ["from-projects", "to", "staging", "teams", "projects-root", "vs-root"];
const BOOL_FLAGS = { "sync-docs": "syncDocs", "verify-briefs": "verifyBriefs", "dry-run": "dryRun", json: "json", help: "help" };
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function parseArgs(argv) {
  const out = { syncDocs: false, verifyBriefs: false, dryRun: false, json: false, help: false, repo: [], as: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") { out.help = true; continue; }
    if (!a.startsWith("--")) throw new Error(`unknown argument: ${a}`);
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (name in BOOL_FLAGS) {
      if (inline !== undefined) throw new Error(`--${name} takes no value`);
      out[BOOL_FLAGS[name]] = true;
    } else if (VALUE_FLAGS.includes(name) || name === "repo" || name === "as") {
      const v = inline !== undefined ? inline : argv[++i];
      if (!v || (inline === undefined && v.startsWith("--"))) throw new Error(`--${name} needs a value`);
      if (name === "repo" || name === "as") out[name].push(v); else out[camel(name)] = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

// ---------------------------------------------------------------- path helpers
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
function isInside(child, parent) {
  const rel = relative(parent, child);
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
const insideOrSame = (p, root) => samePath(p, root) || isInside(p, root);

/** `host:dir` -> { host, dir }; a drive path (`C:\x`, `C:/x`) or anything without a host part is local (null). */
export function parseRemote(to) {
  const m = /^([^:/\\]+):(.+)$/.exec(String(to));
  if (!m || /^[A-Za-z]$/.test(m[1])) return null;
  if (!/^[A-Za-z0-9._@-]+$/.test(m[1]) || m[1].startsWith("-")) throw new Error(`refusing: bad ssh host in --to: ${m[1]}`);
  return { host: m[1], dir: m[2].replace(/\/+$/, "") || "/" };
}

/** POSIX shell quote. A leading `~/` stays unquoted so the remote shell expands it. */
export function shq(s) {
  const str = String(s);
  if (str === "~") return "~";
  if (str.startsWith("~/")) return `~/${shq(str.slice(2))}`;
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Refuse a write whose real location is outside `repoReal` (link escape) or inside `srcReal` (the read-only source). */
function assertDestWrite(target, repoReal, srcReal) {
  const r = realOfNearest(target);
  if (srcReal && insideOrSame(r, srcReal)) throw new Error(`refusing: a write to ${target} would land in the source (${srcReal})`);
  if (!isInside(r, repoReal)) throw new Error(`refusing: a write to ${target} resolves outside ${repoReal} (${r}): link or junction escape`);
  return r;
}

function guardedMkdir(dir, repoReal, srcReal) {
  assertDestWrite(join(dir, "x"), repoReal, srcReal);
  mkdirSync(dir, { recursive: true });
  assertDestWrite(join(dir, "x"), repoReal, srcReal); // re-check: a link created in between is caught here
}

/** Copies `src` to `dest` without ever replacing an existing file; returns the sha256 of the written copy. */
function guardedCopy(src, dest, repoReal, srcReal, st) {
  guardedMkdir(dirname(dest), repoReal, srcReal);
  assertDestWrite(dest, repoReal, srcReal);
  copyFileSync(src, dest, constants.COPYFILE_EXCL);
  try { utimesSync(dest, st.atime, st.mtime); } catch {}
  return sha256File(dest);
}

// ---------------------------------------------------------------- git (read-only)
function git(cwd, args) {
  const r = spawnSync("git", ["--no-optional-locks", "-c", "gc.auto=0", "-C", cwd, ...args], {
    windowsHide: true, timeout: 600_000, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(String(r.stderr || "").trim().split("\n")[0] || `git ${args[0]} exited ${r.status}`);
  return r.stdout.toString("utf8");
}

/** `git ls-files -s -z` output -> { tracked: Set<path>, links: [path] } (mode 120000 = symlink). */
export function parseLsFilesStage(out) {
  const tracked = new Set();
  const links = [];
  for (const rec of out.split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const path = rec.slice(tab + 1);
    tracked.add(path);
    if (rec.startsWith("120000 ")) links.push(path);
  }
  return { tracked, links };
}

const FOLDER_NAME = /^(?!\.\.?$)[^\\/:]+$/;

/** `--as src=dest` list -> Map(src -> dest). Both sides must be plain folder names. */
export function parseAs(list = []) {
  const m = new Map();
  for (const item of list) {
    const [a, b] = String(item).split("=");
    if (!FOLDER_NAME.test(a ?? "") || !FOLDER_NAME.test(b ?? "")) throw new Error(`--as needs <src folder>=<dest folder>: ${item}`);
    m.set(a, b);
  }
  return m;
}

const underLink = (rel, links) => links.find((l) => rel === l || rel.startsWith(`${l}/`)) ?? null;

// ---------------------------------------------------------------- source
/** Main checkouts directly under `root` (`.git` is a directory); `names` restricts and must all exist. */
export function listRepos(root, names = []) {
  if (names.length) {
    return names.map((n) => {
      if (!/^[^\\/]+$/.test(n) || n === "." || n === "..") throw new Error(`--repo must be a folder name: ${n}`);
      const d = join(root, n);
      let st = null;
      try { st = lstatSync(join(d, ".git")); } catch {}
      if (!st?.isDirectory()) throw new Error(`--repo ${n}: ${d} is not a main git checkout`);
      return n;
    });
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (() => { try { return lstatSync(join(root, e.name, ".git")).isDirectory(); } catch { return false; } })())
    .map((e) => e.name)
    .sort();
}

/** Eligible untracked docs files of one source checkout: { files: [{ rel, abs, size, st }], skipped: [{ rel, reason }] }. */
export function sourceDocs(repoDir) {
  const files = [];
  const skipped = [];
  const out = git(repoDir, ["ls-files", "--others", "-z", "--", "docs"]);
  for (const rel of out.split("\0").filter(Boolean).sort()) {
    if (rel.endsWith("/")) { skipped.push({ rel, reason: "nested git repo" }); continue; }
    const seg = rel.split("/").find((s) => SKIP_SEGMENTS.includes(s));
    if (seg) { skipped.push({ rel, reason: seg }); continue; }
    if (/[\n\r\\]/.test(rel)) { skipped.push({ rel, reason: "unsafe file name" }); continue; }
    const abs = join(repoDir, ...rel.split("/"));
    let st;
    try { st = lstatSync(abs); } catch (e) { skipped.push({ rel, reason: `unreadable: ${e.code || e.message}` }); continue; }
    if (!st.isFile()) { skipped.push({ rel, reason: st.isSymbolicLink() ? "link" : "not a regular file" }); continue; }
    if (st.size > MAX_FILE_BYTES) { skipped.push({ rel, reason: `over 200 MB (${fmtBytes(st.size)})`, bytes: st.size }); continue; }
    files.push({ rel, abs, size: st.size, st });
  }
  return { files, skipped };
}

// ---------------------------------------------------------------- remote transport
function tarInfo() {
  if (process.platform === "win32") return { bin: join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "tar.exe"), bsd: true };
  const v = spawnSync("tar", ["--version"], { encoding: "utf8" });
  return { bin: "tar", bsd: !/GNU tar/.test(String(v.stdout)) };
}

/** Runs `cd <dir> && <cmd>` on `host`. deps.ssh = [bin, ...leadingArgs] (tests pass a local double). */
function sshRun(deps, host, dir, cmd, input) {
  const [bin, ...pre] = deps.ssh ?? ["ssh"];
  const r = spawnSync(bin, [...pre, "-o", "BatchMode=yes", "--", host, `cd ${shq(dir)} && ${cmd}`], {
    input, windowsHide: true, timeout: 600_000, maxBuffer: 1024 * 1024 * 1024,
  });
  if (r.error) throw new Error(`ssh: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8").trim() };
}

/** sha256sum of `rels` (relative to the remote repo dir), batched; files that do not exist are simply absent. */
function remoteHashes(deps, host, repoDir, rels) {
  const out = new Map();
  let batch = [];
  let len = 0;
  const flush = () => {
    if (!batch.length) return;
    const r = sshRun(deps, host, repoDir, `sha256sum -- ${batch.map(shq).join(" ")}`);
    for (const line of r.stdout.split("\n")) {
      const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
      if (m) out.set(m[2], m[1]);
    }
    batch = [];
    len = 0;
  };
  for (const rel of rels) {
    const q = shq(rel);
    if (len + q.length > SHA_BATCH_CHARS) flush();
    batch.push(rel);
    len += q.length + 1;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- sync
const stampOf = (now) => now.toISOString().replace(/[:.]/g, "-");

/**
 * Copies the untracked docs of each source checkout into the matching dest clone. Returns the summary
 * { mode, from, to, remote, staging, repos: [...], totals, errors }.
 */
export function syncDocs(opts, deps = {}) {
  if (!opts.fromProjects) throw new Error("--from-projects is required");
  if (!opts.to) throw new Error("--to is required");
  const from = resolve(opts.fromProjects);
  if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(`--from-projects is not a directory: ${from}`);
  const srcReal = realOfNearest(from);
  const remote = parseRemote(opts.to);
  const to = remote ? null : resolve(opts.to);
  if (to) {
    const rt = realOfNearest(to);
    if (insideOrSame(rt, srcReal)) throw new Error(`refusing: --to is the source or inside it (${rt})`);
    if (isInside(srcReal, rt)) throw new Error(`refusing: the source is inside --to (${srcReal})`);
  }
  const destNames = parseAs(opts.as);
  const now = deps.now ?? new Date();
  let staging = null;
  let stagingReal = null;
  if (remote && !opts.dryRun) {
    staging = resolve(opts.staging || join(tmpdir(), `vs-docs-sync-${stampOf(now)}`));
    stagingReal = realOfNearest(staging);
    if (insideOrSame(stagingReal, srcReal) || isInside(srcReal, stagingReal)) throw new Error(`refusing: --staging overlaps the source (${staging})`);
    if (existsSync(staging) && readdirSync(staging).length) throw new Error(`refusing: --staging is not empty (${staging})`);
    mkdirSync(staging, { recursive: true });
    stagingReal = realOfNearest(staging);
  }
  const summary = {
    mode: opts.dryRun ? "sync-docs-dry-run" : "sync-docs", from, to: to ?? `${remote.host}:${remote.dir}`, remote: !!remote,
    staging, repos: [], totals: { files: 0, bytes: 0, copied: 0, same: 0, conflicts: 0, skipped: 0, notCloned: 0 }, errors: [],
  };
  for (const name of listRepos(from, opts.repo ?? [])) {
    const destName = destNames.get(name) ?? name;
    const rep = { repo: name, ...(destName !== name ? { dest: destName } : {}), files: 0, bytes: 0, copied: 0, same: 0, conflicts: [], skipped: [], destState: "cloned", errors: [] };
    summary.repos.push(rep);
    try {
      const src = sourceDocs(join(from, name));
      rep.skipped.push(...src.skipped);
      rep.files = src.files.length;
      rep.bytes = src.files.reduce((n, f) => n + f.size, 0);
      if (!src.files.length) continue;
      if (remote) syncRepoRemote(rep, src.files, { remote, name: destName, staging, stagingReal, srcReal, dryRun: opts.dryRun, deps });
      else syncRepoLocal(rep, src.files, { destRepo: join(to, destName), srcReal, dryRun: opts.dryRun });
    } catch (e) {
      rep.errors.push(e.message);
    }
  }
  for (const r of summary.repos) {
    const t = summary.totals;
    t.files += r.files; t.bytes += r.bytes; t.copied += r.copied; t.same += r.same; t.conflicts += r.conflicts.length; t.skipped += r.skipped.length;
    if (r.destState !== "cloned") t.notCloned++;
    for (const e of r.errors) summary.errors.push(`${r.repo}: ${e}`);
  }
  return summary;
}

/** Decides per candidate: copy / same / conflict / skip, given dest tracked paths, tracked links and existing hashes. */
function classify(rep, files, { tracked, links, destHash, srcHash }) {
  const send = [];
  for (const f of files) {
    const link = underLink(f.rel, links);
    if (link) { rep.skipped.push({ rel: f.rel, reason: `under a tracked link in the dest (${link})` }); continue; }
    const have = destHash(f);
    if (have !== null) {
      if (have === srcHash(f)) { rep.same++; continue; }
      rep.conflicts.push({ rel: f.rel, reason: tracked.has(f.rel) ? "tracked in dest, differs" : "exists in dest, differs (dest kept)" });
      continue;
    }
    if (tracked.has(f.rel)) { rep.conflicts.push({ rel: f.rel, reason: "tracked in dest (missing from its checkout)" }); continue; }
    send.push(f);
  }
  return send;
}

function syncRepoLocal(rep, files, { destRepo, srcReal, dryRun }) {
  if (!existsSync(join(destRepo, ".git"))) { rep.destState = existsSync(destRepo) ? "not a git checkout" : "not cloned"; return; }
  const repoReal = realOfNearest(destRepo);
  if (insideOrSame(repoReal, srcReal)) throw new Error(`refusing: dest repo resolves into the source (${repoReal})`);
  const { tracked, links } = parseLsFilesStage(git(destRepo, ["ls-files", "-s", "-z", "--", "docs"]));
  const hashes = new Map();
  const srcHash = (f) => { if (!hashes.has(f.rel)) hashes.set(f.rel, sha256File(f.abs)); return hashes.get(f.rel); };
  const destPath = (f) => join(destRepo, ...f.rel.split("/"));
  const destHash = (f) => {
    const p = destPath(f);
    let st = null;
    try { st = lstatSync(p); } catch { return null; }
    if (!st.isFile()) return "not-a-regular-file";
    return sha256File(p);
  };
  const send = classify(rep, files, { tracked, links, destHash, srcHash });
  if (dryRun) { rep.copied = send.length; return; }
  for (const f of send) {
    try {
      const got = guardedCopy(f.abs, destPath(f), repoReal, srcReal, f.st);
      if (got !== srcHash(f)) rep.errors.push(`hash mismatch after copy: ${f.rel}`);
      else rep.copied++;
    } catch (e) {
      rep.errors.push(`${f.rel}: ${e.message}`);
    }
  }
}

function syncRepoRemote(rep, files, { remote, name, staging, stagingReal, srcReal, dryRun, deps }) {
  const repoDir = `${remote.dir}/${name}`;
  const probe = sshRun(deps, remote.host, repoDir, "git ls-files -s -z -- docs");
  if (probe.status !== 0) { rep.destState = `not cloned or not a git checkout (${probe.stderr.split("\n")[0] || `exit ${probe.status}`})`; return; }
  const { tracked, links } = parseLsFilesStage(probe.stdout);
  const existing = remoteHashes(deps, remote.host, repoDir, files.map((f) => f.rel));
  const hashes = new Map();
  const srcHash = (f) => { if (!hashes.has(f.rel)) hashes.set(f.rel, sha256File(f.abs)); return hashes.get(f.rel); };
  const send = classify(rep, files, { tracked, links, destHash: (f) => existing.get(f.rel) ?? null, srcHash });
  if (dryRun) { rep.copied = send.length; return; }
  // Stage every eligible file (the kept local copy), then ship only the new ones.
  const stageRepo = join(staging, name);
  for (const f of files) {
    const got = guardedCopy(f.abs, join(stageRepo, ...f.rel.split("/")), stagingReal, srcReal, f.st);
    if (got !== srcHash(f)) throw new Error(`staging hash mismatch: ${f.rel}`);
  }
  if (!send.length) return;
  const { bin, bsd } = deps.tar ?? tarInfo();
  const args = ["--null", "-c", "-f", "-"];
  if (!bsd) args.push("--verbatim-files-from");
  args.push("-C", stageRepo, "-T", "-");
  const t = spawnSync(bin, args, { input: send.map((f) => `${f.rel}\0`).join(""), windowsHide: true, maxBuffer: 2 * 1024 * 1024 * 1024 });
  if (t.error) throw new Error(`${bin}: ${t.error.message}`);
  if (t.status !== 0) throw new Error(`${bin} exited ${t.status}: ${t.stderr.toString("utf8").trim().slice(0, 300)}`);
  const x = sshRun(deps, remote.host, repoDir, "tar -x -k -f -", t.stdout);
  if (x.status !== 0) rep.errors.push(`remote tar exited ${x.status}: ${x.stderr.slice(0, 300)}`);
  const after = remoteHashes(deps, remote.host, repoDir, send.map((f) => f.rel));
  for (const f of send) {
    const got = after.get(f.rel);
    if (got === srcHash(f)) rep.copied++;
    else rep.errors.push(got ? `hash mismatch on the forge: ${f.rel}` : `missing on the forge after copy: ${f.rel}`);
  }
}

// ---------------------------------------------------------------- verify-briefs
const safeSegment = (v) => String(v ?? "").trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "vibesquad";
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** Project dir of a lane, as server/brief-path.mjs laneWorkingDir resolves it against one projects root; null if none. */
export function laneProjectDir(team, lane, projectsRoot) {
  const candidates = [...(lane?.paths ?? []), ...(lane?.path ? [lane.path] : []), ...(team?.paths ?? [])]
    .map((p) => String(p ?? "").trim()).filter(Boolean);
  for (const raw of candidates) {
    if (/^[\\/]{2}/.test(raw)) continue;
    const full = isAbsolute(raw) ? resolve(raw) : resolve(projectsRoot, raw);
    if (!isInside(full, projectsRoot)) continue;
    if (isDir(full)) return full;
  }
  return null;
}

export function verifyBriefs(opts) {
  if (!opts.teams) throw new Error("--teams is required");
  const projectsRoot = resolve(opts.projectsRoot || join(homedir(), "projects"));
  const vsRoot = resolve(opts.vsRoot || join(projectsRoot, "VibeSquad"));
  const raw = readFileSync(opts.teams, "utf8").replace(/^\uFEFF/, "");
  const teams = JSON.parse(raw).teams ?? [];
  const out = { mode: "verify-briefs", teams: opts.teams, projectsRoot, vsRoot, lanes: 0, present: 0, missing: [], warnings: [] };
  for (const team of teams) {
    for (const lane of team.lanes ?? []) {
      if (lane.state === "removed") continue;
      out.lanes++;
      const dir = laneProjectDir(team, lane, projectsRoot);
      const root = dir ?? vsRoot;
      const id = safeSegment(lane.id);
      const brief = join(root, "docs", "brainstorm", `${id}.md`);
      const where = { team: team.id, lane: lane.id, root: dir ? basename(dir) : `${basename(vsRoot)} (fallback: no project dir resolved)` };
      if (existsSync(brief)) out.present++;
      // Hidden helper lanes (kind bug / audit: Bug Runner, Perfection) get no Buddy brief; a gap there is only a warning.
      else if (lane.hidden) out.warnings.push({ ...where, path: brief, reason: "hidden lane, no brief" });
      else out.missing.push({ ...where, path: brief });
      if (!isDir(join(root, "docs", "lanes", lane.id))) out.warnings.push({ ...where, path: join(root, "docs", "lanes", lane.id), reason: "no docs/lanes/<lane>/ dir" });
    }
  }
  return out;
}

// ---------------------------------------------------------------- output
function printSync(s, log) {
  log(`${s.mode}: ${s.from} -> ${s.to}${s.staging ? `\nstaging copy (kept, never deleted): ${s.staging}` : ""}`);
  const verb = s.mode.endsWith("dry-run") ? "would copy" : "copied";
  for (const r of s.repos) {
    log(`  ${r.repo}${r.dest ? ` -> ${r.dest}` : ""}: ${r.files} files, ${fmtBytes(r.bytes)}; ${verb} ${r.copied}, same ${r.same}, conflicts ${r.conflicts.length}, skipped ${r.skipped.length}${r.destState !== "cloned" ? `  [dest ${r.destState}]` : ""}`);
    for (const c of r.conflicts.slice(0, LIST_CAP)) log(`    CONFLICT ${c.rel}: ${c.reason}`);
    if (r.conflicts.length > LIST_CAP) log(`    ... ${r.conflicts.length - LIST_CAP} more conflicts`);
    const bigOrOdd = r.skipped.filter((k) => !SKIP_SEGMENTS.includes(k.reason));
    for (const k of bigOrOdd.slice(0, LIST_CAP)) log(`    SKIPPED ${k.rel}: ${k.reason}`);
    const bySeg = SKIP_SEGMENTS.map((seg) => [seg, r.skipped.filter((k) => k.reason === seg).length]).filter(([, n]) => n);
    if (bySeg.length) log(`    skipped by folder: ${bySeg.map(([seg, n]) => `${seg} ${n}`).join(", ")}`);
    for (const e of r.errors) log(`    ERROR ${e}`);
  }
  const t = s.totals;
  log(`total: ${s.repos.length} repos, ${t.files} files, ${fmtBytes(t.bytes)}; ${verb} ${t.copied}, same ${t.same}, conflicts ${t.conflicts}, skipped ${t.skipped}, dest not cloned ${t.notCloned}, errors ${s.errors.length}`);
}

function printVerify(v, log) {
  log(`verify-briefs: ${v.present}/${v.lanes} lane briefs present (projects root ${v.projectsRoot})`);
  for (const m of v.missing) log(`  MISSING ${m.team}/${m.lane}: ${m.path}`);
  for (const w of v.warnings.slice(0, LIST_CAP * 2)) log(`  warning ${w.team}/${w.lane}: ${w.reason} (${w.root})`);
  log(v.missing.length ? `FAIL: ${v.missing.length} brief(s) missing` : "OK: every lane has its brief");
}

const USAGE = `usage:
  node scripts/forge-docs-sync.mjs --sync-docs --from-projects <projects root> --to <dest projects root | host:dir>
       [--repo <name>]... [--as <src name>=<dest name>]... [--staging <dir>] [--dry-run] [--json]
  node scripts/forge-docs-sync.mjs --verify-briefs --teams <teams.json> [--projects-root <dir>] [--vs-root <dir>] [--json]
See the header of this file and docs/lanes/forge-host/RUNBOOK.md (C2).`;

export function main(argv = process.argv.slice(2), log = console.log, err = console.error, deps = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) { err(`${e.message}\n${USAGE}`); return 2; }
  if (args.help) { log(USAGE); return 0; }
  if (args.syncDocs === args.verifyBriefs) { err(`pass exactly one of --sync-docs or --verify-briefs\n${USAGE}`); return 2; }
  try {
    if (args.verifyBriefs) {
      const v = verifyBriefs(args);
      if (args.json) log(JSON.stringify(v, null, 2)); else printVerify(v, log);
      return v.missing.length ? 1 : 0;
    }
    const s = syncDocs(args, deps);
    if (args.json) log(JSON.stringify(s, null, 2)); else printSync(s, log);
    return s.errors.length ? 1 : 0;
  } catch (e) {
    err(`forge-docs-sync: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
