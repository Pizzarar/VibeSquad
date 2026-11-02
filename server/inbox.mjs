import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  appendVsLogEntry,
  archiveBuddyKeepingChildren,
  createDaemonClient,
  readBrainstormSummary,
  writeBrainstormSummary,
} from "./brainstorm.mjs";
import { findLaneInRegistry, formatDisplayTitle, laneCodeFor } from "./identity.mjs";
import { findProfile, loadProfiles, toPaseoSpawnConfig } from "./profiles.mjs";
import { clearConfigWarning, readJsonFileWithBom } from "./user-settings.mjs";
import { resolveTeamsFilePath as resolveSharedTeamsFilePath } from "./teams-file.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const TITLE_MAX = 60;

export const INBOX_SCOPES = ["art", "mechanic", "plugin", "UI", "infra", "docs", "other"];
export const INBOX_LANES = ["main-game", "ui-lab", "plugins", "vibesquad", "site-polish"];

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

export function writeInboxCards(cards, baseHome) {
  const file = getInboxPath(baseHome);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cards, null, 2) + "\n", "utf8");
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
  const myTokens = extractSignificantTokens(text);
  const mySet = new Set(myTokens);
  let relatedCardId = null;
  let relatedReason = null;
  let bestSim = 0;

  const parkedCards = (Array.isArray(existingCards) ? existingCards : []).filter(
    (c) => c && (!c.status || c.status === "parked"),
  );

  for (const card of parkedCards) {
    const cardTokens = extractSignificantTokens(`${card.title || ""} ${card.text || ""}`);
    if (!cardTokens.length || !myTokens.length) continue;
    const shared = cardTokens.filter((t) => mySet.has(t));
    const unionSize = new Set([...myTokens, ...cardTokens]).size;
    const jaccard = unionSize > 0 ? shared.length / unionSize : 0;
    const sameLane = card.laneId === laneId;
    const sameScope = card.scope === bestScope;

    // Strong similarity when >=2 significant domain words overlap, or >=1 significant word + same lane & scope
    const score =
      jaccard +
      shared.length * 0.18 +
      (sameLane ? 0.2 : 0) +
      (sameScope ? 0.12 : 0);

    const qualifies =
      shared.length >= 2 ||
      (shared.length >= 1 && sameLane && (sameScope || jaccard >= 0.15));

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
    if (status && status !== "all" && c.status !== status) return false;
    if (laneId && laneId !== "all" && String(c.laneId).toLowerCase() !== String(laneId).toLowerCase()) return false;
    if (teamId && teamId !== "all" && !matchesTeamFilter(c, teamId, teams)) return false;
    return true;
  });
}

export function addInboxCards(body = {}, rootDir = REPO_ROOT) {
  const baseHome = body.baseHome;
  const existing = readInboxCards(baseHome);
  const teams = loadTeamsForInbox(rootDir);

  const rawIdeas =
    Array.isArray(body.ideas) && body.ideas.length > 0
      ? splitIdeaDump(body.ideas, Boolean(body.splitDump))
      : splitIdeaDump(body.text ?? "", Boolean(body.splitDump));

  if (!rawIdeas.length) {
    throw new Error("No idea text provided");
  }

  const explicitLane = typeof body.laneId === "string" && body.laneId.trim() ? body.laneId.trim() : "";
  const defaultLane = typeof body.defaultLaneId === "string" && body.defaultLaneId.trim() ? body.defaultLaneId.trim() : "";
  const explicitTeam = typeof body.teamId === "string" && body.teamId.trim() ? body.teamId.trim() : "";
  const source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : "ui";

  const working = [...existing];
  const added = [];
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

  writeInboxCards(working, baseHome);
  const summary = `parked ${added.length} ideas → Inbox`;
  return {
    ok: true,
    added,
    cards: working,
    summary,
  };
}

function toBulletLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*•]\s+/, "").trim())
    .filter(Boolean);
}

export function triageInboxCards(body = {}, rootDir = REPO_ROOT) {
  const baseHome = body.baseHome;
  const teams = loadTeamsForInbox(rootDir);
  const cards = readInboxCards(baseHome);
  const action = String(body.action || "").trim();
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
    target.mergedFromIds = [...mergedFrom];
    if (sourceIds.includes(target.relatedCardId)) {
      target.relatedCardId = null;
      target.relatedReason = null;
    }
    target.updatedAt = now;

    const sourceSet = new Set(sourceIds);
    const remaining = cards.filter((c) => !sourceSet.has(c.id));
    for (const c of remaining) {
      if (c.relatedCardId && sourceSet.has(c.relatedCardId) && c.id !== target.id) {
        c.relatedCardId = target.id;
        c.relatedReason = `goes with card ${target.id} (${target.title})`;
      }
    }

    writeInboxCards(remaining, baseHome);
    return { ok: true, action: "merge", card: target, mergedIds: sourceIds, cards: remaining };
  }

  if (action === "bounce") {
    const cardId = String(body.cardId || "").trim();
    const laneId = String(body.laneId || body.lane || "").trim();
    if (!cardId || !laneId) throw new Error("bounce requires cardId and laneId");
    const card = cards.find((c) => c.id === cardId);
    if (!card) throw new Error(`Card not found: ${cardId}`);

    card.laneId = laneId;
    card.teamId = body.teamId ? String(body.teamId).trim() : teamIdForLane(laneId, card.text, teams);
    if (body.scope && INBOX_SCOPES.includes(body.scope)) {
      card.scope = body.scope;
    }
    card.updatedAt = now;
    writeInboxCards(cards, baseHome);
    return { ok: true, action: "bounce", card, cards };
  }

  if (action === "update") {
    const cardId = String(body.cardId || "").trim();
    const patch = body.patch && typeof body.patch === "object" ? body.patch : {};
    if (!cardId) throw new Error("update requires cardId");
    const card = cards.find((c) => c.id === cardId);
    if (!card) throw new Error(`Card not found: ${cardId}`);

    const allowed = [
      "status",
      "title",
      "text",
      "scope",
      "summaryNote",
      "topicAgentId",
      "topicTitle",
      "topicOpenedAt",
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
    writeInboxCards(cards, baseHome);
    return { ok: true, action: "update", card, cards };
  }

  if (action === "delete" || action === "archive") {
    const cardId = String(body.cardId || "").trim();
    if (!cardId) throw new Error(`${action} requires cardId`);
    const idx = cards.findIndex((c) => c.id === cardId);
    if (idx < 0) throw new Error(`Card not found: ${cardId}`);
    if (action === "archive" || body.archive === true) {
      cards[idx].status = "archived";
      cards[idx].updatedAt = now;
      writeInboxCards(cards, baseHome);
      return { ok: true, action, card: cards[idx], cards };
    }
    const [removed] = cards.splice(idx, 1);
    writeInboxCards(cards, baseHome);
    return { ok: true, action: "delete", card: removed, cards };
  }

  throw new Error(`Unknown triage action "${action}"`);
}

function clipTitle(s) {
  return s.length > TITLE_MAX ? s.slice(0, TITLE_MAX - 1) + "\u2026" : s;
}

function resolveLaneMeta(laneRaw, rootDir = REPO_ROOT) {
  const teams = loadTeamsForInbox(rootDir);
  const hit = findLaneInRegistry(laneRaw, teams);
  if (hit) {
    return {
      teamId: hit.team.id,
      laneId: hit.lane.id,
      laneName: hit.lane.name || hit.lane.id,
      laneUpper: String(hit.lane.name || hit.lane.id).toUpperCase(),
      code: laneCodeFor(hit.lane.id, teams),
    };
  }
  const fallbackLane = String(laneRaw || "vibesquad").trim() || "vibesquad";
  return {
    teamId: teamIdForLane(fallbackLane, "", teams),
    laneId: fallbackLane,
    laneName: fallbackLane.replace(/-/g, " "),
    laneUpper: fallbackLane.replace(/-/g, " ").toUpperCase(),
  };
}

export function buildTopicTitle(rawTitleOrText) {
  const cleaned = String(rawTitleOrText || "")
    .trim()
    .replace(/\r?\n+/g, " ")
    .replace(FILLER_PREFIX_RE, "")
    .replace(/[,:;!?()[\]{}"'`]+/g, " ")
    .trim();
  if (!cleaned) return "Topic";

  const rawWords = cleaned.split(/\s+/).filter(Boolean);
  let chosen = rawWords.slice(0, 4);
  if (rawWords.length > 4) {
    const nonStop = rawWords.filter((w) => !STOPWORDS.has(w.toLowerCase().replace(/[^a-z0-9]/g, "")));
    if (nonStop.length >= 2) {
      chosen = nonStop.slice(0, 4);
    }
  }
  while (chosen.length > 2 && STOPWORDS.has(chosen[chosen.length - 1].toLowerCase().replace(/[^a-z0-9]/g, ""))) {
    chosen.pop();
  }
  return chosen
    .map((w) => {
      if (/^[A-Z0-9]{2,}$/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

export function buildTopicBrainstormPrompt({ card, topic, laneId, laneUpper, summaryContent, buddyName }) {
  const fullTitle = buddyName || `BRAINSTORM · ${laneUpper} · ${topic}`;
  return [
    `You are a focused topic brainstorm (${fullTitle}) for Inbox card #${card.id}. Stay strictly on this topic. When the plan is ready and handed off to the lead, click 'Hand off & close topic' so the card is marked handed-off and this chat closes.`,
    "",
    `--- BEGIN INBOX CARD #${card.id} ---`,
    `Title: ${card.title}`,
    `Scope: ${card.scope || "other"}`,
    `Lane: ${laneId}`,
    ...(Array.isArray(card.mergedFromIds) && card.mergedFromIds.length
      ? [`Merged from: ${card.mergedFromIds.join(", ")}`]
      : []),
    ...(card.summaryNote ? [`Prior Session Summary Note:\n${String(card.summaryNote).trim()}`] : []),
    "",
    String(card.text || "").trim(),
    `--- END INBOX CARD #${card.id} ---`,
    "",
    `--- BEGIN docs/brainstorm/${laneId}.md ---`,
    String(summaryContent || "").trim(),
    `--- END docs/brainstorm/${laneId}.md ---`,
  ].join("\n");
}

export async function openTopicBrainstorm(body = {}, rootDir = REPO_ROOT) {
  const baseHome = body.baseHome;
  const cardId = String(body.cardId || body.id || "").trim();
  if (!cardId) throw new Error("open-topic requires cardId");

  const cards = readInboxCards(baseHome);
  const card = cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`Inbox card not found: ${cardId}`);

  const meta = resolveLaneMeta(card.laneId, rootDir);
  const laneId = meta.laneId;
  const laneUpper = meta.laneUpper;
  const teamId = meta.teamId || card.teamId || "vibesquad";

  const summary = readBrainstormSummary(laneId, rootDir);
  const topic = buildTopicTitle(card.title || card.text);
  const buddyName = formatDisplayTitle({ role: "brainstorm", laneId, laneName: meta.laneName, code: meta.code, topic });
  const newTitle = clipTitle(buddyName);
  const now = new Date().toISOString();

  const initialPrompt = buildTopicBrainstormPrompt({
    card,
    buddyName,
    topic,
    laneId,
    laneUpper,
    summaryContent: summary.content,
  });

  const rawProvider = String(body.provider || "claude");
  const fallbackProfileName = rawProvider.startsWith("antigravity") ? "Brainstorm - Gemini" : "Brainstorm - Claude";
  const desiredProfileKey = String(body.profile || fallbackProfileName).trim();
  const { profiles } = loadProfiles(body.profilesPath, { autoSeed: false });
  const profile = findProfile(desiredProfileKey, profiles) || findProfile(fallbackProfileName, profiles);

  const spawnCfg = profile
    ? toPaseoSpawnConfig(profile)
    : {
        provider: rawProvider.includes("/") ? rawProvider.split("/")[0] : rawProvider,
        model:
          body.model ||
          (rawProvider.includes("/")
            ? rawProvider.split("/").slice(1).join("/")
            : rawProvider.startsWith("antigravity")
              ? "gemini-4-argon"
              : "claude-opus-5-5"),
        modeId: rawProvider.startsWith("antigravity-cli") ? "accept-edits" : "auto",
        thinkingOptionId: "medium",
        ...(rawProvider.startsWith("antigravity-cli")
          ? { featureValues: { approvalPolicy: "skip", shareMcp: "on" } }
          : {}),
        notes: "",
        systemPrompt: "",
      };

  const provider = spawnCfg.provider;
  const model = spawnCfg.model;
  const modeId = spawnCfg.modeId;
  const thinkingOptionId = spawnCfg.thinkingOptionId;
  const featureValues = spawnCfg.featureValues ? { ...spawnCfg.featureValues } : undefined;
  const cwd = body.cwd || rootDir;

  const newLabels = {
    team: teamId,
    lane: laneId,
    lead: laneId,
    role: "brainstorm",
    profile: profile?.name || fallbackProfileName,
    topic,
    "vs.inbox-card-id": card.id,
    "vs.topic-scope": String(card.scope || "other"),
    "vs.opened-at": now,
  };

  let created = null;
  const injectedClient = body.daemonClient || null;
  const client = injectedClient || (body.skipDaemon ? null : createDaemonClient(rootDir));
  if (client) {
    let connected = Boolean(injectedClient);
    try {
      if (!injectedClient && typeof client.connect === "function") {
        await client.connect();
        connected = true;
      }
      if (connected && card.topicAgentId) {
        let existingAgent = null;
        if (typeof client.fetchAgent === "function") {
          const fetched = await client.fetchAgent(card.topicAgentId).catch(() => null);
          existingAgent = fetched?.agent ?? (fetched?.id ? fetched : null);
        } else if (typeof client.getAgent === "function") {
          const fetched = await client.getAgent(card.topicAgentId).catch(() => null);
          existingAgent = fetched?.agent ?? (fetched?.id ? fetched : null);
        }
        if (existingAgent && !existingAgent.archivedAt && existingAgent.status !== "archived") {
          const openTopicCards = cards
            .filter((c) => c.status === "parked" && c.topicAgentId)
            .sort((a, b) =>
              String(a.topicOpenedAt || a.updatedAt || a.createdAt || "").localeCompare(
                String(b.topicOpenedAt || b.updatedAt || b.createdAt || ""),
              ),
            );
          const oldestCard = openTopicCards[0] || null;
          return {
            ok: true,
            reused: true,
            card,
            cards,
            agent: existingAgent,
            agentId: card.topicAgentId,
            topic,
            title: existingAgent.title || card.topicTitle || newTitle,
            initialPrompt,
            summaryPath: summary.path,
            spawnConfig: spawnCfg,
            openTopicsCount: openTopicCards.length,
            softCapExceeded: openTopicCards.length > 3,
            oldestTopic: oldestCard
              ? {
                  cardId: oldestCard.id,
                  agentId: oldestCard.topicAgentId,
                  title: oldestCard.topicTitle || oldestCard.title,
                }
              : null,
          };
        }
      }
      if (connected && typeof client.createAgent === "function") {
        created = await client.createAgent({
          config: {
            provider,
            model,
            cwd,
            title: newTitle,
            modeId,
            thinkingOptionId,
            ...(featureValues && Object.keys(featureValues).length ? { featureValues } : {}),
            ...(spawnCfg.systemPrompt ? { systemPrompt: spawnCfg.systemPrompt } : {}),
          },
          initialPrompt,
          labels: newLabels,
          // Labels never reach the plugin's before(agent.create); env does, so the profile is forced at spawn.
          env: { VS_ROLE: "brainstorm", ...(newLabels.profile ? { VS_PROFILE: newLabels.profile } : {}) },
        });
      }
    } catch {
      created = null;
    } finally {
      if (!injectedClient && typeof client.close === "function") {
        await client.close().catch(() => {});
      }
    }
  }

  if (!created) {
    created = {
      id: `bs-topic-${card.id}-${Date.now().toString(36)}`,
      title: newTitle,
      provider,
      model,
      modeId,
      thinkingOptionId,
      ...(featureValues ? { featureValues } : {}),
      cwd,
      status: "idle",
      labels: newLabels,
      createdAt: now,
      updatedAt: now,
      pendingPermissions: [],
      requiresAttention: false,
    };
  } else {
    created = {
      ...created,
      title: created.title || newTitle,
      modeId: created.modeId ?? modeId,
      thinkingOptionId: created.thinkingOptionId ?? thinkingOptionId,
      ...(featureValues && !created.featureValues ? { featureValues } : {}),
      labels: { ...(created.labels ?? {}), ...newLabels },
    };
  }

  card.topicAgentId = created.id;
  card.topicTitle = created.title || newTitle;
  card.topicOpenedAt = now;
  card.status = "parked";
  card.updatedAt = now;
  writeInboxCards(cards, baseHome);

  const openTopicCards = cards
    .filter((c) => c.status === "parked" && c.topicAgentId)
    .sort((a, b) => String(a.topicOpenedAt || a.updatedAt || a.createdAt || "").localeCompare(String(b.topicOpenedAt || b.updatedAt || b.createdAt || "")));
  const oldestCard = openTopicCards[0] || null;

  return {
    ok: true,
    card,
    cards,
    agent: created,
    agentId: created.id,
    spawnConfig: spawnCfg,
    topic,
    title: created.title || newTitle,
    initialPrompt,
    summaryPath: summary.path,
    openTopicsCount: openTopicCards.length,
    softCapExceeded: openTopicCards.length > 3,
    oldestTopic: oldestCard
      ? {
          cardId: oldestCard.id,
          agentId: oldestCard.topicAgentId,
          title: oldestCard.topicTitle || oldestCard.title,
        }
      : null,
  };
}

export async function handoffTopicBrainstorm(body = {}, rootDir = REPO_ROOT) {
  const baseHome = body.baseHome;
  const reqCardId = String(body.cardId || "").trim();
  const reqAgentId = String(body.agentId || "").trim();
  if (!reqCardId && !reqAgentId) {
    throw new Error("handoff-topic requires cardId or agentId");
  }

  const cards = readInboxCards(baseHome);
  const card = cards.find((c) => (reqCardId && c.id === reqCardId) || (reqAgentId && c.topicAgentId === reqAgentId));
  if (!card) {
    throw new Error(`Inbox card not found for ${reqCardId || reqAgentId}`);
  }

  const targetAgentId = reqAgentId || String(card.topicAgentId || "").trim();
  const meta = resolveLaneMeta(card.laneId, rootDir);
  const laneId = meta.laneId;
  const teamId = card.teamId || meta.teamId || "vibesquad";

  if (typeof body.summaryUpdate === "string" && body.summaryUpdate.trim()) {
    writeBrainstormSummary(laneId, body.summaryUpdate, rootDir);
  }
  const summary = readBrainstormSummary(laneId, rootDir);

  let usedTokens = Number(body.usedTokens) || 0;
  const injectedClient = body.daemonClient || null;
  const client = injectedClient || (body.skipDaemon ? null : createDaemonClient(rootDir));
  if (client && targetAgentId) {
    let connected = Boolean(injectedClient);
    try {
      if (!injectedClient && typeof client.connect === "function") {
        await client.connect();
        connected = true;
      }
      if (connected) {
        if (!usedTokens && typeof client.fetchAgent === "function") {
          const fetched = await client.fetchAgent(targetAgentId).catch(() => null);
          const ag = fetched?.agent;
          usedTokens =
            Number(ag?.contextUsage?.usedTokens) ||
            Number(ag?.lastUsage?.contextWindowUsedTokens) ||
            Number(ag?.lastUsage?.inputTokens) ||
            0;
        }
        if (typeof client.cancelAgent === "function") {
          await client.cancelAgent(targetAgentId).catch(() => {});
        }
        await archiveBuddyKeepingChildren(client, targetAgentId);
      }
    } catch {
      // daemon offline is non-fatal
    } finally {
      if (!injectedClient && typeof client.close === "function") {
        await client.close().catch(() => {});
      }
    }
  }

  const now = new Date().toISOString();
  const planNote = typeof body.planNote === "string" && body.planNote.trim() ? body.planNote.trim() : "";

  card.status = "handed-off";
  card.handedOffAt = now;
  card.summaryNote = planNote || card.summaryNote || null;
  card.topicAgentId = null;
  card.updatedAt = now;
  writeInboxCards(cards, baseHome);

  const prevHome = process.env.VIBESQUAD_HOME;
  if (baseHome) process.env.VIBESQUAD_HOME = baseHome;
  try {
    appendVsLogEntry({
      teamId,
      laneId,
      agent: targetAgentId || "topic-brainstorm",
      type: "handoff",
      text: `topic-handoff (#${card.id} ${card.title}): ${planNote || card.summaryNote || "plan handed off to lead"}`,
      refs: [card.id, summary.path],
    });
    appendVsLogEntry({
      teamId,
      laneId,
      agent: targetAgentId || "topic-brainstorm",
      type: "metric",
      text: `tokens-per-plan-handoff: ${usedTokens} tok (topic #${card.id} ${card.title})`,
      refs: [card.id, summary.path],
    });
  } finally {
    if (baseHome) {
      if (prevHome === undefined) delete process.env.VIBESQUAD_HOME;
      else process.env.VIBESQUAD_HOME = prevHome;
    }
  }

  return {
    ok: true,
    card,
    cards,
    archivedAgentId: targetAgentId || null,
    handedOffAt: now,
    summaryPath: summary.path,
  };
}

export async function parkTopicBrainstorm(body = {}, rootDir = REPO_ROOT) {
  const baseHome = body.baseHome;
  const reqCardId = String(body.cardId || "").trim();
  const reqAgentId = String(body.agentId || "").trim();
  if (!reqCardId && !reqAgentId) {
    throw new Error("park-topic requires cardId or agentId");
  }

  const cards = readInboxCards(baseHome);
  const card = cards.find((c) => (reqCardId && c.id === reqCardId) || (reqAgentId && c.topicAgentId === reqAgentId));
  if (!card) {
    throw new Error(`Inbox card not found for ${reqCardId || reqAgentId}`);
  }

  const targetAgentId = reqAgentId || String(card.topicAgentId || "").trim();
  const rawNote = typeof body.summaryNote === "string" ? body.summaryNote.trim() : "";
  const isDefaultPlaceholder = !rawNote || /^Parked from topic brainstorm$/i.test(rawNote);
  let latestAssistantText = "";

  const injectedClient = body.daemonClient || null;
  const client = injectedClient || (body.skipDaemon ? null : createDaemonClient(rootDir));
  if (client && targetAgentId) {
    let connected = Boolean(injectedClient);
    try {
      if (!injectedClient && typeof client.connect === "function") {
        await client.connect();
        connected = true;
      }
      if (connected) {
        if (isDefaultPlaceholder) {
          let timeline = null;
          if (typeof client.fetchAgentTimeline === "function") {
            timeline = await client
              .fetchAgentTimeline(targetAgentId, { direction: "tail", limit: 20, projection: "projected" })
              .catch(() => null);
          } else if (typeof client.getAgentTimeline === "function") {
            timeline = await client.getAgentTimeline(targetAgentId).catch(() => null);
          }
          const entries = Array.isArray(timeline?.entries)
            ? timeline.entries
            : Array.isArray(timeline)
              ? timeline
              : [];
          for (let i = entries.length - 1; i >= 0; i--) {
            const it = entries[i]?.item ?? entries[i];
            if (it && (it.type === "assistant_message" || it.role === "assistant")) {
              const txt = String(it.text ?? it.content ?? "").trim();
              if (txt) {
                latestAssistantText = txt.slice(0, 400);
                break;
              }
            }
          }
        }
        if (typeof client.cancelAgent === "function") {
          await client.cancelAgent(targetAgentId).catch(() => {});
        }
        await archiveBuddyKeepingChildren(client, targetAgentId);
      }
    } catch {
      // daemon offline is non-fatal
    } finally {
      if (!injectedClient && typeof client.close === "function") {
        await client.close().catch(() => {});
      }
    }
  }

  const now = new Date().toISOString();
  let parkedSummary = "";
  if (!isDefaultPlaceholder && rawNote) {
    parkedSummary = rawNote;
  } else if (latestAssistantText) {
    parkedSummary = latestAssistantText;
  } else if (rawNote) {
    parkedSummary = rawNote;
  } else if (card.summaryNote) {
    parkedSummary = card.summaryNote;
  } else {
    parkedSummary = `Parked topic summary (${card.topicTitle || card.title})`;
  }
  card.summaryNote = parkedSummary;
  card.parkedSummary = parkedSummary;
  card.status = "parked";
  card.topicAgentId = null;
  card.updatedAt = now;
  writeInboxCards(cards, baseHome);

  return {
    ok: true,
    card,
    cards,
    parkedSummary,
    archivedAgentId: targetAgentId || null,
  };
}
