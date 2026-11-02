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
export const REMOTE_MAX_PATH_CHARS = 2048;
export const REMOTE_MAX_IN_FLIGHT = 4;
export const REMOTE_WINDOW_MS = 60_000;
export const REMOTE_BUDGET_PER_MIN = { read: 120, write: 20 } as const;
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
  // R2-5 #1 teams/pins: a pin is a lane in teams.json. paths/path/lastProfile are pinned to disk (registry).
  "/api/teams": ["GET", "PUT"],
  "/__vibesquad/teams": ["GET", "POST"],
  "/__vibesquad/settings": READ, // `remote` is dropped from the response
  // R2-5 #3 log/vs-log: text and refs only; the author is the owner (no agent/agentId).
  "/__vibesquad/log": ["GET", "POST"],
  "/__vibesquad/vs-log": ["GET", "POST"],
  "/__vibesquad/handoff": READ, // "does the packet exist?" (path redacted). POST stays closed.
  // R2-5 #4 brainstorm-summary: revision required, lane must exist in teams.json.
  "/__vibesquad/brainstorm-summary": ["GET", "POST", "PUT"],
  // R2-5 #2 inbox: cards only; spawn config (provider/model/profile) and card titles never come remotely.
  "/__vibesquad/inbox": ["GET", "POST"],
  "/__vibesquad/inbox/triage": ["POST"],
  "/__vibesquad/inbox/open-topic": ["POST"],
  "/__vibesquad/inbox/park-topic": ["POST"],
  "/__vibesquad/inbox/handoff-topic": ["POST"],
  // R2-5 #5 brainstorm-restart: known Buddy or start-brainstorm on a lane that exists in teams.json.
  "/__vibesquad/brainstorm-restart": ["POST"],
  "/__vibesquad/profiles": READ,
  "/__vibesquad/profiles/diff": READ,
  "/__vibesquad/workspace-package-scripts": READ,
  "/__vibesquad/paseo/status": READ,
  "/__vibesquad/paseo/providers": READ,
  "/__vibesquad/paseo/usage": READ, // `refresh` is stripped from the query
  "/__vibesquad/paseo/plugins": READ,
};

/** Writes that stay closed remotely, and why. Reopening one needs the server change named here first. */
export const REMOTE_WRITES_CLOSED: Readonly<Record<string, string>> = {
  "/__vibesquad/handoff": "POST runs `vs handoff` for up to 60 s; the proxy timeout can't cancel the CLI run",
  "/__vibesquad/lead-handoff":
    "spawns a successor lead and retires the old one with no server-side spawn/archive budget (archiveBudget covers only Buddies); the UI never calls it",
  "/__vibesquad/lead-handoff/confirm": "relabels/renames the old lead and deletes its heartbeat; only the lead-handoff flow calls it",
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
    aliases: { t: "array", max: 32, of: str(200) },
    hub: { t: "boolean" },
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
  "/__vibesquad/log": { fields: { team: id, lane: id, type: LOG_TYPE, text: str(240), refs }, require: ["team", "text"] },
  "/__vibesquad/vs-log": {
    fields: { teamId: id, team: id, laneId: id, lane: id, type: LOG_TYPE, text: str(2000), refs },
    require: ["text"],
  },
  "/__vibesquad/brainstorm-summary": {
    fields: { laneId: id, lane: id, content: str(20_000), revision: str(128) },
    require: ["content", "revision"],
    registry: "lane",
  },
  // No topic: the UI never sends one, and a fresh topic per call would spawn a new Buddy each time.
  "/__vibesquad/brainstorm-restart": {
    fields: { agentId: id, teamId: id, laneId: id, laneName: str(200), reason: { t: "string", max: 40, re: SLUG_RE }, usedTokens: tokens, mode: oneOf("quick-start") },
    require: ["reason"],
    registry: "lane",
  },
  "/__vibesquad/inbox": {
    fields: {
      text: str(20_000),
      ideas: { t: "array", max: 100, of: str(4000) },
      splitDump: { t: "boolean" },
      laneId: id,
      teamId: id,
      defaultLaneId: id,
    },
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
  },
  "/__vibesquad/inbox/open-topic": { fields: { cardId }, require: ["cardId"] },
  "/__vibesquad/inbox/park-topic": { fields: { cardId, agentId: id, summaryNote: str(4000) }, require: ["cardId"] },
  "/__vibesquad/inbox/handoff-topic": { fields: { cardId, agentId: id, planNote: str(4000), usedTokens: tokens }, require: ["cardId"] },
};

/** Never accepted in a remote body at any depth, whatever a policy says: spawn config, DI hooks, prompt and brief text. */
export const REMOTE_FORBIDDEN_BODY_KEYS: readonly string[] = [
  "cwd", "provider", "model", "profile", "profilesPath", "baseHome", "labels", "title", "pendingPrompt", "summaryUpdate",
  "skipDaemon", "daemonClient", "clientFactory", "forceNew", "oldAgent", "oldLead", "agents", "execSpawn", "teamsFilePath",
  "cooldownMs", "emptyRetryMs", "backstopDelayMs", "httpWaitMs", "async", "__proto__", "constructor", "prototype",
];

export type BodyCheck = { ok: true; value: Record<string, unknown> } | { ok: false; status: 400 | 403; error: string };

const MAX_DEPTH = 8;

/** First forbidden key anywhere in the value (object keys at every depth, through arrays), or null. */
export function findForbiddenKey(v: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH || v === null || typeof v !== "object") return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const hit = findForbiddenKey(x, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const k of Object.keys(v)) {
    if (REMOTE_FORBIDDEN_BODY_KEYS.includes(k)) return k;
    const hit = findForbiddenKey((v as Record<string, unknown>)[k], depth + 1);
    if (hit) return hit;
  }
  return null;
}

function checkValue(spec: FieldSpec, v: unknown, where: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return `${where}: nested too deep`;
  switch (spec.t) {
    case "string":
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
  const policy = Object.hasOwn(REMOTE_BODY_POLICY, pathname) ? REMOTE_BODY_POLICY[pathname] : undefined;
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
  const forbidden = findForbiddenKey(parsed);
  if (forbidden) return { ok: false, status: 403, error: `body key not allowed remotely: ${forbidden}` };
  const err = checkFields(policy.fields, policy.require, parsed as Record<string, unknown>, "body", 0);
  if (err) return { ok: false, status: 403, error: `${pathname}: ${err}` };
  return { ok: true, value: parsed as Record<string, unknown> };
}

// ---- registry checks (need the live teams.json, read by the proxy over loopback GET /api/teams) ----

type RegLane = { id?: unknown; aliases?: unknown; paths?: unknown; path?: unknown; lastProfile?: unknown };
type RegTeam = { id?: unknown; lanes?: unknown; paths?: unknown; path?: unknown };

/** Lane and team fields that steer where and how agents spawn. A remote write can't change them. */
const PINNED_TEAM_KEYS = ["paths", "path"] as const;
const PINNED_LANE_KEYS = ["paths", "path", "lastProfile"] as const;

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const asArray = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/**
 * Pins `paths`/`path` (team and lane) and `lastProfile` (lane) to the values on disk. For a team or lane
 * that exists, the body may omit them or echo them back (raw, or as the redacted copy the remote GET showed),
 * and the forwarded body carries the disk value; any other value is refused. A new team or lane may not
 * set them (its lane then works in the team's existing folder, derived server-side).
 */
export function pinTeamsRegistry(
  body: Record<string, unknown>,
  current: unknown,
  redact: (s: string) => string = (s) => s,
): { ok: true; value: Record<string, unknown> } | { ok: false; status: 403 | 503; error: string } {
  const curTeams = asArray((current as any)?.teams) as RegTeam[];
  if (!current || typeof current !== "object" || !Array.isArray((current as any).teams)) {
    return { ok: false, status: 503, error: "could not read teams.json to check the write" };
  }
  const echoes = (sent: unknown, disk: unknown) => sameJson(sent, disk) || sameJson(sent, JSON.parse(redact(JSON.stringify(disk ?? null))));
  const pin = (obj: Record<string, unknown>, disk: Record<string, unknown> | undefined, keys: readonly string[], where: string): string | null => {
    for (const k of keys) {
      const has = Object.hasOwn(obj, k);
      if (!disk) {
        if (has) return `${where}.${k} can't be set remotely on a new entry`;
        continue;
      }
      if (has && !echoes(obj[k], disk[k])) return `${where}.${k} can't be changed remotely`;
      if (disk[k] === undefined) delete obj[k];
      else obj[k] = disk[k];
    }
    return null;
  };
  const teams = (body.teams as Record<string, unknown>[]).map((t) => ({ ...t }));
  for (const t of teams) {
    const diskTeam = curTeams.find((c) => c?.id === t.id) as Record<string, unknown> | undefined;
    const err = pin(t, diskTeam, PINNED_TEAM_KEYS, `team ${String(t.id)}`);
    if (err) return { ok: false, status: 403, error: err };
    if (!Array.isArray(t.lanes)) continue;
    t.lanes = (t.lanes as Record<string, unknown>[]).map((l) => ({ ...l }));
    const diskLanes = asArray(diskTeam?.lanes) as RegLane[];
    for (const l of t.lanes as Record<string, unknown>[]) {
      const diskLane = diskLanes.find((c) => c?.id === l.id) as Record<string, unknown> | undefined;
      const lerr = pin(l, diskLane, PINNED_LANE_KEYS, `lane ${String(l.id)}`);
      if (lerr) return { ok: false, status: 403, error: lerr };
    }
  }
  return { ok: true, value: { ...body, teams } };
}

/** The body's lane (laneId, else lane) must name a lane id or alias in teams.json; no lane given passes. */
export function checkLaneExists(
  body: Record<string, unknown>,
  current: unknown,
): { ok: true } | { ok: false; status: 403 | 503; error: string } {
  const want = typeof body.laneId === "string" && body.laneId ? body.laneId : typeof body.lane === "string" ? body.lane : "";
  if (!want) return { ok: true };
  if (!current || typeof current !== "object" || !Array.isArray((current as any).teams)) {
    return { ok: false, status: 503, error: "could not read teams.json to check the lane" };
  }
  const w = want.toLowerCase();
  for (const t of (current as any).teams as RegTeam[]) {
    for (const l of asArray(t?.lanes) as RegLane[]) {
      if (String(l?.id ?? "").toLowerCase() === w) return { ok: true };
      if (asArray(l?.aliases).some((a) => String(a).toLowerCase() === w)) return { ok: true };
    }
  }
  return { ok: false, status: 403, error: `lane ${want} is not in teams.json` };
}

/** Runs the policy's registry check. `current` is the parsed GET /api/teams body (null if unreadable). */
export function checkRemoteRegistry(
  pathname: string,
  body: Record<string, unknown>,
  current: unknown,
  redact?: (s: string) => string,
): { ok: true; value: Record<string, unknown> } | { ok: false; status: 403 | 503; error: string } {
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
  const allowed = Object.hasOwn(allow, norm.pathname) ? allow[norm.pathname] : undefined;
  if (!allowed) return { ok: false, code: "not-allowed", error: `not available remotely: ${norm.pathname}` };
  if (!allowed.includes(m as RemoteMethod)) {
    return { ok: false, code: "method", error: `${m} not available remotely on ${norm.pathname}` };
  }
  return { ok: true, method: m as RemoteMethod, pathname: norm.pathname, search: stripQuery(norm.pathname, norm.search) };
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

export type RateKind = "read" | "write";
export type RateLimiter = {
  acquire(kind: RateKind): { ok: true; release: () => void } | { ok: false; error: string };
};

/** At most `maxInFlight` concurrent requests, plus a rolling per-minute budget per kind (read/write). */
export function createRateLimiter(
  opts: { maxInFlight?: number; budget?: Record<RateKind, number>; windowMs?: number; now?: () => number } = {},
): RateLimiter {
  const maxInFlight = opts.maxInFlight ?? REMOTE_MAX_IN_FLIGHT;
  const budget = opts.budget ?? REMOTE_BUDGET_PER_MIN;
  const windowMs = opts.windowMs ?? REMOTE_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const stamps: Record<RateKind, number[]> = { read: [], write: [] };
  let inFlight = 0;
  return {
    acquire(kind) {
      const t = now();
      const list = stamps[kind];
      while (list.length && list[0] <= t - windowMs) list.shift();
      if (inFlight >= maxInFlight) return { ok: false, error: `too many requests in flight (max ${maxInFlight})` };
      if (list.length >= budget[kind]) {
        const wait = Math.max(1, Math.ceil((list[0] + windowMs - t) / 1000));
        return { ok: false, error: `rate limited: ${budget[kind]} ${kind}s per minute, retry in ${wait} s` };
      }
      list.push(t);
      inFlight++;
      let released = false;
      return {
        ok: true,
        release: () => {
          if (!released) inFlight--;
          released = true;
        },
      };
    },
  };
}

// ---- response redaction -----------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/** Drops `remote` (the proxy gate) from GET /__vibesquad/settings responses. */
export function scrubSettingsBody(pathname: string, body: string): string {
  if (pathname !== "/__vibesquad/settings") return body;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "remote" in parsed) {
      delete parsed.remote;
      return JSON.stringify(parsed);
    }
  } catch {}
  return body;
}
