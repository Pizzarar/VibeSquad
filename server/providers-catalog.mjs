// Provider/model/mode catalog + runner usage rollups + runner settings for the UI (runner pilot B9).
// /__vibesquad/providers[/models|/modes|/usage|/settings]. Shapes match what src/paseoProviders.ts got from the
// Paseo daemon ({providers:[{provider,available,error}]}, {models:[{id,label,...}]}, {modes:[...]}).
// Probing: `<cli> --version` on the resolved executable, no shell, cached with a TTL. No background timers.
import { execFile, execFileSync } from "node:child_process";
import { openSync, closeSync, readSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACP_PROVIDERS, PROVIDER_ALIASES } from "../runner/adapters/acp.mjs";
import { resolveExecutable } from "../runner/spawn.mjs";
import { DEFAULT_PACK_PROFILES, getProfilesPath, normalizeProfile } from "./profiles.mjs";
import { resolveTeamsFilePath } from "./teams-file.mjs";
import { isForbiddenRealHome } from "./test-guard.mjs";
import { readJsonFileWithBom, vibesquadHome, writeSettingsAtomic } from "./user-settings.mjs";

const PROBE_TTL_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 4000;

/** Provider id -> the CLI binary probed for it. */
export const PROBE_COMMANDS = {
  claude: "claude",
  codex: "codex",
  "antigravity-cli": "agy",
  opencode: "opencode",
};
const LABELS = { claude: "Claude", codex: "Codex", "antigravity-cli": "Antigravity (Gemini)", opencode: "OpenCode" };

const BASE_MODELS = {
  claude: [
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-sonnet-5-5", "Sonnet 5.5"],
    ["claude-haiku-5-5", "Haiku 5.5"],
    ["claude-fable-5-1", "Fable 5.1"],
  ],
  codex: [],
  "antigravity-cli": [],
  opencode: [],
};
const BASE_MODES = {
  claude: [
    ["default", "Default", "Ask before edits and commands"],
    ["acceptEdits", "Accept edits", "Edits allowed without asking"],
    ["plan", "Plan", "Read-only planning"],
    ["auto", "Auto", "Classifier-approved actions"],
    ["bypassPermissions", "Bypass permissions", "No prompts"],
  ],
  "antigravity-cli": [
    ["default", "Default", ""],
    ["accept-edits", "Accept edits", ""],
  ],
  codex: [["default", "Default", ""]],
  opencode: [["default", "Default", ""]],
};

const canon = (p) => PROVIDER_ALIASES[p] ?? p;

// ---------------------------------------------------------------- probing (cached)
const probeCache = new Map(); // provider -> { at, value }
let probeRuns = 0;
export const probeStats = () => ({ runs: probeRuns });
export const clearProbeCache = () => probeCache.clear();

function runVersion(file, args, execImpl) {
  return new Promise((resolve) => {
    execImpl(file, [...args, "--version"], { shell: false, windowsHide: true, timeout: PROBE_TIMEOUT_MS }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: String(err.message ?? err).split("\n")[0] });
      resolve({ ok: true, version: String(stdout).trim().split("\n")[0].slice(0, 80) });
    });
  });
}

async function probeOne(provider, { execImpl, resolveImpl }) {
  probeRuns++;
  let r;
  try {
    r = resolveImpl(PROBE_COMMANDS[provider]);
  } catch {
    return { provider, available: false, error: `${PROBE_COMMANDS[provider]} not found on PATH` };
  }
  const v = await runVersion(r.file, r.args, execImpl);
  return v.ok
    ? { provider, available: true, version: v.version }
    : { provider, available: false, error: v.error };
}

/** Probe every known CLI once per TTL. Concurrent callers share the in-flight probe. */
export function probeProviders({ refresh = false, now = Date.now(), execImpl = execFile, resolveImpl = resolveExecutable } = {}) {
  return Promise.all(
    Object.keys(PROBE_COMMANDS).map((p) => {
      const hit = probeCache.get(p);
      if (!refresh && hit && now - hit.at < PROBE_TTL_MS) return hit.value;
      const value = probeOne(p, { execImpl, resolveImpl });
      probeCache.set(p, { at: now, value });
      return value;
    }),
  );
}

// ---------------------------------------------------------------- settings (~/.vibesquad/settings.json "runner" key)
const settingsPath = (home) => join(home || vibesquadHome(), "settings.json");

function readRawSettings(home) {
  const res = readJsonFileWithBom(settingsPath(home), { label: "~/.vibesquad/settings.json", fallback: {}, recordWarning: false, rewriteBom: false });
  return res.ok && res.data && typeof res.data === "object" && !Array.isArray(res.data) ? res.data : {};
}

/** Like readRawSettings but refuses (throws) when the file exists and is unreadable, so a save never clobbers it. */
function readRawSettingsForSave(home) {
  const res = readJsonFileWithBom(settingsPath(home), { label: "~/.vibesquad/settings.json", fallback: {}, recordWarning: false, rewriteBom: false });
  if (res.exists && !res.ok) throw new Error(`refusing to save: settings.json exists but is not valid JSON (${res.error}). Fix or remove it first.`);
  if (res.exists && !(res.data && typeof res.data === "object" && !Array.isArray(res.data))) throw new Error("refusing to save: settings.json is not a JSON object");
  return res.data && typeof res.data === "object" ? res.data : {};
}

const strList = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))] : []);

/** Normalise the editable runner block. Unknown keys are dropped; shapes are forced. */
export function normalizeRunnerSettings(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const providers = {};
  for (const [k, v] of Object.entries(r.providers ?? {})) {
    if (!v || typeof v !== "object") continue;
    const id = canon(String(k));
    const entry = {};
    if (typeof v.enabled === "boolean") entry.enabled = v.enabled;
    if (typeof v.command === "string" && v.command.trim()) entry.command = v.command.trim();
    const models = strList(v.models);
    if (models.length) entry.models = models;
    const modes = strList(v.modes);
    if (modes.length) entry.modes = modes;
    if (typeof v.defaultModel === "string" && v.defaultModel.trim()) entry.defaultModel = v.defaultModel.trim();
    if (typeof v.defaultMode === "string" && v.defaultMode.trim()) entry.defaultMode = v.defaultMode.trim();
    if (Object.keys(entry).length) providers[id] = entry;
  }
  return { providers };
}

export function loadRunnerSettings(home) {
  return normalizeRunnerSettings(readRawSettings(home).runner);
}

/**
 * Merge a patch into settings.json's `runner` key; every other top-level key is preserved untouched.
 * A provider present in the patch REPLACES the saved one (so empty models/modes or blank defaults clear them);
 * `null` resets the provider; providers absent from the patch are untouched.
 */
export function saveRunnerSettings(patch, home) {
  const raw = readRawSettingsForSave(home);
  const current = normalizeRunnerSettings(raw.runner);
  const incoming = normalizeRunnerSettings(patch);
  const providers = { ...current.providers };
  for (const id of Object.keys(patch?.providers ?? {})) {
    const cid = canon(id);
    if (patch.providers[id] === null) delete providers[cid]; // explicit reset
    else if (patch.providers[id] && typeof patch.providers[id] === "object") {
      if (incoming.providers[cid]) providers[cid] = incoming.providers[cid];
      else delete providers[cid]; // everything cleared
    }
  }
  const next = { ...raw, runner: { ...(raw.runner && typeof raw.runner === "object" ? raw.runner : {}), providers } };
  writeSettingsAtomic(settingsPath(home), next);
  return normalizeRunnerSettings(next.runner);
}

// ---------------------------------------------------------------- catalog
function profileList(home) {
  const file = getProfilesPath(home ? join(home, "profiles.json") : undefined);
  const res = readJsonFileWithBom(file, { fallback: null, recordWarning: false, rewriteBom: false });
  const raw = res.ok && res.data ? (Array.isArray(res.data) ? res.data : res.data.profiles) : null;
  const list = Array.isArray(raw) ? raw.map(normalizeProfile).filter(Boolean) : [];
  return list.length ? list : DEFAULT_PACK_PROFILES.map(normalizeProfile).filter(Boolean);
}

export function buildCatalog({ probes, home } = {}) {
  const settings = loadRunnerSettings(home);
  const profiles = profileList(home);
  const probeBy = new Map((probes ?? []).map((p) => [p.provider, p]));
  const ids = [...new Set([...Object.keys(PROBE_COMMANDS), ...Object.keys(ACP_PROVIDERS), ...Object.keys(settings.providers)])];
  const out = {};
  for (const id of ids) {
    const cfg = settings.providers[id] ?? {};
    const models = new Map();
    const add = (mid, label, source, description = "") => {
      if (mid && !models.has(mid)) models.set(mid, { id: mid, label: label || mid, description: description || `from ${source}`, source });
    };
    for (const [mid, label] of BASE_MODELS[id] ?? []) add(mid, label, "built-in");
    for (const p of profiles) if (canon(p.provider) === id && p.model) add(p.model, p.model, `profile ${p.name}`);
    for (const mid of cfg.models ?? []) add(mid, mid, "settings.json");
    const modes = new Map();
    const addMode = (mid, label, description = "") => mid && !modes.has(mid) && modes.set(mid, { id: mid, label: label || mid, description });
    for (const [mid, label, d] of BASE_MODES[id] ?? []) addMode(mid, label, d);
    for (const p of profiles) if (canon(p.provider) === id && p.modeId) addMode(p.modeId, p.modeId, `used by profile ${p.name}`);
    for (const mid of cfg.modes ?? []) addMode(mid, mid, "from settings.json");
    const probe = probeBy.get(id);
    const known = Boolean(PROBE_COMMANDS[id]);
    const disabled = cfg.enabled === false;
    out[id] = {
      provider: id,
      label: LABELS[id] ?? id,
      available: !disabled && (probe ? probe.available : !known),
      ...(disabled ? { error: "disabled in settings.json" } : probe && !probe.available ? { error: probe.error } : {}),
      ...(probe?.version ? { version: probe.version } : {}),
      models: [...models.values()].map((m) => ({ ...m, ...(m.id === cfg.defaultModel ? { isDefault: true } : {}) })),
      modes: [...modes.values()],
      ...(cfg.defaultMode ? { defaultMode: cfg.defaultMode } : {}),
    };
  }
  return out;
}

export async function getProviders(opts = {}) {
  const probes = await probeProviders(opts);
  const catalog = buildCatalog({ probes, home: opts.home });
  return { providers: Object.values(catalog).map(({ models, modes, ...p }) => p) };
}
export async function getModels(provider, opts = {}) {
  const c = buildCatalog({ probes: await probeProviders(opts), home: opts.home })[canon(provider)];
  return c ? { models: c.models, ...(c.available ? {} : { error: c.error }) } : { models: [], error: `unknown provider "${provider}"` };
}
export async function getModes(provider, opts = {}) {
  const c = buildCatalog({ probes: await probeProviders(opts), home: opts.home })[canon(provider)];
  return c ? { modes: c.modes, ...(c.available ? {} : { error: c.error }) } : { modes: [], error: `unknown provider "${provider}"` };
}

// ---------------------------------------------------------------- usage rollups (lazy + incremental)
// Per file we keep the byte offset already folded in and the per-bucket totals. A request stats the directory,
// re-reads only files whose size/mtime moved (and only the new tail), and drops nothing it has already counted.
const usageFiles = new Map(); // path -> { size, mtimeMs, offset, provider, model, lane, role, prevCost, buckets, turns, tail, pass, handoff, title }
export const clearUsageCache = () => usageFiles.clear();
let usageReadBytes = 0;
export const usageStats = () => ({ files: usageFiles.size, readBytes: usageReadBytes });

/** YYYY-MM-DD for a ts, or null when it is not a valid date (never throws). */
const dayOf = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const tokenCount = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

function bucketFor(st, day) {
  const key = `${st.provider}|${st.model}|${st.lane}|${st.role}|${day}`;
  let b = st.buckets.get(key);
  if (!b) {
    b = { provider: st.provider, model: st.model, lane: st.lane, role: st.role, day, turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    st.buckets.set(key, b);
  }
  return b;
}

function foldEvent(st, ev) {
  const t = tsMs(ev.ts);
  if (t !== null) {
    if (st.firstTs === undefined || t < st.firstTs) st.firstTs = t;
    if (st.lastTs === undefined || t > st.lastTs) st.lastTs = t;
  }
  if (ev.type === "created") {
    st.provider = ev.provider ?? st.provider;
    st.model = ev.model ?? st.model;
    st.lane = ev.meta?.lane ?? ev.meta?.labels?.lane ?? st.lane;
    if (ev.cwd !== undefined) st.cwd = ev.cwd;
    if (st.createdAt === undefined && t !== null) st.createdAt = t;
    foldIdentity(st, ev.meta);
  } else if (ev.type === "session" && ev.model) {
    st.model = ev.model;
  } else if (ev.type === "meta") {
    // Runner.updateMeta appends { type: "meta", patch: { lane?, labels?, profile? } }.
    const lane = ev.patch?.lane ?? ev.patch?.labels?.lane;
    if (typeof lane === "string" && lane) st.lane = lane;
    foldIdentity(st, ev.patch);
  } else if (ev.type === "status") {
    // working intervals run from status "running" to "idle"/"parked"/"exited"; an open interval is closed at lastTs.
    if (ev.status === "running") {
      if (st.runningSince === undefined && t !== null) st.runningSince = t;
    } else if (WORKING_END_STATUSES.has(ev.status)) {
      if (st.runningSince !== undefined && t !== null) {
        st.workingMs += Math.max(0, t - st.runningSince);
        st.runningSince = undefined;
      }
    }
  } else if (ev.type === "exit" || ev.type === "error") {
    st.exited = true;
    if (t !== null) st.exitTs = t;
    if (ev.type === "error" || ev.error != null || (ev.code != null && ev.code !== 0)) st.exitError = true;
    if (st.runningSince !== undefined && t !== null) {
      st.workingMs += Math.max(0, t - st.runningSince);
      st.runningSince = undefined;
    }
  } else if (ev.type === "input") {
    st.tail = ""; // a new prompt starts a new assistant message; echoed prompt text never counts
  } else if (ev.type === "output") {
    // PASS counts only at the start of a line of the agent's own message ("PASS", "Verdict: PASS", "**PASS**"), never mid-text.
    if (typeof ev.text === "string") {
      st.tail = (st.tail + ev.text).slice(-400);
      if (!st.pass && PASS_RE.test(st.tail)) st.pass = true;
    }
  } else if (ev.type === "usage") {
    // Adapter usage events (claude: per-call input/output tokens). ACP's contextTokens is a running size, not a delta: ignored.
    const inT = tokenCount(ev.inputTokens);
    const outT = tokenCount(ev.outputTokens);
    const day = dayOf(ev.ts ?? Date.now());
    if (day && (inT || outT)) {
      const b = bucketFor(st, day);
      b.inputTokens += inT;
      b.outputTokens += outT;
    }
  } else if (ev.type === "turn_done") {
    // claude reports a session-cumulative total_cost_usd; a lower value means a fresh process, so count it whole.
    const c = Number(ev.costUsd);
    let delta = 0;
    if (Number.isFinite(c) && c >= 0) {
      delta = c >= st.prevCost ? c - st.prevCost : c;
      st.prevCost = c;
    }
    const day = dayOf(ev.ts ?? Date.now());
    if (!day) return; // invalid ts: skip the event (prevCost already advanced so later deltas stay right)
    const b = bucketFor(st, day);
    b.turns += 1;
    b.costUsd += delta;
    st.turns += 1;
  }
}

/** Role (brainstorm|lead|worker), handoff marker, title and profile ride on created.meta / meta.patch. */
function foldIdentity(st, m) {
  if (!m) return;
  if (typeof m.role === "string" && m.role) st.role = m.role;
  if (typeof m.labels?.["vs.handoff-from"] === "string") st.handoff = true;
  const title = m.title ?? m.labels?.job;
  if (typeof title === "string" && title) st.title = title;
  if (typeof m.profile === "string" && m.profile) st.profile = m.profile;
  else if (typeof m.labels?.profile === "string" && m.labels.profile) st.profile = m.labels.profile;
}

function readTail(file, from, to) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(to - from);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, from + n);
      if (r <= 0) break;
      n += r;
    }
    usageReadBytes += n;
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function refreshFile(file, stat) {
  let st = usageFiles.get(file);
  if (st && st.size === stat.size && st.mtimeMs === stat.mtimeMs) return st;
  if (!st || stat.size < st.offset) st = { offset: 0, provider: "unknown", model: "unknown", lane: "", role: "", prevCost: 0, buckets: new Map(), turns: 0, tail: "", pass: false, handoff: false, title: "", profile: undefined, cwd: undefined, createdAt: undefined, firstTs: undefined, lastTs: undefined, workingMs: 0, runningSince: undefined, exited: false, exitError: false, exitTs: undefined };
  const buf = readTail(file, st.offset, stat.size);
  const lastNl = buf.lastIndexOf(10);
  if (lastNl >= 0) {
    for (const line of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try { foldEvent(st, JSON.parse(line)); } catch { /* torn or foreign line */ }
    }
    st.offset += lastNl + 1; // a trailing partial line is re-read next time
  }
  st.size = stat.size;
  st.mtimeMs = stat.mtimeMs;
  usageFiles.set(file, st);
  return st;
}

/** A run (agent log) with more turns than this and no PASS in its output is flagged as a likely loop. */
export const LOOP_TURN_THRESHOLD = 40;
const PASS_RE = /(?:^|\n)[ \t>*_#-]*(?:verdict:?\s*)?[*_`]*PASS\b/i;
const COORDINATION_ROLES = new Set(["brainstorm", "lead"]);
const ROLE_ORDER = ["brainstorm", "lead", "worker"];
// v2 efficiency signals (usa-5): statuses that close a working interval, spawn-storm windows/thresholds, fix-after-merge.
const WORKING_END_STATUSES = new Set(["idle", "parked", "exited"]);
const SPAWN_BURST_WINDOW_MS = 2 * 60_000;
const SPAWN_BURST_MIN = 3;
const ZERO_TURN_EXIT_WINDOW_MS = 5 * 60_000;
const ZERO_TURN_EXIT_MIN = 3;
const FIX_AFTER_MERGE_WINDOW_MS = 24 * 3600_000;
const FIX_UNIT_RE = /\b(?:fix|hotfix|regress(?:ion)?|revert)\b/i;

const zeroStats = () => ({ turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 });
const addStats = (t, b) => {
  t.turns += b.turns;
  t.costUsd += b.costUsd;
  t.inputTokens += b.inputTokens;
  t.outputTokens += b.outputTokens;
  return t;
};
const withAvg = (t) => ({ ...t, avgTokensPerTurn: t.turns ? Math.round((t.inputTokens + t.outputTokens) / t.turns) : 0 });
const toMs = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
};
/** Event ts -> ms, rejecting values that are not a valid date (e.g. 1e20), so firstTs/lastTs stay sane. */
const tsMs = (v) => {
  const n = toMs(v);
  return n !== null && !Number.isNaN(new Date(n).getTime()) ? n : null;
};
const getOrSet = (m, k, mk) => m.get(k) ?? m.set(k, mk()).get(k);

// ---- provider limit windows: <runner home>/limits.jsonl, one JSON line per sample (written by the adapters/runner):
// {at, provider, window:"5h"|"weekly", usedPct, resetsAt, source:"provider"|"estimate", agentId}
const BURN_LOOKBACK_MS = 2 * 3600_000;

/** Latest sample per provider/window + burn rate (%/h over the last 2h of the current window) + ETA-to-cap. Missing file -> []. */
export function readLimits(home) {
  const dir = home || vibesquadHome();
  if (isForbiddenRealHome(dir)) return [];
  let text = "";
  try { text = readFileSync(join(dir, "runner", "limits.jsonl"), "utf8"); } catch { return []; }
  const groups = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const at = toMs(r?.at);
    const used = Number(r?.usedPct);
    if (!r?.provider || !r?.window || at === null || !Number.isFinite(used)) continue;
    getOrSet(groups, `${r.provider}|${r.window}`, () => []).push({ ...r, atMs: at, used, resetMs: toMs(r.resetsAt) });
  }
  const out = [];
  for (const pts of groups.values()) {
    pts.sort((x, y) => x.atMs - y.atMs);
    const last = pts[pts.length - 1];
    // Current window starts after the last usedPct drop or the last change of a known resetsAt (both mean the window rolled over).
    let start = 0;
    for (let i = 1; i < pts.length; i++) {
      const rolled = pts[i].used < pts[i - 1].used || (pts[i].resetMs !== null && pts[i - 1].resetMs !== null && pts[i].resetMs !== pts[i - 1].resetMs);
      if (rolled) start = i;
    }
    const cur = pts.slice(start).filter((p) => p.atMs >= last.atMs - BURN_LOOKBACK_MS);
    const hours = (last.atMs - cur[0].atMs) / 3600_000;
    const burn = Math.max(0, hours > 0 ? (last.used - cur[0].used) / hours : 0);
    let etaToCap = null;
    if (burn > 0) {
      const eta = last.used >= 100 ? last.atMs : last.atMs + ((100 - last.used) / burn) * 3600_000;
      if (last.resetMs === null || eta < last.resetMs) etaToCap = new Date(eta).toISOString();
    }
    out.push({
      provider: last.provider, window: last.window, usedPct: last.used,
      resetsAt: last.resetMs === null ? null : new Date(last.resetMs).toISOString(),
      source: last.source ?? "provider", agentId: last.agentId ?? null, at: new Date(last.atMs).toISOString(),
      burnPctPerHour: Math.round(burn * 100) / 100, etaToCap,
    });
  }
  return out.sort((x, y) => x.provider.localeCompare(y.provider) || x.window.localeCompare(y.window));
}

// ---- merged units from git. `git` is injectable: (args: string[]) => stdout string.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultGit = (args) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
const REVIEW_RE = /review r(\d+)/i;
const CODE_RE = /\(@([A-Za-z0-9_-]+)(?:\s[^)]*)?\)/g;
const MAX_COMMITS = 4000;
const MAX_BRANCH_WALK = 500;

/** Lane code of a subject: the last `(@code ...)` tag, lowercased, else null. */
const codeOf = (subject) => {
  let m, last = null;
  CODE_RE.lastIndex = 0;
  while ((m = CODE_RE.exec(subject))) last = m[1].toLowerCase();
  return last;
};

let mergedCache = null; // { git, head, units }: recomputed only when HEAD (or the injected git) changes

/** Merge commits -> units {sha, unit, code, reviewRounds, mergedAt, subject}. unit = branch from "Merge branch 'x'".
 * One `git log` over recent history joined in memory (no per-merge spawns), cached by HEAD sha. The merged side of a
 * merge = commits reachable from its 2nd parent until the first-parent (mainline) chain from HEAD is hit.
 * reviewRounds = highest N among "review rN" subjects on that side. Lane code = the merge subject's `(@code)` tag,
 * else the first tag found on the merged side. */
export function readMergedUnits(git = defaultGit) {
  let head = "";
  try { head = git(["rev-parse", "HEAD"]).trim(); } catch { return []; }
  if (mergedCache && mergedCache.git === git && mergedCache.head === head) return mergedCache.units;
  let raw = "";
  try { raw = git(["log", `-${MAX_COMMITS}`, "--format=%H%x1f%P%x1f%ct%x1f%s"]); } catch { return []; }
  const commits = new Map();
  for (const line of raw.split("\n")) {
    const [sha, parents, ct, subject = ""] = line.split("\x1f");
    if (sha) commits.set(sha, { sha, parents: (parents ?? "").trim().split(/\s+/).filter(Boolean), ct, subject });
  }
  const mainline = new Set();
  for (let c = commits.get(head); c && !mainline.has(c.sha); c = commits.get(c.parents[0])) mainline.add(c.sha);
  const units = [];
  for (const c of commits.values()) {
    if (c.parents.length < 2) continue;
    const side = [];
    const seen = new Set();
    const stack = [c.parents[1]];
    while (stack.length && side.length < MAX_BRANCH_WALK) {
      const sha = stack.pop();
      if (seen.has(sha) || mainline.has(sha)) continue;
      seen.add(sha);
      const k = commits.get(sha);
      if (!k) continue;
      side.push(k);
      stack.push(...k.parents);
    }
    let rounds = 0;
    let code = codeOf(c.subject);
    let firstCt = null;
    for (const k of side) {
      const m = REVIEW_RE.exec(k.subject);
      if (m) rounds = Math.max(rounds, Number(m[1]));
      code ??= codeOf(k.subject);
      const cts = Number(k.ct);
      if (Number.isFinite(cts) && (firstCt === null || cts < firstCt)) firstCt = cts;
    }
    const branch = /Merge branch '([^']+)'/i.exec(c.subject)?.[1] ?? null;
    units.push({ sha: c.sha, unit: branch, code, reviewRounds: rounds, mergedAt: Number.isFinite(Number(c.ct)) ? new Date(Number(c.ct) * 1000).toISOString() : null, firstBranchCtMs: firstCt === null ? null : firstCt * 1000, subject: c.subject });
  }
  mergedCache = { git, head, units };
  return units;
}

/** lowercase lane code or id -> lane id, from <home>/teams.json lanes[]. */
function readLaneCodes(home) {
  const map = new Map();
  try {
    const own = home ? join(home, "teams.json") : null;
    const file = own && !isForbiddenRealHome(home) && existsSync(own) ? own : resolveTeamsFilePath(REPO_ROOT);
    const t = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    for (const team of t.teams ?? []) for (const l of team.lanes ?? []) {
      if (!l?.id) continue;
      map.set(String(l.id).toLowerCase(), l.id);
      if (l.code) map.set(String(l.code).toLowerCase(), l.id);
    }
  } catch { /* no teams.json */ }
  return map;
}

// ---------------------------------------------------------------- usage v2 (usa-5): profiles, work/idle, cycles, fix-after-merge, spawn storms

/** Per-agent whole-log summary for the v2 rollups (not day-filtered). */
function agentV2(st, agentId) {
  const stats = zeroStats();
  for (const b of st.buckets.values()) addStats(stats, b);
  let workingMs = st.workingMs;
  if (st.runningSince !== undefined && st.lastTs !== undefined) workingMs += Math.max(0, st.lastTs - st.runningSince);
  const spanMs = st.firstTs !== undefined && st.lastTs !== undefined ? Math.max(0, st.lastTs - st.firstTs) : 0;
  return {
    agentId,
    provider: st.provider,
    model: st.model,
    profile: st.profile || "unknown",
    role: st.role || "unknown",
    lane: st.lane,
    cwd: st.cwd,
    createdAt: st.createdAt ?? st.firstTs ?? null,
    firstTs: st.firstTs ?? null,
    lastTs: st.lastTs ?? null,
    turns: st.turns,
    costUsd: stats.costUsd,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    pass: !!st.pass,
    workingMs,
    idleMs: Math.max(0, spanMs - workingMs),
    exited: !!st.exited,
    exitError: !!st.exitError,
    exitTs: st.exitTs ?? null,
    loop: st.turns > LOOP_TURN_THRESHOLD && !st.pass,
  };
}

/** Attribute a merged unit to the implementer worker: basename(cwd) === unit, else the single worker in the lane created before mergedAt. */
function attributeImplementer(unit, agents) {
  const mergedAtMs = tsMs(unit.mergedAt);
  if (typeof unit.unit === "string" && unit.unit) {
    const matches = agents.filter((a) => a.role === "worker" && typeof a.cwd === "string" && a.cwd && basename(a.cwd) === unit.unit);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null; // ambiguous cwd match
  }
  if (!unit.lane || mergedAtMs === null) return null;
  const workers = agents.filter((a) => a.role === "worker" && a.lane === unit.lane && a.createdAt !== null && a.createdAt <= mergedAtMs);
  return workers.length === 1 ? workers[0] : null;
}

/** handoff entries (type "handoff") from the vs-log dirs under home (logs and teams), deduped (same entry lands in both). */
function readHandoffs(home) {
  const dir = home || vibesquadHome();
  if (isForbiddenRealHome(dir)) return [];
  const files = [];
  try {
    const logs = join(dir, "logs");
    if (existsSync(logs)) for (const n of readdirSync(logs)) if (n.endsWith(".jsonl")) files.push(join(logs, n));
  } catch { /* none */ }
  try {
    const teams = join(dir, "teams");
    if (existsSync(teams)) for (const t of readdirSync(teams)) {
      const p = join(teams, t, "log.jsonl");
      if (existsSync(p)) files.push(p);
    }
  } catch { /* none */ }
  const seen = new Set();
  const out = [];
  for (const file of files) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e?.type !== "handoff") continue;
      const t = tsMs(e.ts);
      if (t === null) continue;
      const lane = typeof e.lane === "string" && e.lane ? e.lane : "";
      const key = `${lane}\u0000${t}\u0000${String(e.text ?? "").slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ lane, ts: t });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Maximal clusters of >=min timestamps within windowMs, merged when they overlap. Returns [{ firstAt, lastAt, count }]. */
function findStorms(tsList, windowMs, min) {
  const ts = tsList.filter((t) => t !== null && t !== undefined).map(Number).sort((a, b) => a - b);
  const storms = [];
  for (let i = 0; i < ts.length; i++) {
    let j = i;
    while (j < ts.length && ts[j] - ts[i] <= windowMs) j++;
    if (j - i >= min) {
      const firstAt = ts[i];
      const lastAt = ts[j - 1];
      const last = storms[storms.length - 1];
      if (last && firstAt <= last.lastAt) last.lastAt = Math.max(last.lastAt, lastAt);
      else storms.push({ firstAt, lastAt });
    }
  }
  return storms.map((s) => ({ firstAt: s.firstAt, lastAt: s.lastAt, count: ts.filter((t) => t >= s.firstAt && t <= s.lastAt).length }));
}

/** Spawn-retry storms: >=3 created in a 2-min window, or >=3 zero-turn/error exits in a 5-min window, per (lane, role). */
function computeSpawnStorms(agents) {
  const groups = new Map();
  for (const a of agents) {
    const lane = a.lane || "unknown";
    const role = a.role || "unknown";
    const g = getOrSet(groups, `${lane}|${role}`, () => ({ lane, role, created: [], zeroExits: [] }));
    if (a.createdAt !== null && a.createdAt !== undefined) g.created.push(a.createdAt);
    if (a.exited && (a.turns === 0 || a.exitError) && a.exitTs !== null && a.exitTs !== undefined) g.zeroExits.push(a.exitTs);
  }
  const entries = [];
  for (const g of groups.values()) {
    for (const s of findStorms(g.created, SPAWN_BURST_WINDOW_MS, SPAWN_BURST_MIN)) {
      entries.push({ lane: g.lane, role: g.role, count: s.count, windowMs: s.lastAt - s.firstAt, firstAt: new Date(s.firstAt).toISOString(), lastAt: new Date(s.lastAt).toISOString(), zeroTurnExits: 0 });
    }
    for (const s of findStorms(g.zeroExits, ZERO_TURN_EXIT_WINDOW_MS, ZERO_TURN_EXIT_MIN)) {
      entries.push({ lane: g.lane, role: g.role, count: s.count, windowMs: s.lastAt - s.firstAt, firstAt: new Date(s.firstAt).toISOString(), lastAt: new Date(s.lastAt).toISOString(), zeroTurnExits: s.count });
    }
  }
  entries.sort((a, b) => a.lane.localeCompare(b.lane) || a.role.localeCompare(b.role) || Date.parse(a.firstAt) - Date.parse(b.firstAt));
  const merged = [];
  for (const e of entries) {
    const last = merged[merged.length - 1];
    if (last && last.lane === e.lane && last.role === e.role && Date.parse(e.firstAt) <= Date.parse(last.lastAt)) {
      last.lastAt = e.lastAt;
      last.windowMs = Date.parse(last.lastAt) - Date.parse(last.firstAt);
      last.count = Math.max(last.count, e.count);
      last.zeroTurnExits = (last.zeroTurnExits ?? 0) + (e.zeroTurnExits ?? 0);
    } else {
      merged.push({ ...e });
    }
  }
  return merged;
}

export function getUsage({ home, since, until, git, laneCodes } = {}) {
  const homeDir = home || vibesquadHome();
  const dir = join(homeDir, "runner", "agents");
  const seen = new Set();
  const agg = new Map();
  const aggAgents = new Map(); // agg key -> Set of agent files (one agent spans several buckets when its role changes mid-day)
  const laneRole = new Map(); // lane|role -> stats (day-filtered)
  const laneAgents = new Map(); // lane -> { agents, handoffs, byRole: Map<role, count> }
  const loops = [];
  const agentStates = []; // { st, agentId } for whole-log v2 rollups
  let names = [];
  if (!isForbiddenRealHome(homeDir)) try { names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { /* no runner yet */ }
  for (const n of names) {
    const file = join(dir, n);
    seen.add(file);
    let st;
    try { st = refreshFile(file, statSync(file)); } catch { continue; }
    agentStates.push({ st, agentId: n.slice(0, -6) });
    const la = getOrSet(laneAgents, st.lane, () => ({ agents: 0, handoffs: 0, byRole: new Map() }));
    la.agents += 1;
    if (st.handoff) la.handoffs += 1;
    la.byRole.set(st.role, (la.byRole.get(st.role) ?? 0) + 1);
    if (st.turns > LOOP_TURN_THRESHOLD && !st.pass) loops.push({ agentId: n.slice(0, -6), lane: st.lane, role: st.role, title: st.title, turns: st.turns });
    for (const b of st.buckets.values()) {
      if ((since && b.day < since) || (until && b.day > until)) continue;
      const a = getOrSet(agg, `${b.provider}|${b.model}|${b.lane}|${b.day}`, () => ({ provider: b.provider, model: b.model, lane: b.lane, day: b.day, ...zeroStats(), agents: 0 }));
      addStats(a, b);
      const aKey = `${b.provider}|${b.model}|${b.lane}|${b.day}`;
      a.agents = getOrSet(aggAgents, aKey, () => new Set()).add(n).size;
      addStats(getOrSet(laneRole, `${b.lane}|${b.role}`, () => ({ lane: b.lane, role: b.role, ...zeroStats() })), b);
    }
  }
  for (const f of [...usageFiles.keys()]) if (!seen.has(f)) usageFiles.delete(f); // file removed: forget it
  const rows = [...agg.values()].sort((a, b) => b.day.localeCompare(a.day) || b.costUsd - a.costUsd);
  const by = (k) => {
    const m = new Map();
    for (const r of rows) addStats(getOrSet(m, r[k], () => ({ [k]: r[k], ...zeroStats() })), r);
    return [...m.values()].sort((a, b) => b.costUsd - a.costUsd);
  };
  const totals = rows.reduce((t, r) => addStats(t, r), zeroStats());

  // role / lane x role / coordination vs execution
  const lrRows = [...laneRole.values()].map(withAvg).sort((a, b) => a.lane.localeCompare(b.lane) || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  const roleMap = new Map();
  for (const r of lrRows) addStats(getOrSet(roleMap, r.role, () => ({ role: r.role, ...zeroStats() })), r);
  const split = (list) => {
    let coord = 0, exec = 0;
    for (const r of list) {
      if (COORDINATION_ROLES.has(r.role)) coord += r.inputTokens + r.outputTokens;
      else exec += r.inputTokens + r.outputTokens;
    }
    return { coordinationTokens: coord, executionTokens: exec, coordinationShare: coord + exec ? Math.round((coord / (coord + exec)) * 1000) / 1000 : 0 };
  };
  const laneIds = [...new Set([...lrRows.map((r) => r.lane), ...laneAgents.keys()])].sort();
  const lanes = laneIds.map((lane) => {
    const mine = lrRows.filter((r) => r.lane === lane);
    const la = laneAgents.get(lane) ?? { agents: 0, handoffs: 0, byRole: new Map() };
    // restarts = extra lead/brainstorm instances in the lane (each replaced an earlier one); handoffs = agents carrying vs.handoff-from.
    const restarts = [...COORDINATION_ROLES].reduce((s, r) => s + Math.max(0, (la.byRole.get(r) ?? 0) - 1), 0);
    return {
      lane, ...withAvg(mine.reduce((t, r) => addStats(t, r), zeroStats())), agents: la.agents, restarts, handoffs: la.handoffs,
      byRole: Object.fromEntries(mine.map((r) => [r.role || "unknown", withAvg(addStats(zeroStats(), r))])),
      ...split(mine),
    };
  });

  // merged units; cost per merged unit = lane cost / lane merged units. Lane via the (@code) tag -> teams.json lane code/id.
  const codes = laneCodes ? new Map(Object.entries(laneCodes).map(([k, v]) => [k.toLowerCase(), v])) : readLaneCodes(home);
  const mergedRaw = readMergedUnits(git).map((u) => ({ ...u, lane: u.code ? (codes.get(u.code) ?? u.code) : null }));
  const mergedByLane = new Map();
  for (const u of mergedRaw) if (u.lane) getOrSet(mergedByLane, u.lane, () => []).push(u);
  const laneCost = new Map(lanes.map((l) => [l.lane, l.costUsd]));

  // ---- v2: per-agent summaries, implementer attribution, unit cycles, fix-after-merge (usa-5)
  const agents = agentStates.map(({ st, agentId }) => agentV2(st, agentId));
  const merged = mergedRaw.map((u) => {
    const mergedAtMs = tsMs(u.mergedAt);
    const implementer = attributeImplementer(u, agents);
    const startMs = implementer?.createdAt ?? u.firstBranchCtMs ?? null;
    const unitCycleMs = startMs !== null && startMs !== undefined && mergedAtMs !== null ? Math.max(0, mergedAtMs - startMs) : null;
    const isFixUnit = (typeof u.unit === "string" && /^(fix|hotfix)-/i.test(u.unit)) || (typeof u.subject === "string" && FIX_UNIT_RE.test(u.subject));
    let fixAfterMerge = false;
    if (isFixUnit && u.lane && mergedAtMs !== null) {
      fixAfterMerge = mergedRaw.some((p) => p !== u && p.lane === u.lane && p.mergedAt !== null && tsMs(p.mergedAt) !== null && tsMs(p.mergedAt) < mergedAtMs && mergedAtMs - tsMs(p.mergedAt) <= FIX_AFTER_MERGE_WINDOW_MS);
    }
    return { ...u, mergedAtMs, implementerProfile: implementer ? implementer.profile : null, implementerAgentId: implementer ? implementer.agentId : null, unitCycleMs, fixAfterMerge };
  });

  // byProfile: group agents by (provider, profile, role); fold in attributed merged units.
  const profileMap = new Map();
  for (const a of agents) {
    const key = `${a.provider}|${a.profile}|${a.role}`;
    const g = getOrSet(profileMap, key, () => ({ provider: a.provider, profile: a.profile, role: a.role, runs: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, workingMs: 0, idleMs: 0, passCount: 0, loopCount: 0, mergedUnits: 0, reviewRounds: 0, unitCycleSum: 0, unitCycleCount: 0, fixAfterMergeCount: 0 }));
    g.runs += 1;
    g.turns += a.turns;
    g.inputTokens += a.inputTokens;
    g.outputTokens += a.outputTokens;
    g.costUsd += a.costUsd;
    g.workingMs += a.workingMs;
    g.idleMs += a.idleMs;
    if (a.pass) g.passCount += 1;
    if (a.loop) g.loopCount += 1;
  }
  for (const u of merged) {
    if (!u.implementerAgentId) continue;
    const a = agents.find((x) => x.agentId === u.implementerAgentId);
    if (!a) continue;
    const g = profileMap.get(`${a.provider}|${a.profile}|${a.role}`);
    if (!g) continue;
    g.mergedUnits += 1;
    g.reviewRounds += u.reviewRounds;
    if (u.unitCycleMs !== null) { g.unitCycleSum += u.unitCycleMs; g.unitCycleCount += 1; }
    if (u.fixAfterMerge) g.fixAfterMergeCount += 1;
  }
  const byProfile = [...profileMap.values()].map((g) => ({
    provider: g.provider, profile: g.profile, role: g.role,
    runs: g.runs, turns: g.turns, avgTurnsPerRun: g.runs ? Math.round((g.turns / g.runs) * 100) / 100 : 0,
    inputTokens: g.inputTokens, outputTokens: g.outputTokens, costUsd: g.costUsd,
    workingMs: g.workingMs, idleMs: g.idleMs,
    passCount: g.passCount, passRate: g.runs ? Math.round((g.passCount / g.runs) * 1000) / 1000 : 0,
    loopCount: g.loopCount,
    mergedUnits: g.mergedUnits, reviewRounds: g.reviewRounds, avgReviewRounds: g.mergedUnits ? Math.round((g.reviewRounds / g.mergedUnits) * 100) / 100 : 0,
    costPerMergedUnit: g.mergedUnits ? g.costUsd / g.mergedUnits : null,
    fixAfterMergeCount: g.fixAfterMergeCount, fixAfterMergeRate: g.mergedUnits ? Math.round((g.fixAfterMergeCount / g.mergedUnits) * 1000) / 1000 : 0,
    avgUnitCycleMs: g.unitCycleCount ? Math.round(g.unitCycleSum / g.unitCycleCount) : null,
  })).sort((a, b) => b.costUsd - a.costUsd || a.profile.localeCompare(b.profile) || a.role.localeCompare(b.role));

  // per-lane v2 aggregates: working/idle time, unit cycle, fix rate, and plan cycle from handoff log entries.
  const workByLane = new Map();
  for (const a of agents) {
    const g = getOrSet(workByLane, a.lane, () => ({ workingMs: 0, idleMs: 0 }));
    g.workingMs += a.workingMs;
    g.idleMs += a.idleMs;
  }
  const unitByLane = new Map();
  for (const u of merged) {
    if (!u.lane) continue;
    const g = getOrSet(unitByLane, u.lane, () => ({ sum: 0, count: 0, fixCount: 0, mergedCount: 0 }));
    g.mergedCount += 1;
    if (u.fixAfterMerge) g.fixCount += 1;
    if (u.unitCycleMs !== null) { g.sum += u.unitCycleMs; g.count += 1; }
  }
  const mergesByLaneMs = new Map();
  for (const u of merged) if (u.lane && u.mergedAtMs !== null) getOrSet(mergesByLaneMs, u.lane, () => []).push(u.mergedAtMs);
  for (const arr of mergesByLaneMs.values()) arr.sort((a, b) => a - b);
  const handoffsByLane = new Map();
  for (const h of readHandoffs(home)) getOrSet(handoffsByLane, h.lane, () => []).push(h.ts);
  const planByLane = new Map();
  for (const [lane, hts] of handoffsByLane) {
    const merges = mergesByLaneMs.get(lane) ?? [];
    const cycles = [];
    for (let i = 0; i < hts.length; i++) {
      const next = i + 1 < hts.length ? hts[i + 1] : Infinity;
      const last = merges.filter((m) => m >= hts[i] && m < next).at(-1);
      if (last !== undefined) cycles.push(Math.max(0, last - hts[i]));
    }
    planByLane.set(lane, { cycles, avg: cycles.length ? Math.round(cycles.reduce((s, c) => s + c, 0) / cycles.length) : null });
  }
  const laneV2 = new Map();
  for (const lane of laneIds) {
    const work = workByLane.get(lane) ?? { workingMs: 0, idleMs: 0 };
    const cyc = unitByLane.get(lane) ?? { sum: 0, count: 0, fixCount: 0, mergedCount: 0 };
    const plan = planByLane.get(lane) ?? { cycles: [], avg: null };
    const total = work.workingMs + work.idleMs;
    laneV2.set(lane, {
      workingMs: work.workingMs, idleMs: work.idleMs,
      workPct: total ? Math.round((work.workingMs / total) * 1000) / 1000 : 0,
      avgUnitCycleMs: cyc.count ? Math.round(cyc.sum / cyc.count) : null,
      planCycleMs: plan.avg, planCycles: plan.cycles,
      fixAfterMergeCount: cyc.fixCount, fixAfterMergeRate: cyc.mergedCount ? Math.round((cyc.fixCount / cyc.mergedCount) * 1000) / 1000 : 0,
    });
  }

  const perLane = [...mergedByLane].map(([lane, us]) => {
    const rounds = us.reduce((s, u) => s + u.reviewRounds, 0);
    const cost = laneCost.get(lane) ?? 0;
    const cyc = unitByLane.get(lane) ?? { sum: 0, count: 0, fixCount: 0, mergedCount: 0 };
    return { lane, mergedUnits: us.length, reviewRounds: rounds, avgReviewRounds: Math.round((rounds / us.length) * 100) / 100, costUsd: cost, costPerMergedUnit: cost / us.length, avgUnitCycleMs: cyc.count ? Math.round(cyc.sum / cyc.count) : null, fixAfterMergeCount: cyc.fixCount, fixAfterMergeRate: cyc.mergedCount ? Math.round((cyc.fixCount / cyc.mergedCount) * 1000) / 1000 : 0 };
  }).sort((a, b) => b.mergedUnits - a.mergedUnits);

  return {
    note: "Cost is summed from turn_done.costUsd; token counts come from adapter usage events and are 0 for logs that have none.",
    files: seen.size,
    totals,
    byProvider: by("provider"),
    byModel: by("model"),
    byLane: by("lane"),
    byDay: by("day"),
    rows,
    limits: readLimits(home),
    byRole: [...roleMap.values()].map(withAvg).sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)),
    lanes: lanes.map((l) => ({ ...l, ...(laneV2.get(l.lane) ?? {}) })),
    laneRole: lrRows,
    coordination: split(lrRows),
    merged: { units: merged, perLane },
    loops: { threshold: LOOP_TURN_THRESHOLD, flagged: loops.sort((a, b) => b.turns - a.turns) },
    byProfile,
    spawnStorms: computeSpawnStorms(agents),
  };
}

// ---------------------------------------------------------------- HTTP
/** Handles /__vibesquad/providers*. Writes (settings POST) are owner-gated by the caller (vibesquad-api.mjs). */
export async function handleProvidersApi(req, res, { sendJson, readBody, home, ...probeOpts }) {
  try {
    const url = new URL(req.url, "http://x");
    const sub = url.pathname.slice("/__vibesquad/providers".length).replace(/^\/+|\/+$/g, "");
    const opts = { home, refresh: url.searchParams.get("refresh") === "1", ...probeOpts };
    if (sub === "settings") {
      if (req.method === "GET") return sendJson(res, 200, { ok: true, path: settingsPath(home), runner: loadRunnerSettings(home) });
      if (req.method === "POST" || req.method === "PUT") {
        const body = await readBody(req);
        return sendJson(res, 200, { ok: true, runner: saveRunnerSettings(body?.runner ?? body, home) });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
    if (sub === "") return sendJson(res, 200, await getProviders(opts));
    if (sub === "models") return sendJson(res, 200, await getModels(url.searchParams.get("provider") ?? "", opts));
    if (sub === "modes") return sendJson(res, 200, await getModes(url.searchParams.get("provider") ?? "", opts));
    if (sub === "usage") return sendJson(res, 200, getUsage({ home, since: url.searchParams.get("since") || undefined, until: url.searchParams.get("until") || undefined, git: probeOpts.git }));
    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    return sendJson(res, 500, { error: String(err?.message ?? err) });
  }
}
