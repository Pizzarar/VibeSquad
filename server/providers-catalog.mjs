// Provider/model/mode catalog + runner usage rollups + runner settings for the UI (runner pilot B9).
// /__vibesquad/providers[/models|/modes|/usage|/settings]. Shapes match what src/paseoProviders.ts got from the
// Paseo daemon ({providers:[{provider,available,error}]}, {models:[{id,label,...}]}, {modes:[...]}).
// Probing: `<cli> --version` on the resolved executable, no shell, cached with a TTL. No background timers.
import { execFile } from "node:child_process";
import { openSync, closeSync, readSync, readdirSync, statSync } from "node:fs";
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
const usageFiles = new Map(); // path -> { size, mtimeMs, offset, provider, model, lane, prevCost, buckets }
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
  const key = `${st.provider}|${st.model}|${st.lane}|${day}`;
  let b = st.buckets.get(key);
  if (!b) {
    b = { provider: st.provider, model: st.model, lane: st.lane, day, turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    st.buckets.set(key, b);
  }
  return b;
}

function foldEvent(st, ev) {
  if (ev.type === "created") {
    st.provider = ev.provider ?? st.provider;
    st.model = ev.model ?? st.model;
    st.lane = ev.meta?.lane ?? ev.meta?.labels?.lane ?? st.lane;
  } else if (ev.type === "session" && ev.model) {
    st.model = ev.model;
  } else if (ev.type === "meta") {
    // Runner.updateMeta appends { type: "meta", patch: { lane?, labels? } }.
    const lane = ev.patch?.lane ?? ev.patch?.labels?.lane;
    if (typeof lane === "string" && lane) st.lane = lane;
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
  }
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
  if (!st || stat.size < st.offset) st = { offset: 0, provider: "unknown", model: "unknown", lane: "", prevCost: 0, buckets: new Map() };
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

export function getUsage({ home, since, until } = {}) {
  const dir = join(home || vibesquadHome(), "runner", "agents");
  const seen = new Set();
  const agg = new Map();
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")); } catch { /* no runner yet */ }
  for (const n of names) {
    const file = join(dir, n);
    seen.add(file);
    let st;
    try { st = refreshFile(file, statSync(file)); } catch { continue; }
    for (const b of st.buckets.values()) {
      if ((since && b.day < since) || (until && b.day > until)) continue;
      const key = `${b.provider}|${b.model}|${b.lane}|${b.day}`;
      const a = agg.get(key) ?? { provider: b.provider, model: b.model, lane: b.lane, day: b.day, turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, agents: 0 };
      a.turns += b.turns;
      a.costUsd += b.costUsd;
      a.inputTokens += b.inputTokens;
      a.outputTokens += b.outputTokens;
      a.agents += 1;
      agg.set(key, a);
    }
  }
  for (const f of [...usageFiles.keys()]) if (!seen.has(f)) usageFiles.delete(f); // file removed: forget it
  const rows = [...agg.values()].sort((a, b) => b.day.localeCompare(a.day) || b.costUsd - a.costUsd);
  const by = (k) => {
    const m = new Map();
    for (const r of rows) {
      const t = m.get(r[k]) ?? { [k]: r[k], turns: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
      t.turns += r.turns;
      t.costUsd += r.costUsd;
      t.inputTokens += r.inputTokens;
      t.outputTokens += r.outputTokens;
      m.set(r[k], t);
    }
    return [...m.values()].sort((a, b) => b.costUsd - a.costUsd);
  };
  return {
    note: "Cost is summed from turn_done.costUsd; token counts come from adapter usage events and are 0 for logs that have none.",
    files: seen.size,
    totals: {
      turns: rows.reduce((s, r) => s + r.turns, 0),
      costUsd: rows.reduce((s, r) => s + r.costUsd, 0),
      inputTokens: rows.reduce((s, r) => s + r.inputTokens, 0),
      outputTokens: rows.reduce((s, r) => s + r.outputTokens, 0),
    },
    byProvider: by("provider"),
    byModel: by("model"),
    byLane: by("lane"),
    byDay: by("day"),
    rows,
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
