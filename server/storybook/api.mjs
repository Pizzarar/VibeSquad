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

/** team id -> adapter. Add a project here; never a repo path (those come from teams.json). */
export const ADAPTERS = Object.freeze({ efi: efiAdapter });

export class StorybookError extends Error {
  constructor(status, message) { super(message); this.name = "StorybookError"; this.status = status; }
}

const CACHE_PER_PROJECT = 4;
const cache = new Map();    // `${project}\0${sha}` -> snapshot
const order = new Map();    // project -> [sha...] oldest first
const inflight = new Map(); // project -> Promise<{snapshot, fetch}>

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
  if (injected) return { runChecks: injected, warning: null };
  try {
    const mod = await import("./checks/index.mjs");
    if (typeof mod.runChecks === "function") return { runChecks: mod.runChecks, warning: null };
    return { runChecks: null, warning: "checks module has no runChecks export; findings empty" };
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND" && /checks[\\/]index\.mjs/.test(String(e.message))) return { runChecks: null, warning: "checks module not available; findings empty" };
    return { runChecks: null, warning: `checks module failed to load (${String(e?.message ?? e).slice(0, 120)}); findings empty` };
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
    throw new StorybookError(404, `storybook: cannot read ${project} repo at origin default branch (${String(e.message).slice(0, 160)})`);
  }
  const hit = cache.get(`${project}\0${sha}`);
  if (hit) return { snapshot: hit, fetch };
  const reader = makeReader(repoPath, sha);
  const { entities, warnings } = await adapter.load(reader, sha);
  const snap = makeSnapshot({ project: adapter.id, ref, sha, entities, warnings: [...warnings] });
  const { runChecks, warning } = await loadRunChecks(deps.runChecks);
  if (warning) snap.warnings.push(warning);
  if (runChecks) {
    try {
      const res = await runChecks(snap, { adapter, reader });
      const findings = Array.isArray(res) ? res : res?.findings;
      snap.findings = Array.isArray(findings) ? findings : [];
    } catch (e) {
      snap.findings = [];
      snap.warnings.push(`checks failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  remember(project, sha, snap);
  return { snapshot: snap, fetch };
}

/** Like buildSnapshot but also returns the fetch outcome: {snapshot, fetch:{fetched,nextFetchAt,skipped}|null}. */
export async function buildSnapshotDetailed(projectKey, { refresh = false, ...deps } = {}) {
  const project = String(projectKey ?? "").trim().toLowerCase();
  const running = inflight.get(project);
  if (running && !refresh) return running; // coalesced: one build per project at a time
  if (running) {
    await running.catch(() => {}); // a refresh waits for the running build, then runs its own (fetch is rate-limited)
    const again = inflight.get(project);
    if (again) return again; // another caller already started the follow-up build
  }
  const p = buildOnce(project, { refresh, deps }).finally(() => { if (inflight.get(project) === p) inflight.delete(project); });
  inflight.set(project, p);
  return p;
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

const PROJECT_RE = /^\/api\/storybook\/([A-Za-z0-9._-]{1,64})(\/refresh)?\/?$/;

/**
 * HTTP handler for GET /api/storybook/:project and POST /api/storybook/:project/refresh. Returns false when the path is
 * not ours. MUST be mounted behind the VS API middleware (serve.mjs `api(req,res,next)`), which owns the auth guard.
 */
export function handleStorybookRoute(req, res, deps = {}) {
  const p = (req.url ?? "").split("?")[0];
  const m = PROJECT_RE.exec(p);
  if (!m) return false;
  const send = (status, body) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(body));
  };
  const isRefresh = Boolean(m[2]);
  if (req.method !== (isRefresh ? "POST" : "GET")) { res.setHeader("allow", isRefresh ? "POST" : "GET"); send(405, { error: "method not allowed" }); return true; }
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
