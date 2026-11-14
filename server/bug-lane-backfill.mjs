import fs from "node:fs";
import path from "node:path";
import { freezeLaneCodes, isHubLane, seedStandingLane } from "./lane-pure.mjs";
import { resolveTeamsFilePath, teamsRevision, vibesquadHome, writeTeamsRegistryAsync } from "./teams-file.mjs";
import { readJsonFileWithBom } from "./user-settings.mjs";

// Template reconcile (G3): old Squads are diffed against what buildNewSquadTeamDef (src/newSquadDef.ts) makes today.
// Additive, no-user-value parts are added at server start; anything else is only logged as a `template-drift` metric.
// test/bug-lane-backfill.test.mjs keeps TEMPLATE_DEFAULTS in step with the TS template.

export const TEMPLATE_DEFAULTS = {
  color: "#00f0ff",
  brainstormWarnTokens: 80_000,
  brainstormRestartTokens: 150_000,
  leadFlagTokens: 150_000,
  leadAutoHandoffTokens: 250_000,
  leadHardCapTokens: 300_000,
};

export { seedStandingLane };
export const seedBugLane = (team, existingTeams = []) => seedStandingLane(team, "bug", existingTeams);

/** One Squad vs the template: `next` has the auto parts applied; `auto` / `logOnly` list rules ({ rule, detail? }). */
export function diffAgainstTemplate(team, allTeams = []) {
  const auto = [];
  let next = team;
  for (const kind of ["bug", "audit"]) {
    const seeded = seedStandingLane(next, kind, allTeams);
    if (seeded !== next) auto.push({ rule: `add-${kind}-lane`, detail: seeded.lanes.at(-1).id });
    next = seeded;
  }
  const fill = Object.entries(TEMPLATE_DEFAULTS).filter(([k]) => next[k] === undefined || next[k] === null);
  if (fill.length) {
    next = { ...next, ...Object.fromEntries(fill) };
    for (const [k, v] of fill) auto.push({ rule: `add-${k}`, detail: String(v) });
  }
  const frozen = freezeLaneCodes(next.lanes ?? []);
  if (frozen.some((l, i) => l !== next.lanes[i])) {
    auto.push({ rule: "freeze-lane-codes", detail: frozen.filter((l, i) => l !== next.lanes[i]).map((l) => l.id).join(",") });
    next = { ...next, lanes: frozen };
  }
  const logOnly = [];
  if (!(next.lanes ?? []).some((l) => isHubLane(next, l))) logOnly.push({ rule: "no-hub-lane" });
  if (!Array.isArray(next.paths) || !next.paths.length) logOnly.push({ rule: "no-paths" });
  return { next, auto, logOnly };
}

/** Reconciles every Squad. `teams` is returned as is when nothing changed. */
export function reconcileTemplate(teams) {
  const auto = [];
  const logOnly = [];
  let changed = false;
  const out = [];
  for (const t of teams) {
    const d = diffAgainstTemplate(t, [...out, ...teams.slice(out.length + 1)]);
    if (d.next !== t) changed = true;
    out.push(d.next);
    auto.push(...d.auto.map((a) => ({ team: t.id, ...a })));
    logOnly.push(...d.logOnly.map((a) => ({ team: t.id, ...a })));
  }
  return { teams: changed ? out : teams, auto, logOnly };
}

/** Adds the missing bug and audit lanes (and the other additive template parts) to every Squad. */
export const backfillBugLanes = (teams) => reconcileTemplate(teams).teams;

const SEEN_FILE = "template-drift-seen.json";

/** Team log + lane log line, the shape `vs log metric` writes. */
function logDriftMetric(team, text, home) {
  const lane = (team.lanes ?? []).find((l) => isHubLane(team, l))?.id ?? team.id;
  const line = JSON.stringify({ ts: new Date().toISOString(), agent: "template-drift", lane, type: "metric", text }) + "\n";
  fs.mkdirSync(path.join(home, "teams", team.id), { recursive: true });
  fs.appendFileSync(path.join(home, "teams", team.id, "log.jsonl"), line, "utf8");
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  fs.appendFileSync(path.join(home, "logs", `${team.id}--${lane}.jsonl`), line, "utf8");
}

/** At server start: persist the additive reconcile once, then log a `template-drift` metric per Squad for what is left (only when that Squad's drift changed since last logged). Never writes teams.example.json.
 * Async: it runs after listen(), so the teams.json lock wait must not block requests (idea-227). */
export async function persistTemplateReconcile(rootDir) {
  const file = resolveTeamsFilePath(rootDir);
  if (path.basename(file) === "teams.example.json") return { changed: false, auto: [], logOnly: [] };
  // Revision is taken with the read; writeTeamsRegistryAsync re-checks it under its lock and answers 409 if teams.json moved meanwhile, so a concurrent edit is never overwritten (retry on the fresh file).
  let r;
  let teams;
  let rec;
  let changed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = teamsRevision(file);
    r = readJsonFileWithBom(file, { label: "teams.json", fallback: null });
    teams = r.ok && r.data && Array.isArray(r.data.teams) ? r.data.teams : null;
    if (!teams) return { changed: false, auto: [], logOnly: [] };
    rec = reconcileTemplate(teams);
    changed = rec.teams !== teams;
    if (!changed) break;
    const w = await writeTeamsRegistryAsync({ ...r.data, teams: rec.teams, revision }, rootDir);
    if (w.status !== 409) break;
    changed = false;
    rec = { teams, auto: [], logOnly: [] };
  }
  const home = vibesquadHome();
  const seenFile = path.join(home, SEEN_FILE);
  const seen = readJsonFileWithBom(seenFile, { fallback: {} }).value ?? {};
  const seenNext = { ...seen };
  for (const t of rec.teams) {
    const rules = rec.logOnly.filter((d) => d.team === t.id).map((d) => d.rule).sort().join(",");
    if ((seen[t.id] ?? "") === rules) continue;
    seenNext[t.id] = rules;
    if (rules) {
      try { logDriftMetric(t, `template-drift: ${t.id} differs from the new-Squad template, not auto-fixed: ${rules}`, home); } catch {}
    }
  }
  if (JSON.stringify(seenNext) !== JSON.stringify(seen)) {
    try { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(seenFile, JSON.stringify(seenNext, null, 2) + "\n", "utf8"); } catch {}
  }
  return { changed, auto: rec.auto, logOnly: rec.logOnly };
}
