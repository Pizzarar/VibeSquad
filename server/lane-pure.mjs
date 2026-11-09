// Pure lane helpers (no fs / locks / node imports): shared by server/identity.mjs, server/bug-lane-backfill.mjs and the browser bundle (src/newSquadDef.ts).
// Keep it that way: server/file-lock.mjs and server/teams-file.mjs must never reach src/ (test/client-bundle-guard.test.mjs).
import { takenLaneIds, uniqueLaneId } from "./pin-ideas.mjs";

/** Mirror of isHubLane in src/teams.ts: explicit `hub: true`, else the lane whose id is the Squad id when no lane is flagged. */
export function isHubLane(team, lane) {
  if (lane?.hub === true) return true;
  return lane?.id != null && !(team?.lanes || []).some((l) => l.hub === true) && lane.id === team?.id;
}

/** Mirrors of laneKindOf / findBugLane / findAuditLane / isHiddenLane in src/teams.ts. */
export const BUG_LANE_FALLBACK_IDS = ["bug-runner", "bug-chaser"];
export const AUDIT_LANE_FALLBACK_IDS = ["perfection"];
export function laneKindOf(lane) {
  return lane?.kind === "bug" || lane?.kind === "audit" ? lane.kind : lane?.bug === true ? "bug" : undefined;
}
function findKindLane(team, kind, fallback) {
  const lanes = team?.lanes || [];
  return lanes.find((l) => laneKindOf(l) === kind) ?? lanes.find((l) => laneKindOf(l) === undefined && fallback.includes(l?.id)) ?? null;
}
export const findBugLane = (team) => findKindLane(team, "bug", BUG_LANE_FALLBACK_IDS);
export const findAuditLane = (team) => findKindLane(team, "audit", AUDIT_LANE_FALLBACK_IDS);
export function isHiddenLane(team, lane) {
  if (typeof lane?.hidden === "boolean") return lane.hidden;
  if (isHubLane(team, lane)) return false;
  return findBugLane(team)?.id === lane?.id || findAuditLane(team)?.id === lane?.id;
}

// ---- Lane codes (docs/PLAN_LANE_CODES.md) ----
// Reserved codes for lanes whose generic code would be unhelpful (the hub lane).
const RESERVED_LANE_CODES = { vibesquad: "Hub" };

const codeCase = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** A stored `code` if it is 2-5 alphanumerics (all-caps kept, e.g. ADE; else Capitalised), else "". */
export function cleanLaneCode(raw) {
  const s = String(raw ?? "").trim();
  if (!/^[A-Za-z0-9]{2,5}$/.test(s)) return "";
  return s === s.toUpperCase() ? s : codeCase(s);
}

/**
 * Candidate codes for a lane, best first. Rule: an all-caps acronym (2-5 letters) among the first three words of the
 * name wins ("Basic ADE (...)" -> Ade, "UI Lab" -> Ui); otherwise the first word's first 3 letters ("Bug Chaser" -> Bug,
 * "Token Checker" -> Tok). Collisions fall back to 4-5 letters of the first word, then first word + next initials.
 */
export function laneCodeCandidates(lane) {
  const id = String(lane?.id ?? "");
  const name = String(lane?.name ?? "").trim() || id;
  const reserved = RESERVED_LANE_CODES[id.toLowerCase()] ?? RESERVED_LANE_CODES[name.toLowerCase()];
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out = [];
  const add = (c) => {
    const k = cleanLaneCode(c);
    if (k && !out.includes(k)) out.push(k);
  };
  if (reserved) add(reserved);
  const acronym = words.slice(0, 3).find((w) => /^[A-Z]{2,5}$/.test(w));
  if (acronym) add(acronym);
  const first = (words[0] ?? id).replace(/[^A-Za-z0-9]/g, "");
  for (const n of [3, 4, 5]) add(first.slice(0, n));
  for (let i = 1; i < words.length && i < 4; i++) add(first.slice(0, 3) + words[i].charAt(0));
  add(first.slice(0, 2) + (words[1] ?? "x").charAt(0));
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") add(first.slice(0, 3) + ch);
  return out;
}

/**
 * Codes for every lane of one Squad, keyed by lane id. Stored codes win; the rest are generated in registry order,
 * the first free candidate each, so the result is stable for a given registry and unique within the Squad.
 */
export function laneCodesForTeam(team) {
  const out = {};
  const used = new Set();
  const lanes = team?.lanes ?? [];
  for (const lane of lanes) {
    const c = cleanLaneCode(lane.code);
    if (c && !used.has(c.toLowerCase())) {
      out[lane.id] = c;
      used.add(c.toLowerCase());
    }
  }
  for (const lane of lanes) {
    if (out[lane.id]) continue;
    const c = laneCodeCandidates(lane).find((k) => !used.has(k.toLowerCase())) ?? codeCase(String(lane.id).slice(0, 5));
    out[lane.id] = c;
    used.add(c.toLowerCase());
  }
  return out;
}

/**
 * Freeze: the Squad's lanes with a `code` on every one (stored codes kept, missing ones generated). Persist this whenever
 * a lane is written so a later stored code can never displace an existing lane's generated code.
 */
export function freezeLaneCodes(lanes) {
  const codes = laneCodesForTeam({ lanes });
  return lanes.map((l) => (cleanLaneCode(l.code) === codes[l.id] ? l : { ...l, code: codes[l.id] }));
}

const STANDING = {
  bug: { id: "bug-runner", name: "Bug Runner", find: findBugLane },
  audit: { id: "perfection", name: "Perfection", find: findAuditLane },
};

/** The Squad with its standing, hidden lane of `kind` ("bug" Bug Runner / "audit" Perfection). Idempotent: a lane it already has (flagged or by fallback id) is kept. Lane ids are unique across Squads (`bug-runner-2`, ...). */
export function seedStandingLane(team, kind, existingTeams = []) {
  const spec = STANDING[kind];
  if (spec.find(team)) return team;
  const others = existingTeams.filter((t) => t.id !== team.id);
  const taken = takenLaneIds([...others, team].flatMap((t) => t.lanes ?? []));
  const lane = { id: uniqueLaneId(spec.id, taken), name: spec.name, kind, hidden: true, standing: true, state: "pinned" };
  return { ...team, lanes: freezeLaneCodes([...(team.lanes ?? []), lane]) };
}
