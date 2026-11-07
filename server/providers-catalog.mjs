// Provider/model/mode catalog + runner usage rollups + runner settings for the UI (runner pilot B9).
// /__vibesquad/providers[/models|/modes|/usage|/settings]. Shapes match what src/paseoProviders.ts got from the
// Paseo daemon ({providers:[{provider,available,error}]}, {models:[{id,label,...}]}, {modes:[...]}).
// Probing: `<cli> --version` on the resolved executable, no shell, cached with a TTL. No background timers.
import { execFile, execFileSync } from "node:child_process";
import { openSync, closeSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ACP_PROVIDERS, PROVIDER_ALIASES } from "../runner/adapters/acp.mjs";
import { resolveExecutable } from "../runner/spawn.mjs";
import { DEFAULT_PACK_PROFILES, getProfilesPath, normalizeProfile } from "./profiles.mjs";
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
const usageFiles = new Map(); // path -> { size, mtimeMs, offset, provider, model, lane, role, prevCost, buckets, turns, pass, handoff, title }
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
  if (ev.type === "created") {
    st.provider = ev.provider ?? st.provider;
    st.model = ev.model ?? st.model;
    st.lane = ev.meta?.lane ?? ev.meta?.labels?.lane ?? st.lane;
    foldIdentity(st, ev.meta);
  } else if (ev.type === "session" && ev.model) {
    st.model = ev.model;
  } else if (ev.type === "meta") {
    // Runner.updateMeta appends { type: "meta", patch: { lane?, labels? } }.
    const lane = ev.patch?.lane ?? ev.patch?.labels?.lane;
    if (typeof lane === "string" && lane) st.lane = lane;
    foldIdentity(st, ev.patch);
  } else if (ev.type === "output") {
    if (!st.pass && typeof ev.text === "string" && PASS_RE.test(ev.text)) st.pass = true;
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

/** Role (brainstorm|lead|worker), handoff marker and title ride on created.meta / meta.patch. */
function foldIdentity(st, m) {
  if (!m) return;
  if (typeof m.role === "string" && m.role) st.role = m.role;
  if (typeof m.labels?.["vs.handoff-from"] === "string") st.handoff = true;
  const title = m.title ?? m.labels?.job;
  if (typeof title === "string" && title) st.title = title;
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
  if (!st || stat.size < st.offset) st = { offset: 0, provider: "unknown", model: "unknown", lane: "", role: "", prevCost: 0, buckets: new Map(), turns: 0, pass: false, handoff: false, title: "" };
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
const PASS_RE = /\bPASS\b/;
const COORDINATION_ROLES = new Set(["brainstorm", "lead"]);
const ROLE_ORDER = ["brainstorm", "lead", "worker"];

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
const getOrSet = (m, k, mk) => m.get(k) ?? m.set(k, mk()).get(k);

// ---- provider limit windows: <runner home>/limits.jsonl, one JSON line per sample (written by the adapters/runner):
// {at, provider, window:"5h"|"weekly", usedPct, resetsAt, source:"provider"|"estimate", agentId}
const BURN_LOOKBACK_MS = 2 * 3600_000;

/** Latest sample per provider/window + burn rate (%/h over the last 2h of the same window) + ETA-to-cap. Missing file -> []. */
export function readLimits(home) {
  let text = "";
  try { text = readFileSync(join(home || vibesquadHome(), "runner", "limits.jsonl"), "utf8"); } catch { return []; }
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
    // Same window = same reset time; a reset drops usedPct back, so only compare within the window.
    const cur = pts.filter((p) => p.resetMs === last.resetMs && p.atMs >= last.atMs - BURN_LOOKBACK_MS);
    const hours = (last.atMs - cur[0].atMs) / 3600_000;
    const burn = hours > 0 ? (last.used - cur[0].used) / hours : 0;
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
const defaultGit = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
const REVIEW_RE = /review r(\d+)/i;
const CODE_RE = /\(@([A-Za-z0-9_-]+)(?:\s[^)]*)?\)/g;
const MAX_MERGES = 300;

/** Lane code of a subject: the last `(@code ...)` tag, lowercased, else null. */
const codeOf = (subject) => {
  let m, last = null;
  CODE_RE.lastIndex = 0;
  while ((m = CODE_RE.exec(subject))) last = m[1].toLowerCase();
  return last;
};

/** Merge commits -> units {sha, unit, code, reviewRounds, mergedAt, subject}. unit = branch from "Merge branch 'x'".
 * reviewRounds = highest N among "review rN" subjects on the merged side (p1..p2). Lane code = the merge subject's
 * `(@code)` tag, else the first tag found on a commit subject of the merged side. */
export function readMergedUnits(git = defaultGit) {
  let raw = "";
  try { raw = git(["log", "--merges", `-${MAX_MERGES}`, "--format=%H%x1f%P%x1f%ct%x1f%s"]); } catch { return []; }
  const units = [];
  for (const line of raw.split("\n")) {
    const [sha, parents, ct, subject = ""] = line.split("\x1f");
    if (!sha || !parents) continue;
    const [p1, p2] = parents.trim().split(/\s+/);
    if (!p2) continue;
    let subjects = [];
    try { subjects = git(["log", "--format=%s", `${p1}..${p2}`]).split("\n").filter(Boolean); } catch { /* keep merge only */ }
    let rounds = 0;
    let code = codeOf(subject);
    for (const sj of subjects) {
      const m = REVIEW_RE.exec(sj);
      if (m) rounds = Math.max(rounds, Number(m[1]));
      code ??= codeOf(sj);
    }
    const branch = /Merge branch '([^']+)'/i.exec(subject)?.[1] ?? null;
    units.push({ sha, unit: branch, code, reviewRounds: rounds, mergedAt: Number.isFinite(Number(ct)) ? new Date(Number(ct) * 1000).toISOString() : null, subject });
  }
  return units;
}

/** lowercase lane code or id -> lane id, from <home>/teams.json lanes[]. */
function readLaneCodes(home) {
  const map = new Map();
  try {
    const t = JSON.parse(readFileSync(join(home || vibesquadHome(), "teams.json"), "utf8").replace(/^﻿/, ""));
    for (const team of t.teams ?? []) for (const l of team.lanes ?? []) {
      if (!l?.id) continue;
      map.set(String(l.id).toLowerCase(), l.id);
      if (l.code) map.set(String(l.code).toLowerCase(), l.id);
    }
  } catch { /* no teams.json */ }
  return map;
}

export function getUsage({ home, since, until, git, laneCodes } = {}) {
  const dir = join(home || vibesquadHome(), "runner", "agents");
  const seen = new Set();
  const agg = new Map();
  const laneRole = new Map(); // lane|role -> stats (day-filtered)
  const laneAgents = new Map(); // lane -> { agents, handoffs, byRole: Map<role, count> }
  const loops = [];
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { /* no runner yet */ }
  for (const n of names) {
    const file = join(dir, n);
    seen.add(file);
    let st;
    try { st = refreshFile(file, statSync(file)); } catch { continue; }
    const la = getOrSet(laneAgents, st.lane, () => ({ agents: 0, handoffs: 0, byRole: new Map() }));
    la.agents += 1;
    if (st.handoff) la.handoffs += 1;
    la.byRole.set(st.role, (la.byRole.get(st.role) ?? 0) + 1);
    if (st.turns > LOOP_TURN_THRESHOLD && !st.pass) loops.push({ agentId: n.slice(0, -6), lane: st.lane, role: st.role, title: st.title, turns: st.turns });
    for (const b of st.buckets.values()) {
      if ((since && b.day < since) || (until && b.day > until)) continue;
      const a = getOrSet(agg, `${b.provider}|${b.model}|${b.lane}|${b.day}`, () => ({ provider: b.provider, model: b.model, lane: b.lane, day: b.day, ...zeroStats(), agents: 0 }));
      addStats(a, b);
      a.agents += 1;
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
  const merged = readMergedUnits(git).map((u) => ({ ...u, lane: u.code ? (codes.get(u.code) ?? u.code) : null }));
  const mergedByLane = new Map();
  for (const u of merged) if (u.lane) getOrSet(mergedByLane, u.lane, () => []).push(u);
  const laneCost = new Map(lanes.map((l) => [l.lane, l.costUsd]));
  const perLane = [...mergedByLane].map(([lane, us]) => {
    const rounds = us.reduce((s, u) => s + u.reviewRounds, 0);
    const cost = laneCost.get(lane) ?? 0;
    return { lane, mergedUnits: us.length, reviewRounds: rounds, avgReviewRounds: Math.round((rounds / us.length) * 100) / 100, costUsd: cost, costPerMergedUnit: cost / us.length };
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
    lanes,
    laneRole: lrRows,
    coordination: split(lrRows),
    merged: { units: merged, perLane },
    loops: { threshold: LOOP_TURN_THRESHOLD, flagged: loops.sort((a, b) => b.turns - a.turns) },
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
    if (sub === "usage") return sendJson(res, 200, getUsage({ home, since: url.searchParams.get("since") || undefined, until: url.searchParams.get("until") || undefined }));
    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    return sendJson(res, 500, { error: String(err?.message ?? err) });
  }
}
