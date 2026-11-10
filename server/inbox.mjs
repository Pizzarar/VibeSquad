import { existsSync, mkdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import os from "node:os";
import { join, resolve } from "node:path";
import { createAgentClient } from "./brainstorm.mjs";
import { getBackend } from "./backend/index.mjs";
import { AUDIT_LANE_FALLBACK_IDS, BUG_LANE_FALLBACK_IDS, findLaneInRegistry, resolveLeadWinner, whoCandidate } from "./identity.mjs";
import { isHubLane } from "./lane-pure.mjs";
import { defangPromptFences } from "./write-guards.mjs";
import { clearConfigWarning, readJsonFileWithBom } from "./user-settings.mjs";
import { resolveTeamsFilePath as resolveSharedTeamsFilePath } from "./teams-file.mjs";
import { updateJsonFileSync } from "./file-lock.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");

export const INBOX_SCOPES = ["art", "mechanic", "plugin", "UI", "infra", "docs", "other"];
export const INBOX_LANES = ["main-game", "ui-lab", "plugins", "vibesquad", "site-polish"];
/** Valid card lifecycle statuses (a card may also be "accepted" or "rejected" by a triager). */
export const INBOX_STATUSES = ["parked", "handed-off", "archived", "accepted", "rejected"];

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could",
  "do", "does", "for", "from", "get", "got", "had", "has", "have", "how",
  "i", "if", "in", "into", "is", "it", "its", "just", "let", "lets", "like",
  "make", "may", "maybe", "more", "most", "my", "need", "needs", "new", "no",
  "not", "now", "of", "on", "one", "only", "or", "other", "our", "out", "over",
  "should", "so", "some", "such", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "to", "too", "up", "us", "use",
  "using", "very", "want", "was", "we", "were", "what", "when", "where",
  "which", "while", "who", "will", "with", "would", "you", "your",
  "add", "adding", "added", "build", "building", "create", "creating",
  "implement", "implementing", "support", "supporting", "update", "updating",
  "idea", "card", "lane", "team", "feature", "fix", "change", "allow",
]);

const FILLER_PREFIX_RE = /^(?:[-*•+]\s+|\d+[.)]\s+|(?:we\s+should|maybe\s+we\s+can|maybe|let'?s|i\s+want\s+to|please|can\s+we|could\s+we|idea\s*:|todo\s*:|note\s*:)\s+)+/i;

export function getInboxPath(baseHome) {
  const home = baseHome || process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
  return join(home, "inbox.json");
}

function resolveTeamsFilePath(rootDir = REPO_ROOT) {
  return resolveSharedTeamsFilePath(rootDir);
}

export function loadTeamsForInbox(rootDir = REPO_ROOT) {
  const file = resolveTeamsFilePath(rootDir);
  const res = readJsonFileWithBom(file, { label: "teams.json", fallback: null, recordWarning: true });
  return Array.isArray(res.data?.teams) ? res.data.teams : [];
}

export function readInboxCards(baseHome) {
  const file = getInboxPath(baseHome);
  if (!existsSync(file)) return [];
  const res = readJsonFileWithBom(file, { label: "~/.vibesquad/inbox.json", fallback: null, recordWarning: true });
  const parsed = res.data;
  return Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cards) ? parsed.cards : [];
}

/**
 * Locked read-modify-write of ~/.vibesquad/inbox.json. `mutate(cards)` receives the current card array and either
 * mutates it in place (return undefined) or returns the replacement array. A missing file yields []. Every inbox
 * write in the server and the CLI funnels through this so a concurrent add/triage can never lose cards or mint a
 * duplicate idea-N id.
 */
function updateInboxCardsSync(baseHome, mutate, opts = {}) {
  const file = getInboxPath(baseHome);
  return updateJsonFileSync(
    file,
    (data) => {
      const cards = Array.isArray(data) ? data : Array.isArray(data?.cards) ? data.cards : [];
      const out = mutate(cards);
      return out === undefined ? cards : out;
    },
    { fallback: [], ...opts },
  );
}

export function writeInboxCards(cards, baseHome) {
  const file = getInboxPath(baseHome);
  updateJsonFileSync(file, () => cards, { fallback: [] });
  clearConfigWarning(file);
  return cards;
}

function normalizeWord(word) {
  let w = String(word || "").toLowerCase().replace(/[^a-z0-9_.-]/g, "");
  if (w.length <= 2) return w;
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("es") && w.length > 4 && (w.endsWith("ches") || w.endsWith("shes") || w.endsWith("xes") || w.endsWith("ses"))) {
    return w.slice(0, -2);
  }
  if (w.endsWith("s") && !w.endsWith("ss") && w !== "tls" && w !== "css" && w !== "docs") {
    return w.slice(0, -1);
  }
  return w;
}

export function extractSignificantTokens(text) {
  const rawWords = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const raw of rawWords) {
    if (STOPWORDS.has(raw)) continue;
    const norm = normalizeWord(raw);
    if (!norm || norm.length < 2 || STOPWORDS.has(norm)) continue;
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

/**
 * Token-overlap between two texts (the same signal sortIdeaCard uses for "goes with card X"): the count of shared
 * significant tokens plus Jaccard similarity. Both empty/one empty -> `{ shared: 0, jaccard: 0 }`.
 */
export function significantTokenOverlap(textA, textB) {
  const a = extractSignificantTokens(textA);
  const b = extractSignificantTokens(textB);
  if (!a.length || !b.length) return { shared: 0, jaccard: 0 };
  const aSet = new Set(a);
  const shared = b.filter((t) => aSet.has(t)).length;
  const unionSize = new Set([...a, ...b]).size;
  return { shared, jaccard: unionSize > 0 ? shared / unionSize : 0 };
}

export function buildConciseTitle(rawText) {
  const cleaned = String(rawText || "")
    .trim()
    .replace(/\r?\n+/g, " ")
    .replace(FILLER_PREFIX_RE, "")
    .trim();
  if (!cleaned) return "Untitled idea";

  const firstClause = cleaned.split(/(?:[.!?;](?:\s+|$)|\s+—\s+|\s+--\s+)/)[0].trim() || cleaned;
  const words = firstClause.split(/\s+/).filter(Boolean);
  let slice = words.slice(0, 7);
  if (slice.length > 5) {
    while (slice.length > 4 && STOPWORDS.has(slice[slice.length - 1].toLowerCase().replace(/[^a-z]/g, ""))) {
      slice.pop();
    }
  }
  let title = slice.join(" ").replace(/[,:;.-]+$/, "").trim();
  if (!title) title = words.slice(0, 5).join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function countPhraseHits(lower, phrases) {
  let score = 0;
  for (const [phrase, weight] of phrases) {
    if (phrase instanceof RegExp) {
      if (phrase.test(lower)) score += weight;
    } else if (lower.includes(phrase)) {
      score += weight;
    }
  }
  return score;
}

export function teamIdForLane(laneId, rawText = "", teams = []) {
  const lane = String(laneId || "").toLowerCase();
  const lower = String(rawText || "").toLowerCase();
  for (const team of teams) {
    if ((team.lanes || []).some((l) => String(l.id).toLowerCase() === lane)) {
      if (lane === "plugins" && /\b(vibesquad|index\.server\.ts|role-pack|role pack|vs\.mjs|vs log|brainstorm|handoff)\b/i.test(lower)) {
        continue;
      }
      return String(team.id);
    }
  }
  if (lane === "vibesquad") return "vibesquad";
  return teams[0]?.id ? String(teams[0].id) : "default";
}

export function sortIdeaCard(rawText, existingCards = [], teams = []) {
  const text = String(rawText ?? "").trim();
  const lower = text.toLowerCase();

  // 1. Detect laneId & teamId
  const laneScores = {
    "main-game": countPhraseHits(lower, [
      [/\bmain-game\b/, 6],
      [/\bmain game\b/, 6],
      [/\b escape from idle\b|\befi\b/, 3],
      [/\bgameplay\b/, 3],
      [/\bcombat\b/, 3],
      [/\bloot\b/, 3],
      [/\bidle progression\b/, 4],
      [/\bidle\b/, 2],
      [/\bprogression\b/, 2],
      [/\benemies\b|\benemy\b/, 3],
      [/\bwaves?\b/, 3],
      [/\bstats?\b/, 2],
      [/\bbalance\b/, 3],
      [/\bdamage\b/, 2],
      [/\bcrafting\b/, 3],
      [/\beconomy\b/, 3],
      [/\btick\b/, 2],
      [/\bboss(?:es)?\b/, 2],
      [/\bdungeon\b|\braid\b|\bdrops?\b|\bxp\b/, 2],
    ]),
    "ui-lab": countPhraseHits(lower, [
      [/\bui-lab\b|\bui lab\b|\builab\b/, 6],
      [/\bhud\b/, 4],
      [/\binventory screen\b/, 5],
      [/\binventory\b/, 3],
      [/\bshader\b/, 4],
      [/\bbutton prototype\b/, 5],
      [/\blayout block\b/, 5],
      [/\banimation\b/, 3],
      [/\bprototype\b/, 2],
      [/\btooltip\b|\bminimap\b|\bhealth bar\b|\bhotbar\b/, 3],
      [/\bsprite\b|\bpalette\b|\bportrait\b/, 2],
    ]),
    plugins: countPhraseHits(lower, [
      [/\bplugins?\b/, 4],
      [/\bpaseo plugin\b/, 5],
      [/\bdaemon hook\b/, 5],
      [/\bdaemon\b/, 3],
      [/\bhook\b/, 3],
      [/\bmcp\b/, 4],
      [/index\.server\.ts/, 5],
      [/\brole-pack\b|\brole pack\b/, 5],
      [/\bturn_ended\b|\bagent\.create\b|\bagent\.created\b/, 4],
      [/\bpre-check\b|\bdigest\b/, 3],
    ]),
    "site-polish": countPhraseHits(lower, [
      [/\bsite-polish\b|\bsite polish\b/, 6],
      [/\bwebsite\b/, 4],
      [/\blanding page\b/, 5],
      [/\bshowcase\b/, 4],
      [/\bshorts\b/, 4],
      [/\bjourney page\b/, 5],

      [/\bhero section\b|\bportfolio\b|\bseo\b/, 3],
    ]),
    vibesquad: countPhraseHits(lower, [
      [/\bvibesquad\b/, 3],
      [/\broster\b/, 4],
      [/\btabs?\b/, 3],
      [/\bpanes?\b/, 3],
      [/\bfocus rail\b/, 5],
      [/\bbrainstorm\b/, 3],
      [/\binbox\b/, 4],
      [/\bpush notifications?\b/, 5],
      [/\bmeshnet\b/, 5],
      [/\bagentdrawer\b|\bteamfeed\b|\bstandup feed\b/, 4],
      [/\bsidebar\b|\bworktree\b/, 2],
    ]),
  };

  let bestLane = "vibesquad";
  let bestLaneScore = 0;
  for (const [lane, score] of Object.entries(laneScores)) {
    if (score > bestLaneScore) {
      bestLaneScore = score;
      bestLane = lane;
    }
  }

  const laneId = bestLane;
  const teamId = teamIdForLane(laneId, text, teams);

  // 2. Detect scope: "art" | "mechanic" | "plugin" | "UI" | "infra" | "docs" | "other"
  const scopeScores = {
    art: countPhraseHits(lower, [
      [/\bsprites?\b/, 3],
      [/\bpalette\b/, 3],
      [/\bportraits?\b/, 3],
      [/\bshaders?\b/, 3],
      [/\bneon\b/, 3],
      [/\bicons?\b/, 3],
      [/\bvisuals?\b/, 3],
      [/\bpixel\b|\bglow\b|\bvfx\b|\bparticles?\b|\billustration\b/, 2],
      [/\banimation\b/, 1],
    ]),
    mechanic: countPhraseHits(lower, [
      [/\bdamage\b/, 3],
      [/\bticks?\b/, 3],
      [/\bloops?\b/, 3],
      [/\beconomy\b/, 3],
      [/\bcrafting\b/, 3],
      [/\bwaves?\b/, 3],
      [/\bprogression\b/, 3],
      [/\bmechanics?\b/, 3],
      [/\bcombat\b|\bloot\b|\benemies\b|\benemy\b|\bbalance\b|\bstats?\b|\bgameplay\b|\bboss(?:es)?\b|\bbuffs?\b|\bdebuffs?\b|\bidle\b/, 2],
    ]),
    plugin: countPhraseHits(lower, [
      [/\bdaemon\b/, 3],
      [/\bhooks?\b/, 3],
      [/\bmcp\b/, 3],
      [/\bplugins?\b/, 3],
      [/\bretire\b|\bauto-retire\b/, 3],
      [/index\.server\.ts|\brole-pack\b|\brole pack\b|\bturn_ended\b|\bagent\.create\b/, 3],
    ]),
    UI: countPhraseHits(lower, [
      [/\bmodals?\b/, 3],
      [/\btabs?\b/, 3],
      [/\bsidebar\b/, 3],
      [/\bbuttons?\b/, 3],
      [/\blayout\b/, 3],
      [/\bdrawer\b/, 3],
      [/\bcss\b/, 3],
      [/\bui\b|\bhud\b|\binventory screen\b|\bscreen\b|\bpanes?\b|\bfocus rail\b|\bcards?\b|\bpanel\b|\bbadges?\b|\bbanner\b|\bpopover\b|\bdropdown\b|\btoolbar\b/, 2],
    ]),
    infra: countPhraseHits(lower, [
      [/\bserver\b/, 3],
      [/\btls\b/, 3],
      [/\bca\b/, 3],
      [/\bpush\b/, 3],
      [/\bbuild\b/, 3],
      [/\bworktrees?\b/, 3],
      [/\bcli\b/, 3],
      [/\binfra\b|\bmeshnet\b|\bvite\b|\bproxy\b|\bwebsocket\b|\bdeploy\b|\bport\b/, 2],
    ]),
    docs: countPhraseHits(lower, [
      [/\bplan\b/, 3],
      [/\breadme\b/, 3],
      [/\bdocs?\b|\bdocumentation\b/, 3],
      [/\bguide\b|\bchangelog\b|\bspec\b/, 2],
    ]),
  };

  let bestScope = "other";
  let bestScopeScore = 0;
  for (const [sc, score] of Object.entries(scopeScores)) {
    if (score > bestScopeScore) {
      bestScopeScore = score;
      bestScope = sc;
    }
  }
  if (bestScope === "other" && bestLaneScore > 0) {
    if (laneId === "main-game") bestScope = "mechanic";
    else if (laneId === "ui-lab") bestScope = "UI";
    else if (laneId === "plugins") bestScope = "plugin";
    else if (laneId === "site-polish" || laneId === "vibesquad") bestScope = "UI";
  }

  // 3. Detect "goes with card X" (relatedCardId) against open parked cards
  let relatedCardId = null;
  let relatedReason = null;
  let bestSim = 0;

  const parkedCards = (Array.isArray(existingCards) ? existingCards : []).filter(
    (c) => c && (!c.status || c.status === "parked"),
  );

  for (const card of parkedCards) {
    const { shared, jaccard } = significantTokenOverlap(text, `${card.title || ""} ${card.text || ""}`);
    if (!shared) continue;
    const sameLane = card.laneId === laneId;
    const sameScope = card.scope === bestScope;

    // Strong similarity when >=2 significant domain words overlap, or >=1 significant word + same lane & scope
    const score =
      jaccard +
      shared * 0.18 +
      (sameLane ? 0.2 : 0) +
      (sameScope ? 0.12 : 0);

    const qualifies =
      shared >= 2 ||
      (shared >= 1 && sameLane && (sameScope || jaccard >= 0.15));

    if (qualifies && score > bestSim) {
      bestSim = score;
      relatedCardId = card.id;
      relatedReason = `goes with card ${card.id} (${card.title})`;
    }
  }

  return {
    title: buildConciseTitle(text),
    teamId,
    laneId,
    scope: bestScope,
    relatedCardId,
    relatedReason,
    matchedDomain: bestLaneScore > 0,
  };
}

export function splitIdeaDump(input, splitDump = false) {
  if (Array.isArray(input)) {
    const out = [];
    for (const item of input) {
      if (typeof item !== "string") continue;
      if (splitDump && /\r?\n/.test(item)) {
        out.push(...splitIdeaDump(item, true));
      } else {
        const cleaned = item.trim().replace(/^[-*•+]\s+|\d+[.)]\s+/, "").trim();
        if (cleaned) out.push(cleaned);
      }
    }
    return out;
  }
  const raw = String(input ?? "").trim();
  if (!raw) return [];
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*•+]\s+|\d+[.)]\s+/, "").trim())
    .filter(Boolean);
  if (splitDump || lines.length > 1) return lines;
  return [lines[0]];
}

function nextCardId(existingCards) {
  let maxNum = 0;
  for (const c of existingCards) {
    const m = /^idea-(\d+)$/i.exec(String(c?.id || ""));
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > maxNum) maxNum = n;
    }
  }
  return `idea-${maxNum + 1}`;
}

export function matchesTeamFilter(card, teamFilter, teams = []) {
  if (!teamFilter || teamFilter === "all") return true;
  const tf = String(teamFilter).toLowerCase();
  const ct = String(card.teamId || "").toLowerCase();
  const cl = String(card.laneId || "").toLowerCase();
  if (ct === tf || cl === tf) return true;
  if (tf === "plugins" && cl === "plugins") return true;
  const teamDef = teams.find((t) => String(t.id).toLowerCase() === tf || String(t.name).toLowerCase() === tf);
  if (teamDef && (teamDef.lanes || []).some((l) => String(l.id).toLowerCase() === cl)) {
    return true;
  }
  return false;
}

export function listInboxCards(filter = {}, rootDir = REPO_ROOT) {
  const cards = readInboxCards(filter.baseHome);
  const teams = loadTeamsForInbox(rootDir);
  const teamId = filter.teamId || filter.team || "";
  const laneId = filter.laneId || filter.lane || "";
  const status = filter.status || "";

  return cards.filter((c) => {
    if (status === "open") {
      if (c.status && c.status !== "parked" && c.status !== "accepted") return false;
    } else if (status && status !== "all" && c.status !== status) return false;
    if (laneId && laneId !== "all" && String(c.laneId).toLowerCase() !== String(laneId).toLowerCase()) return false;
    if (teamId && teamId !== "all" && !matchesTeamFilter(c, teamId, teams)) return false;
    return true;
  });
}

/**
 * A card parked on a lane nobody has (a typo'd `--lane`, a bad bounce) is invisible: no column, no Buddy, and Send fails
 * later. Refuse it at the door so the sender sees the error. Returns the CANONICAL lane id (an alias or @code like "bug"
 * resolves to its lane.id), which is what gets stored. Legacy INBOX_LANES, `_unassigned` and the standing bug/audit
 * fallback lanes (lane-pure.mjs: the server resolves those without a registry entry) stay valid as typed; with no
 * registry loaded there is nothing to check against.
 */
function assertKnownLane(laneId, teams) {
  const raw = String(laneId ?? "").trim().replace(/^@+/, "");
  if (!raw) return "";
  const hit = findLaneInRegistry(raw, teams);
  if (hit) return String(hit.lane.id);
  const lower = raw.toLowerCase();
  if (lower === "_unassigned" || !teams.length) return raw;
  if (INBOX_LANES.includes(raw)) return raw;
  if ([...BUG_LANE_FALLBACK_IDS, ...AUDIT_LANE_FALLBACK_IDS].includes(lower)) return lower;
  throw new Error(`unknown lane "${raw}": not in the teams registry (cards on an unknown lane never reach a Buddy)`);
}

export function addInboxCards(body = {}, rootDir = REPO_ROOT) {
  const baseHome = body.baseHome;
  const teams = loadTeamsForInbox(rootDir);

  const rawIdeas =
    Array.isArray(body.ideas) && body.ideas.length > 0
      ? splitIdeaDump(body.ideas, Boolean(body.splitDump))
      : splitIdeaDump(body.text ?? "", Boolean(body.splitDump));

  if (!rawIdeas.length) {
    throw new Error("No idea text provided");
  }

  const explicitLaneRaw = typeof body.laneId === "string" && body.laneId.trim() ? body.laneId.trim() : "";
  const defaultLane = typeof body.defaultLaneId === "string" && body.defaultLaneId.trim() ? body.defaultLaneId.trim() : "";
  const explicitTeam = typeof body.teamId === "string" && body.teamId.trim() ? body.teamId.trim() : "";
  const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "ui";
  const explicitLane = explicitLaneRaw ? assertKnownLane(explicitLaneRaw, teams) : "";

  let added = [];
  const cards = updateInboxCardsSync(baseHome, (working) => {
    added = [];
    const now = new Date().toISOString();

    for (const ideaText of rawIdeas) {
      const sorted = sortIdeaCard(ideaText, working, teams);
      const finalLane = explicitLane || (sorted.matchedDomain ? sorted.laneId : defaultLane || sorted.laneId);
      const finalTeam = explicitLane
        ? explicitTeam || teamIdForLane(finalLane, ideaText, teams)
        : sorted.matchedDomain
          ? sorted.teamId
          : explicitTeam || teamIdForLane(finalLane, ideaText, teams);

      const card = {
        id: nextCardId(working),
        text: ideaText,
        title: sorted.title,
        teamId: finalTeam,
        laneId: finalLane,
        scope: sorted.scope,
        relatedCardId: sorted.relatedCardId ?? null,
        relatedReason: sorted.relatedReason ?? null,
        mergedFromIds: [],
        status: "parked",
        topicAgentId: null,
        summaryNote: null,
        source,
        createdAt: now,
        updatedAt: now,
      };
      working.push(card);
      added.push(card);
    }

    return working;
  });

  const summary = `parked ${added.length} ideas → Inbox`;
  return {
    ok: true,
    added,
    cards,
    summary,
  };
}

function toBulletLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*•]\s+/, "").trim())
    .filter(Boolean);
}

/**
 * Who may archive/park inbox cards. The owner (no agent id: a human shell) always may; an agent may only if
 * it is a lead or Buddy of the card's Squad (any lane: triage routes cards between lanes). Workers and
 * other Squads get a clear error instead of the HTTP gate's bare 403. Returns normally when allowed.
 */
export function assertInboxTriageCaller(caller = {}, cardIds = [], baseHome) {
  const agentId = String(caller.agentId || "").trim();
  if (!agentId) return;
  const role = String(caller.role || "worker");
  if (role !== "lead" && role !== "brainstorm") {
    throw new Error(`inbox archive/park is for leads and Buddies of the card's Squad; ${agentId} is a ${role}. Put it in your final message for your lead to run.`);
  }
  const cards = readInboxCards(baseHome);
  for (const id of cardIds) {
    const card = cards.find((c) => c.id === id);
    if (!card) throw new Error(`Card not found: ${id}`);
    if ((card.teamId || "") !== (caller.teamId || "")) {
      throw new Error(`card ${id} belongs to Squad "${card.teamId}", not "${caller.teamId}": only that Squad's leads/Buddies (or the owner) may archive or park it`);
    }
  }
}

export function triageInboxCards(body = {}, rootDir = REPO_ROOT) {
  const baseHome = body.baseHome;
  const teams = loadTeamsForInbox(rootDir);
  const action = String(body.action || "").trim();

  let result = null;
  const cards = updateInboxCardsSync(baseHome, (cards) => {
    const now = new Date().toISOString();

    if (action === "merge") {
      const targetId = String(body.targetId || "").trim();
      const sourceIds = (Array.isArray(body.sourceIds) ? body.sourceIds : [body.sourceId].filter(Boolean))
        .map((s) => String(s).trim())
        .filter((s) => s && s !== targetId);
      if (!targetId || !sourceIds.length) {
        throw new Error("merge requires targetId and sourceIds[]");
      }
      const target = cards.find((c) => c.id === targetId);
      if (!target) throw new Error(`Target card not found: ${targetId}`);
      const sources = sourceIds.map((id) => cards.find((c) => c.id === id)).filter(Boolean);
      if (!sources.length) throw new Error(`Source card(s) not found: ${sourceIds.join(", ")}`);

      const bullets = [...toBulletLines(target.text)];
      const mergedFrom = new Set([...(Array.isArray(target.mergedFromIds) ? target.mergedFromIds : [])]);
      for (const src of sources) {
        for (const line of toBulletLines(src.text)) {
          if (!bullets.includes(line)) bullets.push(line);
        }
        mergedFrom.add(src.id);
        for (const prevId of Array.isArray(src.mergedFromIds) ? src.mergedFromIds : []) {
          mergedFrom.add(prevId);
        }
      }

      target.text = bullets.map((b) => `- ${b}`).join("\n");
      // Screenshots follow the merge: move each source's files into the target's media dir and re-link them.
      for (const src of sources) {
        for (const att of Array.isArray(src.attachments) ? src.attachments : []) {
          const moved = moveInboxMedia(att, targetId, baseHome);
          if (!moved) continue;
          target.attachments = [...(Array.isArray(target.attachments) ? target.attachments : []), moved];
          target.text = target.text.includes(att.path) ? target.text.split(att.path).join(moved.path) : `${target.text}\n- Screenshot: ${moved.path}`;
        }
        delete src.attachments;
        removeInboxMedia(src.id, baseHome);
      }
      target.mergedFromIds = [...mergedFrom];
      if (sourceIds.includes(target.relatedCardId)) {
        target.relatedCardId = null;
        target.relatedReason = null;
      }
      target.updatedAt = now;

      const sourceSet = new Set(sourceIds);
      // Sources are archived, not deleted: a merge is recoverable.
      for (const c of cards) {
        if (sourceSet.has(c.id)) {
          c.status = "archived";
          c.updatedAt = now;
        }
      }
      const remaining = cards;
      for (const c of remaining) {
        if (!sourceSet.has(c.id) && c.relatedCardId && sourceSet.has(c.relatedCardId) && c.id !== target.id) {
          c.relatedCardId = target.id;
          c.relatedReason = `goes with card ${target.id} (${target.title})`;
        }
      }

      result = { action: "merge", card: target, mergedIds: sourceIds };
      return remaining;
    }

    if (action === "bounce") {
      const cardId = String(body.cardId || "").trim();
      const laneRaw = String(body.laneId || body.lane || "").trim();
      if (!cardId || !laneRaw) throw new Error("bounce requires cardId and laneId");
      const laneId = assertKnownLane(laneRaw, teams);
      const card = cards.find((c) => c.id === cardId);
      if (!card) throw new Error(`Card not found: ${cardId}`);

      // A real move re-opens delivery: Send must reach the new lane (e.g. Overlord bounce after a "route this").
      if (card.laneId !== laneId) {
        delete card.deliveredTo;
        delete card.deliveredLane;
        delete card.deliveredToTitle;
        delete card.deliveredAt;
      }
      card.laneId = laneId;
      card.teamId = body.teamId ? String(body.teamId).trim() : teamIdForLane(laneId, card.text, teams);
      if (body.scope && INBOX_SCOPES.includes(body.scope)) {
        card.scope = body.scope;
      }
      card.updatedAt = now;

      result = { action: "bounce", card };
      return cards;
    }

    if (action === "update") {
      const cardId = String(body.cardId || "").trim();
      const patch = body.patch && typeof body.patch === "object" ? body.patch : {};
      if (!cardId) throw new Error("update requires cardId");
      const card = cards.find((c) => c.id === cardId);
      if (!card) throw new Error(`Card not found: ${cardId}`);

      // Status is a closed lifecycle set; reject unknown values (e.g. a typo'd "accept") before mutating.
      if (patch.status !== undefined && patch.status !== null && !INBOX_STATUSES.includes(patch.status)) {
        throw new Error(`Unknown inbox status "${patch.status}"`);
      }

      // Same door as add/bounce: a lane patch must exist and is stored canonical; a real move re-opens delivery.
      if (patch.laneId !== undefined && patch.laneId !== null && String(patch.laneId).trim()) {
        const canon = assertKnownLane(patch.laneId, teams);
        if (card.laneId !== canon) {
          delete card.deliveredTo;
          delete card.deliveredLane;
          delete card.deliveredToTitle;
          delete card.deliveredAt;
        }
        patch.laneId = canon;
      }

      const allowed = [
        "status",
        "title",
        "text",
        "scope",
        "summaryNote",
        "handedOffAt",
        "laneId",
        "teamId",
        "relatedCardId",
        "relatedReason",
      ];
      for (const key of allowed) {
        if (key in patch && patch[key] !== undefined) {
          card[key] = patch[key];
        }
      }
      card.updatedAt = now;
      if (card.status === "archived") removeInboxMedia(cardId, baseHome);

      result = { action: "update", card };
      return cards;
    }

    if (action === "delete" || action === "archive") {
      const cardId = String(body.cardId || "").trim();
      if (!cardId) throw new Error(`${action} requires cardId`);
      const idx = cards.findIndex((c) => c.id === cardId);
      if (idx < 0) throw new Error(`Card not found: ${cardId}`);
      if (action === "archive" || body.archive === true) {
        cards[idx].status = "archived";
        cards[idx].updatedAt = now;
        removeInboxMedia(cardId, baseHome);
        result = { action, card: cards[idx] };
        return cards;
      }
      const [removed] = cards.splice(idx, 1);
      removeInboxMedia(cardId, baseHome);
      result = { action: "delete", card: removed };
      return cards;
    }

    throw new Error(`Unknown triage action "${action}"`);
  });

  return { ok: true, ...result, cards };
}

/** Cards being delivered right now: a double-click while the first send is in flight must not send twice. */
const delivering = new Set();

const UNASSIGNED_LANE = "_unassigned";

/**
 * The live agent `vs who <role> --lane <lane>` resolves: the same whoCandidate filter (cwd, lane alias/code, team) and
 * resolveLeadWinner tie-break. A lane's Buddy front door is the one without a topic; topic Buddies are side threads.
 */
function pickLiveAgent(agents, { role, teamId, laneId, teams }) {
  const matches = agents
    .map((item) => item?.agent ?? item)
    .filter((a) => a && whoCandidate(a, { teams, wantTeamId: teamId, wantLane: laneId })?.role === role);
  const topicOf = (a) => String(a.labels?.topic ?? a.labels?.["vs.inbox-card-id"] ?? "").trim();
  const main = role === "brainstorm" ? matches.filter((a) => !topicOf(a)) : matches;
  return resolveLeadWinner(main.length ? main : matches).winner;
}

function buildDeliveryText(card, { toOverlord }) {
  const merged = Array.isArray(card.mergedFromIds) && card.mergedFromIds.length ? card.mergedFromIds.map((id) => `#${id}`).join(", ") : "";
  return [
    toOverlord
      ? `Route this: inbox card #${card.id} has no lane. Bounce it to the right lane with \`vs inbox triage --bounce ${card.id} --lane <lane>\`, send it to that lane's Buddy, and \`vs log decision\` where it went.`
      : `Inbox card #${card.id} for @${card.laneId}: ${card.title}`,
    ...(toOverlord ? [`Title: ${card.title}`] : []),
    `Scope: ${card.scope || "other"}${merged ? ` · merged from ${merged}` : ""}`,
    "",
    defangPromptFences(String(card.text || "").trim()),
  ].join("\n");
}

/**
 * Send = deliver. Hands a card (merged sources are already folded into its text) to its lane's live Buddy,
 * falling back to the lane lead; a card with no lane (or `_unassigned`) goes to the Squad's live Overlord to
 * route. Reuses the runner send path; never creates an agent. Idempotent: a delivered card is not re-sent.
 * body: { cardId, baseHome, agentClient? }.
 */
export async function sendInboxCard(body = {}, rootDir = REPO_ROOT) {
  const baseHome = body.baseHome;
  const cardId = String(body.cardId || body.id || "").trim();
  if (!cardId) throw new Error("send requires cardId");
  const card = readInboxCards(baseHome).find((c) => c.id === cardId);
  if (!card) throw new Error(`Inbox card not found: ${cardId}`);
  if (card.deliveredAt || delivering.has(cardId)) return { ok: true, already: true, card, cards: readInboxCards(baseHome) };
  delivering.add(cardId);
  try {
    const teams = loadTeamsForInbox(rootDir);
    const laneId = String(card.laneId || "").trim();
    const toOverlord = !laneId || laneId === UNASSIGNED_LANE;
    const injectedClient = body.agentClient || null;
    const client = injectedClient || createAgentClient(rootDir);
    const backend = getBackend(client);
    let target = null;
    let targetLane = laneId;
    try {
      if (!injectedClient && typeof backend.connect === "function") await backend.connect();
      const fetched = await backend.fetchAgents();
      const agents = Array.isArray(fetched) ? fetched : (fetched?.entries ?? []);
      const teamId = card.teamId || "";
      if (toOverlord) {
        const team = teams.find((t) => t.id === teamId) ?? teams.find((t) => (t.lanes ?? []).some((l) => l.id === teamId));
        const hub = (team?.lanes ?? []).find((l) => isHubLane(team, l));
        targetLane = hub?.id || team?.id || teamId;
        target = targetLane ? pickLiveAgent(agents, { role: "lead", teamId: team?.id || teamId, laneId: targetLane, teams }) : null;
        if (!target) throw new Error(`No live Overlord (hub lead) for Squad "${team?.id || teamId}" to route card #${cardId}`);
      } else {
        target =
          pickLiveAgent(agents, { role: "brainstorm", teamId, laneId, teams }) ||
          pickLiveAgent(agents, { role: "lead", teamId, laneId, teams });
        if (!target) throw new Error(`No live Buddy or lead in lane "${laneId}" to receive card #${cardId}`);
      }
      await backend.sendAgentPrompt(target.id, buildDeliveryText(card, { toOverlord }));
    } finally {
      if (!injectedClient && typeof backend.close === "function") await backend.close().catch(() => {});
    }

    const now = new Date().toISOString();
    let updated = card;
    const written = updateInboxCardsSync(baseHome, (current) => {
      const t = current.find((c) => c.id === cardId);
      if (!t) throw new Error(`Inbox card not found: ${cardId}`);
      t.deliveredTo = target.id;
      t.deliveredLane = targetLane;
      t.deliveredToTitle = target.title || "";
      t.deliveredAt = now;
      t.updatedAt = now;
      updated = t;
      return current;
    });
    return { ok: true, already: false, card: updated, cards: written, agentId: target.id, lane: targetLane };
  } finally {
    delivering.delete(cardId);
  }
}

export const INBOX_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
export const INBOX_MEDIA_MAX_PER_CARD = 4;
const MEDIA_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
/** The bytes must actually be the image type the client claims (no relying on the Content-Type header alone). */
function sniffImage(b) {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return "";
}

/** Move one saved attachment into another card's media dir (merge); returns the re-linked attachment or null. */
function moveInboxMedia(att, toCardId, baseHome) {
  const from = String(att?.path || "");
  const root = getInboxMediaDir(baseHome);
  if (!from.startsWith(root) || !existsSync(from)) return null;
  const dir = join(root, toCardId);
  mkdirSync(dir, { recursive: true });
  const to = join(dir, `shot-m${randomBytes(4).toString("hex")}.${from.split(".").pop()}`);
  renameSync(from, to);
  return { ...att, path: to };
}

/** Remove a card's saved media (called when the card is archived or deleted). */
export function removeInboxMedia(cardId, baseHome) {
  if (!/^idea-\d+$/.test(String(cardId))) return;
  rmSync(join(getInboxMediaDir(baseHome), String(cardId)), { recursive: true, force: true });
}

export function getInboxMediaDir(baseHome) {
  const home = baseHome || process.env.VIBESQUAD_HOME || join(homedir(), ".vibesquad");
  return join(home, "inbox-media");
}

/**
 * E3: save one image for a parked card under inbox-media/<cardId>/ (server-generated filename), record it in the
 * card's `attachments` and link the absolute path in the card text so workers/Buddies can read it.
 * body: { cardId, mime, bytes: Buffer, baseHome }.
 */
export function attachInboxMedia(body = {}) {
  const baseHome = body.baseHome;
  const cardId = String(body.cardId || "");
  if (!/^idea-\d+$/.test(cardId)) throw new Error("invalid cardId");
  const mime = String(body.mime || "").split(";")[0].trim().toLowerCase();
  const ext = MEDIA_TYPES[mime];
  if (!ext) throw new Error("image types only (png, jpeg, webp)");
  const bytes = body.bytes;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("empty attachment");
  if (sniffImage(bytes) !== mime) throw new Error("file content is not the declared image type");
  if (bytes.length > INBOX_MEDIA_MAX_BYTES) throw Object.assign(new Error("attachment too large (8 MB max)"), { status: 413 });
  const card = readInboxCards(baseHome).find((c) => c.id === cardId);
  if (!card) throw new Error(`Inbox card not found: ${cardId}`);
  if (card.deliveredAt) throw new Error("card already delivered");
  if ((card.attachments?.length ?? 0) >= INBOX_MEDIA_MAX_PER_CARD) throw new Error(`at most ${INBOX_MEDIA_MAX_PER_CARD} attachments per card`);
  const dir = join(getInboxMediaDir(baseHome), cardId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `shot-${randomBytes(6).toString("hex")}.${ext}`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
  const att = { path: file, mime, bytes: bytes.length };
  let updated = card;
  try {
    // Re-check under the lock: the card may have been delivered, archived, deleted or filled while we wrote.
    updateInboxCardsSync(baseHome, (current) => {
      const t = current.find((c) => c.id === cardId);
      if (!t) throw new Error(`Inbox card not found: ${cardId}`);
      if (t.deliveredAt) throw new Error("card already delivered");
      if (t.status === "archived") throw new Error("card is archived");
      if ((t.attachments?.length ?? 0) >= INBOX_MEDIA_MAX_PER_CARD) throw new Error(`at most ${INBOX_MEDIA_MAX_PER_CARD} attachments per card`);
      t.attachments = [...(Array.isArray(t.attachments) ? t.attachments : []), att];
      t.text = `${t.text}

Screenshot: ${file}`;
      t.updatedAt = new Date().toISOString();
      updated = t;
      return current;
    });
  } catch (e) {
    rmSync(file, { force: true });
    try {
      rmdirSync(dir); // only succeeds when empty
    } catch {}
    throw e;
  }
  return { ok: true, attachment: att, card: updated };
}
