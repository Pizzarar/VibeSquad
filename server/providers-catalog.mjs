// Provider/model/mode catalog + runner usage rollups + runner settings for the UI (runner pilot B9).
// /__vibesquad/providers[/models|/modes|/usage|/settings]. Shapes match what src/paseoProviders.ts got from the
// Paseo daemon ({providers:[{provider,available,error}]}, {models:[{id,label,...}]}, {modes:[...]}).
// Probing: `<cli> --version` on the resolved executable, no shell, cached with a TTL. No background timers.
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ACP_PROVIDERS, PROVIDER_ALIASES } from "../runner/adapters/acp.mjs";
import { killTree, resolveExecutable, spawnNoShell } from "../runner/spawn.mjs";
// runner.mjs is import-safe here: it (and its deps — adapters, log, limits) only declare factories/constants, no
// import-time side effects, and none of them import back into this module (no cycle). turnCapsFromEnv is a pure env read.
import { turnCapsFromEnv } from "../runner/runner.mjs";
import { DEFAULT_PACK_PROFILES, getProfilesPath, normalizeProfile } from "./profiles.mjs";
import { resolveTeamsFilePath } from "./teams-file.mjs";
import { resolveProjectPath } from "./brief-path.mjs";
import { addInboxCards, readInboxCards, significantTokenOverlap } from "./inbox.mjs";
import { isForbiddenRealHome, underTestRunner } from "./test-guard.mjs";
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

// Periodic Opus + Gemini usage review cadence (usa-7). Off means "never auto-run"; manual Run now still works.
export const USAGE_REVIEW_INTERVALS = ["off", "6h", "12h", "1d", "3d", "5d", "2w"];
const USAGE_REVIEW_DEFAULT_INTERVAL = "1d";
const USAGE_REVIEW_INTERVAL_MS = {
  "6h": 6 * 3600_000,
  "12h": 12 * 3600_000,
  "1d": 24 * 3600_000,
  "3d": 3 * 24 * 3600_000,
  "5d": 5 * 24 * 3600_000,
  "2w": 14 * 24 * 3600_000,
};
/** Interval label -> milliseconds; "off" (and anything unknown) -> null. */
export function intervalMs(interval) {
  return typeof interval === "string" && Object.prototype.hasOwnProperty.call(USAGE_REVIEW_INTERVAL_MS, interval)
    ? USAGE_REVIEW_INTERVAL_MS[interval]
    : null;
}

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
  const interval = USAGE_REVIEW_INTERVALS.includes(r.usageReview?.interval) ? r.usageReview.interval : USAGE_REVIEW_DEFAULT_INTERVAL;
  return { providers, usageReview: { interval } };
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
  const usageReview = patch && patch.usageReview && typeof patch.usageReview === "object"
    ? incoming.usageReview
    : current.usageReview;
  const next = { ...raw, runner: { ...(raw.runner && typeof raw.runner === "object" ? raw.runner : {}), providers, usageReview } };
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
    if (ev.type === "error" || ev.error != null || (ev.code != null && ev.code !== 0)) {
      st.exitError = true;
      st.errors = (st.errors ?? 0) + 1;
      const msg = ev.type === "error" ? (ev.message ?? ev.error) : (ev.error ?? (ev.code != null && ev.code !== 0 ? `exit code ${ev.code}` : ""));
      if (msg) { st.lastError = String(msg).slice(0, 200); st.lastErrorTs = t; }
    }
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
  const team = m.team ?? m.labels?.team;
  if (typeof team === "string" && team) st.team = team;
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
  if (!st || stat.size < st.offset) st = { offset: 0, provider: "unknown", model: "unknown", lane: "", role: "", prevCost: 0, buckets: new Map(), turns: 0, tail: "", pass: false, handoff: false, title: "", profile: undefined, cwd: undefined, createdAt: undefined, firstTs: undefined, lastTs: undefined, workingMs: 0, runningSince: undefined, exited: false, exitError: false, exitTs: undefined, errors: 0, lastError: "", lastErrorTs: undefined };
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

/**
 * The git checkout `readMergedUnits` must run against. In the installed app the server runs from
 * %LOCALAPPDATA%\VibeSquad\runtime (a deployed copy, not a git checkout), so REPO_ROOT alone points at a
 * non-repo and `git log` returns nothing -> 0 merged units -> empty implementer attribution (usa-10 root cause).
 * Resolve the real checkout: VIBESQUAD_ROOT override (same convention as brainstorm.mjs / lead-handoff.mjs), else
 * the repo the runtime was last synced from (build-stamp.json), else REPO_ROOT (the dev checkout).
 */
function gitRepoRoot({ runtimeRoot = REPO_ROOT, envRoot = process.env.VIBESQUAD_ROOT } = {}) {
  if (envRoot) return resolve(envRoot);
  try {
    const stampPath = join(runtimeRoot, "build-stamp.json");
    if (existsSync(stampPath)) {
      const stamp = JSON.parse(readFileSync(stampPath, "utf8"));
      const repo = typeof stamp?.repo === "string" ? stamp.repo.trim() : "";
      const workTree = repo.replace(/[\\/]+\.git[\\/]*$/, "");
      if (workTree) return resolve(workTree);
    }
  } catch { /* not a runtime or no stamp: fall through to runtimeRoot */ }
  return resolve(runtimeRoot);
}

const gitIn = (root) => (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
const defaultGit = (args) => execFileSync("git", args, { cwd: gitRepoRoot(), encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
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

const mergedCache = new WeakMap(); // git fn -> { head, units }: recomputed only when HEAD changes (one entry per repo's git fn)

/**
 * Parse one `git log --first-parent --numstat --format=%H` into sha -> {locAdded, locDeleted, filesChanged}.
 * The `--first-parent` walk keeps the diff of a merge against its first parent (the LOC the branch introduced),
 * which `git log --numstat` would otherwise omit for merge commits. Bounded by MAX_COMMITS, one spawn.
 */
function parseNumstat(raw) {
  const out = new Map();
  let cur = null;
  for (const line of String(raw ?? "").split("\n")) {
    const sha = /^([0-9a-f]{7,64})$/.exec(line.trim())?.[1];
    if (sha) { cur = sha; if (!out.has(cur)) out.set(cur, { locAdded: 0, locDeleted: 0, filesChanged: 0 }); continue; }
    if (!cur) continue;
    const ns = /^(-|\d+)\t(-|\d+)\t/.exec(line);
    if (ns) {
      const st = out.get(cur);
      st.locAdded += ns[1] === "-" ? 0 : Number(ns[1]);
      st.locDeleted += ns[2] === "-" ? 0 : Number(ns[2]);
      st.filesChanged += 1;
    }
  }
  return out;
}

/** Merge commits -> units {sha, unit, code, reviewRounds, mergedAt, locAdded, locDeleted, filesChanged, subject}.
 * unit = branch from "Merge branch 'x'". One `git log` over recent history joined in memory (no per-merge spawns),
 * cached by HEAD sha, plus one bounded `--first-parent --numstat` companion pass for LOC (also cached). The merged side
 * of a merge = commits reachable from its 2nd parent until the first-parent (mainline) chain from HEAD is hit.
 * reviewRounds = highest N among "review rN" subjects on that side. Lane code = the merge subject's `(@code)` tag,
 * else the first tag found on the merged side. */
export function readMergedUnits(git = defaultGit) {
  let head = "";
  try { head = git(["rev-parse", "HEAD"]).trim(); } catch { return []; }
  const cached = mergedCache.get(git);
  if (cached && cached.head === head) return cached.units;
  let raw = "";
  try { raw = git(["log", `-${MAX_COMMITS}`, "--format=%H%x1f%P%x1f%ct%x1f%s"]); } catch { return []; }
  const commits = new Map();
  for (const line of raw.split("\n")) {
    const [sha, parents, ct, subject = ""] = line.split("\x1f");
    if (sha) commits.set(sha, { sha, parents: (parents ?? "").trim().split(/\s+/).filter(Boolean), ct, subject });
  }
  // Companion LOC pass (usa-10): merge first-parent diffs, keyed by sha. Optional: a git that only answers
  // `rev-parse`/`log` (older fixtures) yields an empty map and units keep locAdded=0.
  let numstat = new Map();
  try { numstat = parseNumstat(git(["log", `-${MAX_COMMITS}`, "--first-parent", "--numstat", "--format=%H"])); } catch { /* LOC is best-effort */ }
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
    const loc = numstat.get(c.sha) ?? { locAdded: 0, locDeleted: 0, filesChanged: 0 };
    units.push({ sha: c.sha, unit: branch, code, reviewRounds: rounds, mergedAt: Number.isFinite(Number(c.ct)) ? new Date(Number(c.ct) * 1000).toISOString() : null, firstBranchCtMs: firstCt === null ? null : firstCt * 1000, subject: c.subject, locAdded: loc.locAdded, locDeleted: loc.locDeleted, filesChanged: loc.filesChanged });
  }
  mergedCache.set(git, { head, units });
  return units;
}

// ---- usa-20: pool merged units across every Squad repo (teams.json team/lane paths), not just gitRepoRoot().
const MAX_SQUAD_REPOS = 16;
const HEAD_CHECK_TTL_MS = 15_000; // a poll within this window reuses the repo's units without spawning git at all
const repoGitFns = new Map(); // normalised root -> stable git fn (the readMergedUnits cache key)
const repoHeadCheck = new Map(); // normalised root -> { at, units }
const normRepoKey = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

/** Nearest ancestor holding a .git entry (no spawn). A linked worktree's .git file folds back to its main checkout. */
function repoToplevel(dir) {
  let cur = resolve(dir);
  for (let i = 0; i < 40; i++) {
    const g = join(cur, ".git");
    try {
      const st = statSync(g);
      if (st.isDirectory()) return cur;
      if (st.isFile()) {
        const m = /^gitdir:s*(.+)$/m.exec(readFileSync(g, "utf8"));
        const wt = m ? /^(.*)[\/].git[\/]worktrees[\/][^\/]+$/.exec(resolve(cur, m[1].trim())) : null;
        return wt ? wt[1] : cur;
      }
    } catch { /* no .git here */ }
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

/** Distinct git repos the Squads work in: [{ root, name, teams: [teamId], laneTeam: Map<laneId, teamId> }]. gitRepoRoot() is always first. */
function readSquadRepos(home) {
  const primary = gitRepoRoot();
  const repos = new Map();
  const add = (root, teamId, laneId) => {
    if (!root) return;
    const key = normRepoKey(root);
    let r = repos.get(key);
    if (!r) {
      if (repos.size >= MAX_SQUAD_REPOS) return;
      r = { root, name: basename(root), teams: [], laneTeam: new Map() };
      repos.set(key, r);
    }
    if (teamId && !r.teams.includes(teamId)) r.teams.push(teamId);
    if (laneId && teamId && !r.laneTeam.has(laneId)) r.laneTeam.set(laneId, teamId);
  };
  add(primary, null, null);
  try {
    const own = home ? join(home, "teams.json") : null;
    const file = own && !isForbiddenRealHome(home) && existsSync(own) ? own : resolveTeamsFilePath(primary);
    const t = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
    for (const team of t.teams ?? []) {
      const teamId = team?.id ? String(team.id) : null;
      const resolveTop = (p) => {
        try {
          const full = resolveProjectPath(p, primary);
          return full ? repoToplevel(realpathSync(full)) : null;
        } catch { return null; }
      };
      for (const p of team?.paths ?? []) add(resolveTop(p), teamId, null);
      for (const l of team?.lanes ?? []) {
        const lp = [...(l?.paths ?? []), ...(l?.path ? [l.path] : [])];
        for (const p of lp) add(resolveTop(p), teamId, l?.id ? String(l.id) : null);
      }
    }
  } catch { /* no teams.json: primary repo only */ }
  return [...repos.values()];
}

/** Merged units of every Squad repo, each tagged { repo, squad } and keyed repo+sha. Per-repo cache by HEAD, plus a
 * short HEAD-check TTL so a poll storm spawns at most one `git rev-parse` per repo per 15s. */
function readPooledMergedUnits(home, laneOf, now = Date.now) {
  const out = [];
  for (const r of readSquadRepos(home)) {
    const key = normRepoKey(r.root);
    const t = now();
    let hc = repoHeadCheck.get(key);
    if (!hc || t - hc.at >= HEAD_CHECK_TTL_MS) {
      let git = repoGitFns.get(key);
      if (!git) { git = gitIn(r.root); repoGitFns.set(key, git); }
      hc = { at: t, units: readMergedUnits(git) };
      repoHeadCheck.set(key, hc);
    }
    for (const u of hc.units) {
      const lane = laneOf(u);
      out.push({ ...u, lane, repo: r.name, squad: (lane && r.laneTeam.get(lane)) || r.teams[0] || null });
    }
  }
  return out;
}

/** lowercase lane code or id -> lane id, from <home>/teams.json lanes[]. */
function readLaneCodes(home) {
  const map = new Map();
  try {
    const own = home ? join(home, "teams.json") : null;
    const file = own && !isForbiddenRealHome(home) && existsSync(own) ? own : resolveTeamsFilePath(gitRepoRoot());
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
    team: st.team ?? null,
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
    errors: st.errors ?? 0,
    lastError: st.lastError ?? "",
    lastErrorTs: st.lastErrorTs ?? null,
    handoff: !!st.handoff,
    loop: st.turns > LOOP_TURN_THRESHOLD && !st.pass,
  };
}

/**
 * The unit name a worker's cwd resolves to: basename() already strips both `\` and `/` (Windows worktree paths such as
 * <sanctuary>\worktrees\VibeSquad\<unit> use backslashes, some logs use forward slashes). Lower-cased so a worktree dir
 * that differs in case from the branch name still matches (git branch names are case-insensitive on Windows).
 */
const unitNameOfCwd = (cwd) => (typeof cwd === "string" && cwd ? basename(cwd).toLowerCase() : "");

/** A run carrying a team may only implement units of that Squad's repo (lane ids can repeat across Squads); untagged on either side matches. */
const sameSquad = (unit, agent) => !unit.squad || !agent.team || unit.squad === agent.team;

/** Attribute a merged unit to the implementer worker: basename(cwd) === unit (case-insensitive), else the single worker in the lane created before mergedAt. */
function attributeImplementer(unit, agents) {
  const mergedAtMs = tsMs(unit.mergedAt);
  if (typeof unit.unit === "string" && unit.unit) {
    const want = unit.unit.toLowerCase();
    const matches = agents.filter((a) => a.role === "worker" && unitNameOfCwd(a.cwd) === want && sameSquad(unit, a));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null; // ambiguous cwd match
  }
  if (!unit.lane || mergedAtMs === null) return null;
  const workers = agents.filter((a) => a.role === "worker" && a.lane === unit.lane && sameSquad(unit, a) && a.createdAt !== null && a.createdAt <= mergedAtMs);
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

// Recent vs-log signals for the periodic usage review (usa-9): @usa/usage-lane notes, friction (blockers, FAIL
// completions, restart-feedback, cap/queue/failover decisions) and compact mcp-alias metric counts. Harvested from
// <home>/logs/*.jsonl and <home>/teams/*/log.jsonl, deduped like readHandoffs (the same entry lands in both). Entries
// with ts <= sinceMs are dropped (sinceMs null/undefined -> no filter). Newest wins; the combined signal list is capped
// at 25 lines. Malformed lines and missing dirs never throw.
const NOTE_TYPES = new Set(["metric", "decision", "blocker", "handoff"]);
const FRICTION_DECISION_RE = /\b(?:cap|queue|jam|failover|re-dispatch|archiv|timeout|stuck|retry)\b/i;
// plugin-agent metric noise (hook-timing / prompt-injection) never counts as a @usa/usage note.
const PLUGIN_METRIC_NOISE_RE = /^(?:plugin:|hook-timing\b|prompt-injection\b)/i;
export function readUsageLogSignals(home, { sinceMs } = {}) {
  const dir = home || vibesquadHome();
  if (isForbiddenRealHome(dir)) return { notes: [], friction: [], mcpAlias: [] };
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
  const hits = []; // { lane, ts, type, text, agent, note, friction } before the 25-line cap
  const mcpCounts = new Map(); // "tool|lane" -> count
  for (const file of files) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      const t = tsMs(e.ts);
      if (t === null) continue;
      if (sinceMs !== null && sinceMs !== undefined && t <= sinceMs) continue;
      const lane = typeof e.lane === "string" && e.lane ? e.lane : "";
      const textStr = typeof e.text === "string" ? e.text : "";
      const agent = typeof e.agent === "string" ? e.agent : "";
      const key = `${lane}\u0000${t}\u0000${textStr.slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const type = e.type;
      if (type === "metric" && textStr.startsWith("mcp-alias:")) {
        const m = /mcp-alias:\s*tool=(\S+)(?:\s+\S+)*\s+lane=(\S+)/.exec(textStr);
        const tool = m?.[1] ?? "?";
        const mlane = m?.[2] ?? lane;
        const k = `${tool}|${mlane}`;
        mcpCounts.set(k, (mcpCounts.get(k) ?? 0) + 1);
        continue; // mcp-alias metrics are compact-counted, never listed as note/friction lines
      }
      const isNote = (textStr.includes("@usa") || lane === "usage") && NOTE_TYPES.has(type)
        && !(type === "metric" && (PLUGIN_METRIC_NOISE_RE.test(textStr) || agent === "plugin"));
      const isFriction = type === "blocker" || type === "restart-feedback"
        || (type === "metric" && textStr.startsWith("restart-feedback:"))
        || (type === "done" && /\bFAIL\b/i.test(textStr))
        || (type === "decision" && FRICTION_DECISION_RE.test(textStr));
      if (isNote || isFriction) hits.push({ lane, ts: t, type, text: textStr, agent, note: isNote, friction: isFriction });
    }
  }
  hits.sort((a, b) => b.ts - a.ts);
  const capped = hits.slice(0, 25);
  const strip = (h) => ({ lane: h.lane, ts: h.ts, type: h.type, text: h.text, agent: h.agent });
  const mcpAlias = [...mcpCounts.entries()].map(([k, count]) => {
    const [tool, lane] = k.split("|");
    return { tool, lane, count };
  }).sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool) || a.lane.localeCompare(b.lane));
  return { notes: capped.filter((h) => h.note).map(strip), friction: capped.filter((h) => h.friction).map(strip), mcpAlias };
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

// ---------------------------------------------------------------- benchmark ledger, A/B workflow, savings, cohorts, floor (usa-10)

const WF_TAG_RE = /\[wf:([^\]]+)\]/i;
const OPUS_IN_PER_MT = 15; // $ per million input tokens — all-Opus routing baseline
const OPUS_OUT_PER_MT = 75; // $ per million output tokens
const BRIEF_TOKENS = 5000; // isolated workers each carry a <5k brief (spec)

/** Implementer provider -> one of the workflow families: gemini | claude | dsp | null. */
function providerFamily(provider) {
  const p = String(provider ?? "").toLowerCase();
  if (p === "antigravity-cli" || p === "agy" || p.includes("antigravity") || p.includes("gemini")) return "gemini";
  if (p === "claude") return "claude";
  if (p === "opencode" || p.includes("deepseek") || p.includes("dsp")) return "dsp";
  return p || null;
}

/** workflowMode: explicit `[wf:<mode>]` tag wins (pilot uses [wf:sonnet]/[wf:dsp]/[wf:gemini], keep the tag value),
 * else derived from the implementer's provider/profile (the current default review loop is Review-Gemini, hence
 * "sonnet+gemini-review" / "dsp+gemini-review"; a Gemini implementer is "gemini-full"; other Claude = "claude-only"). */
function classifyWorkflowMode(unit, implementer) {
  const m = WF_TAG_RE.exec(unit?.subject ?? "");
  if (m) return m[1].trim().toLowerCase() || "unattributed";
  const fam = providerFamily(implementer?.provider);
  const profile = String(implementer?.profile ?? "").toLowerCase();
  if (fam === "gemini") return "gemini-full";
  if (fam === "claude") return profile.includes("sonnet") ? "sonnet+gemini-review" : "claude-only";
  if (fam === "dsp") return "dsp+gemini-review";
  return "unattributed";
}

/** A/B workflow rollup. Cost/tokens per unit come from the attributed implementer (one worker ≈ one unit). */
function buildByWorkflow(merged, agentById) {
  const groups = new Map();
  for (const u of merged) {
    const implementer = u.implementerAgentId ? agentById.get(u.implementerAgentId) : null;
    const workflowMode = u.workflowMode ?? classifyWorkflowMode(u, implementer);
    const g = getOrSet(groups, workflowMode, () => ({
      workflowMode, units: 0, firstTryPassCount: 0, reviewRoundsSum: 0, costUsd: 0,
      inputTokens: 0, outputTokens: 0, locAdded: 0, locDeleted: 0, unitCycleSum: 0, unitCycleCount: 0,
      fixAfterMergeCount: 0, knownCostUnits: 0,
    }));
    g.units += 1;
    if ((u.reviewRounds ?? 0) <= 1) g.firstTryPassCount += 1;
    g.reviewRoundsSum += u.reviewRounds ?? 0;
    const cost = Number.isFinite(u.costUsd) ? u.costUsd : 0;
    g.costUsd += cost;
    g.inputTokens += u.inputTokens ?? 0;
    g.outputTokens += u.outputTokens ?? 0;
    g.locAdded += u.locAdded ?? 0;
    g.locDeleted += u.locDeleted ?? 0;
    if (cost > 0) g.knownCostUnits += 1;
    if (u.unitCycleMs !== null && u.unitCycleMs !== undefined) { g.unitCycleSum += u.unitCycleMs; g.unitCycleCount += 1; }
    if (u.fixAfterMerge) g.fixAfterMergeCount += 1;
  }
  return [...groups.values()].map((g) => {
    const totalLoc = g.locAdded + g.locDeleted;
    return {
      workflowMode: g.workflowMode,
      units: g.units,
      firstTryPassRate: g.units ? Math.round((g.firstTryPassCount / g.units) * 1000) / 1000 : 0,
      avgReviewRounds: g.units ? Math.round((g.reviewRoundsSum / g.units) * 100) / 100 : 0,
      costUsd: g.costUsd,
      costPerUnit: g.units ? g.costUsd / g.units : null,
      costPer100Loc: totalLoc > 0 ? (g.costUsd / totalLoc) * 100 : null,
      tokensPerUnit: g.units ? Math.round(((g.inputTokens + g.outputTokens) / g.units) * 100) / 100 : 0,
      avgUnitCycleMs: g.unitCycleCount ? Math.round(g.unitCycleSum / g.unitCycleCount) : null,
      fixAfterMergeRate: g.units ? Math.round((g.fixAfterMergeCount / g.units) * 1000) / 1000 : 0,
      costCoverage: g.units ? Math.round((g.knownCostUnits / g.units) * 1000) / 1000 : 0,
    };
  }).sort((a, b) => b.units - a.units || a.workflowMode.localeCompare(b.workflowMode));
}

/** Counterfactual savings vs a solo monolithic Opus workflow. Baselines are commented inline; divide-by-zero -> null. */
function buildSavings(merged, totals, lanes, agents) {
  const inputTokens = totals.inputTokens ?? 0;
  const outputTokens = totals.outputTokens ?? 0;
  // (a) Role-tier routing savings: price every token at Opus rates and compare against the actual mixed-tier spend.
  const soloOpusBaselineUsd = (inputTokens * OPUS_IN_PER_MT + outputTokens * OPUS_OUT_PER_MT) / 1_000_000;
  const actualCostUsd = totals.costUsd ?? 0;
  const routingSavingsUsd = Math.max(0, soloOpusBaselineUsd - actualCostUsd);
  const routingSavingsPct = soloOpusBaselineUsd > 0 ? routingSavingsUsd / soloOpusBaselineUsd : null;

  // (b) Context-isolation savings: a monolithic session re-sends every prior assistant output each turn (+ a brief),
  // so its input ≈ Σ_turns (brief + prior outputs). Isolated workers only pay the brief once and never re-send peers'
  // output. Model uniform output per turn: monolithicInput_lane = turns*brief + outputTokens*(turns-1)/2.
  let monolithicBaselineTokens = 0;
  for (const l of lanes) {
    const t = l.turns ?? 0;
    if (!t) continue;
    monolithicBaselineTokens += t * BRIEF_TOKENS + ((l.outputTokens ?? 0) * (t - 1)) / 2;
  }
  const contextSavingsTokens = Math.max(0, monolithicBaselineTokens - inputTokens);

  // (c) Parallelism speedup: total active-agent working time over the wall-clock active span (first active ts -> last).
  let activeAgentWorkMs = 0;
  let minFirst = null;
  let maxLast = null;
  for (const a of agents) {
    activeAgentWorkMs += a.workingMs ?? 0;
    if (a.firstTs !== null && a.firstTs !== undefined && (minFirst === null || a.firstTs < minFirst)) minFirst = a.firstTs;
    if (a.lastTs !== null && a.lastTs !== undefined && (maxLast === null || a.lastTs > maxLast)) maxLast = a.lastTs;
  }
  const wallClockActiveSpanMs = minFirst !== null && maxLast !== null ? Math.max(0, maxLast - minFirst) : 0;
  const parallelSpeedup = wallClockActiveSpanMs > 0 ? activeAgentWorkMs / wallClockActiveSpanMs : null;

  const totalLocChanged = merged.reduce((s, u) => s + (u.locAdded ?? 0) + (u.locDeleted ?? 0), 0);
  const mergedUnits = merged.length;
  return {
    routingSavingsUsd,
    soloOpusBaselineUsd,
    actualCostUsd,
    routingSavingsPct: routingSavingsPct === null ? null : Math.round(routingSavingsPct * 1000) / 1000,
    contextSavingsTokens: Math.round(contextSavingsTokens),
    monolithicBaselineTokens: Math.round(monolithicBaselineTokens),
    parallelSpeedup: parallelSpeedup === null ? null : Math.round(parallelSpeedup * 100) / 100,
    activeAgentWorkMs: Math.round(activeAgentWorkMs),
    wallClockActiveSpanMs: Math.round(wallClockActiveSpanMs),
    totalLocChanged,
    costPer100Loc: totalLocChanged > 0 ? (actualCostUsd / totalLocChanged) * 100 : null,
    costPerMergedUnit: mergedUnits > 0 ? actualCostUsd / mergedUnits : null,
  };
}

function cohortOf(units) {
  const n = units.length;
  if (!n) return { units: 0, firstTryPassRate: null, avgReviewRounds: null, costPerUnit: null, tokensPerUnit: null, avgUnitCycleMs: null, fixAfterMergeRate: null };
  let firstTry = 0, rounds = 0, cost = 0, tokens = 0, cycSum = 0, cycCount = 0, fix = 0;
  for (const u of units) {
    if ((u.reviewRounds ?? 0) <= 1) firstTry += 1;
    rounds += u.reviewRounds ?? 0;
    cost += Number.isFinite(u.costUsd) ? u.costUsd : 0;
    tokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    if (u.unitCycleMs !== null && u.unitCycleMs !== undefined) { cycSum += u.unitCycleMs; cycCount += 1; }
    if (u.fixAfterMerge) fix += 1;
  }
  return {
    units: n,
    firstTryPassRate: round2(firstTry / n),
    avgReviewRounds: round2(rounds / n),
    costPerUnit: round2(cost / n),
    tokensPerUnit: round2(tokens / n),
    avgUnitCycleMs: cycCount ? Math.round(cycSum / cycCount) : null,
    fixAfterMergeRate: round2(fix / n),
  };
}

/** Last ≤10 merged units (recent) vs the preceding ≤10 (prior); delta = recent - prior per metric. */
function buildCohorts(merged) {
  const sorted = [...merged].sort((a, b) => (a.mergedAtMs ?? 0) - (b.mergedAtMs ?? 0));
  const recent = cohortOf(sorted.slice(-10));
  const prior = cohortOf(sorted.slice(-20, -10));
  const delta = {};
  for (const k of ["firstTryPassRate", "avgReviewRounds", "costPerUnit", "tokensPerUnit", "avgUnitCycleMs", "fixAfterMergeRate"]) {
    delta[k] = recent[k] === null || prior[k] === null ? null : round2(recent[k] - prior[k]);
  }
  return { recent, prior, delta };
}

/**
 * Clean-Run Floor: split total spend into "clean shipping" vs four waste buckets.
 *   reworkCostUsd            = Σ costUsd of merged units with reviewRounds >= 2
 *   fixAfterMergeCostUsd     = Σ costUsd of merged units flagged fixAfterMerge (non-rework)
 *   loopAndAbandonedCostUsd  = Σ costUsd of loop-flagged agents + abandoned workers (turns>0, !pass, never merged)
 *   restartOverheadCostUsd   = Σ costUsd of handoff-carrier agents + extra (non-first) lead/brainstorm per lane
 * cleanCostUsd = total - Σ buckets (clamped >= 0), so clean + buckets === total by construction.
 */
function buildFloor(merged, agents, totals) {
  let rework = 0, fixCost = 0;
  for (const u of merged) {
    const c = Number.isFinite(u.costUsd) ? u.costUsd : 0;
    if ((u.reviewRounds ?? 0) >= 2) rework += c;
    else if (u.fixAfterMerge) fixCost += c;
  }
  const implementerIds = new Set(merged.map((u) => u.implementerAgentId).filter(Boolean));
  let loopAbandoned = 0, restart = 0;
  const firstCoord = new Set();
  for (const a of agents) {
    if (a.loop) { loopAbandoned += a.costUsd; continue; }
    if (a.role === "worker" && a.turns > 0 && !a.pass && !implementerIds.has(a.agentId)) { loopAbandoned += a.costUsd; continue; }
    if (a.handoff) { restart += a.costUsd; continue; }
    if (COORDINATION_ROLES.has(a.role) && (a.turns > 0 || a.costUsd > 0)) {
      const key = `${a.lane}|${a.role}`;
      if (firstCoord.has(key)) restart += a.costUsd;
      else firstCoord.add(key);
    }
  }
  const totalCostUsd = totals.costUsd ?? 0;
  const totalTokens = (totals.inputTokens ?? 0) + (totals.outputTokens ?? 0);
  const waste = rework + fixCost + loopAbandoned + restart;
  const cleanCostUsd = Math.max(0, totalCostUsd - waste);
  const cleanShare = totalCostUsd > 0 ? cleanCostUsd / totalCostUsd : null;
  const mergedUnits = merged.length;
  return {
    cleanCostUsd,
    cleanShare: cleanShare === null ? null : round2(cleanShare),
    wasteShare: cleanShare === null ? null : round2(1 - cleanShare),
    cleanCostPerUnit: mergedUnits > 0 ? cleanCostUsd / mergedUnits : null,
    cleanTokensPerUnit: mergedUnits > 0 && cleanShare !== null ? (totalTokens * cleanShare) / mergedUnits : null,
    reworkCostUsd: rework,
    loopAndAbandonedCostUsd: loopAbandoned,
    fixAfterMergeCostUsd: fixCost,
    restartOverheadCostUsd: restart,
  };
}

// ---- durable ledger: <home>/runner/usage-ledger.jsonl (one JSON line per record)

const usageLedgerPath = (home) => join(home || vibesquadHome(), "runner", "usage-ledger.jsonl");

/** usage-ledger.jsonl -> records (newest last). Missing file / bad lines tolerated. */
export function readUsageLedger(home) {
  const dir = home || vibesquadHome();
  if (isForbiddenRealHome(dir)) return [];
  let text = "";
  try { text = readFileSync(join(dir, "runner", "usage-ledger.jsonl"), "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* bad line */ }
  }
  return out;
}

/** Idempotently append snapshot records (kind "unit" keyed by sha, "day" keyed by day) missing from the ledger.
 * Day records are only written once their day has fully completed (day < today UTC), so the archived day is the
 * end-of-day total rather than the first partial snapshot of an in-progress day. Never writes the real home under a
 * test runner (isForbiddenRealHome). Returns the number of new lines appended. */
export function syncUsageLedger(home, snapshot, now = Date.now) {
  const dir = home || vibesquadHome();
  if (isForbiddenRealHome(dir)) return 0;
  const todayUtc = new Date(now()).toISOString().slice(0, 10);
  const existing = readUsageLedger(dir);
  const keys = new Set(existing.map((r) => `${r.kind}\u0000${r.sha ?? r.unit ?? r.day ?? ""}`));
  const lines = [];
  for (const rec of snapshot) {
    if (rec.kind === "day" && typeof rec.day === "string" && rec.day >= todayUtc) continue; // in-progress day: skip until it completes
    const key = `${rec.kind}\u0000${rec.sha ?? rec.unit ?? rec.day ?? ""}`;
    if (keys.has(key)) continue;
    keys.add(key);
    lines.push(JSON.stringify(rec) + "\n");
  }
  if (!lines.length) return 0;
  try {
    mkdirSync(join(dir, "runner"), { recursive: true });
    appendFileSync(usageLedgerPath(dir), lines.join(""));
  } catch { /* best-effort: a failed append must not lose usage */ }
  return lines.length;
}

/** Build the ledger snapshot: one "unit" record per merged unit and one "day" record per day (aggregated from rows). */
function buildLedgerSnapshot(merged, rows) {
  const units = merged.map((u) => ({
    kind: "unit",
    unit: u.unit ?? null,
    sha: u.sha,
    ts: u.mergedAt ?? null,
    lane: u.lane ?? null,
    ...(u.squad ? { squad: u.squad } : {}),
    ...(u.repo ? { repo: u.repo } : {}),
    implementerProfile: u.implementerProfile ?? null,
    implementerProvider: u.implementerProvider ?? null,
    workflowMode: u.workflowMode ?? classifyWorkflowMode(u, null),
    reviewRounds: u.reviewRounds ?? 0,
    firstTryPass: (u.reviewRounds ?? 0) <= 1,
    costUsd: u.costUsd ?? null,
    totalTokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    turns: u.turns ?? 0,
    cycleMs: u.unitCycleMs ?? null,
    locAdded: u.locAdded ?? 0,
    locDeleted: u.locDeleted ?? 0,
    filesChanged: u.filesChanged ?? 0,
    fixedAfterMerge: !!u.fixAfterMerge,
  }));
  const byDay = new Map();
  for (const r of rows) {
    if (!r.day) continue;
    const g = getOrSet(byDay, r.day, () => ({ day: r.day, costUsd: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, byProvider: {} }));
    g.costUsd += r.costUsd;
    g.inputTokens += r.inputTokens;
    g.outputTokens += r.outputTokens;
    g.totalTokens += r.inputTokens + r.outputTokens;
    g.turns += r.turns;
    const p = g.byProvider[r.provider] ?? (g.byProvider[r.provider] = { turns: 0, costUsd: 0, totalTokens: 0 });
    p.turns += r.turns;
    p.costUsd += r.costUsd;
    p.totalTokens += r.inputTokens + r.outputTokens;
  }
  const unitsByDay = new Map();
  const locByDay = new Map();
  for (const u of merged) {
    const day = u.mergedAt ? u.mergedAt.slice(0, 10) : null;
    if (!day) continue;
    unitsByDay.set(day, (unitsByDay.get(day) ?? 0) + 1);
    locByDay.set(day, (locByDay.get(day) ?? 0) + (u.locAdded ?? 0) + (u.locDeleted ?? 0));
  }
  const days = [...byDay.values()].map((g) => ({
    kind: "day",
    day: g.day,
    costUsd: g.costUsd,
    totalTokens: g.totalTokens,
    inputTokens: g.inputTokens,
    outputTokens: g.outputTokens,
    turns: g.turns,
    unitsMerged: unitsByDay.get(g.day) ?? 0,
    locChanged: locByDay.get(g.day) ?? 0,
    byProvider: g.byProvider,
  }));
  return [...units, ...days];
}

/** usage KPI snapshot (used on each review record + for closed-loop deltas). */
function usageKpis(u) {
  const merged = u?.merged?.units ?? [];
  const n = merged.length;
  const rounds = merged.reduce((s, x) => s + (x.reviewRounds ?? 0), 0);
  const firstTry = merged.filter((x) => (x.reviewRounds ?? 0) <= 1).length;
  const cost = merged.reduce((s, x) => s + (Number.isFinite(x.costUsd) ? x.costUsd : 0), 0);
  const fix = merged.filter((x) => x.fixAfterMerge).length;
  return {
    firstTryPassRate: n ? round2(firstTry / n) : null,
    avgReviewRounds: n ? round2(rounds / n) : null,
    costPerUnit: n ? round2(cost / n) : null,
    cleanShare: u?.floor?.cleanShare ?? null,
    fixAfterMergeRate: n ? round2(fix / n) : null,
    unitsMerged: n,
  };
}

// ---------------------------------------------------------------- periodic Opus + Gemini usage review (usa-7)
// One-shot `claude -p --model claude-opus-5-5` and `agy -p` run in parallel (no MCP sidecars), 60s timeout each, and
// append one record to <runner home>/usage-reviews.jsonl. Scheduled runs fire from getUsage() (fire-and-forget) and
// refuse to spawn under a test runner unless the review runners are injected.
let usageReviewInFlight = null; // the in-flight runUsageReview promise, else null

const usageReviewsPath = (home) => join(home || vibesquadHome(), "runner", "usage-reviews.jsonl");

/** usage-reviews.jsonl -> records, newest last. Missing file / bad lines tolerated. */
export function readUsageReviews(home) {
  const dir = home || vibesquadHome();
  if (isForbiddenRealHome(dir)) return [];
  let text = "";
  try { text = readFileSync(join(dir, "runner", "usage-reviews.jsonl"), "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* bad line */ }
  }
  return out;
}

/** Latest review record, else null. */
const latestUsageReview = (home) => {
  const history = readUsageReviews(home);
  return history.length ? history[history.length - 1] : null;
};

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const clip = (s, n = 200) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export const USAGE_REVIEW_PROMPT_REL_PATH = join("docs", "lanes", "perfection", "USAGE_REVIEW_PROMPT.md");
export const DEFAULT_USAGE_REVIEW_PROMPT =
  "First, grade in one line whether the previous review's recommendations improved the KPIs (or note there is no prior review). Then give 3-5 concise, actionable bullets covering (1) Profile/Provider routing, (2) Loops/Tool friction, and (3) Handoffs/Review rounds. One line per bullet, no preamble.";

let usageReviewPromptFallbackWarned = false;
export const resetUsageReviewPromptWarnForTest = () => {
  usageReviewPromptFallbackWarned = false;
};

/**
 * Resolve docs/lanes/perfection/USAGE_REVIEW_PROMPT.md against the live VibeSquad repo checkout rather than REPO_ROOT.
 * Why: server/sync-runtime.mjs (syncRuntimeDir, line 35) only copies ["dist", "public", "server", "cli", "runner"] into
 * %LOCALAPPDATA%\VibeSquad\runtime — it never copies docs/ — and writes build-stamp.json with `repo: "<liveRepo>/.git"`.
 * Resolving via gitRepoRoot() (VIBESQUAD_ROOT -> build-stamp.json repo -> REPO_ROOT) reads the live repo's file even when
 * the server runs from the runtime copy, so Workflows (@perfection) edits take effect on the next review without a sync.
 */
export function resolveUsageReviewPromptPath({ runtimeRoot = REPO_ROOT, envRoot = process.env.VIBESQUAD_ROOT } = {}) {
  return join(gitRepoRoot({ runtimeRoot, envRoot }), USAGE_REVIEW_PROMPT_REL_PATH);
}

/**
 * Load the reviewer instruction text from docs/lanes/perfection/USAGE_REVIEW_PROMPT.md. Falls back to
 * DEFAULT_USAGE_REVIEW_PROMPT when the file is missing, unreadable, or blank, logging a warning once per process.
 */
export function loadUsageReviewPrompt({ promptPath, runtimeRoot, envRoot, warn = console.warn } = {}) {
  const file = promptPath ?? resolveUsageReviewPromptPath({ runtimeRoot, envRoot });
  try {
    const raw = readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
    if (raw) return raw;
    if (!usageReviewPromptFallbackWarned) {
      usageReviewPromptFallbackWarned = true;
      warn(`usage-review: prompt file is empty at ${file}; using built-in fallback`);
    }
  } catch (err) {
    if (!usageReviewPromptFallbackWarned) {
      usageReviewPromptFallbackWarned = true;
      warn(`usage-review: failed to read prompt file at ${file} (${err?.code ?? err?.message ?? err}); using built-in fallback`);
    }
  }
  return DEFAULT_USAGE_REVIEW_PROMPT;
}

/** Compact prompt from the usage payload: totals, limits, loops, spawn storms, by-profile and per-lane review rounds, plus
 * usa-9 context — recent @usa/usage-lane notes, friction signals, mcp-alias counts, recent agent errors, the active
 * profile catalog and runner turn caps — so Opus and Gemini see *why* friction happened. `home` + `sinceMs` scope the
 * log-signal harvest (sinceMs = lastReview.at, so only entries since the prior review are shown). */
export function buildUsageReviewPrompt(usage, { home, sinceMs, previousReview, promptPath, runtimeRoot, envRoot, warn } = {}) {
  const u = usage ?? {};
  const totals = u.totals ?? {};
  const out = [];
  out.push(`Usage snapshot: ${totals.turns ?? 0} turns, $${round2(totals.costUsd ?? 0)} cost, ${totals.inputTokens ?? 0} in / ${totals.outputTokens ?? 0} out tokens.`);
  const limits = u.limits ?? [];
  if (limits.length) out.push(`Limits: ${limits.map((l) => `${l.provider} ${l.window} ${l.usedPct}% (resets ${l.resetsAt ?? "?"})`).join("; ")}.`);
  const loops = u.loops?.flagged ?? [];
  if (loops.length) out.push(`Loops flagged: ${loops.map((l) => `${l.agentId} (${l.lane}/${l.role}) ${l.turns}t`).join("; ")}.`);
  const storms = u.spawnStorms ?? [];
  if (storms.length) out.push(`Spawn storms: ${storms.map((s) => `${s.lane}/${s.role} x${s.count}`).join("; ")}.`);
  const bp = u.byProfile ?? [];
  out.push("By provider/profile/role (runs | turns | costUsd | passRate | costPerMergedUnit | avgReviewRounds | fixAfterMergeRate):");
  for (const g of bp.slice(0, 30)) out.push(`- ${g.provider} | ${g.profile} | ${g.role} | ${g.runs} | ${g.turns} | ${round2(g.costUsd)} | ${g.passRate} | ${g.costPerMergedUnit ?? "-"} | ${g.avgReviewRounds} | ${g.fixAfterMergeRate}`);
  const perLane = u.merged?.perLane ?? [];
  const lanes = u.lanes ?? [];
  const handoffByLane = new Map(lanes.map((l) => [l.lane, l.handoffs ?? 0]));
  out.push("Per-lane (mergedUnits | reviewRounds | costPerMergedUnit | handoffs | workPct | fixAfterMergeRate):");
  for (const l of perLane.slice(0, 30)) {
    const la = lanes.find((x) => x.lane === l.lane);
    out.push(`- ${l.lane} | ${l.mergedUnits} | ${l.reviewRounds} | ${round2(l.costPerMergedUnit)} | ${handoffByLane.get(l.lane) ?? 0} | ${la?.workPct ?? "-"} | ${l.fixAfterMergeRate}`);
  }

  // usa-9 context: why friction happened (harvested since the prior review, bounded).
  const signals = readUsageLogSignals(home, { sinceMs });
  if (signals.notes.length) {
    out.push("Recent @usa / usage-lane log notes:");
    for (const n of signals.notes) out.push(`- [${n.type}]${n.lane ? ` (${n.lane})` : ""} ${clip(n.text)}`);
  }
  if (signals.friction.length) {
    out.push("Recent friction signals:");
    for (const f of signals.friction) out.push(`- [${f.type}]${f.lane ? ` (${f.lane})` : ""} ${clip(f.text)}`);
  }
  if (signals.mcpAlias.length) out.push(`mcp-alias tool hits: ${signals.mcpAlias.map((m) => `${m.tool}@${m.lane || "-"} x${m.count}`).join(", ")}.`);
  const recentErrors = u.recentErrors ?? [];
  if (recentErrors.length) {
    out.push("Recent agent errors:");
    for (const e of recentErrors) out.push(`- ${e.profile || e.role} (${e.agentId}): ${clip(e.message)}`);
  }
  const profiles = profileList(home);
  out.push(`Active profiles: ${profiles.map((p) => `${p.name} (${p.role}/${p.provider}/${p.model})`).join("; ")}.`);
  const caps = turnCapsFromEnv();
  out.push(`Runner turn caps: ${Object.entries(caps).map(([k, v]) => `${k}=${v}`).join(" ")}.`);

  // ---- usa-10 closed loop: grade whether the previous review moved the KPIs before proposing next actions.
  const bw = u.byWorkflow ?? [];
  if (bw.length) {
    out.push(`A/B workflows (mode | units | firstTryPassRate | costPerUnit | costPer100Loc | fixAfterMergeRate):`);
    for (const w of bw.slice(0, 12)) out.push(`- ${w.workflowMode} | ${w.units} | ${w.firstTryPassRate} | ${w.costPerUnit ?? "-"} | ${w.costPer100Loc ?? "-"} | ${w.fixAfterMergeRate}`);
  }
  const cohorts = u.cohorts;
  if (cohorts?.recent?.units) {
    const d = cohorts.delta ?? {};
    out.push(`Cohorts (Last ${cohorts.recent.units} vs Prior ${cohorts.prior?.units ?? 0}): firstTryPass ${cohorts.recent.firstTryPassRate} vs ${cohorts.prior?.firstTryPassRate ?? "-"} (Δ${d.firstTryPassRate ?? "-"}), cost/unit $${cohorts.recent.costPerUnit} vs $${cohorts.prior?.costPerUnit ?? "-"} (Δ${d.costPerUnit ?? "-"}), fix rate ${cohorts.recent.fixAfterMergeRate} vs ${cohorts.prior?.fixAfterMergeRate ?? "-"}.`);
  }
  const floor = u.floor;
  if (floor) {
    out.push(`Clean-Run Floor: cleanShare ${floor.cleanShare ?? "-"}, cleanCostPerUnit $${floor.cleanCostPerUnit ?? "-"}, waste rework=$${floor.reworkCostUsd} loops/abandoned=$${floor.loopAndAbandonedCostUsd} post-merge-fix=$${floor.fixAfterMergeCostUsd} restart/handoff=$${floor.restartOverheadCostUsd}.`);
  }
  const prevKpis = previousReview?.kpis;
  if (previousReview) {
    const opusText = previousReview.opus?.text ?? previousReview.opus?.error ?? "";
    const geminiText = previousReview.gemini?.text ?? previousReview.gemini?.error ?? "";
    if (opusText) out.push(`Previous review Opus said: ${clip(opusText, 400)}`);
    if (geminiText) out.push(`Previous review Gemini said: ${clip(geminiText, 400)}`);
    const cur = usageKpis(u);
    if (prevKpis) {
      const delta = {};
      for (const k of ["firstTryPassRate", "avgReviewRounds", "costPerUnit", "cleanShare", "fixAfterMergeRate"]) {
        delta[k] = prevKpis[k] === null || cur[k] === null ? null : round2(cur[k] - prevKpis[k]);
      }
      out.push(`KPI delta since last review: firstTryPassRate ${prevKpis.firstTryPassRate ?? "-"}->${cur.firstTryPassRate ?? "-"} (Δ${delta.firstTryPassRate ?? "-"}), avgReviewRounds ${prevKpis.avgReviewRounds ?? "-"}->${cur.avgReviewRounds ?? "-"} (Δ${delta.avgReviewRounds ?? "-"}), costPerUnit ${prevKpis.costPerUnit ?? "-"}->${cur.costPerUnit ?? "-"} (Δ${delta.costPerUnit ?? "-"}), cleanShare ${prevKpis.cleanShare ?? "-"}->${cur.cleanShare ?? "-"} (Δ${delta.cleanShare ?? "-"}), fixAfterMergeRate ${prevKpis.fixAfterMergeRate ?? "-"}->${cur.fixAfterMergeRate ?? "-"}.`);
    }
  }

  out.push(loadUsageReviewPrompt({ promptPath, runtimeRoot, envRoot, warn }));
  return out.join("\n");
}

/** One-shot CLI run: prompt as the trailing arg (as runAgyUsage does), stdin not used, stdout captured, 60s killTree timeout. */
export function oneShotReviewRun(cmd, args) {
  return ({ prompt, spawnImpl, timeoutMs = 60_000 }) =>
    new Promise((resolve) => {
      if (!spawnImpl && underTestRunner()) return resolve({ ok: false, error: `refusing to spawn the real ${cmd} under a test runner`, ms: 0 });
      const started = Date.now();
      let child;
      try {
        child = spawnNoShell(cmd, [...args, prompt], { env: process.env, ...(spawnImpl ? { resolved: { file: cmd, args: [] } } : {}) }, spawnImpl);
      } catch (e) {
        return resolve({ ok: false, error: String(e?.message ?? e), ms: Date.now() - started });
      }
      let out = "";
      let err = "";
      let done = false;
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ ...r, ms: Date.now() - started }); };
      const timer = setTimeout(() => { killTree(child); finish({ ok: false, error: `timed out after ${timeoutMs}ms` }); }, timeoutMs);
      timer.unref?.();
      child.stdout?.on("data", (d) => { out += d; });
      child.stderr?.on("data", (d) => { err = (err + d).slice(-2000); }); // bounded tail: an unread stderr pipe can stall the child
      child.on("error", (e) => finish({ ok: false, error: String(e?.message ?? e) }));
      child.on("exit", (code) => finish(code === 0 ? { ok: true, text: out.trim() } : { ok: false, error: err || `exit ${code}` }));
    });
}
const defaultRunOpus = oneShotReviewRun("claude", ["-p", "--model", "claude-opus-5-5"]);
const defaultRunGemini = oneShotReviewRun("agy", ["-p"]);

// ---------------------------------------------------------------- usa-15 / usa-19: auto-route review bullets to perfection inbox

const REVIEW_BULLET_LEAD_RE = /^(?:[-*•+]\s+|\d+[.)]\s+)+/;
const REVIEW_GRADE_RE = /^grade\b|previous review|no prior review/i;

/** A bare section label (e.g. "Profile/Provider routing", "Loops/Tool friction:", "Handoffs/Review rounds:"). */
function isReviewHeading(line) {
  if (/^(?:profile\/provider\s*routing|loops?\/tool\s*friction|handoffs?\/review\s*rounds?|review\s*rounds?|routing|loops?|handoffs?|tool\s*friction|friction)\s*$/i.test(line)) return true;
  if (/[:：]\s*$/.test(line)) {
    const words = line.replace(/[:：]\s*$/, "").trim().split(/\s+/).filter(Boolean);
    if (words.length <= 5) return true;
  }
  return false;
}

/**
 * Split a review response into actionable bullets: strip leading `-`, `*`, `•`, `+` and `1.` markers, drop empty lines
 * and bare section headings, and skip the closed-loop KPI self-grade line (a `/^grade\b|previous review|no prior review/i`
 * match, or the first line of a multi-line reply). Each bullet is truncated to `maxLen` and the list capped at `max`.
 */
export function parseReviewBullets(text, { max = 5, maxLen = 200 } = {}) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (REVIEW_GRADE_RE.test(raw)) continue;
    if (i === 0 && lines.length > 1) continue; // first line is the self-grade line
    const line = raw.replace(REVIEW_BULLET_LEAD_RE, "").trim();
    if (!line) continue;
    if (isReviewHeading(line)) continue;
    out.push(clip(line, maxLen));
    if (out.length >= max) break;
  }
  return out;
}

/** True when `text` significantly overlaps any of the `seen` texts (>=2 shared tokens, or >=1 with jaccard >= 0.15). */
function overlapsSeen(text, seen) {
  for (const other of seen) {
    const { shared, jaccard } = significantTokenOverlap(text, other);
    if (shared >= 2 || (shared >= 1 && jaccard >= 0.15)) return true;
  }
  return false;
}

/** True when an inbox card is an open perfection (Workflows) card (status "parked" or "accepted", or legacy unset status). */
const isOpenPerfectionCard = (c) =>
  Boolean(c) &&
  String(c.laneId || "").toLowerCase() === "perfection" &&
  (!c.status || c.status === "parked" || c.status === "accepted");

/**
 * Best-effort: parse the review's actionable bullets and enqueue them into the perfection (Workflows) inbox, deduped
 * against open perfection cards (status parked or accepted) and across the opus/gemini sets. Returns the enqueued card ids (never throws).
 */
function routeReviewToInbox(opusResult, geminiResult, dir) {
  const sent = [];
  if (!dir || isForbiddenRealHome(dir)) return sent;
  const existing = readInboxCards(dir).filter(isOpenPerfectionCard);
  const seen = existing.map((c) => `${c.title || ""} ${c.text || ""}`).filter(Boolean);
  const process = (result, source) => {
    if (!result?.ok || typeof result.text !== "string") return;
    const ideas = [];
    for (const bullet of parseReviewBullets(result.text)) {
      if (overlapsSeen(bullet, seen)) continue;
      ideas.push(bullet);
      seen.push(bullet);
    }
    if (!ideas.length) return;
    try {
      const res = addInboxCards({ ideas, laneId: "perfection", teamId: "vibesquad", source, baseHome: dir });
      for (const c of res.added ?? []) sent.push(c.id);
    } catch (e) {
      console.error(`usage-review: failed to route ${source} bullets to perfection inbox: ${e?.message ?? e}`);
    }
  };
  process(opusResult, "usage-review:opus");
  process(geminiResult, "usage-review:gemini");
  return sent;
}

/**
 * Run one Opus + Gemini usage review (parallel, one-shot). `runOpus`/`runGemini` default to the real CLIs and refuse
 * under a test runner; inject fakes in tests. One provider failing never loses the other. Appends one record to
 * usage-reviews.jsonl. A second call while one is running returns the in-flight promise (never a second spawn).
 */
export function runUsageReview({ home, trigger = "manual", usage, runOpus, runGemini, promptPath, now = Date.now } = {}) {
  if (usageReviewInFlight) return usageReviewInFlight;
  usageReviewInFlight = (async () => {
    try {
      const interval = loadRunnerSettings(home).usageReview.interval;
      const last = latestUsageReview(home);
      const sinceMs = last ? toMs(last.at) : null;
      const prompt = buildUsageReviewPrompt(usage, { home, sinceMs, previousReview: last, promptPath });
      const opusRun = runOpus ?? defaultRunOpus;
      const geminiRun = runGemini ?? defaultRunGemini;
      const results = await Promise.all([
        opusRun({ prompt }).catch((e) => ({ ok: false, error: String(e?.message ?? e), ms: 0 })),
        geminiRun({ prompt }).catch((e) => ({ ok: false, error: String(e?.message ?? e), ms: 0 })),
      ]);
      const dir = home || vibesquadHome();
      const sentCardIds = routeReviewToInbox(results[0], results[1], dir);
      const record = {
        at: new Date(now()).toISOString(),
        trigger,
        interval,
        turnsAtRun: usage?.totals?.turns ?? 0,
        kpis: usageKpis(usage),
        opus: results[0],
        gemini: results[1],
        sentCardIds,
      };
      try {
        if (!isForbiddenRealHome(dir)) {
          mkdirSync(join(dir, "runner"), { recursive: true });
          appendFileSync(usageReviewsPath(dir), JSON.stringify(record) + "\n");
        }
      } catch { /* best-effort: a failed append must not lose the review */ }
      return record;
    } finally {
      usageReviewInFlight = null;
    }
  })();
  return usageReviewInFlight;
}

/** UI-facing review state (no run is triggered). `usage` (optional) supplies turns for waitingForTurns/nextAt. */
function usageReviewState(home, usage, { now = Date.now } = {}) {
  const interval = loadRunnerSettings(home).usageReview.interval;
  const history = readUsageReviews(home);
  const last = history.length ? history[history.length - 1] : null;
  const ms = intervalMs(interval);
  const turns = usage?.totals?.turns;
  const lastAt = last ? toMs(last.at) : null;
  let nextAt = null;
  let waitingForTurns = false;
  if (ms !== null) {
    if (lastAt === null) {
      waitingForTurns = (turns ?? 0) <= 0; // first run needs at least one turn
    } else {
      nextAt = new Date(lastAt + ms).toISOString();
      waitingForTurns = now() >= lastAt + ms && (turns ?? 0) <= (last?.turnsAtRun ?? 0);
    }
  }
  return {
    interval,
    inFlight: Boolean(usageReviewInFlight),
    last,
    nextAt,
    waitingForTurns,
    history: history.slice(-5),
  };
}

/** Fire-and-forget scheduled check called from getUsage(); never throws into getUsage(). */
function maybeScheduleUsageReview(usage, home, opts = {}) {
  try {
    if (opts.suppressSchedule) return;
    const interval = loadRunnerSettings(home).usageReview.interval;
    if (interval === "off") return;
    const ms = intervalMs(interval);
    if (ms === null) return;
    if (usageReviewInFlight) return;
    if (underTestRunner() && !opts.runOpus && !opts.runGemini) return; // never a real spawn under test
    const last = latestUsageReview(home);
    const lastAt = last ? toMs(last.at) : null;
    const nowMs = opts.now ? opts.now() : Date.now();
    if (lastAt !== null && nowMs - lastAt < ms) return; // not due
    if (!(usage.totals.turns > (last?.turnsAtRun ?? 0))) return; // no new turns
    runUsageReview({ home, trigger: "scheduled", usage, runOpus: opts.runOpus, runGemini: opts.runGemini, now: opts.now }).catch(() => {});
  } catch { /* best-effort */ }
}

export function getUsage({ home, since, until, git, laneCodes, usageReview, now = Date.now } = {}) {
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
  const laneOf = (u) => (u.code ? (codes.get(u.code) ?? u.code) : null);
  // Injected git (tests) keeps the single-repo path; otherwise pool every Squad repo (usa-20).
  const mergedRaw = git ? readMergedUnits(git).map((u) => ({ ...u, lane: laneOf(u), repo: null, squad: null })) : readPooledMergedUnits(home, laneOf, now);
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
      fixAfterMerge = mergedRaw.some((p) => p !== u && p.lane === u.lane && p.squad === u.squad && p.mergedAt !== null && tsMs(p.mergedAt) !== null && tsMs(p.mergedAt) < mergedAtMs && mergedAtMs - tsMs(p.mergedAt) <= FIX_AFTER_MERGE_WINDOW_MS);
    }
    return {
      ...u, mergedAtMs,
      implementerProfile: implementer ? implementer.profile : null,
      implementerProvider: implementer ? implementer.provider : null,
      implementerAgentId: implementer ? implementer.agentId : null,
      costUsd: implementer ? implementer.costUsd : null,
      inputTokens: implementer ? implementer.inputTokens : 0,
      outputTokens: implementer ? implementer.outputTokens : 0,
      turns: implementer ? implementer.turns : 0,
      workflowMode: classifyWorkflowMode(u, implementer),
      unitCycleMs, fixAfterMerge,
    };
  });

  // byProfile: group agents by (provider, profile, role); fold in attributed merged units.
  const profileMap = new Map();
  for (const a of agents) {
    const key = `${a.provider}|${a.profile}|${a.role}`;
    const g = getOrSet(profileMap, key, () => ({ provider: a.provider, profile: a.profile, role: a.role, runs: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, workingMs: 0, idleMs: 0, passCount: 0, loopCount: 0, errorCount: 0, mergedUnits: 0, reviewRounds: 0, unitCycleSum: 0, unitCycleCount: 0, fixAfterMergeCount: 0 }));
    g.runs += 1;
    g.turns += a.turns;
    g.inputTokens += a.inputTokens;
    g.outputTokens += a.outputTokens;
    g.costUsd += a.costUsd;
    g.workingMs += a.workingMs;
    g.idleMs += a.idleMs;
    if (a.pass) g.passCount += 1;
    if (a.loop) g.loopCount += 1;
    g.errorCount += a.errors ?? 0;
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
    errorCount: g.errorCount,
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

  // Recent agent errors (most recent first, capped at 10) for the usage review prompt.
  const recentErrors = agents
    .filter((a) => (a.errors ?? 0) > 0)
    .sort((a, b) => (b.lastErrorTs ?? 0) - (a.lastErrorTs ?? 0))
    .slice(0, 10)
    .map((a) => ({ agentId: a.agentId, profile: a.profile, provider: a.provider, role: a.role, lane: a.lane, message: a.lastError ?? "", errors: a.errors }));

  // ---- usa-10: durable ledger sync + fold archived entries (units/days absent from raw), then benchmark rollups.
  const agentById = new Map(agents.map((a) => [a.agentId, a]));
  syncUsageLedger(homeDir, buildLedgerSnapshot(merged, rows), now);
  const ledger = readUsageLedger(homeDir);
  const rawShas = new Set(merged.map((u) => u.sha));
  const rawDays = new Set(rows.map((r) => r.day));
  // Fold only when the raw source is present but partial: units when git returned a (non-empty) bounded log whose older
  // merges fell off MAX_COMMITS, days when agent logs were pruned (respect the since/until day filter like rows do).
  const foldedUnits = merged.length > 0 ? ledger.filter((r) => r.kind === "unit" && r.sha && !rawShas.has(r.sha)) : [];
  const foldedDays = ledger.filter((r) => r.kind === "day" && r.day && !rawDays.has(r.day) && (!since || r.day >= since) && (!until || r.day <= until));
  for (const r of foldedUnits) {
    merged.push({
      sha: r.sha, unit: r.unit ?? null, code: null, reviewRounds: r.reviewRounds ?? 0,
      mergedAt: r.ts ?? null, mergedAtMs: toMs(r.ts), firstBranchCtMs: null, subject: "",
      locAdded: r.locAdded ?? 0, locDeleted: r.locDeleted ?? 0, filesChanged: r.filesChanged ?? 0,
      lane: r.lane ?? null, squad: r.squad ?? null, repo: r.repo ?? null,
      implementerProfile: r.implementerProfile ?? null, implementerProvider: r.implementerProvider ?? null, implementerAgentId: null,
      costUsd: r.costUsd ?? null, inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0, turns: r.turns ?? 0,
      workflowMode: r.workflowMode ?? "unattributed", unitCycleMs: r.cycleMs ?? null, fixAfterMerge: !!r.fixedAfterMerge,
      fromLedger: true,
    });
  }
  const foldedDayRows = foldedDays.map((r) => ({ day: r.day, turns: r.turns ?? 0, costUsd: r.costUsd ?? 0, inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0 }));
  let totalsFinal = totals;
  if (foldedDayRows.length) {
    totalsFinal = { ...totals };
    for (const d of foldedDayRows) {
      totalsFinal.turns += d.turns;
      totalsFinal.costUsd += d.costUsd;
      totalsFinal.inputTokens += d.inputTokens;
      totalsFinal.outputTokens += d.outputTokens;
    }
  }
  const byDayFinal = by("day");
  if (foldedDayRows.length) for (const d of foldedDayRows) byDayFinal.push({ day: d.day, ...zeroStats(), turns: d.turns, costUsd: d.costUsd, inputTokens: d.inputTokens, outputTokens: d.outputTokens });
  const byWorkflow = buildByWorkflow(merged, agentById);
  const savings = buildSavings(merged, totalsFinal, lanes, agents);
  const cohorts = buildCohorts(merged);
  const floor = buildFloor(merged, agents, totalsFinal);

  const result = {
    note: "Cost is summed from turn_done.costUsd; token counts come from adapter usage events and are 0 for logs that have none.",
    files: seen.size,
    totals: totalsFinal,
    byProvider: by("provider"),
    byModel: by("model"),
    byLane: by("lane"),
    byDay: byDayFinal,
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
    recentErrors,
    byWorkflow,
    savings,
    cohorts,
    floor,
  };
  maybeScheduleUsageReview(result, home, usageReview ?? {});
  return { ...result, usageReview: usageReviewState(home, result, usageReview ?? {}) };
}

/** One-click benchmark export as Markdown (GET /__vibesquad/providers/usage-export?format=md). */
function usageToMarkdown(u) {
  const lines = [];
  const t = u.totals ?? {};
  lines.push("# VibeSquad usage benchmark");
  lines.push(`Exported ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Totals");
  lines.push(`- turns: ${t.turns ?? 0}`);
  lines.push(`- cost: $${round2(t.costUsd ?? 0)}`);
  lines.push(`- tokens: ${t.inputTokens ?? 0} in / ${t.outputTokens ?? 0} out`);
  const s = u.savings;
  if (s) {
    lines.push("");
    lines.push("## Savings vs solo workflow");
    lines.push(`- routing saved: $${s.routingSavingsUsd} vs all-Opus $${s.soloOpusBaselineUsd}${s.routingSavingsPct === null ? "" : ` (${Math.round(s.routingSavingsPct * 100)}%)`}`);
    lines.push(`- context tokens saved: ${s.contextSavingsTokens} (monolithic baseline ${s.monolithicBaselineTokens})`);
    lines.push(`- parallel speedup: ${s.parallelSpeedup === null ? "-" : `${s.parallelSpeedup}x`}`);
    lines.push(`- $/unit: ${s.costPerMergedUnit === null ? "-" : `$${s.costPerMergedUnit}`} | $/100 LOC: ${s.costPer100Loc === null ? "-" : `$${s.costPer100Loc}`}`);
  }
  const f = u.floor;
  if (f) {
    lines.push("");
    lines.push("## Clean-run floor & waste");
    lines.push(`- clean: $${f.cleanCostUsd}${f.cleanShare === null ? "" : ` (${Math.round(f.cleanShare * 100)}%)`}`);
    lines.push(`- rework r2+: $${f.reworkCostUsd}`);
    lines.push(`- loops/abandoned: $${f.loopAndAbandonedCostUsd}`);
    lines.push(`- post-merge fixes: $${f.fixAfterMergeCostUsd}`);
    lines.push(`- restart/handoff: $${f.restartOverheadCostUsd}`);
  }
  const c = u.cohorts;
  if (c?.recent?.units) {
    lines.push("");
    lines.push("## Cohort trend (last vs prior)");
    lines.push(`- first-try PASS: ${c.recent.firstTryPassRate} vs ${c.prior?.firstTryPassRate ?? "-"} (Δ${c.delta?.firstTryPassRate ?? "-"})`);
    lines.push(`- rev rounds/unit: ${c.recent.avgReviewRounds} vs ${c.prior?.avgReviewRounds ?? "-"} (Δ${c.delta?.avgReviewRounds ?? "-"})`);
    lines.push(`- cost/unit: $${c.recent.costPerUnit} vs $${c.prior?.costPerUnit ?? "-"} (Δ${c.delta?.costPerUnit ?? "-"})`);
    lines.push(`- tokens/unit: ${c.recent.tokensPerUnit} vs ${c.prior?.tokensPerUnit ?? "-"}`);
    lines.push(`- fix rate: ${c.recent.fixAfterMergeRate} vs ${c.prior?.fixAfterMergeRate ?? "-"}`);
  }
  const bw = u.byWorkflow ?? [];
  if (bw.length) {
    lines.push("");
    lines.push("## A/B workflow comparison");
    lines.push("| mode | units | 1st-pass | rev/unit | $/unit | $/100LOC | tok/unit | fix rate |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const w of bw) lines.push(`| ${w.workflowMode} | ${w.units} | ${w.firstTryPassRate} | ${w.avgReviewRounds} | ${w.costPerUnit ?? "-"} | ${w.costPer100Loc ?? "-"} | ${w.tokensPerUnit} | ${w.fixAfterMergeRate} |`);
  }
  const pl = u.merged?.perLane ?? [];
  if (pl.length) {
    lines.push("");
    lines.push("## Per lane");
    lines.push("| lane | merged | cost/unit | fix rate |");
    lines.push("|---|---|---|---|");
    for (const l of pl) lines.push(`| ${l.lane} | ${l.mergedUnits} | $${l.costPerMergedUnit} | ${l.fixAfterMergeRate} |`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- HTTP
/** Handles /__vibesquad/providers*. Writes (settings/usage-review POST) are owner-gated by the caller (vibesquad-api.mjs). */
export async function handleProvidersApi(req, res, { sendJson, readBody, home, usageReview, ...probeOpts }) {
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
    if (sub === "usage-review") {
      if (req.method === "GET") {
        return sendJson(res, 200, { ok: true, usageReview: usageReviewState(home, undefined, usageReview ?? {}) });
      }
      if (req.method === "POST" || req.method === "PUT") {
        const body = await readBody(req);
        if (body?.interval !== undefined && !USAGE_REVIEW_INTERVALS.includes(body.interval)) {
          return sendJson(res, 400, { ok: false, error: `bad interval "${body.interval}"` });
        }
        if (body?.interval !== undefined) saveRunnerSettings({ usageReview: { interval: body.interval } }, home);
        let usage;
        if (body?.runNow === true && !usageReviewInFlight) {
          // Compute the usage snapshot with the scheduled check suppressed, so a manual Run-now is always recorded as manual.
          usage = getUsage({ home, git: probeOpts.git, usageReview: { ...usageReview, suppressSchedule: true } });
          runUsageReview({ home, trigger: "manual", usage, runOpus: usageReview?.runOpus, runGemini: usageReview?.runGemini, now: usageReview?.now }).catch(() => {});
        }
        return sendJson(res, 200, { ok: true, usageReview: usageReviewState(home, usage, usageReview ?? {}) });
      }
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (sub === "usage-export") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
      const format = url.searchParams.get("format") ?? "json";
      if (format !== "md" && format !== "json") return sendJson(res, 400, { error: `bad format "${format}"` });
      const usage = getUsage({ home, since: url.searchParams.get("since") || undefined, until: url.searchParams.get("until") || undefined, git: probeOpts.git, usageReview });
      if (format === "json") return sendJson(res, 200, { ok: true, exportedAt: new Date().toISOString(), ...usage });
      return sendJson(res, 200, { ok: true, markdown: usageToMarkdown(usage) });
    }
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
    if (sub === "") return sendJson(res, 200, await getProviders(opts));
    if (sub === "models") return sendJson(res, 200, await getModels(url.searchParams.get("provider") ?? "", opts));
    if (sub === "modes") return sendJson(res, 200, await getModes(url.searchParams.get("provider") ?? "", opts));
    if (sub === "usage") return sendJson(res, 200, getUsage({ home, since: url.searchParams.get("since") || undefined, until: url.searchParams.get("until") || undefined, git: probeOpts.git, usageReview }));
    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    return sendJson(res, 500, { error: String(err?.message ?? err) });
  }
}
