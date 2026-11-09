// VS native schedules & heartbeats (runner pilot Block 8), backed by <VIBESQUAD_HOME>/schedules.json.
// Same shape as the Paseo schedules the UI already speaks (src/paseoSchedules.ts): cadence { type: "cron" | "every" },
// target { type: "new-agent" | "agent" | "self" }. A heartbeat is a schedule whose target is { type: "self", agentId }.
// One timer loop for all schedules; next runs are recomputed from the file on load, so a restart never
// fires missed runs in a burst. Implemented VS native schedules & heartbeats — Thanks to Paseo by getpaseo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findAuditLane } from "./identity.mjs";
import { resolveProjectPath } from "./brief-path.mjs";
import crypto from "node:crypto";

export const vsHome = (env = process.env) => env.VIBESQUAD_HOME || path.join(os.homedir(), ".vibesquad");

const MIN_EVERY_MS = 10_000;
const MAX_LOG_LINES = 200;
const ID_RE = /^sch-[A-Za-z0-9_-]{1,64}$/;
const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function parseField(src, [min, max]) {
  const set = new Set();
  for (const part of String(src).split(",")) {
    const [range, step, extra] = part.split("/");
    if (extra !== undefined || (step !== undefined && !/^[1-9]\d*$/.test(step))) throw new Error(`bad cron field "${src}"`);
    let lo;
    let hi;
    if (range === "*") [lo, hi] = [min, max];
    else {
      const m = /^(\d+)(?:-(\d+))?$/.exec(range);
      if (!m) throw new Error(`bad cron field "${src}"`);
      lo = Number(m[1]);
      hi = m[2] === undefined ? lo : Number(m[2]);
      if (step !== undefined && m[2] === undefined) throw new Error(`bad cron field "${src}"`);
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron field "${src}" outside ${min}-${max}`);
    for (let v = lo; v <= hi; v += step ? Number(step) : 1) set.add(v);
  }
  return set;
}

export function parseCron(expr) {
  const f = String(expr ?? "").trim().split(/\s+/).filter(Boolean);
  if (f.length !== 5) throw new Error("cron needs 5 fields: minute hour day-of-month month day-of-week");
  const [minute, hour, dom, month, dow] = f.map((s, i) => parseField(s, FIELDS[i]));
  return { minute, hour, dom, month, dow, domAny: f[2] === "*", dowAny: f[4] === "*" };
}

const fmtCache = new Map();
function localParts(ms, tz) {
  if (!tz || tz === "UTC") {
    const d = new Date(ms);
    return { minute: d.getUTCMinutes(), hour: d.getUTCHours(), dom: d.getUTCDate(), month: d.getUTCMonth() + 1, dow: d.getUTCDay() };
  }
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    fmtCache.set(tz, fmt);
  }
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(ms))) p[type] = value;
  return { minute: Number(p.minute), hour: Number(p.hour) % 24, dom: Number(p.day), month: Number(p.month), dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}

/** Start of the next local calendar day after `t` (ms). A DST day is 23h/25h, so a fixed 24h step can land an hour past/short of midnight. */
function nextLocalMidnight(t, p, tz) {
  const n = t + (24 * 60 - p.hour * 60 - p.minute) * 60_000;
  const q = localParts(n, tz);
  const sinceMidnight = q.hour * 60 + q.minute;
  // Overshot (23h day: landed at ~01:00 of the day after): step back to local 00:00. Undershot (25h day) lands at 23:xx
  // of the same day, so the caller's next pass skips the remaining minutes. Never move to or before `t`.
  return sinceMidnight > 0 && sinceMidnight < 12 * 60 ? Math.max(n - sinceMidnight * 60_000, t + 60_000) : n;
}

/** Next fire time (ms) strictly after `from` for a cron expression in `tz` (default UTC); null if none within ~2 years. */
export function nextCronRun(expr, from, tz) {
  const c = parseCron(expr);
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  const limit = from + 2 * 366 * 86_400_000;
  while (t <= limit) {
    const p = localParts(t, tz);
    const dayOk = c.domAny || c.dowAny ? c.dom.has(p.dom) && c.dow.has(p.dow) : c.dom.has(p.dom) || c.dow.has(p.dow);
    if (!c.month.has(p.month) || !dayOk) {
      t = nextLocalMidnight(t, p, tz);
      continue;
    }
    if (!c.hour.has(p.hour)) {
      t += (60 - p.minute) * 60_000; // skip to the next local hour
      continue;
    }
    if (c.minute.has(p.minute)) return t;
    t += 60_000;
  }
  return null;
}

export function nextRunFor(cadence, from) {
  if (cadence?.type === "every") return from + Number(cadence.everyMs);
  return nextCronRun(cadence?.expression, from, cadence?.timezone);
}

function validateCadence(c, from = Date.now()) {
  if (c?.type === "every") {
    const ms = Number(c.everyMs);
    if (!Number.isSafeInteger(ms) || ms < MIN_EVERY_MS) throw new Error("interval must be at least 10 seconds");
    return { type: "every", everyMs: ms };
  }
  if (c?.type === "cron") {
    parseCron(c.expression);
    if (c.timezone) {
      try { new Intl.DateTimeFormat("en-US", { timeZone: c.timezone }); } catch { throw new Error(`unknown timezone "${c.timezone}"`); }
    }
    if (nextCronRun(c.expression, from, c.timezone) === null) throw new Error("cron expression never fires");
    return { type: "cron", expression: String(c.expression).trim().replace(/\s+/g, " "), ...(c.timezone ? { timezone: String(c.timezone) } : {}) };
  }
  throw new Error("cadence must be { type: 'cron' | 'every' }");
}

function validateTarget(t) {
  if (t?.type === "new-agent") {
    if (!t.config?.provider || !t.config?.cwd) throw new Error("new-agent target needs config.provider and config.cwd");
    return { type: "new-agent", config: { ...t.config } };
  }
  if ((t?.type === "agent" || t?.type === "self") && t.agentId) return { type: t.type, agentId: String(t.agentId) };
  throw new Error("target must be new-agent {config} or agent/self {agentId}");
}

/** undefined/null = no limit; otherwise a positive integer. */
function validateMaxRuns(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("maxRuns must be a positive integer");
  return n;
}

function validateExpiresAt(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const ms = new Date(v).getTime();
  if (Number.isNaN(ms)) throw new Error("expiresAt is not a valid date");
  return new Date(ms).toISOString();
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const fail = (status, message) => Object.assign(new Error(message), { status });

export const AUDIT_PROMPT = "Read docs/lanes/perfection/AUDIT_BRIEF.md and follow it.";
/** Sonnet medium: the audit makes judgment calls (checklist 1-3) but only reports, so Opus is overkill and Flash too thin. Same config as the "Implement - Sonnet" profile. */
export const AUDIT_PROFILE = { name: "Implement - Sonnet", provider: "claude", model: "claude-sonnet-5-5", modeId: "auto", thinkingOptionId: "medium" };
export const AUDIT_CADENCE = { type: "cron", expression: "17 4 * * *" };

export function createSchedulesStore({ home = vsHome(), backend = null, now = () => Date.now(), tickMs = 15_000, resolveIdentity = null, pruneEveryMs = 60_000 } = {}) {
  const file = path.join(home, "schedules.json");
  const logDir = path.join(home, "schedule-logs");
  let timer = null;
  const running = new Set();
  const pendingCadence = new Set(); // due ticks that hit an in-flight run: that run counts as the due one
  let lastPrune = 0;

  const load = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(data?.schedules) ? data.schedules : [];
    } catch {
      return [];
    }
  };
  /** Seed keys of seeded schedules the user deleted: kept in schedules.json so a restart does not re-seed them. */
  const loadDeletedSeeds = () => {
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf8"))?.deletedSeeds;
      return Array.isArray(d) ? d : [];
    } catch {
      return [];
    }
  };
  const save = (schedules, deletedSeeds = loadDeletedSeeds()) => {
    fs.mkdirSync(home, { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, schedules, ...(deletedSeeds.length ? { deletedSeeds } : {}) }, null, 2), "utf8");
    fs.renameSync(tmp, file);
  };
  const getRaw = (list, id) => {
    const s = list.find((x) => x.id === id);
    if (!s) throw fail(404, `schedule ${id} not found`);
    return s;
  };
  const view = (s) => ({ ...s, nextRunAt: iso(s.nextRunAt), lastRunAt: iso(s.lastRunAt), backend: "vs" });

  const log = (id, entry) => {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const f = path.join(logDir, `${id}.jsonl`);
      fs.appendFileSync(f, `${JSON.stringify({ ts: new Date(now()).toISOString(), ...entry })}\n`, "utf8");
      const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
      if (lines.length > MAX_LOG_LINES * 2) fs.writeFileSync(f, `${lines.slice(-MAX_LOG_LINES).join("\n")}\n`, "utf8");
    } catch {}
  };

  const finishIfDone = (s, t) => {
    if (s.status !== "active") return;
    const expired = s.expiresAt && Date.parse(s.expiresAt) <= t;
    if (expired || (s.maxRuns && s.runCount >= s.maxRuns)) {
      s.status = "completed";
      s.nextRunAt = null;
    }
  };

  async function execute(s, trigger) {
    if (!backend) throw new Error("no agent backend configured");
    const tg = s.target;
    if (tg.type === "new-agent") {
      // Same identity the Paseo agent.created hook derives: team/lane from the cwd, role worker.
      let where = null;
      try { where = (await resolveIdentity?.(tg.config.cwd)) ?? null; } catch {}
      const agent = await backend.createAgent({
        config: { ...tg.config },
        initialPrompt: s.prompt,
        labels: {
          schedule: s.id,
          ...(s.name ? { scheduleName: s.name } : {}),
          role: "worker",
          ...(s.profile ? { profile: s.profile } : {}),
          ...((s.team ?? where?.team) ? { team: s.team ?? where.team } : {}),
          ...((s.lane ?? where?.lane) ? { lane: s.lane ?? where.lane } : {}),
        },
      });
      return { agentId: agent?.id ?? null, message: `${trigger}: started agent ${agent?.id ?? "?"}` };
    }
    await backend.sendAgentPrompt(tg.agentId, s.prompt);
    return { agentId: tg.agentId, message: `${trigger}: sent prompt to ${tg.agentId}` };
  }

  /** Fire a schedule. cadence=true advances runCount/nextRunAt; run-once leaves them alone. */
  async function fire(id, { trigger, cadence }) {
    if (running.has(id)) {
      if (cadence) pendingCadence.add(id);
      return { skipped: true };
    }
    running.add(id);
    try {
      const s = getRaw(load(), id);
      let result;
      let entry;
      try {
        result = await execute(s, trigger);
        entry = { ok: true, trigger, ...result };
      } catch (e) {
        result = { error: String(e?.message ?? e) };
        entry = { ok: false, trigger, message: `${trigger}: failed: ${result.error}`, error: result.error };
      }
      const advance = cadence || pendingCadence.has(id);
      const fresh = load();
      const cur = fresh.find((x) => x.id === id);
      if (cur) { // deleted while running: no log file, no write
        log(id, entry);
        const t = now();
        cur.lastRunAt = t;
        if (advance) {
          cur.runCount = (cur.runCount ?? 0) + 1;
          cur.nextRunAt = cur.status === "active" ? nextRunFor(cur.cadence, t) : cur.nextRunAt;
          finishIfDone(cur, t);
        }
        save(fresh);
      }
      return result;
    } finally {
      running.delete(id);
      pendingCadence.delete(id);
    }
  }

  const store = {
    file,

    list: () => load().map(view),
    get: (id) => view(getRaw(load(), id)),

    create(req = {}) {
      const prompt = String(req.prompt ?? "").trim();
      if (!prompt) throw fail(400, "prompt is required");
      let cadence;
      let target;
      let maxRuns;
      let expiresAt;
      try {
        cadence = validateCadence(req.cadence);
        target = validateTarget(req.target);
        maxRuns = validateMaxRuns(req.maxRuns);
        expiresAt = validateExpiresAt(req.expiresAt);
      } catch (e) {
        throw fail(400, e.message);
      }
      const t = now();
      const list = load();
      const s = {
        id: `sch-${crypto.randomBytes(6).toString("hex")}`,
        ...(req.name ? { name: String(req.name) } : {}),
        prompt,
        cadence,
        target,
        status: "active",
        createdAt: new Date(t).toISOString(),
        nextRunAt: nextRunFor(cadence, t),
        lastRunAt: null,
        runCount: 0,
        ...(maxRuns ? { maxRuns } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      };
      list.push(s);
      save(list);
      // The immediate run is the first counted run, so maxRuns: 1 means exactly one.
      if (req.runOnCreate) void fire(s.id, { trigger: "run-on-create", cadence: true }).catch(() => {});
      return view(s);
    },

    /** Idempotent: one daily new-agent entry (created paused) per Squad's audit lane, keyed by `seed`. Squads without an audit lane or an existing repo folder are skipped; user-deleted seeds stay deleted. Returns the created ids. */
    seedAuditSchedules(teams = [], rootDir = process.cwd()) {
      const created = [];
      for (const team of Array.isArray(teams) ? teams : []) {
        const lane = findAuditLane(team);
        if (!lane) continue;
        const cwd = (team.paths ?? []).map((p) => resolveProjectPath(p, rootDir)).find(Boolean);
        if (!cwd) continue; // registry paths are folder names: skip until one resolves to a real folder
        const seed = `audit:${team.id}:${lane.id}`;
        if (load().some((s) => s.seed === seed) || loadDeletedSeeds().includes(seed)) continue;
        const { name, ...cfg } = AUDIT_PROFILE;
        const v = store.create({ name: `Daily audit: ${team.name ?? team.id}`, prompt: AUDIT_PROMPT, cadence: AUDIT_CADENCE, target: { type: "new-agent", config: { ...cfg, cwd } } });
        const list = load();
        const raw = list.find((x) => x.id === v.id);
        // Audits are off by default (paid, daily): a new seed starts paused. The seed key makes this once-only, so a schedule the user resumes is never re-paused.
        Object.assign(raw, { seed, team: team.id, lane: lane.id, profile: name, status: "paused", nextRunAt: null });
        save(list);
        created.push(v.id);
      }
      return created;
    },

    update(req = {}) {
      const list = load();
      const s = getRaw(list, req.id);
      try {
        if (req.name !== undefined) req.name ? (s.name = String(req.name)) : delete s.name;
        if (req.prompt !== undefined) {
          if (!String(req.prompt).trim()) throw new Error("prompt is required");
          s.prompt = String(req.prompt).trim();
        }
        if (req.cadence) {
          s.cadence = validateCadence(req.cadence);
          if (s.status === "active") s.nextRunAt = nextRunFor(s.cadence, now());
        }
        if (req.maxRuns !== undefined) {
          const n = validateMaxRuns(req.maxRuns);
          n === undefined ? delete s.maxRuns : (s.maxRuns = n);
        }
        if (req.expiresAt !== undefined) {
          const e = validateExpiresAt(req.expiresAt);
          e === undefined ? delete s.expiresAt : (s.expiresAt = e);
        }
      } catch (e) {
        throw fail(400, e.message);
      }
      if (req.maxRuns !== undefined || req.expiresAt !== undefined) {
        const t = now();
        if (s.status === "completed") {
          const done = (s.expiresAt && Date.parse(s.expiresAt) <= t) || (s.maxRuns && s.runCount >= s.maxRuns);
          if (!done) { // limits were extended or cleared: back to work
            s.status = "active";
            s.nextRunAt = nextRunFor(s.cadence, t);
          }
        } else finishIfDone(s, t);
      }
      save(list);
      return view(s);
    },

    pause(id) {
      const list = load();
      const s = getRaw(list, id);
      if (s.status === "active") {
        s.status = "paused";
        s.nextRunAt = null;
        save(list);
      }
      return view(s);
    },

    resume(id) {
      const list = load();
      const s = getRaw(list, id);
      if (s.status === "paused") {
        s.status = "active";
        s.nextRunAt = nextRunFor(s.cadence, now());
        save(list);
      }
      return view(s);
    },

    async runOnce(id) {
      getRaw(load(), id);
      const r = await fire(id, { trigger: "manual", cadence: false });
      return { schedule: view(getRaw(load(), id)), result: r };
    },

    delete(id) {
      const list = load();
      const gone = getRaw(list, id);
      const tomb = loadDeletedSeeds();
      if (gone.seed && !tomb.includes(gone.seed)) tomb.push(gone.seed);
      save(list.filter((s) => s.id !== id), tomb);
      try { fs.rmSync(path.join(logDir, `${id}.jsonl`), { force: true }); } catch {}
      return { ok: true };
    },

    logs(id, limit = 50) {
      getRaw(load(), id);
      try {
        const lines = fs.readFileSync(path.join(logDir, `${id}.jsonl`), "utf8").split("\n").filter(Boolean);
        return lines.slice(-Math.max(1, limit)).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },

    /** Heartbeat cleanup: drop every heartbeat (self target) aimed at `agentId`. Returns the ids removed. */
    deleteHeartbeat(agentId) {
      const list = load();
      const gone = list.filter((s) => s.target?.type === "self" && s.target.agentId === agentId);
      if (!gone.length) return [];
      save(list.filter((s) => !gone.includes(s)));
      for (const s of gone) try { fs.rmSync(path.join(logDir, `${s.id}.jsonl`), { force: true }); } catch {}
      return gone.map((s) => s.id);
    },

    /** Drop heartbeats whose agent is not in `liveIds` (sweep for agents that went away without cleanup). */
    pruneHeartbeats(liveIds) {
      const live = new Set(liveIds);
      const ids = [];
      for (const s of load()) if (s.target?.type === "self" && !live.has(s.target.agentId)) ids.push(...store.deleteHeartbeat(s.target.agentId));
      return ids;
    },

    /** Periodic sweep: drop heartbeats aimed at runner agents that are gone, archived or exited. Skipped when the live list can't be read. */
    async pruneDead(t = now()) {
      if (typeof backend?.listAgents !== "function" || t - lastPrune < pruneEveryMs) return [];
      if (!load().some((s) => s.target?.type === "self" && String(s.target.agentId).startsWith("rn-"))) return [];
      lastPrune = t;
      const agents = await backend.listAgents();
      if (!Array.isArray(agents)) return [];
      const live = new Set(agents.filter((a) => a.status !== "closed" && !a.archivedAt).map((a) => a.id));
      const gone = new Set();
      for (const s of load()) {
        const id = s.target?.type === "self" ? String(s.target.agentId) : "";
        if (id.startsWith("rn-") && !live.has(id)) gone.add(id);
      }
      return [...gone].flatMap((id) => store.deleteHeartbeat(id));
    },

    /** Restart recovery: recompute every active schedule's next run from now; missed runs are dropped, not replayed. */
    recover() {
      const list = load();
      const t = now();
      for (const s of list) {
        if (s.status !== "active") continue;
        s.nextRunAt = nextRunFor(s.cadence, t);
        finishIfDone(s, t);
      }
      if (list.length) save(list);
    },

    /** One pass of the single timer loop: fire what is due, at most once each. */
    async tick() {
      const t = now();
      const list = load();
      let dirty = false;
      const due = [];
      for (const s of list) {
        if (s.status !== "active") continue;
        if (s.expiresAt && Date.parse(s.expiresAt) <= t) {
          s.status = "completed";
          s.nextRunAt = null;
          dirty = true;
        } else if (s.nextRunAt != null && s.nextRunAt <= t) due.push(s.id);
      }
      if (dirty) save(list);
      await store.pruneDead(t).catch(() => {});
      await Promise.all(due.map((id) => fire(id, { trigger: "schedule", cadence: true }).catch(() => {})));
      return due;
    },

    start() {
      if (timer) return;
      try { store.recover(); } catch {}
      timer = setInterval(() => void store.tick().catch(() => {}), tickMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
  return store;
}

let shared;
/** Process-wide store on the real VS home, using the shared runner backend (lazy import keeps this module light). */
export async function sharedSchedules() {
  if (!shared) {
    const { sharedRunnerBackend } = await import("./backend/index.mjs");
    shared = createSchedulesStore({
      backend: sharedRunnerBackend(),
      resolveIdentity: async (cwd) => (await import("../server/hooks/agent-duties.ts")).resolveByCwd(cwd),
    });
  }
  return shared;
}

const PREFIX = "/__vibesquad/schedules";

/** /__vibesquad/schedules[/<id>[/<action>]] — owner gating for writes happens in vibesquad-api.mjs. */
export async function handleSchedulesApi(req, res, { readBody, sendJson, store }) {
  try {
    store ??= await sharedSchedules();
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.slice(PREFIX.length).split("/").filter(Boolean);
    const id = parts[0];
    const action = parts[1];
    if (id && !ID_RE.test(id)) return sendJson(res, 400, { error: "bad schedule id" });
    if (!id && req.method === "GET") return sendJson(res, 200, { schedules: store.list() });
    if (!id && req.method === "POST") return sendJson(res, 201, { schedule: store.create(await readBody(req)) });
    if (id && !action && req.method === "GET") return sendJson(res, 200, { schedule: store.get(id) });
    if (id && !action && req.method === "DELETE") return sendJson(res, 200, store.delete(id));
    if (id && req.method === "POST") {
      if (action === "update") return sendJson(res, 200, { schedule: store.update({ ...(await readBody(req)), id }) });
      if (action === "pause") return sendJson(res, 200, { schedule: store.pause(id) });
      if (action === "resume") return sendJson(res, 200, { schedule: store.resume(id) });
      if (action === "run-once") return sendJson(res, 200, await store.runOnce(id));
    }
    if (id && action === "logs" && req.method === "GET") {
      return sendJson(res, 200, { logs: store.logs(id, Number(url.searchParams.get("limit")) || 50) });
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (err) {
    return sendJson(res, err?.status >= 400 ? err.status : 500, { error: String(err?.message ?? err) });
  }
}
