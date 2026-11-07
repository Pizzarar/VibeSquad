// Pure rules for the vs.http remote proxy (PLAN_PASEO_PARITY.md block R2-1): path normalisation,
// allowlist, method filter, size caps, rate limits and response redaction. No imports, so node --test
// can load it directly.
//
// Deny by default. A path must normalise cleanly AND be listed in REMOTE_ALLOW; REMOTE_BLOCKED is checked
// first and wins even if someone later adds an overlapping ALLOW entry.
//
// WRITES REOPEN PER ENDPOINT (block R2-5). The R2-1 security cross-review showed the write handlers let a
// link-holder spawn auto-mode agents in a chosen cwd (inbox/open-topic, lead-handoff), inject DI keys
// (baseHome, profilesPath) on the inbox handlers, write persistent prompt injection into briefs
// (brainstorm-summary POST) and mass-archive agents. Security S4 fixed those server-side (sanitizeBody on
// every handler, cwd derived server-side, real-lead lookup, archive binding + budget, brief revision).
// A write in REMOTE_ALLOW must also have a REMOTE_BODY_POLICY entry: checkRemoteBody enforces its typed key
// allowlist (a write without a policy is refused), and a policy with `registry` is checked against the live
// teams.json by checkRemoteRegistry before the proxy forwards.
// Still closed, with the reason, in REMOTE_WRITES_CLOSED.

export const REMOTE_MAX_BODY_BYTES = 512 * 1024; // request and response bodies; relay frames allow 32 MiB
export const REMOTE_TIMEOUT_MS = 10_000;
export const REMOTE_SPAWN_TIMEOUT_MS = 45_000;

export function proxyTimeoutFor(pathname: string, defaultMs: number = REMOTE_TIMEOUT_MS): number {
  if (pathname === "/__vibesquad/brainstorm-restart" || pathname === "/__vibesquad/inbox/triage") {
    return Math.max(defaultMs, REMOTE_SPAWN_TIMEOUT_MS);
  }
  return defaultMs;
}
export const REMOTE_MAX_PATH_CHARS = 2048;
export const REMOTE_MAX_IN_FLIGHT = 4;
export const REMOTE_WINDOW_MS = 60_000;
// term: terminal poll (~1/s per open tab) + keystrokes, kept apart so a shell never starves or is starved by the other budgets.
export const REMOTE_BUDGET_PER_MIN = { read: 120, write: 20, term: 1200 } as const;
export const REMOTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type RemoteMethod = (typeof REMOTE_METHODS)[number];
export type AllowMap = Readonly<Record<string, readonly RemoteMethod[]>>;

const READ: readonly RemoteMethod[] = ["GET"];

/**
 * Exact pathnames the remote UI may reach, with the methods allowed on each. Writes were reopened one at a
 * time in block R2-5, each after its server handler was checked for S4 (sanitised body, server-side cwd).
 */
export const REMOTE_ALLOW: AllowMap = {
  "/api/health": READ,
  "/__vibesquad/health": READ,
  "/api/auth/status": READ,
  "/__vibesquad/auth/status": READ,
  // R2-5 #1 teams/pins: a pin is a lane in teams.json. paths/path/vibeMode/lastProfile are pinned to disk (registry).
  "/api/teams": ["GET", "PUT", "POST"],
  "/__vibesquad/teams": ["GET", "POST", "PUT"],
  "/__vibesquad/settings": READ, // `remote` is dropped from the response
  // R2-5 #3 log/vs-log: text and refs only; the author is the owner (no agent/agentId).
  "/__vibesquad/log": ["GET", "POST"],
  "/__vibesquad/vs-log": ["GET", "POST"],
  // Block 4: GET polls "does the packet exist / is vs handoff still running?" (path redacted). POST starts
  // `vs handoff` and answers 202 within 2 s if it is still running, so the 10 s proxy timeout never fires.
  "/__vibesquad/handoff": ["GET", "POST"],
  // Block 4: Buddy start + restart. Profile/cwd come from the lane in teams.json; spawnBudget caps it server-side.
  "/__vibesquad/brainstorm-restart": ["POST"],
  // R2-5 #4 brainstorm-summary: revision required, lane must exist in teams.json.
  "/__vibesquad/brainstorm-summary": ["GET", "POST", "PUT"],
  // R2-5 #2 inbox: cards only; spawn config (provider/model/profile) and card titles never come remotely.
  "/__vibesquad/inbox": ["GET", "POST"],
  "/__vibesquad/inbox/triage": ["POST"],
  "/__vibesquad/inbox/park-topic": ["POST"],
  "/__vibesquad/inbox/handoff-topic": ["POST"],
  "/__vibesquad/profiles": READ,
  "/__vibesquad/profiles/diff": READ,
  "/__vibesquad/workspace-package-scripts": READ,
  "/__vibesquad/paseo/status": READ,
  "/__vibesquad/paseo/providers": READ,
  "/__vibesquad/paseo/usage": READ, // `refresh` is stripped from the query
  "/__vibesquad/paseo/plugins": READ,
  // B8 Files panel: GET only. Confinement (roots, realpath, .ssh/.vibesquad/.paseo/.git filter, 413 cap) stays in
  // server/file-search.mjs. The server owner-gates these reads (isGatedRead), so they go with the loopback token.
  "/__vibesquad/fs/list": READ,
  "/__vibesquad/fs/resolve": READ,
  "/__vibesquad/fs/read": READ,
};

/** Allowlisted GETs the server owner-gates (isGatedRead): the proxy sends the loopback token on these, like a write. */
export const REMOTE_OWNER_READS: readonly string[] = ["/__vibesquad/fs/list", "/__vibesquad/fs/resolve", "/__vibesquad/fs/read"];

// ---- owner-only terminal + script routes (B8 part 2b) -------------------------------------------------------
// A full shell on the host, so every route here (reads and writes) carries the loopback owner token and the proxy
// refuses locally when it has none. Terminal ids vary, so these are patterns, not REMOTE_ALLOW keys. There is no
// `stream` route: output is fetched by cursor long-poll (GET .../poll?since=N) because vs.http is request/response.
export const REMOTE_TERMINAL_INPUT_CHARS = 65_536; // = terminals.mjs input slice
export const REMOTE_TERMINAL_POLL_CHARS = 32_768; // server caps each poll body; keeps the JSON under the 512 KB text cap
export const REMOTE_MAX_TERMINALS = 4; // terminals a single proxy handler (one paired PC session) may hold open
const TID = "tm-[a-f0-9]{12}";
export const REMOTE_OWNER_ROUTES: readonly { re: RegExp; methods: readonly RemoteMethod[] }[] = [
  { re: /^\/__vibesquad\/terminals$/, methods: ["GET", "POST"] },
  { re: new RegExp(`^/__vibesquad/terminals/${TID}/(?:poll|output)$`), methods: ["GET"] },
  { re: new RegExp(`^/__vibesquad/terminals/${TID}/(?:input|resize|rename|kill)$`), methods: ["POST"] },
  { re: /^\/__vibesquad\/workspace-scripts$/, methods: ["GET"] },
  { re: /^\/__vibesquad\/workspace-scripts\/logs$/, methods: ["GET"] }, // `stream=1` is refused in decideProxyRequest
  { re: /^\/__vibesquad\/workspace-scripts\/(?:start|stop)$/, methods: ["POST"] },
];
const ownerRouteMethods = (pathname: string) => REMOTE_OWNER_ROUTES.find((r) => r.re.test(pathname))?.methods;
/** True for any owner-only terminal / script route: the proxy injects the token and refuses without one. */
export const isOwnerRoute = (pathname: string): boolean => ownerRouteMethods(pathname) !== undefined;
/** Terminal output / control routes (not scripts): own rate bucket, raw (unscrubbed) 2xx bodies. */
export const isTerminalRoute = (pathname: string): boolean => pathname === "/__vibesquad/terminals" || pathname.startsWith("/__vibesquad/terminals/");
/** Body-policy key: a terminal id becomes `:id`. */
export const terminalPolicyKey = (pathname: string): string => pathname.replace(new RegExp(`^(/__vibesquad/terminals/)${TID}(/)`), "$1:id$2");

/** Writes that stay closed remotely, and why. Reopening one needs the server change named here first. */
export const REMOTE_WRITES_CLOSED: Readonly<Record<string, string>> = {
  "/__vibesquad/lead-handoff":
    "spawns a successor lead and retires the old one; the UI never calls it (HandoffModal spawns the successor via client.agents.create over the relay WebSocket after POST /__vibesquad/handoff)",
  "/__vibesquad/lead-handoff/confirm": "relabels/renames the old lead and deletes its heartbeat; only the lead-handoff flow calls it",
  "/__vibesquad/inbox/open-topic": "Spawns a live Buddy agent on the host; agent creation stays local-only",
};

// ---- remote body policy (R2-5) ----------------------------------------------------------------------

/** A typed value schema. Strings and arrays always carry a cap; objects list every key they accept. */
export type FieldSpec =
  | { t: "string"; max: number; re?: RegExp; oneOf?: readonly string[] }
  | { t: "number"; min: number; max: number; int?: boolean }
  | { t: "boolean" }
  | { t: "array"; max: number; of: FieldSpec }
  | { t: "object"; fields: Readonly<Record<string, FieldSpec>>; require?: readonly string[] };

/**
 * Body keys each write endpoint accepts remotely. Deny by default: a write to a path with no entry here is
 * refused, and so is any key (at any depth) outside `fields` or inside REMOTE_FORBIDDEN_BODY_KEYS.
 * `require` keys must be present (the revision keeps a remote write from blindly overwriting newer edits).
 * `registry` names a check against the live teams.json (checkRemoteRegistry).
 */
export type BodyPolicy = {
  fields: Readonly<Record<string, FieldSpec>>;
  require?: readonly string[];
  registry?: "teams" | "lane";
  /** REMOTE_FORBIDDEN_BODY_KEYS this endpoint may take anyway (the server validates the value itself). */
  allowKeys?: readonly string[];
};

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/; // TEAM_ID / AGENT_ID_STRICT on the server
const CARD_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SLUG_RE = /^[a-z0-9-]{1,40}$/;
const id: FieldSpec = { t: "string", max: 64, re: ID_RE };
const cardId: FieldSpec = { t: "string", max: 64, re: CARD_RE };
const str = (max: number): FieldSpec => ({ t: "string", max });
const oneOf = (...values: string[]): FieldSpec => ({ t: "string", max: 40, oneOf: values });
const tokens: FieldSpec = { t: "number", min: 0, max: 100_000_000, int: true };
const isoTime: FieldSpec = { t: "string", max: 40, re: /^[0-9T:.+Z-]{0,40}$/ };
const pathList: FieldSpec = { t: "array", max: 64, of: str(1024) }; // MAX_PATHS / MAX_PATH_LEN
const refs: FieldSpec = { t: "array", max: 20, of: str(512) };

const LANE: FieldSpec = {
  t: "object",
  require: ["id"],
  fields: {
    id,
    name: str(200),
    code: str(16),
    paths: pathList,
    path: str(1024),
    worktree: str(1024),
    branch: str(200),
    aliases: { t: "array", max: 32, of: str(200) },
    hub: { t: "boolean" },
    standing: { t: "boolean" },
    backend: oneOf("paseo", "runner"),
    state: oneOf("pinned", "done", "removed"),
    doneAt: isoTime,
    removedAt: isoTime,
    order: { t: "number", min: -1_000_000, max: 1_000_000 },
    lastProfile: str(200),
  },
};
const TEAM: FieldSpec = {
  t: "object",
  require: ["id"],
  fields: {
    id,
    name: str(200),
    aliases: { t: "array", max: 32, of: str(200) },
    color: str(32),
    lanes: { t: "array", max: 500, of: LANE }, // MAX_LANES
    paths: pathList,
    path: str(1024),
    leadFlagTokens: tokens,
    leadAutoHandoffTokens: tokens,
    leadHardCapTokens: tokens,
    brainstormWarnTokens: tokens,
    brainstormRestartTokens: tokens,
    vibeMode: { t: "boolean" },
  },
};
const TEAMS_POLICY: BodyPolicy = {
  fields: {
    teams: { t: "array", max: 200, of: TEAM }, // MAX_TEAMS
    revision: str(128),
    leadFlagTokens: tokens,
    leadAutoHandoffTokens: tokens,
    leadHardCapTokens: tokens,
    brainstormWarnTokens: tokens,
    brainstormRestartTokens: tokens,
  },
  require: ["teams", "revision"],
  registry: "teams",
};
// UI_LOG_TYPES on the server; vs-log takes any type server-side, so the remote list is the UI's.
const LOG_TYPE = oneOf("you", "needs-you", "handoff", "metric", "decision");
const INBOX_STATUS = oneOf("parked", "handed-off", "archived");
const INBOX_SCOPE = oneOf("art", "mechanic", "plugin", "UI", "infra", "docs", "other");

export const REMOTE_BODY_POLICY: Readonly<Record<string, BodyPolicy>> = {
  "/api/teams": TEAMS_POLICY,
  "/__vibesquad/teams": TEAMS_POLICY,
  "/__vibesquad/log": {
    fields: { team: id, teamId: id, lane: id, laneId: id, type: LOG_TYPE, text: str(240), refs },
    require: ["team", "text"],
    registry: "lane",
  },
  "/__vibesquad/vs-log": {
    fields: { teamId: id, team: id, laneId: id, lane: id, type: LOG_TYPE, text: str(2000), refs },
    require: ["text"],
    registry: "lane",
  },
  "/__vibesquad/brainstorm-summary": {
    fields: { laneId: id, lane: id, teamId: id, team: id, content: str(19_999), revision: str(128) },
    require: ["content", "revision"],
    registry: "lane",
  },
  "/__vibesquad/inbox": {
    fields: {
      text: str(20_000),
      ideas: { t: "array", max: 20, of: str(5000) },
      splitDump: { t: "boolean" },
      laneId: id,
      lane: id,
      teamId: id,
      team: id,
      defaultLaneId: id,
    },
    registry: "lane",
  },
  "/__vibesquad/inbox/triage": {
    fields: {
      action: oneOf("merge", "bounce", "update", "delete", "archive"),
      cardId,
      targetId: cardId,
      sourceIds: { t: "array", max: 100, of: cardId },
      sourceId: cardId,
      laneId: id,
      lane: id,
      teamId: id,
      team: id,
      scope: INBOX_SCOPE,
      // Server allowlist minus `title` (never remote, at any depth).
      patch: {
        t: "object",
        fields: {
          status: INBOX_STATUS,
          text: str(20_000),
          scope: INBOX_SCOPE,
          summaryNote: str(4000),
          topicTitle: str(200),
          topicOpenedAt: isoTime,
          handedOffAt: isoTime,
          laneId: id,
          teamId: id,
          relatedCardId: cardId,
          relatedReason: str(500),
        },
      },
      archive: { t: "boolean" },
    },
    require: ["action"],
    registry: "lane",
  },
  "/__vibesquad/inbox/park-topic": { fields: { cardId, agentId: id, summaryNote: str(4000) }, require: ["cardId"] },
  "/__vibesquad/inbox/handoff-topic": { fields: { cardId, agentId: id, planNote: str(4000), usedTokens: tokens }, require: ["cardId"] },
  // Block 4: no profile/cwd/provider/pendingPrompt/summaryUpdate (REMOTE_FORBIDDEN_BODY_KEYS); the server
  // takes the profile from the lane's lastProfile and the cwd from the lane's paths. `model` / `modeId` /
  // `thinkingOptionId` are allowlisted here so a staged provider switch can override them on the fresh Buddy.
  "/__vibesquad/brainstorm-restart": {
    fields: {
      reason: oneOf("start-brainstorm", "manual", "warn-80k", "handoff", "provider-switch"),
      mode: oneOf("quick-start"),
      teamId: id,
      laneId: id,
      laneName: str(200),
      agentId: id,
      usedTokens: tokens,
      profileName: str(120),
      model: str(200),
      modeId: str(64),
      thinkingOptionId: str(64),
    },
    require: ["laneId"],
    registry: "lane",
  },
  "/__vibesquad/handoff": {
    fields: { team: id, lane: id, teamId: id, laneId: id, agentId: id },
    require: ["team", "lane"],
    registry: "lane",
  },
};

// B8 part 2b: owner-only terminal + script writes. Keyed by terminalPolicyKey() (terminal id -> `:id`). `cwd` is exempt
// from the forbidden-key list here because resolveCwd (terminals-api.mjs) refuses anything outside a known team/agent path.
const dim = (min: number, max: number): FieldSpec => ({ t: "number", min, max, int: true });
export const REMOTE_TERMINAL_POLICY: Readonly<Record<string, BodyPolicy>> = {
  "/__vibesquad/terminals": { fields: { cwd: str(1024), name: str(60), cols: dim(2, 500), rows: dim(2, 200) }, require: ["cwd"], allowKeys: ["cwd"] },
  "/__vibesquad/terminals/:id/input": { fields: { data: str(REMOTE_TERMINAL_INPUT_CHARS) }, require: ["data"] },
  "/__vibesquad/terminals/:id/resize": { fields: { cols: dim(2, 500), rows: dim(2, 200) } },
  "/__vibesquad/terminals/:id/rename": { fields: { name: str(60) }, require: ["name"] },
  "/__vibesquad/terminals/:id/kill": { fields: {} },
  "/__vibesquad/workspace-scripts/start": { fields: { cwd: str(1024), name: str(120) }, require: ["cwd", "name"], allowKeys: ["cwd"] },
  "/__vibesquad/workspace-scripts/stop": { fields: { cwd: str(1024), name: str(120) }, require: ["cwd", "name"], allowKeys: ["cwd"] },
};
export const WRITE_SCHEMAS = REMOTE_BODY_POLICY;

/** Never accepted in a remote body at any depth, whatever a policy says: spawn config, DI hooks, prompt and brief text.
 *  `model`, `modeId` and `thinkingOptionId` are the exception: they are allowlisted on POST /__vibesquad/brainstorm-restart
 *  (staged provider switch overrides) and remain rejected everywhere else by each endpoint's field allowlist. */
export const REMOTE_FORBIDDEN_BODY_KEYS: readonly string[] = [
  "cwd", "provider", "profile", "profilesPath", "baseHome", "labels", "title", "pendingPrompt", "summaryUpdate",
  "skipDaemon", "daemonClient", "clientFactory", "forceNew", "oldAgent", "oldLead", "agents", "execSpawn", "teamsFilePath",
  "cooldownMs", "emptyRetryMs", "backstopDelayMs", "httpWaitMs", "async", "__proto__", "constructor", "prototype",
];

export type BodyCheck = { ok: true; value: Record<string, unknown> } | { ok: false; status: 400 | 403; error: string };

const MAX_DEPTH = 8;

/** First forbidden key anywhere in the value (object keys at every depth, through arrays), or null. */
export function findForbiddenKey(v: unknown, depth = 0, allow: readonly string[] = []): string | null {
  if (depth > MAX_DEPTH || v === null || typeof v !== "object") return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const hit = findForbiddenKey(x, depth + 1, allow);
      if (hit) return hit;
    }
    return null;
  }
  for (const k of Object.keys(v)) {
    if (REMOTE_FORBIDDEN_BODY_KEYS.includes(k) && !allow.includes(k)) return k;
    const hit = findForbiddenKey((v as Record<string, unknown>)[k], depth + 1, allow);
    if (hit) return hit;
  }
  return null;
}

function checkValue(spec: FieldSpec, v: unknown, where: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return `${where}: nested too deep`;
  switch (spec.t) {
    case "string":
      if (where.startsWith("body.ideas[") && v && typeof v === "object" && !Array.isArray(v)) {
        return checkFields({ text: spec, laneId: id, lane: id, teamId: id, team: id, scope: INBOX_SCOPE }, ["text"], v as Record<string, unknown>, where, depth + 1);
      }
      if (typeof v !== "string") return `${where} must be a string`;
      if (v.length > spec.max) return `${where} is ${v.length} chars, cap ${spec.max}`;
      if (spec.oneOf && !spec.oneOf.includes(v)) return `${where} must be one of ${spec.oneOf.join(", ")}`;
      if (spec.re && !spec.re.test(v)) return `${where} has a bad format`;
      return null;
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v)) return `${where} must be a number`;
      if (spec.int && !Number.isInteger(v)) return `${where} must be an integer`;
      if (v < spec.min || v > spec.max) return `${where} is out of range`;
      return null;
    case "boolean":
      return typeof v === "boolean" ? null : `${where} must be a boolean`;
    case "array":
      if (!Array.isArray(v)) return `${where} must be an array`;
      if (v.length > spec.max) return `${where} has ${v.length} items, cap ${spec.max}`;
      for (let i = 0; i < v.length; i++) {
        const err = checkValue(spec.of, v[i], `${where}[${i}]`, depth + 1);
        if (err) return err;
      }
      return null;
    case "object": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return `${where} must be an object`;
      return checkFields(spec.fields, spec.require, v as Record<string, unknown>, where, depth + 1);
    }
  }
}

function checkFields(
  fields: Readonly<Record<string, FieldSpec>>,
  require: readonly string[] | undefined,
  obj: Record<string, unknown>,
  where: string,
  depth: number,
): string | null {
  for (const k of Object.keys(obj)) {
    if (!Object.hasOwn(fields, k)) return `key not allowed remotely: ${where}.${k}`;
  }
  for (const k of require ?? []) {
    if (!Object.hasOwn(obj, k)) return `key required remotely: ${where}.${k}`;
  }
  for (const k of Object.keys(obj)) {
    // undefined can't come out of JSON.parse; null is not a valid value for any remote field.
    const err = checkValue(fields[k], obj[k], `${where}.${k}`, depth);
    if (err) return err;
  }
  return null;
}

/**
 * Checks a remote write body against its endpoint's policy: JSON object, no forbidden key at any depth,
 * every key in the policy with the right type and within its cap. GETs never forward a body, so they pass.
 * Status: 403 for a policy refusal (no policy, forbidden/unknown key, bad value), 400 for unparseable JSON.
 */
export function checkRemoteBody(method: RemoteMethod, pathname: string, body: string | undefined): BodyCheck {
  if (method === "GET") return { ok: true, value: {} };
  const tkey = terminalPolicyKey(pathname);
  const policy = Object.hasOwn(REMOTE_BODY_POLICY, pathname)
    ? REMOTE_BODY_POLICY[pathname]
    : Object.hasOwn(REMOTE_TERMINAL_POLICY, tkey) && isOwnerRoute(pathname)
      ? REMOTE_TERMINAL_POLICY[tkey]
      : undefined;
  if (!policy) return { ok: false, status: 403, error: `no remote body policy for ${pathname}` };
  let parsed: unknown = {};
  if (body !== undefined && body.trim() !== "") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, status: 400, error: "body must be a JSON object" };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, status: 400, error: "body must be a JSON object" };
  const forbidden = findForbiddenKey(parsed, 0, policy.allowKeys);
  if (forbidden) return { ok: false, status: 403, error: `body key not allowed remotely: ${forbidden}` };
  const err = checkFields(policy.fields, policy.require, parsed as Record<string, unknown>, "body", 0);
  if (err) return { ok: false, status: 403, error: `${pathname}: ${err}` };
  if (policy.registry === "lane") {
    const rec = parsed as Record<string, unknown>;
    const laneId = String(rec.laneId ?? rec.lane ?? "").trim();
    if (!laneId) {
      return { ok: false, status: 403, error: `${pathname}: key required remotely: body.laneId (BadRequest: laneId is required)` };
    }
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

// ---- registry checks (need the live teams.json, read by the proxy over loopback GET /api/teams) ----

type RegLane = { id?: unknown; name?: unknown; aliases?: unknown; paths?: unknown; path?: unknown; lastProfile?: unknown; worktree?: unknown; branch?: unknown; cwd?: unknown; backend?: unknown; standing?: unknown };
type RegTeam = { id?: unknown; name?: unknown; aliases?: unknown; lanes?: unknown; paths?: unknown; path?: unknown; vibeMode?: unknown };

/** Lane and team fields that steer where and how agents spawn. A remote write can't change them. */
export const PINNED_TEAM_KEYS = ["paths", "path", "vibeMode"] as const;
export const PINNED_LANE_KEYS = ["paths", "path", "lastProfile", "worktree", "branch", "cwd", "backend"] as const;

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const normKey = (s: unknown): string => String(s || "").trim().toLowerCase();

function extractDiskTeams(current: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(current)) return current as Record<string, unknown>[];
  if (current && typeof current === "object" && Array.isArray((current as any).teams)) {
    return (current as any).teams as Record<string, unknown>[];
  }
  return null;
}

/**
 * Pins `paths`/`path`/`vibeMode` (team) and `paths`/`path`/`lastProfile`/`worktree`/`branch`/`cwd` (lane)
 * to the values on disk. Enforces case-insensitive matching, refuses deleting or reordering existing teams
 * or lanes, caps new additions (<= 1 team, <= 3 lanes per save), prevents cross-registry collisions and
 * cross-team lane moves, and merges incoming fields onto existing on-disk objects to preserve unknown keys.
 */
export function pinTeamsRegistry(
  body: Record<string, unknown>,
  current: unknown,
  redact: (s: string) => string = (s) => s,
): { ok: true; value: Record<string, unknown> } | { ok: false; status: 403 | 503; error: string } {
  const curTeams = extractDiskTeams(current);
  if (!curTeams) {
    return { ok: false, status: 503, error: "could not read teams.json to check the write" };
  }
  const echoes = (sent: unknown, disk: unknown) => sameJson(sent, disk) || sameJson(sent, JSON.parse(redact(JSON.stringify(disk ?? null))));

  const diskTeamsById = new Map<string, { team: Record<string, unknown>; index: number }>();
  const diskTeamsByAnyKey = new Map<string, Record<string, unknown>>();
  const allDiskLaneIds = new Map<string, { lane: Record<string, unknown>; teamId: string }>();
  const allDiskLanes = new Map<string, { lane: Record<string, unknown>; teamId: string }>();

  for (let i = 0; i < curTeams.length; i++) {
    const dt = curTeams[i];
    if (!dt || typeof dt !== "object") continue;
    const dtId = normKey(dt.id);
    if (!dtId) continue;
    diskTeamsById.set(dtId, { team: dt, index: i });
    diskTeamsByAnyKey.set(dtId, dt);
    const dtName = normKey(dt.name);
    if (dtName) diskTeamsByAnyKey.set(dtName, dt);
    for (const a of asArray(dt.aliases)) {
      const ak = normKey(a);
      if (ak) diskTeamsByAnyKey.set(ak, dt);
    }
    for (const dl of asArray(dt.lanes) as Record<string, unknown>[]) {
      if (!dl || typeof dl !== "object") continue;
      const dlId = normKey(dl.id);
      if (dlId) {
        allDiskLaneIds.set(dlId, { lane: dl, teamId: dtId });
        allDiskLanes.set(dlId, { lane: dl, teamId: dtId });
      }
      const dlName = normKey(dl.name);
      if (dlName && !allDiskLaneIds.has(dlName)) allDiskLanes.set(dlName, { lane: dl, teamId: dtId });
      for (const a of asArray(dl.aliases)) {
        const ak = normKey(a);
        if (ak && !allDiskLaneIds.has(ak)) allDiskLanes.set(ak, { lane: dl, teamId: dtId });
      }
    }
  }

  const inTeams = asArray(body.teams) as Record<string, unknown>[];

  // 1. Check pinned keys on each incoming team and lane first.
  for (const t of inTeams) {
    const tId = normKey(t?.id);
    const diskTeam = diskTeamsById.get(tId)?.team;
    if (diskTeam) {
      if (t.vibeMode !== undefined && Boolean(t.vibeMode) !== Boolean(diskTeam.vibeMode)) {
        return { ok: false, status: 403, error: "RemoteDenied: team paths and vibeMode are pinned on host" };
      }
      for (const k of ["paths", "path"] as const) {
        if (Object.hasOwn(t, k) && !echoes(t[k], diskTeam[k])) {
          return {
            ok: false,
            status: 403,
            error: `RemoteDenied: team ${String(diskTeam.id)}.${k} can't be changed remotely`,
          };
        }
      }
    } else {
      if (Boolean(t?.vibeMode) === true) {
        return { ok: false, status: 403, error: "RemoteDenied: new remote teams cannot enable vibeMode" };
      }
      for (const k of ["paths", "path"] as const) {
        if (Object.hasOwn(t, k)) {
          return { ok: false, status: 403, error: `RemoteDenied: team ${String(t.id)}.${k} can't be set remotely on a new entry` };
        }
      }
    }
    if (!Array.isArray(t?.lanes)) continue;
    const diskLanes = asArray(diskTeam?.lanes) as Record<string, unknown>[];
    for (const l of t.lanes as Record<string, unknown>[]) {
      const lId = normKey(l?.id);
      const diskLane = diskLanes.find((c) => normKey(c?.id) === lId);
      for (const k of PINNED_LANE_KEYS) {
        const has = Object.hasOwn(l, k);
        if (!diskLane) {
          if (has) return { ok: false, status: 403, error: `RemoteDenied: lane ${String(l.id)}.${k} can't be set remotely on a new entry` };
          continue;
        }
        if (has && !echoes(l[k], diskLane[k])) {
          return { ok: false, status: 403, error: `RemoteDenied: lane ${String(diskLane.id)}.${k} can't be changed remotely` };
        }
      }
    }
  }

  // 2. Check team uniqueness across the payload and collisions with on-disk teams.
  const seenTeamKeys = new Map<string, number>();
  for (let ti = 0; ti < inTeams.length; ti++) {
    const t = inTeams[ti];
    const tId = normKey(t?.id);
    if (!tId) return { ok: false, status: 403, error: "RemoteDenied: team id is required" };
    const isExistingTeam = diskTeamsById.has(tId);
    const keysToCheck = [tId];
    const tName = normKey(t?.name);
    if (tName && tName !== tId) keysToCheck.push(tName);
    const seenAliases = new Set<string>();
    for (const a of asArray(t?.aliases)) {
      const ak = normKey(a);
      if (!ak) continue;
      if (seenAliases.has(ak) || ak === tId || (tName && ak === tName)) {
        return { ok: false, status: 403, error: `RemoteDenied: duplicate team alias "${ak}"` };
      }
      seenAliases.add(ak);
      keysToCheck.push(ak);
    }
    for (const k of keysToCheck) {
      if (seenTeamKeys.has(k) && seenTeamKeys.get(k) !== ti) {
        return { ok: false, status: 403, error: `RemoteDenied: duplicate team identifier "${k}"` };
      }
      seenTeamKeys.set(k, ti);
      const diskOwner = diskTeamsByAnyKey.get(k);
      if (diskOwner) {
        if (!isExistingTeam || normKey(diskOwner.id) !== tId) {
          return { ok: false, status: 403, error: `RemoteDenied: team identifier "${k}" collides with an existing team` };
        }
      }
    }
  }

  // 3. Refuse dropping or reordering existing teams, and cap new teams at <= 1.
  for (const [dtId] of diskTeamsById) {
    if (!inTeams.some((t) => normKey(t?.id) === dtId)) {
      return { ok: false, status: 403, error: "RemoteDenied: cannot delete teams remotely (set state to removed)" };
    }
  }
  for (let i = 0; i < curTeams.length; i++) {
    if (normKey(inTeams[i]?.id) !== normKey(curTeams[i]?.id)) {
      return { ok: false, status: 403, error: "RemoteDenied: cannot reorder existing teams remotely" };
    }
  }
  const newTeamsCount = inTeams.length - curTeams.length;
  if (newTeamsCount > 1) {
    return { ok: false, status: 403, error: "RemoteDenied: at most 1 new team per remote save" };
  }

  // 4. Validate lanes per team (uniqueness, cross-team collisions, no drops, no reorder, <= 3 new lanes) and merge onto disk.
  let totalNewLanes = 0;
  const seenAllLaneKeys = new Map<string, { teamId: string; laneId: string; isPreExistingOwnKey: boolean }>();
  const mergedTeams: Record<string, unknown>[] = [];

  for (const t of inTeams) {
    const tId = normKey(t.id);
    const diskTeam = diskTeamsById.get(tId)?.team;
    const diskLanes = asArray(diskTeam?.lanes) as Record<string, unknown>[];
    const diskLanesById = new Map<string, { lane: Record<string, unknown>; index: number }>();
    for (let li = 0; li < diskLanes.length; li++) {
      const dl = diskLanes[li];
      const dlId = normKey(dl?.id);
      if (dlId) diskLanesById.set(dlId, { lane: dl, index: li });
    }

    const hasInLanes = Array.isArray(t.lanes);
    const inLanes = hasInLanes ? (t.lanes as Record<string, unknown>[]) : [];

    const seenLaneKeys = new Map<string, number>();
    for (let li = 0; li < inLanes.length; li++) {
      const l = inLanes[li];
      const lId = normKey(l?.id);
      if (!lId) return { ok: false, status: 403, error: "RemoteDenied: lane id is required" };
      const diskLaneEntry = diskLanesById.get(lId);
      const isExistingInTeam = Boolean(diskLaneEntry);
      const diskLane = diskLaneEntry?.lane;
      const ownDiskKeys = new Set<string>();
      if (diskLane) {
        const dId = normKey(diskLane.id);
        if (dId) ownDiskKeys.add(dId);
        const dName = normKey(diskLane.name);
        if (dName) ownDiskKeys.add(dName);
        for (const a of asArray(diskLane.aliases)) {
          const ak = normKey(a);
          if (ak) ownDiskKeys.add(ak);
        }
      }
      const keysToCheck = [lId];
      const lName = normKey(l?.name);
      if (lName && lName !== lId) keysToCheck.push(lName);
      const seenAliases = new Set<string>();
      for (const a of asArray(l?.aliases)) {
        const ak = normKey(a);
        if (!ak) continue;
        if (seenAliases.has(ak) || ak === lId || (lName && ak === lName)) {
          return { ok: false, status: 403, error: `RemoteDenied: duplicate lane alias "${ak}"` };
        }
        seenAliases.add(ak);
        keysToCheck.push(ak);
      }
      for (const k of keysToCheck) {
        if (seenLaneKeys.has(k) && seenLaneKeys.get(k) !== li) {
          return { ok: false, status: 403, error: `RemoteDenied: duplicate lane identifier "${k}"` };
        }
        seenLaneKeys.set(k, li);
        const isPreExistingOwnKey = isExistingInTeam && ownDiskKeys.has(k);
        const idOwner = allDiskLaneIds.get(k);
        if (idOwner && (idOwner.teamId !== tId || normKey(idOwner.lane.id) !== lId)) {
          return { ok: false, status: 403, error: "RemoteDenied: lane id, name, or alias collides with an existing lane" };
        }
        const diskOwner = allDiskLanes.get(k);
        if (diskOwner && (diskOwner.teamId !== tId || normKey(diskOwner.lane.id) !== lId) && !isPreExistingOwnKey) {
          return { ok: false, status: 403, error: "RemoteDenied: lane id, name, or alias collides with an existing lane" };
        }
        const prevSeen = seenAllLaneKeys.get(k);
        if (prevSeen && (prevSeen.teamId !== tId || prevSeen.laneId !== lId)) {
          if (!isPreExistingOwnKey || !prevSeen.isPreExistingOwnKey || k === lId) {
            return { ok: false, status: 403, error: "RemoteDenied: lane id, name, or alias collides with an existing lane" };
          }
        }
        seenAllLaneKeys.set(k, { teamId: tId, laneId: lId, isPreExistingOwnKey });
      }
      if (!isExistingInTeam) {
        totalNewLanes++;
      }
    }

    if (diskLanes.length > 0) {
      for (const [dlId] of diskLanesById) {
        if (!inLanes.some((l) => normKey(l?.id) === dlId)) {
          return { ok: false, status: 403, error: "RemoteDenied: cannot delete lanes remotely (set state to removed)" };
        }
      }
      for (let i = 0; i < diskLanes.length; i++) {
        if (normKey(inLanes[i]?.id) !== normKey(diskLanes[i]?.id)) {
          return { ok: false, status: 403, error: "RemoteDenied: cannot reorder existing lanes remotely" };
        }
      }
    }

    if (totalNewLanes > 3) {
      return { ok: false, status: 403, error: "RemoteDenied: at most 3 new lanes per remote save" };
    }

    const mergedLanes: Record<string, unknown>[] = [];
    for (const l of inLanes) {
      const diskLane = diskLanesById.get(normKey(l.id))?.lane;
      if (diskLane) {
        const mergedLane: Record<string, unknown> = { ...diskLane, ...l, id: diskLane.id };
        for (const k of PINNED_LANE_KEYS) {
          if (diskLane[k] === undefined) delete mergedLane[k];
          else mergedLane[k] = diskLane[k];
        }
        mergedLanes.push(mergedLane);
      } else {
        const mergedLane: Record<string, unknown> = { ...l };
        for (const k of PINNED_LANE_KEYS) delete mergedLane[k];
        mergedLanes.push(mergedLane);
      }
    }

    if (diskTeam) {
      const mergedTeam: Record<string, unknown> = { ...diskTeam, ...t, id: diskTeam.id };
      for (const k of PINNED_TEAM_KEYS) {
        if (diskTeam[k] === undefined) delete mergedTeam[k];
        else mergedTeam[k] = diskTeam[k];
      }
      if (hasInLanes || Array.isArray(diskTeam.lanes)) {
        mergedTeam.lanes = mergedLanes;
      }
      mergedTeams.push(mergedTeam);
    } else {
      const mergedTeam: Record<string, unknown> = { ...t };
      for (const k of PINNED_TEAM_KEYS) delete mergedTeam[k];
      if (hasInLanes) {
        mergedTeam.lanes = mergedLanes;
      }
      mergedTeams.push(mergedTeam);
    }
  }

  return { ok: true, value: { ...body, teams: mergedTeams } };
}

function teamMatches(t: RegTeam, wantTeam: string): boolean {
  const w = normKey(wantTeam);
  if (!w) return false;
  if (normKey(t?.id) === w || normKey(t?.name) === w) return true;
  return asArray(t?.aliases).some((a) => normKey(a) === w);
}

function laneMatches(l: RegLane, wantLane: string): boolean {
  const w = normKey(wantLane);
  if (!w) return false;
  if (normKey(l?.id) === w) return true;
  return asArray(l?.aliases).some((a) => normKey(a) === w);
}

/**
 * Verifies the body's lane (`laneId` or `lane`) and optional team (`teamId` or `team`) against `teams.json`.
 * Fails closed: missing lane returns 400; unreadable registry returns 503; unknown team or lane not belonging
 * to the specified team (or not in `teams.json`) returns 403.
 */
export function checkLaneExists(
  body: Record<string, unknown>,
  current: unknown,
): { ok: true } | { ok: false; status: 400 | 403 | 503; error: string } {
  const laneId = String(body?.laneId ?? body?.lane ?? body?.defaultLaneId ?? "").trim();
  if (!laneId) {
    return { ok: false, status: 400, error: "BadRequest: laneId is required" };
  }
  const diskTeams = extractDiskTeams(current) as RegTeam[] | null;
  if (!diskTeams) {
    return { ok: false, status: 503, error: "could not read teams.json to check the lane" };
  }
  const verifyPair = (wantTeam: string, wantLane: string): { ok: true } | { ok: false; status: 403; error: string } => {
    if (wantTeam) {
      const team = diskTeams.find((t) => teamMatches(t, wantTeam));
      if (!team) {
        return { ok: false, status: 403, error: `RemoteDenied: unknown team "${wantTeam}"` };
      }
      const foundInTeam = asArray(team.lanes).some((l: RegLane) => laneMatches(l, wantLane));
      if (!foundInTeam) {
        return { ok: false, status: 403, error: `RemoteDenied: lane "${wantLane}" does not belong to team "${wantTeam}"` };
      }
    } else {
      const foundAnywhere = diskTeams.some((t) => asArray(t?.lanes).some((l: RegLane) => laneMatches(l, wantLane)));
      if (!foundAnywhere) {
        return { ok: false, status: 403, error: `RemoteDenied: lane ${wantLane} is not in teams.json` };
      }
    }
    return { ok: true };
  };

  const teamId = String(body?.teamId ?? body?.team ?? "").trim();
  const topCheck = verifyPair(teamId, laneId);
  if (!topCheck.ok) return topCheck;

  const defaultLaneId = String(body?.defaultLaneId ?? "").trim();
  if (defaultLaneId) {
    const defCheck = verifyPair(teamId, defaultLaneId);
    if (!defCheck.ok) return defCheck;
  }

  if (Array.isArray(body?.ideas)) {
    for (const item of body.ideas) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>;
        const itemTeam = String(rec.teamId ?? rec.team ?? "").trim();
        const itemLane = String(rec.laneId ?? rec.lane ?? "").trim();
        if (itemTeam || itemLane) {
          const checkItem = verifyPair(itemTeam || teamId, itemLane || laneId);
          if (!checkItem.ok) return checkItem;
        }
      }
    }
  }

  if (body?.patch && typeof body.patch === "object" && !Array.isArray(body.patch)) {
    const patch = body.patch as Record<string, unknown>;
    const patchTeam = String(patch.teamId ?? "").trim();
    const patchLane = String(patch.laneId ?? "").trim();
    if (patchTeam || patchLane) {
      const checkPatch = verifyPair(patchTeam || teamId, patchLane || laneId);
      if (!checkPatch.ok) return checkPatch;
    }
  }
  return { ok: true };
}

/** Runs the policy's registry check. `current` is the parsed GET /api/teams body (null if unreadable). */
export function checkRemoteRegistry(
  pathname: string,
  body: Record<string, unknown>,
  current: unknown,
  redact?: (s: string) => string,
): { ok: true; value: Record<string, unknown> } | { ok: false; status: 400 | 403 | 503; error: string } {
  const kind = Object.hasOwn(REMOTE_BODY_POLICY, pathname) ? REMOTE_BODY_POLICY[pathname].registry : undefined;
  if (kind === "teams") return pinTeamsRegistry(body, current, redact);
  if (kind === "lane") {
    const r = checkLaneExists(body, current);
    return r.ok ? { ok: true, value: body } : r;
  }
  return { ok: true, value: body };
}

/** True when the endpoint's policy needs teams.json before forwarding. */
export function needsRegistry(pathname: string): boolean {
  return Boolean(Object.hasOwn(REMOTE_BODY_POLICY, pathname) && REMOTE_BODY_POLICY[pathname].registry);
}

/** Never proxied, whatever ALLOW says. Entries ending in "*" are prefixes. */
export const REMOTE_BLOCKED: readonly string[] = [
  "/__vibesquad/first-run*",
  "/__vibesquad/paseo/daemon*",
  "/__vibesquad/paseo/raw*",
  "/__vibesquad/paseo/pair*", // returns the relay pairing offer, i.e. the secret
  "/__vibesquad/paseo/hub*", // connects the daemon to an external hub origin
  "/__vibesquad/pair*",
  "/pair*",
  "/__vibesquad/push*",
  "/__vibesquad/devices*",
  "/__vibesquad/local-image*",
  "/__vibesquad/local-login*",
  "/__vibesquad/remove-team-worktrees*",
  "/__vibesquad/desktop*",
  "/__vibesquad/attach*", // copies arbitrary local files into a workspace
  "/__vibesquad/profiles/import*",
  "/__vibesquad/files*", // workspace file names (S3 gated read)
  "/__vibesquad/search*", // workspace file contents (S3 gated read)
  "/VibeSquad-setup.exe",
  "/ca.crt",
];

export type ProxyDecision =
  | { ok: true; method: RemoteMethod; pathname: string; search: string }
  | { ok: false; code: "method" | "path" | "blocked" | "not-allowed"; error: string };

const PATH_CHARS = /^\/[A-Za-z0-9/_.-]*$/;
const QUERY_CHARS = /^[A-Za-z0-9_.~!$&'()*+,;=:@/?%-]*$/;

export function isBlockedPath(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return REMOTE_BLOCKED.some((b) => {
    const rule = b.toLowerCase();
    return rule.endsWith("*") ? p.startsWith(rule.slice(0, -1)) : p === rule;
  });
}

/**
 * Splits and checks a caller-supplied path. Rejects absolute or scheme-relative URLs, backslashes,
 * any percent-encoding in the pathname (so no encoded traversal), dot segments, empty segments and
 * control characters. The query string is kept verbatim but limited to URL-safe characters.
 */
export function normalizeProxyPath(raw: unknown): { ok: true; pathname: string; search: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || !raw) return { ok: false, error: "path must be a non-empty string" };
  if (raw.length > REMOTE_MAX_PATH_CHARS) return { ok: false, error: "path too long" };
  if (raw[0] !== "/" || raw.startsWith("//")) return { ok: false, error: "path must be origin-relative" };
  if (raw.includes("#")) return { ok: false, error: "fragments are not allowed" };
  const q = raw.indexOf("?");
  const pathname = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? "" : raw.slice(q + 1);
  if (!PATH_CHARS.test(pathname)) return { ok: false, error: "path has disallowed characters" };
  const segs = pathname.split("/").slice(1);
  if (segs.some((s, i) => s === "." || s === ".." || (s === "" && i !== segs.length - 1))) {
    return { ok: false, error: "path traversal is not allowed" };
  }
  if (!QUERY_CHARS.test(query)) return { ok: false, error: "query has disallowed characters" };
  if (/%(?![0-9A-Fa-f]{2})/.test(query)) return { ok: false, error: "query has bad percent-encoding" };
  const trimmed = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return { ok: true, pathname: trimmed, search: query ? `?${query}` : "" };
}

/** Query params dropped remotely: `refresh=1` on usage forces provider API calls (an S3 gated read). */
const STRIP_QUERY: Readonly<Record<string, readonly string[]>> = { "/__vibesquad/paseo/usage": ["refresh"] };

function stripQuery(pathname: string, search: string): string {
  const drop = Object.hasOwn(STRIP_QUERY, pathname) ? STRIP_QUERY[pathname] : undefined;
  if (!drop || !search) return search;
  const kept = search
    .slice(1)
    .split("&")
    .filter((pair) => {
      if (!pair) return false;
      const key = pair.split("=")[0];
      let name = key;
      try {
        name = decodeURIComponent(key.replace(/\+/g, " "));
      } catch {}
      return !drop.includes(name);
    });
  return kept.length ? `?${kept.join("&")}` : "";
}

/**
 * Full decision for one request: method filter, normalisation, blocklist, allowlist, query strip.
 * `allow` is injectable for tests; production is REMOTE_ALLOW.
 */
export function decideProxyRequest(method: unknown, path: unknown, allow: AllowMap = REMOTE_ALLOW): ProxyDecision {
  const m = typeof method === "string" ? method.toUpperCase() : "";
  if (!(REMOTE_METHODS as readonly string[]).includes(m)) {
    return { ok: false, code: "method", error: `method not allowed: ${String(method)}` };
  }
  const norm = normalizeProxyPath(path);
  if (!norm.ok) return { ok: false, code: "path", error: norm.error };
  if (isBlockedPath(norm.pathname)) return { ok: false, code: "blocked", error: `blocked remotely: ${norm.pathname}` };
  const allowed = Object.hasOwn(allow, norm.pathname) ? allow[norm.pathname] : ownerRouteMethods(norm.pathname);
  if (allowed && norm.pathname === "/__vibesquad/workspace-scripts/logs" && new URLSearchParams(norm.search).has("stream")) {
    return { ok: false, code: "not-allowed", error: `not available remotely: ${norm.pathname}?stream (use the non-stream form)` };
  }
  if (!allowed) return { ok: false, code: "not-allowed", error: `not available remotely: ${norm.pathname}` };
  if (!allowed.includes(m as RemoteMethod)) {
    return { ok: false, code: "method", error: `${m} not available remotely on ${norm.pathname}` };
  }
  return { ok: true, method: m as RemoteMethod, pathname: norm.pathname, search: stripQuery(norm.pathname, norm.search) };
}

export function isAllowedRoute(method: unknown, path: unknown, allow: AllowMap = REMOTE_ALLOW): boolean {
  return decideProxyRequest(method, path, allow).ok;
}

/** HTTP-style status for a refused decision: 405 wrong method, 400 malformed path, 403 blocked/unlisted. */
export function decisionStatus(code: "method" | "path" | "blocked" | "not-allowed"): 400 | 403 | 405 {
  return code === "method" ? 405 : code === "path" ? 400 : 403;
}

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/** Response headers passed back to the browser. Everything else (set-cookie, location, ...) is dropped. */
export const REMOTE_RESPONSE_HEADERS = ["content-type", "cache-control", "etag", "last-modified"] as const;

export function isTextContentType(ct: string | null | undefined): boolean {
  if (!ct) return true; // empty bodies (204, 405 res.end()) carry no type
  const t = ct.split(";")[0].trim().toLowerCase();
  return t.startsWith("text/") || t === "application/json" || t.endsWith("+json");
}

// ---- rate limits ------------------------------------------------------------------------------------

export const ENDPOINT_WRITE_LIMITS_PER_MIN: Record<string, number> = {
  "POST /api/teams": 5,
  "PUT /api/teams": 5,
  "POST /__vibesquad/teams": 5,
  "PUT /__vibesquad/teams": 5,
  "POST /__vibesquad/brainstorm-summary": 5,
  "PUT /__vibesquad/brainstorm-summary": 5,
  "POST /__vibesquad/inbox": 10,
  "POST /__vibesquad/inbox/triage": 10,
  "POST /__vibesquad/park-topic": 10,
  "POST /__vibesquad/inbox/park-topic": 10,
  "POST /__vibesquad/handoff-topic": 10,
  "POST /__vibesquad/inbox/handoff-topic": 10,
  "POST /__vibesquad/log": 10,
  "POST /__vibesquad/vs-log": 10,
  "POST /__vibesquad/brainstorm-restart": 5,
  "POST /__vibesquad/handoff": 5,
};

export type RateKind = "read" | "write" | "term";
export type RateLimiter = {
  acquire(kind: RateKind, endpointKey?: string): { ok: true; release: () => void } | { ok: false; status: 429; error: string };
  check(method: string, path: string): { ok: true; status: 200; release: () => void } | { ok: false; status: 429; error: string };
};

/** At most `maxInFlight` concurrent requests, plus a rolling per-minute budget per kind (read/write) and per write endpoint. */
export function createRateLimiter(
  opts: {
    maxInFlight?: number;
    budget?: Record<RateKind, number>;
    endpointLimits?: Record<string, number>;
    windowMs?: number;
    now?: () => number;
  } = {},
): RateLimiter {
  const maxInFlight = opts.maxInFlight ?? REMOTE_MAX_IN_FLIGHT;
  const budget = opts.budget ?? REMOTE_BUDGET_PER_MIN;
  const endpointLimits = opts.endpointLimits ?? ENDPOINT_WRITE_LIMITS_PER_MIN;
  const windowMs = opts.windowMs ?? REMOTE_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const stamps: Record<RateKind, number[]> = { read: [], write: [], term: [] };
  const endpointStamps = new Map<string, number[]>();
  let inFlight = 0;

  function evaluate(kind: RateKind, endpointKey: string | undefined, trackInFlight: boolean) {
    const t = now();
    const list = stamps[kind];
    while (list.length && list[0] <= t - windowMs) list.shift();
    let epList: number[] | undefined;
    let epCap: number | undefined;
    if (endpointKey && Object.hasOwn(endpointLimits, endpointKey)) {
      epCap = endpointLimits[endpointKey];
      epList = endpointStamps.get(endpointKey);
      if (!epList) {
        epList = [];
        endpointStamps.set(endpointKey, epList);
      }
      while (epList.length && epList[0] <= t - windowMs) epList.shift();
    }
    if (inFlight >= maxInFlight) {
      return { ok: false as const, status: 429 as const, error: `too many requests in flight (max ${maxInFlight})` };
    }
    if (list.length >= budget[kind]) {
      const wait = Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000));
      return { ok: false as const, status: 429 as const, error: `rate limited: ${budget[kind]} ${kind}s per minute, retry in ${wait} s` };
    }
    if (epList && epCap !== undefined && epList.length >= epCap) {
      const wait = Math.max(1, Math.ceil((epList[0] + windowMs - t) / 1000));
      return {
        ok: false as const,
        status: 429 as const,
        error: `rate limited: ${epCap} writes per minute on ${endpointKey}, retry in ${wait} s`,
      };
    }
    list.push(t);
    if (epList) epList.push(t);
    if (trackInFlight) inFlight++;
    let released = false;
    return {
      ok: true as const,
      status: 200 as const,
      release: () => {
        if (trackInFlight && !released) inFlight--;
        released = true;
      },
    };
  }

  return {
    acquire(kind: RateKind, endpointKey?: string) {
      return evaluate(kind, endpointKey, true);
    },
    check(method: string, path: string) {
      const m = String(method || "GET").toUpperCase();
      const p = String(path || "").split("?")[0];
      const kind: RateKind = m === "GET" ? "read" : "write";
      return evaluate(kind, `${m} ${p}`, false);
    },
  };
}

// ---- response redaction -----------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const FS_PATH_RE = /(?:[A-Za-z]:[\\/][^\s"'<>|?*]+|\/(?:Users|home|root|var|tmp|etc|opt|private|mnt|srv)\/[^\s"'<>|?*]+)/g;

function scrubErrorValue(v: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || v === null || v === undefined) return v;
  if (typeof v === "string") {
    return v.replace(FS_PATH_RE, "[redacted-path]");
  }
  if (Array.isArray(v)) {
    return v.map((item) => scrubErrorValue(item, depth + 1));
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "path" || k === "teamLogPath" || k === "cwd" || k === "worktree" || k === "stack") continue;
      out[k] = scrubErrorValue(val, depth + 1);
    }
    return out;
  }
  return v;
}

/**
 * Replaces the owner's home directory (backslash, JSON-escaped backslash and forward-slash forms, any
 * case), then the bare username, with "~". The needles hold no quotes, so JSON bodies stay valid.
 */
export function redactBody(body: string, homeDir: string, userName: string): string {
  let out = body;
  // Keep a leading "" for POSIX homes ("/home/x") so the root separator is part of the needle.
  const parts = homeDir.replace(/[\\/]+$/, "").split(/[\\/]+/);
  if (parts.filter(Boolean).length >= 2) {
    // Longest form first: JSON-escaped "C:\\Users\\x" before raw "C:\Users\x".
    for (const sep of ["\\\\", "\\", "/"]) {
      out = out.replace(new RegExp(escapeRe(parts.join(sep)), "gi"), "~");
    }
  }
  const user = userName.trim();
  if (user.length >= 3) out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRe(user)}(?![A-Za-z0-9_])`, "gi"), "~");
  return out;
}

/**
 * Drops `remote` (the proxy gate) from GET /__vibesquad/settings responses, strips top-level `path`
 * and `teamLogPath` from JSON object responses, and scrubs filesystem paths / sensitive keys on >= 400 error bodies.
 */
export function scrubResponseBody(pathname: string, body: string, status?: number): string {
  const isError = status !== undefined && status >= 400;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      let mutated = false;
      if (pathname === "/__vibesquad/settings" && "remote" in parsed) {
        delete parsed.remote;
        mutated = true;
      }
      // fs/resolve's `path` is repo-relative and already confined server-side; bare-name links need it.
      if ("path" in parsed && pathname !== "/__vibesquad/fs/resolve") {
        delete parsed.path;
        mutated = true;
      }
      if ("teamLogPath" in parsed) {
        delete parsed.teamLogPath;
        mutated = true;
      }
      if (isError) {
        return JSON.stringify(scrubErrorValue(parsed));
      }
      return mutated ? JSON.stringify(parsed) : body;
    }
    if (isError && (typeof parsed === "string" || Array.isArray(parsed))) {
      return JSON.stringify(scrubErrorValue(parsed));
    }
  } catch {
    if (isError) {
      return body.replace(FS_PATH_RE, "[redacted-path]");
    }
  }
  return body;
}

export const scrubSettingsBody = scrubResponseBody;
