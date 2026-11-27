// Storybook API (SB4): project key -> pinned-sha snapshot with findings, an in-memory per-(project, sha) cache, and the two
// HTTP routes + CLI summary line that sit on top of it. Report-only: nothing here gates anything.
//
// Project config is VS's existing teams.json: the project key is a Squad (team) id, its repo is the first entry of
// team.paths that resolves to a git checkout (brief-path.mjs resolveProjectPath, the same resolver schedules/spawn use).
// ADAPTERS maps team id -> adapter; a project with no adapter (or no resolvable repo) is "unknown" (404).
import fs from "node:fs";
import path from "node:path";
import { efiAdapter } from "./adapters/efi.mjs";
import { assertAdapter } from "./adapter.mjs";
import { defaultBranch, fetchRepo, makeReader, resolveRef } from "./git-read.mjs";
import { makeSnapshot } from "./schema.mjs";
import { SIGNALS } from "../registry/audit.mjs";
import { buildArc } from "./unlocks.mjs";
import { QUOTED_HOST_PATH } from "../team-worktrees.mjs";
import { diffChanges, readSeen, seenRecord, writeSeen } from "./changes.mjs";
import { buildGlossary } from "./glossary.mjs";
import { buildProgress } from "./progress.mjs";

/** team id -> adapter. Add a project here; never a repo path (those come from teams.json). */
export const ADAPTERS = Object.freeze({ efi: efiAdapter });

export class StorybookError extends Error {
  constructor(status, message) { super(message); this.name = "StorybookError"; this.status = status; }
}

const CACHE_PER_PROJECT = 4;
const cache = new Map();    // `${project}\0${sha}` -> snapshot
const order = new Map();    // project -> [sha...] oldest first
const inflight = new Map(); // project -> {promise: Promise<{snapshot, fetch}>, refresh}

export function clearStorybookCache() { cache.clear(); order.clear(); inflight.clear(); }

function remember(project, sha, snap) {
  cache.set(`${project}\0${sha}`, snap);
  const list = (order.get(project) ?? []).filter((s) => s !== sha);
  list.push(sha);
  while (list.length > CACHE_PER_PROJECT) cache.delete(`${project}\0${list.shift()}`);
  order.set(project, list);
}

const isGitDir = (p) => { try { return fs.existsSync(path.join(p, ".git")); } catch { return false; } };

/**
 * projectKey -> {adapter, repoPath, key} from teams.json, or null. Injectable: opts.teams (array), opts.adapters,
 * opts.resolvePath(p) (default resolveProjectPath).
 */
export async function resolveProject(projectKey, { rootDir, teams, adapters = ADAPTERS, resolvePath } = {}) {
  const key = String(projectKey ?? "").trim().toLowerCase();
  if (!key || !Object.hasOwn(adapters, key)) return null;
  const adapter = adapters[key];
  let list = teams;
  if (!list) {
    const { readTeamsConfig } = await import("../teams-file.mjs");
    list = readTeamsConfig(rootDir).teams;
  }
  const team = list.find((t) => String(t?.id ?? "").toLowerCase() === key);
  if (!team) return null;
  let rp = resolvePath;
  if (!rp) {
    const { resolveProjectPath } = await import("../brief-path.mjs");
    rp = (p) => resolveProjectPath(p, rootDir);
  }
  let repoPath = null;
  for (const p of team.paths ?? []) {
    const full = rp(String(p ?? "").trim());
    if (full && isGitDir(full)) { repoPath = full; break; }
  }
  repoPath ??= adapter.defaultRepoPath ?? null;
  return repoPath ? { adapter, repoPath, key } : null;
}

async function loadRunChecks(injected) {
  if (injected) return { runChecks: injected, runAudit: null, warning: null };
  try {
    const mod = await import("./checks/index.mjs");
    if (typeof mod.runChecks === "function") return {
      runChecks: mod.runChecks,
      runAudit: typeof mod.runAudit === "function" ? mod.runAudit : null,
      warning: null,
    };
    return { runChecks: null, runAudit: null, warning: "checks module has no runChecks export; findings empty" };
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND" && /checks[\\/]index\.mjs/.test(String(e.message))) return { runChecks: null, runAudit: null, warning: "checks module not available; findings empty" };
    return { runChecks: null, runAudit: null, warning: `checks module failed to load (${String(e?.message ?? e).slice(0, 120)}); findings empty` };
  }
}

async function buildOnce(project, { refresh, deps }) {
  const proj = await (deps.resolveProject ?? resolveProject)(project, deps);
  if (!proj) throw new StorybookError(404, `unknown storybook project: ${project}`);
  const { adapter, repoPath } = proj;
  assertAdapter(adapter);
  let fetch = null;
  if (refresh) {
    const r = await (deps.fetchRepo ?? fetchRepo)(repoPath, deps.fetchOpts ?? {});
    fetch = { fetched: Boolean(r.fetched), nextFetchAt: r.nextAllowedAt ? new Date(r.nextAllowedAt).toISOString() : null, skipped: r.skipped ?? null };
  }
  let sha, ref;
  try {
    ref = `origin/${await defaultBranch(repoPath)}`;
    sha = await resolveRef(repoPath, ref);
  } catch (e) {
    console.warn(`[storybook] ${project}: cannot resolve origin default branch: ${String(e?.message ?? e).slice(0, 300)}`); // detail stays server-side (host path hygiene)
    throw new StorybookError(404, `storybook unavailable for ${project}: ref not resolvable`);
  }
  const hit = cache.get(`${project}\0${sha}`);
  if (hit) return { snapshot: hit, fetch };
  const reader = makeReader(repoPath, sha);
  const { entities, warnings, dropped } = await adapter.load(reader, sha);
  const snap = makeSnapshot({ project: adapter.id, ref, sha, entities, warnings: [...warnings] });
  if (Array.isArray(dropped) && dropped.length) Object.defineProperty(snap, "dropped", { value: dropped, enumerable: false, configurable: true }); // V8: server-only adapter-excluded rows for changes.mjs (keep out of JSON schema)
  try { snap.glossary = await buildGlossary(snap.entities, reader); } catch (e) { snap.warnings.push(`glossary failed: ${String(e?.message ?? e).slice(0, 200)}`); }
  const { runChecks, runAudit, warning } = await loadRunChecks(deps.runChecks);
  if (warning) snap.warnings.push(warning);
  if (runChecks) {
    try {
      const res = await runChecks(snap, adapter, { reader });
      const findings = Array.isArray(res) ? res : res?.findings;
      snap.findings = Array.isArray(findings) ? findings : [];
    } catch (e) {
      snap.findings = [];
      snap.warnings.push(`checks failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  if (runAudit) {
    try {
      const audit = await runAudit(snap, adapter, { reader, findings: snap.findings });
      snap.audit = Array.isArray(audit) ? audit : [];
    } catch (e) {
      snap.warnings.push(`audit failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  try { snap.arc = buildArc(snap.entities); } catch (e) { snap.warnings.push(`arc failed: ${String(e?.message ?? e).slice(0, 200)}`); }
  try { snap.progress = buildProgress(snap); } catch (e) { snap.warnings.push(`progress failed: ${String(e?.message ?? e).slice(0, 200)}`); }
  remember(project, sha, snap);
  return { snapshot: snap, fetch };
}

/** Cheap existence probe (HEAD): resolves project + adapter + origin ref only; builds no snapshot, fetches nothing. Throws StorybookError(404). */
export async function probeProject(projectKey, deps = {}) {
  const project = String(projectKey ?? "").trim().toLowerCase();
  const proj = await (deps.resolveProject ?? resolveProject)(project, deps);
  if (!proj) throw new StorybookError(404, `unknown storybook project: ${project}`);
  assertAdapter(proj.adapter);
  try {
    await resolveRef(proj.repoPath, `origin/${await defaultBranch(proj.repoPath)}`);
  } catch (e) {
    console.warn(`[storybook] ${project}: probe cannot resolve origin default branch: ${String(e?.message ?? e).slice(0, 300)}`);
    throw new StorybookError(404, `storybook unavailable for ${project}: ref not resolvable`);
  }
  return true;
}

/** Like buildSnapshot but also returns the fetch outcome: {snapshot, fetch:{fetched,nextFetchAt,skipped}|null}. */
export async function buildSnapshotDetailed(projectKey, { refresh = false, ...deps } = {}) {
  const project = String(projectKey ?? "").trim().toLowerCase();
  for (;;) {
    const running = inflight.get(project);
    if (!running) break;
    // A plain read joins any running build. A refresh joins only another refresh (its fetch already ran); otherwise it waits
    // for the plain build to settle and re-checks, so it always ends up running (or joining) a fetchRepo.
    if (!refresh || running.refresh) return running.promise;
    await running.promise.catch(() => {});
  }
  const promise = buildOnce(project, { refresh, deps }).finally(() => { if (inflight.get(project)?.promise === promise) inflight.delete(project); });
  inflight.set(project, { promise, refresh });
  return promise;
}

/** The SB1 snapshot at origin/<default> with findings filled. refresh=true runs the rate-limited fetch first. */
export async function buildSnapshot(projectKey, opts = {}) {
  return (await buildSnapshotDetailed(projectKey, opts)).snapshot;
}

/** `[STORYBOOK] sha=<short> #1=n #2=n ... total=n` (only check ids present, in numeric order). */
export function summaryLine(snap) {
  const counts = new Map();
  for (const f of snap.findings ?? []) counts.set(f.check, (counts.get(f.check) ?? 0) + 1);
  const ids = [...counts.keys()].sort((a, b) => Number(String(a).replace(/\D/g, "")) - Number(String(b).replace(/\D/g, "")));
  const parts = ids.map((id) => `${id}=${counts.get(id)}`);
  return `[STORYBOOK] sha=${String(snap.sha).slice(0, 8)} ${parts.length ? parts.join(" ") + " " : ""}total=${(snap.findings ?? []).length}`;
}

/** `[STORYBOOK] signals coverage=n integrity=n cohesion=n signoff=n`, or "" when the snapshot has no audit findings. */
export function auditLine(snap) {
  if (!Array.isArray(snap.audit)) return "";
  const counts = {};
  for (const s of SIGNALS) counts[s] = 0;
  for (const f of snap.audit) if (Object.hasOwn(counts, f?.signal)) counts[f.signal]++;
  return `[STORYBOOK] signals ${SIGNALS.map((s) => `${s}=${counts[s]}`).join(" ")}`;
}

const CHANGES_RE = /^\/api\/storybook\/([A-Za-z0-9._-]{1,64})\/changes(\/seen)?\/?$/;

const sendJson = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
};

function readBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on("data", (c) => { n += c.length; if (n > max) { reject(new StorybookError(413, "body too large")); req.destroy?.(); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

/** V8: GET .../changes = new/changed/gone vs the owner's last-seen session; POST .../changes/seen {sha} = "I've seen up to sha X" (explicit, never automatic). */
function handleChangesRoute(req, res, project, isSeen, deps) {
  const storeOpts = { home: deps.seenHome };
  const fail = (e) => {
    if (e instanceof StorybookError) return sendJson(res, e.status, { error: e.message });
    console.warn(`[storybook] ${project} changes: ${e?.message ?? e}`);
    sendJson(res, 500, { error: "storybook changes failed; see the server log" });
  };
  if (req.method !== (isSeen ? "POST" : "GET")) { res.setHeader("allow", isSeen ? "POST" : "GET"); sendJson(res, 405, { error: "method not allowed" }); return true; }
  const key = project.toLowerCase();
  (async () => {
    const snap = await buildSnapshot(key, deps);
    if (!isSeen) return sendJson(res, 200, diffChanges(readSeen(key, storeOpts), snap));
    let want = "";
    try { want = String(JSON.parse((await readBody(req)) || "{}")?.sha ?? "").trim().toLowerCase(); } catch (e) { if (e instanceof StorybookError) throw e; throw new StorybookError(400, "body must be JSON {sha}"); }
    if (!/^[0-9a-f]{7,40}$/.test(want)) throw new StorybookError(400, "sha required (7-40 hex)");
    if (!snap.sha.toLowerCase().startsWith(want)) throw new StorybookError(409, `Storybook moved to ${String(snap.sha).slice(0, 8)}; reload before marking seen`);
    const rec = seenRecord(snap);
    writeSeen(key, rec, storeOpts);
    sendJson(res, 200, { ok: true, sha: rec.sha, at: rec.at, total: rec.total });
  })().catch(fail);
  return true;
}

const PROJECT_RE = /^\/api\/storybook\/([A-Za-z0-9._-]{1,64})(\/refresh)?\/?$/;

/**
 * HTTP handler for GET /api/storybook/:project and POST /api/storybook/:project/refresh. Returns false when the path is
 * not ours. MUST be mounted behind the VS API middleware (serve.mjs `api(req,res,next)`), which owns the auth guard.
 */
export function handleStorybookRoute(req, res, deps = {}) {
  const p = (req.url ?? "").split("?")[0];
  const cm = CHANGES_RE.exec(p);
  if (cm) return handleChangesRoute(req, res, cm[1], Boolean(cm[2]), deps);
  const m = PROJECT_RE.exec(p);
  if (!m) return false;
  const send = (status, body) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(body));
  };
  const isRefresh = Boolean(m[2]);
  if (req.method === "HEAD" && !isRefresh) { // probe: status only (Node drops the body for HEAD)
    probeProject(m[1], deps).then(() => send(200, {}), (e) => {
      if (e instanceof StorybookError) return send(e.status, { error: e.message });
      console.warn(`[storybook] ${m[1]}: ${e?.message ?? e}`);
      send(500, { error: "storybook probe failed; see the server log" });
    });
    return true;
  }
  if (req.method !== (isRefresh ? "POST" : "GET")) { res.setHeader("allow", isRefresh ? "POST" : "GET, HEAD"); send(405, { error: "method not allowed" }); return true; }
  buildSnapshotDetailed(m[1], { refresh: isRefresh, ...deps }).then(
    ({ snapshot, fetch }) => send(200, isRefresh ? { ...snapshot, fetched: fetch?.fetched ?? false, nextFetchAt: fetch?.nextFetchAt ?? null } : snapshot),
    (e) => {
      if (e instanceof StorybookError) return send(e.status, { error: e.message });
      console.warn(`[storybook] ${m[1]}: ${e?.message ?? e}`);
      send(500, { error: "storybook build failed; see the server log" });
    },
  );
  return true;
}

// ── V6 owner marks: GET /api/storybook/:p/marks, POST /api/storybook/:p/marks, POST /api/storybook/:p/marks/commit ──
const MARKS_RE = /^\/api\/storybook\/([A-Za-z0-9._-]{1,64})\/marks(\/commit)?\/?$/;
const MARKS_BODY_MAX = 2 * 1024 * 1024;
const marksApis = new Map(); // repoPath -> marksFor(repo)

function readJsonBody(req, limit = MARKS_BODY_MAX) {
  return new Promise((ok, fail) => {
    if (req.body !== undefined) return ok(typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body);
    let body = "", size = 0, done = false;
    req.on("data", (c) => { if (done) return; size += c.length; if (size > limit) { done = true; fail(new StorybookError(413, "payload too large")); return; } body += c; });
    req.on("end", () => { if (done) return; try { ok(JSON.parse(body.replace(/^﻿/, "") || "{}")); } catch { fail(new StorybookError(400, "bad json")); } });
    req.on("error", fail);
  });
}

// An unquoted absolute path (POSIX /a/b, Windows C:\a or C:/a, UNC \\host\share) not glued to a word, `~` or a placeholder.
const BARE_HOST_PATH = /(?<![\w~.<>/\\-])(?:[A-Za-z]:[\\/]|\\\\|\/(?=[^\s/]))[^\s'"<>]*/g;
/** Both slash spellings of a host path (git prints C:/x on Windows where env vars hold C:\x), longest first. */
const spellings = (p) => [...new Set([p, p.replace(/\\/g, "/"), p.replace(/\//g, "\\")])].filter((x) => x.length > 1).sort((a, b) => b.length - a.length);
/**
 * No host paths in a response: the repo path, VIBESQUAD_HOME and the home dir become placeholders (either slash style),
 * then any other quoted or bare absolute path becomes <path> (QUOTED_HOST_PATH is the git-stderr masking of team-worktrees).
 */
export function scrubPaths(msg, repoPath, env = process.env) {
  let s = String(msg ?? "");
  const named = [[repoPath, "<repo>"], [env.VIBESQUAD_HOME, "<vs-home>"], [env.HOME, "~"], [env.USERPROFILE, "~"]];
  for (const [p, ph] of named) if (p) for (const v of spellings(String(p).replace(/[\\/]+$/, ""))) s = s.split(v).join(ph);
  return s.replace(QUOTED_HOST_PATH, "'<path>'").replace(BARE_HOST_PATH, "<path>");
}

/**
 * HTTP handler for the V6 marks routes. Returns false when the path is not ours. Owner writes (POST) go through the same
 * VS API guard as /refresh (mounted behind it in vibesquad-api.mjs; agents are not on the write allowlist).
 * deps.marksFor(repoPath) is injectable for tests.
 */
export function handleStorybookMarksRoute(req, res, deps = {}) {
  const p = (req.url ?? "").split("?")[0];
  const m = MARKS_RE.exec(p);
  if (!m) return false;
  const send = (status, body) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(body));
  };
  const isCommit = Boolean(m[2]);
  const allowed = isCommit ? ["POST"] : ["GET", "POST"];
  if (!allowed.includes(req.method)) { res.setHeader("allow", allowed.join(", ")); send(405, { error: "method not allowed" }); return true; }
  let repoPath = null;
  (async () => {
    const proj = await resolveProject(m[1], deps);
    if (!proj) throw new StorybookError(404, `unknown storybook project: ${m[1]}`);
    repoPath = proj.repoPath;
    const { marksFor } = await import("./marks.mjs");
    const make = deps.marksFor ?? marksFor;
    let api = marksApis.get(repoPath);
    if (!api || deps.marksFor) { api = make(repoPath); if (!deps.marksFor) marksApis.set(repoPath, api); }
    if (req.method === "GET") {
      const out = await api.get();
      return out?.autoCommitError ? { ...out, autoCommitError: scrubPaths(out.autoCommitError, repoPath) } : out;
    }
    if (isCommit) return api.commit();
    const body = await readJsonBody(req);
    return api.set(body?.marks);
  })().then((out) => send(200, out), (e) => {
    const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status >= 500) console.warn(`[storybook] marks ${m[1]}: ${e?.message ?? e}`);
    send(status, { error: scrubPaths(e?.message ?? e, repoPath) });
  });
  return true;
}
